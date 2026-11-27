"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PlcDiagnostics,
  isGoodStatus
} = require("../src/gateway/plc-diagnostics");

const START = Date.parse("2026-11-27T10:00:00.000Z");

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function observation(now, overrides = {}) {
  return {
    name: "temperatureSensor",
    nodeId: "ns=1;s=MockPLC.TemperatureSensor",
    value: 24.5,
    statusCode: "Good (0x00000000)",
    sourceTimestamp: iso(now),
    serverTimestamp: iso(now),
    ...overrides
  };
}

test("PLC diagnostics detects stale, bad, uncertain, future, and skewed values", () => {
  let now = START;
  const diagnostics = new PlcDiagnostics({
    clock: () => now,
    staleWarningMs: 5000,
    clockSkewWarningMs: 1000,
    eventSubscriptionConfigured: true
  });
  diagnostics.recordConnectionAttempt();
  diagnostics.recordConnected({ subscriptionId: 10 });
  diagnostics.recordEventSubscription("active");
  diagnostics.observe(observation(now));
  diagnostics.observe(
    observation(now, {
      name: "alarmEvents",
      nodeId: "ns=1;s=MockPLC.AlarmEvents",
      value: "{\"sequence\":0,\"active\":[]}"
    })
  );

  let status = diagnostics.getStatus();
  assert.equal(status.status, "ok");
  assert.equal(status.healthy, true);
  assert.equal(status.variables[0].issues.length, 0);

  now += 6000;
  status = diagnostics.getStatus();
  assert.equal(status.status, "warning");
  assert.equal(status.summary.staleValues, 1);
  assert.ok(status.variables[0].issues.includes("stale_value"));

  diagnostics.observe(
    observation(now, { statusCode: "Bad (0x80340000)", value: null })
  );
  status = diagnostics.getStatus();
  assert.equal(status.status, "critical");
  assert.equal(status.summary.badValues, 1);
  assert.ok(status.variables[0].issues.includes("bad_status"));

  diagnostics.observe(
    observation(now, { statusCode: "Uncertain (0x40920000)" })
  );
  status = diagnostics.getStatus();
  assert.equal(status.status, "warning");
  assert.equal(status.summary.uncertainValues, 1);
  assert.ok(status.variables[0].issues.includes("uncertain_status"));

  diagnostics.observe(
    observation(now, {
      sourceTimestamp: iso(now + 2000),
      serverTimestamp: iso(now)
    })
  );
  status = diagnostics.getStatus();
  assert.equal(status.status, "warning");
  assert.equal(status.summary.futureTimestampValues, 1);
  assert.equal(status.summary.clockSkewValues, 1);
  assert.ok(status.variables[0].issues.includes("future_source_timestamp"));
  assert.ok(status.variables[0].issues.includes("source_server_clock_skew"));

  diagnostics.observe(
    observation(now, {
      sourceTimestamp: null,
      serverTimestamp: null
    })
  );
  status = diagnostics.getStatus();
  assert.ok(status.variables[0].issues.includes("missing_source_timestamp"));
});

test("PLC diagnostics tracks reconnect gaps and event-subscription recovery", () => {
  let now = START;
  const diagnostics = new PlcDiagnostics({
    clock: () => now,
    eventSubscriptionConfigured: true
  });
  diagnostics.recordConnectionAttempt();
  diagnostics.recordConnected({ subscriptionId: 10 });
  diagnostics.recordEventSubscription("active");
  diagnostics.observe(observation(now));

  now += 2000;
  diagnostics.recordDisconnected("network lost");
  let status = diagnostics.getStatus();
  assert.equal(status.status, "critical");
  assert.equal(status.connection.disconnectedAt, iso(now));
  assert.equal(status.eventSubscription.status, "unavailable");
  assert.equal(status.connection.currentGapMs, 0);

  now += 3000;
  status = diagnostics.getStatus();
  assert.equal(status.connection.currentGapMs, 3000);

  diagnostics.recordConnectionAttempt();
  diagnostics.recordConnected({ subscriptionId: 11 });
  diagnostics.recordEventSubscription("active");
  diagnostics.observe(observation(now));
  status = diagnostics.getStatus();
  assert.equal(status.status, "ok");
  assert.equal(status.connection.reconnectCount, 1);
  assert.equal(status.connection.lastReconnectGapMs, 3000);
  assert.equal(status.connection.maxReconnectGapMs, 3000);
  assert.equal(status.connection.totalReconnectGapMs, 3000);
  assert.equal(status.connection.failures, 0);
  assert.equal(status.eventSubscription.recoveries, 1);
});

test("PLC diagnostics exposes connection failures and disabled event subscription", () => {
  const diagnostics = new PlcDiagnostics({
    clock: () => START,
    eventSubscriptionConfigured: false
  });
  diagnostics.recordConnectionAttempt();
  diagnostics.recordConnectionFailure(new Error("connect refused"));
  const status = diagnostics.getStatus();
  assert.equal(status.status, "critical");
  assert.equal(status.connection.attempts, 1);
  assert.equal(status.connection.failures, 1);
  assert.equal(status.connection.lastError, "connect refused");
  assert.equal(status.eventSubscription.status, "disabled");
  assert.equal(isGoodStatus("Good (0x00000000)"), true);
  assert.equal(isGoodStatus("GoodClamped (0x00300000)"), true);
  assert.equal(isGoodStatus("Bad (0x80340000)"), false);
});
