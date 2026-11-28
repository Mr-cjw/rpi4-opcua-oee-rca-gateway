"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseQuarantineArgs,
  runTestQuarantineCheck,
  validateQuarantineDocument
} = require("../src/reliability/test-quarantine");

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const ROOT = path.resolve(__dirname, "..");

function entry(overrides = {}) {
  return {
    test: "test/example.test.js :: example test",
    owner: "gateway-maintainers",
    reason: "Known timing-sensitive assertion under investigation.",
    issue: "https://github.com/Mr-cjw/rpi4-opcua-oee-rca-gateway/issues/1",
    quarantinedAt: "2026-11-20T00:00:00.000Z",
    removeBy: "2026-12-20T00:00:00.000Z",
    evidence: "data/evidence/flaky-example.json",
    ...overrides
  };
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quarantine-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("quarantine registry requires owner, tracking, evidence, and a future removal date", async (t) => {
  const validated = validateQuarantineDocument(
    { schemaVersion: "1.0", quarantined: [entry()] },
    { now: NOW }
  );
  assert.equal(validated.entries.length, 1);
  assert.equal(validated.entries[0].owner, "gateway-maintainers");

  assert.throws(
    () =>
      validateQuarantineDocument(
        { schemaVersion: "1.0", quarantined: [entry({ owner: "" })] },
        { now: NOW }
      ),
    /owner must be a non-empty string/
  );
  assert.throws(
    () =>
      validateQuarantineDocument(
        { schemaVersion: "1.0", quarantined: [entry({ removeBy: "2026-11-27T00:00:00.000Z" })] },
        { now: NOW }
      ),
    /quarantine expired/
  );
  assert.throws(
    () =>
      validateQuarantineDocument(
        { schemaVersion: "1.0", quarantined: [entry(), entry()] },
        { now: NOW }
      ),
    /duplicate quarantined test/
  );
  assert.throws(
    () =>
      validateQuarantineDocument(
        { schemaVersion: "1.0", quarantined: [entry({ quarantinedAt: "2026-12-01T00:00:00.000Z" })] },
        { now: NOW }
      ),
    /future quarantinedAt/
  );
});

test("quarantine review writes a private report and the repository registry is empty", async (t) => {
  const root = await makeRoot(t);
  const registryPath = path.join(root, "flaky-tests.json");
  const outputPath = path.join(root, "quarantine.json");
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({ schemaVersion: "1.0", quarantined: [entry()] }, null, 2)}\n`
  );
  const result = await runTestQuarantineCheck({
    rootDir: root,
    registryPath,
    outputPath,
    clock: () => NOW
  });
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.summary.count, 1);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);

  const repository = await runTestQuarantineCheck({ rootDir: ROOT, clock: () => NOW });
  assert.equal(repository.report.status, "passed");
  assert.equal(repository.report.summary.count, 0);
});

test("quarantine arguments and CLI use exit code 2 for usage errors", async () => {
  assert.throws(() => parseQuarantineArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseQuarantineArgs(["--registry"]), /requires a value/);
  const parsed = parseQuarantineArgs([
    "--root",
    "/tmp/repo",
    "--registry",
    "/tmp/registry.json",
    "--output",
    "/tmp/report.json",
    "--json"
  ]);
  assert.equal(parsed.rootDir, "/tmp/repo");
  assert.equal(parsed.registryPath, "/tmp/registry.json");
  assert.equal(parsed.outputPath, "/tmp/report.json");
  assert.equal(parsed.json, true);
  assert.equal(parseQuarantineArgs(["--help"]).help, true);

  const script = path.join(ROOT, "scripts", "check-test-quarantine.js");
  const invalid = spawnSync(process.execPath, [script, "--unknown"], {
    encoding: "utf8"
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown option: --unknown/);
});

test("push and weekly workflows run governance checks and accelerated soak", async () => {
  const ciWorkflow = await fs.readFile(
    path.join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  assert.match(ciWorkflow, /npm run check:supply-chain/);
  assert.match(ciWorkflow, /npm run check:quarantine/);
  assert.match(ciWorkflow, /dist\/supply-chain\/review\.json/);
  assert.match(ciWorkflow, /node-version:\s*22\.13\.0/);

  const workflow = await fs.readFile(
    path.join(ROOT, ".github", "workflows", "reliability.yml"),
    "utf8"
  );
  assert.match(workflow, /cron:\s*"17 3 \* \* 1"/);
  assert.match(workflow, /npm run check:supply-chain/);
  assert.match(workflow, /npm run check:quarantine/);
  assert.match(workflow, /npm run security:audit/);
  assert.match(workflow, /SOAK_DURATION_MS:\s*300000/);
  assert.match(workflow, /npm run soak/);
  assert.match(workflow, /timeout-minutes:\s*20/);
});
