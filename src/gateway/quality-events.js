"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { toMillis } = require("../analytics/oee");
const { JsonlLog } = require("./jsonl");

const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 10000;

class QualityEventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "QualityEventValidationError";
    this.statusCode = 400;
  }
}

class QualityEventNotFoundError extends Error {
  constructor(qualityEventId) {
    super(`quality event not found: ${qualityEventId}`);
    this.name = "QualityEventNotFoundError";
    this.statusCode = 404;
  }
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new QualityEventValidationError(`${field} must be a string`);
  }
  return value;
}

function normalizeQuantity(value) {
  const quantity = value ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new QualityEventValidationError("quantity must be a positive integer");
  }
  return quantity;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new QualityEventValidationError("confidence must be a number between 0 and 1");
  }
  return confidence;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new QualityEventValidationError("metadata must be an object");
  }
  return { ...value };
}

function rangeFromOptions(options = {}) {
  return {
    from: options.from === undefined ? null : toMillis(options.from, "from"),
    to: options.to === undefined ? null : toMillis(options.to, "to")
  };
}

class QualityEventStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      lineId: options.lineId || "LINE-01",
      stationId: options.stationId || "STATION-01",
      workOrderId: options.workOrderId || "",
      serialNumber: options.serialNumber || "",
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
      eventLogPath: options.eventLogPath || options.logPath || null,
      clock: options.clock || (() => Date.now()),
      createId: options.createId || (() => `qevt-${randomUUID()}`),
      logger: options.logger || null
    };
    if (!Number.isInteger(this.options.retentionMs) || this.options.retentionMs <= 0) {
      throw new Error("quality event retentionMs must be a positive integer");
    }
    if (!Number.isInteger(this.options.maxEvents) || this.options.maxEvents < 2) {
      throw new Error("quality event maxEvents must be an integer >= 2");
    }

    this._events = [];
    this._bySourceEventId = new Map();
    this._logStore = new JsonlLog(this.options.eventLogPath, {
      logger: this.options.logger
    });
    this._loaded = false;
  }

  get count() {
    return this._events.length;
  }

  record(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new QualityEventValidationError("quality event body must be an object");
    }

    const sourceEventId = optionalString(input.sourceEventId, "sourceEventId");
    if (!sourceEventId) {
      throw new QualityEventValidationError("sourceEventId is required for idempotency");
    }
    const existing = this._bySourceEventId.get(sourceEventId);
    if (existing) {
      return { event: existing, duplicate: true };
    }

    const result = String(input.result ?? "NG").toUpperCase();
    if (result !== "NG") {
      throw new QualityEventValidationError("only NG quality events are accepted");
    }
    const lineId = optionalString(input.lineId, "lineId") || this.options.lineId;
    const stationId = optionalString(input.stationId, "stationId") || this.options.stationId;
    if (input.lineId && input.lineId !== this.options.lineId) {
      throw new QualityEventValidationError(
        `lineId ${input.lineId} does not match gateway line ${this.options.lineId}`
      );
    }
    if (input.stationId && input.stationId !== this.options.stationId) {
      throw new QualityEventValidationError(
        `stationId ${input.stationId} does not match gateway station ${this.options.stationId}`
      );
    }

    let occurredAt;
    try {
      occurredAt = new Date(
        toMillis(input.occurredAt ?? input.at ?? this.options.clock(), "occurredAt")
      ).toISOString();
    } catch (error) {
      throw new QualityEventValidationError(error.message);
    }
    const event = {
      schemaVersion: "1.0",
      qualityEventId: this.options.createId(),
      sourceEventId,
      eventType: optionalString(input.eventType, "eventType") || "NG_ORDER",
      result: "NG",
      occurredAt,
      lineId,
      stationId,
      quantity: normalizeQuantity(input.quantity),
      recordedAt: new Date(this.options.clock()).toISOString(),
      metadata: normalizeMetadata(input.metadata)
    };

    const correlationId = optionalString(input.correlationId, "correlationId");
    const workOrderId = optionalString(input.workOrderId, "workOrderId") || this.options.workOrderId;
    const serialNumber =
      optionalString(input.serialNumber, "serialNumber") || this.options.serialNumber;
    const defectType = optionalString(input.defectType, "defectType");
    const imageId = optionalString(input.imageId, "imageId");
    const source = optionalString(input.source, "source");
    const confidence = normalizeConfidence(input.confidence);
    if (correlationId) {
      event.correlationId = correlationId;
    }
    if (workOrderId) {
      event.workOrderId = workOrderId;
    }
    if (serialNumber) {
      event.serialNumber = serialNumber;
    }
    if (defectType) {
      event.defectType = defectType;
    }
    if (imageId) {
      event.imageId = imageId;
    }
    if (source) {
      event.source = source;
    }
    if (confidence !== undefined) {
      event.confidence = confidence;
    }

    this._events.push(event);
    this._bySourceEventId.set(sourceEventId, event);
    this._prune();
    this._logStore.append(event);
    this.emit("event", event);
    return { event, duplicate: false };
  }

  get(qualityEventId) {
    return this._events.find((event) => event.qualityEventId === qualityEventId) || null;
  }

  list(options = {}) {
    const { from, to } = rangeFromOptions(options);
    let events = this._events.filter((event) => {
      const at = toMillis(event.occurredAt, "quality event timestamp");
      return (from === null || at >= from) && (to === null || at <= to);
    });
    const limit = Number(options.limit ?? 0);
    if (Number.isInteger(limit) && limit > 0) {
      events = events.slice(-limit);
    }
    return events;
  }

  quantity(options = {}) {
    return this.list(options).reduce((total, event) => total + event.quantity, 0);
  }

  async load() {
    if (this._loaded) {
      return { loaded: 0, skipped: 0, retained: this._events.length, alreadyLoaded: true };
    }
    this._loaded = true;
    let loaded = 0;
    let skipped = 0;
    const seen = new Set();
    const readResult = await this._logStore.read((event) => {
      if (!this._isValidStoredEvent(event) || seen.has(event.sourceEventId)) {
        skipped += 1;
        return;
      }
      seen.add(event.sourceEventId);
      this._events.push(event);
      loaded += 1;
    });
    this._events.sort(
      (left, right) =>
        toMillis(left.recordedAt, "recordedAt") -
        toMillis(right.recordedAt, "recordedAt")
    );
    this._prune();
    this._bySourceEventId = new Map(
      this._events.map((event) => [event.sourceEventId, event])
    );
    return {
      loaded,
      skipped: skipped + readResult.corrupt,
      retained: this._events.length,
      alreadyLoaded: false
    };
  }

  async flush() {
    await this._logStore.flush();
  }

  _isValidStoredEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return false;
    }
    if (
      event.schemaVersion !== "1.0" ||
      event.result !== "NG" ||
      typeof event.qualityEventId !== "string" ||
      event.qualityEventId === "" ||
      typeof event.sourceEventId !== "string" ||
      event.sourceEventId === "" ||
      typeof event.eventType !== "string" ||
      event.eventType === "" ||
      event.lineId !== this.options.lineId ||
      event.stationId !== this.options.stationId ||
      !Number.isInteger(event.quantity) ||
      event.quantity <= 0 ||
      !event.metadata ||
      typeof event.metadata !== "object" ||
      Array.isArray(event.metadata)
    ) {
      return false;
    }
    try {
      toMillis(event.occurredAt, "occurredAt");
      toMillis(event.recordedAt, "recordedAt");
    } catch {
      return false;
    }
    return true;
  }

  _prune() {
    const cutoff = this.options.clock() - this.options.retentionMs;
    const removed = [];
    this._events = this._events.filter((event) => {
      const keep = toMillis(event.recordedAt, "recordedAt") >= cutoff;
      if (!keep) {
        removed.push(event);
      }
      return keep;
    });
    for (const event of removed) {
      this._bySourceEventId.delete(event.sourceEventId);
    }
    if (this._events.length > this.options.maxEvents) {
      const dropped = this._events.slice(0, this._events.length - this.options.maxEvents);
      this._events = this._events.slice(-this.options.maxEvents);
      for (const event of dropped) {
        this._bySourceEventId.delete(event.sourceEventId);
      }
    }
  }
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RETENTION_MS,
  QualityEventNotFoundError,
  QualityEventStore,
  QualityEventValidationError
};
