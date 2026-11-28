"use strict";

const fsp = require("node:fs/promises");

const STATE_MIGRATION_SCHEMA_VERSION = "1.0";
const STATE_MIGRATION_KIND = "rpi4-gateway-state-migration";
const STATE_MIGRATION_FILE = "state-migration.json";
const STATE_FORMAT_VERSION_PATTERN = /^\d+\.\d+$/;
const RELEASE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,159}$/;
const IDENTIFIER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,159}$/;
const REQUIRED_PREFLIGHT_RULE = "exact-source-format-and-verified-backup";
const REQUIRED_POST_MIGRATION_RULE =
  "state-format-file-integrity-and-backup-provenance";
const REQUIRED_ROLLBACK_PROCEDURE = "restore-verified-pre-migration-backup";
const REQUIRED_POST_MIGRATION_CHECKS = Object.freeze([
  "state-format-version",
  "state-file-integrity",
  "pre-migration-backup-provenance"
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${value || "missing"}`);
  }
  return value;
}

function requireStateFormatVersion(value, label) {
  if (typeof value !== "string" || !STATE_FORMAT_VERSION_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${value || "missing"}`);
  }
  return value;
}

function validateStateFormatVersion(value, label = "state format version") {
  return requireStateFormatVersion(value, label);
}

function compareStateFormatVersions(left, right) {
  const [leftMajor, leftMinor] = left.split(".").map(Number);
  const [rightMajor, rightMinor] = right.split(".").map(Number);
  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }
  return leftMinor - rightMinor;
}

function validateStateMigrationManifest(manifest, options = {}) {
  requireObject(manifest, "state migration manifest");
  if (manifest.schemaVersion !== STATE_MIGRATION_SCHEMA_VERSION) {
    throw new Error(
      `unsupported state migration schema: ${manifest.schemaVersion || "missing"}`
    );
  }
  if (manifest.kind !== STATE_MIGRATION_KIND) {
    throw new Error(`state migration kind must be ${STATE_MIGRATION_KIND}`);
  }
  requireIdentifier(manifest.migrationId, "state migration id");
  const fromVersion = requireStateFormatVersion(
    manifest.fromVersion,
    "state migration fromVersion"
  );
  const toVersion = requireStateFormatVersion(
    manifest.toVersion,
    "state migration toVersion"
  );
  if (fromVersion === toVersion) {
    throw new Error("state migration fromVersion and toVersion must differ");
  }
  if (compareStateFormatVersions(fromVersion, toVersion) > 0) {
    throw new Error("state migration cannot move to an older state format version");
  }
  if (typeof manifest.releaseId !== "string" || !RELEASE_ID_PATTERN.test(manifest.releaseId)) {
    throw new Error(`state migration releaseId is invalid: ${manifest.releaseId || "missing"}`);
  }
  if (options.releaseId !== undefined && manifest.releaseId !== options.releaseId) {
    throw new Error(
      `state migration releaseId ${manifest.releaseId} does not match release ${options.releaseId}`
    );
  }
  if (options.fromVersion !== undefined && fromVersion !== options.fromVersion) {
    throw new Error(
      `state migration starts at ${fromVersion}, expected ${options.fromVersion}`
    );
  }
  if (options.toVersion !== undefined && toVersion !== options.toVersion) {
    throw new Error(
      `state migration ends at ${toVersion}, expected ${options.toVersion}`
    );
  }

  const preflight = requireObject(manifest.preflight, "state migration preflight");
  if (preflight.ruleId !== REQUIRED_PREFLIGHT_RULE) {
    throw new Error(
      `state migration preflight rule must be ${REQUIRED_PREFLIGHT_RULE}`
    );
  }
  if (preflight.requiredStateFormatVersion !== fromVersion) {
    throw new Error(
      "state migration preflight requiredStateFormatVersion must match fromVersion"
    );
  }
  if (preflight.requireVerifiedBackup !== true) {
    throw new Error("state migration preflight must require a verified backup");
  }

  const backup = requireObject(manifest.backup, "state migration backup");
  if (backup.required !== true) {
    throw new Error("state migration must require a pre-migration backup");
  }
  if (backup.verification !== "sha256-manifest") {
    throw new Error("state migration backup verification must use sha256-manifest");
  }
  if (backup.offDeviceCopyRequired !== true) {
    throw new Error("state migration backup must require an off-device copy");
  }

  const postMigration = requireObject(
    manifest.postMigrationValidation,
    "state migration postMigrationValidation"
  );
  if (postMigration.ruleId !== REQUIRED_POST_MIGRATION_RULE) {
    throw new Error(
      `state migration post-migration rule must be ${REQUIRED_POST_MIGRATION_RULE}`
    );
  }
  if (!Array.isArray(postMigration.checks)) {
    throw new Error("state migration postMigrationValidation.checks must be an array");
  }
  const checks = new Set(postMigration.checks);
  for (const requiredCheck of REQUIRED_POST_MIGRATION_CHECKS) {
    if (!checks.has(requiredCheck)) {
      throw new Error(`state migration post-migration validation is missing ${requiredCheck}`);
    }
  }

  const rollback = requireObject(manifest.rollback, "state migration rollback");
  if (rollback.procedureId !== REQUIRED_ROLLBACK_PROCEDURE) {
    throw new Error(
      `state migration rollback procedure must be ${REQUIRED_ROLLBACK_PROCEDURE}`
    );
  }
  if (rollback.codeOnly !== false) {
    throw new Error("state migration rollback cannot be code-only");
  }
  if (rollback.stateRestoreRequired !== true) {
    throw new Error("state migration rollback must require a state restore");
  }
  if (rollback.verifiedBackupRequired !== true) {
    throw new Error("state migration rollback must require a verified backup");
  }

  return {
    ...manifest,
    fromVersion,
    toVersion,
    preflight: {
      ...preflight,
      requiredStateFormatVersion: preflight.requiredStateFormatVersion
    },
    backup: { ...backup },
    postMigrationValidation: {
      ...postMigration,
      checks: [...postMigration.checks]
    },
    rollback: { ...rollback }
  };
}

async function loadStateMigrationManifest(filePath, options = {}) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`state migration manifest not found: ${filePath}`);
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`state migration manifest is not valid JSON: ${error.message}`);
  }
  return validateStateMigrationManifest(manifest, options);
}

function stateFormatMismatchMessage({ releaseVersion, runtimeVersion, migration }) {
  if (!migration) {
    return `unsupported release state format: ${releaseVersion} (runtime supports ${runtimeVersion}); state migration manifest is required`;
  }
  return `unsupported release state format: ${releaseVersion} (runtime supports ${runtimeVersion}); migration ${migration.migrationId} from ${migration.fromVersion} to ${migration.toVersion} is declared but this runtime cannot execute it`;
}

function assertRuntimeStateFormatCompatibility({
  releaseVersion,
  runtimeVersion,
  migration = null
}) {
  requireStateFormatVersion(releaseVersion, "release state format");
  requireStateFormatVersion(runtimeVersion, "runtime state format");
  if (releaseVersion === runtimeVersion) {
    return {
      compatible: true,
      releaseVersion,
      runtimeVersion,
      migration: null
    };
  }
  if (migration) {
    validateStateMigrationManifest(migration, {
      fromVersion: runtimeVersion,
      toVersion: releaseVersion
    });
  }
  throw new Error(
    stateFormatMismatchMessage({ releaseVersion, runtimeVersion, migration })
  );
}

module.exports = {
  REQUIRED_POST_MIGRATION_CHECKS,
  REQUIRED_POST_MIGRATION_RULE,
  REQUIRED_PREFLIGHT_RULE,
  REQUIRED_ROLLBACK_PROCEDURE,
  STATE_MIGRATION_FILE,
  STATE_MIGRATION_KIND,
  STATE_MIGRATION_SCHEMA_VERSION,
  assertRuntimeStateFormatCompatibility,
  compareStateFormatVersions,
  loadStateMigrationManifest,
  stateFormatMismatchMessage,
  validateStateFormatVersion,
  validateStateMigrationManifest
};
