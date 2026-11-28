"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createReleasePackage } = require("../src/release/package");
const { signReleaseArchive } = require("../src/release/signature");
const { runReleaseRehearsal } = require("../src/release/rehearsal");

const NOW = Date.parse("2026-11-28T06:00:00.000Z");
const COMMIT = "a".repeat(40);
const RELEASE_FILES = [
  "README.md",
  "deploy/rpi4-gateway.service",
  "package-lock.json",
  "package.json",
  "scripts/gateway-commission.js",
  "scripts/gateway-edge-verify.js",
  "scripts/gateway-field-drill.js",
  "scripts/gateway-hardware-check.js",
  "security/advisory-dispositions.json",
  "src/commission/report.js",
  "src/edge/verify.js",
  "src/field-drill/drill.js",
  "src/gateway/index.js",
  "src/hardware/check.js"
];

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-rehearsal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  for (const directory of [
    "deploy",
    "scripts",
    "security",
    "src/commission",
    "src/edge",
    "src/field-drill",
    "src/gateway",
    "src/hardware"
  ]) {
    await fs.mkdir(path.join(sourceDir, directory), { recursive: true });
  }
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rpi4-rehearsal-fixture",
        version: "1.0.0",
        engines: { node: ">=22.13.0" }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(sourceDir, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(sourceDir, "README.md"), "# Rehearsal fixture\n");
  await fs.writeFile(
    path.join(sourceDir, "deploy", "rpi4-gateway.service"),
    "[Service]\nExecStart=/usr/bin/node src/gateway/index.js\n"
  );
  for (const file of [
    "scripts/gateway-commission.js",
    "scripts/gateway-edge-verify.js",
    "scripts/gateway-field-drill.js",
    "scripts/gateway-hardware-check.js",
    "src/commission/report.js",
    "src/edge/verify.js",
    "src/field-drill/drill.js",
    "src/gateway/index.js",
    "src/hardware/check.js"
  ]) {
    await fs.writeFile(path.join(sourceDir, file), '"use strict";\n');
  }
  await fs.writeFile(
    path.join(sourceDir, "security", "advisory-dispositions.json"),
    '{"schemaVersion":"1.0","dispositions":[]}\n'
  );
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, "process-context.jsonl"), '{"kind":"context"}\n');
  await fs.writeFile(path.join(stateDir, "process-context.jsonl.1"), '{"kind":"context-old"}\n');
  await fs.writeFile(path.join(stateDir, "quality-events.jsonl"), '{"kind":"quality"}\n');
  await fs.writeFile(
    path.join(stateDir, "quality-idempotency.json"),
    '{"key":"value"}\n',
    { mode: 0o600 }
  );
  await fs.writeFile(path.join(stateDir, "work-context.json"), '{"workOrder":"WO-1"}\n');
  return { root, sourceDir, stateDir };
}

async function ensureSigningKeys(workspace) {
  const privateKeyPath = path.join(workspace.root, "release-private.pem");
  const publicKeyPath = path.join(workspace.root, "release-public.pem");
  const keysExist = await fs
    .access(privateKeyPath)
    .then(() => true)
    .catch(() => false);
  if (keysExist) {
    return { privateKeyPath, publicKeyPath };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  return { privateKeyPath, publicKeyPath };
}

async function buildSignedRelease(t, workspace, version) {
  const outputDir = path.join(workspace.root, `dist-${version}`);
  const release = await createReleasePackage({
    rootDir: workspace.sourceDir,
    outputDir,
    version,
    source: { files: RELEASE_FILES, commit: COMMIT, dirty: false },
    clock: () => NOW
  });
  const { privateKeyPath, publicKeyPath } = await ensureSigningKeys(workspace);
  await signReleaseArchive({ archivePath: release.archivePath, privateKeyPath });
  return { archivePath: release.archivePath, publicKeyPath };
}

test("offline release rehearsal covers upgrade, rollback, auto-rollback, and state restore", async (t) => {
  const workspace = await makeWorkspace(t);
  const base = await buildSignedRelease(t, workspace, "1.0.0");
  const candidate = await buildSignedRelease(t, workspace, "2.0.0");
  const outputPath = path.join(workspace.root, "rehearsal.json");
  const result = await runReleaseRehearsal({
    baseArchivePath: base.archivePath,
    candidateArchivePath: candidate.archivePath,
    stateDir: workspace.stateDir,
    outputPath,
    publicKeyPath: candidate.publicKeyPath,
    requireSignature: true,
    clock: () => NOW
  });

  assert.equal(result.report.status, "passed", JSON.stringify(result.report.scenarios, null, 2));
  assert.equal(result.report.mode, "offline-simulation");
  assert.equal(result.report.inputs.base.signature.verified, true);
  assert.equal(result.report.inputs.candidate.signature.verified, true);
  assert.deepEqual(
    result.report.scenarios.map((scenario) => [scenario.id, scenario.status]),
    [
      ["state-backup-restore", "passed"],
      ["upgrade-and-explicit-rollback", "passed"],
      ["failed-upgrade-auto-rollback", "passed"]
    ]
  );
  const stateScenario = result.report.scenarios[0];
  assert.equal(stateScenario.details.backupFileCount, 5);
  assert.equal(stateScenario.details.restoredFiles.length, 5);
  const explicit = result.report.scenarios[1].details;
  assert.equal(explicit.finalCurrent, explicit.baseReleaseId);
  assert.equal(explicit.finalPrevious, explicit.candidateReleaseId);
  const automatic = result.report.scenarios[2].details;
  assert.equal(automatic.finalCurrent, automatic.baseReleaseId);
  assert.equal(automatic.restoredReleaseId, automatic.baseReleaseId);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
  assert.match(result.outputSha256, /^[0-9a-f]{64}$/);
});

test("offline release rehearsal refuses to overwrite an existing report", async (t) => {
  const workspace = await makeWorkspace(t);
  const base = await buildSignedRelease(t, workspace, "1.0.0");
  const candidate = await buildSignedRelease(t, workspace, "2.0.0");
  const outputPath = path.join(workspace.root, "existing.json");
  await fs.writeFile(outputPath, "{}\n");
  await assert.rejects(
    runReleaseRehearsal({
      baseArchivePath: base.archivePath,
      candidateArchivePath: candidate.archivePath,
      stateDir: workspace.stateDir,
      outputPath
    }),
    /output already exists/
  );
});
