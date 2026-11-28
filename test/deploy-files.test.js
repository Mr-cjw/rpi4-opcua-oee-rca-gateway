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
  assert.match(unit, /^PrivateDevices=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
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

test("nginx template terminates TLS on an authenticated loopback boundary", async () => {
  const config = await fs.readFile(
    path.join(ROOT, "deploy", "nginx", "rpi4-gateway.conf"),
    "utf8"
  );

  assert.match(config, /^    listen 443 ssl http2;$/m);
  assert.match(config, /^    ssl_protocols TLSv1\.2 TLSv1\.3;$/m);
  assert.match(config, /^    ssl_ciphers ECDHE-[^;]+;$/m);
  assert.match(config, /^    ssl_prefer_server_ciphers off;$/m);
  assert.match(config, /^    ssl_session_tickets off;$/m);
  assert.match(config, /^    return 301 https:\/\/\$host\$request_uri;$/m);

  assert.match(config, /^    ssl_certificate \/etc\/rpi4-gateway\/tls\/fullchain\.pem;$/m);
  assert.match(config, /^    ssl_certificate_key \/etc\/rpi4-gateway\/tls\/privkey\.pem;$/m);
  assert.equal(
    (config.match(/^        proxy_pass http:\/\/127\.0\.0\.1:8080;$/gm) || []).length,
    3
  );
  assert.doesNotMatch(config, /^listen\s+8080/m);
  assert.doesNotMatch(config, /proxy_pass\s+https:/);
  assert.doesNotMatch(config, /proxy_pass\s+http:\/\/(?:0\.0\.0\.0|\[::\])/);

  assert.match(config, /^limit_req_zone \$binary_remote_addr .* rate=10r\/s;$/m);
  assert.match(config, /^limit_conn_zone \$binary_remote_addr .*;$/m);
  assert.match(config, /^    limit_conn rpi4_gateway_per_ip 20;$/m);
  assert.match(config, /limit_req zone=rpi4_gateway_api burst=20 nodelay;/);
  assert.match(config, /^    client_max_body_size 1m;$/m);
  assert.doesNotMatch(config, /^    client_max_body_size 0;/m);

  assert.match(config, /^    server_tokens off;$/m);
  assert.match(config, /^    access_log \/var\/log\/nginx\/rpi4-gateway-access\.log rpi4_gateway;$/m);
  assert.match(config, /^    add_header X-Content-Type-Options "nosniff" always;$/m);
  assert.match(config, /^    add_header X-Frame-Options "DENY" always;$/m);
  assert.match(config, /^    add_header Referrer-Policy "no-referrer" always;$/m);
  assert.match(config, /^    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" always;$/m);
  assert.doesNotMatch(config, /^    add_header Strict-Transport-Security/m);
  assert.match(config, /^    # add_header Strict-Transport-Security/m);

  const logFormat = config.match(/log_format rpi4_gateway[\s\S]*?;/)?.[0] || "";
  assert.notEqual(logFormat, "");
  assert.doesNotMatch(logFormat, /\$http_authorization|\$http_cookie|\$request_body/);
  assert.match(config, /^        proxy_set_header Authorization \$http_authorization;$/m);
  assert.match(config, /^        proxy_set_header Authorization "";$/m);
  assert.doesNotMatch(config, /^        add_header Authorization/m);

  assert.match(
    config,
    /location = \/healthz \{[\s\S]*?allow 127\.0\.0\.1;[\s\S]*?allow ::1;[\s\S]*?deny all;/
  );
  assert.match(config, /^    location = \/metrics \{/m);
  assert.match(config, /^    location \/v1\/ \{/m);
  assert.match(config, /^    location \/ \{\n        return 404;/m);
  assert.match(config, /^        proxy_set_header X-Forwarded-Proto \$scheme;$/m);
  assert.match(config, /^        proxy_set_header X-Real-IP \$remote_addr;$/m);
});

test("nginx access logs have bounded retention", async () => {
  const logrotate = await fs.readFile(
    path.join(ROOT, "deploy", "nginx", "rpi4-gateway.logrotate"),
    "utf8"
  );

  assert.match(logrotate, /^\/var\/log\/nginx\/rpi4-gateway-\*\.log \{$/m);
  assert.match(logrotate, /^    rotate 30$/m);
  assert.match(logrotate, /^    maxage 90$/m);
  assert.match(logrotate, /^        if \[ -f \/run\/nginx\.pid \]; then$/m);
  assert.match(logrotate, /kill -USR1/);
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
  assert.equal(packageJson.scripts["release:sign"], "node scripts/gateway-release.js sign");
  assert.equal(
    packageJson.scripts["release:verify-signature"],
    "node scripts/gateway-release.js verify-signature"
  );
  assert.equal(packageJson.scripts["release:sbom"], "node scripts/gateway-release.js sbom");
  assert.equal(packageJson.scripts["release:install"], "node scripts/gateway-release.js install");
  assert.equal(packageJson.scripts["release:rollback"], "node scripts/gateway-release.js rollback");
  assert.equal(packageJson.scripts["release:status"], "node scripts/gateway-release.js status");
  assert.equal(packageJson.scripts["storage:evaluate"], "node scripts/evaluate-storage.js");
  assert.equal(packageJson.scripts["commission"], "node scripts/gateway-commission.js");
  assert.equal(
    packageJson.scripts["hardware:check"],
    "node scripts/gateway-hardware-check.js"
  );
  assert.equal(packageJson.scripts["field:drill"], "node scripts/gateway-field-drill.js");
  assert.equal(
    packageJson.scripts["check:supply-chain"],
    "node scripts/check-supply-chain.js"
  );
  assert.equal(
    packageJson.scripts["check:quarantine"],
    "node scripts/check-test-quarantine.js"
  );
  assert.equal(
    packageJson.scripts["supply-chain:baseline"],
    "node scripts/check-supply-chain.js --write-baseline"
  );
  assert.equal(packageJson.scripts["edge:verify"], "node scripts/gateway-edge-verify.js");
  assert.equal(packageJson.scripts["e2e:security"], "node scripts/gateway-security-e2e.js");
  assert.equal(packageJson.scripts["e2e:clock"], "node scripts/gateway-clock-e2e.js");
  assert.equal(
    packageJson.scripts["security:audit"],
    "npm audit --omit=dev --audit-level=high"
  );
});
