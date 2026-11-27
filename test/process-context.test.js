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
    totalProducedCount: { value: 160 },
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
    productId: "SKU-JX-001",
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
  assert.equal(event.productId, "SKU-JX-001");
  assert.deepEqual(event.metrics, {
    deviceStatus: "RUNNING",
    currentOutput: 118.432,
    goodCount: 155,
    totalProducedCount: 160,
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

test("process context accepts legacy snapshots without total production", () => {
  const collector = makeCollector();
  const event = collector.capture(snapshot({ totalProducedCount: undefined }), {
    occurredAt: "2026-11-27T00:00:10.000Z"
  });

  assert.ok(event);
  assert.equal(Object.hasOwn(event.metrics, "totalProducedCount"), false);
});

test("process context works when the PLC has no AlarmEvents node", () => {
  const collector = makeCollector();
  const event = collector.capture(snapshot({ alarmEvents: undefined }), {
    occurredAt: "2026-11-27T00:00:10.000Z"
  });

  assert.ok(event);
  assert.deepEqual(event.alarms, []);
  assert.equal(event.metrics.alarmSequence, null);
});

test("process context updates and clears runtime work context", () => {
  const collector = makeCollector();
  const emitted = [];
  collector.on("workContext", (context) => emitted.push(context));

  const updated = collector.setWorkContext({
    workOrderId: "WO-JX-002",
    serialNumber: "SN-JX-002",
    correlationId: "corr-002",
    productId: "SKU-JX-002"
  });
  assert.deepEqual(updated, {
    workOrderId: "WO-JX-002",
    serialNumber: "SN-JX-002",
    correlationId: "corr-002",
    productId: "SKU-JX-002"
  });
  assert.deepEqual(collector.getWorkContext(), updated);
  assert.deepEqual(emitted, [updated]);

  const event = collector.capture(snapshot(), {
    occurredAt: "2026-11-27T00:00:10.000Z"
  });
  assert.equal(event.workOrderId, "WO-JX-002");
  assert.equal(event.serialNumber, "SN-JX-002");
  assert.equal(event.correlationId, "corr-002");
  assert.equal(event.productId, "SKU-JX-002");

  const cleared = collector.setWorkContext({
    workOrderId: null,
    serialNumber: "",
    correlationId: undefined,
    productId: ""
  });
  assert.deepEqual(cleared, {
    workOrderId: null,
    serialNumber: null,
    correlationId: null,
    productId: null
  });
  const clearedEvent = collector.capture(snapshot(), {
    occurredAt: "2026-11-27T00:00:11.000Z"
  });
  assert.equal(Object.hasOwn(clearedEvent, "workOrderId"), false);
  assert.equal(Object.hasOwn(clearedEvent, "serialNumber"), false);
  assert.equal(Object.hasOwn(clearedEvent, "correlationId"), false);
  assert.equal(Object.hasOwn(clearedEvent, "productId"), false);

  assert.throws(
    () => collector.setWorkContext({ workOrderId: 42 }),
    (error) => error.statusCode === 400 && /workOrderId/.test(error.message)
  );
  assert.throws(() => collector.setWorkContext([]), /must be an object/);
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

test("process context filters retained events by work context", () => {
  const collector = makeCollector();
  collector.setWorkContext({ workOrderId: "WO-A", correlationId: "corr-a" });
  collector.capture(snapshot(), { occurredAt: "2026-11-27T00:00:01.000Z" });
  collector.setWorkContext({ workOrderId: "WO-B", correlationId: "corr-b" });
  collector.capture(snapshot(), { occurredAt: "2026-11-27T00:00:02.000Z" });

  assert.equal(collector.getEvents({ workOrderId: "WO-A" }).length, 1);
  assert.equal(collector.getEvents({ workOrderId: "WO-B" }).length, 1);
  assert.equal(
    collector.getEvents({ workOrderId: "WO-A", correlationId: "corr-b" }).length,
    0
  );
  assert.equal(collector.getEvents({ correlationId: "corr-b" }).length, 1);
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

test("process context scopes alarm history by its active work context", () => {
  const collector = makeCollector();
  collector.setWorkContext({
    workOrderId: "WO-ALARM-A",
    serialNumber: "SN-ALARM-A",
    correlationId: "corr-alarm-a"
  });
  const first = collector.recordAlarm({
    eventId: "alarm-context-a",
    time: "2026-11-27T00:00:02.000Z",
    alarmCode: "DOWNTIME",
    message: "Stopped for A"
  });
  collector.setWorkContext({
    workOrderId: "WO-ALARM-B",
    serialNumber: "SN-ALARM-B",
    correlationId: "corr-alarm-b"
  });
  collector.recordAlarm({
    eventId: "alarm-context-b",
    time: "2026-11-27T00:00:03.000Z",
    alarmCode: "TEMPERATURE_SPIKE",
    message: "Hot for B"
  });

  assert.equal(first.workOrderId, "WO-ALARM-A");
  assert.equal(first.correlationId, "corr-alarm-a");
  assert.equal(collector.getAlarmHistory({ workOrderId: "WO-ALARM-A" }).length, 1);
  assert.equal(collector.getAlarmHistory({ correlationId: "corr-alarm-b" }).length, 1);
  assert.equal(
    collector.getAlarmHistory({
      workOrderId: "WO-ALARM-A",
      correlationId: "corr-alarm-b"
    }).length,
    0
  );
});

test("process context replays retained JSONL and skips corrupt or foreign lines", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "process-context-replay-"));
  const logPath = path.join(directory, "events.jsonl");
  const first = makeCollector({ eventLogPath: logPath });
  t.after(async () => {
    await first.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });

  first.capture(snapshot({ goodCount: { value: 1 } }), {
    occurredAt: "2026-11-27T00:00:01.000Z"
  });
  first.capture(snapshot({ goodCount: { value: 2 } }), {
    occurredAt: "2026-11-27T00:00:02.000Z"
  });
  await first.flush();

  const foreign = {
    schemaVersion: "1.0",
    eventId: "foreign-1",
    source: "rpi4-gateway",
    eventType: "PROCESS_CONTEXT",
    occurredAt: "2026-11-27T00:00:03.000Z",
    lineId: "OTHER-LINE",
    stationId: "JX-LINQIN-STATION-01",
    metrics: {
      deviceStatus: "RUNNING",
      currentOutput: 120,
      goodCount: 3,
      temperatureC: 24,
      alarmSequence: null
    },
    alarms: []
  };
  await fs.appendFile(logPath, `${JSON.stringify(foreign)}\nnot-json\n`, "utf8");
  await fs.appendFile(
    logPath,
    `${JSON.stringify({
      schemaVersion: "1.0",
      eventId: "legacy-event-1",
      source: "rpi4-gateway",
      eventType: "PROCESS_CONTEXT",
      occurredAt: "2026-11-27T00:00:02.500Z",
      lineId: "JX-LINE-01",
      stationId: "JX-LINQIN-STATION-01",
      metrics: {
        deviceStatus: "RUNNING",
        currentOutput: 120,
        goodCount: 2,
        temperatureC: 24,
        alarmSequence: null
      },
      alarms: []
    })}\n`,
    "utf8"
  );

  const replayed = makeCollector({ eventLogPath: logPath });
  const result = await replayed.load();
  assert.equal(result.loaded, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.retained, 3);
  assert.equal(replayed.getEvents().length, 3);
  assert.equal(replayed.getLatest().occurredAt, "2026-11-27T00:00:02.500Z");

  const again = await replayed.load();
  assert.equal(again.alreadyLoaded, true);
  assert.equal(again.loaded, 0);
});
