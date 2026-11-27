"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JsonlLog } = require("../src/gateway/jsonl");

test("JSONL log rotates by size and replays retained backups in order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-rotation-"));
  const logPath = path.join(directory, "events.jsonl");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const lineBytes = Buffer.byteLength(`${JSON.stringify({ value: 0 })}\n`, "utf8");
  const log = new JsonlLog(logPath, {
    maxBytes: lineBytes * 2,
    maxFiles: 2
  });
  for (let value = 1; value <= 7; value += 1) {
    log.append({ value });
  }
  await log.flush();

  const records = [];
  const result = await log.read((record) => records.push(record.value));
  assert.deepEqual(records, [3, 4, 5, 6, 7]);
  assert.equal(result.records, 5);
  assert.equal(result.corrupt, 0);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "events.jsonl",
    "events.jsonl.1",
    "events.jsonl.2"
  ]);
});

test("JSONL log can disable rotation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-unlimited-"));
  const logPath = path.join(directory, "events.jsonl");
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const log = new JsonlLog(logPath, { maxBytes: 0, maxFiles: 0 });
  for (let value = 1; value <= 3; value += 1) {
    log.append({ value });
  }
  await log.flush();

  const records = [];
  await log.read((record) => records.push(record.value));
  assert.deepEqual(records, [1, 2, 3]);
  assert.deepEqual(await fs.readdir(directory), ["events.jsonl"]);
});

test("JSONL log isolates a partial trailing record after a crash", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-partial-"));
  const logPath = path.join(directory, "events.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(logPath, '{"value":1}\n{"value":', "utf8");

  const log = new JsonlLog(logPath);
  log.append({ value: 2 });
  await log.flush({ throwOnError: true });

  const records = [];
  const result = await log.read((record) => records.push(record.value));
  assert.deepEqual(records, [1, 2]);
  assert.equal(result.corrupt, 1);
  assert.equal(log.getStatus().recoveredPartialLines, 1);
  assert.equal(log.getStatus().status, "ok");
});

test("JSONL fsync mode recovers after a durability-barrier failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-fsync-"));
  const logPath = path.join(directory, "events.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const originalOpen = fs.open;
  let syncCalls = 0;
  let failSync = true;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    const handle = await originalOpen.call(fs, filePath, flags, mode);
    if (flags !== "a") {
      return handle;
    }
    return {
      writeFile: (...args) => handle.writeFile(...args),
      sync: async () => {
        syncCalls += 1;
        if (failSync) {
          throw new Error("simulated fsync failure");
        }
        await handle.sync();
      },
      close: () => handle.close()
    };
  });

  const log = new JsonlLog(logPath, { fsync: true, maxBytes: 0, maxFiles: 0 });
  const failed = await log.append({ value: 1 });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /simulated fsync failure/);
  await assert.rejects(log.flush({ throwOnError: true }), /simulated fsync failure/);
  assert.equal(log.getStatus().status, "critical");
  assert.equal(log.getStatus().fsync, true);

  failSync = false;
  await log.append({ value: 2 });
  await log.flush({ throwOnError: true });
  assert.ok(syncCalls >= 2);
  assert.equal(log.getStatus().status, "ok");

  const records = [];
  await log.read((record) => records.push(record.value));
  assert.deepEqual(records, [1, 2]);
});
