"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("gateway systemd unit uses the runtime entry point and hardened state", async () => {
  const unit = await fs.readFile(path.join(ROOT, "deploy", "rpi4-gateway.service"), "utf8");

  assert.match(unit, /^WorkingDirectory=\/opt\/rpi4-opcua-oee-rca-gateway$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/rpi4-gateway\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node src\/gateway\/index\.js$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StateDirectory=rpi4-gateway$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/opt\/rpi4-opcua-oee-rca-gateway\/data$/m);
});

test("gateway environment template includes persistence and API safeguards", async () => {
  const env = await fs.readFile(
    path.join(ROOT, "deploy", "rpi4-gateway.env.example"),
    "utf8"
  );

  for (const name of [
    "OPCUA_ENDPOINT",
    "OPCUA_DEVICE_STATUS_NODE",
    "OPCUA_TOTAL_PRODUCED_NODE",
    "GATEWAY_LINE_ID",
    "GATEWAY_STATION_ID",
    "GATEWAY_WORK_CONTEXT_FILE",
    "GATEWAY_HTTP_HOST",
    "GATEWAY_API_TOKEN",
    "PROCESS_CONTEXT_LOG",
    "PROCESS_CONTEXT_LOG_MAX_BYTES",
    "PROCESS_CONTEXT_LOG_MAX_FILES",
    "QUALITY_EVENT_LOG",
    "QUALITY_EVENT_IDEMPOTENCY_FILE",
    "QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS",
    "QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES",
    "QUALITY_EVENT_LOG_MAX_BYTES",
    "QUALITY_EVENT_LOG_MAX_FILES",
    "OEE_NOMINAL_OUTPUT_PER_MIN",
    "OEE_TIMEZONE",
    "OEE_SHIFT_WINDOWS",
    "OEE_PLANNED_DOWNTIME_ALARM_CODES",
    "OEE_CHANGEOVER_ALARM_CODES",
    "RCA_TEMPERATURE_THRESHOLD_C"
  ]) {
    assert.match(env, new RegExp(`^${name}=`, "m"));
  }
  assert.match(env, /^GATEWAY_HTTP_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^GATEWAY_API_TOKEN=replace-with-strong-token$/m);
  assert.match(env, /^PROCESS_CONTEXT_LOG=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^QUALITY_EVENT_LOG=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^QUALITY_EVENT_IDEMPOTENCY_FILE=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^GATEWAY_WORK_CONTEXT_FILE=\/var\/lib\/rpi4-gateway\//m);
});
