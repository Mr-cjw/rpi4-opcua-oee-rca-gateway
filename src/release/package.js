"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  hashFile,
  lstatIfExists,
  pathExists,
  resolveWithin,
  runProcess,
  safeRelativePath
} = require("./common");
const {
  SBOM_FILE,
  SBOM_FORMAT,
  generateReleaseSbom,
  validateCycloneDxSbom
} = require("./sbom");
const {
  INITIAL_STATE_FORMAT_VERSION,
  STATE_FORMAT_VERSION
} = require("../gateway/state-format");
const {
  STATE_MIGRATION_FILE,
  assertRuntimeStateFormatCompatibility,
  compareStateFormatVersions,
  loadStateMigrationManifest,
  stateFormatMismatchMessage,
  validateStateFormatVersion
} = require("./state-migration");

const RELEASE_SCHEMA_VERSION = "1.0";
const MANIFEST_FILE = "release-manifest.json";
const CHECKSUM_FILE = "SHA256SUMS";
const REQUIRED_RELEASE_FILES = Object.freeze([
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
]);

function validateReleaseId(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,159}$/.test(value)) {
    throw new Error(`release id is invalid: ${value}`);
  }
  return value;
}

function rollbackMetadataForStateFormat(stateFormatVersion, stateMigration) {
  if (stateMigration) {
    return {
      mode: "state-restore-required",
      codeOnly: false,
      stateRestoreRequired: true,
      verifiedBackupRequired: true,
      note: `Restore the verified ${stateMigration.fromVersion} pre-migration backup before starting the previous release.`
    };
  }
  return {
    mode: "code-only",
    codeOnly: true,
    stateRestoreRequired: false,
    verifiedBackupRequired: false,
    note: `State format ${stateFormatVersion} is unchanged; rollback changes code only.`
  };
}

function validateRollbackMetadata(rollback, required) {
  if (rollback === undefined) {
    if (required) {
      throw new Error("release manifest must declare rollback mode for a state-format change");
    }
    return null;
  }
  if (!rollback || typeof rollback !== "object" || Array.isArray(rollback)) {
    throw new Error("release manifest rollback metadata must be an object");
  }
  if (rollback.mode !== "code-only" && rollback.mode !== "state-restore-required") {
    throw new Error(`release manifest rollback mode is invalid: ${rollback.mode || "missing"}`);
  }
  const stateRestoreRequired = rollback.mode === "state-restore-required";
  if (stateRestoreRequired !== required) {
    throw new Error(
      `release manifest rollback mode ${rollback.mode} does not match the state-format change`
    );
  }
  if (rollback.codeOnly !== !stateRestoreRequired) {
    throw new Error("release manifest rollback codeOnly flag is inconsistent");
  }
  if (rollback.stateRestoreRequired !== stateRestoreRequired) {
    throw new Error("release manifest rollback stateRestoreRequired flag is inconsistent");
  }
  if (rollback.verifiedBackupRequired !== stateRestoreRequired) {
    throw new Error("release manifest rollback verifiedBackupRequired flag is inconsistent");
  }
  if (typeof rollback.note !== "string" || rollback.note.trim() === "") {
    throw new Error("release manifest rollback note must be a non-empty string");
  }
  return { ...rollback };
}

function validateStateMigrationDescriptor(descriptor, required) {
  if (descriptor === undefined) {
    if (required) {
      throw new Error("state-format change requires a migration manifest");
    }
    return null;
  }
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("release manifest stateMigration must be an object");
  }
  if (descriptor.path !== STATE_MIGRATION_FILE) {
    throw new Error(`release manifest stateMigration path must be ${STATE_MIGRATION_FILE}`);
  }
  if (
    typeof descriptor.migrationId !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]{0,159}$/.test(descriptor.migrationId)
  ) {
    throw new Error(
      `release manifest stateMigration migrationId is invalid: ${descriptor.migrationId || "missing"}`
    );
  }
  validateStateFormatVersion(
    descriptor.fromVersion,
    "release manifest stateMigration fromVersion"
  );
  validateStateFormatVersion(
    descriptor.toVersion,
    "release manifest stateMigration toVersion"
  );
  if (descriptor.fromVersion === descriptor.toVersion) {
    throw new Error("release manifest stateMigration fromVersion and toVersion must differ");
  }
  if (compareStateFormatVersions(descriptor.fromVersion, descriptor.toVersion) > 0) {
    throw new Error("release manifest stateMigration cannot move to an older state format");
  }
  return { ...descriptor };
}

async function gitOutput(rootDir, args, run) {
  const { stdout } = await run("git", ["-C", rootDir, ...args], {
    timeoutMs: 60000
  });
  return stdout;
}

async function collectReleaseSource({ rootDir, run = runProcess }) {
  const resolvedRoot = path.resolve(rootDir);
  const status = await gitOutput(
    resolvedRoot,
    ["status", "--porcelain=v1", "--untracked-files=no"],
    run
  );
  const commit = (await gitOutput(resolvedRoot, ["rev-parse", "HEAD"], run)).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("unable to resolve a Git commit for the release");
  }
  const listed = await gitOutput(resolvedRoot, ["ls-files", "-z"], run);
  const files = listed
    .split("\0")
    .filter(Boolean)
    .map((filePath) => safeRelativePath(filePath, "tracked file path"))
    .sort();
  return { files, commit, dirty: status.trim() !== "" };
}

async function readPackageMetadata(rootDir) {
  const packagePath = path.join(rootDir, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read package.json: ${error.message}`);
  }
  if (!parsed || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error("package.json must include name and version");
  }
  return parsed;
}

function minimumNodeVersion(packageJson) {
  const engine = String(packageJson.engines?.node || "");
  const match = engine.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return null;
  }
  return [match[1], match[2] || "0", match[3] || "0"].map(Number).join(".");
}

function minimumNodeMajor(packageJson) {
  const version = minimumNodeVersion(packageJson);
  return version === null ? null : Number(version.split(".")[0]);
}

async function copyReleaseFiles(rootDir, stagingDir, files) {
  const entries = [];
  for (const relativePath of files) {
    const sourcePath = resolveWithin(rootDir, relativePath, "release source path");
    const stats = await lstatIfExists(sourcePath);
    if (!stats || !stats.isFile()) {
      throw new Error(`release source file is missing or not regular: ${relativePath}`);
    }
    const destinationPath = resolveWithin(stagingDir, relativePath, "release file path");
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.copyFile(sourcePath, destinationPath);
    const mode = stats.mode & 0o777;
    await fsp.chmod(destinationPath, mode);
    entries.push({
      path: relativePath,
      bytes: (await fsp.stat(destinationPath)).size,
      sha256: await hashFile(destinationPath),
      mode
    });
  }
  return entries;
}

function renderChecksums(entries) {
  return `${entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
}

async function createReleasePackage(options) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const outputDir = path.resolve(options.outputDir);
  const run = options.run || runProcess;
  const packageJson = await readPackageMetadata(rootDir);
  const source = options.source || (await collectReleaseSource({ rootDir, run }));
  const dirty = Boolean(source.dirty);
  if (dirty && !options.allowDirty) {
    throw new Error(
      "refusing to package tracked changes; commit them or pass --allow-dirty for a diagnostic build"
    );
  }
  const version = options.version || packageJson.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
    throw new Error(`release version is invalid: ${version}`);
  }
  const commit = source.commit || null;
  if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`release commit is invalid: ${commit}`);
  }
  const releaseId = validateReleaseId(
    options.releaseId ||
      `${version}-${(commit || "nogit").slice(0, 12)}${dirty ? "-dirty" : ""}`
  );
  const stateFormatVersion = validateStateFormatVersion(
    options.stateFormatVersion || STATE_FORMAT_VERSION,
    "release state format version"
  );
  const stateMigrationRequired = stateFormatVersion !== INITIAL_STATE_FORMAT_VERSION;
  const files = [...new Set(source.files || [])]
    .map((filePath) => safeRelativePath(filePath, "release file path"))
    .sort();
  if (files.length === 0) {
    throw new Error("release source contains no files");
  }
  for (const required of REQUIRED_RELEASE_FILES) {
    if (!files.includes(required)) {
      throw new Error(`release source is missing required file: ${required}`);
    }
  }
  if (files.includes(SBOM_FILE)) {
    throw new Error(`release source must not contain generated file: ${SBOM_FILE}`);
  }
  let stateMigration = null;
  if (stateMigrationRequired) {
    if (!files.includes(STATE_MIGRATION_FILE)) {
      throw new Error(
        `state format ${stateFormatVersion} requires ${STATE_MIGRATION_FILE} in the release source`
      );
    }
    stateMigration = await loadStateMigrationManifest(
      resolveWithin(rootDir, STATE_MIGRATION_FILE, "state migration path"),
      {
        releaseId,
        toVersion: stateFormatVersion
      }
    );
  } else if (files.includes(STATE_MIGRATION_FILE)) {
    throw new Error(
      `${STATE_MIGRATION_FILE} is only valid when the release changes the initial state format`
    );
  }
  const rollback = rollbackMetadataForStateFormat(stateFormatVersion, stateMigration);

  const archiveName = `${packageJson.name}-${releaseId}.tar.gz`;
  const archivePath = path.join(outputDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  if (!options.force && (await pathExists(archivePath))) {
    throw new Error(`release archive already exists: ${archivePath}`);
  }
  await fsp.mkdir(outputDir, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(outputDir, ".release-staging-"));
  try {
    const fileEntries = await copyReleaseFiles(rootDir, stagingDir, files);
    const createdAt = new Date((options.clock || Date.now)()).toISOString();
    const sbom = await generateReleaseSbom({
      rootDir,
      outputPath: path.join(stagingDir, SBOM_FILE),
      packageJson,
      version,
      releaseId,
      commit: commit || "nogit",
      dirty,
      createdAt,
      run,
      npmCommand: options.npmCommand
    });
    const sbomStats = await fsp.stat(sbom.path);
    fileEntries.push({
      path: SBOM_FILE,
      bytes: sbomStats.size,
      sha256: await hashFile(sbom.path),
      mode: 0o644
    });
    fileEntries.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      product: packageJson.name,
      version,
      releaseId,
      stateFormatVersion,
      rollback,
      ...(stateMigration
        ? {
            stateMigration: {
              path: STATE_MIGRATION_FILE,
              migrationId: stateMigration.migrationId,
              fromVersion: stateMigration.fromVersion,
              toVersion: stateMigration.toVersion
            }
          }
        : {}),
      createdAt,
      git: { commit, dirty },
      runtime: {
        nodeEngine: packageJson.engines?.node || null,
        minimumNodeMajor: minimumNodeMajor(packageJson),
        minimumNodeVersion: minimumNodeVersion(packageJson)
      },
      fileCount: fileEntries.length,
      totalBytes: fileEntries.reduce((total, entry) => total + entry.bytes, 0),
      sbom: {
        path: SBOM_FILE,
        format: sbom.format,
        specVersion: sbom.specVersion,
        serialNumber: sbom.serialNumber,
        componentCount: sbom.componentCount,
        dependencyCount: sbom.dependencyCount
      },
      files: fileEntries
    };
    const manifestPath = path.join(stagingDir, MANIFEST_FILE);
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644
    });
    const checksumEntries = [
      ...fileEntries,
      {
        path: MANIFEST_FILE,
        sha256: await hashFile(manifestPath)
      }
    ];
    await fsp.writeFile(path.join(stagingDir, CHECKSUM_FILE), renderChecksums(checksumEntries), {
      encoding: "utf8",
      mode: 0o644
    });

    await run("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
      timeoutMs: 300000
    });
    const archiveSha256 = await hashFile(archivePath);
    await fsp.writeFile(checksumPath, `${archiveSha256}  ${archiveName}\n`, {
      encoding: "utf8",
      mode: 0o644
    });
    return {
      archivePath,
      checksumPath,
      archiveSha256,
      manifest,
      sbom
    };
  } catch (error) {
    await fsp.rm(archivePath, { force: true }).catch(() => undefined);
    await fsp.rm(checksumPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseChecksumContent(content, source) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${source} must contain exactly one SHA-256 entry`);
  }
  const match = lines[0].match(/^([0-9a-f]{64})\s+\*?(.+)$/);
  if (!match) {
    throw new Error(`${source} is not a valid SHA-256 checksum file`);
  }
  return { sha256: match[1], fileName: match[2] };
}

function parseManifestChecksums(content) {
  const entries = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) {
      throw new Error(`invalid ${CHECKSUM_FILE} entry: ${line}`);
    }
    const relativePath = safeRelativePath(match[2], "checksum path");
    if (entries.has(relativePath)) {
      throw new Error(`duplicate checksum entry: ${relativePath}`);
    }
    entries.set(relativePath, match[1]);
  }
  return entries;
}

function validateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("release manifest must be an object");
  }
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new Error(`unsupported release schema: ${manifest.schemaVersion || "missing"}`);
  }
  validateReleaseId(manifest.releaseId);
  if (typeof manifest.product !== "string" || typeof manifest.version !== "string") {
    throw new Error("release manifest must include product and version");
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("release manifest createdAt is invalid");
  }
  const stateFormatVersion = validateStateFormatVersion(
    manifest.stateFormatVersion,
    "release state format version"
  );
  const stateMigrationRequired = stateFormatVersion !== INITIAL_STATE_FORMAT_VERSION;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("release manifest must contain at least one file");
  }
  const seen = new Set();
  const files = manifest.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("release file entry must be an object");
    }
    const relativePath = safeRelativePath(entry.path, "release manifest path");
    if (relativePath === MANIFEST_FILE || relativePath === CHECKSUM_FILE) {
      throw new Error(`release manifest cannot hash itself: ${relativePath}`);
    }
    if (seen.has(relativePath)) {
      throw new Error(`release manifest contains a duplicate path: ${relativePath}`);
    }
    seen.add(relativePath);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`release byte count is invalid for ${relativePath}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`release checksum is invalid for ${relativePath}`);
    }
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error(`release mode is invalid for ${relativePath}`);
    }
    return { ...entry, path: relativePath };
  });
  if (!Number.isInteger(manifest.fileCount) || manifest.fileCount !== files.length) {
    throw new Error("release file count does not match the manifest");
  }
  const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isInteger(manifest.totalBytes) || manifest.totalBytes !== totalBytes) {
    throw new Error("release total byte count does not match the manifest");
  }
  for (const required of REQUIRED_RELEASE_FILES) {
    if (!seen.has(required)) {
      throw new Error(`release manifest is missing required file: ${required}`);
    }
  }
  const stateMigration = validateStateMigrationDescriptor(
    manifest.stateMigration,
    stateMigrationRequired
  );
  if (stateMigration) {
    if (!seen.has(STATE_MIGRATION_FILE)) {
      throw new Error(
        `release manifest stateMigration is missing from files: ${STATE_MIGRATION_FILE}`
      );
    }
    if (stateMigration.toVersion !== stateFormatVersion) {
      throw new Error("release manifest stateMigration toVersion does not match stateFormatVersion");
    }
  }
  const rollback = validateRollbackMetadata(manifest.rollback, stateMigrationRequired);
  if (manifest.sbom !== undefined) {
    if (!manifest.sbom || typeof manifest.sbom !== "object" || Array.isArray(manifest.sbom)) {
      throw new Error("release manifest sbom must be an object");
    }
    if (manifest.sbom.path !== SBOM_FILE) {
      throw new Error(`release manifest sbom path must be ${SBOM_FILE}`);
    }
    if (!seen.has(SBOM_FILE)) {
      throw new Error(`release manifest sbom is missing from files: ${SBOM_FILE}`);
    }
    if (manifest.sbom.format !== SBOM_FORMAT) {
      throw new Error(`release manifest sbom format must be ${SBOM_FORMAT}`);
    }
    if (
      typeof manifest.sbom.specVersion !== "string" ||
      !/^1\.\d+$/.test(manifest.sbom.specVersion)
    ) {
      throw new Error("release manifest sbom specVersion is invalid");
    }
    if (!Number.isInteger(manifest.sbom.componentCount) || manifest.sbom.componentCount < 0) {
      throw new Error("release manifest sbom componentCount is invalid");
    }
    if (
      manifest.sbom.dependencyCount !== undefined &&
      (!Number.isInteger(manifest.sbom.dependencyCount) || manifest.sbom.dependencyCount < 0)
    ) {
      throw new Error("release manifest sbom dependencyCount is invalid");
    }
  }
  const validated = {
    ...manifest,
    stateFormatVersion,
    files,
    ...(rollback ? { rollback } : {}),
    ...(stateMigration ? { stateMigration } : {})
  };
  if (!options.deferStateFormatCheck && stateFormatVersion !== STATE_FORMAT_VERSION) {
    throw new Error(
      stateFormatMismatchMessage({
        releaseVersion: stateFormatVersion,
        runtimeVersion: STATE_FORMAT_VERSION,
        migration: stateMigration
      })
    );
  }
  return validated;
}

async function walkFiles(rootDir, currentDir = rootDir) {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const stats = await fsp.lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`release archive contains a symbolic link: ${fullPath}`);
    }
    if (stats.isDirectory()) {
      files.push(...(await walkFiles(rootDir, fullPath)));
    } else if (stats.isFile()) {
      files.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
    } else {
      throw new Error(`release archive contains an unsupported file type: ${fullPath}`);
    }
  }
  return files;
}

async function verifyReleasePackage(options) {
  const archivePath = path.resolve(options.archivePath);
  const checksumPath = path.resolve(options.checksumPath || `${archivePath}.sha256`);
  const run = options.run || runProcess;
  const requireChecksum = options.requireChecksum !== false;
  const archiveSha256 = await hashFile(archivePath);
  if (
    options.expectedArchiveSha256 &&
    options.expectedArchiveSha256 !== archiveSha256
  ) {
    throw new Error("release archive changed after signature verification");
  }
  let checksum = null;
  if (await pathExists(checksumPath)) {
    checksum = parseChecksumContent(
      await fsp.readFile(checksumPath, "utf8"),
      path.basename(checksumPath)
    );
    if (path.basename(checksum.fileName) !== path.basename(archivePath)) {
      throw new Error(`release checksum names a different archive: ${checksum.fileName}`);
    }
    if (checksum.sha256 !== archiveSha256) {
      throw new Error("release archive checksum mismatch");
    }
  } else if (requireChecksum) {
    throw new Error(`release checksum file not found: ${checksumPath}`);
  }

  const listed = await run("tar", ["-tzf", archivePath], { timeoutMs: 120000 });
  for (const entry of listed.stdout.split(/\r?\n/)) {
    const normalized = entry.replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized === "./") {
      continue;
    }
    safeRelativePath(normalized, "archive entry");
  }

  const ownedExtractDir = !options.extractDir;
  const extractDir = path.resolve(
    options.extractDir || (await fsp.mkdtemp(path.join(os.tmpdir(), "rpi4-release-verify-")))
  );
  await fsp.mkdir(extractDir, { recursive: true });
  try {
    await run(
      "tar",
      ["-xzf", archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"],
      { timeoutMs: 120000 }
    );
    let rawManifest;
    try {
      rawManifest = await fsp.readFile(path.join(extractDir, MANIFEST_FILE), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`release manifest not found in archive: ${MANIFEST_FILE}`);
      }
      throw error;
    }
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(rawManifest);
    } catch (error) {
      throw new Error(`release manifest is not valid JSON: ${error.message}`);
    }
    const manifest = validateManifest(parsedManifest, {
      deferStateFormatCheck: true
    });
    const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
    for (const entry of manifest.files) {
      const filePath = resolveWithin(extractDir, entry.path, "release manifest path");
      const stats = await lstatIfExists(filePath);
      if (!stats || !stats.isFile()) {
        throw new Error(`release file is missing or not regular: ${entry.path}`);
      }
      if (stats.size !== entry.bytes) {
        throw new Error(`release size mismatch for ${entry.path}`);
      }
      if ((await hashFile(filePath)) !== entry.sha256) {
        throw new Error(`release checksum mismatch for ${entry.path}`);
      }
    }

    const actualFiles = (await walkFiles(extractDir)).sort();
    const allowedExtras = new Set([MANIFEST_FILE, CHECKSUM_FILE]);
    for (const relativePath of actualFiles) {
      if (!expected.has(relativePath) && !allowedExtras.has(relativePath)) {
        throw new Error(`release archive contains an unlisted file: ${relativePath}`);
      }
    }
    for (const required of expected.keys()) {
      if (!actualFiles.includes(required)) {
        throw new Error(`release archive is missing ${required}`);
      }
    }

    let internalChecksums;
    try {
      internalChecksums = parseManifestChecksums(
        await fsp.readFile(path.join(extractDir, CHECKSUM_FILE), "utf8")
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`release checksum list not found: ${CHECKSUM_FILE}`);
      }
      throw error;
    }
    const expectedChecksums = new Map(
      manifest.files.map((entry) => [entry.path, entry.sha256])
    );
    expectedChecksums.set(
      MANIFEST_FILE,
      await hashFile(path.join(extractDir, MANIFEST_FILE))
    );
    for (const [relativePath, expectedHash] of expectedChecksums) {
      if (internalChecksums.get(relativePath) !== expectedHash) {
        throw new Error(`release checksum list mismatch for ${relativePath}`);
      }
    }
    for (const relativePath of internalChecksums.keys()) {
      if (!expectedChecksums.has(relativePath)) {
        throw new Error(`release checksum list contains an unexpected path: ${relativePath}`);
      }
    }

    let sbom = null;
    if (manifest.sbom) {
      let parsedSbom;
      try {
        parsedSbom = JSON.parse(
          await fsp.readFile(resolveWithin(extractDir, manifest.sbom.path, "SBOM path"), "utf8")
        );
      } catch (error) {
        throw new Error(`release SBOM is not valid JSON: ${error.message}`);
      }
      sbom = validateCycloneDxSbom(parsedSbom, {
        product: manifest.product,
        version: manifest.version
      });
      if (sbom.componentCount !== manifest.sbom.componentCount) {
        throw new Error("release SBOM component count does not match the manifest");
      }
      if (
        manifest.sbom.dependencyCount !== undefined &&
        sbom.dependencyCount !== manifest.sbom.dependencyCount
      ) {
        throw new Error("release SBOM dependency count does not match the manifest");
      }
      if (manifest.sbom.serialNumber && sbom.serialNumber !== manifest.sbom.serialNumber) {
        throw new Error("release SBOM serial number does not match the manifest");
      }
      if (sbom.format !== manifest.sbom.format || sbom.specVersion !== manifest.sbom.specVersion) {
        throw new Error("release SBOM format does not match the manifest");
      }
    }

    let stateMigration = null;
    if (manifest.stateMigration) {
      stateMigration = await loadStateMigrationManifest(
        resolveWithin(
          extractDir,
          manifest.stateMigration.path,
          "state migration path"
        ),
        {
          releaseId: manifest.releaseId,
          fromVersion: manifest.stateMigration.fromVersion,
          toVersion: manifest.stateMigration.toVersion
        }
      );
      if (stateMigration.migrationId !== manifest.stateMigration.migrationId) {
        throw new Error("release state migration id does not match the manifest");
      }
    }
    if (manifest.stateFormatVersion !== STATE_FORMAT_VERSION) {
      assertRuntimeStateFormatCompatibility({
        releaseVersion: manifest.stateFormatVersion,
        runtimeVersion: STATE_FORMAT_VERSION,
        migration: stateMigration
      });
    }

    return {
      archivePath,
      archiveSha256,
      checksumPath,
      checksum,
      extractDir,
      manifest,
      stateMigration,
      sbom,
      cleanup: ownedExtractDir
        ? async () => fsp.rm(extractDir, { recursive: true, force: true })
        : async () => undefined
    };
  } catch (error) {
    if (ownedExtractDir) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

module.exports = {
  CHECKSUM_FILE,
  MANIFEST_FILE,
  RELEASE_SCHEMA_VERSION,
  REQUIRED_RELEASE_FILES,
  SBOM_FILE,
  collectReleaseSource,
  createReleasePackage,
  parseChecksumContent,
  parseManifestChecksums,
  validateReleaseId,
  validateManifest,
  verifyReleasePackage
};
