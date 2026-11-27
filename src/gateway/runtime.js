"use strict";

const { EventEmitter } = require("node:events");
const { calculateOee, toMillis } = require("../analytics/oee");
const { analyzeRca } = require("../analytics/rca");
const { OpcUaGatewayClient } = require("./opcua-client");
const { ProcessContextCollector } = require("./process-context");
const { QualityEventNotFoundError, QualityEventStore } = require("./quality-events");
const { createGatewayApi } = require("./http-api");

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
        logger: this.logger
      });
    this.qualityEvents =
      dependencies.qualityEvents ||
      new QualityEventStore({
        ...config.identity,
        ...config.quality
      });
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
      await this.client.stop();
      this._started = false;
    } finally {
      this._stopping = false;
    }
  }

  getStatus() {
    const latest = this.collector.getLatest();
    return {
      status: this._started && this.client.isConnected ? "ok" : "degraded",
      opcuaConnected: Boolean(this.client.isConnected),
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(this.startedAt)) / 1000))
        : 0,
      identity: {
        lineId: this.config.identity.lineId,
        stationId: this.config.identity.stationId,
        workOrderId: this.config.identity.workOrderId || null,
        serialNumber: this.config.identity.serialNumber || null
      },
      context: {
        eventCount: this.collector.eventCount,
        alarmCount: this.collector.alarmCount,
        latestOccurredAt: latest?.occurredAt || null
      },
      quality: {
        eventCount: this.qualityEvents.count
      }
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

  setCorrelationId(correlationId) {
    this.collector.setCorrelationId(correlationId);
    return this.collector.options.correlationId;
  }

  recordQualityEvent(input) {
    return this.qualityEvents.record(input);
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

    const events = this.collector.getEvents({ from, to });
    const qualityEvents = this.qualityEvents.list({ from, to });
    const qualityEventNgCount = qualityEvents.reduce(
      (total, qualityEvent) => total + qualityEvent.quantity,
      0
    );
    const analyticsOptions = {
      nominalOutputPerMinute: this.config.analytics.nominalOutputPerMinute
    };
    if (options.ngCount !== undefined) {
      analyticsOptions.ngCount = options.ngCount;
    } else {
      analyticsOptions.ngCount = qualityEventNgCount;
    }

    const result = calculateOee(events, analyticsOptions);
    result.qualitySource = options.ngCount === undefined ? "quality-events" : "query";
    result.qualityEventCount = qualityEvents.length;
    result.qualityEventQuantity = qualityEventNgCount;
    if (options.ngCount === undefined && qualityEvents.length === 0) {
      result.warnings.push(
        "No NG quality events were recorded in the window; verify the quality-event feed is connected."
      );
    }

    return {
      range: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        windowMs
      },
      eventCount: events.length,
      ...result
    };
  }

  analyzeRca(options = {}) {
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
    const result = analyzeRca(this.collector.getEvents({ from, to }), {
      targetAt,
      windowMs,
      temperatureThresholdC,
      alarms: this.collector.getAlarmHistory({ from, to })
    });
    if (qualityEvent) {
      result.qualityEvent = qualityEvent;
      result.targetQualityEventId = qualityEvent.qualityEventId;
      result.correlationId = qualityEvent.correlationId || null;
    }
    return result;
  }
}

module.exports = {
  GatewayRuntime
};
