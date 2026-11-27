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

function plcSnapshot({ goodCount = 0, deviceStatus = "RUNNING", temperatureC = 24 } = {}) {
  return {
    deviceStatus: { value: deviceStatus },
    currentOutput: { value: 120 },
    goodCount: { value: goodCount },
    temperatureSensor: { value: temperatureC },
    alarmEvents: { alarmSnapshot: { sequence: 0, active: [] } }
  };
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
}

function makeRuntime(extraEnv = {}) {
  const config = loadGatewayConfig({
    OPCUA_ENDPOINT: "opc.tcp://127.0.0.1:1/UA/MockPLC",
    PROCESS_CONTEXT_LOG: "off",
    QUALITY_EVENT_LOG: "off",
    GATEWAY_HTTP_PORT: "0",
    GATEWAY_LINE_ID: "JX-LINE-01",
    GATEWAY_STATION_ID: "JX-LINQIN-STATION-01",
    OEE_NOMINAL_OUTPUT_PER_MIN: "120",
    GATEWAY_API_TOKEN: "",
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

function captureWindow(collector) {
  const goodCounts = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18];
  for (let second = 0; second <= 10; second += 1) {
    collector.capture(
      plcSnapshot({
        goodCount: goodCounts[second],
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
  assert.equal(oee.qualitySource, "quality-events");
  assert.equal(oee.qualityEventCount, 1);
  assert.equal(oee.qualityEventQuantity, 2);

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

  const missingRcaResponse = await fetch(`${runtime.api.address}/v1/rca`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qualityEventId: "qevt-missing" })
  });
  assert.equal(missingRcaResponse.status, 404);
});

test("gateway API enforces a bearer token when configured", async (t) => {
  const { runtime } = makeRuntime({ GATEWAY_API_TOKEN: "test-token" });
  t.after(async () => runtime.stop());
  await runtime.start();

  const unauthorized = await fetch(`${runtime.api.address}/v1/context/latest`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`${runtime.api.address}/healthz`);
  assert.equal(health.status, 200);

  const authorized = await fetch(`${runtime.api.address}/v1/context/latest`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(authorized.status, 200);
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
    correlationId: null
  });

  const updateResponse = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workOrderId: "WO-RUNTIME-NEXT",
      serialNumber: "SN-RUNTIME-NEXT",
      correlationId: "corr-runtime-next"
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), {
    workOrderId: "WO-RUNTIME-NEXT",
    serialNumber: "SN-RUNTIME-NEXT",
    correlationId: "corr-runtime-next"
  });

  const event = runtime.collector.capture(plcSnapshot({ goodCount: 1 }), {
    occurredAt: new Date().toISOString()
  });
  assert.equal(event.workOrderId, "WO-RUNTIME-NEXT");
  assert.equal(event.serialNumber, "SN-RUNTIME-NEXT");
  assert.equal(event.correlationId, "corr-runtime-next");

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
    body: JSON.stringify({ workOrderId: null, serialNumber: "", correlationId: null })
  });
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), {
    workOrderId: null,
    serialNumber: null,
    correlationId: null
  });
  const clearedEvent = runtime.collector.capture(plcSnapshot({ goodCount: 2 }), {
    occurredAt: new Date().toISOString()
  });
  assert.equal(Object.hasOwn(clearedEvent, "workOrderId"), false);
  assert.equal(Object.hasOwn(clearedEvent, "serialNumber"), false);
  assert.equal(Object.hasOwn(clearedEvent, "correlationId"), false);

  const invalidResponse = await fetch(`${runtime.api.address}/v1/work-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workOrderId: 42 })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /workOrderId/);
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
    QUALITY_EVENT_LOG: path.join(directory, "quality-events.jsonl")
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
