"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const IGNORED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]);

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!IGNORED_DIRECTORY_SYNC_ERRORS.has(error.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeFileAtomic(filePath, contents, options = {}) {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = options.mode ?? 0o600;
  const fsync = options.fsync !== false;
  await fs.mkdir(directory, { recursive: true });
  let handle;
  try {
    handle = await fs.open(tempPath, "w", mode);
    await handle.writeFile(contents, "utf8");
    if (fsync) {
      await handle.sync();
    }
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    if (fsync) {
      await syncDirectory(directory);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  return true;
}

module.exports = {
  syncDirectory,
  writeFileAtomic
};
