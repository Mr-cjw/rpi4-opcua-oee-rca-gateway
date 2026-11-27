"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProcessContextCollector } = require("../src/gateway/process-context");
const { QualityEventStore } = require("../src/gateway/quality-events");

const FIXTURE_DIRECTORY = path.join(__dirname, "fixtures", "legacy-jsonl");
const NOW = Date.parse("2026-11-27T00:00:05.000Z");

async function copyFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-legacy-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.cp(FIXTURE_DIRECTORY, directory, { recursive: true });
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "manifest.json"), "utf8")
  );
  return { directory, manifest };
}

test("legacy process-context JSONL fixtures remain replayable", async (t) => {
  const { directory, manifest } = await copyFixture(t);
  const eventLogPath = path.join(directory, "process-context.jsonl");
  const collector = new ProcessContextCollector({
    lineId: manifest.lineId,
    stationId: manifest.stationId,
    workOrderId: "WO-CURRENT",
    sampleIntervalMs: 1000,
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath,
    clock: () => NOW,
    createId: () => "pcevt-current-1"
  });

  const loaded = await collector.load();
  assert.equal(loaded.loaded, manifest.processEvents);
  assert.equal(loaded.skipped, 0);
  assert.equal(loaded.retained, manifest.processEvents);
  assert.equal(collector.getSequenceStatus().currentSequence, 0);

  const current = collector.capture(
    {
      deviceStatus: { value: "RUNNING" },
      currentOutput: { value: 121 },
      goodCount: { value: 101 },
      totalProducedCount: { value: 103 },
      temperatureSensor: { value: 24.4 },
      alarmEvents: { alarmSnapshot: { sequence: 1, active: [] } }
    },
    { occurredAt: "2026-11-27T00:00:05.000Z" }
  );
  assert.equal(current.sequence, 1);
  await collector.flush();

  const replayed = new ProcessContextCollector({
    lineId: manifest.lineId,
    stationId: manifest.stationId,
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath,
    clock: () => NOW,
    createId: () => "pcevt-unused"
  });
  const reloaded = await replayed.load();
  assert.equal(reloaded.loaded, manifest.processEvents + 1);
  assert.equal(replayed.getSequenceStatus().currentSequence, 1);
  assert.equal(replayed.getSequenceStatus().gapsTotal, 0);
});

test("legacy quality JSONL and idempotency fixtures migrate without replaying duplicates", async (t) => {
  const { directory, manifest } = await copyFixture(t);
  const eventLogPath = path.join(directory, "quality-events.jsonl");
  const idempotencyPath = path.join(directory, "quality-idempotency.json");
  const store = new QualityEventStore({
    lineId: manifest.lineId,
    stationId: manifest.stationId,
    workOrderId: "WO-CURRENT",
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath,
    idempotencyPath,
    idempotencyRetentionMs: 600_000,
    idempotencyMaxEntries: 100,
    clock: () => NOW,
    createId: () => "qevt-current-1"
  });

  const loaded = await store.load();
  assert.equal(loaded.loaded, manifest.qualityEvents);
  assert.equal(loaded.skipped, 0);
  assert.equal(loaded.idempotencyLoaded, 1);
  assert.equal(store.quantity(), 4);
  assert.equal(store.getSequenceStatus().currentSequence, 0);

  const archivedDuplicate = store.record({
    sourceEventId: "QC-LEGACY-0",
    occurredAt: "2026-11-27T00:00:04.000Z",
    quantity: 1
  });
  assert.equal(archivedDuplicate.duplicate, true);
  assert.equal(archivedDuplicate.retained, false);
  assert.equal(archivedDuplicate.event.qualityEventId, "qevt-legacy-0");

  const duplicate = store.record({
    sourceEventId: "QC-LEGACY-2",
    occurredAt: "2026-11-27T00:00:04.000Z",
    quantity: 1
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.qualityEventId, "qevt-legacy-2");

  const current = await store.recordDurably({
    sourceEventId: "QC-CURRENT-1",
    occurredAt: "2026-11-27T00:00:05.000Z"
  });
  assert.equal(current.event.sequence, 1);
  await store.flush();

  const replayed = new QualityEventStore({
    lineId: manifest.lineId,
    stationId: manifest.stationId,
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath,
    idempotencyPath,
    idempotencyRetentionMs: 600_000,
    idempotencyMaxEntries: 100,
    clock: () => NOW
  });
  const reloaded = await replayed.load();
  assert.equal(reloaded.loaded, manifest.qualityEvents + 1);
  assert.equal(replayed.getSequenceStatus().currentSequence, 1);
  assert.equal(replayed.getSequenceStatus().gapsTotal, 0);
  assert.equal(replayed.quantity(), 5);
});
