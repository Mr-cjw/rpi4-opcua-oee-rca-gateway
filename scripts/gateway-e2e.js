"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { createMockPlcServer } = require("../src/server");
const { loadGatewayConfig } = require("../src/gateway/config");
const { GatewayRuntime } = require("../src/gateway/runtime");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-gateway-e2e-"));
  const port = await getFreePort();
  const serverConfig = loadConfig({
    ...process.env,
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: path.join(runDir, "server-pki"),
    SIM_INTERVAL_MS: "50",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0",
    SIM_SEED: "42",
    SIM_YIELD_RATE: "1.0"
  });
  const server = createMockPlcServer(serverConfig);
  let runtime = null;

  try {
    const running = await server.start();
    const gatewayConfig = loadGatewayConfig({
      OPCUA_ENDPOINT: running.endpointUrl,
      OPCUA_CLIENT_PKI_ROOT: path.join(runDir, "client-pki"),
      PROCESS_CONTEXT_LOG: "off",
      PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "100",
      GATEWAY_LINE_ID: "JX-LINE-01",
      GATEWAY_STATION_ID: "JX-LINQIN-STATION-01",
      GATEWAY_WORK_ORDER_ID: "WO-GATEWAY-E2E-001",
      GATEWAY_CORRELATION_ID: "corr-gateway-e2e",
      GATEWAY_HTTP_PORT: "0",
      GATEWAY_API_TOKEN: "",
      OEE_NOMINAL_OUTPUT_PER_MIN: "120"
    });
    runtime = new GatewayRuntime(gatewayConfig, {
      logger: { info() {}, warn() {}, error() {} }
    });

    await runtime.start();
    await waitFor(
      () => runtime.getLatestContext() !== null,
      5000,
      "the first process-context event"
    );
    console.log(`Gateway API: ${runtime.api.address}`);
    console.log(`OPC UA endpoint: ${running.endpointUrl}`);

    const health = await getJson(`${runtime.api.address}/healthz`);
    assert.equal(health.status, "ok");
    assert.equal(health.opcuaConnected, true);

    await sleep(1200);
    const beforeFault = await getJson(`${runtime.api.address}/v1/context/latest`);
    assert.equal(beforeFault.eventType, "PROCESS_CONTEXT");
    assert.equal(beforeFault.workOrderId, "WO-GATEWAY-E2E-001");

    server.simulator.triggerDowntime(2, "gateway-e2e");
    server.simulator.triggerTemperatureSpike(2, 95);
    await waitFor(
      () => Number(runtime.getLatestContext()?.metrics.temperatureC) >= 70,
      5000,
      "the temperature anomaly to reach the context API"
    );
    const anomaly = await getJson(`${runtime.api.address}/v1/context/latest`);
    assert.equal(anomaly.metrics.deviceStatus, "DOWN");
    assert.ok(anomaly.metrics.temperatureC >= 70);
    assert.ok(anomaly.alarms.some((alarm) => alarm.code === "DOWNTIME"));
    assert.ok(anomaly.alarms.some((alarm) => alarm.code === "TEMPERATURE_SPIKE"));

    const oee = await getJson(
      `${runtime.api.address}/v1/oee?ngCount=1&windowMs=300000`
    );
    for (const key of ["availability", "performance", "quality", "oee"]) {
      assert.ok(oee[key] >= 0 && oee[key] <= 1, `${key} must be between 0 and 1`);
    }
    assert.ok(oee.eventCount >= 2);

    const rca = await getJson(`${runtime.api.address}/v1/rca`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetAt: anomaly.occurredAt,
        windowMs: 10000,
        temperatureThresholdC: 70
      })
    });
    const codes = rca.candidates.map((candidate) => candidate.code);
    assert.ok(codes.includes("DOWNTIME"));
    assert.ok(codes.includes("TEMPERATURE_SPIKE"));
    for (const candidate of rca.candidates) {
      assert.equal(candidate.causalClaim, false);
      assert.ok(candidate.evidence.length > 0);
    }

    console.log(
      `OEE: ${(oee.oee * 100).toFixed(1)}% ` +
        `(A ${(oee.availability * 100).toFixed(1)}%, ` +
        `P ${(oee.performance * 100).toFixed(1)}%, ` +
        `Q ${(oee.quality * 100).toFixed(1)}%)`
    );
    console.log(`RCA candidates: ${codes.join(", ")}`);
    console.log("Gateway E2E test passed.");
  } finally {
    if (runtime) {
      await runtime.stop().catch(() => undefined);
    }
    await server.stop().catch(() => undefined);
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Gateway E2E test failed:", error);
  process.exitCode = 1;
});
