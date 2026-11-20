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
    })
  });
}

module.exports = {
  loadGatewayConfig
};
