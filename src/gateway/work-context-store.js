"use strict";

const fs = require("node:fs/promises");
const { writeFileAtomic } = require("./durable-file");
const {
  normalizeWorkContextUpdate,
  workContextFrom
} = require("./work-context");

class WorkContextStore {
  constructor(filePath) {
    this.filePath = filePath || null;
  }

  get enabled() {
    return Boolean(this.filePath);
  }

  async load() {
    if (!this.enabled) {
      return { loaded: false, context: null };
    }

    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { loaded: false, context: null };
      }
      throw error;
    }

    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      throw new Error(`work context state is not valid JSON: ${this.filePath}`);
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error(`work context state must be a JSON object: ${this.filePath}`);
    }

    return {
      loaded: true,
      context: workContextFrom(normalizeWorkContextUpdate(stored))
    };
  }

  async save(context) {
    if (!this.enabled) {
      return false;
    }

    const payload = {
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      ...workContextFrom(context)
    };

    await writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600
    });
    return true;
  }
}

module.exports = {
  WorkContextStore
};
