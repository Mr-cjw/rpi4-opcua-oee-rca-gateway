"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { QualityIdempotencyStore } = require("../src/gateway/quality-idempotency");

test("quality idempotency store atomically saves and loads entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-idempotency-store-"));
  const filePath = path.join(directory, "state", "quality-idempotency.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const entries = [
    {
      schemaVersion: "1.0",
      qualityEventId: "qevt-1",
      sourceEventId: "QC-1",
      eventType: "NG_ORDER",
      result: "NG",
      occurredAt: "2026-11-27T00:00:01.000Z",
      recordedAt: "2026-11-27T00:01:00.000Z",
      lineId: "JX-LINE-01",
      stationId: "JX-LINQIN-STATION-01",
      quantity: 1,
      metadata: {}
    }
  ];
  const store = new QualityIdempotencyStore(filePath);
  assert.equal(await store.save(entries), true);
  assert.deepEqual(await store.load(), { loaded: true, entries });
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["quality-idempotency.json"]);
});

test("quality idempotency store supports disabled state and rejects corrupt JSON", async (t) => {
  const disabled = new QualityIdempotencyStore(null);
  assert.deepEqual(await disabled.load(), { loaded: false, entries: [] });
  assert.equal(await disabled.save([]), false);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-idempotency-corrupt-"));
  const filePath = path.join(directory, "quality-idempotency.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(filePath, "not-json\n", "utf8");
  await assert.rejects(
    new QualityIdempotencyStore(filePath).load(),
    /not valid JSON/
  );
});
