"use strict";

const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { toMillis } = require("../analytics/oee");

const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 10000;

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function unwrap(entry) {
  if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")) {
    return entry.value;
  }
  return entry;
}

function parseAlarmSnapshot(value) {
  if (value && typeof value === "object" && value.alarmSnapshot) {
    return value.alarmSnapshot;
  }
  const payload = unwrap(value);
  if (payload && typeof payload === "object") {
    return payload;
  }
  if (typeof payload !== "string") {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function toIsoTimestamp(value, fallback = new Date()) {
  if (value === undefined || value === null || value === "") {
    return fallback.toISOString();
  }
  return new Date(toMillis(value, "alarm timestamp")).toISOString();
}

function normalizeAlarm(alarm, fallbackAt = new Date()) {
  if (!alarm || typeof alarm !== "object") {
    return null;
  }
  const code = alarm.code || alarm.alarmCode;
  if (!code) {
    return null;
  }
  return {
    eventId: alarm.eventId || null,
    sequence: Number.isInteger(Number(alarm.sequence)) ? Number(alarm.sequence) : null,
    occurredAt: toIsoTimestamp(alarm.occurredAt ?? alarm.time, fallbackAt),
    code: String(code),
    severity: Number.isFinite(Number(alarm.severity)) ? Number(alarm.severity) : null,
    message: alarm.message ? String(alarm.message) : "",
    cause: alarm.cause ? String(alarm.cause) : null,
    deviceStatus: alarm.deviceStatus ? String(alarm.deviceStatus) : null,
    temperatureC: Number.isFinite(Number(alarm.temperatureC))
      ? round(Number(alarm.temperatureC))
      : null,
    currentOutput: Number.isFinite(Number(alarm.currentOutput))
      ? round(Number(alarm.currentOutput))
      : null,
    goodCount: Number.isFinite(Number(alarm.goodCount)) ? Number(alarm.goodCount) : null
  };
}

function parseTimeRange(options = {}) {
  return {
    from: options.from === undefined ? null : toMillis(options.from, "from"),
    to: options.to === undefined ? null : toMillis(options.to, "to")
  };
}

class ProcessContextCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.lineId) {
      throw new Error("ProcessContextCollector requires a lineId");
    }
    if (!options.stationId) {
      throw new Error("ProcessContextCollector requires a stationId");
    }

    this.options = {
      lineId: options.lineId,
      stationId: options.stationId,
      workOrderId: options.workOrderId || null,
      serialNumber: options.serialNumber || null,
      source: options.source || "rpi4-gateway",
      sampleIntervalMs: options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
      eventLogPath: options.eventLogPath || null,
      correlationId: options.correlationId || null,
      clock: options.clock || (() => Date.now()),
      createId: options.createId || randomUUID,
      logger: options.logger || null
    };
    if (
      !Number.isInteger(this.options.sampleIntervalMs) ||
      this.options.sampleIntervalMs < 50
    ) {
      throw new Error("sampleIntervalMs must be an integer >= 50");
    }
    if (!Number.isInteger(this.options.retentionMs) || this.options.retentionMs <= 0) {
      throw new Error("retentionMs must be a positive integer");
    }
    if (!Number.isInteger(this.options.maxEvents) || this.options.maxEvents < 2) {
      throw new Error("maxEvents must be an integer >= 2");
    }

    this._events = [];
    this._alarmHistory = [];
    this._latest = null;
    this._client = null;
    this._timer = null;
    this._onAlarm = null;
    this._writeQueue = Promise.resolve();
  }

  get eventCount() {
    return this._events.length;
  }

  get alarmCount() {
    return this._alarmHistory.length;
  }

  setCorrelationId(correlationId) {
    this.options.correlationId = correlationId || null;
  }

  getLatest() {
    return this._latest;
  }

  getEvents(options = {}) {
    const { from, to } = parseTimeRange(options);
    let events = this._events.filter((event) => {
      const at = toMillis(event.occurredAt, "event timestamp");
      return (from === null || at >= from) && (to === null || at <= to);
    });
    const limit = Number(options.limit ?? 0);
    if (Number.isInteger(limit) && limit > 0) {
      events = events.slice(-limit);
    }
    return events;
  }

  getAlarmHistory(options = {}) {
    const { from, to } = parseTimeRange(options);
    let alarms = this._alarmHistory.filter((alarm) => {
      const at = toMillis(alarm.occurredAt, "alarm timestamp");
      return (from === null || at >= from) && (to === null || at <= to);
    });
    const limit = Number(options.limit ?? 0);
    if (Number.isInteger(limit) && limit > 0) {
      alarms = alarms.slice(-limit);
    }
    return alarms;
  }

  capture(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    const deviceStatusRaw = unwrap(snapshot.deviceStatus);
    const currentOutput = Number(unwrap(snapshot.currentOutput));
    const goodCount = Number(unwrap(snapshot.goodCount));
    const temperatureC = Number(unwrap(snapshot.temperatureSensor));
    if (
      deviceStatusRaw === undefined ||
      deviceStatusRaw === null ||
      !Number.isFinite(currentOutput) ||
      !Number.isFinite(goodCount) ||
      !Number.isFinite(temperatureC)
    ) {
      this._log("warn", "Skipping incomplete process snapshot", {
        hasDeviceStatus: deviceStatusRaw !== undefined && deviceStatusRaw !== null,
        hasCurrentOutput: Number.isFinite(currentOutput),
        hasGoodCount: Number.isFinite(goodCount),
        hasTemperature: Number.isFinite(temperatureC)
      });
      return null;
    }

    const alarmSnapshot = parseAlarmSnapshot(snapshot.alarmEvents);
    const activeAlarms = Array.isArray(alarmSnapshot?.active)
      ? alarmSnapshot.active.map((alarm) => normalizeAlarm(alarm)).filter(Boolean)
      : [];
    const occurredAt =
      options.occurredAt === undefined
        ? new Date(this.options.clock()).toISOString()
        : toIsoTimestamp(options.occurredAt, new Date(this.options.clock()));
    const metricAlarmSequence = Number.isInteger(Number(alarmSnapshot?.sequence))
      ? Number(alarmSnapshot.sequence)
      : null;
    const event = {
      schemaVersion: "1.0",
      eventId: this.options.createId(),
      source: this.options.source,
      eventType: "PROCESS_CONTEXT",
      occurredAt,
      lineId: this.options.lineId,
      stationId: this.options.stationId,
      metrics: {
        deviceStatus: String(deviceStatusRaw).toUpperCase(),
        currentOutput: round(currentOutput),
        goodCount,
        temperatureC: round(temperatureC),
        alarmSequence: metricAlarmSequence
      },
      alarms: activeAlarms
    };
    const correlationId = options.correlationId ?? this.options.correlationId;
    if (correlationId) {
      event.correlationId = correlationId;
    }
    if (this.options.workOrderId) {
      event.workOrderId = this.options.workOrderId;
    }
    if (this.options.serialNumber) {
      event.serialNumber = this.options.serialNumber;
    }

    this._latest = event;
    this._events.push(event);
    this._prune();
    this._appendEvent(event);
    this.emit("event", event);
    return event;
  }

  recordAlarm(alarm) {
    const normalized = normalizeAlarm(alarm, new Date(this.options.clock()));
    if (!normalized) {
      return null;
    }
    if (
      normalized.eventId &&
      this._alarmHistory.some((existing) => existing.eventId === normalized.eventId)
    ) {
      return null;
    }

    this._alarmHistory.push(normalized);
    this._prune();
    this.emit("alarm", normalized);
    return normalized;
  }

  start(client) {
    if (this._timer) {
      return;
    }
    if (!client || typeof client.getSnapshot !== "function") {
      throw new Error("ProcessContextCollector.start requires an OPC UA client");
    }

    this._client = client;
    const captureFromClient = () => {
      try {
        this.capture(client.getSnapshot());
      } catch (error) {
        this._log("warn", "Unable to capture process context", { error: error.message });
      }
    };
    this._onAlarm = (alarm) => {
      this.recordAlarm(alarm);
      setImmediate(captureFromClient);
    };
    client.on("alarm", this._onAlarm);

    captureFromClient();
    this._timer = setInterval(captureFromClient, this.options.sampleIntervalMs);
    this._timer.unref?.();
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._client && this._onAlarm) {
      this._client.off("alarm", this._onAlarm);
    }
    this._client = null;
    this._onAlarm = null;
    await this._writeQueue;
  }

  async flush() {
    await this._writeQueue;
  }

  _prune() {
    const now = this.options.clock();
    const cutoff = now - this.options.retentionMs;
    this._events = this._events.filter(
      (event) => toMillis(event.occurredAt, "event timestamp") >= cutoff
    );
    if (this._events.length > this.options.maxEvents) {
      this._events = this._events.slice(-this.options.maxEvents);
    }
    this._alarmHistory = this._alarmHistory.filter(
      (alarm) => toMillis(alarm.occurredAt, "alarm timestamp") >= cutoff
    );
    if (this._alarmHistory.length > this.options.maxEvents) {
      this._alarmHistory = this._alarmHistory.slice(-this.options.maxEvents);
    }
  }

  _appendEvent(event) {
    if (!this.options.eventLogPath) {
      return;
    }
    const line = `${JSON.stringify(event)}\n`;
    if (this.options.eventLogPath === "stdout") {
      process.stdout.write(line);
      return;
    }

    const logPath = this.options.eventLogPath;
    this._writeQueue = this._writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.appendFile(logPath, line, "utf8");
      })
      .catch((error) => {
        this._log("error", "Unable to append process context event", {
          path: logPath,
          error: error.message
        });
      });
  }

  _log(level, message, data = {}) {
    if (!this.options.logger) {
      return;
    }
    const method = this.options.logger[level] || this.options.logger.info;
    if (typeof method === "function") {
      method({
        timestamp: new Date().toISOString(),
        level,
        module: "process-context",
        message,
        ...data
      });
    }
  }
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RETENTION_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  ProcessContextCollector,
  normalizeAlarm
};
