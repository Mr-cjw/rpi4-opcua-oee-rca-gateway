"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { loadGatewayConfig } = require("../src/gateway/config");
const { evaluateDoctorReadings, runGatewayDoctor } = require("../src/gateway/doctor");
const { createMockPlcServer } = require("../src/server");

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

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

function reading(name, nodeId, value, dataType, overrides = {}) {
  return {
    name,
    nodeId,
    value,
    dataType,
    statusCode: "Good (0x00000000)",
    statusGood: true,
    sourceTimestamp: new Date(NOW).toISOString(),
    serverTimestamp: new Date(NOW).toISOString(),
    ...overrides
  };
}

function healthyReadings(counterStart = 10) {
  return [
    reading("deviceStatus", "ns=2;s=Status", "RUNNING", "String"),
    reading("currentOutput", "ns=2;s=Output", 120, "Double"),
    reading("goodCount", "ns=2;s=Good", counterStart, "UInt32"),
    reading("totalProducedCount", "ns=2;s=Total", counterStart + 1, "UInt32"),
    reading("temperatureSensor", "ns=2;s=Temperature", 24.5, "Double"),
    reading("alarmEvents", "ns=2;s=Alarms", '{"active":[],"latest":null}', "String")
  ];
}

function evaluate(firstReadings, secondReadings = firstReadings) {
  return evaluateDoctorReadings({
    endpointUrl: "opc.tcp://plc.example:4840/UA/Line",
    firstReadings,
    secondReadings,
    eventNotifier: {
      nodeId: "ns=2;s=Alarms",
      value: 1,
      statusCode: "Good (0x00000000)",
      statusGood: true
    },
    now: NOW,
    options: { sampleMs: 1000 }
  });
}

test("doctor reports a ready PLC mapping", () => {
  const report = evaluate(healthyReadings(10), healthyReadings(12));

  assert.equal(report.overallStatus, "pass");
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.fail, 0);
  assert.ok(report.checks.some((check) => check.code === "COUNTER_INVARIANTS_READY"));
  assert.ok(report.checks.some((check) => check.code === "ALARM_EVENTS_JSON_READY"));
  assert.ok(report.checks.some((check) => check.code === "EVENT_NOTIFIER_READY"));
  assert.ok(report.checks.every((check) => check.status === "pass"));
});

test("doctor fails counter invariants and wrong data types", () => {
  const first = healthyReadings(10);
  first[1] = reading("currentOutput", "ns=2;s=Output", "120", "String");
  first[2] = reading("goodCount", "ns=2;s=Good", 10, "UInt32");
  first[3] = reading("totalProducedCount", "ns=2;s=Total", 15, "UInt32");
  const second = healthyReadings(10);
  second[2] = reading("goodCount", "ns=2;s=Good", 12, "UInt32");
  second[3] = reading("totalProducedCount", "ns=2;s=Total", 11, "UInt32");

  const report = evaluate(first, second);

  assert.equal(report.overallStatus, "fail");
  assert.equal(report.exitCode, 1);
  assert.ok(report.checks.some((check) => check.code === "CURRENT_OUTPUT_DATA_TYPE"));
  assert.ok(report.checks.some((check) => check.code === "TOTAL_PRODUCED_COUNT_DECREASED"));
  assert.ok(report.checks.some((check) => check.code === "GOOD_COUNT_EXCEEDS_TOTAL_SECOND"));
  assert.equal(
    report.checks.some((check) => check.code === "COUNTER_INVARIANTS_READY"),
    false
  );
});

test("doctor warns on missing timestamps and disabled event notifications", () => {
  const first = healthyReadings(10);
  first[0] = reading("deviceStatus", "ns=2;s=Status", "RUNNING", "String", {
    sourceTimestamp: null
  });
  const report = evaluateDoctorReadings({
    endpointUrl: "opc.tcp://plc.example:4840/UA/Line",
    firstReadings: first,
    secondReadings: first,
    eventNotifier: {
      nodeId: "ns=2;s=Alarms",
      value: 0,
      statusCode: "Good (0x00000000)",
      statusGood: true
    },
    now: NOW,
    options: { sampleMs: 1000 }
  });

  assert.equal(report.overallStatus, "warn");
  assert.equal(report.exitCode, 0);
  assert.ok(
    report.checks.some((check) => check.code === "DEVICE_STATUS_SOURCE_TIMESTAMP_MISSING")
  );
  assert.ok(report.checks.some((check) => check.code === "EVENT_NOTIFIER_DISABLED"));
});

test("doctor connects to the mock PLC and validates all configured points", { timeout: 30000 }, async (t) => {
  const port = await getFreePort();
  const pkiRoot = path.join(os.tmpdir(), `gateway-doctor-${Date.now()}-${port}`);
  const serverConfig = loadConfig({
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: pkiRoot,
    SIM_INTERVAL_MS: "100",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0"
  });
  const server = createMockPlcServer(serverConfig);
  const running = await server.start();
  const config = loadGatewayConfig({
    OPCUA_ENDPOINT: running.endpointUrl,
    OPCUA_CLIENT_PKI_ROOT: pkiRoot
  });

  t.after(async () => {
    await server.stop();
    await fs.rm(pkiRoot, { recursive: true, force: true });
  });

  const report = await runGatewayDoctor(config, { sampleMs: 250 });

  assert.equal(report.overallStatus, "pass");
  assert.equal(report.variables.length, 6);
  assert.ok(report.variables.every((variable) => variable.statusGood));
  assert.ok(report.variables.every((variable) => variable.sourceTimestamp));
  assert.ok(report.checks.some((check) => check.code === "COUNTER_INVARIANTS_READY"));
  assert.ok(report.checks.some((check) => check.code === "EVENT_NOTIFIER_READY"));
});
