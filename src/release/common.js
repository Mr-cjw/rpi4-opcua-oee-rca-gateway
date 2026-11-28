"use strict";

const { execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function safeRelativePath(value, label = "file path") {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} contains an unsupported character: ${value}`);
  }
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (normalized === "" || normalized === "." || normalized === "..") {
    throw new Error(`${label} is not a file: ${value}`);
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} must be relative: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe segment: ${value}`);
  }
  return segments.join("/");
}

function resolveWithin(root, relativePath, label = "file path") {
  const resolvedRoot = path.resolve(root);
  const safePath = safeRelativePath(relativePath, label);
  const target = path.resolve(resolvedRoot, ...safePath.split("/"));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return target;
}

async function lstatIfExists(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath) {
  return (await lstatIfExists(filePath)) !== null;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runProcess(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    timeout: options.timeoutMs || 300000,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    windowsHide: true
  });
  return { stdout, stderr };
}

async function writeJsonAtomic(filePath, value, options = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: options.mode || 0o644
    });
    await fsp.chmod(temporaryPath, options.mode || 0o644);
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function switchSymlink(linkPath, targetPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true });
  const temporaryPath = `${linkPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.symlink(targetPath, temporaryPath, "dir");
    await fsp.rename(temporaryPath, linkPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readLinkTarget(linkPath) {
  try {
    const target = await fsp.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") {
      return null;
    }
    throw error;
  }
}

module.exports = {
  hashFile,
  lstatIfExists,
  pathExists,
  readLinkTarget,
  resolveWithin,
  runProcess,
  safeRelativePath,
  switchSymlink,
  writeJsonAtomic
};
