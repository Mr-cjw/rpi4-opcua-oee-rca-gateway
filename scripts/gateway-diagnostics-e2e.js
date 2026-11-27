"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { StatusCodes } = require("node-opcua");
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
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`
  );
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getHealth(runtime) {
  return getJson(`${runtime.api.address}/healthz`);
}

async function getMetrics(runtime) {
  const response = await fetch(`${runtime.api.address}/metrics`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from /metrics: ${body}`);
  }
  return body;
}

async function waitForHealth(runtime, predicate, timeoutMs, description) {
  let health;
  await waitFor(
    async () => {
      health = await getHealth(runtime);
      return predicate(health);
    },
    timeoutMs,
    description
  );
  return health;
}

function variableNamed(health, name) {
  return health.plc.variables.find((variable) => variable.name === name);
}

function metricValue(metrics, name) {
  const match = metrics.match(new RegExp(`^${name} ([0-9.]+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

async function startServer(serverConfig, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const server = createMockPlcServer(serverConfig);
    try {
      return { server, running: await server.start() };
    } catch (error) {
      lastError = error;
      await server.stop().catch(() => undefined);
      if (attempt < attempts) {
        await sleep(300 * attempt);
      }
    }
  }
  throw lastError;
}

async function main() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-gateway-diagnostics-e2e-"));
  const port = await getFreePort();
  const serverConfig = loadConfig({
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: path.join(runDir, "server-pki"),
    SIM_INTERVAL_MS: "50",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0",
    SIM_SEED: "73",
    SIM_YIELD_RATE: "0.98"
  });
  let started = await startServer(serverConfig);
  let server = started.server;
  let runtime = null;

  try {
    const gatewayConfig = loadGatewayConfig({
      OPCUA_ENDPOINT: started.running.endpointUrl,
      OPCUA_CLIENT_PKI_ROOT: path.join(runDir, "client-pki"),
      OPCUA_DATA_CHANGE_TRIGGER: "StatusValueTimestamp",
      OPCUA_PUBLISHING_INTERVAL_MS: "100",
      OPCUA_SAMPLING_INTERVAL_MS: "100",
      OPCUA_RECONNECT_MIN_DELAY_MS: "100",
      OPCUA_RECONNECT_MAX_DELAY_MS: "1000",
      PROCESS_CONTEXT_LOG: "off",
      QUALITY_EVENT_LOG: "off",
      QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
      PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "100",
      GATEWAY_WORK_CONTEXT_FILE: "off",
      GATEWAY_HTTP_PORT: "0",
      GATEWAY_API_TOKEN: "",
      GATEWAY_PLC_STALE_WARNING_MS: "1000",
      GATEWAY_PLC_CLOCK_SKEW_WARNING_MS: "1000"
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
    await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok",
      5000,
      "healthy initial PLC diagnostics"
    );
    console.log(`Gateway API: ${runtime.api.address}`);
    console.log(`OPC UA endpoint: ${started.running.endpointUrl}`);

    server.injectVariableStatus("currentOutput", StatusCodes.BadSensorFailure);
    const badHealth = await waitForHealth(
      runtime,
      (health) => health.plc?.summary?.badValues === 1,
      5000,
      "Bad currentOutput diagnostics"
    );
    assert.equal(badHealth.status, "degraded");
    assert.equal(badHealth.opcuaConnected, true);
    assert.equal(badHealth.plc.status, "critical");
    assert.equal(badHealth.plc.summary.badValues, 1);
    const badVariable = variableNamed(badHealth, "currentOutput");
    assert.equal(badVariable.good, false);
    assert.ok(badVariable.issues.includes("bad_status"));
    let metrics = await getMetrics(runtime);
    assert.equal(metricValue(metrics, "rpi4_gateway_plc_diagnostics_healthy"), 0);
    assert.equal(metricValue(metrics, "rpi4_gateway_plc_bad_values"), 1);
    assert.match(metrics, /^rpi4_gateway_plc_value_good\{name="currentOutput"\} 0$/m);

    await sleep(250);
    const pausedSequence = runtime.getLatestContext()?.sequence;
    await sleep(350);
    assert.equal(
      runtime.getLatestContext()?.sequence,
      pausedSequence,
      "a Bad required tag must pause process-context capture"
    );

    server.injectVariableStatus("currentOutput", StatusCodes.Good);
    await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok",
      5000,
      "recovery after Bad status"
    );

    server.injectVariableStatus("temperatureSensor", StatusCodes.Uncertain);
    const uncertainHealth = await waitForHealth(
      runtime,
      (health) => health.plc?.summary?.uncertainValues === 1,
      5000,
      "Uncertain temperature diagnostics"
    );
    assert.equal(uncertainHealth.status, "degraded");
    assert.equal(uncertainHealth.plc.status, "warning");
    assert.ok(
      variableNamed(uncertainHealth, "temperatureSensor").issues.includes(
        "uncertain_status"
      )
    );
    metrics = await getMetrics(runtime);
    assert.equal(metricValue(metrics, "rpi4_gateway_plc_uncertain_values"), 1);

    server.injectVariableStatus("temperatureSensor", StatusCodes.Good);
    await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok",
      5000,
      "recovery after Uncertain status"
    );

    server.freezeVariable("temperatureSensor");
    const staleHealth = await waitForHealth(
      runtime,
      (health) => health.plc?.summary?.staleValues === 1,
      5000,
      "stale temperature diagnostics"
    );
    const staleVariable = variableNamed(staleHealth, "temperatureSensor");
    assert.equal(staleHealth.status, "degraded");
    assert.equal(staleHealth.plc.status, "warning");
    assert.equal(staleVariable.stale, true);
    assert.ok(staleVariable.ageMs >= 1000);
    assert.ok(staleVariable.issues.includes("stale_value"));
    metrics = await getMetrics(runtime);
    assert.equal(metricValue(metrics, "rpi4_gateway_plc_stale_values"), 1);
    assert.match(metrics, /^rpi4_gateway_plc_value_stale\{name="temperatureSensor"\} 1$/m);

    server.freezeVariable("temperatureSensor", false);
    await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok",
      5000,
      "recovery after stale value"
    );

    server.setSourceTimestampOffsetMs(5000);
    const skewHealth = await waitForHealth(
      runtime,
      (health) => {
        const variable = variableNamed(health, "temperatureSensor");
        return variable?.clockSkewMs >= 4000;
      },
      5000,
      "future-source and clock-skew diagnostics"
    );
    const skewVariable = variableNamed(skewHealth, "temperatureSensor");
    assert.equal(skewHealth.status, "degraded");
    assert.equal(skewHealth.plc.status, "warning");
    assert.ok(skewVariable.issues.includes("future_source_timestamp"));
    assert.ok(skewVariable.issues.includes("source_server_clock_skew"));
    metrics = await getMetrics(runtime);
    assert.ok(metricValue(metrics, "rpi4_gateway_plc_clock_skew_values") >= 1);
    assert.ok(metricValue(metrics, "rpi4_gateway_plc_future_timestamp_values") >= 1);
    assert.ok(
      metricValue(
        metrics,
        'rpi4_gateway_plc_value_clock_skew_seconds{name="temperatureSensor"}'
      ) >= 4
    );

    server.setSourceTimestampOffsetMs(0);
    await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok",
      5000,
      "recovery after clock skew"
    );

    await server.stop();
    const disconnectedHealth = await waitForHealth(
      runtime,
      (health) => health.opcuaConnected === false && health.plc?.connection?.currentGapMs > 0,
      5000,
      "Gateway disconnect after PLC shutdown"
    );
    assert.equal(disconnectedHealth.status, "degraded");
    assert.equal(disconnectedHealth.plc.status, "critical");
    await sleep(1200);

    started = await startServer(serverConfig);
    server = started.server;
    const recoveredHealth = await waitForHealth(
      runtime,
      (health) => health.plc?.status === "ok" && health.opcuaConnected === true,
      10000,
      "Gateway reconnect and diagnostics recovery"
    );
    assert.ok(recoveredHealth.plc.connection.reconnectCount >= 1);
    assert.ok(recoveredHealth.plc.connection.maxReconnectGapMs >= 1000);

    const resumedFrom = runtime.getLatestContext()?.sequence;
    await waitFor(
      () => runtime.getLatestContext()?.sequence > resumedFrom,
      5000,
      "process-context capture to resume after reconnect"
    );

    console.log("PLC diagnostics E2E test passed.");
  } finally {
    if (runtime) {
      await runtime.stop().catch(() => undefined);
    }
    await server.stop().catch(() => undefined);
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("PLC diagnostics E2E test failed:", error);
  process.exitCode = 1;
});
