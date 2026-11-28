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
    const result = await predicate();
    if (result) {
      return result;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function getHealth(runtime) {
  const response = await fetch(`${runtime.api.address}/healthz`);
  assert.equal(response.status, 200);
  return response.json();
}

async function getMetrics(runtime) {
  const response = await fetch(`${runtime.api.address}/metrics`);
  assert.equal(response.status, 200);
  return response.text();
}

function metricValue(metrics, name) {
  const match = metrics.match(new RegExp(`^${name} ([0-9.]+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

async function main() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-gateway-clock-e2e-"));
  const port = await getFreePort();
  const serverConfig = loadConfig({
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: path.join(runDir, "server-pki"),
    SIM_INTERVAL_MS: "100",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0"
  });
  const server = createMockPlcServer(serverConfig);
  let runtime = null;
  let clockMode = "synchronized";
  try {
    const running = await server.start();
    const gatewayConfig = loadGatewayConfig({
      OPCUA_ENDPOINT: running.endpointUrl,
      OPCUA_CLIENT_PKI_ROOT: path.join(runDir, "client-pki"),
      PROCESS_CONTEXT_LOG: "off",
      QUALITY_EVENT_LOG: "off",
      QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
      PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "100",
      GATEWAY_WORK_CONTEXT_FILE: "off",
      GATEWAY_HTTP_PORT: "0",
      GATEWAY_CLOCK_SYNC_CHECK_INTERVAL_MS: "1000",
      GATEWAY_CLOCK_SYNC_MAX_AGE_MS: "5000",
      GATEWAY_CLOCK_SYNC_MAX_OFFSET_MS: "100",
      GATEWAY_CLOCK_SYNC_REQUIRED: "true"
    });
    runtime = new GatewayRuntime(gatewayConfig, {
      logger: { info() {}, warn() {}, error() {} },
      checkClock: async () => {
        if (clockMode === "unsynchronized") {
          return { synchronized: false, source: "injected-e2e" };
        }
        return {
          synchronized: true,
          source: "injected-e2e",
          offsetMs: 12,
          leapStatus: "Normal"
        };
      }
    });

    await runtime.start();
    const synced = await getHealth(runtime);
    assert.equal(synced.status, "ok");
    assert.equal(synced.clock.status, "ok");
    assert.equal(synced.clock.synchronized, true);
    assert.equal(synced.clock.source, "injected-e2e");
    assert.equal(synced.clock.required, true);
    let metrics = await getMetrics(runtime);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_sync_healthy"), 1);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_synchronized"), 1);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_sync_required"), 1);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_offset_seconds"), 0.012);
    console.log("Verified required synchronized clock health.");

    clockMode = "unsynchronized";
    const unsynchronized = await waitFor(
      async () => {
        const health = await getHealth(runtime);
        return health.clock.status === "warning" && health.status === "degraded"
          ? health
          : null;
      },
      5000,
      "unsynchronized clock degradation"
    );
    assert.equal(unsynchronized.clock.synchronized, false);
    assert.equal(unsynchronized.clock.reason, "not_synchronized");
    metrics = await getMetrics(runtime);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_sync_healthy"), 0);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_synchronized"), 0);
    assert.equal(metricValue(metrics, "rpi4_gateway_clock_sync_known"), 1);
    assert.match(
      metrics,
      /^rpi4_gateway_clock_sync_info\{status="warning",source="injected-e2e"\} 1$/m
    );
    console.log("Verified unsynchronized clock degradation and metrics.");

    clockMode = "synchronized";
    await waitFor(
      async () => {
        const health = await getHealth(runtime);
        return health.status === "ok" && health.clock.status === "ok";
      },
      5000,
      "clock synchronization recovery"
    );
    console.log("Clock synchronization E2E test passed.");
  } finally {
    if (runtime) {
      await runtime.stop().catch(() => undefined);
    }
    await server.stop().catch(() => undefined);
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Gateway clock synchronization E2E test failed:", error);
  process.exitCode = 1;
});
