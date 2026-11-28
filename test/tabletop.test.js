"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashFile } = require("../src/release/common");
const {
  parseTabletopArgs,
  runOfflineTabletop
} = require("../src/tabletop/exercise");

const NOW = new Date("2026-11-28T12:00:00.000Z");
const SCENARIO_IDS = [
  "plc-loss",
  "disk-full",
  "ntp-loss",
  "failed-upgrade-auto-rollback",
  "explicit-rollback",
  "state-restore",
  "state-format-boundary"
];

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-tabletop-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function mode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function scenarioById(report, id) {
  const scenario = report.scenarios.find((entry) => entry.id === id);
  assert.ok(scenario, `missing scenario ${id}`);
  return scenario;
}

test("offline tabletop records seven simulated recovery scenarios", async (t) => {
  const root = await makeRoot(t);
  const outputPath = path.join(root, "offline-tabletop-report.json");
  const evidenceDir = path.join(root, "offline-tabletop-evidence");
  const result = await runOfflineTabletop({
    outputPath,
    evidenceDir,
    force: true,
    clock: () => NOW.getTime()
  });
  const report = result.report;

  assert.equal(report.schemaVersion, "1.0");
  assert.equal(report.kind, "rpi4-gateway-offline-operational-tabletop");
  assert.equal(report.mode, "offline-simulation");
  assert.equal(report.evidenceLevel, "L1/L2 local simulation");
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.equal(report.status, "passed");
  assert.equal(report.satisfiesHardwareGate, false);
  assert.match(report.hardwareGateNote, /cannot satisfy L3\/L4/);
  assert.deepEqual(report.summary, { total: 7, passed: 7, failed: 0 });
  assert.deepEqual(report.scenarios.map((scenario) => scenario.id), SCENARIO_IDS);
  assert.equal(report.releaseRehearsal.status, "passed");
  assert.equal(result.outputSha256, await hashFile(outputPath));
  assert.equal(await mode(outputPath), 0o600);
  assert.equal(await mode(evidenceDir), 0o700);
  assert.deepEqual(await readJson(outputPath), report);

  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, "passed");
    assert.equal(scenario.satisfiesHardwareGate, false);
    assert.ok(scenario.commands.length > 0, `${scenario.id} has no commands`);
    assert.ok(scenario.expectedObservations.length > 0, `${scenario.id} has no expectations`);
    assert.ok(scenario.decisionPoints.length > 0, `${scenario.id} has no decisions`);
    assert.equal(typeof scenario.hardwareOnlyFrom, "string");
    assert.equal(scenario.hardwareHandoff.required, true);
    assert.equal(await mode(scenario.evidencePath), 0o600);
    assert.equal(scenario.evidenceSha256, await hashFile(scenario.evidencePath));
    const evidence = await readJson(scenario.evidencePath);
    const { evidencePath, evidenceSha256, ...recordedScenario } = scenario;
    assert.equal(evidence.mode, "offline-simulation");
    assert.equal(evidence.satisfiesHardwareGate, false);
    assert.deepEqual(evidence.scenario, recordedScenario);
  }

  const plc = scenarioById(report, "plc-loss").observed;
  assert.equal(plc.before.status, "ok");
  assert.equal(plc.outage.status, "degraded");
  assert.equal(plc.outage.opcuaConnected, false);
  assert.equal(plc.outage.plcStatus, "critical");
  assert.equal(plc.recovered.status, "ok");
  assert.equal(plc.contextAdvanced, true);

  const disk = scenarioById(report, "disk-full").observed;
  assert.equal(disk.baseline.status, 201);
  assert.equal(disk.baseline.sequence, 1);
  assert.equal(disk.rejected.status, 503);
  assert.equal(disk.rejected.health.status, "degraded");
  assert.equal(disk.rejected.health.qualityLogStatus, "critical");
  assert.equal(disk.retry.status, 201);
  assert.equal(disk.retry.sourceEventId, "QC-TABLETOP-DISK-001");
  assert.equal(disk.retry.sequence, 3);
  assert.equal(disk.retainedEvents, 2);
  assert.equal(disk.sequenceGap.gapsTotal, 1);
  assert.equal(disk.sequenceGap.missingEvents, 1);
  assert.deepEqual(disk.sequenceGap.gapRanges, [{ from: 2, to: 2 }]);
  assert.equal(disk.recoveredHealth.status, "ok");

  const ntp = scenarioById(report, "ntp-loss").observed;
  assert.equal(ntp.synchronized.status, "ok");
  assert.equal(ntp.lost.status, "warning");
  assert.equal(ntp.lost.reason, "not_synchronized");
  assert.equal(ntp.recovered.status, "ok");

  const automatic = scenarioById(report, "failed-upgrade-auto-rollback").observed;
  assert.equal(automatic.restoredReleaseId, automatic.baseReleaseId);
  assert.equal(automatic.finalCurrent, automatic.baseReleaseId);
  assert.notEqual(automatic.failedReleaseId, automatic.baseReleaseId);
  assert.match(automatic.error, /health|healthy/i);

  const explicit = scenarioById(report, "explicit-rollback").observed;
  assert.equal(explicit.finalCurrent, explicit.baseReleaseId);
  assert.equal(explicit.rolledBackReleaseId, explicit.baseReleaseId);
  assert.notEqual(explicit.candidateReleaseId, explicit.baseReleaseId);

  const restore = scenarioById(report, "state-restore").observed;
  assert.deepEqual(restore.missingFiles, []);
  assert.ok(Array.isArray(restore.restoredFiles));
  assert.ok(restore.restoredFiles.length > 0);
  assert.ok(restore.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));

  const boundary = scenarioById(report, "state-format-boundary").observed;
  assert.equal(boundary.runtimeStateFormatVersion, "1.0");
  assert.equal(boundary.rejectedBeforeReleaseSwitch, true);
  assert.equal(boundary.acceptedStateUnchanged, true);
  assert.equal(boundary.restoredStateMatchesAcceptedV1, true);

  await assert.rejects(
    runOfflineTabletop({ outputPath, evidenceDir, clock: () => NOW.getTime() }),
    /already exists/
  );
});

test("tabletop arguments and CLI use exit code 2 for usage errors", async (t) => {
  assert.throws(() => parseTabletopArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseTabletopArgs(["--output"]), /requires a value/);
  assert.throws(() => parseTabletopArgs(["--evidence-dir"]), /requires a value/);
  assert.equal(parseTabletopArgs(["--help"]).help, true);
  assert.equal(parseTabletopArgs(["-h"]).help, true);

  const root = await makeRoot(t);
  const options = parseTabletopArgs([
    "--output",
    path.join(root, "report.json"),
    "--evidence-dir",
    path.join(root, "evidence"),
    "--force",
    "--json"
  ]);
  assert.equal(options.force, true);
  assert.equal(options.json, true);
  assert.equal(options.outputPath, path.join(root, "report.json"));
  assert.equal(options.evidenceDir, path.join(root, "evidence"));

  const script = path.resolve(__dirname, "..", "scripts", "gateway-tabletop.js");
  const unknown = spawnSync(process.execPath, [script, "--unknown"], {
    encoding: "utf8"
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option: --unknown/);

  const missingValue = spawnSync(process.execPath, [script, "--output"], {
    encoding: "utf8"
  });
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--output requires a value/);

  const help = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8"
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npm run tabletop/);
});
