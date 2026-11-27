"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { QualityEventStore } = require("../src/gateway/quality-events");

const HELPER = path.join(__dirname, "helpers", "forced-quality-writer.js");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForSeed(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the forced writer to seed the log"));
    }, 5000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("seeded\n")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`forced writer exited early (${code || signal}): ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function fileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("quality JSONL recovers after a forced kill during a large append", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quality-forced-kill-"));
  const logPath = path.join(directory, "quality-events.jsonl");
  const child = spawn(process.execPath, [HELPER, logPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  await waitForSeed(child);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await fileSize(logPath)) < 256 * 1024) {
    await delay(5);
  }
  assert.ok((await fileSize(logPath)) >= 256 * 1024);

  const exitPromise = waitForExit(child);
  child.kill("SIGKILL");
  const exit = await exitPromise;
  assert.equal(exit.signal, "SIGKILL");

  const raw = await fs.readFile(logPath, "utf8");
  const endedWithPartialLine = raw.length > 0 && !raw.endsWith("\n");
  const recovered = new QualityEventStore({
    lineId: "LINE-KILL",
    stationId: "STATION-KILL",
    retentionMs: 60 * 60 * 1000,
    maxEvents: 100,
    eventLogPath: logPath,
    idempotencyPath: null,
    clock: () => Date.now()
  });
  const loaded = await recovered.load();
  assert.ok(loaded.loaded >= 1);
  assert.ok(recovered.list().some((event) => event.sourceEventId === "QC-KILL-SEED"));

  const afterKill = await recovered.recordDurably({
    sourceEventId: "QC-AFTER-KILL",
    occurredAt: new Date().toISOString()
  });
  await recovered.flush({ throwOnError: true });
  assert.equal(afterKill.duplicate, false);
  if (endedWithPartialLine) {
    assert.equal(
      recovered.getStorageStatus().eventLog.recoveredPartialLines,
      1
    );
  }

  const replayed = new QualityEventStore({
    lineId: "LINE-KILL",
    stationId: "STATION-KILL",
    retentionMs: 60 * 60 * 1000,
    maxEvents: 100,
    eventLogPath: logPath,
    idempotencyPath: null,
    clock: () => Date.now()
  });
  await replayed.load();
  assert.ok(
    replayed.list().some((event) => event.sourceEventId === "QC-AFTER-KILL")
  );
});
