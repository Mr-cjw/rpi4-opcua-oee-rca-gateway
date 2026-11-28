"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { STATE_FORMAT_VERSION } = require("../src/gateway/state-format");
const { verifyStateBackup } = require("../src/gateway/state-backup");
const {
  assertRuntimeStateFormatCompatibility,
  validateStateMigrationManifest
} = require("../src/release/state-migration");

const FIXTURE_DIRECTORY = path.join(__dirname, "fixtures", "state-format-v2");

async function migrationFixture() {
  return JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIRECTORY, "state-migration.json"), "utf8")
  );
}

test("synthetic v1 to v2 migration manifest is structurally complete", async () => {
  const migration = validateStateMigrationManifest(await migrationFixture(), {
    releaseId: "2.0.0-state-v2-fixture",
    fromVersion: STATE_FORMAT_VERSION,
    toVersion: "2.0"
  });

  assert.equal(migration.migrationId, "state-format-1-0-to-2-0");
  assert.equal(migration.preflight.requireVerifiedBackup, true);
  assert.equal(migration.backup.offDeviceCopyRequired, true);
  assert.equal(migration.rollback.codeOnly, false);
  assert.deepEqual(migration.postMigrationValidation.checks, [
    "state-format-version",
    "state-file-integrity",
    "pre-migration-backup-provenance"
  ]);
});

test("migration manifest rejects missing preflight, backup, validation, and rollback controls", async () => {
  const migration = await migrationFixture();

  assert.throws(
    () =>
      validateStateMigrationManifest({
        ...migration,
        backup: { ...migration.backup, required: false }
      }),
    /must require a pre-migration backup/
  );
  assert.throws(
    () =>
      validateStateMigrationManifest({
        ...migration,
        preflight: { ...migration.preflight, requireVerifiedBackup: false }
      }),
    /must require a verified backup/
  );
  assert.throws(
    () =>
      validateStateMigrationManifest({
        ...migration,
        postMigrationValidation: {
          ...migration.postMigrationValidation,
          checks: ["state-format-version"]
        }
      }),
    /missing state-file-integrity/
  );
  assert.throws(
    () =>
      validateStateMigrationManifest({
        ...migration,
        rollback: { ...migration.rollback, codeOnly: true }
      }),
    /cannot be code-only/
  );
  assert.throws(
    () => validateStateMigrationManifest(migration, { releaseId: "different-release" }),
    /does not match release/
  );
});

test("current runtime rejects v2 release and state backup formats with specific diagnostics", async () => {
  const migration = await migrationFixture();

  assert.throws(
    () =>
      assertRuntimeStateFormatCompatibility({
        releaseVersion: "2.0",
        runtimeVersion: STATE_FORMAT_VERSION,
        migration
      }),
    /unsupported release state format: 2\.0 \(runtime supports 1\.0\); migration state-format-1-0-to-2-0/
  );
  assert.throws(
    () =>
      assertRuntimeStateFormatCompatibility({
        releaseVersion: "2.0",
        runtimeVersion: STATE_FORMAT_VERSION
      }),
    /state migration manifest is required/
  );
  await assert.rejects(
    verifyStateBackup({ backupDir: FIXTURE_DIRECTORY }),
    /unsupported state format: 2\.0 \(runtime supports 1\.0\)/
  );
});
