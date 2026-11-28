"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { hashFile, writeJsonAtomic } = require("../release/common");

const QUARANTINE_SCHEMA_VERSION = "1.0";
const QUARANTINE_KIND = "rpi4-gateway-flaky-test-registry";
const DEFAULT_QUARANTINE_PATH = path.join("security", "flaky-tests.json");
const REQUIRED_FIELDS = [
  "test",
  "owner",
  "reason",
  "issue",
  "quarantinedAt",
  "removeBy",
  "evidence"
];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function validateQuarantineDocument(document, options = {}) {
  const root = requireObject(document, "flaky-test registry");
  if (root.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    throw new Error(
      `flaky-test registry schemaVersion must be ${QUARANTINE_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(root.quarantined)) {
    throw new Error("flaky-test registry quarantined must be an array");
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new Error("flaky-test registry requires a valid current time");
  }
  const seen = new Set();
  const entries = root.quarantined.map((rawEntry, index) => {
    const label = `flaky-test registry entry ${index + 1}`;
    const entry = requireObject(rawEntry, label);
    const normalized = {};
    for (const field of REQUIRED_FIELDS) {
      if (field !== "quarantinedAt" && field !== "removeBy") {
        normalized[field] = requireString(entry[field], `${label} ${field}`);
      }
    }
    if (seen.has(normalized.test)) {
      throw new Error(`duplicate quarantined test: ${normalized.test}`);
    }
    seen.add(normalized.test);
    normalized.quarantinedAt = requireTimestamp(
      entry.quarantinedAt,
      `${label} quarantinedAt`
    );
    normalized.removeBy = requireTimestamp(entry.removeBy, `${label} removeBy`);
    if (Date.parse(normalized.quarantinedAt) > now) {
      throw new Error(`${normalized.test} has a future quarantinedAt date`);
    }
    if (Date.parse(normalized.removeBy) <= Date.parse(normalized.quarantinedAt)) {
      throw new Error(`${normalized.test} removeBy must be after quarantinedAt`);
    }
    if (Date.parse(normalized.removeBy) <= now) {
      throw new Error(`${normalized.test} quarantine expired at ${normalized.removeBy}`);
    }
    return normalized;
  });
  entries.sort((left, right) => left.test.localeCompare(right.test));
  return {
    schemaVersion: root.schemaVersion,
    entries
  };
}

async function runTestQuarantineCheck(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const registryPath = path.resolve(
    rootDir,
    options.registryPath || DEFAULT_QUARANTINE_PATH
  );
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : null;
  const now = (options.clock || Date.now)();
  let document;
  try {
    document = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`flaky-test registry not found: ${registryPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`flaky-test registry is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  const validated = validateQuarantineDocument(document, { now });
  const report = {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    kind: QUARANTINE_KIND,
    generatedAt: new Date(now).toISOString(),
    status: "passed",
    registryPath,
    registrySha256: await hashFile(registryPath),
    policy: {
      requiredFields: REQUIRED_FIELDS,
      expiredEntriesBlock: true,
      releasePromotionRequiresRecord: true
    },
    summary: {
      count: validated.entries.length
    },
    entries: validated.entries
  };
  if (outputPath) {
    await writeJsonAtomic(outputPath, report, { mode: 0o600 });
  }
  return { registryPath, outputPath, report };
}

function formatQuarantineReport(report) {
  const lines = [
    `Flaky-test quarantine review: ${report.status.toUpperCase()}`,
    `Registry: ${report.registryPath}`,
    `Quarantined tests: ${report.summary.count}`
  ];
  for (const entry of report.entries) {
    lines.push(`- ${entry.test}: owner=${entry.owner} removeBy=${entry.removeBy}`);
  }
  return lines.join("\n");
}

function parseQuarantineArgs(args) {
  const options = {
    rootDir: process.cwd(),
    registryPath: null,
    outputPath: null,
    json: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const valueOptions = new Map([
      ["--root", "rootDir"],
      ["--registry", "registryPath"],
      ["--output", "outputPath"]
    ]);
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[valueOptions.get(argument)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

module.exports = {
  DEFAULT_QUARANTINE_PATH,
  QUARANTINE_KIND,
  QUARANTINE_SCHEMA_VERSION,
  REQUIRED_FIELDS,
  formatQuarantineReport,
  parseQuarantineArgs,
  runTestQuarantineCheck,
  validateQuarantineDocument
};
