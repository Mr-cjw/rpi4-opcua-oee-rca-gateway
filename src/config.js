"use strict";

const os = require("node:os");
const path = require("node:path");
const { resolveCredentialPair } = require("./secret-file");

const SECURITY_MODES = Object.freeze(["None", "Sign", "SignAndEncrypt"]);
const SECURITY_POLICIES = Object.freeze([
  "None",
  "Basic256Sha256",
  "Aes128_Sha256_RsaOaep",
  "Aes256_Sha256_RsaPss"
]);

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

function enumListFromEnv(env, name, fallback, allowed) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return Object.freeze([...fallback]);
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = allowed.find((candidate) => candidate.toLowerCase() === entry.toLowerCase());
      if (!match) {
        throw new Error(`${name} must contain only ${allowed.join(", ")}; received "${entry}"`);
      }
      return match;
    });
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return Object.freeze([...new Set(values)]);
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
  const securityModes = enumListFromEnv(
    env,
    "MOCK_PLC_SECURITY_MODES",
    ["None"],
    SECURITY_MODES
  );
  const securityPolicies = enumListFromEnv(
    env,
    "MOCK_PLC_SECURITY_POLICIES",
    ["None"],
    SECURITY_POLICIES
  );
  const allowAnonymous = booleanFromEnv(env, "MOCK_PLC_ALLOW_ANONYMOUS", true);
  const credentials = resolveCredentialPair(env, {
    usernameName: "MOCK_PLC_USERNAME",
    passwordName: "MOCK_PLC_PASSWORD",
    usernameFileName: "MOCK_PLC_USERNAME_FILE",
    passwordFileName: "MOCK_PLC_PASSWORD_FILE"
  });
  const hasNoneMode = securityModes.includes("None");
  const hasSecureMode = securityModes.some((mode) => mode !== "None");
  const hasNonePolicy = securityPolicies.includes("None");
  const hasSecurePolicy = securityPolicies.some((policy) => policy !== "None");
  if (hasNoneMode && hasSecureMode) {
    throw new Error("MOCK_PLC_SECURITY_MODES cannot mix None with secured modes");
  }
  if (hasNoneMode !== hasNonePolicy || hasSecureMode !== hasSecurePolicy) {
    throw new Error(
      "MOCK_PLC_SECURITY_MODES and MOCK_PLC_SECURITY_POLICIES must both select None or both select secured endpoints"
    );
  }
  if (!allowAnonymous && !credentials.username) {
    throw new Error(
      "MOCK_PLC_ALLOW_ANONYMOUS=false requires MOCK_PLC_USERNAME and MOCK_PLC_PASSWORD"
    );
  }

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
      pkiRoot: path.resolve(env.OPCUA_PKI_ROOT || path.join(process.cwd(), ".pki")),
      securityModes,
      securityPolicies,
      allowAnonymous,
      username: credentials.username,
      password: credentials.password,
      trustUnknownClientCertificates: booleanFromEnv(
        env,
        "MOCK_PLC_TRUST_UNKNOWN_CLIENT_CERTIFICATES",
        true
      )
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
