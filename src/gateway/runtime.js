"use strict";

const { EventEmitter } = require("node:events");
const { calculateOee, toMillis } = require("../analytics/oee");
const { analyzeRca } = require("../analytics/rca");
const { OpcUaGatewayClient } = require("./opcua-client");
const { ProcessContextCollector } = require("./process-context");
const { QualityEventNotFoundError, QualityEventStore } = require("./quality-events");
const { createGatewayApi } = require("./http-api");
const { WorkContextStore } = require("./work-context-store");
const { workContextFilterFrom } = require("./work-context");
const { StorageMonitor, StorageWriteError } = require("./storage-health");

const defaultLogger = {
  info(record) {
    console.log(JSON.stringify(record));
  },
  warn(record) {
    console.warn(JSON.stringify(record));
  },
  error(record) {
    console.error(JSON.stringify(record));
  }
};

class GatewayRuntime extends EventEmitter {
  constructor(config, dependencies = {}) {
    super();
    if (!config?.endpointUrl) {
      throw new Error("GatewayRuntime requires a gateway config with endpointUrl");
    }
    this.config = config;
    this.logger = config.logger || dependencies.logger || defaultLogger;
    this.storageMonitor =
      dependencies.storageMonitor || new StorageMonitor(config.storage || {});
    this.client =
      dependencies.client ||
      new OpcUaGatewayClient({
        ...config,
        logger: this.logger
      });
    this.collector =
      dependencies.collector ||
      new ProcessContextCollector({
        ...config.identity,
        ...config.context,
        eventLogPath: config.context.logPath,
        eventLogMaxBytes: config.context.logMaxBytes,
        eventLogMaxFiles: config.context.logMaxFiles,
        onStorageError: (error) =>
          this.storageMonitor.recordError("process-context-log", error),
        onStorageSuccess: () =>
          this.storageMonitor.recordSuccess("process-context-log"),
        logger: this.logger
      });
    this.qualityEvents =
      dependencies.qualityEvents ||
      new QualityEventStore({
        ...config.identity,
        ...config.quality,
        eventLogPath: config.quality.logPath,
        idempotencyPath: config.quality.idempotencyPath,
        idempotencyRetentionMs: config.quality.idempotencyRetentionMs,
        idempotencyMaxEntries: config.quality.idempotencyMaxEntries,
        eventLogMaxBytes: config.quality.logMaxBytes,
        eventLogMaxFiles: config.quality.logMaxFiles,
        onStorageError: (error) =>
          this.storageMonitor.recordError("quality-event-log", error),
        onStorageSuccess: () =>
          this.storageMonitor.recordSuccess("quality-event-log"),
        onIdempotencyError: (error) =>
          this.storageMonitor.recordError("quality-idempotency", error),
        onIdempotencySuccess: () =>
          this.storageMonitor.recordSuccess("quality-idempotency"),
        logger: this.logger
      });
    this.workContextStore =
      dependencies.workContextStore ||
      new WorkContextStore(config.workContext?.statePath || null);
    this.api = dependencies.api || null;
    this.startedAt = null;
    this._started = false;
    this._stopping = false;
  }

  async start() {
    if (this._started) {
      return this;
    }
    if (this._stopping) {
      throw new Error("GatewayRuntime is stopping");
    }

    this.startedAt = new Date().toISOString();
    await this.storageMonitor.start();
    await this._loadPersistedState();
    await this._loadWorkContextState();
    if (!this.api) {
      this.api = createGatewayApi(this, {
        ...this.config.api,
        logger: this.logger
      });
    }
    try {
      await this.api.listen();
      await this.client.start();
      this.collector.start(this.client);
    } catch (error) {
      await this.api.close().catch(() => undefined);
      await this.collector.stop().catch(() => undefined);
      await this.client.stop().catch(() => undefined);
      throw error;
    }

    this._started = true;
    this.emit("ready", this.getStatus());
    return this;
  }

  async stop() {
    if (this._stopping) {
      return;
    }
    this._stopping = true;
    try {
      if (this.api) {
        await this.api.close();
      }
      await this.collector.stop();
      await this.qualityEvents.flush();
      await this.client.stop();
      this._started = false;
    } finally {
      this.storageMonitor.stop();
      this._stopping = false;
    }
  }

  getStatus() {
    const latest = this.collector.getLatest();
    const storage = this.storageMonitor.getStatus();
    const healthy =
      this._started && this.client.isConnected && storage.status === "ok";
    return {
      status: healthy ? "ok" : "degraded",
      opcuaConnected: Boolean(this.client.isConnected),
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(this.startedAt)) / 1000))
        : 0,
      identity: {
        lineId: this.config.identity.lineId,
        stationId: this.config.identity.stationId,
        ...this.getWorkContext()
      },
      context: {
        eventCount: this.collector.eventCount,
        alarmCount: this.collector.alarmCount,
        latestOccurredAt: latest?.occurredAt || null
      },
      quality: {
        eventCount: this.qualityEvents.count
      },
      sequences: {
        processContext: this.collector.getSequenceStatus(),
        quality: this.qualityEvents.getSequenceStatus()
      },
      storage
    };
  }

  getLatestContext() {
    return this.collector.getLatest();
  }

  getContextEvents(options = {}) {
    return this.collector.getEvents(options);
  }

  getAlarmHistory(options = {}) {
    return this.collector.getAlarmHistory(options);
  }

  getWorkContext() {
    return this.collector.getWorkContext();
  }

  async updateWorkContext(update) {
    const previousContext = this.collector.getWorkContext();
    const context = this.collector.setWorkContext(update);
    if (typeof this.qualityEvents.setWorkContext === "function") {
      this.qualityEvents.setWorkContext(context);
    }
    try {
      await this.workContextStore.save(context);
      this.storageMonitor.recordSuccess("work-context");
    } catch (error) {
      this.collector.setWorkContext(previousContext);
      if (typeof this.qualityEvents.setWorkContext === "function") {
        this.qualityEvents.setWorkContext(previousContext);
      }
      this.storageMonitor.recordError("work-context", error);
      this._log("error", "Unable to persist work context", { error: error.message });
      throw new StorageWriteError(`Unable to persist work context: ${error.message}`, {
        cause: error
      });
    }
    return context;
  }

  async setCorrelationId(correlationId) {
    return (await this.updateWorkContext({ correlationId })).correlationId;
  }

  async _loadPersistedState() {
    const results = {};
    for (const [name, store] of [
      ["context", this.collector],
      ["quality", this.qualityEvents]
    ]) {
      try {
        results[name] = await store.load();
      } catch (error) {
        results[name] = { error: error.message };
        this._log("warn", `Unable to load persisted ${name} events`, {
          error: error.message
        });
      }
    }
    if (results.context?.loaded || results.quality?.loaded) {
      this._log("info", "Replayed persisted gateway state", {
        contextLoaded: results.context?.loaded || 0,
        contextSkipped: results.context?.skipped || 0,
        qualityLoaded: results.quality?.loaded || 0,
        qualitySkipped: results.quality?.skipped || 0
      });
    }
    return results;
  }

  async _loadWorkContextState() {
    try {
      const result = await this.workContextStore.load();
      if (result.loaded) {
        this.collector.setWorkContext(result.context);
        if (typeof this.qualityEvents.setWorkContext === "function") {
          this.qualityEvents.setWorkContext(result.context);
        }
        this._log("info", "Restored persisted work context", result.context);
      }
      return result;
    } catch (error) {
      this._log("warn", "Unable to restore persisted work context", {
        error: error.message
      });
      return { loaded: false, context: null, error: error.message };
    }
  }

  recordQualityEvent(input) {
    return this.qualityEvents.record(input);
  }

  recordQualityEventDurable(input) {
    return this.qualityEvents.recordDurably(input);
  }

  getQualityEvents(options = {}) {
    return this.qualityEvents.list(options);
  }

  getQualityEvent(qualityEventId) {
    return this.qualityEvents.get(qualityEventId);
  }

  calculateOee(options = {}) {
    const to = options.to === undefined ? Date.now() : toMillis(options.to, "to");
    const windowMs = Number(options.windowMs ?? this.config.analytics.oeeWindowMs);
    const from =
      options.from === undefined
        ? to - windowMs
        : toMillis(options.from, "from");
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive number");
    }
    if (from > to) {
      throw new Error("from must be earlier than or equal to to");
    }

    const scope = workContextFilterFrom(options);
    const events = this.collector.getEvents({ from, to, ...scope });
    const qualityEvents = this.qualityEvents.list({ from, to, ...scope });
    const qualityEventNgCount = qualityEvents.reduce(
      (total, qualityEvent) => total + qualityEvent.quantity,
      0
    );
    const analyticsOptions = {
      nominalOutputPerMinute: this.config.analytics.nominalOutputPerMinute,
      productCycleTimes: this.config.analytics.productCycleTimes,
      plannedTime: this.config.analytics.plannedTime,
      downtimeClassification: this.config.analytics.downtimeClassification,
      qualitySource: options.ngCount === undefined ? "quality-events" : "query",
      qualityEventCount: qualityEvents.length,
      qualityEventQuantity: qualityEventNgCount
    };
    const idealCycleTimeMs =
      options.idealCycleTimeMs !== undefined
        ? options.idealCycleTimeMs
        : this.config.analytics.idealCycleTimeMs;
    if (idealCycleTimeMs !== undefined && idealCycleTimeMs !== null) {
      analyticsOptions.idealCycleTimeMs = idealCycleTimeMs;
      analyticsOptions.idealCycleTimeSource =
        options.idealCycleTimeMs !== undefined ? "query" : "config";
    }
    if (options.ngCount !== undefined) {
      analyticsOptions.ngCount = options.ngCount;
    } else {
      analyticsOptions.ngCount = qualityEventNgCount;
    }

    const result = calculateOee(events, analyticsOptions);
    result.qualitySource = options.ngCount === undefined ? "quality-events" : "query";
    result.qualityEventCount = qualityEvents.length;
    result.qualityEventQuantity = qualityEventNgCount;

    return {
      range: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        windowMs
      },
      eventCount: events.length,
      scope,
      ...result
    };
  }

  analyzeRca(options = {}) {
    const explicitScope = workContextFilterFrom(options);
    const explicitScopeRequested = Boolean(
      explicitScope.workOrderId || explicitScope.correlationId || explicitScope.productId
    );
    let qualityEvent = null;
    let targetAt;
    if (options.qualityEventId) {
      qualityEvent = this.qualityEvents.get(options.qualityEventId);
      if (!qualityEvent) {
        throw new QualityEventNotFoundError(options.qualityEventId);
      }
      targetAt = toMillis(qualityEvent.occurredAt, "quality event occurredAt");
    } else {
      targetAt = toMillis(options.targetAt ?? Date.now(), "targetAt");
    }
    const windowMs = Number(options.windowMs ?? this.config.analytics.rcaWindowMs);
    const temperatureThresholdC = Number(
      options.temperatureThresholdC ?? this.config.analytics.temperatureThresholdC
    );
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive number");
    }

    const from = targetAt - windowMs;
    const to = targetAt + windowMs;
    const scope = qualityEvent
      ? {
          workOrderId: explicitScope.workOrderId || qualityEvent.workOrderId || null,
          correlationId:
            explicitScope.correlationId || qualityEvent.correlationId || null
        }
      : {
          workOrderId: explicitScope.workOrderId,
          correlationId: explicitScope.correlationId
        };
    const scopeProductId = explicitScope.productId || qualityEvent?.productId || null;
    if (scopeProductId) {
      scope.productId = scopeProductId;
    }
    const scopeRequested = Boolean(
      scope.workOrderId || scope.correlationId || scope.productId
    );
    let events = this.collector.getEvents({ from, to, ...scope });
    let alarms = this.collector.getAlarmHistory({ from, to, ...scope });
    let scopeApplied = scopeRequested;
    let scopeFallback = false;
    if (
      scopeRequested &&
      !explicitScopeRequested &&
      events.length === 0 &&
      alarms.length === 0
    ) {
      events = this.collector.getEvents({ from, to });
      alarms = this.collector.getAlarmHistory({ from, to });
      scopeApplied = false;
      scopeFallback = true;
    }

    const result = analyzeRca(events, {
      targetAt,
      windowMs,
      temperatureThresholdC,
      alarms
    });
    result.scope = scope;
    result.scopeApplied = scopeApplied;
    if (scopeFallback) {
      result.warnings = [
        ...(result.warnings || []),
        "No process context or alarms matched the quality event work context; RCA fell back to the unscoped time window."
      ];
    }
    if (qualityEvent) {
      result.qualityEvent = qualityEvent;
      result.targetQualityEventId = qualityEvent.qualityEventId;
      result.correlationId = qualityEvent.correlationId || null;
    }
    return result;
  }

  _log(level, message, data = {}) {
    const method = this.logger?.[level] || this.logger?.info;
    if (typeof method === "function") {
      method.call(this.logger, {
        timestamp: new Date().toISOString(),
        level,
        module: "gateway-runtime",
        message,
        ...data
      });
    }
  }
}

module.exports = {
  GatewayRuntime
};
