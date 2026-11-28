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

function signatureOptions({ archivePath, publicKeyPath, signaturePath, requireSignature }) {
  if (!publicKeyPath && !signaturePath && !requireSignature) {
    return { publicKeyPath: undefined, signaturePath: undefined, requireSignature: false };
  }
  return {
    publicKeyPath,
    signaturePath: signaturePath || `${path.resolve(archivePath)}.sig`,
    requireSignature: Boolean(requireSignature)
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
            keyFingerprint: signed.keyFingerprint
          }
        : null
    };
  } finally {
    await verified.cleanup();
  }
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
      requireSignature: options.requireSignature
    });
    const candidateSignature = signatureOptions({
      archivePath: candidateArchivePath,
      publicKeyPath: options.publicKeyPath,
      signaturePath: options.candidateSignaturePath,
      requireSignature: options.requireSignature
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
        signatureRequired: Boolean(options.requireSignature)
      },
      scenarios,
      limitations: [
        "No systemd unit, real service process, network health endpoint, or Raspberry Pi hardware was exercised.",
        "Archive installation uses the production release code with service commands and npm installation simulated."
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
  runReleaseRehearsal
};
