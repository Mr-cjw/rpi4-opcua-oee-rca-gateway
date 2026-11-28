"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashFile } = require("../src/release/common");
const {
  parseFieldDrillArgs,
  runFieldDrill
} = require("../src/field-drill/drill");

const NOW = new Date("2026-11-28T12:00:00.000Z");
const CURRENT_RELEASE = "1.0.0-aaaaaaaaaaaa";
const PREVIOUS_RELEASE = "0.9.0-cccccccccccc";
const NEW_RELEASE = "2.0.0-bbbbbbbbbbbb";
const BOOT_BEFORE = "11111111-1111-4111-8111-111111111111";
const BOOT_AFTER = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT_BEFORE = "AA:11:22:33";
const FINGERPRINT_AFTER = "BB:44:55:66";

function commissionReport(releaseId, fingerprint, overrides = {}) {
  const overallStatus = overrides.overallStatus || "pass";
  return {
    schemaVersion: "1.0",
    overallStatus,
    exitCode: overrides.exitCode ?? (overallStatus === "fail" ? 1 : 0),
    generatedAt: NOW.toISOString(),
    checks: [
      {
        name: "release_current",
        status: overallStatus === "fail" ? "fail" : "pass",
        summary: `current release is ${releaseId}`,
        details: { currentReleaseId: releaseId }
      }
    ],
    edge: {
      overallStatus,
      exitCode: overallStatus === "fail" ? 1 : 0,
      counts: { pass: 1, warn: 0, fail: overallStatus === "fail" ? 1 : 0, skip: 0 },
      checks: [
        {
          name: "certificate",
          status: overallStatus === "fail" ? "fail" : "pass",
          summary: "certificate test fixture",
          details: { fingerprint256: fingerprint }
        }
      ]
    }
  };
}

function hardwareReport(overrides = {}) {
  const overallStatus = overrides.overallStatus || "pass";
  return {
    schemaVersion: "1.0",
    generatedAt: NOW.toISOString(),
    overallStatus,
    exitCode: overrides.exitCode ?? (overallStatus === "pass" ? 0 : 1),
    counts: {
      pass: overallStatus === "pass" ? 8 : 7,
      warn: overallStatus === "warn" ? 1 : 0,
      fail: overallStatus === "fail" ? 1 : 0,
      skip: 0
    },
    model: {
      text: "Raspberry Pi 4 Model B Rev 1.5",
      raspberryPi: true,
      pi4Class: true
    },
    hardware: {
      temperature: { temperatureC: 52 },
      throttling: { throttled: "0x0", current: [], occurred: [] }
    },
    settings: { storagePath: "/var/lib/rpi4-gateway" }
  };
}

function makeDependencies(overrides = {}) {
  let bootId = BOOT_BEFORE;
  const calls = {
    cleanup: 0,
    commission: [],
    hardware: [],
    install: [],
    list: 0,
    rollback: [],
    verifyPackage: 0
  };
  const dependencies = {
    now: () => NOW,
    listReleaseStatus: async () => {
      calls.list += 1;
      return {
        releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
        current: CURRENT_RELEASE,
        previous: PREVIOUS_RELEASE,
        releases: [
          { releaseId: CURRENT_RELEASE },
          { releaseId: PREVIOUS_RELEASE }
        ]
      };
    },
    verifyReleasePackage: async (options) => {
      calls.verifyPackage += 1;
      assert.ok(options.archivePath.endsWith("release.tar.gz"));
      assert.ok(options.checksumPath.endsWith("release.tar.gz.sha256"));
      return {
        archiveSha256: "a".repeat(64),
        manifest: {
          releaseId: NEW_RELEASE,
          version: "2.0.0",
          fileCount: 5
        },
        cleanup: async () => {
          calls.cleanup += 1;
        }
      };
    },
    verifyReleaseSignature: async () => ({
      valid: true,
      algorithm: "sha256",
      keyFingerprint: "b".repeat(64)
    }),
    verifyStateBackup: async () => ({
      manifest: {
        fileCount: 3,
        createdAt: "2026-11-28T11:30:00.000Z"
      }
    }),
    readBootId: async () => bootId,
    installRelease: async (options) => {
      calls.install.push(options);
      return {
        releaseId: NEW_RELEASE,
        releaseDir: `/releases/${NEW_RELEASE}`,
        previousReleaseId: CURRENT_RELEASE,
        signature: {
          verified: true,
          algorithm: "sha256",
          keyFingerprint: "b".repeat(64)
        },
        report: { action: "install", releaseId: NEW_RELEASE }
      };
    },
    rollbackRelease: async (options) => {
      calls.rollback.push(options);
      return {
        releaseId: CURRENT_RELEASE,
        previousReleaseId: NEW_RELEASE,
        report: { action: "rollback", releaseId: CURRENT_RELEASE }
      };
    },
    runCommission: async (options) => {
      calls.commission.push(options);
      if (dependencies.commissionReports.length === 0) {
        throw new Error("unexpected commission call");
      }
      return dependencies.commissionReports.shift();
    },
    commissionReports: [],
    runHardwareCheck: async (options) => {
      calls.hardware.push(options);
      if (dependencies.hardwareReports.length === 0) {
        return hardwareReport();
      }
      return dependencies.hardwareReports.shift();
    },
    hardwareReports: [],
    calls,
    setBootId(value) {
      bootId = value;
    }
  };
  Object.assign(dependencies, overrides);
  return dependencies;
}

function preflightOptions(root, overrides = {}) {
  return {
    phase: "preflight",
    stateDir: path.join(root, "drill"),
    archive: path.join(root, "release.tar.gz"),
    checksum: path.join(root, "release.tar.gz.sha256"),
    signature: path.join(root, "release.tar.gz.sig"),
    publicKey: path.join(root, "release-public.pem"),
    requireSignature: true,
    stateBackup: path.join(root, "state-backup"),
    url: "https://gateway.example.invalid/",
    originUrl: "http://127.0.0.1:8080",
    releaseRoot: path.join(root, "release-root"),
    service: "rpi4-gateway",
    storagePath: path.join(root, "state"),
    maxUptimeSeconds: 600,
    execute: false,
    json: false,
    help: false,
    ...overrides
  };
}

function phaseOptions(root, phase, execute = false) {
  return {
    phase,
    stateDir: path.join(root, "drill"),
    execute,
    json: false,
    help: false
  };
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-field-drill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function mode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

async function readState(root) {
  return JSON.parse(
    await fs.readFile(path.join(root, "drill", "drill-state.json"), "utf8")
  );
}

async function startDrill(root, dependencies, overrides = {}) {
  return runFieldDrill(preflightOptions(root, overrides), dependencies);
}

test("field drill completes install, reboot, rotation, rollback, and evidence bundle", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  const stateDir = path.join(root, "drill");

  const preflight = await startDrill(root, dependencies);
  assert.equal(preflight.phase, "preflight");
  assert.equal(preflight.status, "pass");
  assert.equal(preflight.nextPhase, "install --execute");
  assert.equal(preflight.baseline.releaseId, NEW_RELEASE);
  assert.equal(preflight.baseline.currentReleaseId, CURRENT_RELEASE);
  assert.equal(preflight.baseline.bootIdBefore, BOOT_BEFORE);
  assert.equal(preflight.baseline.hardwarePreflight.overallStatus, "pass");
  assert.equal(dependencies.calls.hardware.length, 1);
  assert.deepEqual(dependencies.calls.hardware[0], {
    storagePath: path.join(root, "state"),
    strict: true
  });
  assert.equal(dependencies.calls.cleanup, 1);

  const install = await runFieldDrill(phaseOptions(root, "install", true), dependencies);
  assert.equal(install.status, "pass");
  assert.equal(dependencies.calls.install.length, 1);
  assert.equal(
    dependencies.calls.install[0].archivePath,
    path.join(root, "release.tar.gz")
  );
  assert.equal(
    dependencies.calls.install[0].stateBackup,
    path.join(root, "state-backup")
  );

  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  const postInstall = await runFieldDrill(
    phaseOptions(root, "post-install"),
    dependencies
  );
  assert.equal(postInstall.status, "pass");
  assert.equal(postInstall.nextPhase, "reboot the host, then post-reboot");

  dependencies.setBootId(BOOT_AFTER);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  const postReboot = await runFieldDrill(
    phaseOptions(root, "post-reboot"),
    dependencies
  );
  assert.equal(postReboot.status, "pass");
  assert.equal(postReboot.baseline.bootIdAfter, BOOT_AFTER);
  assert.equal(postReboot.baseline.hardwarePostReboot.overallStatus, "pass");
  assert.equal(dependencies.calls.hardware.length, 2);
  assert.equal(
    postReboot.hardwareEvidencePath,
    path.join(stateDir, "hardware-post-reboot.json")
  );
  assert.equal(
    postReboot.nextPhase,
    "rotate the edge certificate, then rotation-after"
  );

  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_AFTER)
  );
  const rotation = await runFieldDrill(
    phaseOptions(root, "rotation-after"),
    dependencies
  );
  assert.equal(rotation.status, "pass");
  assert.equal(rotation.baseline.certificateFingerprintAfter, FINGERPRINT_AFTER);
  assert.equal(rotation.nextPhase, "rollback --execute");

  dependencies.commissionReports.push(
    commissionReport(CURRENT_RELEASE, FINGERPRINT_AFTER)
  );
  const rollback = await runFieldDrill(phaseOptions(root, "rollback", true), dependencies);
  assert.equal(rollback.status, "pass");
  assert.equal(rollback.finalizeStatus, "pass");
  assert.equal(rollback.nextPhase, "complete");
  assert.equal(rollback.manifestPath, path.join(stateDir, "drill-manifest.json"));
  assert.equal(rollback.checksumsPath, path.join(stateDir, "SHA256SUMS"));
  assert.equal(dependencies.calls.rollback.length, 1);
  assert.equal(dependencies.calls.rollback[0].toReleaseId, CURRENT_RELEASE);
  assert.deepEqual(
    dependencies.calls.commission.map((options) => options.maxUptimeSeconds),
    [null, 600, null, null]
  );
  assert.ok(
    dependencies.calls.commission.every(
      (options) => options.strict && options.edge && options.doctor
    )
  );

  const state = await readState(root);
  assert.deepEqual(Object.keys(state.phases).sort(), [
    "finalize",
    "install",
    "post-install",
    "post-reboot",
    "preflight",
    "rollback",
    "rotation-after"
  ]);
  assert.ok(Object.values(state.phases).every((entry) => entry.status === "pass"));
  assert.equal(state.operations.rollback.status, "executed");
  assert.equal(state.operations.rollback.commissionStatus, "pass");
  assert.equal(state.baseline.installedReleaseId, NEW_RELEASE);
  assert.equal(state.baseline.bootIdAfter, BOOT_AFTER);
  assert.equal(state.baseline.certificateFingerprintAfter, FINGERPRINT_AFTER);
  assert.equal(await mode(stateDir), 0o700);
  assert.equal(await mode(path.join(stateDir, "drill-state.json")), 0o600);
  assert.equal(await mode(path.join(stateDir, "drill-manifest.json")), 0o600);
  assert.equal(await mode(path.join(stateDir, "SHA256SUMS")), 0o600);

  const expectedEvidence = [
    "commission-post-install.json",
    "commission-post-reboot.json",
    "commission-post-rollback.json",
    "commission-rotation-after.json",
    "hardware-post-reboot.json",
    "install.json",
    "preflight.json",
    "rollback.json"
  ];
  assert.deepEqual(
    state.evidence.map((entry) => entry.path),
    expectedEvidence
  );
  for (const entry of state.evidence) {
    assert.equal(await mode(path.join(stateDir, entry.path)), 0o600);
    assert.equal(await hashFile(path.join(stateDir, entry.path)), entry.sha256);
  }

  const manifest = JSON.parse(
    await fs.readFile(path.join(stateDir, "drill-manifest.json"), "utf8")
  );
  assert.equal(manifest.schemaVersion, "1.0");
  assert.equal(manifest.result, "pass");
  assert.equal(manifest.release.currentBefore, CURRENT_RELEASE);
  assert.equal(manifest.release.installed, NEW_RELEASE);
  assert.equal(manifest.release.finalCurrent, CURRENT_RELEASE);
  assert.equal(manifest.boot.before, BOOT_BEFORE);
  assert.equal(manifest.boot.after, BOOT_AFTER);
  assert.equal(manifest.certificate.fingerprintBefore, FINGERPRINT_BEFORE);
  assert.equal(manifest.certificate.fingerprintAfter, FINGERPRINT_AFTER);
  assert.equal(manifest.hardware.preflight.overallStatus, "pass");
  assert.equal(manifest.hardware.postReboot.overallStatus, "pass");
  assert.equal(manifest.signature.verified, true);
  assert.equal(manifest.stateBackup.fileCount, 3);
  assert.equal(manifest.operations.rollback.commissionStatus, "pass");
  assert.equal(manifest.phases.rollback.status, "pass");
  assert.equal(manifest.phases.finalize.status, "pass");
  const preflightEvidence = JSON.parse(
    await fs.readFile(path.join(stateDir, "preflight.json"), "utf8")
  );
  assert.equal(preflightEvidence.hardware.overallStatus, "pass");
  const postRebootHardware = JSON.parse(
    await fs.readFile(path.join(stateDir, "hardware-post-reboot.json"), "utf8")
  );
  assert.equal(postRebootHardware.overallStatus, "pass");

  const checksumLines = (await fs.readFile(path.join(stateDir, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, expectedEvidence.length + 1);
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(match, line);
    assert.equal(await hashFile(path.join(stateDir, match[2])), match[1]);
  }

  await fs.appendFile(path.join(stateDir, "preflight.json"), " ");
  await assert.rejects(
    runFieldDrill(phaseOptions(root, "finalize"), dependencies),
    /evidence (size|checksum) changed: preflight\.json/
  );
});

test("field drill fails preflight hardware evidence but permits an explicit skip", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  dependencies.hardwareReports.push(hardwareReport({ overallStatus: "warn" }));

  await assert.rejects(
    startDrill(root, dependencies),
    /hardware readiness check warn with exit code 1/
  );
  await assert.rejects(
    fs.stat(path.join(root, "drill", "drill-state.json")),
    { code: "ENOENT" }
  );

  const skippedRoot = await makeRoot(t);
  const skippedDependencies = makeDependencies();
  const skipped = await startDrill(skippedRoot, skippedDependencies, {
    hardware: false
  });
  assert.equal(skipped.status, "warn");
  assert.equal(skipped.baseline.hardwarePreflight, null);
  assert.deepEqual(skippedDependencies.calls.hardware, []);
});

test("field drill records a failed post-reboot hardware report and allows retry", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await startDrill(root, dependencies);
  await runFieldDrill(phaseOptions(root, "install", true), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-install"), dependencies);
  dependencies.setBootId(BOOT_AFTER);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  dependencies.hardwareReports.push(
    hardwareReport({ overallStatus: "fail", exitCode: 1 })
  );

  const failed = await runFieldDrill(phaseOptions(root, "post-reboot"), dependencies);
  assert.equal(failed.status, "fail");
  assert.equal(failed.nextPhase, null);
  assert.equal(failed.hardwareStatus, "fail");
  assert.equal(failed.baseline.bootIdAfter, null);
  assert.equal(
    failed.hardwareEvidencePath,
    path.join(root, "drill", "hardware-post-reboot.json")
  );
  let state = await readState(root);
  assert.equal(state.phases["post-reboot"].status, "fail");
  assert.equal(
    state.phases["post-reboot"].summary,
    "post-reboot hardware readiness fail"
  );
  assert.ok(
    state.evidence.some((entry) => entry.path === "hardware-post-reboot.json")
  );

  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  const retried = await runFieldDrill(phaseOptions(root, "post-reboot"), dependencies);
  assert.equal(retried.status, "pass");
  assert.equal(retried.hardwareStatus, "pass");
  assert.equal(retried.baseline.bootIdAfter, BOOT_AFTER);
  state = await readState(root);
  assert.equal(state.phases["post-reboot"].status, "pass");
  assert.equal(state.baseline.hardwarePostReboot.overallStatus, "pass");
});

test("field drill gates mutating phases and incomplete finalization", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await startDrill(root, dependencies);

  for (const phase of ["install", "rollback"]) {
    await assert.rejects(
      runFieldDrill(phaseOptions(root, phase), dependencies),
      (error) => {
        assert.equal(error.exitCode, 2);
        assert.match(error.message, /requires --execute/);
        return true;
      }
    );
  }
  assert.deepEqual(dependencies.calls.install, []);
  assert.deepEqual(dependencies.calls.rollback, []);

  await assert.rejects(
    runFieldDrill(phaseOptions(root, "finalize"), dependencies),
    /required phase is incomplete or failed: install/
  );
  const state = await readState(root);
  assert.equal(state.phases.install, undefined);
  assert.equal(state.phases.rollback, undefined);
  assert.equal(state.phases.finalize, undefined);
});

test("field drill requires a changed boot ID after post-install", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await startDrill(root, dependencies);
  await runFieldDrill(phaseOptions(root, "install", true), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-install"), dependencies);

  await assert.rejects(
    runFieldDrill(phaseOptions(root, "post-reboot"), dependencies),
    /boot ID is unchanged/
  );
  assert.equal(dependencies.calls.commission.length, 1);
  const state = await readState(root);
  assert.equal(state.phases["post-reboot"], undefined);
  assert.equal(
    state.evidence.some((entry) => entry.path === "commission-post-reboot.json"),
    false
  );
});

test("field drill requires the edge certificate fingerprint to change", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await startDrill(root, dependencies);
  await runFieldDrill(phaseOptions(root, "install", true), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-install"), dependencies);
  dependencies.setBootId(BOOT_AFTER);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-reboot"), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );

  await assert.rejects(
    runFieldDrill(phaseOptions(root, "rotation-after"), dependencies),
    /fingerprint did not change/
  );
  assert.equal(dependencies.calls.commission.length, 3);
  const state = await readState(root);
  assert.equal(state.phases["rotation-after"], undefined);
  assert.equal(
    state.evidence.some((entry) => entry.path === "commission-rotation-after.json"),
    false
  );
});

test("field drill refuses a release that is current or already installed", async (t) => {
  const root = await makeRoot(t);
  const currentDependencies = makeDependencies({
    listReleaseStatus: async () => ({
      releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
      current: NEW_RELEASE,
      previous: CURRENT_RELEASE,
      releases: [{ releaseId: NEW_RELEASE }, { releaseId: CURRENT_RELEASE }]
    })
  });
  await assert.rejects(
    startDrill(root, currentDependencies),
    /already the current release/
  );
  assert.equal(currentDependencies.calls.cleanup, 1);

  const installedDependencies = makeDependencies({
    listReleaseStatus: async () => ({
      releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
      current: CURRENT_RELEASE,
      previous: PREVIOUS_RELEASE,
      releases: [
        { releaseId: NEW_RELEASE },
        { releaseId: CURRENT_RELEASE },
        { releaseId: PREVIOUS_RELEASE }
      ]
    })
  });
  await assert.rejects(
    startDrill(root, installedDependencies),
    /already installed/
  );
  assert.equal(installedDependencies.calls.cleanup, 1);
  await assert.rejects(readState(root), /ENOENT/);
});

test("field drill requires an installed rollback target", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies({
    listReleaseStatus: async () => ({
      releaseRoot: "/opt/rpi4-opcua-oee-rca-gateway",
      current: null,
      previous: null,
      releases: []
    })
  });

  await assert.rejects(
    startDrill(root, dependencies),
    /requires an installed current release/
  );
  assert.equal(dependencies.calls.verifyPackage, 0);
});

test("field drill rejects missing, malformed, and non-file state", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await assert.rejects(
    runFieldDrill(phaseOptions(root, "install", true), dependencies),
    /run --phase preflight first/
  );

  await startDrill(root, dependencies);
  const statePath = path.join(root, "drill", "drill-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.schemaVersion = "2.0";
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(
    runFieldDrill(phaseOptions(root, "post-install"), dependencies),
    /schema or state directory is invalid/
  );

  await fs.rm(statePath);
  await fs.symlink(path.join(root, "missing-state.json"), statePath);
  await assert.rejects(
    runFieldDrill(phaseOptions(root, "post-install"), dependencies),
    /not a regular file/
  );

  const unrelatedDir = path.join(root, "unrelated");
  await fs.mkdir(unrelatedDir);
  await fs.chmod(unrelatedDir, 0o755);
  await fs.writeFile(path.join(unrelatedDir, "system.conf"), "do not touch\n");
  await assert.rejects(
    startDrill(root, dependencies, { stateDir: unrelatedDir }),
    /must be empty or contain drill-state\.json/
  );
  assert.equal(await mode(unrelatedDir), 0o755);
});

test("field drill retries post-rollback commissioning without repeating rollback", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies();
  await startDrill(root, dependencies);
  await runFieldDrill(phaseOptions(root, "install", true), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-install"), dependencies);
  dependencies.setBootId(BOOT_AFTER);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_BEFORE)
  );
  await runFieldDrill(phaseOptions(root, "post-reboot"), dependencies);
  dependencies.commissionReports.push(
    commissionReport(NEW_RELEASE, FINGERPRINT_AFTER)
  );
  await runFieldDrill(phaseOptions(root, "rotation-after"), dependencies);

  dependencies.commissionReports.push(
    commissionReport(CURRENT_RELEASE, FINGERPRINT_AFTER, {
      overallStatus: "fail",
      exitCode: 1
    })
  );
  await assert.rejects(
    runFieldDrill(phaseOptions(root, "rollback", true), dependencies),
    /commission fail with exit code 1/
  );
  assert.equal(dependencies.calls.rollback.length, 1);
  let state = await readState(root);
  assert.equal(state.phases.rollback, undefined);
  assert.equal(state.operations.rollback.status, "executed");
  assert.ok(state.evidence.some((entry) => entry.path === "rollback.json"));

  dependencies.commissionReports.push(
    commissionReport(CURRENT_RELEASE, FINGERPRINT_AFTER)
  );
  const retried = await runFieldDrill(
    phaseOptions(root, "rollback", true),
    dependencies
  );
  assert.equal(retried.status, "pass");
  assert.equal(retried.finalizeStatus, "pass");
  assert.equal(dependencies.calls.rollback.length, 1);
  state = await readState(root);
  assert.equal(state.operations.rollback.commissionStatus, "pass");
  assert.equal(state.phases.rollback.status, "pass");
  assert.equal(state.phases.finalize.status, "pass");
});

test("field drill arguments and CLI use exit code 2 for usage errors", async (t) => {
  assert.throws(() => parseFieldDrillArgs([]), /--phase is required/);
  assert.throws(
    () => parseFieldDrillArgs(["--phase", "preflight"]),
    /--state-dir is required/
  );
  assert.throws(
    () =>
      parseFieldDrillArgs([
        "--phase",
        "preflight",
        "--state-dir",
        "/tmp/drill",
        "--token",
        "secret"
      ]),
    /unknown option/
  );
  assert.throws(
    () =>
      parseFieldDrillArgs([
        "--phase",
        "preflight",
        "--state-dir",
        "/tmp/drill",
        "--health-timeout-ms",
        "0"
      ]),
    /positive integer/
  );
  const parsed = parseFieldDrillArgs([
    "--phase",
    "rollback",
    "--state-dir",
    "/tmp/drill",
    "--storage-path",
    "/var/lib/rpi4-gateway",
    "--skip-hardware",
    "--execute",
    "--json"
  ]);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.storagePath, "/var/lib/rpi4-gateway");
  assert.equal(parsed.hardware, false);
  assert.equal(parseFieldDrillArgs(["--help"]).help, true);

  const root = await makeRoot(t);
  await assert.rejects(
    runFieldDrill({ phase: "unknown", stateDir: path.join(root, "drill") }),
    (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /--phase must be one of/);
      return true;
    }
  );

  const script = path.resolve(__dirname, "..", "scripts", "gateway-field-drill.js");
  const missing = spawnSync(
    process.execPath,
    [script, "--phase", "preflight"],
    { encoding: "utf8" }
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--state-dir is required/);

  const unknown = spawnSync(
    process.execPath,
    [script, "--phase", "preflight", "--state-dir", root, "--token", "secret"],
    { encoding: "utf8" }
  );
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option: --token/);
});
