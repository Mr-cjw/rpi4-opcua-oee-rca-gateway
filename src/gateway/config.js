"use strict";

const path = require("node:path");
const {
  DEFAULT_SHIFT_WINDOWS,
  defaultTimeZone,
  parseShiftSchedule,
  validateTimeZone
} = require("../analytics/planned-time");
const { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } = require("./jsonl");

function integerFromEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received "${raw}"`);
  }
  return value;
}

function numberFromEnv(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}; received "${raw}"`);
  }
  return value;
}

function booleanFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be a boolean; received "${raw}"`);
}

function jsonlPathFromEnv(env, name, defaultFile) {
  const raw = env[name];
  if (raw === "off" || raw === "none") {
    return null;
  }
  if (raw === "stdout") {
    return "stdout";
  }
  return path.resolve(raw || path.join(process.cwd(), "data", defaultFile));
}

function statePathFromEnv(env, name, defaultFile) {
  const raw = env[name];
  if (raw === "off" || raw === "none" || raw === "disabled") {
    return null;
  }
  return path.resolve(raw || path.join(process.cwd(), "data", defaultFile));
}

function alarmCodesFromEnv(env, name) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return Object.freeze([]);
  }
  const codes = raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  return Object.freeze([...new Set(codes)]);
}

function productCycleTimesFromEnv(env, name) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return Object.freeze({});
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const cycleTimes = {};
  for (const entry of entries) {
    const separator = entry.lastIndexOf("=");
    const productId = separator > 0 ? entry.slice(0, separator).trim() : "";
    const rawCycleTime = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const cycleTimeMs = Number(rawCycleTime);
    if (!productId || !Number.isFinite(cycleTimeMs) || cycleTimeMs <= 0) {
      throw new Error(`${name} entry must use PRODUCT_ID=MILLISECONDS; received "${entry}"`);
    }
    if (Object.prototype.hasOwnProperty.call(cycleTimes, productId)) {
      throw new Error(`${name} contains duplicate productId "${productId}"`);
    }
    cycleTimes[productId] = cycleTimeMs;
  }
  return Object.freeze(cycleTimes);
}

function nodeIdFromEnv(env, name, fallback, { optional = false } = {}) {
  const raw = env[name];
  if (raw === "off" || raw === "none" || raw === "disabled") {
    if (optional) {
      return null;
    }
    throw new Error(`${name} cannot be disabled`);
  }
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim();
}

function loadGatewayConfig(env = process.env) {
  const username = env.OPCUA_USERNAME || "";
  const password = env.OPCUA_PASSWORD || "";
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("OPCUA_USERNAME and OPCUA_PASSWORD must be configured together");
  }

  const timeZone = env.OEE_TIMEZONE || defaultTimeZone();
  try {
    validateTimeZone(timeZone);
  } catch (error) {
    throw new Error(`OEE_TIMEZONE: ${error.message}`);
  }
  const shiftWindows = env.OEE_SHIFT_WINDOWS || DEFAULT_SHIFT_WINDOWS;
  let shiftSchedule;
  try {
    shiftSchedule = parseShiftSchedule(shiftWindows);
  } catch (error) {
    throw new Error(`OEE_SHIFT_WINDOWS: ${error.message}`);
  }
  const plannedDowntimeAlarmCodes = alarmCodesFromEnv(
    env,
    "OEE_PLANNED_DOWNTIME_ALARM_CODES"
  );
  const changeoverAlarmCodes = alarmCodesFromEnv(env, "OEE_CHANGEOVER_ALARM_CODES");
  const productCycleTimes = productCycleTimesFromEnv(env, "OEE_PRODUCT_CYCLE_TIMES");
  const storageWarnFreeBytes = integerFromEnv(
    env,
    "GATEWAY_STORAGE_WARN_FREE_BYTES",
    100 * 1024 * 1024,
    { min: 1024, max: Number.MAX_SAFE_INTEGER }
  );
  const storageCriticalFreeBytes = integerFromEnv(
    env,
    "GATEWAY_STORAGE_CRITICAL_FREE_BYTES",
    32 * 1024 * 1024,
    { min: 1024, max: Number.MAX_SAFE_INTEGER }
  );
  if (storageCriticalFreeBytes > storageWarnFreeBytes) {
    throw new Error(
      "GATEWAY_STORAGE_CRITICAL_FREE_BYTES must be less than or equal to GATEWAY_STORAGE_WARN_FREE_BYTES"
    );
  }
  const overlappingCode = plannedDowntimeAlarmCodes.find((code) =>
    changeoverAlarmCodes.includes(code)
  );
  if (overlappingCode) {
    throw new Error(
      `OEE_PLANNED_DOWNTIME_ALARM_CODES and OEE_CHANGEOVER_ALARM_CODES overlap on "${overlappingCode}"`
    );
  }

  const variables = [
    {
      name: "deviceStatus",
      nodeId: nodeIdFromEnv(
        env,
        "OPCUA_DEVICE_STATUS_NODE",
        "ns=1;s=MockPLC.DeviceStatus"
      )
    },
    {
      name: "currentOutput",
      nodeId: nodeIdFromEnv(
        env,
        "OPCUA_CURRENT_OUTPUT_NODE",
        "ns=1;s=MockPLC.CurrentOutput"
      )
    },
    {
      name: "goodCount",
      nodeId: nodeIdFromEnv(env, "OPCUA_GOOD_COUNT_NODE", "ns=1;s=MockPLC.GoodCount")
    }
  ];
  const totalProducedCountNodeId = nodeIdFromEnv(
    env,
    "OPCUA_TOTAL_PRODUCED_NODE",
    "ns=1;s=MockPLC.TotalProducedCount",
    { optional: true }
  );
  if (totalProducedCountNodeId) {
    variables.push({ name: "totalProducedCount", nodeId: totalProducedCountNodeId });
  }
  variables.push(
    {
      name: "temperatureSensor",
      nodeId: nodeIdFromEnv(
        env,
        "OPCUA_TEMPERATURE_NODE",
        "ns=1;s=MockPLC.TemperatureSensor"
      )
    }
  );
  const alarmEventsNodeId = nodeIdFromEnv(
    env,
    "OPCUA_ALARM_EVENTS_NODE",
    "ns=1;s=MockPLC.AlarmEvents",
    { optional: true }
  );
  if (alarmEventsNodeId) {
    variables.push({ name: "alarmEvents", nodeId: alarmEventsNodeId });
  }

  return Object.freeze({
    endpointUrl: env.OPCUA_ENDPOINT || "opc.tcp://localhost:4840/UA/MockPLC",
    applicationName: env.OPCUA_CLIENT_NAME || "RCA-Gateway-OPCUA-Client",
    applicationUri:
      env.OPCUA_CLIENT_APPLICATION_URI || "urn:rpi4:gateway:opcua-client",
    pkiRoot: path.resolve(env.OPCUA_CLIENT_PKI_ROOT || path.join(process.cwd(), ".pki")),
    securityMode: env.OPCUA_SECURITY_MODE || "None",
    securityPolicy: env.OPCUA_SECURITY_POLICY || "None",
    username,
    password,
    requestedSessionTimeout: integerFromEnv(env, "OPCUA_SESSION_TIMEOUT_MS", 60000, {
      min: 1000,
      max: 3600000
    }),
    connection: Object.freeze({
      initialDelayMs: integerFromEnv(env, "OPCUA_RECONNECT_MIN_DELAY_MS", 500, {
        min: 50,
        max: 60000
      }),
      maxDelayMs: integerFromEnv(env, "OPCUA_RECONNECT_MAX_DELAY_MS", 30000, {
        min: 100,
        max: 300000
      }),
      randomisationFactor: 0.2
    }),
    subscription: Object.freeze({
      publishingIntervalMs: integerFromEnv(env, "OPCUA_PUBLISHING_INTERVAL_MS", 250, {
        min: 50,
        max: 60000
      }),
      samplingIntervalMs: integerFromEnv(env, "OPCUA_SAMPLING_INTERVAL_MS", 250, {
        min: 0,
        max: 60000
      }),
      queueSize: integerFromEnv(env, "OPCUA_QUEUE_SIZE", 20, { min: 1, max: 100000 }),
      eventQueueSize: integerFromEnv(env, "OPCUA_EVENT_QUEUE_SIZE", 200, {
        min: 1,
        max: 100000
      })
    }),
    variables: Object.freeze(variables),
    eventNodeId: nodeIdFromEnv(env, "OPCUA_EVENT_NODE", "ns=1;s=MockPLC", {
      optional: true
    }),
    identity: Object.freeze({
      lineId: env.GATEWAY_LINE_ID || "LINE-01",
      stationId: env.GATEWAY_STATION_ID || "STATION-01",
      workOrderId: env.GATEWAY_WORK_ORDER_ID || "",
      serialNumber: env.GATEWAY_SERIAL_NUMBER || "",
      correlationId: env.GATEWAY_CORRELATION_ID || "",
      productId: env.GATEWAY_PRODUCT_ID || ""
    }),
    workContext: Object.freeze({
      statePath: statePathFromEnv(env, "GATEWAY_WORK_CONTEXT_FILE", "work-context.json")
    }),
    context: Object.freeze({
      sampleIntervalMs: integerFromEnv(env, "PROCESS_CONTEXT_SAMPLE_INTERVAL_MS", 1000, {
        min: 50,
        max: 60000
      }),
      retentionMs: integerFromEnv(env, "PROCESS_CONTEXT_RETENTION_MS", 3600000, {
        min: 60000,
        max: 7 * 24 * 60 * 60 * 1000
      }),
      maxEvents: integerFromEnv(env, "PROCESS_CONTEXT_MAX_EVENTS", 10000, {
        min: 2,
        max: 1000000
      }),
      logPath: jsonlPathFromEnv(env, "PROCESS_CONTEXT_LOG", "process-context.jsonl"),
      logFsync: booleanFromEnv(env, "PROCESS_CONTEXT_LOG_FSYNC", false),
      logMaxBytes: integerFromEnv(
        env,
        "PROCESS_CONTEXT_LOG_MAX_BYTES",
        DEFAULT_MAX_BYTES,
        { min: 1024, max: 1024 * 1024 * 1024 }
      ),
      logMaxFiles: integerFromEnv(
        env,
        "PROCESS_CONTEXT_LOG_MAX_FILES",
        DEFAULT_MAX_FILES,
        { min: 1, max: 100 }
      )
    }),
    analytics: Object.freeze({
      nominalOutputPerMinute: numberFromEnv(env, "OEE_NOMINAL_OUTPUT_PER_MIN", 120, {
        min: 0.001,
        max: 100000
      }),
      idealCycleTimeMs: numberFromEnv(env, "OEE_IDEAL_CYCLE_TIME_MS", null, {
        min: 0.001,
        max: 3600000
      }),
      productCycleTimes,
      plannedTime: Object.freeze({
        timeZone,
        windows: shiftWindows,
        schedule: shiftSchedule
      }),
      downtimeClassification: Object.freeze({
        plannedAlarmCodes: plannedDowntimeAlarmCodes,
        changeoverAlarmCodes
      }),
      oeeWindowMs: integerFromEnv(env, "OEE_WINDOW_MS", 300000, {
        min: 1000,
        max: 7 * 24 * 60 * 60 * 1000
      }),
      rcaWindowMs: integerFromEnv(env, "RCA_WINDOW_MS", 300000, {
        min: 1000,
        max: 7 * 24 * 60 * 60 * 1000
      }),
      temperatureThresholdC: numberFromEnv(env, "RCA_TEMPERATURE_THRESHOLD_C", 70, {
        min: -40,
        max: 200
      })
    }),
    doctor: Object.freeze({
      sampleMs: integerFromEnv(env, "GATEWAY_DOCTOR_SAMPLE_MS", 3000, {
        min: 0,
        max: 60000
      }),
      connectTimeoutMs: integerFromEnv(env, "GATEWAY_DOCTOR_TIMEOUT_MS", 15000, {
        min: 1000,
        max: 120000
      }),
      clockSkewWarningMs: integerFromEnv(
        env,
        "GATEWAY_DOCTOR_CLOCK_SKEW_WARNING_MS",
        30000,
        { min: 0, max: 86400000 }
      ),
      staleValueWarningMs: integerFromEnv(
        env,
        "GATEWAY_DOCTOR_STALE_WARNING_MS",
        300000,
        { min: 1000, max: 30 * 24 * 60 * 60 * 1000 }
      )
    }),
    storage: Object.freeze({
      diskPath: path.resolve(
        env.GATEWAY_STORAGE_DISK_PATH || path.join(process.cwd(), "data")
      ),
      warnFreeBytes: storageWarnFreeBytes,
      criticalFreeBytes: storageCriticalFreeBytes,
      checkIntervalMs: integerFromEnv(env, "GATEWAY_STORAGE_CHECK_INTERVAL_MS", 60000, {
        min: 1000,
        max: 3600000
      })
    }),
    quality: Object.freeze({
      retentionMs: integerFromEnv(env, "QUALITY_EVENT_RETENTION_MS", 3600000, {
        min: 60000,
        max: 7 * 24 * 60 * 60 * 1000
      }),
      maxEvents: integerFromEnv(env, "QUALITY_EVENT_MAX_EVENTS", 10000, {
        min: 2,
        max: 1000000
      }),
      logPath: jsonlPathFromEnv(env, "QUALITY_EVENT_LOG", "quality-events.jsonl"),
      logFsync: booleanFromEnv(env, "QUALITY_EVENT_LOG_FSYNC", true),
      idempotencyPath: statePathFromEnv(
        env,
        "QUALITY_EVENT_IDEMPOTENCY_FILE",
        "quality-idempotency.json"
      ),
      idempotencyRetentionMs: integerFromEnv(
        env,
        "QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS",
        7 * 24 * 60 * 60 * 1000,
        { min: 60000, max: 30 * 24 * 60 * 60 * 1000 }
      ),
      idempotencyMaxEntries: integerFromEnv(
        env,
        "QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES",
        100000,
        { min: 2, max: 1000000 }
      ),
      logMaxBytes: integerFromEnv(
        env,
        "QUALITY_EVENT_LOG_MAX_BYTES",
        DEFAULT_MAX_BYTES,
        { min: 1024, max: 1024 * 1024 * 1024 }
      ),
      logMaxFiles: integerFromEnv(
        env,
        "QUALITY_EVENT_LOG_MAX_FILES",
        DEFAULT_MAX_FILES,
        { min: 1, max: 100 }
      )
    }),
    api: Object.freeze({
      host: env.GATEWAY_HTTP_HOST || "127.0.0.1",
      port: integerFromEnv(env, "GATEWAY_HTTP_PORT", 8080, { min: 0, max: 65535 }),
      token: env.GATEWAY_API_TOKEN || ""
    })
  });
}

module.exports = {
  loadGatewayConfig
};
