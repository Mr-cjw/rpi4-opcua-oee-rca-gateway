"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  compareWithBaseline,
  contractSurface,
  createApiContract,
  operationsFromHttpSource
} = require("../src/gateway/api-contract");
const { createGatewayApi } = require("../src/gateway/http-api");
const { QualityEventNotFoundError } = require("../src/gateway/quality-events");
const { StorageWriteError } = require("../src/gateway/storage-health");

const ROOT = path.resolve(__dirname, "..");
const ISO = "2026-11-28T00:00:00.000Z";
const contractPromise = createApiContract();

const PROCESS_EVENT = {
  schemaVersion: "1.0",
  eventId: "evt-api-contract-001",
  sequence: 1,
  source: "rpi4-gateway",
  eventType: "PROCESS_CONTEXT",
  occurredAt: ISO,
  lineId: "JX-LINE-01",
  stationId: "JX-LINQIN-STATION-01",
  workOrderId: "WO-API-001",
  serialNumber: "SN-API-001",
  correlationId: "corr-api-001",
  productId: "SKU-API-001",
  metrics: {
    deviceStatus: "RUNNING",
    currentOutput: 120,
    goodCount: 98,
    totalProducedCount: 100,
    temperatureC: 24.5,
    alarmSequence: 1
  },
  alarms: []
};

const ALARM = {
  eventId: "alarm-api-contract-001",
  sequence: 1,
  occurredAt: ISO,
  code: "DOWNTIME",
  severity: 700,
  message: "Equipment stopped",
  cause: null,
  deviceStatus: "DOWN",
  temperatureC: null,
  currentOutput: null,
  goodCount: null,
  workOrderId: "WO-API-001",
  correlationId: "corr-api-001",
  productId: "SKU-API-001"
};

const QUALITY_EVENT = {
  schemaVersion: "1.0",
  qualityEventId: "qevt-api-contract-001",
  sequence: 1,
  sourceEventId: "QC-API-001",
  eventType: "NG_ORDER",
  result: "NG",
  occurredAt: ISO,
  recordedAt: ISO,
  lineId: "JX-LINE-01",
  stationId: "JX-LINQIN-STATION-01",
  workOrderId: "WO-API-001",
  serialNumber: "SN-API-001",
  correlationId: "corr-api-001",
  productId: "SKU-API-001",
  quantity: 1,
  defectType: "DENT",
  confidence: 0.97,
  metadata: { imageId: "IMG-API-001" }
};

function healthStatus() {
  const sequence = {
    stream: "quality",
    status: "ok",
    currentSequence: 1,
    gapsTotal: 0,
    missingEvents: 0,
    duplicatesTotal: 0,
    outOfOrderTotal: 0,
    gapRanges: [],
    lastObservedAt: ISO
  };
  return {
    status: "ok",
    opcuaConnected: true,
    startedAt: ISO,
    uptimeSeconds: 10,
    identity: {
      lineId: "JX-LINE-01",
      stationId: "JX-LINQIN-STATION-01",
      workOrderId: "WO-API-001",
      serialNumber: "SN-API-001",
      correlationId: "corr-api-001",
      productId: "SKU-API-001"
    },
    context: {
      eventCount: 1,
      alarmCount: 1,
      latestOccurredAt: ISO
    },
    quality: {
      eventCount: 1
    },
    sequences: {
      processContext: { ...sequence, stream: "process-context" },
      quality: sequence
    },
    clock: {
      schemaVersion: "1.0",
      status: "ok",
      healthy: true,
      synchronized: true,
      required: true,
      source: "injected",
      checkedAt: ISO,
      ageMs: 0,
      stale: false,
      offsetMs: 0,
      maxOffsetMs: 1000,
      checkIntervalMs: 60000,
      maxAgeMs: 180000,
      leapStatus: "Normal",
      reason: "synchronized",
      error: null
    },
    plc: {
      status: "ok",
      healthy: true,
      connected: true,
      summary: {
        variables: 6,
        badValues: 0,
        uncertainValues: 0,
        staleValues: 0,
        clockSkewValues: 0,
        futureTimestampValues: 0
      },
      variables: []
    },
    storage: {
      status: "ok",
      healthy: true,
      disk: {
        status: "ok",
        path: "/var/lib/rpi4-gateway",
        freeBytes: 1073741824,
        totalBytes: 8589934592,
        usageRatio: 0.875,
        lastCheckAt: ISO,
        lastError: null
      },
      components: {
        "quality-event-log": {
          status: "ok",
          consecutiveFailures: 0,
          totalFailures: 0,
          lastError: null,
          lastFailureAt: null,
          lastSuccessAt: ISO
        }
      }
    }
  };
}

function oeeResponse() {
  const counter = {
    status: "continuous",
    epochs: 1,
    resetCount: 0,
    delta: 10
  };
  return {
    range: {
      from: "2026-11-27T23:59:50.000Z",
      to: ISO,
      windowMs: 10000
    },
    eventCount: 2,
    scope: {
      workOrderId: "WO-API-001",
      correlationId: "corr-api-001",
      productId: null
    },
    availability: 1,
    performance: 1,
    quality: 1,
    oee: 1,
    observedSeconds: 10,
    plannedSeconds: 10,
    plannedProductionSeconds: 10,
    runningSeconds: 10,
    downtimeSeconds: 0,
    plannedStopSeconds: 0,
    plannedDowntimeSeconds: 0,
    changeoverSeconds: 0,
    unplannedStopSeconds: 0,
    unknownStopSeconds: 0,
    outsidePlanRunningSeconds: 0,
    goodDelta: 10,
    theoreticalGood: 20,
    totalDelta: null,
    counterScrapDelta: null,
    counterMode: "good-count-proxy",
    counterContinuity: {
      status: "continuous",
      resetCount: 0,
      epochs: 1,
      deltaBasis: "last-minus-first",
      goodCount: counter,
      totalProducedCount: { ...counter, status: "not-present", epochs: 0, delta: null },
      resets: []
    },
    ngCount: 1,
    nominalOutputPerMinute: 120,
    idealCycleTimeMs: null,
    idealCycleTimeSource: null,
    performanceSource: "nominal-output-rate",
    configuredProductCycleTimes: {},
    appliedCycleTimes: [],
    plannedTime: {
      timeZone: "Asia/Shanghai",
      windows: "00:00-24:00"
    },
    downtimeSources: {
      plannedStop: "shift-schedule",
      plannedDowntime: "disabled",
      changeover: "disabled",
      unplannedStop: "device-status",
      unknownStop: "device-status"
    },
    lossBreakdown: {
      availabilityLossSeconds: 0,
      plannedStopSeconds: 0,
      plannedDowntimeSeconds: 0,
      changeoverSeconds: 0,
      unplannedStopSeconds: 0,
      unknownStopSeconds: 0,
      outsidePlanRunningSeconds: 0,
      speedLossUnits: 10,
      qualityLossUnits: 1,
      speedLossSource: "good-counter-gap",
      qualityLossSource: "ngCount"
    },
    qualityReconciliation: {
      status: "counter-unavailable",
      qualitySource: "quality-events",
      counterScrapDelta: null,
      qualityInputQuantity: 1,
      qualityEventQuantity: 1,
      qualityEventCount: 1,
      delta: null,
      eventDelta: null,
      toleranceUnits: 0
    },
    dataQuality: {
      status: "ok",
      issueCount: 0,
      warningCount: 0,
      errorCount: 0,
      issues: []
    },
    inputs: {
      sampleCount: 2,
      counterMode: "good-count-proxy",
      counterScope: "first-to-last sample in observed window"
    },
    warnings: [],
    basis: {
      plannedTime: "intersection of sampled window and configured shift windows",
      availability: "RUNNING planned intervals / available planned intervals",
      performance: "goodCount delta / theoretical good units at nominal output",
      quality: "goodDelta / (goodDelta + ngCount)",
      lossBreakdown: "planned, speed, and quality loss decomposition"
    },
    qualitySource: "quality-events",
    qualityEventCount: 1,
    qualityEventQuantity: 1
  };
}

function rcaResponse() {
  return {
    targetAt: ISO,
    window: {
      from: "2026-11-27T23:55:00.000Z",
      to: "2026-11-28T00:05:00.000Z",
      windowMs: 300000
    },
    sampleCount: 2,
    alarmCount: 0,
    conclusion: "INCONCLUSIVE",
    candidates: [
      {
        code: "DOWNTIME",
        title: "Equipment downtime",
        score: 0.7,
        confidence: "medium",
        confidenceLabel: "time overlap, not causal proof",
        causalClaim: false,
        summary: "Equipment downtime overlaps the target window.",
        evidence: [
          {
            type: "process-context",
            eventId: PROCESS_EVENT.eventId,
            occurredAt: ISO,
            correlationId: PROCESS_EVENT.correlationId,
            detail: "deviceStatus became DOWN in the target window"
          }
        ]
      }
    ],
    disclaimer:
      "Candidates are derived from time-window overlap. They are not evidence of causation and require human confirmation.",
    scope: {
      workOrderId: "WO-API-001",
      correlationId: "corr-api-001",
      productId: null
    },
    scopeApplied: true,
    warnings: []
  };
}

function createRuntime() {
  const state = {
    latest: PROCESS_EVENT,
    workContext: {
      workOrderId: "WO-API-001",
      serialNumber: "SN-API-001",
      correlationId: "corr-api-001",
      productId: "SKU-API-001"
    },
    qualityEvents: [],
    qualityBySource: new Map(),
    failQualityStorage: false,
    failWorkContextStorage: false
  };
  const runtime = {
    getStatus: () => healthStatus(),
    getLatestContext: () => state.latest,
    getWorkContext: () => ({ ...state.workContext }),
    updateWorkContext: async (update) => {
      if (state.failWorkContextStorage) {
        throw new StorageWriteError("Unable to persist work context: ENOSPC");
      }
      for (const field of ["workOrderId", "serialNumber", "correlationId", "productId"]) {
        if (Object.prototype.hasOwnProperty.call(update, field)) {
          state.workContext[field] = update[field] || null;
        }
      }
      return { ...state.workContext };
    },
    getContextEvents: () => [PROCESS_EVENT],
    getAlarmHistory: () => [ALARM],
    calculateOee: () => oeeResponse(),
    recordQualityEventDurable: async (body) => {
      if (state.failQualityStorage) {
        throw new StorageWriteError("Unable to persist quality event: ENOSPC");
      }
      const existing = state.qualityBySource.get(body.sourceEventId);
      if (existing) {
        return { event: existing, duplicate: true, retained: true };
      }
      const event = {
        ...QUALITY_EVENT,
        sourceEventId: body.sourceEventId,
        occurredAt: body.occurredAt || ISO
      };
      state.qualityBySource.set(body.sourceEventId, event);
      state.qualityEvents.push(event);
      return { event, duplicate: false };
    },
    getQualityEvents: () => state.qualityEvents,
    getQualityEvent: (qualityEventId) =>
      state.qualityEvents.find((event) => event.qualityEventId === qualityEventId),
    analyzeRca: ({ qualityEventId }) => {
      if (qualityEventId && qualityEventId !== QUALITY_EVENT.qualityEventId) {
        throw new QualityEventNotFoundError(qualityEventId);
      }
      return rcaResponse();
    },
    setCorrelationId: async (correlationId) =>
      (await runtime.updateWorkContext({ correlationId })).correlationId
  };
  return { runtime, state };
}

async function startApi(runtime, options = {}) {
  const api = createGatewayApi(runtime, {
    host: "127.0.0.1",
    port: 0,
    token: "",
    ...options
  });
  await api.listen();
  return api;
}

async function request(api, routePath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${api.address}${routePath}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  return {
    status: response.status,
    headers: response.headers,
    body: isJson ? JSON.parse(text) : text
  };
}

test("HTTP contract matches source, examples, and the frozen baseline", async () => {
  const contract = await contractPromise;
  const source = await fs.readFile(path.join(ROOT, "src", "gateway", "http-api.js"), "utf8");
  assert.deepEqual(operationsFromHttpSource(source), contract.operations);
  assert.ok(contract.validateDocumentedExamples() >= 13);

  const baseline = JSON.parse(
    await fs.readFile(path.join(ROOT, "contracts", "http-api.surface.json"), "utf8")
  );
  const surface = contractSurface(contract.bundledDocument);
  assert.deepEqual(compareWithBaseline(surface, baseline), []);

  const regressed = structuredClone(surface);
  regressed.operations = regressed.operations.filter((operation) => operation !== "POST /v1/rca");
  regressed.parameters["GET /v1/events"] = regressed.parameters["GET /v1/events"].filter(
    (parameter) => parameter !== "query:limit"
  );
  regressed.responses["POST /v1/quality-events"] = regressed.responses[
    "POST /v1/quality-events"
  ].filter((status) => status !== "503");
  regressed.schemas.QualityEvent = regressed.schemas.QualityEvent.filter(
    (field) => field !== "sourceEventId"
  );
  regressed.required.QualityEvent = regressed.required.QualityEvent.filter(
    (field) => field !== "metadata"
  );
  const failures = compareWithBaseline(regressed, baseline);
  assert.ok(failures.some((failure) => failure.includes("POST /v1/rca")));
  assert.ok(failures.some((failure) => failure.includes("query:limit")));
  assert.ok(failures.some((failure) => failure.includes("503")));
  assert.ok(failures.some((failure) => failure.includes("sourceEventId")));
  assert.ok(failures.some((failure) => failure.includes("metadata")));
});

test("documented success responses validate against the live HTTP server", async (t) => {
  const contract = await contractPromise;
  const { runtime } = createRuntime();
  const api = await startApi(runtime);
  t.after(() => api.close());

  let result = await request(api, "/healthz");
  assert.equal(result.status, 200);
  contract.validateResponse("/healthz", "GET", result.status, result.body);

  result = await request(api, "/metrics");
  assert.equal(result.status, 200);
  contract.validateResponse("/metrics", "GET", result.status, result.body);

  result = await request(api, "/v1/context/latest");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/context/latest", "GET", result.status, result.body);

  result = await request(api, "/v1/work-context");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/work-context", "GET", result.status, result.body);

  result = await request(api, "/v1/work-context", {
    method: "POST",
    body: JSON.stringify({ workOrderId: "WO-API-002" })
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.workOrderId, "WO-API-002");
  contract.validateResponse("/v1/work-context", "POST", result.status, result.body);

  result = await request(api, "/v1/events?limit=1");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/events", "GET", result.status, result.body);

  result = await request(api, "/v1/alarms?limit=1");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/alarms", "GET", result.status, result.body);

  result = await request(api, "/v1/oee?windowMs=10000");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/oee", "GET", result.status, result.body);

  const qualityInput = JSON.stringify({
    sourceEventId: "QC-API-CONTRACT-001",
    occurredAt: ISO,
    result: "NG",
    quantity: 1
  });
  result = await request(api, "/v1/quality-events", {
    method: "POST",
    body: qualityInput
  });
  assert.equal(result.status, 201);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);

  result = await request(api, "/v1/quality-events", {
    method: "POST",
    body: qualityInput
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);

  result = await request(api, "/v1/quality-events");
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/quality-events", "GET", result.status, result.body);

  result = await request(api, `/v1/quality-events/${QUALITY_EVENT.qualityEventId}`);
  assert.equal(result.status, 200);
  contract.validateResponse(
    "/v1/quality-events/{qualityEventId}",
    "GET",
    result.status,
    result.body
  );

  result = await request(api, "/v1/rca", {
    method: "POST",
    body: JSON.stringify({ qualityEventId: QUALITY_EVENT.qualityEventId })
  });
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/rca", "POST", result.status, result.body);

  result = await request(api, "/v1/correlation", {
    method: "POST",
    body: JSON.stringify({ correlationId: "corr-api-002" })
  });
  assert.equal(result.status, 200);
  contract.validateResponse("/v1/correlation", "POST", result.status, result.body);
});

test("documented errors and retry semantics validate against the live HTTP server", async (t) => {
  const contract = await contractPromise;
  const { runtime, state } = createRuntime();
  const api = await startApi(runtime, { token: "contract-token" });
  t.after(() => api.close());
  const authorization = { authorization: "Bearer contract-token" };

  let result = await request(api, "/healthz");
  assert.equal(result.status, 200);
  contract.validateResponse("/healthz", "GET", result.status, result.body);

  result = await request(api, "/v1/work-context");
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("www-authenticate"), "Bearer");
  contract.validateResponse("/v1/work-context", "GET", result.status, result.body);

  result = await request(api, "/v1/quality-events", {
    method: "POST",
    headers: authorization,
    body: "{"
  });
  assert.equal(result.status, 400);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);

  result = await request(api, "/v1/quality-events", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ sourceEventId: "QC-TOO-LARGE", padding: "x".repeat(1024 * 1024) })
  });
  assert.equal(result.status, 413);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);

  state.latest = null;
  result = await request(api, "/v1/context/latest", { headers: authorization });
  assert.equal(result.status, 404);
  contract.validateResponse("/v1/context/latest", "GET", result.status, result.body);
  state.latest = PROCESS_EVENT;

  result = await request(api, "/v1/quality-events/qevt-missing", { headers: authorization });
  assert.equal(result.status, 404);
  contract.validateResponse(
    "/v1/quality-events/{qualityEventId}",
    "GET",
    result.status,
    result.body
  );

  result = await request(api, "/v1/rca", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ qualityEventId: "qevt-missing" })
  });
  assert.equal(result.status, 404);
  contract.validateResponse("/v1/rca", "POST", result.status, result.body);

  state.failQualityStorage = true;
  result = await request(api, "/v1/quality-events", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({
      sourceEventId: "QC-RETRY-SAME-ID",
      occurredAt: ISO,
      result: "NG"
    })
  });
  assert.equal(result.status, 503);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);
  state.failQualityStorage = false;

  result = await request(api, "/v1/quality-events", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({
      sourceEventId: "QC-RETRY-SAME-ID",
      occurredAt: ISO,
      result: "NG"
    })
  });
  assert.equal(result.status, 201);
  contract.validateResponse("/v1/quality-events", "POST", result.status, result.body);

  state.failWorkContextStorage = true;
  result = await request(api, "/v1/work-context", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ workOrderId: "WO-STORAGE-FAIL" })
  });
  assert.equal(result.status, 503);
  contract.validateResponse("/v1/work-context", "POST", result.status, result.body);

  result = await request(api, "/v1/correlation", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ correlationId: "corr-storage-fail" })
  });
  assert.equal(result.status, 503);
  contract.validateResponse("/v1/correlation", "POST", result.status, result.body);
});
