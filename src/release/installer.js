"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  lstatIfExists,
  pathExists,
  readLinkTarget,
  runProcess,
  switchSymlink,
  writeJsonAtomic
} = require("./common");
const {
  validateManifest,
  validateReleaseId,
  verifyReleasePackage
} = require("./package");
const {
  signaturePathFor,
  verifyReleaseArchiveSignature
} = require("./signature");

const RELEASE_OPERATION_FILE = "last-release.json";

function isWithin(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function readReleaseLink(linkPath, releasesDir) {
  const target = await readLinkTarget(linkPath);
  if (!target) {
    return null;
  }
  if (!isWithin(releasesDir, target)) {
    throw new Error(`release link points outside the releases directory: ${linkPath}`);
  }
  const stats = await fsp.stat(target).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`release link target is missing: ${linkPath} -> ${target}`);
    }
    throw error;
  });
  if (!stats.isDirectory()) {
    throw new Error(`release link target is not a directory: ${target}`);
  }
  return { id: path.basename(target), target };
}

function versionParts(version) {
  const match = String(version || "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [match[1], match[2] || "0", match[3] || "0"].map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function checkRuntime(manifest) {
  const current = versionParts(process.versions.node);
  const minimumVersion = manifest.runtime?.minimumNodeVersion;
  if (minimumVersion !== undefined && minimumVersion !== null) {
    const minimum = versionParts(minimumVersion);
    if (!minimum) {
      throw new Error(`release manifest has an invalid Node.js minimum: ${minimumVersion}`);
    }
    if (compareVersions(current, minimum) < 0) {
      throw new Error(
        `release requires Node.js ${minimumVersion} or newer; current runtime is ${process.versions.node}`
      );
    }
    return;
  }
  const minimumMajor = manifest.runtime?.minimumNodeMajor;
  if (Number.isInteger(minimumMajor) && current[0] < minimumMajor) {
    throw new Error(
      `release requires Node.js ${minimumMajor} or newer; current runtime is ${process.versions.node}`
    );
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultCheckHealth(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.ok;
}

async function waitForHealthy(options) {
  if (options.healthUrl === null || options.healthUrl === undefined) {
    return false;
  }
  const timeoutMs = options.healthTimeoutMs || 30000;
  const checkHealth = options.checkHealth || defaultCheckHealth;
  const pause = options.sleep || sleep;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      if (await checkHealth(options.healthUrl)) {
        return true;
      }
      lastError = new Error("health endpoint returned a failure response");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await pause(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `health check did not recover within ${timeoutMs}ms: ${
      lastError?.message || "no response"
    }`
  );
}

async function writeOperationReport(releaseRoot, report) {
  await writeJsonAtomic(path.join(releaseRoot, RELEASE_OPERATION_FILE), report);
}

async function verifySignatureIfRequired(options) {
  const signatureRequired =
    options.requireSignature || options.signaturePath || options.publicKeyPath;
  if (!signatureRequired) {
    return null;
  }
  if (!options.publicKeyPath) {
    throw new Error("release signature verification requires a public key path");
  }
  const signaturePath = options.signaturePath || signaturePathFor(options.archivePath);
  const result = await verifyReleaseArchiveSignature({
    archivePath: options.archivePath,
    signaturePath,
    publicKeyPath: options.publicKeyPath
  });
  if (!result.valid) {
    throw new Error(`release signature verification failed: ${signaturePath}`);
  }
  return result;
}

function signatureMetadata(signature) {
  return signature
    ? {
        verified: true,
        algorithm: signature.algorithm,
        keyFingerprint: signature.keyFingerprint
      }
    : null;
}

async function installRelease(options) {
  if (!options.archivePath) {
    throw new Error("install requires an archive path");
  }
  const signature = await verifySignatureIfRequired(options);
  const releaseRoot = path.resolve(options.releaseRoot);
  const releasesDir = path.join(releaseRoot, "releases");
  const currentLink = path.join(releaseRoot, "current");
  const previousLink = path.join(releaseRoot, "previous");
  const run = options.run || runProcess;
  const service = options.service || "rpi4-gateway";
  const npmCommand = options.npmCommand || "npm";
  const stateBackup = options.stateBackup ? path.resolve(options.stateBackup) : null;

  await fsp.mkdir(releasesDir, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(releasesDir, ".staging-"));
  let manifest;
  let targetDir;
  let archiveSha256 = null;
  let sbom = null;
  const verifiedSignature = signatureMetadata(signature);
  try {
    const verified = await verifyReleasePackage({
      archivePath: options.archivePath,
      checksumPath: options.checksumPath,
      extractDir: stagingDir,
      run,
      expectedArchiveSha256: signature?.archiveSha256
    });
    manifest = verified.manifest;
    archiveSha256 = verified.archiveSha256;
    sbom = verified.sbom
      ? {
          path: manifest.sbom.path,
          format: verified.sbom.format,
          specVersion: verified.sbom.specVersion,
          serialNumber: verified.sbom.serialNumber,
          componentCount: verified.sbom.componentCount,
          dependencyCount: verified.sbom.dependencyCount
        }
      : null;
    checkRuntime(manifest);
    targetDir = path.join(releasesDir, manifest.releaseId);
    if (await pathExists(targetDir)) {
      throw new Error(`release is already installed: ${manifest.releaseId}`);
    }
    if (!options.skipNpmInstall) {
      await run(
        npmCommand,
        ["ci", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: stagingDir, timeoutMs: 900000 }
      );
    }
    await fsp.rename(stagingDir, targetDir);
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const previous = await readReleaseLink(currentLink, releasesDir);
  const oldPrevious = await readReleaseLink(previousLink, releasesDir);
  let stopped = false;
  let switched = false;
  let started = false;
  let previousLinkChanged = false;
  try {
    await run("systemctl", ["stop", service], { timeoutMs: 60000 });
    stopped = true;
    if (previous) {
      await switchSymlink(previousLink, previous.target);
    } else {
      await fsp.rm(previousLink, { force: true });
    }
    previousLinkChanged = true;
    await switchSymlink(currentLink, targetDir);
    switched = true;
    await run("systemctl", ["restart", service], { timeoutMs: 60000 });
    started = true;
    await waitForHealthy(options);

    const report = {
      schemaVersion: "1.0",
      action: "install",
      at: new Date((options.clock || Date.now)()).toISOString(),
      releaseId: manifest.releaseId,
      previousReleaseId: previous?.id || null,
      service,
      healthUrl: options.healthUrl ?? null,
      archiveSha256,
      stateBackup,
      sbom,
      signature: verifiedSignature
    };
    await writeOperationReport(releaseRoot, report);
    return {
      releaseRoot,
      releaseId: manifest.releaseId,
      releaseDir: targetDir,
      previousReleaseId: previous?.id || null,
      sbom,
      signature: verifiedSignature,
      report
    };
  } catch (error) {
    let rollback = null;
    let rollbackError = null;
    try {
      if (switched) {
        if (previous) {
          await switchSymlink(currentLink, previous.target);
          if (oldPrevious) {
            await switchSymlink(previousLink, oldPrevious.target);
          } else {
            await fsp.rm(previousLink, { force: true });
          }
          await run("systemctl", ["restart", service], { timeoutMs: 60000 });
          await waitForHealthy(options);
          rollback = { restoredReleaseId: previous.id };
        } else {
          if (started) {
            await run("systemctl", ["stop", service], { timeoutMs: 60000 });
          }
          await fsp.rm(currentLink, { force: true });
          if (oldPrevious) {
            await switchSymlink(previousLink, oldPrevious.target);
          } else {
            await fsp.rm(previousLink, { force: true });
          }
          rollback = { restoredReleaseId: null };
        }
      } else {
        if (previousLinkChanged) {
          if (oldPrevious) {
            await switchSymlink(previousLink, oldPrevious.target);
          } else {
            await fsp.rm(previousLink, { force: true });
          }
        }
        if (stopped && previous) {
          await run("systemctl", ["restart", service], { timeoutMs: 60000 });
          await waitForHealthy(options);
          rollback = { restoredReleaseId: previous.id };
        }
      }
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
    }
    const failure = new Error(
      `release install failed: ${error.message}${
        rollback?.restoredReleaseId
          ? `; restored ${rollback.restoredReleaseId}`
          : rollback
            ? "; restored initial state"
            : ""
      }${rollbackError ? `; rollback failed: ${rollbackError.message}` : ""}`
    );
    failure.cause = error;
    failure.rollback = rollback;
    failure.rollbackError = rollbackError;
    failure.releaseId = manifest.releaseId;
    await writeOperationReport(releaseRoot, {
      schemaVersion: "1.0",
      action: "install-failed",
      at: new Date((options.clock || Date.now)()).toISOString(),
      releaseId: manifest.releaseId,
      attemptedPreviousReleaseId: previous?.id || null,
      service,
      healthUrl: options.healthUrl ?? null,
      archiveSha256,
      stateBackup,
      sbom,
      signature: verifiedSignature,
      error: error.message,
      rollback: rollback?.restoredReleaseId || null,
      rollbackError: rollbackError?.message || null
    }).catch(() => undefined);
    throw failure;
  }
}

async function rollbackRelease(options) {
  const releaseRoot = path.resolve(options.releaseRoot);
  const releasesDir = path.join(releaseRoot, "releases");
  const currentLink = path.join(releaseRoot, "current");
  const previousLink = path.join(releaseRoot, "previous");
  const run = options.run || runProcess;
  const service = options.service || "rpi4-gateway";
  const current = await readReleaseLink(currentLink, releasesDir);
  if (!current) {
    throw new Error("no current release is installed");
  }
  const oldPrevious = await readReleaseLink(previousLink, releasesDir);
  let target = oldPrevious;
  if (options.toReleaseId) {
    const releaseId = validateReleaseId(options.toReleaseId);
    const targetPath = path.join(releasesDir, releaseId);
    const stats = await lstatIfExists(targetPath);
    if (!stats || !stats.isDirectory()) {
      throw new Error(`rollback release is not installed: ${releaseId}`);
    }
    target = { id: releaseId, target: targetPath };
  }
  if (!target) {
    throw new Error("no previous release is available for rollback");
  }
  if (target.id === current.id) {
    throw new Error(`release is already current: ${target.id}`);
  }

  await run("systemctl", ["stop", service], { timeoutMs: 60000 });
  try {
    await switchSymlink(currentLink, target.target);
    await switchSymlink(previousLink, current.target);
    await run("systemctl", ["restart", service], { timeoutMs: 60000 });
    await waitForHealthy(options);
    const report = {
      schemaVersion: "1.0",
      action: "rollback",
      at: new Date((options.clock || Date.now)()).toISOString(),
      releaseId: target.id,
      previousReleaseId: current.id,
      service,
      healthUrl: options.healthUrl ?? null
    };
    await writeOperationReport(releaseRoot, report);
    return {
      releaseRoot,
      releaseId: target.id,
      previousReleaseId: current.id,
      report
    };
  } catch (error) {
    let rollbackError = null;
    try {
      await switchSymlink(currentLink, current.target);
      if (oldPrevious) {
        await switchSymlink(previousLink, oldPrevious.target);
      } else {
        await fsp.rm(previousLink, { force: true });
      }
      await run("systemctl", ["restart", service], { timeoutMs: 60000 });
      await waitForHealthy(options);
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    const failure = new Error(
      `release rollback failed: ${error.message}${
        rollbackError
          ? `; restoring current release also failed: ${rollbackError.message}`
          : `; restored ${current.id}`
      }`
    );
    failure.cause = error;
    failure.rollbackError = rollbackError;
    throw failure;
  }
}

async function listReleases(options) {
  const releaseRoot = path.resolve(options.releaseRoot);
  const releasesDir = path.join(releaseRoot, "releases");
  const current = await readReleaseLink(path.join(releaseRoot, "current"), releasesDir);
  const previous = await readReleaseLink(path.join(releaseRoot, "previous"), releasesDir);
  let entries = [];
  try {
    entries = await fsp.readdir(releasesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const releaseDir = path.join(releasesDir, entry.name);
    let manifest = null;
    let error = null;
    try {
      const parsed = JSON.parse(
        await fsp.readFile(path.join(releaseDir, "release-manifest.json"), "utf8")
      );
      manifest = validateManifest(parsed);
    } catch (manifestError) {
      error = manifestError.message;
    }
    releases.push({
      releaseId: entry.name,
      current: current?.id === entry.name,
      previous: previous?.id === entry.name,
      version: manifest?.version || null,
      createdAt: manifest?.createdAt || null,
      commit: manifest?.git?.commit || null,
      error
    });
  }
  releases.sort((left, right) => left.releaseId.localeCompare(right.releaseId));
  return {
    releaseRoot,
    current: current?.id || null,
    previous: previous?.id || null,
    releases
  };
}

module.exports = {
  RELEASE_OPERATION_FILE,
  defaultCheckHealth,
  installRelease,
  listReleases,
  rollbackRelease,
  verifySignatureIfRequired,
  waitForHealthy
};
