"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ClockSyncMonitor,
  parseChronycTracking,
  parseTimedatectlOutput
} = require("../src/gateway/clock-sync");

test("clock sync parses timedatectl and chronyc status", () => {
  assert.deepEqual(parseTimedatectlOutput("yes\n"), {
    synchronized: true,
    source: "timedatectl"
  });
  assert.deepEqual(parseTimedatectlOutput("no\n"), {
    synchronized: false,
    source: "timedatectl"
  });
  assert.equal(parseTimedatectlOutput("unknown"), null);

  assert.deepEqual(
    parseChronycTracking(
      [
        "Reference ID    : 1A2B3C4D (time.example.net)",
        "System time     : 0.012500000 seconds fast of NTP time",
        "Leap status     : Normal"
      ].join("\n")
    ),
    {
      synchronized: true,
      source: "chronyc",
      offsetMs: 12.5,
      leapStatus: "Normal"
    }
  );
  assert.deepEqual(
    parseChronycTracking(
      [
        "System time     : 0.250000000 seconds slow of NTP time",
        "Leap status     : Not synchronised"
      ].join("\n")
    ),
    {
      synchronized: false,
      source: "chronyc",
      offsetMs: -250,
      leapStatus: "Not synchronised"
    }
  );
  assert.equal(parseChronycTracking("Leap status : Normal"), null);
});

test("clock sync monitor reports synchronized, unsynchronized, offset, and unknown states", async () => {
  let now = 1_000;
  let result = { synchronized: true, source: "injected", offsetMs: 10 };
  const monitor = new ClockSyncMonitor(
    { checkIntervalMs: 60_000, maxAgeMs: 180_000, maxOffsetMs: 1000, required: true },
    {
      now: () => now,
      checkClock: async () => result
    }
  );

  let status = await monitor.checkNow();
  assert.equal(status.status, "ok");
  assert.equal(status.healthy, true);
  assert.equal(status.synchronized, true);
  assert.equal(status.required, true);
  assert.equal(status.offsetMs, 10);
  assert.equal(status.reason, "synchronized");

  result = { synchronized: false, source: "injected" };
  status = await monitor.checkNow();
  assert.equal(status.status, "warning");
  assert.equal(status.healthy, false);
  assert.equal(status.synchronized, false);
  assert.equal(status.reason, "not_synchronized");

  result = { synchronized: true, source: "injected", offsetMs: 1001 };
  status = await monitor.checkNow();
  assert.equal(status.status, "warning");
  assert.equal(status.reason, "offset_exceeds_limit");

  result = { synchronized: null, source: "unavailable", error: "no provider" };
  status = await monitor.checkNow();
  assert.equal(status.status, "unknown");
  assert.equal(status.synchronized, null);
  assert.equal(status.reason, "unavailable");
  assert.equal(status.error, "no provider");

  result = { synchronized: true, source: "injected" };
  await monitor.checkNow();
  now += 180_001;
  status = monitor.getStatus();
  assert.equal(status.status, "warning");
  assert.equal(status.stale, true);
  assert.equal(status.reason, "check_stale");
});

test("clock sync monitor captures check failures without throwing", async () => {
  const monitor = new ClockSyncMonitor(
    {},
    {
      now: () => 1_000,
      checkClock: async () => {
        throw new Error("timedatectl failed\nsecond line");
      }
    }
  );

  const status = await monitor.checkNow();
  assert.equal(status.status, "unknown");
  assert.equal(status.reason, "check_failed");
  assert.equal(status.source, "error");
  assert.equal(status.error, "timedatectl failed");
  assert.equal(status.required, false);
});
