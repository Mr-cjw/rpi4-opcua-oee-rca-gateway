"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("gateway systemd unit uses the runtime entry point and hardened state", async () => {
  const unit = await fs.readFile(path.join(ROOT, "deploy", "rpi4-gateway.service"), "utf8");

  assert.match(unit, /^WorkingDirectory=\/opt\/rpi4-opcua-oee-rca-gateway\/current$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/rpi4-gateway\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node src\/gateway\/index\.js$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StateDirectory=rpi4-gateway$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(unit, /^ReadWritePaths=\/opt\/rpi4-opcua-oee-rca-gateway\/data$/m);
});

test("gateway environment template includes persistence and API safeguards", async () => {
  const env = await fs.readFile(
    path.join(ROOT, "deploy", "rpi4-gateway.env.example"),
    "utf8"
  );

  for (const name of [
    "OPCUA_ENDPOINT",
    "OPCUA_SECURITY_MODE",
    "OPCUA_SECURITY_POLICY",
    "OPCUA_CLIENT_PKI_ROOT",
    "OPCUA_TRUST_UNKNOWN_CERTIFICATES",
    "GATEWAY_ALLOW_INSECURE_OPCUA",
    "OPCUA_DEVICE_STATUS_NODE",
    "OPCUA_TOTAL_PRODUCED_NODE",
    "GATEWAY_LINE_ID",
    "GATEWAY_STATION_ID",
    "GATEWAY_PRODUCT_ID",
    "GATEWAY_WORK_CONTEXT_FILE",
    "GATEWAY_HTTP_HOST",
    "GATEWAY_API_TOKEN",
    "GATEWAY_STORAGE_DISK_PATH",
    "GATEWAY_STORAGE_WARN_FREE_BYTES",
    "GATEWAY_STORAGE_CRITICAL_FREE_BYTES",
    "GATEWAY_STORAGE_CHECK_INTERVAL_MS",
    "GATEWAY_CLOCK_SYNC_CHECK_INTERVAL_MS",
    "GATEWAY_CLOCK_SYNC_MAX_AGE_MS",
    "GATEWAY_CLOCK_SYNC_MAX_OFFSET_MS",
    "GATEWAY_CLOCK_SYNC_REQUIRED",
    "GATEWAY_DOCTOR_SAMPLE_MS",
    "GATEWAY_DOCTOR_TIMEOUT_MS",
    "GATEWAY_PLC_STALE_WARNING_MS",
    "GATEWAY_PLC_CLOCK_SKEW_WARNING_MS",
    "OPCUA_DATA_CHANGE_TRIGGER",
    "PROCESS_CONTEXT_LOG",
    "PROCESS_CONTEXT_LOG_FSYNC",
    "PROCESS_CONTEXT_LOG_MAX_BYTES",
    "PROCESS_CONTEXT_LOG_MAX_FILES",
    "QUALITY_EVENT_LOG",
    "QUALITY_EVENT_LOG_FSYNC",
    "QUALITY_EVENT_IDEMPOTENCY_FILE",
    "QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS",
    "QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES",
    "QUALITY_EVENT_LOG_MAX_BYTES",
    "QUALITY_EVENT_LOG_MAX_FILES",
    "OEE_NOMINAL_OUTPUT_PER_MIN",
    "OEE_IDEAL_CYCLE_TIME_MS",
    "OEE_PRODUCT_CYCLE_TIMES",
    "OEE_TIMEZONE",
    "OEE_SHIFT_WINDOWS",
    "OEE_PLANNED_DOWNTIME_ALARM_CODES",
    "OEE_CHANGEOVER_ALARM_CODES",
    "RCA_TEMPERATURE_THRESHOLD_C"
  ]) {
    assert.match(env, new RegExp(`^${name}=`, "m"));
  }
  assert.match(env, /^GATEWAY_HTTP_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^OPCUA_SECURITY_MODE=SignAndEncrypt$/m);
  assert.match(env, /^OPCUA_SECURITY_POLICY=Basic256Sha256$/m);
  assert.match(env, /^OPCUA_TRUST_UNKNOWN_CERTIFICATES=false$/m);
  assert.match(env, /^GATEWAY_API_TOKEN=replace-with-strong-token$/m);
  assert.match(env, /^PROCESS_CONTEXT_LOG=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^QUALITY_EVENT_LOG=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^QUALITY_EVENT_IDEMPOTENCY_FILE=\/var\/lib\/rpi4-gateway\//m);
  assert.match(env, /^GATEWAY_WORK_CONTEXT_FILE=\/var\/lib\/rpi4-gateway\//m);
});

test("package scripts expose state, release, and storage operations", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts["state:backup"], "node scripts/gateway-state.js backup");
  assert.equal(packageJson.scripts["state:verify"], "node scripts/gateway-state.js verify");
  assert.equal(packageJson.scripts["state:restore"], "node scripts/gateway-state.js restore");
  assert.equal(
    packageJson.scripts["release:package"],
    "node scripts/gateway-release.js package"
  );
  assert.equal(packageJson.scripts["release:verify"], "node scripts/gateway-release.js verify");
  assert.equal(packageJson.scripts["release:install"], "node scripts/gateway-release.js install");
  assert.equal(packageJson.scripts["release:rollback"], "node scripts/gateway-release.js rollback");
  assert.equal(packageJson.scripts["release:status"], "node scripts/gateway-release.js status");
  assert.equal(packageJson.scripts["storage:evaluate"], "node scripts/evaluate-storage.js");
  assert.equal(packageJson.scripts["e2e:security"], "node scripts/gateway-security-e2e.js");
  assert.equal(packageJson.scripts["e2e:clock"], "node scripts/gateway-clock-e2e.js");
});
