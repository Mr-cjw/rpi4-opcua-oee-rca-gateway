"use strict";

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");

const RECORD_COUNT = Number(process.env.STORAGE_EVAL_RECORDS || 2000);

function sampleRecord(sequence) {
  return {
    schemaVersion: "1.0",
    eventId: `storage-eval-${sequence}`,
    sequence,
    eventType: "PROCESS_CONTEXT",
    occurredAt: new Date(Date.UTC(2026, 10, 27, 0, 0, sequence % 60)).toISOString(),
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    metrics: {
      deviceStatus: "RUNNING",
      currentOutput: 120.5,
      goodCount: sequence,
      totalProducedCount: sequence + 2,
      temperatureC: 24.5
    },
    alarms: []
  };
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory)) {
    const stats = await fs.stat(path.join(directory, entry));
    if (stats.isFile()) {
      total += stats.size;
    }
  }
  return total;
}

async function readJsonl(filePath) {
  const stream = fsSync.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (line.trim()) {
      JSON.parse(line);
      count += 1;
    }
  }
  lines.close();
  stream.destroy();
  return count;
}

async function benchmarkJsonl(root, fsync) {
  const directory = path.join(root, fsync ? "jsonl-fsync" : "jsonl-buffered");
  const filePath = path.join(directory, "events.jsonl");
  await fs.mkdir(directory, { recursive: true });
  const records = Array.from({ length: RECORD_COUNT }, (_, index) =>
    `${JSON.stringify(sampleRecord(index + 1))}\n`
  );

  const writeStart = performance.now();
  const handle = await fs.open(filePath, "a");
  try {
    for (const record of records) {
      await handle.write(record, null, "utf8");
      if (fsync) {
        await handle.sync();
      }
    }
  } finally {
    await handle.close();
  }
  const writeMs = performance.now() - writeStart;

  const readStart = performance.now();
  const loaded = await readJsonl(filePath);
  const readMs = performance.now() - readStart;
  return {
    label: fsync ? "JSONL append + fsync" : "JSONL append",
    count: loaded,
    writeMs,
    readMs,
    bytes: await directoryBytes(directory),
    integrity: loaded === RECORD_COUNT ? "ok" : "mismatch"
  };
}

async function benchmarkSqlite(root, synchronous) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }

  const directory = path.join(root, `sqlite-wal-${synchronous.toLowerCase()}`);
  const filePath = path.join(directory, "events.db");
  await fs.mkdir(directory, { recursive: true });
  const db = new DatabaseSync(filePath);
  let closed = false;
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${synchronous}`);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(
      "CREATE TABLE events (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)"
    );
    const insert = db.prepare(
      "INSERT INTO events (sequence, event_id, occurred_at, payload) VALUES (?, ?, ?, ?)"
    );

    const writeStart = performance.now();
    for (let sequence = 1; sequence <= RECORD_COUNT; sequence += 1) {
      const record = sampleRecord(sequence);
      insert.run(sequence, record.eventId, record.occurredAt, JSON.stringify(record));
    }
    const writeMs = performance.now() - writeStart;

    const readStart = performance.now();
    const rows = db.prepare("SELECT payload FROM events").all();
    for (const row of rows) {
      JSON.parse(row.payload);
    }
    const loaded = rows.length;
    const readMs = performance.now() - readStart;
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    db.close();
    closed = true;
    return {
      label: `SQLite WAL synchronous=${synchronous}`,
      count: loaded,
      writeMs,
      readMs,
      bytes: await directoryBytes(directory),
      integrity
    };
  } finally {
    if (!closed) {
      db.close();
    }
  }
}

function printResult(result) {
  const writesPerSecond = Math.round(result.count / (result.writeMs / 1000));
  console.log(
    `${result.label.padEnd(32)} records=${result.count} ` +
      `write=${result.writeMs.toFixed(1)}ms read=${result.readMs.toFixed(1)}ms ` +
      `rate=${writesPerSecond}/s bytes=${result.bytes} integrity=${result.integrity}`
  );
}

async function main() {
  if (!Number.isInteger(RECORD_COUNT) || RECORD_COUNT <= 0) {
    throw new Error("STORAGE_EVAL_RECORDS must be a positive integer");
  }
  let sqliteProbe;
  try {
    sqliteProbe = require("node:sqlite");
  } catch {
    sqliteProbe = null;
  }
  if (!sqliteProbe) {
    console.log("node:sqlite is unavailable; SQLite WAL evaluation was skipped.");
    console.log("Use Node.js >= 22.13 or rerun on the target Raspberry Pi runtime.");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-storage-eval-"));
  try {
    console.log(`Storage evaluation: ${RECORD_COUNT} records, ${os.platform()} ${os.arch()}`);
    const results = [
      await benchmarkJsonl(root, false),
      await benchmarkJsonl(root, true),
      await benchmarkSqlite(root, "NORMAL"),
      await benchmarkSqlite(root, "FULL")
    ].filter(Boolean);
    for (const result of results) {
      printResult(result);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Storage evaluation failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
