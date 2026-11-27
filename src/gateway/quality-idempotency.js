"use strict";

const fs = require("node:fs/promises");
const { writeFileAtomic } = require("./durable-file");

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

    const payload = {
      schemaVersion: "1.0",
      savedAt: new Date().toISOString(),
      entries
    };

    await writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600
    });
    return true;
  }
}

module.exports = {
  QualityIdempotencyStore
};
