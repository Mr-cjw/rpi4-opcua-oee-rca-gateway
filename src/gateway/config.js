"use strict";

const path = require("node:path");

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

function eventLogPathFromEnv(env) {
  const raw = env.PROCESS_CONTEXT_LOG;
  if (raw === "off" || raw === "none") {
    return null;
  }
  if (raw === "stdout") {
    return "stdout";
  }
  return path.resolve(raw || path.join(process.cwd(), "data", "process-context.jsonl"));
}

function loadGatewayConfig(env = process.env) {
  const username = env.OPCUA_USERNAME || "";
  const password = env.OPCUA_PASSWORD || "";
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("OPCUA_USERNAME and OPCUA_PASSWORD must be configured together");
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
    identity: Object.freeze({
      lineId: env.GATEWAY_LINE_ID || "LINE-01",
      stationId: env.GATEWAY_STATION_ID || "STATION-01",
      workOrderId: env.GATEWAY_WORK_ORDER_ID || "",
      serialNumber: env.GATEWAY_SERIAL_NUMBER || "",
      correlationId: env.GATEWAY_CORRELATION_ID || ""
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
      logPath: eventLogPathFromEnv(env)
    }),
    analytics: Object.freeze({
      nominalOutputPerMinute: numberFromEnv(env, "OEE_NOMINAL_OUTPUT_PER_MIN", 120, {
        min: 0.001,
        max: 100000
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
