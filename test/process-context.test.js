"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProcessContextCollector } = require("../src/gateway/process-context");
const processContextSchema = require("../contracts/process-context-event.schema.json");

function snapshot(overrides = {}) {
  return {
    deviceStatus: { value: "RUNNING" },
    currentOutput: { value: 118.4321 },
    goodCount: { value: 155 },
    temperatureSensor: { value: 24.125 },
    alarmEvents: {
      alarmSnapshot: {
        sequence: 2,
        active: [
          {
            sequence: 2,
            eventId: "alarm-2",
            time: "2026-11-27T00:00:05.000Z",
            code: "TEMPERATURE_SPIKE",
            severity: 800,
            message: "Temperature spike",
            cause: "MANUAL_FAULT_INJECTION"
          }
        ]
      }
    },
    ...overrides
  };
}

function makeCollector(overrides = {}) {
  let id = 0;
  return new ProcessContextCollector({
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    workOrderId: "WO-JX-001",
    serialNumber: "SN-JX-001",
    correlationId: "corr-001",
    sampleIntervalMs: 1000,
    retentionMs: 60_000,
    maxEvents: 10,
    clock: () => Date.parse("2026-11-27T00:00:10.000Z"),
    createId: () => `event-${++id}`,
    ...overrides
  });
}

test("process context builds the shared event contract", () => {
  const collector = makeCollector();
  const event = collector.capture(snapshot(), {
    occurredAt: "2026-11-27T00:00:10.000Z"
  });

  assert.equal(event.schemaVersion, "1.0");
  assert.equal(event.eventType, "PROCESS_CONTEXT");
  assert.equal(event.source, "rpi4-gateway");
  assert.equal(event.correlationId, "corr-001");
  assert.equal(event.lineId, "JX-LINE-01");
  assert.equal(event.stationId, "JX-LINQIN-STATION-01");
  assert.equal(event.workOrderId, "WO-JX-001");
  assert.equal(event.serialNumber, "SN-JX-001");
  assert.deepEqual(event.metrics, {
    deviceStatus: "RUNNING",
    currentOutput: 118.432,
    goodCount: 155,
    temperatureC: 24.125,
    alarmSequence: 2
  });
  assert.equal(event.alarms.length, 1);
  assert.equal(event.alarms[0].code, "TEMPERATURE_SPIKE");
  assert.equal(collector.getLatest(), event);
  assert.equal(collector.eventCount, 1);
  for (const field of processContextSchema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(event, field), `missing contract field ${field}`);
  }
  assert.equal(event.schemaVersion, processContextSchema.properties.schemaVersion.const);
});

test("process context rejects incomplete snapshots", () => {
  const collector = makeCollector();
  const event = collector.capture(snapshot({ temperatureSensor: { value: undefined } }));

  assert.equal(event, null);
  assert.equal(collector.eventCount, 0);
});

test("process context filters and limits retained events", () => {
  const collector = makeCollector();
  for (let second = 0; second < 5; second += 1) {
    collector.capture(snapshot({ goodCount: { value: second } }), {
      occurredAt: new Date(Date.parse("2026-11-27T00:00:00.000Z") + second * 1000).toISOString()
    });
  }

  assert.equal(collector.getEvents().length, 5);
  assert.equal(collector.getEvents({ limit: 2 }).length, 2);
  assert.equal(
    collector.getEvents({
      from: "2026-11-27T00:00:02.000Z",
      to: "2026-11-27T00:00:03.000Z"
    }).length,
    2
  );
});

test("process context records alarms once and persists JSONL", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "process-context-"));
  const logPath = path.join(directory, "events.jsonl");
  const collector = makeCollector({ eventLogPath: logPath });
  t.after(async () => {
    await collector.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.ok(
    collector.recordAlarm({
      eventId: "alarm-1",
      time: "2026-11-27T00:00:01.000Z",
      alarmCode: "DOWNTIME",
      severity: 700,
      message: "Stopped"
    })
  );
  assert.equal(
    collector.recordAlarm({
      eventId: "alarm-1",
      time: "2026-11-27T00:00:01.000Z",
      alarmCode: "DOWNTIME"
    }),
    null
  );
  collector.capture(snapshot(), { occurredAt: "2026-11-27T00:00:10.000Z" });
  await collector.flush();

  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).eventType, "PROCESS_CONTEXT");
  assert.equal(collector.alarmCount, 1);
});
