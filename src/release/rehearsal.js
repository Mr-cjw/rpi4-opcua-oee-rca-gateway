"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { hashFile, pathExists, runProcess, writeJsonAtomic } = require("./common");
const { verifyReleasePackage } = require("./package");
const {
  installRelease,
  listReleases,
  rollbackRelease,
  verifySignatureIfRequired
} = require("./installer");
const {
  createStateBackup,
  restoreStateBackup,
  statePathsFromConfig,
  verifyStateBackup
} = require("../gateway/state-backup");
const { STATE_FORMAT_VERSION } = require("../gateway/state-format");
const {
  STATE_MIGRATION_FILE,
  validateStateMigrationManifest
} = require("./state-migration");

const REHEARSAL_SCHEMA_VERSION = "1.0";
const REHEARSAL_KIND = "rpi4-gateway-offline-release-rehearsal";
const DEFAULT_SERVICE = "rpi4-gateway-rehearsal";
const DEFAULT_HEALTH_URL = "http://rehearsal.invalid/healthz";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

async function rotatedFileCount(filePath) {
  let count = 0;
  while (await pathExists(`${filePath}.${count + 1}`)) {
    count += 1;
  }
  return count;
}

async function inferStateConfig(stateDir) {
  const contextLog = path.join(stateDir, "process-context.jsonl");
  const qualityLog = path.join(stateDir, "quality-events.jsonl");
  const config = {
    context: {
      logPath: (await pathExists(contextLog)) ? contextLog : null,
      logMaxFiles: await rotatedFileCount(contextLog)
    },
    quality: {
      logPath: (await pathExists(qualityLog)) ? qualityLog : null,
      logMaxFiles: await rotatedFileCount(qualityLog),
      idempotencyPath: path.join(stateDir, "quality-idempotency.json")
    },
    workContext: {
      statePath: path.join(stateDir, "work-context.json")
    }
  };
  if (statePathsFromConfig(config).length === 0) {
    throw new Error(`offline rehearsal found no known Gateway state files in ${stateDir}`);
  }
  return config;
}

async function rehearseState({ stateDir, workDir, clock }) {
  const sourceStateDir = path.resolve(stateDir);
  const config = await inferStateConfig(sourceStateDir);
  const backupDir = path.join(workDir, "state-backup");
  const backup = await createStateBackup({
    stateDir: sourceStateDir,
    outputPath: backupDir,
    config,
    clock
  });
  const verified = await verifyStateBackup({ backupDir });
  const restoreDir = path.join(workDir, "restored-state");
  await fsp.cp(sourceStateDir, restoreDir, { recursive: true, force: true });
  const firstEntry = verified.manifest.files[0];
  await fsp.appendFile(path.join(restoreDir, firstEntry.path), "offline-rehearsal-mutation\n");
  const restored = await restoreStateBackup({
    backupDir,
    stateDir: restoreDir,
    force: true
  });
  for (const entry of verified.manifest.files) {
    const restoredPath = path.join(restoreDir, entry.path);
    if ((await hashFile(restoredPath)) !== entry.sha256) {
      throw new Error(`restored state checksum mismatch for ${entry.path}`);
    }
  }
  return {
    backupFileCount: backup.manifest.fileCount,
    backupTotalBytes: backup.manifest.totalBytes,
    missingFiles: backup.manifest.missingFiles,
    restoredFiles: restored.restoredFiles,
    files: verified.manifest.files.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      mode: entry.mode
    }))
  };
}

function createSimulatedRunner(commands) {
  return async (command, args, options) => {
    commands.push([command, ...args].join(" "));
    if (command === "tar") {
      return runProcess(command, args, options);
    }
    return { stdout: "", stderr: "" };
  };
}

function signatureOptions({
  archivePath,
  publicKeyPath,
  signaturePath,
  requireSignature,
  expectedKeyFingerprint,
  trustPolicyPath,
  expectedPolicySha256,
  minimumPolicySequence
}) {
  if (
    !publicKeyPath &&
    !signaturePath &&
    !requireSignature &&
    !expectedKeyFingerprint &&
    !trustPolicyPath &&
    !expectedPolicySha256 &&
    !minimumPolicySequence
  ) {
    return {
      publicKeyPath: undefined,
      signaturePath: undefined,
      requireSignature: false,
      expectedKeyFingerprint: undefined,
      trustPolicyPath: undefined,
      expectedPolicySha256: undefined,
      minimumPolicySequence: undefined
    };
  }
  return {
    publicKeyPath,
    signaturePath: signaturePath || `${path.resolve(archivePath)}.sig`,
    requireSignature: Boolean(requireSignature),
    expectedKeyFingerprint,
    trustPolicyPath,
    expectedPolicySha256,
    minimumPolicySequence
  };
}

function installerOptions({ archivePath, releaseRoot, commands, signature, clock }) {
  return {
    archivePath,
    releaseRoot,
    run: createSimulatedRunner(commands),
    skipNpmInstall: true,
    service: DEFAULT_SERVICE,
    healthUrl: DEFAULT_HEALTH_URL,
    healthTimeoutMs: 1,
    checkHealth: async () => true,
    sleep: async () => undefined,
    clock,
    ...signature
  };
}

async function preflightArchive({ archivePath, signature }) {
  const verified = await verifyReleasePackage({ archivePath });
  try {
    const signed = await verifySignatureIfRequired({ archivePath, ...signature });
    return {
      archivePath: path.resolve(archivePath),
      archiveSha256: verified.archiveSha256,
      releaseId: verified.manifest.releaseId,
      version: verified.manifest.version,
      commit: verified.manifest.git?.commit || null,
      releaseSchemaVersion: verified.manifest.schemaVersion,
      runtime: verified.manifest.runtime || null,
      stateFormatVersion: verified.manifest.stateFormatVersion || null,
      sbom: verified.sbom
        ? {
            format: verified.sbom.format,
            specVersion: verified.sbom.specVersion,
            componentCount: verified.sbom.componentCount
          }
        : null,
      signature: signed
        ? {
            verified: true,
            algorithm: signed.algorithm,
            keyFingerprint: signed.keyFingerprint,
            ...(signed.trustPolicy
              ? {
                  signerName: signed.signerName,
                  signerStatus: signed.signerStatus,
                  trustPolicy: signed.trustPolicy
                }
              : {})
          }
        : null
    };
  } finally {
    await verified.cleanup();
  }
}

async function snapshotState(stateDir) {
  const resolvedStateDir = path.resolve(stateDir);
  const config = await inferStateConfig(resolvedStateDir);
  const entries = [];
  for (const filePath of statePathsFromConfig(config)) {
    if (!(await pathExists(filePath))) {
      continue;
    }
    const stats = await fsp.lstat(filePath);
    if (!stats.isFile()) {
      throw new Error(`rehearsal state path is not a regular file: ${filePath}`);
    }
    entries.push({
      path: path.relative(resolvedStateDir, filePath).split(path.sep).join("/"),
      bytes: stats.size,
      sha256: await hashFile(filePath),
      mode: stats.mode & 0o777
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function assertStateSnapshotEqual(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} changed Gateway state`);
  }
}

function nextStateFormatVersion(version) {
  const major = Number(String(version).split(".")[0]);
  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`cannot synthesize a state-format fixture from version ${version}`);
  }
  return `${major + 1}.0`;
}

function renderChecksums(entries) {
  return `${entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
}

async function createIncompatibleStateFormatArchive({ candidateArchivePath, workDir }) {
  const extractDir = path.join(workDir, "state-format-v2-fixture-content");
  await fsp.rm(extractDir, { recursive: true, force: true });
  const verified = await verifyReleasePackage({
    archivePath: candidateArchivePath,
    extractDir
  });
  const manifestPath = path.join(extractDir, "release-manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (manifest.stateFormatVersion !== STATE_FORMAT_VERSION) {
    throw new Error(
      `cannot synthesize fixture from candidate state format ${manifest.stateFormatVersion || "missing"}`
    );
  }
  if (manifest.stateMigration) {
    throw new Error("candidate already declares a state migration manifest");
  }

  const fromVersion = verified.manifest.stateFormatVersion;
  const toVersion = nextStateFormatVersion(fromVersion);
  const suffix = `-state-${toVersion.replaceAll(".", "-")}-fixture`;
  const releaseId = `${manifest.releaseId.slice(0, 160 - suffix.length)}${suffix}`;
  const migrationId = `state-format-${fromVersion.replaceAll(".", "-")}-to-${toVersion.replaceAll(".", "-")}`;
  const migration = validateStateMigrationManifest(
    {
      schemaVersion: "1.0",
      kind: "rpi4-gateway-state-migration",
      migrationId,
      fromVersion,
      toVersion,
      releaseId,
      preflight: {
        ruleId: "exact-source-format-and-verified-backup",
        requiredStateFormatVersion: fromVersion,
        requireVerifiedBackup: true
      },
      backup: {
        required: true,
        verification: "sha256-manifest",
        offDeviceCopyRequired: true
      },
      postMigrationValidation: {
        ruleId: "state-format-file-integrity-and-backup-provenance",
        checks: [
          "state-format-version",
          "state-file-integrity",
          "pre-migration-backup-provenance"
        ]
      },
      rollback: {
        procedureId: "restore-verified-pre-migration-backup",
        codeOnly: false,
        stateRestoreRequired: true,
        verifiedBackupRequired: true
      }
    },
    { releaseId, fromVersion, toVersion }
  );
  const migrationPath = path.join(extractDir, STATE_MIGRATION_FILE);
  await writeJsonAtomic(migrationPath, migration, { mode: 0o644 });
  const migrationStats = await fsp.stat(migrationPath);
  manifest.releaseId = releaseId;
  manifest.stateFormatVersion = toVersion;
  manifest.stateMigration = {
    path: STATE_MIGRATION_FILE,
    migrationId,
    fromVersion,
    toVersion
  };
  manifest.rollback = {
    mode: "state-restore-required",
    codeOnly: false,
    stateRestoreRequired: true,
    verifiedBackupRequired: true,
    note: `Restore the verified ${fromVersion} pre-migration backup before starting the previous release.`
  };
  manifest.files.push({
    path: STATE_MIGRATION_FILE,
    bytes: migrationStats.size,
    sha256: await hashFile(migrationPath),
    mode: 0o644
  });
  manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  manifest.fileCount = manifest.files.length;
  manifest.totalBytes = manifest.files.reduce((total, entry) => total + entry.bytes, 0);
  await writeJsonAtomic(manifestPath, manifest, { mode: 0o644 });
  const checksums = renderChecksums([
    ...manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    { path: "release-manifest.json", sha256: await hashFile(manifestPath) }
  ]);
  await fsp.writeFile(path.join(extractDir, "SHA256SUMS"), checksums, {
    encoding: "utf8",
    mode: 0o644
  });

  const archivePath = path.join(workDir, `synthetic-state-format-${toVersion}.tar.gz`);
  await fsp.rm(archivePath, { force: true });
  await runProcess("tar", ["-czf", archivePath, "-C", extractDir, "."], {
    timeoutMs: 120000
  });
  const archiveSha256 = await hashFile(archivePath);
  await fsp.writeFile(
    `${archivePath}.sha256`,
    `${archiveSha256}  ${path.basename(archivePath)}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  return {
    archivePath,
    archiveSha256,
    releaseId,
    fromVersion,
    toVersion,
    migrationId
  };
}

async function rehearseStateFormatMigrationBoundary({
  baseArchivePath,
  candidateArchivePath,
  stateDir,
  workDir,
  baseSignature,
  clock
}) {
  const releaseRoot = path.join(workDir, "release-root-state-format-boundary");
  const commands = [];
  const base = await installRelease(
    installerOptions({ archivePath: baseArchivePath, releaseRoot, commands, signature: baseSignature, clock })
  );
  const before = await snapshotState(stateDir);
  const config = await inferStateConfig(stateDir);
  const backupDir = path.join(workDir, "state-format-migration-backup");
  const backup = await createStateBackup({
    stateDir,
    outputPath: backupDir,
    config,
    clock
  });
  const fixture = await createIncompatibleStateFormatArchive({
    candidateArchivePath,
    workDir
  });

  let rejection = null;
  try {
    await installRelease(
      installerOptions({
        archivePath: fixture.archivePath,
        releaseRoot,
        commands,
        clock
      })
    );
  } catch (error) {
    rejection = error;
  }
  if (!rejection) {
    throw new Error("incompatible state-format candidate was accepted");
  }
  if (
    !new RegExp(
      `unsupported release state format: ${fixture.toVersion.replaceAll(".", "\\.")} \\(runtime supports ${STATE_FORMAT_VERSION.replaceAll(".", "\\.")}\\); migration ${fixture.migrationId}`
    ).test(rejection.message)
  ) {
    throw new Error(`unexpected state-format rejection: ${rejection.message}`);
  }

  const status = await listReleases({ releaseRoot });
  if (status.current !== base.releaseId) {
    throw new Error(`state-format rejection changed current release to ${status.current || "none"}`);
  }
  const afterRejection = await snapshotState(stateDir);
  assertStateSnapshotEqual(before, afterRejection, "rejected state-format release");

  const restoreDir = path.join(workDir, "state-format-migration-restored-state");
  const restored = await restoreStateBackup({
    backupDir,
    stateDir: restoreDir
  });
  for (const entry of backup.manifest.files) {
    if ((await hashFile(path.join(restoreDir, entry.path))) !== entry.sha256) {
      throw new Error(`restored v1 state checksum mismatch for ${entry.path}`);
    }
  }
  const restoredSnapshot = await snapshotState(restoreDir);
  assertStateSnapshotEqual(before, restoredSnapshot, "v1 state restore");
  const afterRestore = await snapshotState(stateDir);
  assertStateSnapshotEqual(before, afterRestore, "v1 state restore against accepted state");

  return {
    baseReleaseId: base.releaseId,
    rejectedReleaseId: fixture.releaseId,
    runtimeStateFormatVersion: STATE_FORMAT_VERSION,
    candidateStateFormatVersion: fixture.toVersion,
    migrationId: fixture.migrationId,
    rejection: rejection.message,
    rejectedBeforeReleaseSwitch: status.current === base.releaseId,
    acceptedStateUnchanged: true,
    backupStateFormatVersion: backup.manifest.stateFormatVersion,
    backupFileCount: backup.manifest.fileCount,
    restoredFiles: restored.restoredFiles.length,
    restoredStateMatchesAcceptedV1: true
  };
}

function rehearseManifestCompatibility(base, candidate) {
  if (base.releaseSchemaVersion !== candidate.releaseSchemaVersion) {
    throw new Error("base and candidate release manifest schemas differ");
  }
  if (!base.sbom || !candidate.sbom) {
    throw new Error("base and candidate must both include an SBOM");
  }
  if (
    base.sbom.format !== candidate.sbom.format ||
    base.sbom.specVersion !== candidate.sbom.specVersion
  ) {
    throw new Error("base and candidate SBOM formats differ");
  }
  if (
    base.stateFormatVersion !== null &&
    candidate.stateFormatVersion !== null &&
    base.stateFormatVersion !== candidate.stateFormatVersion
  ) {
    throw new Error("base and candidate declare incompatible state formats");
  }
  return {
    releaseSchemaVersion: base.releaseSchemaVersion,
    runtime: { base: base.runtime, candidate: candidate.runtime },
    sbom: { base: base.sbom, candidate: candidate.sbom },
    stateFormatVersion: {
      base: base.stateFormatVersion,
      candidate: candidate.stateFormatVersion,
      declared: base.stateFormatVersion !== null || candidate.stateFormatVersion !== null
    }
  };
}

async function rehearseUpgradeAndRollback({
  baseArchivePath,
  candidateArchivePath,
  workDir,
  baseSignature,
  candidateSignature,
  clock
}) {
  const releaseRoot = path.join(workDir, "release-root-explicit");
  const commands = [];
  const common = { releaseRoot, commands, clock };
  const base = await installRelease(
    installerOptions({ ...common, archivePath: baseArchivePath, signature: baseSignature })
  );
  const candidate = await installRelease(
    installerOptions({
      ...common,
      archivePath: candidateArchivePath,
      signature: candidateSignature
    })
  );
  const upgraded = await listReleases({ releaseRoot });
  if (upgraded.current !== candidate.releaseId || upgraded.previous !== base.releaseId) {
    throw new Error("explicit upgrade did not install candidate over base");
  }
  const rolledBack = await rollbackRelease(
    installerOptions({
      ...common,
      archivePath: candidateArchivePath,
      signature: candidateSignature
    })
  );
  const finalStatus = await listReleases({ releaseRoot });
  if (finalStatus.current !== base.releaseId || finalStatus.previous !== candidate.releaseId) {
    throw new Error("explicit rollback did not restore base over candidate");
  }
  return {
    baseReleaseId: base.releaseId,
    candidateReleaseId: candidate.releaseId,
    rolledBackReleaseId: rolledBack.releaseId,
    finalCurrent: finalStatus.current,
    finalPrevious: finalStatus.previous,
    commandCount: commands.length
  };
}

async function rehearseAutomaticRollback({
  baseArchivePath,
  candidateArchivePath,
  workDir,
  baseSignature,
  candidateSignature,
  clock
}) {
  const releaseRoot = path.join(workDir, "release-root-auto-rollback");
  const commands = [];
  const common = { releaseRoot, commands, clock };
  const base = await installRelease(
    installerOptions({ ...common, archivePath: baseArchivePath, signature: baseSignature })
  );
  let failure = null;
  try {
    await installRelease({
      ...installerOptions({
        ...common,
        archivePath: candidateArchivePath,
        signature: candidateSignature
      }),
      checkHealth: async () => {
        try {
          const current = await fsp.readlink(path.join(releaseRoot, "current"));
          return path.basename(current) === base.releaseId;
        } catch {
          return false;
        }
      }
    });
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    throw new Error("failed-health candidate unexpectedly became healthy");
  }
  const status = await listReleases({ releaseRoot });
  if (status.current !== base.releaseId) {
    throw new Error(`automatic rollback left current at ${status.current || "none"}`);
  }
  const restored = failure.rollback?.restoredReleaseId || null;
  if (restored !== base.releaseId) {
    throw new Error("install failure did not report restoration of the base release");
  }
  return {
    baseReleaseId: base.releaseId,
    failedReleaseId: failure.releaseId,
    error: failure.message,
    restoredReleaseId: restored,
    finalCurrent: status.current,
    finalPrevious: status.previous,
    commandCount: commands.length
  };
}

async function runScenario(id, action) {
  try {
    return { id, status: "passed", details: await action() };
  } catch (error) {
    return { id, status: "failed", error: error.message };
  }
}

async function runReleaseRehearsal(options) {
  const outputPath = path.resolve(options.outputPath);
  if (!options.force && (await pathExists(outputPath))) {
    throw new Error(`rehearsal output already exists: ${outputPath}`);
  }
  const baseArchivePath = path.resolve(options.baseArchivePath);
  const candidateArchivePath = path.resolve(options.candidateArchivePath);
  const stateDir = path.resolve(options.stateDir);
  const clock = options.clock || Date.now;
  const ownedWorkDir = !options.workDir;
  const workDir = options.workDir
    ? path.resolve(options.workDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "rpi4-release-rehearsal-"));
  if (outputPath.startsWith(`${workDir}${path.sep}`)) {
    throw new Error("rehearsal output must be outside the work directory");
  }
  if (!ownedWorkDir) {
    await fsp.mkdir(workDir, { recursive: true });
  }
  try {
    const baseSignature = signatureOptions({
      archivePath: baseArchivePath,
      publicKeyPath: options.publicKeyPath,
      signaturePath: options.baseSignaturePath,
      requireSignature: options.requireSignature,
      expectedKeyFingerprint: options.signerFingerprint,
      trustPolicyPath: options.trustPolicyPath,
      expectedPolicySha256: options.expectedPolicySha256,
      minimumPolicySequence: options.minimumPolicySequence
    });
    const candidateSignature = signatureOptions({
      archivePath: candidateArchivePath,
      publicKeyPath: options.publicKeyPath,
      signaturePath: options.candidateSignaturePath,
      requireSignature: options.requireSignature,
      expectedKeyFingerprint: options.signerFingerprint,
      trustPolicyPath: options.trustPolicyPath,
      expectedPolicySha256: options.expectedPolicySha256,
      minimumPolicySequence: options.minimumPolicySequence
    });
    const basePreflight = await preflightArchive({
      archivePath: baseArchivePath,
      signature: baseSignature
    });
    const candidatePreflight = await preflightArchive({
      archivePath: candidateArchivePath,
      signature: candidateSignature
    });
    if (basePreflight.releaseId === candidatePreflight.releaseId) {
      throw new Error("base and candidate archives resolve to the same release ID");
    }

    const scenarios = [];
    scenarios.push(
      await runScenario("manifest-compatibility", async () =>
        rehearseManifestCompatibility(basePreflight, candidatePreflight)
      )
    );
    const stateRehearsal = await runScenario("state-backup-restore", () =>
      rehearseState({ stateDir, workDir, clock })
    );
    scenarios.push(stateRehearsal);
    scenarios.push(
      await runScenario("state-format-migration-boundary", () =>
        rehearseStateFormatMigrationBoundary({
          baseArchivePath,
          candidateArchivePath,
          stateDir,
          workDir,
          baseSignature,
          clock
        })
      )
    );
    scenarios.push(
      await runScenario("upgrade-and-explicit-rollback", () =>
        rehearseUpgradeAndRollback({
          baseArchivePath,
          candidateArchivePath,
          workDir,
          baseSignature,
          candidateSignature,
          clock
        })
      )
    );
    scenarios.push(
      await runScenario("failed-upgrade-auto-rollback", () =>
        rehearseAutomaticRollback({
          baseArchivePath,
          candidateArchivePath,
          workDir,
          baseSignature,
          candidateSignature,
          clock
        })
      )
    );
    const status = scenarios.every((scenario) => scenario.status === "passed")
      ? "passed"
      : "failed";
    const report = {
      schemaVersion: REHEARSAL_SCHEMA_VERSION,
      kind: REHEARSAL_KIND,
      mode: "offline-simulation",
      generatedAt: new Date(clock()).toISOString(),
      status,
      host: {
        node: process.version,
        platform: process.platform,
        arch: process.arch
      },
      inputs: {
        base: basePreflight,
        candidate: candidatePreflight,
        stateDir,
        signatureRequired: Boolean(options.requireSignature),
        trustPolicy: {
          base: basePreflight.signature?.trustPolicy || null,
          candidate: candidatePreflight.signature?.trustPolicy || null
        }
      },
      scenarios,
      limitations: [
        "No systemd unit, real service process, network health endpoint, or Raspberry Pi hardware was exercised.",
        "Archive installation uses the production release code with service commands and npm installation simulated.",
        "The synthetic state-format v2 archive is intentionally rejected before release switching; no data migration is executed.",
        "Power loss during a real state migration remains a hardware qualification gate."
      ]
    };
    await writeJsonAtomic(outputPath, report, { mode: 0o600 });
    return {
      outputPath,
      outputSha256: await hashFile(outputPath),
      report
    };
  } finally {
    if (ownedWorkDir) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

module.exports = {
  DEFAULT_HEALTH_URL,
  DEFAULT_SERVICE,
  REHEARSAL_KIND,
  REHEARSAL_SCHEMA_VERSION,
  inferStateConfig,
  rehearseManifestCompatibility,
  rehearseStateFormatMigrationBoundary,
  runReleaseRehearsal
};
