"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseCommissionArgs,
  runCommission,
  writeCommissionReport
} = require("../src/commission/report");

const NOW = new Date("2026-11-28T08:00:00.000Z");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function healthyReleaseStatus() {
  return {
    releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
    current: "1.0.0-aaaaaaaaaaaa",
    previous: "0.9.0-bbbbbbbbbbbb",
    releases: [
      {
        releaseId: "1.0.0-aaaaaaaaaaaa",
        current: true,
        previous: false,
        version: "1.0.0",
        createdAt: "2026-11-28T07:00:00.000Z",
        commit: "a".repeat(40),
        error: null
      },
      {
        releaseId: "0.9.0-bbbbbbbbbbbb",
        current: false,
        previous: true,
        version: "0.9.0",
        createdAt: "2026-11-27T07:00:00.000Z",
        commit: "b".repeat(40),
        error: null
      }
    ]
  };
}

function healthyServiceOutput() {
  return [
    "ActiveState=active",
    "SubState=running",
    "UnitFileState=enabled",
    "NRestarts=0",
    "ExecMainStartTimestamp=Sat 2026-11-28 15:55:00 CST",
    ""
  ].join("\n");
}

function healthyHealth(uptimeSeconds = 120) {
  return {
    status: "ok",
    opcuaConnected: true,
    startedAt: new Date(NOW.getTime() - uptimeSeconds * 1000).toISOString(),
    uptimeSeconds,
    clock: {
      status: "ok",
      healthy: true,
      synchronized: true,
      required: true,
      source: "chronyc"
    },
    plc: { status: "ok", healthy: true, connected: true },
    storage: { status: "ok", healthy: true, disk: { status: "ok" }, components: {} }
  };
}

function passingDependencies(health = healthyHealth()) {
  return {
    nodeVersion: "22.13.0",
    platform: "linux",
    hostname: () => "rpi4-acceptance",
    uptime: () => 7200,
    now: () => NOW,
    listReleaseStatus: async () => healthyReleaseStatus(),
    runCommand: async () => ({ stdout: healthyServiceOutput(), stderr: "" }),
    probeHealth: async (url, timeoutMs) => {
      assert.equal(url, "http://127.0.0.1:8080/healthz");
      assert.equal(timeoutMs, 2500);
      return { statusCode: 200, body: health, text: JSON.stringify(health) };
    },
    runDoctor: async () => ({
      overallStatus: "pass",
      endpointUrl: "opc.tcp://plc.example:4840/UA/Line",
      security: { mode: "SignAndEncrypt", policy: "Basic256Sha256" },
      summary: { pass: 9, warn: 0, fail: 0 },
      checks: []
    }),
    runEdge: async (options) => {
      assert.equal(options.url, "https://gateway.example.invalid");
      assert.match(options.originUrl, /^http:\/\/127\.0\.0\.1:/);
      assert.equal(options.timeoutMs, 2500);
      assert.equal(options.strict, false);
      return {
        target: "https://gateway.example.invalid/",
        overallStatus: "pass",
        exitCode: 0,
        counts: { pass: 15, warn: 0, fail: 0, skip: 1 },
        checks: []
      };
    }
  };
}

function acceptanceOptions(overrides = {}) {
  return {
    url: "https://gateway.example.invalid",
    originUrl: "http://127.0.0.1:8080",
    releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
    service: "rpi4-gateway",
    timeoutMs: 2500,
    maxUptimeSeconds: 300,
    strict: true,
    edge: true,
    doctor: true,
    ...overrides
  };
}

test("commission report aggregates a passing field acceptance", async (t) => {
  const report = await runCommission(
    acceptanceOptions(),
    passingDependencies(healthyHealth(120))
  );

  assert.equal(report.overallStatus, "pass");
  assert.equal(report.exitCode, 0);
  assert.equal(report.counts.warn, 0);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.health.status, "ok");
  assert.equal(report.doctor.overallStatus, "pass");
  assert.equal(report.edge.overallStatus, "pass");
  for (const name of [
    "node_runtime",
    "release_current",
    "release_rollback",
    "service_active",
    "service_enabled",
    "health_endpoint",
    "health_overall",
    "plc_link",
    "clock_sync",
    "storage_health",
    "uptime_window",
    "doctor",
    "edge_verification"
  ]) {
    assert.equal(report.checks.find((item) => item.name === name)?.status, "pass", name);
  }
  assert.equal(report.host.hostname, "rpi4-acceptance");
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.doesNotMatch(JSON.stringify(report), /Bearer|GATEWAY_API_TOKEN|client-key/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-commission-report-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "commission.json");
  report.outputPath = await writeCommissionReport(report, outputPath);
  const stats = await fs.stat(outputPath);
  assert.equal(stats.mode & 0o777, 0o600);
  const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(written.schemaVersion, "1.0");
  assert.equal(written.outputPath, outputPath);
  await assert.rejects(writeCommissionReport(report, outputPath), /EEXIST/);
});

test("commission probes the configured HTTP health endpoint by default", async (t) => {
  const body = healthyHealth(45);
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/healthz");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const port = await listen(server);
  t.after(() => close(server));

  const dependencies = passingDependencies();
  delete dependencies.probeHealth;
  const report = await runCommission(
    acceptanceOptions({ originUrl: `http://127.0.0.1:${port}` }),
    dependencies
  );

  assert.equal(report.overallStatus, "pass");
  assert.equal(report.health.uptimeSeconds, 45);
  assert.equal(report.checks.find((item) => item.name === "health_endpoint")?.status, "pass");
});

test("commission report fails unsafe or degraded acceptance evidence", async () => {
  const health = {
    status: "degraded",
    opcuaConnected: false,
    uptimeSeconds: 120,
    clock: {
      status: "warning",
      required: true,
      source: "timedatectl",
      reason: "not_synchronized"
    },
    plc: { status: "critical", healthy: false, connected: false },
    storage: { status: "critical", healthy: false, disk: { status: "critical" }, components: {} }
  };
  const dependencies = passingDependencies(health);
  dependencies.nodeVersion = "20.19.0";
  dependencies.listReleaseStatus = async () => ({
    releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
    current: null,
    previous: null,
    releases: []
  });
  dependencies.runCommand = async () => ({
    stdout: [
      "ActiveState=failed",
      "SubState=failed",
      "UnitFileState=disabled",
      "NRestarts=3",
      ""
    ].join("\n"),
    stderr: ""
  });
  dependencies.runDoctor = async () => ({
    overallStatus: "warn",
    endpointUrl: "opc.tcp://plc.example:4840/UA/Line",
    security: { mode: "SignAndEncrypt", policy: "Basic256Sha256" },
    summary: { pass: 8, warn: 1, fail: 0 },
    checks: []
  });
  dependencies.runEdge = async () => ({
    target: "https://gateway.example.invalid/",
    overallStatus: "fail",
    exitCode: 1,
    counts: { pass: 10, warn: 0, fail: 5, skip: 1 },
    checks: []
  });

  const report = await runCommission(
    acceptanceOptions({ maxUptimeSeconds: 30 }),
    dependencies
  );

  assert.equal(report.overallStatus, "fail");
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((item) => item.name === "node_runtime")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "release_current")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "release_rollback")?.status, "warn");
  assert.equal(report.checks.find((item) => item.name === "service_active")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "service_enabled")?.status, "warn");
  assert.equal(report.checks.find((item) => item.name === "health_overall")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "plc_link")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "clock_sync")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "storage_health")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "uptime_window")?.status, "fail");
  assert.equal(report.checks.find((item) => item.name === "doctor")?.status, "warn");
  assert.equal(report.checks.find((item) => item.name === "edge_verification")?.status, "fail");
});

test("commission strict mode treats skipped gates as warnings", async () => {
  const report = await runCommission(
    acceptanceOptions({ url: null, edge: false, doctor: false }),
    passingDependencies()
  );

  assert.equal(report.overallStatus, "warn");
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((item) => item.name === "doctor")?.status, "warn");
  assert.equal(report.checks.find((item) => item.name === "edge_verification")?.status, "warn");
});

test("commission arguments reject unsafe or incomplete configuration", () => {
  assert.throws(() => parseCommissionArgs([]), /--url is required/);
  assert.throws(
    () => parseCommissionArgs(["--url", "https://gateway.example", "--token", "secret"]),
    /unknown option/
  );
  assert.throws(
    () => parseCommissionArgs(["--url", "https://gateway.example", "--max-uptime-seconds", "0"]),
    /positive integer/
  );
  assert.throws(
    () => parseCommissionArgs(["--url", "https://gateway.example", "--service", "bad service"]),
    /unsupported characters/
  );
  const partial = parseCommissionArgs(["--skip-edge", "--skip-doctor", "--json"]);
  assert.equal(partial.edge, false);
  assert.equal(partial.doctor, false);
  assert.equal(partial.json, true);
});
