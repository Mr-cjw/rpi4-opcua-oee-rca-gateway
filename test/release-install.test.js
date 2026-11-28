"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runProcess } = require("../src/release/common");
const { createReleasePackage } = require("../src/release/package");
const {
  RELEASE_OPERATION_FILE,
  installRelease,
  listReleases,
  rollbackRelease
} = require("../src/release/installer");

const COMMIT = "b".repeat(40);
const RELEASE_FILES = [
  "README.md",
  "deploy/rpi4-gateway.service",
  "package-lock.json",
  "package.json",
  "src/gateway/index.js"
];

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  await fs.mkdir(path.join(sourceDir, "src", "gateway"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "deploy"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      { name: "rpi4-release-fixture", version: "0.0.0", engines: { node: ">=20" } },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(sourceDir, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(sourceDir, "README.md"), "# Installed fixture\n");
  await fs.writeFile(
    path.join(sourceDir, "deploy", "rpi4-gateway.service"),
    "[Service]\nExecStart=/usr/bin/node src/gateway/index.js\n"
  );
  await fs.writeFile(path.join(sourceDir, "src", "gateway", "index.js"), '"use strict";\n');
  const releaseRoot = path.join(root, "release-root");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, "quality-events.jsonl"), '{"state":"preserved"}\n');
  return { root, sourceDir, releaseRoot, stateDir };
}

async function buildRelease(t, workspace, version) {
  const outputDir = path.join(workspace.root, `dist-${version}`);
  return createReleasePackage({
    rootDir: workspace.sourceDir,
    outputDir,
    version,
    source: {
      files: RELEASE_FILES,
      commit: COMMIT,
      dirty: false
    }
  });
}

function fakeCommandRunner(commands) {
  return async (command, args, options) => {
    commands.push([command, ...args].join(" "));
    if (command === "tar") {
      return runProcess(command, args, options);
    }
    return { stdout: "", stderr: "" };
  };
}

async function linkReleaseId(linkPath) {
  return path.basename(await fs.readlink(linkPath));
}

test("release installer switches atomically and supports explicit rollback", async (t) => {
  const workspace = await makeWorkspace(t);
  const releaseV1 = await buildRelease(t, workspace, "1.0.0");
  const releaseV2 = await buildRelease(t, workspace, "2.0.0");
  const commands = [];
  const run = fakeCommandRunner(commands);
  const common = {
    releaseRoot: workspace.releaseRoot,
    run,
    skipNpmInstall: true,
    healthUrl: "http://health.test/healthz",
    healthTimeoutMs: 1000,
    checkHealth: async () => true,
    service: "rpi4-gateway"
  };

  const first = await installRelease({ ...common, archivePath: releaseV1.archivePath });
  assert.equal(first.previousReleaseId, null);
  assert.equal(await linkReleaseId(path.join(workspace.releaseRoot, "current")), first.releaseId);
  assert.equal(
    await fs.readFile(path.join(workspace.stateDir, "quality-events.jsonl"), "utf8"),
    '{"state":"preserved"}\n'
  );

  const second = await installRelease({ ...common, archivePath: releaseV2.archivePath });
  assert.equal(second.previousReleaseId, first.releaseId);
  assert.equal(await linkReleaseId(path.join(workspace.releaseRoot, "current")), second.releaseId);
  assert.equal(
    await linkReleaseId(path.join(workspace.releaseRoot, "previous")),
    first.releaseId
  );

  const rolledBack = await rollbackRelease(common);
  assert.equal(rolledBack.releaseId, first.releaseId);
  assert.equal(rolledBack.previousReleaseId, second.releaseId);
  assert.equal(await linkReleaseId(path.join(workspace.releaseRoot, "current")), first.releaseId);
  assert.equal(
    await linkReleaseId(path.join(workspace.releaseRoot, "previous")),
    second.releaseId
  );

  const status = await listReleases({ releaseRoot: workspace.releaseRoot });
  assert.equal(status.current, first.releaseId);
  assert.equal(status.previous, second.releaseId);
  assert.equal(status.releases.length, 2);
  assert.ok(status.releases.every((release) => release.error === null));
  const report = JSON.parse(
    await fs.readFile(path.join(workspace.releaseRoot, RELEASE_OPERATION_FILE), "utf8")
  );
  assert.equal(report.action, "rollback");
  assert.ok(commands.filter((command) => command === "systemctl stop rpi4-gateway").length >= 3);
});

test("release installer restores the previous release when the new health check fails", async (t) => {
  const workspace = await makeWorkspace(t);
  const releaseV1 = await buildRelease(t, workspace, "1.0.0");
  const releaseV3 = await buildRelease(t, workspace, "3.0.0");
  const run = fakeCommandRunner([]);
  const releaseRoot = workspace.releaseRoot;
  const currentLink = path.join(releaseRoot, "current");
  const base = {
    releaseRoot,
    run,
    skipNpmInstall: true,
    healthUrl: "http://health.test/healthz",
    healthTimeoutMs: 1,
    service: "rpi4-gateway",
    checkHealth: async () => true
  };
  const installed = await installRelease({ ...base, archivePath: releaseV1.archivePath });

  await assert.rejects(
    installRelease({
      ...base,
      archivePath: releaseV3.archivePath,
      checkHealth: async () => (await linkReleaseId(currentLink)) !== releaseV3.manifest.releaseId,
      sleep: async () => undefined
    }),
    new RegExp(`restored ${installed.releaseId}`)
  );
  assert.equal(await linkReleaseId(currentLink), installed.releaseId);
  await assert.rejects(fs.readlink(path.join(releaseRoot, "previous")), /ENOENT/);
  const report = JSON.parse(
    await fs.readFile(path.join(releaseRoot, RELEASE_OPERATION_FILE), "utf8")
  );
  assert.equal(report.action, "install-failed");
  assert.equal(report.releaseId, releaseV3.manifest.releaseId);
});
