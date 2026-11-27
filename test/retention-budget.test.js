"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProcessContextCollector } = require("../src/gateway/process-context");
const { QualityEventStore } = require("../src/gateway/quality-events");

const START = Date.parse("2026-11-01T00:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function logBytes(directory, prefix) {
  let total = 0;
  for (const entry of await fs.readdir(directory)) {
    if (entry.startsWith(prefix)) {
      total += (await fs.stat(path.join(directory, entry))).size;
    }
  }
  return total;
}

function snapshot() {
  return {
    deviceStatus: { value: "RUNNING" },
    currentOutput: { value: 120 },
    goodCount: { value: 100 },
    totalProducedCount: { value: 102 },
    temperatureSensor: { value: 24.5 },
    alarmEvents: { alarmSnapshot: { sequence: 0, active: [] } }
  };
}

test("process-context retention and rotation stay bounded across three virtual days", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "retention-context-"));
  const eventLogPath = path.join(directory, "process-context.jsonl");
  const maxBytes = 8192;
  const maxFiles = 2;
  const maxEvents = 45;
  let now = START;
  let id = 0;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const collector = new ProcessContextCollector({
    lineId: "LINE-RETENTION",
    stationId: "STATION-RETENTION",
    sampleIntervalMs: MINUTE,
    retentionMs: HOUR,
    maxEvents,
    eventLogPath,
    eventLogFsync: false,
    eventLogMaxBytes: maxBytes,
    eventLogMaxFiles: maxFiles,
    clock: () => now,
    createId: () => `pcevt-retention-${++id}`
  });

  for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
    now = START + minute * MINUTE;
    collector.capture(snapshot());
    if (minute % 60 === 59) {
      await collector.flush();
      const events = collector.getEvents();
      assert.ok(events.length <= maxEvents);
      assert.ok(Date.parse(events[0].occurredAt) >= now - HOUR);
    }
  }
  await collector.flush();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(collector.getSequenceStatus().currentSequence, 3 * 24 * 60);
  assert.equal(collector.getSequenceStatus().gapsTotal, 0);
  assert.ok(
    (await logBytes(directory, "process-context.jsonl")) <= (maxFiles + 1) * maxBytes
  );

  const replayed = new ProcessContextCollector({
    lineId: "LINE-RETENTION",
    stationId: "STATION-RETENTION",
    sampleIntervalMs: MINUTE,
    retentionMs: HOUR,
    maxEvents,
    eventLogPath,
    eventLogMaxBytes: maxBytes,
    eventLogMaxFiles: maxFiles,
    clock: () => now
  });
  const loaded = await replayed.load();
  assert.equal(loaded.skipped, 0);
  assert.ok(loaded.retained <= maxEvents);
  assert.ok(Date.parse(replayed.getEvents()[0].occurredAt) >= now - HOUR);
});

test("quality retention and idempotency horizon stay bounded across three virtual days", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "retention-quality-"));
  const eventLogPath = path.join(directory, "quality-events.jsonl");
  const idempotencyPath = path.join(directory, "quality-idempotency.json");
  const maxBytes = 8192;
  const maxFiles = 2;
  let now = START;
  let id = 0;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new QualityEventStore({
    lineId: "LINE-RETENTION",
    stationId: "STATION-RETENTION",
    retentionMs: HOUR,
    maxEvents: 10,
    eventLogPath,
    eventLogFsync: false,
    eventLogMaxBytes: maxBytes,
    eventLogMaxFiles: maxFiles,
    idempotencyPath,
    idempotencyRetentionMs: DAY,
    idempotencyMaxEntries: 1000,
    clock: () => now,
    createId: () => `qevt-retention-${++id}`
  });

  for (let step = 0; step < 3 * 24 * 6; step += 1) {
    now = START + step * 10 * MINUTE;
    const sourceEventId = step === 0 ? "QC-RETENTION-START" : `QC-RETENTION-${step}`;
    await store.recordDurably({
      sourceEventId,
      occurredAt: new Date(now).toISOString()
    });
    if (step === 138) {
      assert.equal(
        store.record({
          sourceEventId: "QC-RETENTION-START",
          occurredAt: new Date(now).toISOString()
        }).duplicate,
        true
      );
    }
    if (step === 150) {
      assert.equal(
        store.record({
          sourceEventId: "QC-RETENTION-START",
          occurredAt: new Date(now).toISOString()
        }).duplicate,
        false
      );
    }
    if (step % 144 === 143) {
      assert.ok(store.count <= 10);
      const events = store.list();
      assert.ok(Date.parse(events[0].occurredAt) >= now - HOUR);
    }
  }
  await store.flush();

  assert.ok(
    (await logBytes(directory, "quality-events.jsonl")) <= (maxFiles + 1) * maxBytes
  );
  assert.ok((await fs.stat(idempotencyPath)).size < 512 * 1024);
  assert.equal(store.getSequenceStatus().gapsTotal, 0);

  const reloaded = new QualityEventStore({
    lineId: "LINE-RETENTION",
    stationId: "STATION-RETENTION",
    retentionMs: HOUR,
    maxEvents: 10,
    eventLogPath,
    eventLogMaxBytes: maxBytes,
    eventLogMaxFiles: maxFiles,
    idempotencyPath,
    idempotencyRetentionMs: DAY,
    idempotencyMaxEntries: 1000,
    clock: () => now
  });
  const loaded = await reloaded.load();
  assert.equal(loaded.skipped, 0);
  assert.ok(loaded.retained <= 10);
  assert.ok(Date.parse(reloaded.list()[0].occurredAt) >= now - HOUR);
});
