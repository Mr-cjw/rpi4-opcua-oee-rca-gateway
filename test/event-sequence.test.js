"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventSequenceTracker } = require("../src/gateway/event-sequence");

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

test("event sequence tracker detects gaps, duplicates, and out-of-order events", () => {
  const tracker = new EventSequenceTracker({
    stream: "quality",
    maxGapRanges: 2,
    clock: () => NOW
  });

  assert.equal(tracker.observe(10).action, "baseline");
  assert.equal(tracker.observe(11).action, "ok");
  assert.equal(tracker.observe(14).action, "gap");
  assert.equal(tracker.observe(14).action, "duplicate");
  assert.equal(tracker.observe(12).action, "out_of_order");
  assert.equal(tracker.observe(17).action, "gap");
  assert.equal(tracker.observe(20).action, "gap");

  const status = tracker.getStatus();
  assert.equal(status.stream, "quality");
  assert.equal(status.status, "warning");
  assert.equal(status.currentSequence, 20);
  assert.equal(status.gapsTotal, 3);
  assert.equal(status.missingEvents, 6);
  assert.equal(status.duplicatesTotal, 1);
  assert.equal(status.outOfOrderTotal, 1);
  assert.deepEqual(status.gapRanges, [
    { from: 15, to: 16 },
    { from: 18, to: 19 }
  ]);
  assert.equal(status.lastObservedAt, new Date(NOW).toISOString());
});

test("event sequence tracker ignores invalid values and reports a clean stream", () => {
  const tracker = new EventSequenceTracker({ stream: "process-context" });
  assert.equal(tracker.observe(undefined).action, "ignored");
  assert.equal(tracker.observe(0).action, "ignored");
  assert.equal(tracker.observe(1).action, "baseline");
  assert.equal(tracker.observe(2).action, "ok");
  assert.equal(tracker.getStatus().status, "ok");
  assert.equal(tracker.getStatus().currentSequence, 2);
});
