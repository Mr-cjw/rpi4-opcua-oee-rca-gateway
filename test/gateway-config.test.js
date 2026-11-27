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

test("gateway config validates planned-time shifts and time zone", () => {
  const defaults = loadGatewayConfig({});
  assert.equal(defaults.analytics.plannedTime.windows, "00:00-24:00");
  assert.equal(defaults.analytics.plannedTime.schedule[0].startMinute, 0);
  assert.equal(defaults.analytics.plannedTime.schedule[0].endMinute, 1440);
  assert.ok(defaults.analytics.plannedTime.timeZone);

  const configured = loadGatewayConfig({
    OEE_TIMEZONE: "Asia/Shanghai",
    OEE_SHIFT_WINDOWS: "MON-FRI:08:00-20:00;SAT:08:00-12:00"
  });
  assert.equal(configured.analytics.plannedTime.timeZone, "Asia/Shanghai");
  assert.equal(configured.analytics.plannedTime.schedule.length, 2);
  assert.deepEqual(configured.analytics.plannedTime.schedule[0].days, [1, 2, 3, 4, 5]);

  assert.throws(
    () => loadGatewayConfig({ OEE_TIMEZONE: "Not/A_Zone" }),
    /OEE_TIMEZONE/
  );
  assert.throws(
    () => loadGatewayConfig({ OEE_SHIFT_WINDOWS: "MON-FRI 08:00-20:00" }),
    /OEE_SHIFT_WINDOWS/
  );
});

test("gateway config parses and validates downtime alarm classification", () => {
  const defaults = loadGatewayConfig({});
  assert.deepEqual(defaults.analytics.downtimeClassification.plannedAlarmCodes, []);
  assert.deepEqual(defaults.analytics.downtimeClassification.changeoverAlarmCodes, []);

  const configured = loadGatewayConfig({
    OEE_PLANNED_DOWNTIME_ALARM_CODES: "planned_maint, maintenance",
    OEE_CHANGEOVER_ALARM_CODES: "changeover"
  });
  assert.deepEqual(configured.analytics.downtimeClassification.plannedAlarmCodes, [
    "PLANNED_MAINT",
    "MAINTENANCE"
  ]);
  assert.deepEqual(configured.analytics.downtimeClassification.changeoverAlarmCodes, [
    "CHANGEOVER"
  ]);

  assert.throws(
    () =>
      loadGatewayConfig({
        OEE_PLANNED_DOWNTIME_ALARM_CODES: "CHANGEOVER",
        OEE_CHANGEOVER_ALARM_CODES: "CHANGEOVER"
      }),
    /overlap/
  );
});

test("gateway config parses an optional ideal cycle time", () => {
  const defaults = loadGatewayConfig({});
  assert.equal(defaults.analytics.idealCycleTimeMs, null);

  const configured = loadGatewayConfig({ OEE_IDEAL_CYCLE_TIME_MS: "750" });
  assert.equal(configured.analytics.idealCycleTimeMs, 750);

  assert.throws(
    () => loadGatewayConfig({ OEE_IDEAL_CYCLE_TIME_MS: "0" }),
    /OEE_IDEAL_CYCLE_TIME_MS/
  );
});

test("gateway config parses per-product cycle times", () => {
  const defaults = loadGatewayConfig({});
  assert.deepEqual(defaults.analytics.productCycleTimes, {});

  const configured = loadGatewayConfig({
    OEE_PRODUCT_CYCLE_TIMES: "SKU-A=500,SKU-B=750"
  });
  assert.deepEqual(configured.analytics.productCycleTimes, {
    "SKU-A": 500,
    "SKU-B": 750
  });

  assert.throws(
    () => loadGatewayConfig({ OEE_PRODUCT_CYCLE_TIMES: "SKU-A" }),
    /OEE_PRODUCT_CYCLE_TIMES/
  );
  assert.throws(
    () => loadGatewayConfig({ OEE_PRODUCT_CYCLE_TIMES: "SKU-A=0" }),
    /OEE_PRODUCT_CYCLE_TIMES/
  );
  assert.throws(
    () => loadGatewayConfig({ OEE_PRODUCT_CYCLE_TIMES: "SKU-A=500,SKU-A=750" }),
    /duplicate/
  );
});

test("gateway config validates doctor sampling and timeout settings", () => {
  const config = loadGatewayConfig({
    GATEWAY_DOCTOR_SAMPLE_MS: "5000",
    GATEWAY_DOCTOR_TIMEOUT_MS: "20000",
    GATEWAY_DOCTOR_CLOCK_SKEW_WARNING_MS: "45000",
    GATEWAY_DOCTOR_STALE_WARNING_MS: "600000"
  });

  assert.deepEqual(config.doctor, {
    sampleMs: 5000,
    connectTimeoutMs: 20000,
    clockSkewWarningMs: 45000,
    staleValueWarningMs: 600000
  });
  assert.throws(
    () => loadGatewayConfig({ GATEWAY_DOCTOR_SAMPLE_MS: "-1" }),
    /GATEWAY_DOCTOR_SAMPLE_MS/
  );
  assert.throws(
    () => loadGatewayConfig({ GATEWAY_DOCTOR_TIMEOUT_MS: "0" }),
    /GATEWAY_DOCTOR_TIMEOUT_MS/
  );
});

test("gateway config validates storage pressure thresholds", () => {
  const config = loadGatewayConfig({
    GATEWAY_STORAGE_DISK_PATH: "/var/lib/rpi4-gateway",
    GATEWAY_STORAGE_WARN_FREE_BYTES: "104857600",
    GATEWAY_STORAGE_CRITICAL_FREE_BYTES: "33554432",
    GATEWAY_STORAGE_CHECK_INTERVAL_MS: "30000"
  });

  assert.equal(config.storage.diskPath, "/var/lib/rpi4-gateway");
  assert.equal(config.storage.warnFreeBytes, 104857600);
  assert.equal(config.storage.criticalFreeBytes, 33554432);
  assert.equal(config.storage.checkIntervalMs, 30000);
  assert.throws(
    () =>
      loadGatewayConfig({
        GATEWAY_STORAGE_WARN_FREE_BYTES: "1024",
        GATEWAY_STORAGE_CRITICAL_FREE_BYTES: "2048"
      }),
    /GATEWAY_STORAGE_CRITICAL_FREE_BYTES/
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
