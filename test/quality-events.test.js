"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  QualityEventStore,
  QualityEventValidationError
} = require("../src/gateway/quality-events");
const qualityEventSchema = require("../contracts/quality-event.schema.json");

const BASE_MS = Date.parse("2026-11-27T00:00:00.000Z");

function iso(seconds) {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function makeStore(overrides = {}) {
  let now = BASE_MS + 60_000;
  let id = 0;
  const store = new QualityEventStore({
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    workOrderId: "WO-DEFAULT",
    serialNumber: "SN-DEFAULT",
    retentionMs: 60_000,
    maxEvents: 10,
    clock: () => now,
    createId: () => `qevt-${++id}`,
    ...overrides
  });
  return {
    store,
    setNow(value) {
      now = value;
    }
  };
}

test("quality event store creates a versioned, idempotent NG event", () => {
  const { store } = makeStore();
  const first = store.record({
    sourceEventId: "QC-001",
    occurredAt: iso(10),
    correlationId: "corr-001",
    defectType: "DENT",
    confidence: 0.97,
    metadata: { imageId: "IMG-001" }
  });

  assert.equal(first.duplicate, false);
  assert.equal(first.event.schemaVersion, "1.0");
  assert.equal(first.event.qualityEventId, "qevt-1");
  assert.equal(first.event.result, "NG");
  assert.equal(first.event.eventType, "NG_ORDER");
  assert.equal(first.event.lineId, "JX-LINE-01");
  assert.equal(first.event.stationId, "JX-LINQIN-STATION-01");
  assert.equal(first.event.workOrderId, "WO-DEFAULT");
  assert.equal(first.event.serialNumber, "SN-DEFAULT");
  assert.equal(first.event.quantity, 1);
  assert.equal(first.event.confidence, 0.97);
  assert.deepEqual(first.event.metadata, { imageId: "IMG-001" });
  for (const field of qualityEventSchema.required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(first.event, field),
      `missing contract field ${field}`
    );
  }

  const duplicate = store.record({
    sourceEventId: "QC-001",
    occurredAt: iso(10)
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.retained, true);
  assert.equal(duplicate.event.qualityEventId, first.event.qualityEventId);
  assert.equal(store.count, 1);
});

test("quality event store rejects unsafe or malformed input", () => {
  const { store } = makeStore();

  assert.throws(
    () => store.record({ occurredAt: iso(1) }),
    (error) => error instanceof QualityEventValidationError && /sourceEventId/.test(error.message)
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-2", result: "OK" }),
    /only NG/
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-3", lineId: "OTHER-LINE" }),
    /does not match gateway line/
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-4", stationId: "OTHER-STATION" }),
    /does not match gateway station/
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-5", quantity: 0 }),
    /quantity/
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-6", confidence: 2 }),
    /confidence/
  );
  assert.throws(
    () => store.record({ sourceEventId: "QC-7", occurredAt: "not-a-timestamp" }),
    (error) => error instanceof QualityEventValidationError && error.statusCode === 400
  );
});

test("quality event defaults follow runtime work context updates", () => {
  const { store } = makeStore();
  store.setWorkContext({
    workOrderId: "WO-NEXT",
    serialNumber: "SN-NEXT",
    correlationId: "corr-next"
  });

  const inherited = store.record({ sourceEventId: "QC-CONTEXT-1" });
  assert.equal(inherited.event.workOrderId, "WO-NEXT");
  assert.equal(inherited.event.serialNumber, "SN-NEXT");
  assert.equal(inherited.event.correlationId, "corr-next");

  const explicit = store.record({
    sourceEventId: "QC-CONTEXT-2",
    workOrderId: "WO-EXPLICIT",
    serialNumber: "SN-EXPLICIT",
    correlationId: "corr-explicit"
  });
  assert.equal(explicit.event.workOrderId, "WO-EXPLICIT");
  assert.equal(explicit.event.serialNumber, "SN-EXPLICIT");
  assert.equal(explicit.event.correlationId, "corr-explicit");

  store.setWorkContext({ workOrderId: null, serialNumber: "", correlationId: null });
  const cleared = store.record({ sourceEventId: "QC-CONTEXT-3" });
  assert.equal(Object.hasOwn(cleared.event, "workOrderId"), false);
  assert.equal(Object.hasOwn(cleared.event, "serialNumber"), false);
  assert.equal(Object.hasOwn(cleared.event, "correlationId"), false);
  assert.throws(
    () => store.setWorkContext({ serialNumber: false }),
    (error) => error.statusCode === 400 && /serialNumber/.test(error.message)
  );
});

test("quality event store filters by occurrence time and sums quantity", () => {
  const { store } = makeStore();
  store.record({ sourceEventId: "QC-1", occurredAt: iso(0), quantity: 2 });
  store.record({ sourceEventId: "QC-2", occurredAt: iso(5), quantity: 3 });
  store.record({ sourceEventId: "QC-3", occurredAt: iso(10), quantity: 1 });

  assert.equal(store.list().length, 3);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.deepEqual(
    store.list({ from: iso(4), to: iso(9) }).map((event) => event.sourceEventId),
    ["QC-2"]
  );
  assert.equal(store.quantity({ from: iso(4), to: iso(9) }), 3);
});

test("quality event store filters by work order and correlation ID", () => {
  const { store } = makeStore();
  store.record({
    sourceEventId: "QC-WO-A",
    occurredAt: iso(1),
    workOrderId: "WO-A",
    correlationId: "corr-a",
    quantity: 2
  });
  store.record({
    sourceEventId: "QC-WO-B",
    occurredAt: iso(2),
    workOrderId: "WO-B",
    correlationId: "corr-b",
    quantity: 3
  });

  assert.equal(store.list({ workOrderId: "WO-A" }).length, 1);
  assert.equal(store.list({ correlationId: "corr-b" }).length, 1);
  assert.equal(store.quantity({ workOrderId: "WO-A" }), 2);
  assert.equal(store.list({ workOrderId: "WO-A", correlationId: "corr-b" }).length, 0);
});

test("quality idempotency survives event retention and restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-idempotency-"));
  const eventLogPath = path.join(directory, "quality-events.jsonl");
  const idempotencyPath = path.join(directory, "quality-idempotency.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const first = makeStore({
    eventLogPath,
    idempotencyPath,
    clock: () => BASE_MS + 60_000
  });
  const original = first.store.record({
    sourceEventId: "QC-DURABLE",
    occurredAt: iso(1),
    quantity: 2
  });
  await first.store.flush();

  const ledger = JSON.parse(await fs.readFile(idempotencyPath, "utf8"));
  assert.equal(ledger.schemaVersion, "1.0");
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].sourceEventId, "QC-DURABLE");

  const second = makeStore({
    eventLogPath,
    idempotencyPath,
    clock: () => BASE_MS + 130_000
  });
  const loaded = await second.store.load();
  assert.equal(loaded.retained, 0);
  assert.equal(loaded.idempotencyLoaded, 1);

  const duplicate = second.store.record({
    sourceEventId: "QC-DURABLE",
    occurredAt: iso(120),
    quantity: 2
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.retained, false);
  assert.equal(duplicate.event.qualityEventId, original.event.qualityEventId);
  assert.equal(duplicate.event.sourceEventId, "QC-DURABLE");
  assert.equal(second.store.count, 0);
  assert.equal(second.store.quantity(), 0);
});

test("quality idempotency expires at its configured horizon", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-idempotency-expiry-"));
  const eventLogPath = path.join(directory, "quality-events.jsonl");
  const idempotencyPath = path.join(directory, "quality-idempotency.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const first = makeStore({
    eventLogPath,
    idempotencyPath,
    idempotencyRetentionMs: 60_000,
    clock: () => BASE_MS + 60_000
  });
  const original = first.store.record({
    sourceEventId: "QC-EXPIRED",
    occurredAt: iso(1),
    quantity: 1
  });
  await first.store.flush();

  const second = makeStore({
    eventLogPath,
    idempotencyPath,
    idempotencyRetentionMs: 60_000,
    clock: () => BASE_MS + 200_000,
    createId: (() => {
      let id = 0;
      return () => `qevt-second-${++id}`;
    })()
  });
  await second.store.load();
  const replayed = second.store.record({
    sourceEventId: "QC-EXPIRED",
    occurredAt: iso(190),
    quantity: 1
  });
  assert.equal(replayed.duplicate, false);
  assert.notEqual(replayed.event.qualityEventId, original.event.qualityEventId);
  assert.equal(second.store.count, 1);
});

test("quality event store prunes old events but keeps idempotency keys", () => {
  const { store, setNow } = makeStore();
  const old = store.record({ sourceEventId: "QC-OLD", occurredAt: iso(0) });
  setNow(BASE_MS + 121_000);
  store.record({ sourceEventId: "QC-NEW", occurredAt: iso(120) });

  assert.equal(store.get(old.event.qualityEventId), null);
  assert.equal(store.count, 1);
  const replayed = store.record({ sourceEventId: "QC-OLD", occurredAt: iso(120) });
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.retained, false);
  assert.equal(replayed.event.qualityEventId, old.event.qualityEventId);
  assert.equal(store.count, 1);
});

test("quality event store replays JSONL and keeps idempotency across restarts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-events-replay-"));
  const logPath = path.join(directory, "quality-events.jsonl");
  const first = makeStore({ eventLogPath: logPath });
  t.after(async () => {
    await first.store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });

  first.store.record({ sourceEventId: "QC-1", occurredAt: iso(1), quantity: 2 });
  first.store.record({ sourceEventId: "QC-2", occurredAt: iso(2), quantity: 3 });
  await first.store.flush();

  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  await fs.appendFile(logPath, `${lines[0]}\nnot-json\n`, "utf8");

  const second = makeStore({ eventLogPath: logPath });
  const result = await second.store.load();
  assert.equal(result.loaded, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.retained, 2);
  assert.equal(second.store.count, 2);
  assert.equal(second.store.quantity(), 5);

  const duplicate = second.store.record({ sourceEventId: "QC-1", occurredAt: iso(3) });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.sourceEventId, "QC-1");

  const again = await second.store.load();
  assert.equal(again.alreadyLoaded, true);
});
