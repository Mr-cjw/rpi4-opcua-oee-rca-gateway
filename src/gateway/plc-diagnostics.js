"use strict";

const DEFAULT_STALE_WARNING_MS = 300000;
const DEFAULT_CLOCK_SKEW_WARNING_MS = 30000;

function isGoodStatus(statusCode) {
  return typeof statusCode === "string" && statusCode.startsWith("Good");
}

function timestampMs(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(milliseconds) {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

class PlcDiagnostics {
  constructor(options = {}) {
    this.clock = options.clock || (() => Date.now());
    this.staleWarningMs = options.staleWarningMs ?? DEFAULT_STALE_WARNING_MS;
    this.clockSkewWarningMs =
      options.clockSkewWarningMs ?? DEFAULT_CLOCK_SKEW_WARNING_MS;
    this._variables = new Map();
    this._connected = false;
    this._connectedAt = null;
    this._disconnectedAt = null;
    this._lastDisconnectedAt = null;
    this._hasConnected = false;
    this._subscriptionId = null;
    this._valueSubscriptionActive = false;
    this._disconnectReason = null;
    this._connectionAttempts = 0;
    this._connectionFailures = 0;
    this._lastConnectionError = null;
    this._lastConnectionErrorAt = null;
    this._reconnectCount = 0;
    this._lastReconnectGapMs = null;
    this._maxReconnectGapMs = 0;
    this._totalReconnectGapMs = 0;
    this._eventSubscription = {
      status: options.eventSubscriptionConfigured === false ? "disabled" : "unknown",
      error: null,
      failures: 0,
      recoveries: 0,
      activeSince: null
    };
    this._lastEventAt = null;
  }

  recordConnectionAttempt() {
    this._connectionAttempts += 1;
  }

  recordConnected(data = {}) {
    const now = this.clock();
    const gapStart = this._disconnectedAt ?? this._lastDisconnectedAt;
    if (this._hasConnected) {
      this._reconnectCount += 1;
      if (Number.isFinite(gapStart)) {
        const gapMs = Math.max(0, now - gapStart);
        this._lastReconnectGapMs = gapMs;
        this._maxReconnectGapMs = Math.max(this._maxReconnectGapMs, gapMs);
        this._totalReconnectGapMs += gapMs;
      }
    }
    this._hasConnected = true;
    this._connected = true;
    this._connectedAt = now;
    this._disconnectedAt = null;
    this._disconnectReason = null;
    this._subscriptionId = data.subscriptionId ?? null;
    this._valueSubscriptionActive = data.valueSubscriptionActive !== false;
  }

  recordDisconnected(reason) {
    if (!this._connected && this._disconnectedAt !== null) {
      return;
    }
    const now = this.clock();
    if (this._connected) {
      this._disconnectedAt = now;
      this._lastDisconnectedAt = now;
    }
    this._connected = false;
    this._valueSubscriptionActive = false;
    this._disconnectReason = reason ? String(reason) : null;
    if (this._eventSubscription.status === "active") {
      this._eventSubscription.status = "unavailable";
      this._eventSubscription.error = this._disconnectReason;
      this._eventSubscription.activeSince = null;
    }
  }

  recordConnectionFailure(error) {
    this._connectionFailures += 1;
    this._lastConnectionError = error?.message ? String(error.message) : String(error);
    this._lastConnectionErrorAt = this.clock();
  }

  recordValueSubscription(active, subscriptionId = null) {
    this._valueSubscriptionActive = Boolean(active);
    if (subscriptionId !== null) {
      this._subscriptionId = subscriptionId;
    }
    if (!active && this._eventSubscription.status === "active") {
      this._eventSubscription.status = "unavailable";
      this._eventSubscription.error = "value subscription is inactive";
      this._eventSubscription.activeSince = null;
    }
  }

  recordEventSubscription(status, error = null) {
    const previous = this._eventSubscription.status;
    if (status === "active" && previous === "unavailable") {
      this._eventSubscription.recoveries += 1;
    }
    if (status === "unavailable") {
      this._eventSubscription.failures += 1;
    }
    this._eventSubscription.status = status;
    this._eventSubscription.error = error?.message ? String(error.message) : null;
    this._eventSubscription.activeSince =
      status === "active" ? this.clock() : null;
  }

  recordEventReceived() {
    this._lastEventAt = this.clock();
  }

  observe(payload) {
    if (!payload?.name) {
      return;
    }
    const now = this.clock();
    const statusCode = payload.statusCode || null;
    const existing = this._variables.get(payload.name);
    this._variables.set(payload.name, {
      name: payload.name,
      nodeId: payload.nodeId || null,
      statusCode,
      value: payload.value,
      receivedAt: now,
      sourceTimestamp: payload.sourceTimestamp || null,
      serverTimestamp: payload.serverTimestamp || null,
      sourceTimestampMs: timestampMs(payload.sourceTimestamp),
      serverTimestampMs: timestampMs(payload.serverTimestamp),
      firstSeenAt: existing?.firstSeenAt ?? now,
      nonGoodSamples:
        (existing?.nonGoodSamples || 0) + (isGoodStatus(statusCode) ? 0 : 1)
    });
  }

  getStatus() {
    const now = this.clock();
    const variables = [...this._variables.values()].map((variable) =>
      this._variableStatus(variable, now)
    );
    const badValues = variables.filter((variable) => variable.issues.includes("bad_status")).length;
    const uncertainValues = variables.filter((variable) =>
      variable.issues.includes("uncertain_status")
    ).length;
    const staleValues = variables.filter((variable) => variable.stale).length;
    const futureTimestampValues = variables.filter((variable) =>
      variable.issues.includes("future_source_timestamp")
    ).length;
    const clockSkewValues = variables.filter((variable) =>
      variable.issues.includes("source_server_clock_skew")
    ).length;
    const missingSourceTimestampValues = variables.filter((variable) =>
      variable.issues.includes("missing_source_timestamp")
    ).length;

    let status = "ok";
    if (!this._connected || badValues > 0) {
      status = "critical";
    } else if (
      variables.length === 0 ||
      uncertainValues > 0 ||
      staleValues > 0 ||
      futureTimestampValues > 0 ||
      clockSkewValues > 0 ||
      missingSourceTimestampValues > 0 ||
      this._eventSubscription.status === "unavailable" ||
      this._eventSubscription.status === "unknown"
    ) {
      status = "warning";
    }

    const currentGapMs =
      !this._connected && Number.isFinite(this._disconnectedAt)
        ? Math.max(0, now - this._disconnectedAt)
        : 0;
    return {
      status,
      healthy: status === "ok",
      connected: this._connected,
      connection: {
        connectedAt: isoOrNull(this._connectedAt),
        disconnectedAt: isoOrNull(this._disconnectedAt),
        disconnectReason: this._disconnectReason,
        subscriptionId: this._subscriptionId,
        valueSubscriptionActive: this._valueSubscriptionActive,
        attempts: this._connectionAttempts,
        failures: this._connectionFailures,
        lastError: this._lastConnectionError,
        lastErrorAt: isoOrNull(this._lastConnectionErrorAt),
        reconnectCount: this._reconnectCount,
        lastReconnectGapMs: this._lastReconnectGapMs,
        maxReconnectGapMs: this._maxReconnectGapMs,
        totalReconnectGapMs: this._totalReconnectGapMs,
        currentGapMs
      },
      eventSubscription: {
        ...this._eventSubscription,
        activeSince: isoOrNull(this._eventSubscription.activeSince),
        lastEventAt: isoOrNull(this._lastEventAt)
      },
      thresholds: {
        staleWarningMs: this.staleWarningMs,
        clockSkewWarningMs: this.clockSkewWarningMs
      },
      summary: {
        variables: variables.length,
        badValues,
        uncertainValues,
        staleValues,
        futureTimestampValues,
        clockSkewValues,
        missingSourceTimestampValues
      },
      variables
    };
  }

  _variableStatus(variable, now) {
    const issues = [];
    const sourceTimestampMs = variable.sourceTimestampMs;
    const serverTimestampMs = variable.serverTimestampMs;
    const ageMs = Math.max(0, now - variable.receivedAt);
    const sourceAgeMs = Number.isFinite(sourceTimestampMs)
      ? now - sourceTimestampMs
      : null;
    const sourceTimestampFutureMs = Number.isFinite(sourceTimestampMs)
      ? Math.max(0, sourceTimestampMs - now)
      : null;
    const clockSkewMs =
      Number.isFinite(sourceTimestampMs) && Number.isFinite(serverTimestampMs)
        ? Math.abs(serverTimestampMs - sourceTimestampMs)
        : null;

    if (!variable.statusCode) {
      issues.push("missing_status_code");
    } else if (variable.statusCode.startsWith("Bad")) {
      issues.push("bad_status");
    } else if (variable.statusCode.startsWith("Uncertain")) {
      issues.push("uncertain_status");
    }
    if (!Number.isFinite(sourceTimestampMs)) {
      issues.push("missing_source_timestamp");
    } else if (sourceTimestampFutureMs > this.clockSkewWarningMs) {
      issues.push("future_source_timestamp");
    }
    if (Number.isFinite(clockSkewMs) && clockSkewMs > this.clockSkewWarningMs) {
      issues.push("source_server_clock_skew");
    }
    const stale = variable.name !== "alarmEvents" && ageMs > this.staleWarningMs;
    if (stale) {
      issues.push("stale_value");
    }

    return {
      name: variable.name,
      nodeId: variable.nodeId,
      statusCode: variable.statusCode,
      good: isGoodStatus(variable.statusCode),
      status:
        issues.includes("bad_status")
          ? "critical"
          : issues.length > 0
            ? "warning"
            : "ok",
      stale,
      ageMs,
      sourceAgeMs,
      sourceTimestampFutureMs,
      clockSkewMs,
      lastReceivedAt: new Date(variable.receivedAt).toISOString(),
      sourceTimestamp: variable.sourceTimestamp,
      serverTimestamp: variable.serverTimestamp,
      nonGoodSamples: variable.nonGoodSamples,
      issues
    };
  }
}

module.exports = {
  DEFAULT_CLOCK_SKEW_WARNING_MS,
  DEFAULT_STALE_WARNING_MS,
  PlcDiagnostics,
  isGoodStatus,
  timestampMs
};
