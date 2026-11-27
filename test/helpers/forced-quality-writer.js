"use strict";

const { QualityEventStore } = require("../../src/gateway/quality-events");

const logPath = process.argv[2];
if (!logPath) {
  throw new Error("forced quality writer requires a log path");
}

const store = new QualityEventStore({
  lineId: "LINE-KILL",
  stationId: "STATION-KILL",
  retentionMs: 60 * 60 * 1000,
  maxEvents: 100,
  eventLogPath: logPath,
  eventLogMaxBytes: 0,
  eventLogMaxFiles: 0,
  idempotencyPath: null
});

async function main() {
  await store.recordDurably({
    sourceEventId: "QC-KILL-SEED",
    occurredAt: new Date().toISOString()
  });
  process.stdout.write("seeded\n");

  for (let index = 1; ; index += 1) {
    await store.recordDurably({
      sourceEventId: `QC-KILL-${index}`,
      occurredAt: new Date().toISOString(),
      metadata: { payload: "x".repeat(1024 * 1024) }
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
