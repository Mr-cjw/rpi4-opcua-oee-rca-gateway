"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGatewayConfig } = require("../src/gateway/config");

test("gateway config keeps the mock PLC node map by default", () => {
  const config = loadGatewayConfig({});
  assert.deepEqual(
    config.variables.map(({ name, nodeId }) => [name, nodeId]),
    [
      ["deviceStatus", "ns=1;s=MockPLC.DeviceStatus"],
      ["currentOutput", "ns=1;s=MockPLC.CurrentOutput"],
      ["goodCount", "ns=1;s=MockPLC.GoodCount"],
      ["totalProducedCount", "ns=1;s=MockPLC.TotalProducedCount"],
      ["temperatureSensor", "ns=1;s=MockPLC.TemperatureSensor"],
      ["alarmEvents", "ns=1;s=MockPLC.AlarmEvents"]
    ]
  );
  assert.equal(config.eventNodeId, "ns=1;s=MockPLC");
});

test("gateway config maps a real PLC and can disable optional event sources", () => {
  const config = loadGatewayConfig({
    OPCUA_DEVICE_STATUS_NODE: "ns=2;s=Line1.RunState",
    OPCUA_CURRENT_OUTPUT_NODE: "ns=2;s=Line1.Output",
    OPCUA_GOOD_COUNT_NODE: "ns=2;s=Line1.GoodCount",
    OPCUA_TOTAL_PRODUCED_NODE: "ns=2;s=Line1.TotalProduced",
    OPCUA_TEMPERATURE_NODE: "ns=2;s=Line1.Temperature",
    OPCUA_ALARM_EVENTS_NODE: "off",
    OPCUA_EVENT_NODE: "off"
  });

  assert.deepEqual(
    config.variables.map(({ name, nodeId }) => [name, nodeId]),
    [
      ["deviceStatus", "ns=2;s=Line1.RunState"],
      ["currentOutput", "ns=2;s=Line1.Output"],
      ["goodCount", "ns=2;s=Line1.GoodCount"],
      ["totalProducedCount", "ns=2;s=Line1.TotalProduced"],
      ["temperatureSensor", "ns=2;s=Line1.Temperature"]
    ]
  );
  assert.equal(config.eventNodeId, null);
});

test("gateway config can omit the optional total production counter", () => {
  const config = loadGatewayConfig({ OPCUA_TOTAL_PRODUCED_NODE: "off" });

  assert.equal(
    config.variables.some((variable) => variable.name === "totalProducedCount"),
    false
  );
});

test("gateway config refuses to disable a required PLC point", () => {
  assert.throws(
    () => loadGatewayConfig({ OPCUA_DEVICE_STATUS_NODE: "off" }),
    /OPCUA_DEVICE_STATUS_NODE cannot be disabled/
  );
});

test("gateway config tunes bounded JSONL rotation independently", () => {
  const config = loadGatewayConfig({
    PROCESS_CONTEXT_LOG_MAX_BYTES: "2048",
    PROCESS_CONTEXT_LOG_MAX_FILES: "2",
    QUALITY_EVENT_LOG_MAX_BYTES: "4096",
    QUALITY_EVENT_LOG_MAX_FILES: "4"
  });

  assert.equal(config.context.logMaxBytes, 2048);
  assert.equal(config.context.logMaxFiles, 2);
  assert.equal(config.quality.logMaxBytes, 4096);
  assert.equal(config.quality.logMaxFiles, 4);
  assert.throws(
    () => loadGatewayConfig({ PROCESS_CONTEXT_LOG_MAX_BYTES: "512" }),
    /PROCESS_CONTEXT_LOG_MAX_BYTES/
  );
  assert.throws(
    () => loadGatewayConfig({ QUALITY_EVENT_LOG_MAX_FILES: "0" }),
    /QUALITY_EVENT_LOG_MAX_FILES/
  );
});

test("gateway config configures durable quality idempotency", () => {
  const defaults = loadGatewayConfig({});
  assert.match(defaults.quality.idempotencyPath, /quality-idempotency\.json$/);
  assert.equal(defaults.quality.idempotencyRetentionMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(defaults.quality.idempotencyMaxEntries, 100000);

  const config = loadGatewayConfig({
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
    QUALITY_EVENT_RETENTION_MS: "60000",
    QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS: "120000",
    QUALITY_EVENT_MAX_EVENTS: "10",
    QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES: "50"
  });
  assert.equal(config.quality.idempotencyPath, null);
  assert.equal(config.quality.idempotencyRetentionMs, 120000);
  assert.equal(config.quality.idempotencyMaxEntries, 50);
  assert.throws(
    () => loadGatewayConfig({ QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS: "59999" }),
    /QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS/
  );
});
