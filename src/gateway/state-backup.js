"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { STATE_FORMAT_VERSION } = require("./state-format");

const BACKUP_SCHEMA_VERSION = "1.0";
const MANIFEST_FILE = "state-manifest.json";

function safeRelativePath(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("backup file path must be a non-empty string");
  }
  if (value.includes("\0")) {
    throw new Error("backup file path must not contain NUL bytes");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`backup file path must be relative: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`backup file path contains an unsafe segment: ${value}`);
  }
  return segments.join("/");
}

function resolveWithin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const safePath = safeRelativePath(relativePath);
  const target = path.resolve(resolvedRoot, ...safePath.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`backup file path escapes the state directory: ${relativePath}`);
  }
  return target;
}

function expandLogPaths(logPath, maxFiles) {
  if (!logPath || logPath === "stdout") {
    return [];
  }
  const paths = [path.resolve(logPath)];
  for (let index = 1; index <= maxFiles; index += 1) {
    paths.push(path.resolve(`${logPath}.${index}`));
  }
  return paths;
}

function statePathsFromConfig(config) {
  const paths = [
    ...expandLogPaths(config?.context?.logPath, config?.context?.logMaxFiles ?? 0),
    ...expandLogPaths(config?.quality?.logPath, config?.quality?.logMaxFiles ?? 0)
  ];
  if (config?.quality?.idempotencyPath) {
    paths.push(path.resolve(config.quality.idempotencyPath));
  }
  if (config?.workContext?.statePath) {
    paths.push(path.resolve(config.workContext.statePath));
  }
  return [...new Set(paths)];
}

function relativeToStateDir(stateDir, filePath) {
  const relative = path.relative(stateDir, filePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`configured state path is outside ${stateDir}: ${filePath}`);
  }
  return safeRelativePath(relative.split(path.sep).join("/"));
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pathExists(filePath) {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("state backup manifest must be an object");
  }
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `unsupported state backup schema: ${manifest.schemaVersion || "missing"}`
    );
  }
  if (
    manifest.stateFormatVersion !== undefined &&
    manifest.stateFormatVersion !== STATE_FORMAT_VERSION
  ) {
    throw new Error(
      `unsupported state format: ${manifest.stateFormatVersion || "missing"}`
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("state backup manifest must contain at least one file");
  }

  const seen = new Set();
  const files = manifest.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("state backup file entry must be an object");
    }
    const relativePath = safeRelativePath(entry.path);
    if (seen.has(relativePath)) {
      throw new Error(`state backup contains a duplicate path: ${relativePath}`);
    }
    seen.add(relativePath);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`state backup byte count is invalid for ${relativePath}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`state backup checksum is invalid for ${relativePath}`);
    }
    const mode = entry.mode === undefined ? 0o600 : entry.mode;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error(`state backup mode is invalid for ${relativePath}`);
    }
    return { ...entry, path: relativePath, mode };
  });
  const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (!Number.isInteger(manifest.fileCount) || manifest.fileCount !== files.length) {
    throw new Error("state backup file count does not match the manifest");
  }
  if (!Number.isInteger(manifest.totalBytes) || manifest.totalBytes !== totalBytes) {
    throw new Error("state backup total byte count does not match the manifest");
  }
  if (
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new Error("state backup createdAt is invalid");
  }

  return { ...manifest, files };
}

async function createStateBackup(options) {
  const stateDir = path.resolve(options.stateDir);
  const outputPath = path.resolve(options.outputPath);
  const force = Boolean(options.force);
  const clock = options.clock || (() => Date.now());
  const config = options.config;
  if (outputPath === stateDir || outputPath === path.parse(outputPath).root) {
    throw new Error("backup output must be a dedicated directory, not the state root");
  }
  if (!force && (await pathExists(outputPath))) {
    throw new Error(`backup output already exists: ${outputPath}`);
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const stagingPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.mkdir(stagingPath);
  try {
    const files = [];
    const missingFiles = [];
    for (const sourcePath of statePathsFromConfig(config)) {
      const relativePath = relativeToStateDir(stateDir, sourcePath);
      let stats;
      try {
        stats = await fsp.stat(sourcePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          missingFiles.push(relativePath);
          continue;
        }
        throw error;
      }
      if (!stats.isFile()) {
        throw new Error(`configured state path is not a regular file: ${sourcePath}`);
      }

      const destinationPath = resolveWithin(stagingPath, relativePath);
      await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
      await fsp.copyFile(sourcePath, destinationPath);
      await fsp.chmod(destinationPath, stats.mode & 0o777);
      files.push({
        path: relativePath,
        bytes: (await fsp.stat(destinationPath)).size,
        sha256: await hashFile(destinationPath),
        mode: stats.mode & 0o777
      });
    }
    if (files.length === 0) {
      throw new Error("no configured Gateway state files exist to back up");
    }

    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      stateFormatVersion: STATE_FORMAT_VERSION,
      createdAt: new Date(clock()).toISOString(),
      sourceStateDir: stateDir,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
      missingFiles
    };
    await fsp.writeFile(
      path.join(stagingPath, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    if (force) {
      await fsp.rm(outputPath, { recursive: true, force: true });
    }
    await fsp.rename(stagingPath, outputPath);
    return { outputPath, manifest };
  } catch (error) {
    await fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyStateBackup(options) {
  const backupDir = path.resolve(options.backupDir);
  let raw;
  try {
    raw = await fsp.readFile(path.join(backupDir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`state backup manifest not found: ${backupDir}`);
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`state backup manifest is not valid JSON: ${error.message}`);
  }
  const validated = validateManifest(manifest);

  for (const entry of validated.files) {
    const filePath = resolveWithin(backupDir, entry.path);
    let stats;
    try {
      stats = await fsp.lstat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`state backup file is missing: ${entry.path}`);
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw new Error(`state backup entry is not a regular file: ${entry.path}`);
    }
    if (stats.size !== entry.bytes) {
      throw new Error(`state backup size mismatch for ${entry.path}`);
    }
    if ((await hashFile(filePath)) !== entry.sha256) {
      throw new Error(`state backup checksum mismatch for ${entry.path}`);
    }
  }
  return { backupDir, manifest: validated };
}

async function restoreStateBackup(options) {
  const { manifest } = await verifyStateBackup(options);
  const stateDir = path.resolve(options.stateDir);
  const force = Boolean(options.force);
  await fsp.mkdir(stateDir, { recursive: true });

  const restorePlan = [];
  for (const entry of manifest.files) {
    const sourcePath = resolveWithin(options.backupDir, entry.path);
    const destinationPath = resolveWithin(stateDir, entry.path);
    if (await pathExists(destinationPath)) {
      const stats = await fsp.lstat(destinationPath);
      if (!force) {
        throw new Error(`refusing to overwrite existing state file: ${destinationPath}`);
      }
      if (!stats.isFile()) {
        throw new Error(`restore destination is not a regular file: ${destinationPath}`);
      }
    }
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.restore.tmp`;
    restorePlan.push({ entry, sourcePath, destinationPath, temporaryPath });
  }

  try {
    for (const item of restorePlan) {
      await fsp.mkdir(path.dirname(item.destinationPath), { recursive: true });
      await fsp.copyFile(item.sourcePath, item.temporaryPath);
      await fsp.chmod(item.temporaryPath, item.entry.mode);
    }
    for (const item of restorePlan) {
      await fsp.rename(item.temporaryPath, item.destinationPath);
    }
  } finally {
    await Promise.all(
      restorePlan.map((item) =>
        fsp.rm(item.temporaryPath, { force: true }).catch(() => undefined)
      )
    );
  }

  return {
    stateDir,
    restoredFiles: restorePlan.map((item) => item.entry.path),
    manifest
  };
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  MANIFEST_FILE,
  createStateBackup,
  restoreStateBackup,
  statePathsFromConfig,
  verifyStateBackup
};
