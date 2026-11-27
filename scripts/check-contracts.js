"use strict";

const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const processContextSchema = require("../contracts/process-context-event.schema.json");
const qualityEventSchema = require("../contracts/quality-event.schema.json");
const { ProcessContextCollector } = require("../src/gateway/process-context");
const { QualityEventStore } = require("../src/gateway/quality-events");

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

function createValidator(schema, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return { label, validate: ajv.compile(schema) };
}

function assertValid(validator, value) {
  if (validator.validate(value)) {
    console.log(`  ${validator.label}: valid`);
    return;
  }
  const errors = validator.validate.errors
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("\n");
  throw new Error(`${validator.label} validation failed:\n${errors}`);
}

function createProcessContextEvent() {
  const collector = new ProcessContextCollector({
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    workOrderId: "WO-CONTRACT-001",
    serialNumber: "SN-CONTRACT-001",
    correlationId: "corr-contract-001",
    productId: "SKU-CONTRACT-001",
    sampleIntervalMs: 1000,
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath: null,
    clock: () => NOW,
    createId: () => "event-contract-001"
  });
  const event = collector.capture(
    {
      deviceStatus: { value: "RUNNING" },
      currentOutput: { value: 120 },
      goodCount: { value: 98 },
      totalProducedCount: { value: 100 },
      temperatureSensor: { value: 24.5 },
      alarmEvents: {
        alarmSnapshot: {
          sequence: 1,
          active: [
            {
              eventId: "alarm-contract-001",
              occurredAt: "2026-11-27T10:00:00.000Z",
              code: "DOWNTIME",
              severity: 700
            }
          ]
        }
      }
    },
    { occurredAt: "2026-11-27T10:00:00.000Z" }
  );
  if (!event) {
    throw new Error("unable to generate a process-context contract sample");
  }
  return event;
}

function createQualityEvent() {
  const store = new QualityEventStore({
    lineId: "JX-LINE-01",
    stationId: "JX-LINQIN-STATION-01",
    workOrderId: "WO-CONTRACT-001",
    serialNumber: "SN-CONTRACT-001",
    correlationId: "corr-contract-001",
    productId: "SKU-CONTRACT-001",
    retentionMs: 60_000,
    maxEvents: 10,
    eventLogPath: null,
    idempotencyPath: null,
    clock: () => NOW,
    createId: () => "qevt-contract-001"
  });
  return store.record({
    sourceEventId: "QC-CONTRACT-001",
    occurredAt: "2026-11-27T10:00:00.000Z",
    defectType: "DENT",
    confidence: 0.97,
    metadata: { imageId: "IMG-CONTRACT-001" }
  }).event;
}

function main() {
  console.log("Validating shared event contracts...");
  assertValid(
    createValidator(processContextSchema, "process-context-event.schema.json"),
    createProcessContextEvent()
  );
  assertValid(
    createValidator(qualityEventSchema, "quality-event.schema.json"),
    createQualityEvent()
  );
  console.log("Contract validation passed.");
}

try {
  main();
} catch (error) {
  console.error(`Contract validation failed: ${error.message}`);
  process.exitCode = 1;
}
