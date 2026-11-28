"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_CLOCK_SYNC_OPTIONS = Object.freeze({
  checkIntervalMs: 60000,
  maxAgeMs: 180000,
  maxOffsetMs: 1000,
  required: false
});

function parseTimedatectlOutput(output) {
  const value = String(output || "").trim().toLowerCase();
  if (value === "yes") {
    return { synchronized: true, source: "timedatectl" };
  }
  if (value === "no") {
    return { synchronized: false, source: "timedatectl" };
  }
  return null;
}

function parseChronycTracking(output) {
  const text = String(output || "");
  const systemTime = text.match(
    /^System time\s*:\s*([+-]?\d+(?:\.\d+)?)\s*seconds\s+(fast|slow)\s+of\s+NTP time\s*$/im
  );
  if (!systemTime) {
    return null;
  }
  const leapStatus = text.match(/^Leap status\s*:\s*(.+?)\s*$/im)?.[1]?.trim() || null;
  const magnitudeMs = Math.abs(Number(systemTime[1])) * 1000;
  const offsetMs = systemTime[2].toLowerCase() === "slow" ? -magnitudeMs : magnitudeMs;
  const synchronized = leapStatus ? /^normal$/i.test(leapStatus) : null;
  return {
    synchronized,
    source: "chronyc",
    offsetMs,
    leapStatus
  };
}

async function runCommand(command, args, timeoutMs = 2500) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error
    };
  }
}

async function defaultCheckClock() {
  if (process.platform !== "linux") {
    return {
      synchronized: null,
      source: "unsupported",
      error: `system clock synchronization detection is not implemented for ${process.platform}`
    };
  }

  const timedatectl = await runCommand("timedatectl", [
    "show",
    "--property=NTPSynchronized",
    "--value"
  ]);
  if (timedatectl.ok) {
    const parsed = parseTimedatectlOutput(timedatectl.stdout);
    if (parsed) {
      return parsed;
    }
  }

  const chronyc = await runCommand("chronyc", ["-n", "tracking"]);
  if (chronyc.ok) {
    const parsed = parseChronycTracking(chronyc.stdout);
    if (parsed) {
      return parsed;
    }
  }

  const errors = [];
  if (!timedatectl.ok && timedatectl.code !== "ENOENT") {
    errors.push(`timedatectl: ${String(timedatectl.error.message).split("\n")[0]}`);
  }
  if (!chronyc.ok && chronyc.code !== "ENOENT") {
    errors.push(`chronyc: ${String(chronyc.error.message).split("\n")[0]}`);
  }
  return {
    synchronized: null,
    source: "unavailable",
    error:
      errors.join("; ") ||
      "no supported NTP status source was found (timedatectl or chronyc)"
  };
}

function safeError(error) {
  if (!error) {
    return null;
  }
  return String(error.message || error)
    .split("\n")[0]
    .slice(0, 500);
}

class ClockSyncMonitor {
  constructor(options = {}, dependencies = {}) {
    this.options = { ...DEFAULT_CLOCK_SYNC_OPTIONS, ...options };
    this.checkClock = dependencies.checkClock || defaultCheckClock;
    this.now = dependencies.now || (() => Date.now());
    this._started = false;
    this._timer = null;
    this._checking = null;
    this._last = null;
  }

  async start() {
    if (this._started) {
      return this;
    }
    this._started = true;
    await this.checkNow();
    this._schedule();
    return this;
  }

  async stop() {
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this._checking?.catch(() => undefined);
  }

  async checkNow() {
    if (this._checking) {
      return this._checking;
    }
    this._checking = this._checkOnce().finally(() => {
      this._checking = null;
    });
    return this._checking;
  }

  async _checkOnce() {
    const checkedAtMs = this.now();
    try {
      const result = (await this.checkClock()) || {};
      const synchronized =
        result.synchronized === true
          ? true
          : result.synchronized === false
            ? false
            : null;
      const offsetMs = Number.isFinite(result.offsetMs) ? result.offsetMs : null;
      let status = "unknown";
      let reason = "unavailable";
      if (synchronized === true) {
        if (offsetMs !== null && Math.abs(offsetMs) > this.options.maxOffsetMs) {
          status = "warning";
          reason = "offset_exceeds_limit";
        } else {
          status = "ok";
          reason = "synchronized";
        }
      } else if (synchronized === false) {
        status = "warning";
        reason = "not_synchronized";
      }
      this._last = {
        synchronized,
        status,
        reason,
        source: result.source || "unknown",
        checkedAtMs,
        offsetMs,
        leapStatus: result.leapStatus || null,
        error: safeError(result.error)
      };
    } catch (error) {
      this._last = {
        synchronized: null,
        status: "unknown",
        reason: "check_failed",
        source: "error",
        checkedAtMs,
        offsetMs: null,
        leapStatus: null,
        error: safeError(error)
      };
    }
    return this.getStatus();
  }

  _schedule() {
    if (!this._started) {
      return;
    }
    this._timer = setTimeout(async () => {
      this._timer = null;
      await this.checkNow().catch(() => undefined);
      this._schedule();
    }, this.options.checkIntervalMs);
    this._timer.unref?.();
  }

  getStatus() {
    const ageMs = this._last ? Math.max(0, this.now() - this._last.checkedAtMs) : null;
    const stale = ageMs !== null && ageMs > this.options.maxAgeMs;
    const status = stale ? "warning" : this._last?.status || "unknown";
    return {
      schemaVersion: "1.0",
      status,
      healthy: status === "ok",
      synchronized: this._last?.synchronized ?? null,
      required: this.options.required === true,
      source: this._last?.source || "pending",
      checkedAt: this._last ? new Date(this._last.checkedAtMs).toISOString() : null,
      ageMs,
      stale,
      offsetMs: this._last?.offsetMs ?? null,
      maxOffsetMs: this.options.maxOffsetMs,
      checkIntervalMs: this.options.checkIntervalMs,
      maxAgeMs: this.options.maxAgeMs,
      leapStatus: this._last?.leapStatus ?? null,
      reason: stale ? "check_stale" : this._last?.reason || "pending",
      error: this._last?.error ?? null
    };
  }
}

module.exports = {
  ClockSyncMonitor,
  DEFAULT_CLOCK_SYNC_OPTIONS,
  defaultCheckClock,
  parseChronycTracking,
  parseTimedatectlOutput
};
