"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkContextStore } = require("../src/gateway/work-context-store");

test("work context store atomically saves and loads context", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "work-context-store-"));
  const filePath = path.join(directory, "state", "work-context.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const store = new WorkContextStore(filePath);
  const context = {
    workOrderId: "WO-STORE-001",
    serialNumber: "SN-STORE-001",
    correlationId: "corr-store-001"
  };
  assert.equal(await store.save(context), true);

  assert.deepEqual(await store.load(), { loaded: true, context });
  const files = await fs.readdir(path.dirname(filePath));
  assert.deepEqual(files, ["work-context.json"]);
  const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(stored.workOrderId, "WO-STORE-001");
  assert.equal(stored.schemaVersion, "1.0");
});

test("work context store supports disabled state and rejects corrupt JSON", async (t) => {
  const disabled = new WorkContextStore(null);
  assert.deepEqual(await disabled.load(), { loaded: false, context: null });
  assert.equal(await disabled.save({ workOrderId: "WO-IGNORED" }), false);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "work-context-corrupt-"));
  const filePath = path.join(directory, "work-context.json");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  await fs.writeFile(filePath, "not-json\n", "utf8");
  const store = new WorkContextStore(filePath);
  await assert.rejects(store.load(), /not valid JSON/);
});
