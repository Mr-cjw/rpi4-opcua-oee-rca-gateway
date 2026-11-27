"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { toMillis } = require("../analytics/oee");
const { EventSequenceTracker } = require("./event-sequence");
const { JsonlLog } = require("./jsonl");
const { QualityIdempotencyStore } = require("./quality-idempotency");
const { StorageWriteError } = require("./storage-health");
const {
  matchesWorkContext,
  normalizeWorkContextUpdate,
  workContextFilterFrom,
  workContextFrom
} = require("./work-context");

const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 100000;

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

function compactQualityEvent(event) {
  const compact = {
    schemaVersion: "1.0",
    qualityEventId: event.qualityEventId,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    result: "NG",
    occurredAt: event.occurredAt,
    lineId: event.lineId,
    stationId: event.stationId,
    quantity: event.quantity,
    recordedAt: event.recordedAt,
    metadata: {}
  };
  for (const field of [
    "workOrderId",
    "serialNumber",
    "correlationId",
    "productId",
    "defectType",
    "imageId",
    "source",
    "confidence",
    "sequence"
  ]) {
    if (event[field] !== undefined) {
      compact[field] = event[field];
    }
  }
  return compact;
}

class QualityEventStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      lineId: options.lineId || "LINE-01",
      stationId: options.stationId || "STATION-01",
      workOrderId: options.workOrderId || null,
      serialNumber: options.serialNumber || null,
      correlationId: options.correlationId || null,
      productId: options.productId || null,
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
      eventLogPath: options.eventLogPath || options.logPath || null,
      eventLogMaxBytes: options.eventLogMaxBytes,
      eventLogMaxFiles: options.eventLogMaxFiles,
      onStorageError: options.onStorageError || null,
      onStorageSuccess: options.onStorageSuccess || null,
      onIdempotencyError: options.onIdempotencyError || null,
      onIdempotencySuccess: options.onIdempotencySuccess || null,
      idempotencyPath: options.idempotencyPath || null,
      idempotencyRetentionMs:
        options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS,
      idempotencyMaxEntries:
        options.idempotencyMaxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
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
    if (
      !Number.isInteger(this.options.idempotencyRetentionMs) ||
      this.options.idempotencyRetentionMs < this.options.retentionMs
    ) {
      throw new Error(
        "quality event idempotencyRetentionMs must be an integer >= retentionMs"
      );
    }
    if (
      !Number.isInteger(this.options.idempotencyMaxEntries) ||
      this.options.idempotencyMaxEntries < this.options.maxEvents
    ) {
      throw new Error(
        "quality event idempotencyMaxEntries must be an integer >= maxEvents"
      );
    }

    this._events = [];
    this._bySourceEventId = new Map();
    this._logStore = new JsonlLog(this.options.eventLogPath, {
      logger: this.options.logger,
      maxBytes: this.options.eventLogMaxBytes,
      maxFiles: this.options.eventLogMaxFiles,
      onStorageError: this.options.onStorageError,
      onStorageSuccess: this.options.onStorageSuccess
    });
    this._idempotencyStore = new QualityIdempotencyStore(this.options.idempotencyPath);
    this._idempotencyWrite = Promise.resolve();
    this._idempotencyError = null;
    this._lastIdempotencyFailureAt = null;
    this._lastIdempotencySuccessAt = null;
    this._pendingDurability = new Map();
    this._nextSequence = 1;
    this._sequenceTracker = new EventSequenceTracker({
      stream: "quality",
      clock: this.options.clock
    });
    this._loaded = false;
  }

  get count() {
    return this._events.length;
  }

  getWorkContext() {
    return workContextFrom(this.options);
  }

  setWorkContext(update) {
    Object.assign(this.options, normalizeWorkContextUpdate(update));
    const context = this.getWorkContext();
    this.emit("workContext", context);
    return context;
  }

  record(input) {
    const { logWrite, ...result } = this._record(input);
    return result;
  }

  _record(input, { deferIdempotency = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new QualityEventValidationError("quality event body must be an object");
    }

    const sourceEventId = optionalString(input.sourceEventId, "sourceEventId");
    if (!sourceEventId) {
      throw new QualityEventValidationError("sourceEventId is required for idempotency");
    }
    const existing = this._bySourceEventId.get(sourceEventId);
    if (existing) {
      const retainedEvent = this.get(existing.event.qualityEventId);
      return {
        event: retainedEvent || existing.event,
        duplicate: true,
        retained: Boolean(retainedEvent)
      };
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
      sequence: this._nextSequence,
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

    const correlationId =
      optionalString(input.correlationId, "correlationId") || this.options.correlationId;
    const workOrderId = optionalString(input.workOrderId, "workOrderId") || this.options.workOrderId;
    const serialNumber =
      optionalString(input.serialNumber, "serialNumber") || this.options.serialNumber;
    const productId =
      optionalString(input.productId, "productId") || this.options.productId;
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
    if (productId) {
      event.productId = productId;
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

    this._nextSequence += 1;
    this._events.push(event);
    this._bySourceEventId.set(sourceEventId, {
      event: compactQualityEvent(event),
      recordedAtMs: toMillis(event.recordedAt, "recordedAt")
    });
    this._prune();
    const logWrite = this._logStore.append(event);
    this._observeSequenceAfterWrite(event.sequence, logWrite);
    if (!deferIdempotency) {
      this._scheduleIdempotencyPersist();
    }
    this.emit("event", event);
    return { event, duplicate: false, logWrite };
  }

  async recordDurably(input) {
    const result = this._record(input, { deferIdempotency: true });
    if (result.duplicate) {
      const pending = this._pendingDurability.get(result.event.sourceEventId);
      if (pending) {
        try {
          const persisted = await pending;
          return { event: persisted.event, duplicate: true, retained: true };
        } catch {
          return this.recordDurably(input);
        }
      }
      return result;
    }

    const persistence = this._persistRecordedEvent(result);
    this._pendingDurability.set(result.event.sourceEventId, persistence);
    try {
      return await persistence;
    } finally {
      if (this._pendingDurability.get(result.event.sourceEventId) === persistence) {
        this._pendingDurability.delete(result.event.sourceEventId);
      }
    }
  }

  async _persistRecordedEvent(result) {
    const logResult = await result.logWrite;
    if (!logResult?.ok) {
      this._rollbackRecordedEvent(result.event);
      const error = logResult?.error || new Error("JSONL write did not complete");
      throw new StorageWriteError(`Unable to persist quality event: ${error.message}`, {
        cause: error
      });
    }

    this._scheduleIdempotencyPersist();
    await this._idempotencyWrite;
    return { event: result.event, duplicate: false };
  }

  _rollbackRecordedEvent(event) {
    this._events = this._events.filter(
      (candidate) => candidate.qualityEventId !== event.qualityEventId
    );
    const entry = this._bySourceEventId.get(event.sourceEventId);
    if (entry?.event.qualityEventId === event.qualityEventId) {
      this._bySourceEventId.delete(event.sourceEventId);
    }
  }

  get(qualityEventId) {
    return this._events.find((event) => event.qualityEventId === qualityEventId) || null;
  }

  list(options = {}) {
    const { from, to } = rangeFromOptions(options);
    const filter = workContextFilterFrom(options);
    let events = this._events.filter((event) => {
      const at = toMillis(event.occurredAt, "quality event timestamp");
      return (
        (from === null || at >= from) &&
        (to === null || at <= to) &&
        matchesWorkContext(event, filter)
      );
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
      return {
        loaded: 0,
        skipped: 0,
        retained: this._events.length,
        idempotencyLoaded: 0,
        alreadyLoaded: true
      };
    }
    this._loaded = true;
    let loaded = 0;
    let skipped = 0;
    const seen = new Set();
    const readResult = await this._logStore.read((event) => {
      if (!this._isValidStoredEvent(event)) {
        skipped += 1;
        return;
      }
      if (Number.isInteger(event.sequence)) {
        this._sequenceTracker.observe(event.sequence);
      }
      if (seen.has(event.sourceEventId)) {
        skipped += 1;
        return;
      }
      seen.add(event.sourceEventId);
      this._events.push(event);
      loaded += 1;
    });
    this._nextSequence = Math.max(
      this._nextSequence,
      this._sequenceTracker.getStatus().currentSequence + 1
    );
    this._events.sort(
      (left, right) =>
        toMillis(left.recordedAt, "recordedAt") -
        toMillis(right.recordedAt, "recordedAt")
    );
    this._prune();
    this._bySourceEventId = new Map(
      this._events.map((event) => [
        event.sourceEventId,
        {
          event: compactQualityEvent(event),
          recordedAtMs: toMillis(event.recordedAt, "recordedAt")
        }
      ])
    );
    const idempotencyResult = await this._loadIdempotency();
    this._pruneIdempotency();
    return {
      loaded,
      skipped: skipped + readResult.corrupt,
      retained: this._events.length,
      idempotencyLoaded: idempotencyResult.loaded,
      idempotencySkipped: idempotencyResult.skipped,
      idempotencyError: idempotencyResult.error || null,
      alreadyLoaded: false
    };
  }

  async flush(options = {}) {
    await this._logStore.flush(options);
    await this._idempotencyWrite;
    if (options.throwOnError && this._idempotencyError) {
      throw this._idempotencyError;
    }
  }

  getStorageStatus() {
    return {
      eventLog: this._logStore.getStatus(),
      idempotency: {
        enabled: this._idempotencyStore.enabled,
        status: !this._idempotencyStore.enabled
          ? "disabled"
          : this._idempotencyError
            ? "critical"
            : "ok",
        lastError: this._idempotencyError?.message || null,
        lastFailureAt: this._lastIdempotencyFailureAt,
        lastSuccessAt: this._lastIdempotencySuccessAt
      }
    };
  }

  getSequenceStatus() {
    return this._sequenceTracker.getStatus();
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
      (event.sequence !== undefined &&
        (!Number.isInteger(event.sequence) || event.sequence <= 0)) ||
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
    this._events = this._events.filter((event) => {
      return toMillis(event.recordedAt, "recordedAt") >= cutoff;
    });
    if (this._events.length > this.options.maxEvents) {
      this._events = this._events.slice(-this.options.maxEvents);
    }
    this._pruneIdempotency();
  }

  async _loadIdempotency() {
    if (!this._idempotencyStore.enabled) {
      return { loaded: 0, skipped: 0, error: null };
    }
    let result;
    try {
      result = await this._idempotencyStore.load();
    } catch (error) {
      this._log("warn", "Unable to load quality idempotency state", {
        error: error.message
      });
      return { loaded: 0, skipped: 0, error: error.message };
    }

    let loaded = 0;
    let skipped = 0;
    const entries = [];
    for (const raw of result.entries) {
      if (!this._isValidStoredEvent(raw)) {
        skipped += 1;
        continue;
      }
      if (Number.isInteger(raw.sequence)) {
        this._nextSequence = Math.max(this._nextSequence, raw.sequence + 1);
      }
      entries.push(raw);
    }
    entries.sort(
      (left, right) =>
        toMillis(left.recordedAt, "recordedAt") -
        toMillis(right.recordedAt, "recordedAt")
    );
    for (const event of entries) {
      if (this._bySourceEventId.has(event.sourceEventId)) {
        continue;
      }
      this._bySourceEventId.set(event.sourceEventId, {
        event: compactQualityEvent(event),
        recordedAtMs: toMillis(event.recordedAt, "recordedAt")
      });
      loaded += 1;
    }
    return { loaded, skipped, error: null };
  }

  _pruneIdempotency() {
    const cutoff = this.options.clock() - this.options.idempotencyRetentionMs;
    for (const [sourceEventId, entry] of this._bySourceEventId) {
      if (entry.recordedAtMs < cutoff) {
        this._bySourceEventId.delete(sourceEventId);
      }
    }
    while (this._bySourceEventId.size > this.options.idempotencyMaxEntries) {
      const oldest = this._bySourceEventId.keys().next().value;
      this._bySourceEventId.delete(oldest);
    }
  }

  _observeSequenceAfterWrite(sequence, logWrite) {
    Promise.resolve(logWrite)
      .then((result) => {
        if (result?.ok) {
          this._sequenceTracker.observe(sequence);
        }
      })
      .catch(() => undefined);
  }

  _scheduleIdempotencyPersist() {
    if (!this._idempotencyStore.enabled) {
      return;
    }
    const entries = [...this._bySourceEventId.values()].map((entry) => entry.event);
    this._idempotencyWrite = this._idempotencyWrite
      .then(async () => {
        await this._idempotencyStore.save(entries);
        this._idempotencyError = null;
        this._lastIdempotencySuccessAt = new Date(this.options.clock()).toISOString();
        if (typeof this.options.onIdempotencySuccess === "function") {
          this.options.onIdempotencySuccess();
        }
      })
      .catch((error) => {
        this._idempotencyError = error;
        this._lastIdempotencyFailureAt = new Date(this.options.clock()).toISOString();
        if (typeof this.options.onIdempotencyError === "function") {
          this.options.onIdempotencyError(error, { component: "quality-idempotency" });
        }
        this._log("error", "Unable to persist quality idempotency state", {
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
        module: "quality-events",
        message,
        ...data
      });
    }
  }
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  DEFAULT_RETENTION_MS,
  QualityEventNotFoundError,
  QualityEventStore,
  QualityEventValidationError
};
