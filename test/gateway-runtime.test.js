"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadGatewayConfig } = require("../src/gateway/config");
const { ProcessContextCollector } = require("../src/gateway/process-context");
const { GatewayRuntime } = require("../src/gateway/runtime");

const BASE_MS = Date.now() - 60_000;

function iso(seconds) {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function plcSnapshot({
  goodCount = 0,
  totalProducedCount,
  deviceStatus = "RUNNING",
  temperatureC = 24
} = {}) {
  const snapshot = {
    deviceStatus: { value: deviceStatus },
    currentOutput: { value: 120 },
    goodCount: { value: goodCount },
    temperatureSensor: { value: temperatureC },
    alarmEvents: { alarmSnapshot: { sequence: 0, active: [] } }
  };
  if (totalProducedCount !== undefined) {
    snapshot.totalProducedCount = { value: totalProducedCount };
  }
  return snapshot;
}

class FakeOpcUaClient extends EventEmitter {
  constructor(snapshot = plcSnapshot()) {
    super();
    this.snapshot = snapshot;
    this.isConnected = false;
    this.started = false;
    this.stopped = false;
  }

  async start() {
    this.started = true;
    this.isConnected = true;
    return this;
  }

  async stop() {
    this.stopped = true;
    this.isConnected = false;
  }

  getSnapshot() {
    return this.snapshot;
  }

  getStatus() {
    return (
      this.plcStatus || {
        status: "ok",
        healthy: true,
        connection: {
          reconnectCount: 0,
          lastReconnectGapMs: null,
          maxReconnectGapMs: 0
        },
        eventSubscription: { status: "disabled" },
        summary: {
          badValues: 0,
          uncertainValues: 0,
          staleValues: 0,
          clockSkewValues: 0,
          futureTimestampValues: 0
        },
        variables: []
      }
    );
  }
}

function makeRuntime(extraEnv = {}) {
  const config = loadGatewayConfig({
    OPCUA_ENDPOINT: "opc.tcp://127.0.0.1:1/UA/MockPLC",
    PROCESS_CONTEXT_LOG: "off",
    QUALITY_EVENT_LOG: "off",
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
    GATEWAY_HTTP_PORT: "0",
    GATEWAY_LINE_ID: "JX-LINE-01",
    GATEWAY_STATION_ID: "JX-LINQIN-STATION-01",
    OEE_NOMINAL_OUTPUT_PER_MIN: "120",
    GATEWAY_API_TOKEN: "",
    GATEWAY_WORK_CONTEXT_FILE: "off",
    ...extraEnv
  });
  const client = new FakeOpcUaClient();
  const collector = new ProcessContextCollector({
    ...config.identity,
    ...config.context,
    createId: (() => {
      let id = 0;
      return () => `runtime-event-${++id}`;
    })()
  });
  return {
    runtime: new GatewayRuntime(config, { client, collector }),
    client,
    collector
  };
}

function captureWindow(collector, { totalProduced = false } = {}) {
  const goodCounts = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18];
  for (let second = 0; second <= 10; second += 1) {
    collector.capture(
      plcSnapshot({
        goodCount: goodCounts[second],
        totalProducedCount: totalProduced ? second * 2 : undefined,
        temperatureC: second === 10 ? 92 : 24
      }),
      { occurredAt: iso(second) }
    );
  }
}

test("gateway runtime exposes context, OEE and RCA over HTTP", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector);

  assert.match(runtime.api.address, /^http:\/\/127\.0\.0\.1:\d+$/);

  const healthResponse = await fetch(`${runtime.api.address}/healthz`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.opcuaConnected, true);
  assert.equal(health.identity.lineId, "JX-LINE-01");
  assert.equal(health.plc.status, "ok");

  const metricsResponse = await fetch(`${runtime.api.address}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(metricsResponse.headers.get("content-type"), /^text\/plain/);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /^rpi4_gateway_up 1$/m);
  assert.match(metrics, /^rpi4_gateway_opcua_connected 1$/m);
  const processContextMetric = metrics.match(
    /^rpi4_gateway_process_context_events (\d+)$/m
  );
  assert.ok(processContextMetric && Number(processContextMetric[1]) >= 11);
  assert.match(metrics, /^rpi4_gateway_quality_events 0$/m);
  assert.match(metrics, /^rpi4_gateway_plc_diagnostics_healthy 1$/m);
  assert.match(metrics, /^rpi4_gateway_plc_stale_values 0$/m);

  const latestResponse = await fetch(`${runtime.api.address}/v1/context/latest`);
  assert.equal(latestResponse.status, 200);
  const latest = await latestResponse.json();
  assert.equal(latest.eventType, "PROCESS_CONTEXT");
  assert.equal(latest.metrics.temperatureC, 92);

  const eventsResponse = await fetch(`${runtime.api.address}/v1/events?limit=3`);
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.count, 3);

  const qualityBody = {
    sourceEventId: "QC-RUNTIME-001",
    eventType: "NG_ORDER",
    result: "NG",
    occurredAt: iso(10),
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    workOrderId: "WO-RUNTIME-001",
    serialNumber: "SN-RUNTIME-001",
    correlationId: "corr-runtime-001",
    defectType: "DENT",
    quantity: 2,
    confidence: 0.97,
    metadata: { imageId: "IMG-RUNTIME-001" }
  };
  const qualityResponse = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(qualityBody)
  });
  assert.equal(qualityResponse.status, 201);
  const quality = await qualityResponse.json();
  assert.equal(quality.duplicate, false);
  assert.match(quality.event.qualityEventId, /^qevt-/);
  assert.equal(quality.event.quantity, 2);
  assert.equal(quality.event.correlationId, "corr-runtime-001");

  const duplicateResponse = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(qualityBody)
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.qualityEventId, quality.event.qualityEventId);

  const qualityListResponse = await fetch(`${runtime.api.address}/v1/quality-events`);
  assert.equal(qualityListResponse.status, 200);
  const qualityList = await qualityListResponse.json();
  assert.equal(qualityList.count, 1);
  assert.equal(qualityList.events[0].sourceEventId, "QC-RUNTIME-001");

  const qualityByIdResponse = await fetch(
    `${runtime.api.address}/v1/quality-events/${quality.event.qualityEventId}`
  );
  assert.equal(qualityByIdResponse.status, 200);
  assert.equal((await qualityByIdResponse.json()).sourceEventId, "QC-RUNTIME-001");

  const invalidQualityResponse = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceEventId: "QC-RUNTIME-BAD", result: "OK" })
  });
  assert.equal(invalidQualityResponse.status, 400);

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  const oeeResponse = await fetch(oeeUrl);
  assert.equal(oeeResponse.status, 200);
  const oee = await oeeResponse.json();
  assert.equal(oee.availability, 1);
  assert.equal(oee.performance, 0.9);
  assert.equal(oee.quality, 0.9);
  assert.equal(oee.oee, 0.81);
  assert.equal(oee.counterMode, "good-count-proxy");
  assert.equal(oee.plannedSeconds, 10);
  assert.equal(oee.plannedStopSeconds, 0);
  assert.equal(oee.outsidePlanRunningSeconds, 0);
  assert.equal(oee.plannedTime.windows, "00:00-24:00");
  assert.equal(oee.lossBreakdown.plannedStopSeconds, 0);
  assert.equal(oee.lossBreakdown.unplannedStopSeconds, 0);
  assert.equal(oee.qualitySource, "quality-events");
  assert.equal(oee.qualityEventCount, 1);
  assert.equal(oee.qualityEventQuantity, 2);
  assert.equal(oee.qualityReconciliation.status, "counter-unavailable");
  assert.equal(oee.dataQuality.status, "ok");

  const rcaResponse = await fetch(`${runtime.api.address}/v1/rca`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      qualityEventId: quality.event.qualityEventId,
      windowMs: 10_000,
      temperatureThresholdC: 70
    })
  });
  assert.equal(rcaResponse.status, 200);
  const rca = await rcaResponse.json();
  assert.equal(rca.conclusion, "TEMPERATURE_SPIKE");
  assert.equal(rca.candidates[0].causalClaim, false);
  assert.equal(rca.targetAt, iso(10));
  assert.equal(rca.targetQualityEventId, quality.event.qualityEventId);
  assert.equal(rca.correlationId, "corr-runtime-001");
  assert.equal(rca.scopeApplied, false);
  assert.deepEqual(rca.scope, {
    workOrderId: "WO-RUNTIME-001",
    correlationId: "corr-runtime-001"
  });
  assert.ok(rca.warnings.some((warning) => warning.includes("fell back")));

  const missingRcaResponse = await fetch(`${runtime.api.address}/v1/rca`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qualityEventId: "qevt-missing" })
  });
  assert.equal(missingRcaResponse.status, 404);
});

test("gateway health and metrics expose event sequence watermarks", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector);

  const qualityResponse = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceEventId: "QC-SEQUENCE-1", occurredAt: iso(10) })
  });
  assert.equal(qualityResponse.status, 201);

  const health = await (await fetch(`${runtime.api.address}/healthz`)).json();
  assert.equal(health.sequences.processContext.status, "ok");
  assert.ok(health.sequences.processContext.currentSequence >= 11);
  assert.equal(health.sequences.quality.status, "ok");
  assert.equal(health.sequences.quality.currentSequence, 1);

  const metrics = await (await fetch(`${runtime.api.address}/metrics`)).text();
  assert.match(
    metrics,
    /^rpi4_gateway_event_sequence_current\{stream="quality"\} 1$/m
  );
  assert.match(
    metrics,
    /^rpi4_gateway_event_sequence_healthy\{stream="process-context"\} 1$/m
  );
  assert.match(metrics, /^rpi4_gateway_event_sequence_healthy\{stream="quality"\} 1$/m);
});

test("gateway health and metrics surface degraded PLC diagnostics", async (t) => {
  const { runtime, client } = makeRuntime();
  client.plcStatus = {
    status: "warning",
    healthy: false,
    connection: {
      attempts: 4,
      failures: 1,
      reconnectCount: 2,
      lastReconnectGapMs: 1500,
      maxReconnectGapMs: 3000,
      totalReconnectGapMs: 4500,
      currentGapMs: 2500
    },
    eventSubscription: { status: "unavailable", failures: 1, recoveries: 1 },
    summary: {
      badValues: 0,
      uncertainValues: 0,
      staleValues: 1,
      clockSkewValues: 1,
      futureTimestampValues: 0
    },
    variables: [
      {
        name: "temperatureSensor",
        good: true,
        stale: true,
        ageMs: 600000,
        clockSkewMs: 45000
      }
    ]
  };
  t.after(async () => runtime.stop());
  await runtime.start();

  const health = await (await fetch(`${runtime.api.address}/healthz`)).json();
  assert.equal(health.status, "degraded");
  assert.equal(health.plc.status, "warning");
  assert.equal(health.plc.summary.staleValues, 1);

  const metrics = await (await fetch(`${runtime.api.address}/metrics`)).text();
  assert.match(metrics, /^rpi4_gateway_plc_diagnostics_healthy 0$/m);
  assert.match(metrics, /^rpi4_gateway_plc_stale_values 1$/m);
  assert.match(metrics, /^rpi4_gateway_plc_clock_skew_values 1$/m);
  assert.match(metrics, /^rpi4_gateway_plc_reconnects_total 2$/m);
  assert.match(metrics, /^rpi4_gateway_plc_connection_attempts_total 4$/m);
  assert.match(metrics, /^rpi4_gateway_plc_connection_failures_total 1$/m);
  assert.match(metrics, /^rpi4_gateway_plc_last_reconnect_gap_seconds 1\.5$/m);
  assert.match(metrics, /^rpi4_gateway_plc_total_reconnect_gap_seconds 4\.5$/m);
  assert.match(metrics, /^rpi4_gateway_plc_current_disconnect_gap_seconds 2\.5$/m);
  assert.match(metrics, /^rpi4_gateway_plc_event_subscription_healthy 0$/m);
  assert.match(metrics, /^rpi4_gateway_plc_event_subscription_failures_total 1$/m);
  assert.match(metrics, /^rpi4_gateway_plc_event_subscription_recoveries_total 1$/m);
  assert.match(
    metrics,
    /^rpi4_gateway_plc_value_stale\{name="temperatureSensor"\} 1$/m
  );
});

test("gateway runtime reports total-production OEE counter mode", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector, { totalProduced: true });

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  oeeUrl.searchParams.set("ngCount", "2");
  const response = await fetch(oeeUrl);
  assert.equal(response.status, 200);
  const oee = await response.json();

  assert.equal(oee.counterMode, "total-produced");
  assert.equal(oee.performance, 1);
  assert.equal(oee.quality, 0.9);
  assert.equal(oee.oee, 0.9);
  assert.equal(oee.totalDelta, 20);
  assert.equal(oee.counterScrapDelta, 2);
  assert.equal(oee.plannedSeconds, 10);
  assert.equal(oee.qualitySource, "query");
  assert.equal(oee.qualityReconciliation.status, "reconciled");
  assert.equal(oee.qualityReconciliation.delta, 0);
  assert.equal(oee.dataQuality.status, "ok");
});

test("gateway runtime applies config and query ideal cycle times", async (t) => {
  const { runtime } = makeRuntime({ OEE_IDEAL_CYCLE_TIME_MS: "500" });
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector);

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  const configuredResponse = await fetch(oeeUrl);
  assert.equal(configuredResponse.status, 200);
  const configured = await configuredResponse.json();
  assert.equal(configured.performance, 0.9);
  assert.equal(configured.idealCycleTimeMs, 500);
  assert.equal(configured.idealCycleTimeSource, "config");
  assert.equal(configured.performanceSource, "ideal-cycle-time");

  oeeUrl.searchParams.set("idealCycleTimeMs", "600");
  const queryResponse = await fetch(oeeUrl);
  assert.equal(queryResponse.status, 200);
  const query = await queryResponse.json();
  assert.equal(query.performance, 1);
  assert.equal(query.idealCycleTimeMs, 600);
  assert.equal(query.idealCycleTimeSource, "query");

  oeeUrl.searchParams.set("idealCycleTimeMs", "0");
  const invalidResponse = await fetch(oeeUrl);
  assert.equal(invalidResponse.status, 400);
});

test("gateway runtime applies product context to per-SKU Performance", async (t) => {
  const { runtime } = makeRuntime({
    OEE_PRODUCT_CYCLE_TIMES: "SKU-A=500,SKU-B=1000"
  });
  t.after(async () => runtime.stop());
  await runtime.start();

  await runtime.updateWorkContext({ productId: "SKU-A" });
  runtime.collector.capture(
    plcSnapshot({ goodCount: 0, totalProducedCount: 0 }),
    { occurredAt: iso(0) }
  );
  runtime.collector.capture(
    plcSnapshot({ goodCount: 2, totalProducedCount: 2 }),
    { occurredAt: iso(1) }
  );
  await runtime.updateWorkContext({ productId: "SKU-B" });
  runtime.collector.capture(
    plcSnapshot({ goodCount: 4, totalProducedCount: 4 }),
    { occurredAt: iso(2) }
  );
  runtime.collector.capture(
    plcSnapshot({ goodCount: 5, totalProducedCount: 5 }),
    { occurredAt: iso(3) }
  );

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(3));
  oeeUrl.searchParams.set("ngCount", "0");
  const response = await fetch(oeeUrl);
  assert.equal(response.status, 200);
  const oee = await response.json();

  assert.equal(oee.theoreticalGood, 5);
  assert.equal(oee.performance, 1);
  assert.equal(oee.performanceSource, "product-cycle-time");
  assert.deepEqual(
    oee.appliedCycleTimes.map(({ productId, runningSeconds, theoreticalUnits }) => ({
      productId,
      runningSeconds,
      theoreticalUnits
    })),
    [
      { productId: "SKU-A", runningSeconds: 2, theoreticalUnits: 4 },
      { productId: "SKU-B", runningSeconds: 1, theoreticalUnits: 1 }
    ]
  );
});

test("gateway runtime exposes counter-to-quality reconciliation warnings", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector, { totalProduced: true });
  runtime.recordQualityEvent({
    sourceEventId: "QC-RECONCILIATION-001",
    occurredAt: iso(5),
    quantity: 1
  });

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  const response = await fetch(oeeUrl);
  assert.equal(response.status, 200);
  const oee = await response.json();

  assert.equal(oee.qualitySource, "quality-events");
  assert.equal(oee.qualityEventQuantity, 1);
  assert.equal(oee.counterScrapDelta, 2);
  assert.equal(oee.qualityReconciliation.status, "mismatch");
  assert.equal(oee.qualityReconciliation.delta, 1);
  assert.equal(oee.dataQuality.status, "warning");
  assert.ok(
    oee.dataQuality.issues.some(
      (issue) => issue.code === "QUALITY_RECONCILIATION_MISMATCH"
    )
  );
  assert.ok(oee.warnings.some((warning) => warning.includes("differs")));
});

test("gateway runtime reports an empty quality feed after OEE refactoring", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();
  captureWindow(runtime.collector);

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  const response = await fetch(oeeUrl);
  assert.equal(response.status, 200);
  const oee = await response.json();

  assert.equal(oee.qualitySource, "quality-events");
  assert.equal(oee.qualityEventCount, 0);
  assert.equal(oee.dataQuality.status, "warning");
  assert.ok(
    oee.dataQuality.issues.some((issue) => issue.code === "QUALITY_EVENT_FEED_EMPTY")
  );
  assert.ok(oee.warnings.some((warning) => warning.includes("No NG quality events")));
});

test("gateway API enforces a bearer token when configured", async (t) => {
  const { runtime } = makeRuntime({ GATEWAY_API_TOKEN: "test-token" });
  t.after(async () => runtime.stop());
  await runtime.start();

  const unauthorized = await fetch(`${runtime.api.address}/v1/context/latest`);
  assert.equal(unauthorized.status, 401);
  const unauthorizedMetrics = await fetch(`${runtime.api.address}/metrics`);
  assert.equal(unauthorizedMetrics.status, 401);

  const health = await fetch(`${runtime.api.address}/healthz`);
  assert.equal(health.status, 200);

  const authorized = await fetch(`${runtime.api.address}/v1/context/latest`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(authorized.status, 200);
  const authorizedMetrics = await fetch(`${runtime.api.address}/metrics`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(authorizedMetrics.status, 200);
});

test("gateway API fails closed and degrades health when quality storage is unavailable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-storage-fail-"));
  const { runtime } = makeRuntime({
    QUALITY_EVENT_LOG: directory,
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off"
  });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await runtime.start();

  const response = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEventId: "QC-RUNTIME-STORAGE-FAIL",
      occurredAt: new Date().toISOString()
    })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Unable to persist quality event/);
  assert.equal(runtime.getQualityEvents().length, 0);

  const health = await (await fetch(`${runtime.api.address}/healthz`)).json();
  assert.equal(health.status, "degraded");
  assert.equal(health.storage.status, "critical");
  assert.equal(health.storage.components["quality-event-log"].status, "critical");

  const metrics = await (await fetch(`${runtime.api.address}/metrics`)).text();
  assert.match(metrics, /^rpi4_gateway_storage_healthy 0$/m);
  assert.match(
    metrics,
    /^rpi4_gateway_storage_component_healthy\{component="quality-event-log"\} 0$/m
  );
  assert.match(
    metrics,
    /^rpi4_gateway_storage_write_errors_total\{component="quality-event-log"\} 1$/m
  );
});

test("gateway API fails closed on a simulated full quality disk", async (t) => {
  try {
    await fs.access("/dev/full");
  } catch {
    t.skip("/dev/full is not available on this platform");
    return;
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-disk-full-"));
  const { runtime } = makeRuntime({
    QUALITY_EVENT_LOG: path.join(directory, "quality-events.jsonl"),
    QUALITY_EVENT_IDEMPOTENCY_FILE: path.join(directory, "quality-idempotency.json")
  });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  runtime.qualityEvents._logStore.filePath = "/dev/full";
  runtime.qualityEvents._logStore._size = 0;

  const response = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEventId: "QC-DISK-FULL",
      occurredAt: new Date().toISOString()
    })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ENOSPC/);
  assert.equal(runtime.getQualityEvents().length, 0);

  const health = await (await fetch(`${runtime.api.address}/healthz`)).json();
  assert.equal(health.status, "degraded");
  assert.equal(health.storage.components["quality-event-log"].status, "critical");
  assert.equal(health.storage.components["quality-event-log"].totalFailures, 1);
});

test("gateway API does not acknowledge a slow quality-log write early", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-slow-write-"));
  const { runtime } = makeRuntime({
    QUALITY_EVENT_LOG: path.join(directory, "quality-events.jsonl"),
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off"
  });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await runtime.start();

  const append = runtime.qualityEvents._logStore.append.bind(runtime.qualityEvents._logStore);
  runtime.qualityEvents._logStore.append = (record) =>
    new Promise((resolve) => {
      setTimeout(() => resolve(append(record)), 150);
    });

  let settled = false;
  const request = fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEventId: "QC-SLOW-WRITE",
      occurredAt: new Date().toISOString()
    })
  }).then(async (response) => {
    settled = true;
    return { status: response.status, body: await response.json() };
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);

  const response = await request;
  assert.equal(response.status, 201);
  assert.equal(response.body.duplicate, false);
  assert.equal(runtime.getQualityEvents().length, 1);
});

test("gateway API rolls back work context when persistence fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-work-context-fail-"));
  const { runtime } = makeRuntime({
    GATEWAY_WORK_CONTEXT_FILE: directory
  });
  t.after(async () => {
    await runtime.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await runtime.start();

  const response = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workOrderId: "WO-UNPERSISTED" })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Unable to persist work context/);
  assert.equal(runtime.getWorkContext().workOrderId, null);

  const health = await (await fetch(`${runtime.api.address}/healthz`)).json();
  assert.equal(health.status, "degraded");
  assert.equal(health.storage.components["work-context"].status, "critical");
});

test("gateway runtime exposes and applies runtime work context updates", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();

  const initialResponse = await fetch(`${runtime.api.address}/v1/work-context`);
  assert.equal(initialResponse.status, 200);
  assert.deepEqual(await initialResponse.json(), {
    workOrderId: null,
    serialNumber: null,
    correlationId: null,
    productId: null
  });

  const updateResponse = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workOrderId: "WO-RUNTIME-NEXT",
      serialNumber: "SN-RUNTIME-NEXT",
      correlationId: "corr-runtime-next",
      productId: "SKU-RUNTIME-NEXT"
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), {
    workOrderId: "WO-RUNTIME-NEXT",
    serialNumber: "SN-RUNTIME-NEXT",
    correlationId: "corr-runtime-next",
    productId: "SKU-RUNTIME-NEXT"
  });

  const event = runtime.collector.capture(plcSnapshot({ goodCount: 1 }), {
    occurredAt: new Date().toISOString()
  });
  assert.equal(event.workOrderId, "WO-RUNTIME-NEXT");
  assert.equal(event.serialNumber, "SN-RUNTIME-NEXT");
  assert.equal(event.correlationId, "corr-runtime-next");
  assert.equal(event.productId, "SKU-RUNTIME-NEXT");

  const qualityResponse = await fetch(`${runtime.api.address}/v1/quality-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEventId: "QC-RUNTIME-WORK-CONTEXT",
      occurredAt: new Date().toISOString()
    })
  });
  assert.equal(qualityResponse.status, 201);
  const quality = await qualityResponse.json();
  assert.equal(quality.event.workOrderId, "WO-RUNTIME-NEXT");
  assert.equal(quality.event.serialNumber, "SN-RUNTIME-NEXT");
  assert.equal(quality.event.correlationId, "corr-runtime-next");
  assert.equal(quality.event.productId, "SKU-RUNTIME-NEXT");
  const metrics = await (await fetch(`${runtime.api.address}/metrics`)).text();
  assert.match(metrics, /work_order_id="WO-RUNTIME-NEXT"/);
  assert.match(metrics, /serial_number="SN-RUNTIME-NEXT"/);
  assert.match(metrics, /correlation_id="corr-runtime-next"/);
  assert.match(metrics, /product_id="SKU-RUNTIME-NEXT"/);

  const correlationResponse = await fetch(`${runtime.api.address}/v1/correlation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correlationId: "corr-runtime-legacy" })
  });
  assert.equal(correlationResponse.status, 200);
  assert.deepEqual(await correlationResponse.json(), {
    correlationId: "corr-runtime-legacy"
  });

  const clearResponse = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workOrderId: null,
      serialNumber: "",
      correlationId: null,
      productId: null
    })
  });
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), {
    workOrderId: null,
    serialNumber: null,
    correlationId: null,
    productId: null
  });
  const clearedEvent = runtime.collector.capture(plcSnapshot({ goodCount: 2 }), {
    occurredAt: new Date().toISOString()
  });
  assert.equal(Object.hasOwn(clearedEvent, "workOrderId"), false);
  assert.equal(Object.hasOwn(clearedEvent, "serialNumber"), false);
  assert.equal(Object.hasOwn(clearedEvent, "correlationId"), false);
  assert.equal(Object.hasOwn(clearedEvent, "productId"), false);

  const invalidResponse = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workOrderId: 42 })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /workOrderId/);
});

test("gateway runtime persists and restores work context", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-work-context-"));
  const statePath = path.join(directory, "work-context.json");
  let first = null;
  let second = null;
  t.after(async () => {
    await first?.runtime.stop().catch(() => undefined);
    await second?.runtime.stop().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  first = makeRuntime({ GATEWAY_WORK_CONTEXT_FILE: statePath });
  await first.runtime.start();
  const updated = await first.runtime.updateWorkContext({
    workOrderId: "WO-PERSISTED",
    serialNumber: "SN-PERSISTED",
    correlationId: "corr-persisted",
    productId: "SKU-PERSISTED"
  });
  assert.deepEqual(updated, {
    workOrderId: "WO-PERSISTED",
    serialNumber: "SN-PERSISTED",
    correlationId: "corr-persisted",
    productId: "SKU-PERSISTED"
  });
  const stored = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(stored.schemaVersion, "1.0");
  assert.equal(stored.workOrderId, "WO-PERSISTED");
  assert.equal(stored.serialNumber, "SN-PERSISTED");
  assert.equal(stored.correlationId, "corr-persisted");
  assert.equal(stored.productId, "SKU-PERSISTED");
  assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  await first.runtime.stop();
  first = null;

  second = makeRuntime({ GATEWAY_WORK_CONTEXT_FILE: statePath });
  await second.runtime.start();
  assert.deepEqual(second.runtime.getWorkContext(), updated);
  const quality = second.runtime.recordQualityEvent({
    sourceEventId: "QC-PERSISTED-CONTEXT",
    occurredAt: new Date().toISOString()
  });
  assert.equal(quality.event.workOrderId, "WO-PERSISTED");
  assert.equal(quality.event.serialNumber, "SN-PERSISTED");
  assert.equal(quality.event.correlationId, "corr-persisted");
  assert.equal(quality.event.productId, "SKU-PERSISTED");
  await second.runtime.stop();
  second = null;
});

test("gateway API scopes events, NG input and OEE by work context", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();

  await runtime.updateWorkContext({
    workOrderId: "WO-SCOPE-A",
    serialNumber: "SN-SCOPE-A",
    correlationId: "corr-scope-a",
    productId: "SKU-SCOPE-A"
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 0 }), { occurredAt: iso(0) });
  runtime.collector.capture(plcSnapshot({ goodCount: 2 }), { occurredAt: iso(1) });
  runtime.recordQualityEvent({
    sourceEventId: "QC-SCOPE-A",
    occurredAt: iso(1),
    quantity: 1
  });

  await runtime.updateWorkContext({
    workOrderId: "WO-SCOPE-B",
    serialNumber: "SN-SCOPE-B",
    correlationId: "corr-scope-b",
    productId: "SKU-SCOPE-B"
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 4 }), { occurredAt: iso(2) });
  runtime.collector.capture(plcSnapshot({ goodCount: 6 }), { occurredAt: iso(3) });
  runtime.recordQualityEvent({
    sourceEventId: "QC-SCOPE-B",
    occurredAt: iso(3),
    quantity: 2
  });

  const eventsResponse = await fetch(
    `${runtime.api.address}/v1/events?workOrderId=WO-SCOPE-A&correlationId=corr-scope-a&productId=SKU-SCOPE-A`
  );
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.count, 2);
  assert.ok(events.events.every((event) => event.workOrderId === "WO-SCOPE-A"));
  assert.ok(events.events.every((event) => event.productId === "SKU-SCOPE-A"));

  const qualityResponse = await fetch(
    `${runtime.api.address}/v1/quality-events?correlationId=corr-scope-b`
  );
  assert.equal(qualityResponse.status, 200);
  const quality = await qualityResponse.json();
  assert.equal(quality.count, 1);
  assert.equal(quality.events[0].workOrderId, "WO-SCOPE-B");
  assert.equal(quality.events[0].productId, "SKU-SCOPE-B");

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(3));
  oeeUrl.searchParams.set("workOrderId", "WO-SCOPE-A");
  oeeUrl.searchParams.set("productId", "SKU-SCOPE-A");
  const oeeResponse = await fetch(oeeUrl);
  assert.equal(oeeResponse.status, 200);
  const oee = await oeeResponse.json();
  assert.equal(oee.eventCount, 2);
  assert.equal(oee.qualityEventCount, 1);
  assert.equal(oee.qualityEventQuantity, 1);
  assert.deepEqual(oee.scope, {
    workOrderId: "WO-SCOPE-A",
    correlationId: null,
    productId: "SKU-SCOPE-A"
  });
});

test("RCA scopes context and alarms to the quality event work context", async (t) => {
  const { runtime } = makeRuntime();
  t.after(async () => runtime.stop());
  await runtime.start();

  await runtime.updateWorkContext({
    workOrderId: "WO-RCA-A",
    serialNumber: "SN-RCA-A",
    correlationId: "corr-rca-a",
    productId: "SKU-RCA-A"
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 0, temperatureC: 24 }), {
    occurredAt: iso(41)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 1, temperatureC: 92 }), {
    occurredAt: iso(51)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 2, temperatureC: 93 }), {
    occurredAt: iso(61)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 3, temperatureC: 24 }), {
    occurredAt: iso(71)
  });
  runtime.collector.recordAlarm({
    eventId: "alarm-rca-a",
    occurredAt: iso(51),
    code: "TEMPERATURE_SPIKE",
    severity: 800,
    message: "Temperature spike for A"
  });
  const qualityA = runtime.recordQualityEvent({
    sourceEventId: "QC-RCA-A",
    occurredAt: iso(61),
    quantity: 1
  });

  await runtime.updateWorkContext({
    workOrderId: "WO-RCA-B",
    serialNumber: "SN-RCA-B",
    correlationId: "corr-rca-b",
    productId: "SKU-RCA-B"
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 4, temperatureC: 24 }), {
    occurredAt: iso(42)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 5, temperatureC: 25 }), {
    occurredAt: iso(52)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 6, temperatureC: 25 }), {
    occurredAt: iso(62)
  });
  runtime.collector.capture(plcSnapshot({ goodCount: 7, temperatureC: 24 }), {
    occurredAt: iso(72)
  });
  const qualityB = runtime.recordQualityEvent({
    sourceEventId: "QC-RCA-B",
    occurredAt: iso(62),
    quantity: 1
  });

  const rcaA = runtime.analyzeRca({
    qualityEventId: qualityA.event.qualityEventId,
    windowMs: 30_000,
    temperatureThresholdC: 70
  });
  assert.equal(rcaA.scopeApplied, true);
  assert.deepEqual(rcaA.scope, {
    workOrderId: "WO-RCA-A",
    correlationId: "corr-rca-a",
    productId: "SKU-RCA-A"
  });
  assert.equal(rcaA.sampleCount, 4);
  assert.equal(rcaA.alarmCount, 1);
  assert.equal(rcaA.conclusion, "TEMPERATURE_SPIKE");

  const rcaB = runtime.analyzeRca({
    qualityEventId: qualityB.event.qualityEventId,
    windowMs: 30_000,
    temperatureThresholdC: 70
  });
  assert.equal(rcaB.scopeApplied, true);
  assert.deepEqual(rcaB.scope, {
    workOrderId: "WO-RCA-B",
    correlationId: "corr-rca-b",
    productId: "SKU-RCA-B"
  });
  assert.equal(rcaB.sampleCount, 4);
  assert.equal(rcaB.alarmCount, 0);
  assert.equal(rcaB.conclusion, "INCONCLUSIVE");

  const explicitMissing = runtime.analyzeRca({
    qualityEventId: qualityB.event.qualityEventId,
    workOrderId: "WO-RCA-MISSING",
    windowMs: 30_000
  });
  assert.equal(explicitMissing.scopeApplied, true);
  assert.equal(explicitMissing.sampleCount, 0);
  assert.equal(explicitMissing.conclusion, "INCONCLUSIVE");

  const alarmsResponse = await fetch(
    `${runtime.api.address}/v1/alarms?workOrderId=WO-RCA-A`
  );
  assert.equal(alarmsResponse.status, 200);
  const alarms = await alarmsResponse.json();
  assert.equal(alarms.count, 1);
  assert.equal(alarms.alarms[0].correlationId, "corr-rca-a");
});

test("gateway runtime stops the OPC UA client and HTTP API", async () => {
  const { runtime, client } = makeRuntime();
  await runtime.start();
  assert.equal(client.started, true);
  await runtime.stop();
  assert.equal(client.stopped, true);
  assert.equal(runtime.getStatus().opcuaConnected, false);
});

test("gateway runtime replays context and quality events after restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-replay-"));
  const env = {
    PROCESS_CONTEXT_LOG: path.join(directory, "process-context.jsonl"),
    QUALITY_EVENT_LOG: path.join(directory, "quality-events.jsonl"),
    QUALITY_EVENT_IDEMPOTENCY_FILE: path.join(directory, "quality-idempotency.json")
  };
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const first = makeRuntime(env);
  await first.runtime.start();
  captureWindow(first.runtime.collector);
  const quality = first.runtime.recordQualityEvent({
    sourceEventId: "QC-REPLAY-001",
    occurredAt: iso(10),
    quantity: 2,
    correlationId: "corr-replay-001"
  });
  assert.equal(quality.duplicate, false);
  await first.runtime.stop();

  const second = makeRuntime(env);
  try {
    await second.runtime.start();
    assert.equal(second.runtime.getStatus().quality.eventCount, 1);

    const duplicate = second.runtime.recordQualityEvent({
      sourceEventId: "QC-REPLAY-001",
      occurredAt: iso(10),
      quantity: 2
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.event.qualityEventId, quality.event.qualityEventId);
    assert.equal(second.runtime.getStatus().quality.eventCount, 1);

    const oee = second.runtime.calculateOee({ from: iso(0), to: iso(10) });
    assert.equal(oee.eventCount, 11);
    assert.equal(oee.qualitySource, "quality-events");
    assert.equal(oee.qualityEventCount, 1);
    assert.equal(oee.quality, 0.9);

    const rca = second.runtime.analyzeRca({
      qualityEventId: quality.event.qualityEventId,
      windowMs: 10_000
    });
    assert.equal(rca.conclusion, "TEMPERATURE_SPIKE");
    assert.equal(rca.correlationId, "corr-replay-001");
  } finally {
    await second.runtime.stop();
  }
});

test("gateway runtime preserves counter reset detection across restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-counter-reset-"));
  const env = {
    PROCESS_CONTEXT_LOG: path.join(directory, "process-context.jsonl"),
    QUALITY_EVENT_LOG: "off",
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off"
  };
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const first = makeRuntime(env);
  await first.runtime.start();
  first.runtime.collector.capture(
    plcSnapshot({ goodCount: 100, totalProducedCount: 200 }),
    { occurredAt: iso(0) }
  );
  first.runtime.collector.capture(
    plcSnapshot({ goodCount: 102, totalProducedCount: 204 }),
    { occurredAt: iso(1) }
  );
  await first.runtime.stop();

  const second = makeRuntime(env);
  try {
    await second.runtime.start();
    second.runtime.collector.capture(
      plcSnapshot({ goodCount: 0, totalProducedCount: 0 }),
      { occurredAt: iso(2) }
    );
    second.runtime.collector.capture(
      plcSnapshot({ goodCount: 2, totalProducedCount: 4 }),
      { occurredAt: iso(3) }
    );

    const oee = second.runtime.calculateOee({
      from: iso(0),
      to: iso(3),
      ngCount: 0
    });
    assert.equal(oee.eventCount, 4);
    assert.equal(oee.counterMode, "total-produced-reset-adjusted");
    assert.equal(oee.goodDelta, 4);
    assert.equal(oee.totalDelta, 8);
    assert.equal(oee.quality, 0.5);
    assert.equal(oee.counterContinuity.status, "reset-adjusted");
    assert.equal(oee.counterContinuity.resetCount, 2);
    assert.ok(oee.warnings.some((warning) => warning.includes("reset/rollback")));
  } finally {
    await second.runtime.stop();
  }
});
