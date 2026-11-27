"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MANIFEST_FILE,
  createStateBackup,
  restoreStateBackup,
  verifyStateBackup
} = require("../src/gateway/state-backup");

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-state-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const config = {
    context: {
      logPath: path.join(stateDir, "process-context.jsonl"),
      logMaxFiles: 2
    },
    quality: {
      logPath: path.join(stateDir, "quality-events.jsonl"),
      logMaxFiles: 1,
      idempotencyPath: path.join(stateDir, "quality-idempotency.json")
    },
    workContext: {
      statePath: path.join(stateDir, "work-context.json")
    }
  };
  await fs.writeFile(config.context.logPath, '{"kind":"context"}\n');
  await fs.writeFile(`${config.context.logPath}.1`, '{"kind":"context-old"}\n');
  await fs.writeFile(config.quality.logPath, '{"kind":"quality"}\n', { mode: 0o640 });
  await fs.writeFile(
    config.quality.idempotencyPath,
    '{"schemaVersion":"1.0","entries":[]}\n',
    { mode: 0o600 }
  );
  await fs.writeFile(
    config.workContext.statePath,
    '{"schemaVersion":"1.0","workOrderId":"WO-BACKUP"}\n',
    { mode: 0o600 }
  );
  return { root, stateDir, config };
}

test("state backup records checksums and missing optional files", async (t) => {
  const fixture = await makeFixture(t);
  const outputPath = path.join(fixture.root, "backup");
  const result = await createStateBackup({
    stateDir: fixture.stateDir,
    outputPath,
    config: fixture.config,
    clock: () => NOW
  });

  assert.equal(result.manifest.schemaVersion, "1.0");
  assert.equal(result.manifest.fileCount, 5);
  assert.equal(result.manifest.createdAt, new Date(NOW).toISOString());
  assert.deepEqual(result.manifest.missingFiles.sort(), [
    "process-context.jsonl.2",
    "quality-events.jsonl.1"
  ]);
  assert.ok(result.manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert.equal(
    result.manifest.files.find((entry) => entry.path === "quality-idempotency.json").mode,
    0o600
  );

  const verified = await verifyStateBackup({ backupDir: outputPath });
  assert.equal(verified.manifest.fileCount, 5);
  assert.equal(
    (await fs.stat(path.join(outputPath, MANIFEST_FILE))).mode & 0o777,
    0o600
  );
  await assert.rejects(
    createStateBackup({
      stateDir: fixture.stateDir,
      outputPath,
      config: fixture.config
    }),
    /already exists/
  );
});

test("state backup verification rejects tampering and unsafe manifest paths", async (t) => {
  const fixture = await makeFixture(t);
  const outputPath = path.join(fixture.root, "backup");
  await createStateBackup({
    stateDir: fixture.stateDir,
    outputPath,
    config: fixture.config
  });

  const tamperedPath = path.join(outputPath, "process-context.jsonl");
  await fs.appendFile(tamperedPath, "tampered\n");
  await assert.rejects(
    verifyStateBackup({ backupDir: outputPath }),
    /size mismatch|checksum mismatch/
  );

  const manifestPath = path.join(outputPath, MANIFEST_FILE);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.files[0].path = "../escape.jsonl";
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyStateBackup({ backupDir: outputPath }),
    /unsafe segment|escapes the state directory/
  );
});

test("state restore verifies the backup and can atomically overwrite files", async (t) => {
  const fixture = await makeFixture(t);
  const outputPath = path.join(fixture.root, "backup");
  await createStateBackup({
    stateDir: fixture.stateDir,
    outputPath,
    config: fixture.config
  });
  const restoreDir = path.join(fixture.root, "restored");

  const restored = await restoreStateBackup({
    backupDir: outputPath,
    stateDir: restoreDir
  });
  assert.equal(restored.restoredFiles.length, 5);
  assert.equal(
    await fs.readFile(path.join(restoreDir, "work-context.json"), "utf8"),
    await fs.readFile(fixture.config.workContext.statePath, "utf8")
  );
  assert.equal(
    (await fs.stat(path.join(restoreDir, "quality-events.jsonl"))).mode & 0o777,
    0o640
  );

  const restoredContext = path.join(restoreDir, "process-context.jsonl");
  await fs.writeFile(restoredContext, "changed while stopped\n");
  await assert.rejects(
    restoreStateBackup({ backupDir: outputPath, stateDir: restoreDir }),
    /refusing to overwrite/
  );
  assert.equal(await fs.readFile(restoredContext, "utf8"), "changed while stopped\n");

  const orphanPath = path.join(restoreDir, "unrelated.txt");
  await fs.writeFile(orphanPath, "keep me\n");
  await restoreStateBackup({ backupDir: outputPath, stateDir: restoreDir, force: true });
  assert.equal(await fs.readFile(restoredContext, "utf8"), '{"kind":"context"}\n');
  assert.equal(await fs.readFile(orphanPath, "utf8"), "keep me\n");
});

test("state backup refuses configured files outside the state directory", async (t) => {
  const fixture = await makeFixture(t);
  const outsidePath = path.join(fixture.root, "outside.jsonl");
  await fs.writeFile(outsidePath, '{"outside":true}\n');
  await assert.rejects(
    createStateBackup({
      stateDir: fixture.stateDir,
      outputPath: path.join(fixture.root, "backup"),
      config: {
        ...fixture.config,
        context: { logPath: outsidePath, logMaxFiles: 0 }
      }
    }),
    /outside/
  );
});
