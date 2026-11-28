"use strict";

const path = require("node:path");
const {
  AttributeIds,
  OPCUACertificateManager,
  OPCUAClient,
  UserTokenType,
  coerceMessageSecurityMode,
  coerceSecurityPolicy
} = require("node-opcua");
const { dataTypeName, isoOrNull, normalizeVariant } = require("./opcua-client");

const DEFAULT_DOCTOR_OPTIONS = Object.freeze({
  sampleMs: 3000,
  connectTimeoutMs: 15000,
  clockSkewWarningMs: 30000,
  staleValueWarningMs: 300000
});

const NUMERIC_DATA_TYPES = new Set([
  "SByte",
  "Byte",
  "Int16",
  "UInt16",
  "Int32",
  "UInt32",
  "Int64",
  "UInt64",
  "Float",
  "Double"
]);
const STRING_DATA_TYPES = new Set(["String", "LocalizedText"]);

const EXPECTED_VARIABLES = Object.freeze({
  deviceStatus: { category: "string", expected: "String" },
  currentOutput: { category: "number", expected: "numeric" },
  goodCount: { category: "number", expected: "numeric counter" },
  totalProducedCount: { category: "number", expected: "numeric counter" },
  temperatureSensor: { category: "number", expected: "numeric" },
  alarmEvents: { category: "string", expected: "JSON String" }
});

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataTypeCategory(name) {
  if (NUMERIC_DATA_TYPES.has(name)) {
    return "number";
  }
  if (STRING_DATA_TYPES.has(name)) {
    return "string";
  }
  return "other";
}

function numericValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readingFromDataValue(definition, dataValue) {
  return {
    name: definition.name,
    nodeId: definition.nodeId,
    value: normalizeVariant(dataValue.value),
    dataType: dataTypeName(dataValue.value) || null,
    statusCode: dataValue.statusCode.toString(),
    statusGood: !dataValue.statusCode.isNotGood(),
    sourceTimestamp: isoOrNull(dataValue.sourceTimestamp),
    serverTimestamp: isoOrNull(dataValue.serverTimestamp)
  };
}

async function readVariable(session, definition) {
  try {
    const dataValue = await session.read({
      nodeId: definition.nodeId,
      attributeId: AttributeIds.Value
    });
    return readingFromDataValue(definition, dataValue);
  } catch (error) {
    return {
      name: definition.name,
      nodeId: definition.nodeId,
      value: null,
      dataType: null,
      statusCode: "ReadFailed",
      statusGood: false,
      sourceTimestamp: null,
      serverTimestamp: null,
      error: error.message
    };
  }
}

async function readEventNotifier(session, nodeId) {
  try {
    const dataValue = await session.read({
      nodeId,
      attributeId: AttributeIds.EventNotifier
    });
    return {
      nodeId,
      value: normalizeVariant(dataValue.value),
      statusCode: dataValue.statusCode.toString(),
      statusGood: !dataValue.statusCode.isNotGood(),
      sourceTimestamp: isoOrNull(dataValue.sourceTimestamp),
      serverTimestamp: isoOrNull(dataValue.serverTimestamp)
    };
  } catch (error) {
    return {
      nodeId,
      value: null,
      statusCode: "ReadFailed",
      statusGood: false,
      sourceTimestamp: null,
      serverTimestamp: null,
      error: error.message
    };
  }
}

function createCheck(code, status, message, details = {}) {
  return { code, status, message, ...details };
}

function variableCode(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function checkTimestamp(name, field, timestamp, now, options, checks) {
  if (!timestamp) {
    checks.push(
      createCheck(
        `${variableCode(name)}_${variableCode(field)}_MISSING`,
        "warn",
        `${name}.${field} is missing; freshness and clock checks are limited.`,
        { variable: name, field }
      )
    );
    return;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    checks.push(
      createCheck(
        `${variableCode(name)}_${variableCode(field)}_INVALID`,
        "warn",
        `${name}.${field} is not a valid timestamp: ${timestamp}`,
        { variable: name, field, timestamp }
      )
    );
    return;
  }
  const deltaMs = parsed - now;
  if (field === "serverTimestamp" && deltaMs > options.clockSkewWarningMs) {
    checks.push(
      createCheck(
        `${variableCode(name)}_CLOCK_SKEW`,
        "warn",
        `${name}.serverTimestamp is ${Math.round(deltaMs / 1000)} seconds ahead of Gateway time.`,
        { variable: name, field, deltaMs, timestamp }
      )
    );
  }
  if (field === "sourceTimestamp") {
    if (deltaMs > options.clockSkewWarningMs) {
      checks.push(
        createCheck(
          `${variableCode(name)}_SOURCE_TIMESTAMP_AHEAD`,
          "warn",
          `${name}.sourceTimestamp is ${Math.round(deltaMs / 1000)} seconds ahead of Gateway time.`,
          { variable: name, field, deltaMs, timestamp }
        )
      );
    }
    if (name !== "alarmEvents" && now - parsed > options.staleValueWarningMs) {
      checks.push(
        createCheck(
          `${variableCode(name)}_VALUE_STALE`,
          "warn",
          `${name}.sourceTimestamp is older than ${Math.round(options.staleValueWarningMs / 1000)} seconds.`,
          { variable: name, field, ageMs: now - parsed, timestamp }
        )
      );
    }
  }
}

function checkTimestampSkew(name, sourceTimestamp, serverTimestamp, options, checks) {
  if (!sourceTimestamp || !serverTimestamp) {
    return;
  }
  const source = Date.parse(sourceTimestamp);
  const server = Date.parse(serverTimestamp);
  if (!Number.isFinite(source) || !Number.isFinite(server)) {
    return;
  }
  const deltaMs = source - server;
  if (Math.abs(deltaMs) > options.clockSkewWarningMs) {
    checks.push(
      createCheck(
        `${variableCode(name)}_SOURCE_SERVER_SKEW`,
        "warn",
        `${name} source/server timestamps differ by ${Math.round(deltaMs / 1000)} seconds.`,
        { variable: name, deltaMs, sourceTimestamp, serverTimestamp }
      )
    );
  }
}

function variableByName(readings, name) {
  return readings.find((reading) => reading.name === name) || null;
}

function evaluateDoctorReadings({
  endpointUrl,
  securityMode = "None",
  securityPolicy = "None",
  firstReadings,
  secondReadings = firstReadings,
  eventNotifier = null,
  now = Date.now(),
  options = {}
}) {
  const settings = { ...DEFAULT_DOCTOR_OPTIONS, ...options };
  const checks = [];

  for (const reading of firstReadings) {
    const code = variableCode(reading.name);
    if (!reading.statusGood) {
      checks.push(
        createCheck(
          `${code}_STATUS_BAD`,
          "fail",
          `${reading.name} returned ${reading.statusCode}${reading.error ? `: ${reading.error}` : ""}.`,
          { variable: reading.name, nodeId: reading.nodeId, statusCode: reading.statusCode }
        )
      );
      continue;
    }

    const expected = EXPECTED_VARIABLES[reading.name];
    let dataTypeMatches = true;
    if (expected && dataTypeCategory(reading.dataType) !== expected.category) {
      dataTypeMatches = false;
      checks.push(
        createCheck(
          `${code}_DATA_TYPE`,
          "fail",
          `${reading.name} data type is ${reading.dataType || "unknown"}; expected ${expected.expected}.`,
          {
            variable: reading.name,
            nodeId: reading.nodeId,
            dataType: reading.dataType,
            expected: expected.expected
          }
        )
      );
    }
    let valuePresent = true;
    if (reading.value === null || reading.value === undefined) {
      valuePresent = false;
      checks.push(
        createCheck(
          `${code}_VALUE_MISSING`,
          "fail",
          `${reading.name} returned no value.`,
          { variable: reading.name, nodeId: reading.nodeId }
        )
      );
    }
    if (dataTypeMatches && valuePresent) {
      checks.push(
        createCheck(
          `${code}_READY`,
          "pass",
          `${reading.name} is readable as ${reading.dataType}.`,
          { variable: reading.name, nodeId: reading.nodeId, dataType: reading.dataType }
        )
      );
    }
    checkTimestamp(reading.name, "sourceTimestamp", reading.sourceTimestamp, now, settings, checks);
    checkTimestamp(reading.name, "serverTimestamp", reading.serverTimestamp, now, settings, checks);
    checkTimestampSkew(
      reading.name,
      reading.sourceTimestamp,
      reading.serverTimestamp,
      settings,
      checks
    );
  }

  const deviceStatusText = variableByName(firstReadings, "deviceStatus")?.value;
  if (deviceStatusText && !["RUNNING", "DOWN"].includes(String(deviceStatusText).toUpperCase())) {
    checks.push(
      createCheck(
        "DEVICE_STATUS_UNRECOGNIZED",
        "warn",
        `deviceStatus=${deviceStatusText}; the Gateway will treat it as non-running.`,
        { value: deviceStatusText }
      )
    );
  }

  const currentOutput = variableByName(firstReadings, "currentOutput");
  const currentOutputValue = numericValue(currentOutput?.value);
  if (currentOutput?.statusGood && currentOutputValue === null) {
    checks.push(
      createCheck(
        "CURRENT_OUTPUT_NOT_NUMERIC",
        "fail",
        "currentOutput is not numeric.",
        { value: currentOutput.value }
      )
    );
  } else if (currentOutputValue !== null && currentOutputValue < 0) {
    checks.push(
      createCheck(
        "CURRENT_OUTPUT_NEGATIVE",
        "fail",
        `currentOutput=${currentOutputValue}; expected a non-negative rate.`,
        { value: currentOutputValue }
      )
    );
  }

  const temperature = variableByName(firstReadings, "temperatureSensor");
  if (temperature?.statusGood && numericValue(temperature.value) === null) {
    checks.push(
      createCheck(
        "TEMPERATURE_NOT_NUMERIC",
        "fail",
        "temperatureSensor is not numeric.",
        { value: temperature.value }
      )
    );
  }

  const alarmEvents = variableByName(firstReadings, "alarmEvents");
  if (alarmEvents?.statusGood && typeof alarmEvents.value === "string") {
    try {
      const parsed = JSON.parse(alarmEvents.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      checks.push(
        createCheck(
          "ALARM_EVENTS_JSON_READY",
          "pass",
          "alarmEvents contains a valid JSON object.",
          { nodeId: alarmEvents.nodeId }
        )
      );
    } catch (error) {
      checks.push(
        createCheck(
          "ALARM_EVENTS_JSON_INVALID",
          "fail",
          `alarmEvents is not a valid JSON object: ${error.message}`,
          { nodeId: alarmEvents.nodeId, value: alarmEvents.value }
        )
      );
    }
  }

  let counterInvariantFailure = false;
  for (const counterName of ["goodCount", "totalProducedCount"]) {
    const counter = variableByName(firstReadings, counterName);
    if (!counter) {
      checks.push(
        createCheck(
          `${variableCode(counterName)}_MISSING`,
          counterName === "totalProducedCount" ? "warn" : "fail",
          counterName === "totalProducedCount"
            ? "totalProducedCount is not configured; OEE will use the good-count proxy."
            : `${counterName} is not configured.`,
          { variable: counterName }
        )
      );
      continue;
    }
    if (!counter.statusGood) {
      counterInvariantFailure = true;
      continue;
    }
    const firstValue = numericValue(counter.value);
    const secondValue = numericValue(variableByName(secondReadings, counterName)?.value);
    if (firstValue === null || secondValue === null) {
      counterInvariantFailure = true;
      checks.push(
        createCheck(
          `${variableCode(counterName)}_NOT_NUMERIC`,
          "fail",
          `${counterName} is not numeric.`,
          { variable: counterName, firstValue: counter.value }
        )
      );
      continue;
    }
    if (!Number.isInteger(firstValue) || firstValue < 0) {
      counterInvariantFailure = true;
      checks.push(
        createCheck(
          `${variableCode(counterName)}_INVALID_VALUE`,
          "fail",
          `${counterName}=${firstValue}; expected a non-negative integer.`,
          { variable: counterName, value: firstValue }
        )
      );
    }
    if (secondValue < firstValue) {
      counterInvariantFailure = true;
      checks.push(
        createCheck(
          `${variableCode(counterName)}_DECREASED`,
          "fail",
          `${counterName} decreased from ${firstValue} to ${secondValue} during the sample window.`,
          { variable: counterName, firstValue, secondValue }
        )
      );
    }
  }

  const good = numericValue(variableByName(firstReadings, "goodCount")?.value);
  const total = numericValue(variableByName(firstReadings, "totalProducedCount")?.value);
  const secondGood = numericValue(variableByName(secondReadings, "goodCount")?.value);
  const secondTotal = numericValue(variableByName(secondReadings, "totalProducedCount")?.value);
  for (const [label, goodValue, totalValue] of [
    ["first", good, total],
    ["second", secondGood, secondTotal]
  ]) {
    if (goodValue !== null && totalValue !== null && goodValue > totalValue) {
      counterInvariantFailure = true;
      checks.push(
        createCheck(
          `GOOD_COUNT_EXCEEDS_TOTAL_${label.toUpperCase()}`,
          "fail",
          `${label} sample has goodCount=${goodValue} greater than totalProducedCount=${totalValue}.`,
          { sample: label, goodCount: goodValue, totalProducedCount: totalValue }
        )
      );
    }
  }
  if (
    !counterInvariantFailure &&
    good !== null &&
    total !== null &&
    secondGood !== null &&
    secondTotal !== null
  ) {
    checks.push(
      createCheck(
        "COUNTER_INVARIANTS_READY",
        "pass",
        "Counter values are non-negative, goodCount does not exceed totalProducedCount, and neither counter decreased.",
        {
          first: { goodCount: good, totalProducedCount: total },
          second: { goodCount: secondGood, totalProducedCount: secondTotal }
        }
      )
    );
  }

  if (eventNotifier) {
    if (!eventNotifier.statusGood) {
      checks.push(
        createCheck(
          "EVENT_NOTIFIER_BAD_STATUS",
          "fail",
          `EventNotifier returned ${eventNotifier.statusCode}${eventNotifier.error ? `: ${eventNotifier.error}` : ""}.`,
          { nodeId: eventNotifier.nodeId, statusCode: eventNotifier.statusCode }
        )
      );
    } else if (Number(eventNotifier.value) === 0) {
      checks.push(
        createCheck(
          "EVENT_NOTIFIER_DISABLED",
          "warn",
          "EventNotifier is zero; native OPC UA alarm events will not be available.",
          { nodeId: eventNotifier.nodeId, value: eventNotifier.value }
        )
      );
    } else {
      checks.push(
        createCheck(
          "EVENT_NOTIFIER_READY",
          "pass",
          "EventNotifier is enabled for native OPC UA events.",
          { nodeId: eventNotifier.nodeId, value: eventNotifier.value }
        )
      );
    }
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  const overallStatus = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  return {
    schemaVersion: "1.0",
    generatedAt: new Date(now).toISOString(),
    endpointUrl,
    security: { mode: securityMode, policy: securityPolicy },
    overallStatus,
    exitCode: overallStatus === "fail" ? 1 : 0,
    summary,
    settings,
    variables: firstReadings,
    secondSample: secondReadings,
    eventNotifier,
    checks
  };
}

function failedConnectionReport(endpointUrl, options, error, stage) {
  const now = Date.now();
  const check = createCheck(
    stage === "connect" ? "CONNECTION_FAILED" : "SESSION_FAILED",
    "fail",
    error.message,
    { stage }
  );
  return {
    schemaVersion: "1.0",
    generatedAt: new Date(now).toISOString(),
    endpointUrl,
    security: {
      mode: options.securityMode,
      policy: options.securityPolicy
    },
    overallStatus: "fail",
    exitCode: 1,
    summary: { pass: 0, warn: 0, fail: 1 },
    settings: options,
    variables: [],
    secondSample: [],
    eventNotifier: null,
    checks: [check]
  };
}

async function runGatewayDoctor(config, overrides = {}) {
  const options = {
    ...DEFAULT_DOCTOR_OPTIONS,
    ...(config.doctor || {}),
    ...overrides,
    securityMode: config.securityMode,
    securityPolicy: config.securityPolicy
  };
  const certificateManager = new OPCUACertificateManager({
    rootFolder: path.join(config.pkiRoot, "doctor"),
    automaticallyAcceptUnknownCertificate: config.trustUnknownCertificates === true
  });
  const clientOptions = {
    applicationName: `${config.applicationName || "RCA-Gateway"}-Doctor`,
    applicationUri: config.applicationUri || "urn:rpi4:gateway:opcua-doctor",
    clientCertificateManager: certificateManager,
    endpointMustExist: false,
    securityMode: coerceMessageSecurityMode(config.securityMode),
    securityPolicy: coerceSecurityPolicy(config.securityPolicy),
    requestedSessionTimeout: config.requestedSessionTimeout,
    keepSessionAlive: false,
    connectionStrategy: {
      initialDelay: 100,
      maxDelay: 1000,
      maxRetry: 0,
      randomisationFactor: 0
    }
  };
  if (config.clientCertificateFile) {
    clientOptions.certificateFile = config.clientCertificateFile;
    clientOptions.privateKeyFile = config.clientPrivateKeyFile;
  }
  const client = OPCUAClient.create(clientOptions);

  let session = null;
  try {
    try {
      await withTimeout(
        client.connect(config.endpointUrl),
        options.connectTimeoutMs,
        "OPC UA connection"
      );
    } catch (error) {
      return failedConnectionReport(config.endpointUrl, options, error, "connect");
    }

    const userIdentity = config.username
      ? {
          type: UserTokenType.UserName,
          userName: config.username,
          password: config.password
        }
      : { type: UserTokenType.Anonymous };
    try {
      session = await withTimeout(
        client.createSession(userIdentity),
        options.connectTimeoutMs,
        "OPC UA session creation"
      );
    } catch (error) {
      return failedConnectionReport(config.endpointUrl, options, error, "session");
    }

    const firstReadings = [];
    for (const definition of config.variables) {
      firstReadings.push(await readVariable(session, definition));
    }
    const eventNotifier = config.eventNodeId
      ? await readEventNotifier(session, config.eventNodeId)
      : null;

    let secondReadings = firstReadings;
    if (options.sampleMs > 0) {
      await delay(options.sampleMs);
      secondReadings = [];
      for (const definition of config.variables) {
        secondReadings.push(await readVariable(session, definition));
      }
    }

    return evaluateDoctorReadings({
      endpointUrl: config.endpointUrl,
      securityMode: config.securityMode,
      securityPolicy: config.securityPolicy,
      firstReadings,
      secondReadings,
      eventNotifier,
      now: Date.now(),
      options
    });
  } finally {
    if (session) {
      await withTimeout(session.close(), 3000, "OPC UA session close").catch(() => undefined);
    }
    await withTimeout(client.disconnect(), 3000, "OPC UA disconnect").catch(() => undefined);
  }
}

function formatDoctorReport(report) {
  const lines = [
    "Gateway OPC UA doctor",
    `Endpoint: ${report.endpointUrl}`,
    `Security: ${report.security.mode} / ${report.security.policy}`,
    ""
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.code}: ${check.message}`);
  }
  lines.push(
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    `Result: ${report.overallStatus.toUpperCase()}`
  );
  return lines.join("\n");
}

module.exports = {
  DEFAULT_DOCTOR_OPTIONS,
  evaluateDoctorReadings,
  formatDoctorReport,
  runGatewayDoctor
};
