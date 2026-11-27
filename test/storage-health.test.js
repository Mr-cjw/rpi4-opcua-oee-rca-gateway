"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JsonlLog } = require("../src/gateway/jsonl");
const { QualityEventStore } = require("../src/gateway/quality-events");
const { StorageMonitor } = require("../src/gateway/storage-health");

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function statfsWithFreeBytes(freeBytes, totalBytes = 1000) {
  return async () => ({
    bsize: 1n,
    blocks: BigInt(totalBytes),
    bavail: BigInt(freeBytes)
  });
}

test("storage monitor reports warning, critical, component failure, and recovery", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storage-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let freeBytes = 80;
  const monitor = new StorageMonitor({
    diskPath: directory,
    warnFreeBytes: 100,
    criticalFreeBytes: 50,
    checkIntervalMs: 0,
    statfs: statfsWithFreeBytes(0, 1000),
    clock: () => NOW
  });
  monitor.statfs = async () => ({
    bsize: 1n,
    blocks: 1000n,
    bavail: BigInt(freeBytes)
  });

  let status = await monitor.checkDisk();
  assert.equal(status.status, "warning");
  assert.equal(status.healthy, false);
  assert.equal(status.disk.freeBytes, 80);

  freeBytes = 25;
  status = await monitor.checkDisk();
  assert.equal(status.status, "critical");
  assert.equal(status.disk.freeBytes, 25);

  monitor.recordError("quality-event-log", new Error("disk full"));
  freeBytes = 500;
  status = await monitor.checkDisk();
  assert.equal(status.status, "critical");
  assert.equal(status.components["quality-event-log"].status, "critical");
  assert.equal(status.components["quality-event-log"].totalFailures, 1);

  monitor.recordSuccess("quality-event-log");
  status = monitor.getStatus();
  assert.equal(status.status, "ok");
  assert.equal(status.healthy, true);
  assert.equal(status.components["quality-event-log"].status, "ok");
});

test("JSONL log exposes write failures and recovers on the next successful write", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-health-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const errors = [];
  const successes = [];
  const unavailable = new JsonlLog(directory, {
    onStorageError: (error) => errors.push(error.message),
    onStorageSuccess: () => successes.push(true)
  });

  unavailable.append({ value: 1 });
  await assert.rejects(unavailable.flush({ throwOnError: true }));
  assert.equal(unavailable.getStatus().status, "critical");
  assert.equal(unavailable.getStatus().totalFailures, 1);
  assert.match(errors[0], /EISDIR/);

  const healthy = new JsonlLog(path.join(directory, "healthy.jsonl"), {
    onStorageError: (error) => errors.push(error.message),
    onStorageSuccess: () => successes.push(true)
  });
  healthy.append({ value: 2 });
  await healthy.flush({ throwOnError: true });
  assert.equal(healthy.getStatus().status, "ok");
  assert.equal(healthy.getStatus().totalWrites, 1);
  assert.ok(successes.length >= 1);
});

test("durable quality ingest rejects an unwritable log and rolls back memory", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-storage-fail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const errors = [];
  const idempotencyPath = path.join(directory, "quality-idempotency.json");
  const store = new QualityEventStore({
    lineId: "LINE-01",
    stationId: "STATION-01",
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath: directory,
    idempotencyPath,
    clock: () => NOW,
    createId: () => "qevt-storage-fail",
    onStorageError: (error) => errors.push(error.message)
  });

  await assert.rejects(
    store.recordDurably({
      sourceEventId: "QC-STORAGE-FAIL",
      occurredAt: new Date(NOW).toISOString()
    }),
    (error) => error.statusCode === 503 && /Unable to persist quality event/.test(error.message)
  );

  assert.equal(store.count, 0);
  assert.equal(store.get("qevt-storage-fail"), null);
  assert.equal(store.getStorageStatus().eventLog.status, "critical");
  assert.ok(errors.length >= 1);
  await assert.rejects(fs.access(idempotencyPath), (error) => error.code === "ENOENT");
});

test("durable quality ingest waits for an in-flight write before confirming a duplicate", async (t) => {
  const { store } = await (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-pending-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return {
      store: new QualityEventStore({
        lineId: "LINE-01",
        stationId: "STATION-01",
        retentionMs: 60_000,
        maxEvents: 10,
        eventLogPath: path.join(directory, "quality-events.jsonl"),
        idempotencyPath: null,
        clock: () => NOW,
        createId: () => "qevt-pending"
      })
    };
  })();
  const write = deferred();
  let appendCalls = 0;
  store._logStore.append = () => {
    appendCalls += 1;
    return write.promise;
  };

  const first = store.recordDurably({
    sourceEventId: "QC-PENDING",
    occurredAt: new Date(NOW).toISOString()
  });
  let duplicateSettled = false;
  const duplicate = store.recordDurably({
    sourceEventId: "QC-PENDING",
    occurredAt: new Date(NOW).toISOString()
  });
  duplicate.then(
    () => {
      duplicateSettled = true;
    },
    () => {
      duplicateSettled = true;
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appendCalls, 1);
  assert.equal(duplicateSettled, false);

  write.resolve({ ok: true, enabled: true, bytes: 1 });
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.duplicate, false);
  assert.equal(duplicateResult.duplicate, true);
  assert.equal(firstResult.event.qualityEventId, duplicateResult.event.qualityEventId);
  assert.equal(store.count, 1);
});

test("quality idempotency failure degrades health without rejecting a persisted event", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-idempotency-fail-"));
  const eventLogPath = path.join(directory, "quality-events.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const idempotencyErrors = [];
  const store = new QualityEventStore({
    lineId: "LINE-01",
    stationId: "STATION-01",
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath,
    idempotencyPath: directory,
    clock: () => NOW,
    createId: () => "qevt-idempotency-fail",
    onIdempotencyError: (error) => idempotencyErrors.push(error.message)
  });

  const result = await store.recordDurably({
    sourceEventId: "QC-IDEMPOTENCY-FAIL",
    occurredAt: new Date(NOW).toISOString()
  });
  await store.flush();

  assert.equal(result.duplicate, false);
  assert.equal(store.count, 1);
  assert.equal(store.getStorageStatus().eventLog.status, "ok");
  assert.equal(store.getStorageStatus().idempotency.status, "critical");
  assert.ok(idempotencyErrors.length >= 1);
  const records = (await fs.readFile(eventLogPath, "utf8")).trim().split("\n");
  assert.equal(records.length, 1);
});

test("a failed durable quality write is visible as a later sequence gap", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-sequence-gap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new QualityEventStore({
    lineId: "LINE-01",
    stationId: "STATION-01",
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath: path.join(directory, "quality-events.jsonl"),
    idempotencyPath: null,
    clock: () => NOW,
    createId: (() => {
      let id = 0;
      return () => `qevt-sequence-${++id}`;
    })()
  });

  await store.recordDurably({
    sourceEventId: "QC-SEQUENCE-1",
    occurredAt: new Date(NOW).toISOString()
  });
  const append = store._logStore.append.bind(store._logStore);
  store._logStore.append = () =>
    Promise.resolve({ ok: false, enabled: true, error: new Error("simulated ENOSPC") });
  await assert.rejects(
    store.recordDurably({
      sourceEventId: "QC-SEQUENCE-2",
      occurredAt: new Date(NOW).toISOString()
    }),
    (error) => error.statusCode === 503
  );
  store._logStore.append = append;
  const third = await store.recordDurably({
    sourceEventId: "QC-SEQUENCE-3",
    occurredAt: new Date(NOW).toISOString()
  });
  await store.flush();

  assert.equal(third.event.sequence, 3);
  const status = store.getSequenceStatus();
  assert.equal(status.currentSequence, 3);
  assert.equal(status.gapsTotal, 1);
  assert.equal(status.missingEvents, 1);
  assert.deepEqual(status.gapRanges, [{ from: 2, to: 2 }]);
});
