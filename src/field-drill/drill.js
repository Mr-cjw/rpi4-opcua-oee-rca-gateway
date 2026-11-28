"use strict";

const { randomUUID } = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runCommission } = require("../commission/report");
const { verifyStateBackup } = require("../gateway/state-backup");
const { runHardwareCheck } = require("../hardware/check");
const { hashFile, lstatIfExists, writeJsonAtomic } = require("../release/common");
const { installRelease, listReleases, rollbackRelease } = require("../release/installer");
const { verifyReleasePackage } = require("../release/package");
const {
  signaturePathFor,
  verifyReleaseArchiveSignature
} = require("../release/signature");

const STATE_FILE = "drill-state.json";
const MANIFEST_FILE = "drill-manifest.json";
const CHECKSUMS_FILE = "SHA256SUMS";
const PHASES = Object.freeze([
  "preflight",
  "install",
  "post-install",
  "post-reboot",
  "rotation-after",
  "rollback",
  "finalize"
]);
const REQUIRED_FINAL_PHASES = Object.freeze([
  "preflight",
  "install",
  "post-install",
  "post-reboot",
  "rotation-after",
  "rollback"
]);
const DEFAULT_ORIGIN_URL = "http://127.0.0.1:8080";
const DEFAULT_RELEASE_ROOT = "/opt/rpi4-opcua-oee-rca-gateway";
const DEFAULT_SERVICE = "rpi4-gateway";
const DEFAULT_STATE_PATH = "/var/lib/rpi4-gateway";

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseUrl(value, name, protocol) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (protocol && url.protocol !== protocol) {
    throw new Error(`${name} must use ${protocol.slice(0, -1)}`);
  }
  return url;
}

function healthUrlFor(originUrl) {
  const url = parseUrl(originUrl, "--origin-url");
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function normalizeConfig(options) {
  if (!options.archive) {
    throw new Error("preflight requires --archive <file.tar.gz>");
  }
  if (!options.url) {
    throw new Error("preflight requires --url <https-url>");
  }
  parseUrl(options.url, "--url", "https:");
  const originUrl = options.originUrl || DEFAULT_ORIGIN_URL;
  parseUrl(originUrl, "--origin-url");
  healthUrlFor(originUrl);
  const releaseRoot = path.resolve(options.releaseRoot || DEFAULT_RELEASE_ROOT);
  const service = options.service || DEFAULT_SERVICE;
  if (!/^[A-Za-z0-9_.@-]+$/.test(service)) {
    throw new Error("--service contains unsupported characters");
  }
  const archivePath = path.resolve(options.archive);
  return {
    archivePath,
    checksumPath: path.resolve(options.checksum || `${archivePath}.sha256`),
    signaturePath: path.resolve(
      options.signature || signaturePathFor(archivePath)
    ),
    publicKeyPath: options.publicKey ? path.resolve(options.publicKey) : null,
    requireSignature: options.requireSignature === true,
    stateBackupPath: options.stateBackup ? path.resolve(options.stateBackup) : null,
    releaseRoot,
    service,
    hardwareCheck: options.hardware !== false,
    storagePath: path.resolve(options.storagePath || DEFAULT_STATE_PATH),
    healthUrl: healthUrlFor(originUrl),
    healthTimeoutMs: positiveInteger(options.healthTimeoutMs || 30000, "--health-timeout-ms"),
    originUrl,
    url: options.url,
    httpUrl: options.httpUrl || null,
    skipHttpRedirect: options.skipHttpRedirect === true,
    tokenFile: options.tokenFile ? path.resolve(options.tokenFile) : null,
    caFile: options.caFile ? path.resolve(options.caFile) : null,
    clientCertFile: options.clientCertFile ? path.resolve(options.clientCertFile) : null,
    clientKeyFile: options.clientKeyFile ? path.resolve(options.clientKeyFile) : null,
    minCertDays: positiveInteger(options.minCertDays || 14, "--min-cert-days"),
    timeoutMs: positiveInteger(options.timeoutMs || 10000, "--timeout-ms"),
    maxUptimeSeconds: positiveInteger(
      options.maxUptimeSeconds || 600,
      "--max-uptime-seconds"
    )
  };
}

async function defaultReadBootId() {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const value = (await fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function ensureStateDir(stateDir) {
  const resolved = path.resolve(stateDir);
  const existing = await lstatIfExists(resolved);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`state directory is not a real directory: ${resolved}`);
    }
    const entries = await fsp.readdir(resolved);
    if (entries.length > 0 && !entries.includes(STATE_FILE)) {
      throw new Error(
        `state directory must be empty or contain ${STATE_FILE}: ${resolved}`
      );
    }
  } else {
    await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
  }
  await fsp.chmod(resolved, 0o700);
  return resolved;
}

function statePath(stateDir) {
  return path.join(stateDir, STATE_FILE);
}

async function loadState(stateDir) {
  const filePath = statePath(stateDir);
  const stats = await lstatIfExists(filePath);
  if (!stats) {
    throw new Error("drill state was not found; run --phase preflight first");
  }
  if (!stats.isFile()) {
    throw new Error("drill state is not a regular file");
  }
  let state;
  try {
    state = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`unable to load drill state: ${error.message}`);
  }
  if (
    !isPlainObject(state) ||
    state.schemaVersion !== "1.0" ||
    state.stateDir !== stateDir ||
    typeof state.drillId !== "string" ||
    !isPlainObject(state.config) ||
    !isPlainObject(state.baseline) ||
    !isPlainObject(state.phases) ||
    !Array.isArray(state.evidence) ||
    (state.operations !== undefined && !isPlainObject(state.operations))
  ) {
    throw new Error("drill state schema or state directory is invalid");
  }
  for (const name of [
    "archivePath",
    "checksumPath",
    "signaturePath",
    "releaseRoot",
    "service",
    "healthUrl",
    "originUrl",
    "url"
  ]) {
    if (typeof state.config[name] !== "string" || state.config[name] === "") {
      throw new Error(`drill state config is invalid: ${name}`);
    }
  }
  for (const name of [
    "archiveSha256",
    "releaseId",
    "version",
    "currentReleaseId",
    "rollbackTargetReleaseId"
  ]) {
    if (typeof state.baseline[name] !== "string" || state.baseline[name] === "") {
      throw new Error(`drill state baseline is invalid: ${name}`);
    }
  }
  for (const [phase, record] of Object.entries(state.phases)) {
    if (
      !PHASES.includes(phase) ||
      !isPlainObject(record) ||
      !["pass", "warn", "fail"].includes(record.status)
    ) {
      throw new Error(`drill state phase is invalid: ${phase}`);
    }
  }
  if (
    state.config.hardwareCheck !== undefined &&
    typeof state.config.hardwareCheck !== "boolean"
  ) {
    throw new Error("drill state config is invalid: hardwareCheck");
  }
  if (
    state.config.storagePath !== undefined &&
    (typeof state.config.storagePath !== "string" || state.config.storagePath === "")
  ) {
    throw new Error("drill state config is invalid: storagePath");
  }
  for (const entry of state.evidence) {
    if (
      !isPlainObject(entry) ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._-]+\.json$/.test(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error("drill state evidence entry is invalid");
    }
  }
  return state;
}

async function saveState(stateDir, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath(stateDir), state, { mode: 0o600 });
}

async function recordEvidence(stateDir, state, phase, fileName, payload) {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
    throw new Error(`invalid evidence file name: ${fileName}`);
  }
  const filePath = path.join(stateDir, fileName);
  await writeJsonAtomic(filePath, payload, { mode: 0o600 });
  const stats = await fsp.stat(filePath);
  state.evidence = state.evidence.filter((entry) => entry.path !== fileName);
  state.evidence.push({
    phase,
    path: fileName,
    size: stats.size,
    sha256: await hashFile(filePath),
    writtenAt: new Date().toISOString()
  });
  state.evidence.sort((left, right) => left.path.localeCompare(right.path));
  return filePath;
}

async function verifyEvidence(stateDir, state) {
  for (const entry of state.evidence) {
    const filePath = path.join(stateDir, entry.path);
    const stats = await fsp.lstat(filePath);
    if (!stats.isFile()) {
      throw new Error(`evidence entry is not a regular file: ${entry.path}`);
    }
    if (stats.size !== entry.size) {
      throw new Error(`evidence size changed: ${entry.path}`);
    }
    if ((await hashFile(filePath)) !== entry.sha256) {
      throw new Error(`evidence checksum changed: ${entry.path}`);
    }
  }
}

async function writeTextAtomic(filePath, text, mode) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, text, { encoding: "utf8", mode });
    await fsp.chmod(temporaryPath, mode);
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function phaseComplete(state, phase) {
  return ["pass", "warn"].includes(state.phases[phase]?.status);
}

function requirePhase(state, phase) {
  if (!phaseComplete(state, phase)) {
    throw new Error(`required phase is incomplete or failed: ${phase}`);
  }
}

function commissionOptions(config, maxUptimeSeconds) {
  return {
    url: config.url,
    httpUrl: config.httpUrl,
    originUrl: config.originUrl,
    tokenFile: config.tokenFile,
    caFile: config.caFile,
    clientCertFile: config.clientCertFile,
    clientKeyFile: config.clientKeyFile,
    minCertDays: config.minCertDays,
    timeoutMs: config.timeoutMs,
    skipHttpRedirect: config.skipHttpRedirect,
    releaseRoot: config.releaseRoot,
    service: config.service,
    maxUptimeSeconds,
    strict: true,
    edge: true,
    doctor: true
  };
}

function currentReleaseId(report) {
  return (
    report?.checks?.find((entry) => entry.name === "release_current")?.details
      ?.currentReleaseId || null
  );
}

function certificateFingerprint(report) {
  return (
    report?.edge?.checks?.find((entry) => entry.name === "certificate")?.details
      ?.fingerprint256 || null
  );
}

async function runCommissionEvidence(
  stateDir,
  state,
  phase,
  fileName,
  maxUptimeSeconds,
  dependencies
) {
  const run = dependencies.runCommission || runCommission;
  const report = await run(commissionOptions(state.config, maxUptimeSeconds));
  const evidencePath = await recordEvidence(stateDir, state, phase, fileName, report);
  if (report.exitCode !== 0 || report.overallStatus !== "pass") {
    throw new Error(
      `commission ${report.overallStatus || "failed"} with exit code ${report.exitCode}`
    );
  }
  return { report, evidencePath };
}

function hardwareSummary(report) {
  return {
    overallStatus: report.overallStatus,
    exitCode: report.exitCode,
    model: report.model?.text || null,
    pi4Class: report.model?.pi4Class ?? null,
    temperatureC: report.hardware?.temperature?.temperatureC ?? null,
    throttled: report.hardware?.throttling?.throttled ?? null,
    currentConditions: report.hardware?.throttling?.current || [],
    occurredConditions: report.hardware?.throttling?.occurred || [],
    storagePath: report.settings?.storagePath || null,
    counts: report.counts || null
  };
}

async function runHardwareReport(config, dependencies) {
  const run = dependencies.runHardwareCheck || runHardwareCheck;
  return run({
    storagePath: config.storagePath || DEFAULT_STATE_PATH,
    strict: true
  });
}

async function runHardwareEvidence(stateDir, state, phase, fileName, dependencies) {
  const report = await runHardwareReport(state.config, dependencies);
  const evidencePath = await recordEvidence(stateDir, state, phase, fileName, report);
  return { report, evidencePath };
}

async function preflight(options, stateDir, dependencies, now) {
  if (await lstatIfExists(statePath(stateDir))) {
    throw new Error(`drill state already exists: ${stateDir}`);
  }
  const config = normalizeConfig(options);
  const list = dependencies.listReleaseStatus || listReleases;
  const status = await list({ releaseRoot: config.releaseRoot });
  if (!status.current) {
    throw new Error("field drill requires an installed current release as the rollback target");
  }

  const verifyPackage = dependencies.verifyReleasePackage || verifyReleasePackage;
  const verified = await verifyPackage({
    archivePath: config.archivePath,
    checksumPath: config.checksumPath
  });
  let signature = null;
  try {
    if (config.requireSignature && !config.publicKeyPath) {
      throw new Error("--require-signature requires --public-key");
    }
    if (config.publicKeyPath) {
      const verifySignature =
        dependencies.verifyReleaseSignature || verifyReleaseArchiveSignature;
      signature = await verifySignature({
        archivePath: config.archivePath,
        signaturePath: config.signaturePath,
        publicKeyPath: config.publicKeyPath
      });
      if (!signature.valid) {
        throw new Error(`release signature verification failed: ${config.signaturePath}`);
      }
    }
  } finally {
    await verified.cleanup?.();
  }
  if (verified.manifest.releaseId === status.current) {
    throw new Error("release archive is already the current release");
  }
  if (status.releases?.some((entry) => entry.releaseId === verified.manifest.releaseId)) {
    throw new Error("release archive is already installed; remove it before repeating the drill");
  }

  let stateBackup = null;
  if (config.stateBackupPath) {
    const verifyBackup = dependencies.verifyStateBackup || verifyStateBackup;
    stateBackup = await verifyBackup({ backupDir: config.stateBackupPath });
  }
  const bootId = await (dependencies.readBootId || defaultReadBootId)();
  const warnings = [];
  if (!signature) {
    warnings.push("release signature was not verified");
  }
  if (!stateBackup) {
    warnings.push("no verified state backup was supplied");
  }
  if (!bootId) {
    warnings.push("host boot ID is unavailable; post-reboot verification will fail");
  }
  let hardware = null;
  if (config.hardwareCheck) {
    hardware = await runHardwareReport(config, dependencies);
    if (hardware.exitCode !== 0 || hardware.overallStatus !== "pass") {
      throw new Error(
        `hardware readiness check ${hardware.overallStatus || "failed"} with exit code ` +
          `${hardware.exitCode}`
      );
    }
  } else {
    warnings.push("hardware readiness check was skipped");
  }
  const id = `field-${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const state = {
    schemaVersion: "1.0",
    drillId: id,
    stateDir,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    config,
    baseline: {
      archiveSha256: verified.archiveSha256,
      releaseId: verified.manifest.releaseId,
      version: verified.manifest.version,
      currentReleaseId: status.current,
      previousReleaseId: status.previous,
      rollbackTargetReleaseId: status.current,
      installedReleaseId: null,
      bootIdBefore: bootId,
      bootIdAfter: null,
      certificateFingerprintBefore: null,
      certificateFingerprintAfter: null,
      hardwarePreflight: hardware ? hardwareSummary(hardware) : null,
      hardwarePostReboot: null,
      signature: signature
        ? {
            verified: true,
            algorithm: signature.algorithm,
            keyFingerprint: signature.keyFingerprint
          }
        : null,
      stateBackup: stateBackup
        ? {
            fileCount: stateBackup.manifest.fileCount,
            createdAt: stateBackup.manifest.createdAt
          }
        : null
    },
    operations: {},
    phases: {},
    evidence: []
  };
  const evidence = {
    status: warnings.length > 0 ? "warn" : "pass",
    warnings,
    archive: {
      path: config.archivePath,
      checksumPath: config.checksumPath,
      sha256: verified.archiveSha256,
      releaseId: verified.manifest.releaseId,
      version: verified.manifest.version,
      fileCount: verified.manifest.fileCount
    },
    signature: state.baseline.signature,
    stateBackup: state.baseline.stateBackup,
    currentReleaseId: status.current,
    previousReleaseId: status.previous,
    bootId,
    hardware
  };
  const evidencePath = await recordEvidence(
    stateDir,
    state,
    "preflight",
    "preflight.json",
    evidence
  );
  state.phases.preflight = {
    status: evidence.status,
    summary: "archive, signature, hardware, rollback target, and host state checked",
    completedAt: now().toISOString()
  };
  await saveState(stateDir, state);
  return {
    status: evidence.status,
    state,
    evidencePath,
    baseline: state.baseline
  };
}

async function installPhase(options, stateDir, state, dependencies) {
  if (!options.execute) {
    throw usageError("install is a mutating phase and requires --execute");
  }
  requirePhase(state, "preflight");
  if (phaseComplete(state, "install")) {
    throw new Error("install phase already completed");
  }
  const install = dependencies.installRelease || installRelease;
  const result = await install({
    archivePath: state.config.archivePath,
    checksumPath: state.config.checksumPath,
    signaturePath: state.config.signaturePath,
    publicKeyPath: state.config.publicKeyPath,
    requireSignature: state.config.requireSignature,
    releaseRoot: state.config.releaseRoot,
    stateBackup: state.config.stateBackupPath,
    service: state.config.service,
    healthUrl: state.config.healthUrl,
    healthTimeoutMs: state.config.healthTimeoutMs
  });
  if (result.releaseId !== state.baseline.releaseId) {
    throw new Error(
      `installed release ${result.releaseId} does not match preflight ${state.baseline.releaseId}`
    );
  }
  if (result.previousReleaseId !== state.baseline.currentReleaseId) {
    throw new Error(
      `installer previous release ${result.previousReleaseId || "none"} does not match ` +
        `preflight current ${state.baseline.currentReleaseId}`
    );
  }
  state.baseline.installedReleaseId = result.releaseId;
  state.baseline.previousReleaseId = result.previousReleaseId;
  const evidencePath = await recordEvidence(stateDir, state, "install", "install.json", {
    status: "pass",
    releaseId: result.releaseId,
    releaseDir: result.releaseDir,
    previousReleaseId: result.previousReleaseId,
    signature: result.signature || null,
    operation: result.report || null
  });
  return { status: "pass", state, evidencePath, baseline: state.baseline };
}

async function postInstallPhase(options, stateDir, state, dependencies) {
  requirePhase(state, "install");
  if (phaseComplete(state, "post-install")) {
    throw new Error("post-install phase already completed");
  }
  const { report, evidencePath } = await runCommissionEvidence(
    stateDir,
    state,
    "post-install",
    "commission-post-install.json",
    null,
    dependencies
  );
  const activeRelease = currentReleaseId(report);
  if (activeRelease !== state.baseline.installedReleaseId) {
    throw new Error(
      `commission active release ${activeRelease || "unknown"} does not match ` +
        `${state.baseline.installedReleaseId}`
    );
  }
  const fingerprint = certificateFingerprint(report);
  if (!fingerprint) {
    throw new Error("post-install commission report has no certificate fingerprint");
  }
  state.baseline.certificateFingerprintBefore = fingerprint;
  return {
    status: "pass",
    state,
    evidencePath,
    baseline: state.baseline,
    commissionStatus: report.overallStatus
  };
}

async function postRebootPhase(options, stateDir, state, dependencies) {
  requirePhase(state, "post-install");
  if (phaseComplete(state, "post-reboot")) {
    throw new Error("post-reboot phase already completed");
  }
  const bootId = await (dependencies.readBootId || defaultReadBootId)();
  if (!bootId) {
    throw new Error("host boot ID is unavailable; reboot cannot be verified");
  }
  if (bootId === state.baseline.bootIdBefore) {
    throw new Error("host boot ID is unchanged; reboot the Pi before post-reboot");
  }
  const { report, evidencePath } = await runCommissionEvidence(
    stateDir,
    state,
    "post-reboot",
    `commission-post-reboot.json`,
    state.config.maxUptimeSeconds,
    dependencies
  );
  const activeRelease = currentReleaseId(report);
  if (activeRelease !== state.baseline.installedReleaseId) {
    throw new Error(
      `post-reboot active release ${activeRelease || "unknown"} does not match ` +
        `${state.baseline.installedReleaseId}`
    );
  }
  const fingerprint = certificateFingerprint(report);
  if (fingerprint !== state.baseline.certificateFingerprintBefore) {
    throw new Error("certificate changed before rotation-after was run");
  }
  let hardware = null;
  let hardwareEvidencePath = null;
  if (state.config.hardwareCheck !== false) {
    const result = await runHardwareEvidence(
      stateDir,
      state,
      "post-reboot",
      "hardware-post-reboot.json",
      dependencies
    );
    hardware = result.report;
    hardwareEvidencePath = result.evidencePath;
    state.baseline.hardwarePostReboot = hardwareSummary(hardware);
    if (hardware.exitCode !== 0 || hardware.overallStatus !== "pass") {
      return {
        status: "fail",
        summary: `post-reboot hardware readiness ${hardware.overallStatus}`,
        state,
        evidencePath,
        hardwareEvidencePath,
        baseline: state.baseline,
        commissionStatus: report.overallStatus,
        hardwareStatus: hardware.overallStatus
      };
    }
  }
  state.baseline.bootIdAfter = bootId;
  return {
    status: "pass",
    state,
    evidencePath,
    hardwareEvidencePath,
    baseline: state.baseline,
    commissionStatus: report.overallStatus,
    hardwareStatus: hardware?.overallStatus || null
  };
}

async function rotationAfterPhase(options, stateDir, state, dependencies) {
  requirePhase(state, "post-reboot");
  if (phaseComplete(state, "rotation-after")) {
    throw new Error("rotation-after phase already completed");
  }
  const { report, evidencePath } = await runCommissionEvidence(
    stateDir,
    state,
    "rotation-after",
    "commission-rotation-after.json",
    null,
    dependencies
  );
  const activeRelease = currentReleaseId(report);
  if (activeRelease !== state.baseline.installedReleaseId) {
    throw new Error(
      `rotation active release ${activeRelease || "unknown"} does not match ` +
        `${state.baseline.installedReleaseId}`
    );
  }
  const fingerprint = certificateFingerprint(report);
  if (!fingerprint) {
    throw new Error("rotation commission report has no certificate fingerprint");
  }
  if (fingerprint === state.baseline.certificateFingerprintBefore) {
    throw new Error("edge certificate fingerprint did not change after rotation");
  }
  state.baseline.certificateFingerprintAfter = fingerprint;
  return {
    status: "pass",
    state,
    evidencePath,
    baseline: state.baseline,
    commissionStatus: report.overallStatus
  };
}

async function rollbackPhase(options, stateDir, state, dependencies) {
  if (!options.execute) {
    throw usageError("rollback is a mutating phase and requires --execute");
  }
  requirePhase(state, "rotation-after");
  if (phaseComplete(state, "rollback")) {
    throw new Error("rollback phase already completed");
  }
  let rollbackEvidencePath;
  const previousOperation = state.operations?.rollback;
  if (previousOperation?.status === "executed") {
    if (
      previousOperation.releaseId !== state.baseline.rollbackTargetReleaseId ||
      previousOperation.previousReleaseId !== state.baseline.installedReleaseId
    ) {
      throw new Error("recorded rollback operation does not match the drill baseline");
    }
    const evidence = state.evidence.find((entry) => entry.path === "rollback.json");
    if (!evidence) {
      throw new Error("recorded rollback operation has no evidence file");
    }
    rollbackEvidencePath = path.join(stateDir, evidence.path);
  } else {
    const rollback = dependencies.rollbackRelease || rollbackRelease;
    const result = await rollback({
      toReleaseId: state.baseline.rollbackTargetReleaseId,
      releaseRoot: state.config.releaseRoot,
      service: state.config.service,
      healthUrl: state.config.healthUrl,
      healthTimeoutMs: state.config.healthTimeoutMs
    });
    if (result.releaseId !== state.baseline.rollbackTargetReleaseId) {
      throw new Error(
        `rollback release ${result.releaseId} does not match target ` +
          `${state.baseline.rollbackTargetReleaseId}`
      );
    }
    rollbackEvidencePath = await recordEvidence(
      stateDir,
      state,
      "rollback",
      "rollback.json",
      {
        status: "pass",
        releaseId: result.releaseId,
        previousReleaseId: result.previousReleaseId,
        operation: result.report || null
      }
    );
    state.operations = {
      ...state.operations,
      rollback: {
        status: "executed",
        releaseId: result.releaseId,
        previousReleaseId: result.previousReleaseId
      }
    };
    await saveState(stateDir, state);
  }
  const { report, evidencePath: commissionEvidencePath } = await runCommissionEvidence(
    stateDir,
    state,
    "rollback",
    "commission-post-rollback.json",
    null,
    dependencies
  );
  const activeRelease = currentReleaseId(report);
  if (activeRelease !== state.baseline.rollbackTargetReleaseId) {
    throw new Error(
      `post-rollback active release ${activeRelease || "unknown"} does not match ` +
        `${state.baseline.rollbackTargetReleaseId}`
    );
  }
  state.operations.rollback = {
    ...state.operations.rollback,
    commissionStatus: report.overallStatus
  };
  return {
    status: "pass",
    state,
    evidencePath: rollbackEvidencePath,
    commissionEvidencePath,
    baseline: state.baseline
  };
}

async function finalizePhase(options, stateDir, state, dependencies, now) {
  for (const phase of REQUIRED_FINAL_PHASES) {
    requirePhase(state, phase);
  }
  const warnings = REQUIRED_FINAL_PHASES.filter(
    (phase) => state.phases[phase].status === "warn"
  );
  const status = warnings.length > 0 ? "warn" : "pass";
  const completedAt = now().toISOString();
  state.phases.finalize = {
    status,
    summary: "evidence bundle generated",
    completedAt
  };
  await verifyEvidence(stateDir, state);
  const manifest = {
    schemaVersion: "1.0",
    drillId: state.drillId,
    stateDir,
    createdAt: state.createdAt,
    completedAt,
    result: status,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      osRelease: os.release()
    },
    archive: {
      path: state.config.archivePath,
      checksumPath: state.config.checksumPath,
      sha256: state.baseline.archiveSha256,
      releaseId: state.baseline.releaseId,
      version: state.baseline.version
    },
    signature: state.baseline.signature,
    stateBackup: state.baseline.stateBackup,
    release: {
      currentBefore: state.baseline.currentReleaseId,
      installed: state.baseline.installedReleaseId,
      rollbackTarget: state.baseline.rollbackTargetReleaseId,
      finalCurrent: state.baseline.rollbackTargetReleaseId
    },
    boot: {
      before: state.baseline.bootIdBefore,
      after: state.baseline.bootIdAfter
    },
    certificate: {
      fingerprintBefore: state.baseline.certificateFingerprintBefore,
      fingerprintAfter: state.baseline.certificateFingerprintAfter
    },
    hardware: {
      preflight: state.baseline.hardwarePreflight || null,
      postReboot: state.baseline.hardwarePostReboot || null
    },
    operations: state.operations || {},
    phases: Object.fromEntries(
      [...REQUIRED_FINAL_PHASES, "finalize"].map((phase) => [phase, state.phases[phase]])
    ),
    evidence: state.evidence
  };
  const manifestPath = path.join(stateDir, MANIFEST_FILE);
  await writeJsonAtomic(manifestPath, manifest, { mode: 0o600 });
  const manifestStats = await fsp.stat(manifestPath);
  const manifestSha256 = await hashFile(manifestPath);
  const checksumLines = [...state.evidence]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`);
  checksumLines.push(`${manifestSha256}  ${MANIFEST_FILE}`);
  const checksumsPath = path.join(stateDir, CHECKSUMS_FILE);
  await writeTextAtomic(checksumsPath, `${checksumLines.join("\n")}\n`, 0o600);
  state.manifest = {
    path: MANIFEST_FILE,
    sha256: manifestSha256,
    size: manifestStats.size,
    checksumsPath: CHECKSUMS_FILE
  };
  return {
    status: manifest.result,
    state,
    manifestPath,
    checksumsPath,
    manifest
  };
}

const NEXT_PHASE = Object.freeze({
  preflight: "install --execute",
  install: "post-install",
  "post-install": "reboot the host, then post-reboot",
  "post-reboot": "rotate the edge certificate, then rotation-after",
  "rotation-after": "rollback --execute",
  rollback: "complete",
  finalize: "complete"
});

async function runFieldDrill(options, dependencies = {}) {
  if (!PHASES.includes(options.phase)) {
    throw usageError(`--phase must be one of ${PHASES.join(", ")}`);
  }
  if (typeof options.stateDir !== "string" || options.stateDir.trim() === "") {
    throw usageError("--state-dir is required");
  }
  const now = dependencies.now || (() => new Date());
  const stateDir = await ensureStateDir(options.stateDir);
  let outcome;
  if (options.phase === "preflight") {
    outcome = await preflight(options, stateDir, dependencies, now);
  } else {
    const state = await loadState(stateDir);
    await verifyEvidence(stateDir, state);
    if (options.phase === "install") {
      outcome = await installPhase(options, stateDir, state, dependencies);
    } else if (options.phase === "post-install") {
      outcome = await postInstallPhase(options, stateDir, state, dependencies);
    } else if (options.phase === "post-reboot") {
      outcome = await postRebootPhase(options, stateDir, state, dependencies);
    } else if (options.phase === "rotation-after") {
      outcome = await rotationAfterPhase(options, stateDir, state, dependencies);
    } else if (options.phase === "rollback") {
      outcome = await rollbackPhase(options, stateDir, state, dependencies);
    } else {
      outcome = await finalizePhase(options, stateDir, state, dependencies, now);
    }
  }

  const state = outcome.state;
  state.phases[options.phase] = {
    status: outcome.status,
    summary:
      outcome.summary ||
      (outcome.manifest
        ? `evidence bundle result ${outcome.manifest.result}`
        : `${options.phase} ${outcome.status}`),
    completedAt: now().toISOString()
  };
  await saveState(stateDir, state);

  if (options.phase === "rollback") {
    const finalized = await finalizePhase(options, stateDir, state, dependencies, now);
    await saveState(stateDir, state);
    outcome.status = finalized.status;
    outcome.finalizeStatus = finalized.status;
    outcome.manifestPath = finalized.manifestPath;
    outcome.checksumsPath = finalized.checksumsPath;
    outcome.manifest = finalized.manifest;
  }

  const resultManifestPath = outcome.manifestPath
    ? path.resolve(outcome.manifestPath)
    : state.manifest?.path
      ? path.resolve(stateDir, state.manifest.path)
      : null;
  const resultChecksumsPath = outcome.checksumsPath
    ? path.resolve(outcome.checksumsPath)
    : state.manifest?.checksumsPath
      ? path.resolve(stateDir, state.manifest.checksumsPath)
      : null;

  return {
    drillId: state.drillId,
    phase: options.phase,
    status: outcome.status,
    stateDir,
    evidencePath: outcome.evidencePath || null,
    commissionEvidencePath: outcome.commissionEvidencePath || null,
    hardwareEvidencePath: outcome.hardwareEvidencePath || null,
    hardwareStatus: outcome.hardwareStatus || null,
    manifestPath: resultManifestPath,
    checksumsPath: resultChecksumsPath,
    finalizeStatus:
      outcome.finalizeStatus || (options.phase === "finalize" ? outcome.status : null),
    nextPhase: outcome.status === "fail" ? null : NEXT_PHASE[options.phase],
    baseline: state.baseline,
    phases: state.phases
  };
}

function formatFieldDrillResult(result) {
  const lines = [
    `Field drill ${result.drillId}`,
    `Phase: ${result.phase}`,
    `Status: ${result.status.toUpperCase()}`,
    `State: ${result.stateDir}`
  ];
  if (result.evidencePath) {
    lines.push(`Evidence: ${result.evidencePath}`);
  }
  if (result.commissionEvidencePath) {
    lines.push(`Commission evidence: ${result.commissionEvidencePath}`);
  }
  if (result.hardwareEvidencePath) {
    lines.push(`Hardware evidence: ${result.hardwareEvidencePath}`);
  }
  if (result.manifestPath) {
    lines.push(`Manifest: ${result.manifestPath}`);
  }
  if (result.checksumsPath) {
    lines.push(`Checksums: ${result.checksumsPath}`);
  }
  if (result.nextPhase && result.nextPhase !== "complete") {
    lines.push(`Next: ${result.nextPhase}`);
  }
  return lines.join("\n");
}

function parseFieldDrillArgs(args) {
  const options = {
    phase: null,
    stateDir: null,
    archive: null,
    checksum: null,
    signature: null,
    publicKey: null,
    requireSignature: false,
    stateBackup: null,
    releaseRoot: DEFAULT_RELEASE_ROOT,
    service: DEFAULT_SERVICE,
    storagePath: null,
    hardware: true,
    healthTimeoutMs: 30000,
    url: null,
    httpUrl: null,
    originUrl: DEFAULT_ORIGIN_URL,
    skipHttpRedirect: false,
    tokenFile: null,
    caFile: null,
    clientCertFile: null,
    clientKeyFile: null,
    minCertDays: 14,
    timeoutMs: 10000,
    maxUptimeSeconds: 600,
    execute: false,
    json: false,
    help: false
  };
  const valueOptions = new Map([
    ["--phase", "phase"],
    ["--state-dir", "stateDir"],
    ["--archive", "archive"],
    ["--checksum", "checksum"],
    ["--signature", "signature"],
    ["--public-key", "publicKey"],
    ["--state-backup", "stateBackup"],
    ["--release-root", "releaseRoot"],
    ["--service", "service"],
    ["--storage-path", "storagePath"],
    ["--url", "url"],
    ["--http-url", "httpUrl"],
    ["--origin-url", "originUrl"],
    ["--token-file", "tokenFile"],
    ["--ca-file", "caFile"],
    ["--client-cert-file", "clientCertFile"],
    ["--client-key-file", "clientKeyFile"]
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[valueOptions.get(argument)] = value;
      index += 1;
      continue;
    }
    if (
      argument === "--health-timeout-ms" ||
      argument === "--min-cert-days" ||
      argument === "--timeout-ms" ||
      argument === "--max-uptime-seconds"
    ) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} requires a positive integer`);
      }
      options[
        argument
          .slice(2)
          .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      ] = value;
      index += 1;
      continue;
    }
    if (argument === "--require-signature") {
      options.requireSignature = true;
      continue;
    }
    if (argument === "--skip-http-redirect") {
      options.skipHttpRedirect = true;
      continue;
    }
    if (argument === "--skip-hardware") {
      options.hardware = false;
      continue;
    }
    if (argument === "--execute") {
      options.execute = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.help) {
    if (!options.phase) {
      throw new Error("--phase is required");
    }
    if (!options.stateDir) {
      throw new Error("--state-dir is required");
    }
  }
  return options;
}

module.exports = {
  DEFAULT_ORIGIN_URL,
  DEFAULT_RELEASE_ROOT,
  DEFAULT_SERVICE,
  PHASES,
  formatFieldDrillResult,
  parseFieldDrillArgs,
  runFieldDrill
};
