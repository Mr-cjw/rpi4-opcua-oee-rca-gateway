"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

class QualityIdempotencyStore {
  constructor(filePath) {
    this.filePath = filePath || null;
  }

  get enabled() {
    return Boolean(this.filePath);
  }

  async load() {
    if (!this.enabled) {
      return { loaded: false, entries: [] };
    }

    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { loaded: false, entries: [] };
      }
      throw error;
    }

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      throw new Error(`quality idempotency state is not valid JSON: ${this.filePath}`);
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error(`quality idempotency state must be a JSON object: ${this.filePath}`);
    }
    if (!Array.isArray(stored.entries)) {
      throw new Error(`quality idempotency state entries must be an array: ${this.filePath}`);
    }
    return { loaded: true, entries: stored.entries };
  }

  async save(entries) {
    if (!this.enabled) {
      return false;
    }

    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = {
      schemaVersion: "1.0",
      savedAt: new Date().toISOString(),
      entries
    };

    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.rename(tempPath, this.filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    return true;
  }
}

module.exports = {
  QualityIdempotencyStore
};
