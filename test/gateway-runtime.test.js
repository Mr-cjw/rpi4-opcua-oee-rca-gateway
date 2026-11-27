"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

  const oeeUrl = new URL(`${runtime.api.address}/v1/oee`);
  oeeUrl.searchParams.set("from", iso(0));
  oeeUrl.searchParams.set("to", iso(10));
  oeeUrl.searchParams.set("ngCount", "2");
  const oeeResponse = await fetch(oeeUrl);
  assert.equal(oeeResponse.status, 200);
  const oee = await oeeResponse.json();
  assert.equal(oee.availability, 1);
  assert.equal(oee.performance, 0.9);
  assert.equal(oee.quality, 0.9);
  assert.equal(oee.oee, 0.81);

  const rcaResponse = await fetch(`${runtime.api.address}/v1/rca`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetAt: iso(10),
      windowMs: 10_000,
      temperatureThresholdC: 70
    })
  });
  assert.equal(rcaResponse.status, 200);
  const rca = await rcaResponse.json();
  assert.equal(rca.conclusion, "TEMPERATURE_SPIKE");
  assert.equal(rca.candidates[0].causalClaim, false);
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

test("gateway runtime stops the OPC UA client and HTTP API", async () => {
  const { runtime, client } = makeRuntime();
  await runtime.start();
  assert.equal(client.started, true);
  await runtime.stop();
  assert.equal(client.stopped, true);
  assert.equal(runtime.getStatus().opcuaConnected, false);
});
