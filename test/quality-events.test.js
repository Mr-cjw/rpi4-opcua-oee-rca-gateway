"use strict";

const assert = require("node:assert/strict");
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

test("quality event store prunes old events and their idempotency keys", () => {
  const { store, setNow } = makeStore();
  const old = store.record({ sourceEventId: "QC-OLD", occurredAt: iso(0) });
  setNow(BASE_MS + 121_000);
  store.record({ sourceEventId: "QC-NEW", occurredAt: iso(120) });

  assert.equal(store.get(old.event.qualityEventId), null);
  assert.equal(store.count, 1);
  const replayed = store.record({ sourceEventId: "QC-OLD", occurredAt: iso(120) });
  assert.equal(replayed.duplicate, false);
});
