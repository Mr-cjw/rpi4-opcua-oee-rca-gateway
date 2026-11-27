"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeFileAtomic } = require("../src/gateway/durable-file");

test("atomic state writes preserve the previous file when replacement fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "durable-file-"));
  const filePath = path.join(directory, "state.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(filePath, "old\n", "utf8");
  t.mock.method(fs, "rename", async () => {
    throw new Error("simulated rename failure");
  });

  await assert.rejects(
    writeFileAtomic(filePath, "new\n"),
    /simulated rename failure/
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "old\n");
  assert.deepEqual(await fs.readdir(directory), ["state.json"]);
});

test("atomic state writes replace content with owner-only permissions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "durable-mode-"));
  const filePath = path.join(directory, "state.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await writeFileAtomic(filePath, "new\n", { mode: 0o600 });
  assert.equal(await fs.readFile(filePath, "utf8"), "new\n");
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), ["state.json"]);
});
