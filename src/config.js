"use strict";

const os = require("node:os");
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

function loadConfig(env = process.env) {
  const resourcePath = env.OPCUA_RESOURCE_PATH || "/UA/MockPLC";
  if (!resourcePath.startsWith("/") || resourcePath.includes("//")) {
    throw new Error("OPCUA_RESOURCE_PATH must start with '/' and must not contain '//'");
  }

  const seed = integerFromEnv(env, "SIM_SEED", 8675309, {
    min: 0,
    max: 0xffffffff
  });

  return Object.freeze({
    opcua: Object.freeze({
      host: env.OPCUA_HOST || "0.0.0.0",
      hostname: env.OPCUA_HOSTNAME || "localhost",
      port: integerFromEnv(env, "OPCUA_PORT", 4840, { min: 1, max: 65535 }),
      resourcePath,
      maxSessions: integerFromEnv(env, "OPCUA_MAX_SESSIONS", 32, { min: 1, max: 1000 }),
      maxConnectionsPerEndpoint: integerFromEnv(
        env,
        "OPCUA_MAX_CONNECTIONS",
        32,
        { min: 1, max: 1000 }
      ),
      pkiRoot: path.resolve(env.OPCUA_PKI_ROOT || path.join(process.cwd(), ".pki"))
    }),
    simulation: Object.freeze({
      intervalMs: integerFromEnv(env, "SIM_INTERVAL_MS", 500, { min: 50, max: 60000 }),
      seed,
      nominalOutputPerMinute: numberFromEnv(env, "SIM_NOMINAL_OUTPUT", 120, {
        min: 0,
        max: 100000
      }),
      yieldRate: numberFromEnv(env, "SIM_YIELD_RATE", 0.98, { min: 0, max: 1 }),
      ambientTemperatureC: numberFromEnv(env, "SIM_AMBIENT_TEMP_C", 23.5, {
        min: -40,
        max: 80
      }),
      downtimeRatePerMinute: numberFromEnv(env, "SIM_DOWNTIME_RATE_PER_MIN", 0.35, {
        min: 0,
        max: 60
      }),
      temperatureSpikeRatePerMinute: numberFromEnv(
        env,
        "SIM_TEMP_SPIKE_RATE_PER_MIN",
        0.40,
        { min: 0, max: 60 }
      ),
      logEachTick: env.SIM_LOG_EACH_TICK === "1"
    }),
    metadata: Object.freeze({
      hostname: os.hostname(),
      nodeVersion: process.version,
      startedAt: new Date()
    })
  });
}

module.exports = {
  loadConfig
};
