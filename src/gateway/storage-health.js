"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class StorageWriteError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "StorageWriteError";
    this.statusCode = 503;
  }
}

function componentStatus(entry) {
  return {
    status: entry.consecutiveFailures > 0 ? "critical" : "ok",
    consecutiveFailures: entry.consecutiveFailures,
    totalFailures: entry.totalFailures,
    lastError: entry.lastError,
    lastFailureAt: entry.lastFailureAt,
    lastSuccessAt: entry.lastSuccessAt
  };
}

class StorageMonitor {
  constructor(options = {}) {
    this.diskPath = options.diskPath || process.cwd();
    this.warnFreeBytes = options.warnFreeBytes ?? 100 * 1024 * 1024;
    this.criticalFreeBytes = options.criticalFreeBytes ?? 32 * 1024 * 1024;
    this.checkIntervalMs = options.checkIntervalMs ?? 60000;
    this.statfs = options.statfs || fs.statfs;
    this.clock = options.clock || (() => Date.now());
    this.components = new Map();
    this.disk = {
      status: "unknown",
      path: this.diskPath,
      freeBytes: null,
      totalBytes: null,
      usageRatio: null,
      lastCheckAt: null,
      lastError: null
    };
    this._timer = null;
  }

  async start() {
    await this.checkDisk();
    if (!this._timer && this.checkIntervalMs > 0) {
      this._timer = setInterval(() => {
        this.checkDisk().catch(() => undefined);
      }, this.checkIntervalMs);
      this._timer.unref?.();
    }
    return this.getStatus();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _existingPath() {
    let candidate = this.diskPath;
    while (true) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          return candidate;
        }
        candidate = parent;
      }
    }
  }

  async checkDisk() {
    try {
      const path = await this._existingPath();
      const stats = await this.statfs(path, { bigint: true });
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      const freeBytes = Number(stats.bavail) * blockSize;
      const usageRatio = totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : 0;
      let status = "ok";
      if (freeBytes <= this.criticalFreeBytes) {
        status = "critical";
      } else if (freeBytes <= this.warnFreeBytes) {
        status = "warning";
      }
      this.disk = {
        status,
        path,
        freeBytes,
        totalBytes,
        usageRatio,
        lastCheckAt: new Date(this.clock()).toISOString(),
        lastError: null
      };
      return this.getStatus();
    } catch (error) {
      this.disk = {
        ...this.disk,
        status: "critical",
        lastCheckAt: new Date(this.clock()).toISOString(),
        lastError: error.message
      };
      return this.getStatus();
    }
  }

  recordError(component, error) {
    const now = new Date(this.clock()).toISOString();
    const current = this.components.get(component) || {
      consecutiveFailures: 0,
      totalFailures: 0,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null
    };
    this.components.set(component, {
      ...current,
      consecutiveFailures: current.consecutiveFailures + 1,
      totalFailures: current.totalFailures + 1,
      lastError: error?.message || String(error),
      lastFailureAt: now
    });
  }

  recordSuccess(component) {
    const current = this.components.get(component) || {
      consecutiveFailures: 0,
      totalFailures: 0,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null
    };
    this.components.set(component, {
      ...current,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: new Date(this.clock()).toISOString()
    });
  }

  getStatus() {
    const components = Object.fromEntries(
      [...this.components.entries()].map(([name, entry]) => [name, componentStatus(entry)])
    );
    const componentCritical = Object.values(components).some(
      (entry) => entry.status === "critical"
    );
    const status =
      componentCritical || this.disk.status === "critical"
        ? "critical"
        : this.disk.status === "warning"
          ? "warning"
          : "ok";
    return {
      status,
      healthy: status === "ok",
      disk: { ...this.disk },
      components
    };
  }
}

module.exports = {
  StorageMonitor,
  StorageWriteError
};
