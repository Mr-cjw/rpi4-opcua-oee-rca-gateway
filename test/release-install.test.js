"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runProcess } = require("../src/release/common");
const { createReleasePackage } = require("../src/release/package");
const { signReleaseArchive } = require("../src/release/signature");
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
  "scripts/gateway-commission.js",
  "scripts/gateway-edge-verify.js",
  "scripts/gateway-field-drill.js",
  "scripts/gateway-hardware-check.js",
  "security/advisory-dispositions.json",
  "src/commission/report.js",
  "src/edge/verify.js",
  "src/field-drill/drill.js",
  "src/gateway/index.js",
  "src/hardware/check.js"
];

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  await fs.mkdir(path.join(sourceDir, "src", "gateway"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "src", "edge"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "src", "commission"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "src", "field-drill"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "src", "hardware"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "deploy"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "security"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      { name: "rpi4-release-fixture", version: "0.0.0", engines: { node: ">=22.13.0" } },
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
  await fs.writeFile(path.join(sourceDir, "scripts", "gateway-commission.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "scripts", "gateway-edge-verify.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "scripts", "gateway-field-drill.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "scripts", "gateway-hardware-check.js"), '"use strict";\n');
  await fs.writeFile(
    path.join(sourceDir, "security", "advisory-dispositions.json"),
    '{"schemaVersion":"1.0","dispositions":[]}\n'
  );
  await fs.writeFile(path.join(sourceDir, "src", "commission", "report.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "src", "edge", "verify.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "src", "field-drill", "drill.js"), '"use strict";\n');
  await fs.writeFile(path.join(sourceDir, "src", "hardware", "check.js"), '"use strict";\n');
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

async function createSigningKeys(workspace) {
  const privateKeyPath = path.join(workspace.root, "release-private.pem");
  const publicKeyPath = path.join(workspace.root, "release-public.pem");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await Promise.all([
    fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" })),
    fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }))
  ]);
  return { privateKeyPath, publicKeyPath };
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
  const keys = await createSigningKeys(workspace);
  const signedV3 = await signReleaseArchive({
    archivePath: releaseV3.archivePath,
    privateKeyPath: keys.privateKeyPath
  });
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
      publicKeyPath: keys.publicKeyPath,
      requireSignature: true,
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
  assert.deepEqual(report.signature, {
    verified: true,
    algorithm: "sha256",
    keyFingerprint: signedV3.keyFingerprint
  });
});

test("release installer records a verified detached signature", async (t) => {
  const workspace = await makeWorkspace(t);
  const release = await buildRelease(t, workspace, "5.0.0");
  const keys = await createSigningKeys(workspace);
  const signed = await signReleaseArchive({
    archivePath: release.archivePath,
    privateKeyPath: keys.privateKeyPath
  });

  const installed = await installRelease({
    archivePath: release.archivePath,
    publicKeyPath: keys.publicKeyPath,
    requireSignature: true,
    releaseRoot: workspace.releaseRoot,
    run: fakeCommandRunner([]),
    skipNpmInstall: true,
    healthUrl: "http://health.test/healthz",
    healthTimeoutMs: 1000,
    checkHealth: async () => true
  });

  assert.deepEqual(installed.signature, {
    verified: true,
    algorithm: "sha256",
    keyFingerprint: signed.keyFingerprint
  });
  assert.equal(installed.sbom.format, "CycloneDX");
  assert.equal(installed.sbom.componentCount, 0);
  assert.equal(installed.report.signature.keyFingerprint, signed.keyFingerprint);
  assert.equal(installed.report.sbom.format, "CycloneDX");
  const report = JSON.parse(
    await fs.readFile(path.join(workspace.releaseRoot, RELEASE_OPERATION_FILE), "utf8")
  );
  assert.deepEqual(report.signature, installed.signature);
});

test("release installer rejects an unexpected signing fingerprint before switching", async (t) => {
  const workspace = await makeWorkspace(t);
  const release = await buildRelease(t, workspace, "5.1.0");
  const keys = await createSigningKeys(workspace);
  await signReleaseArchive({
    archivePath: release.archivePath,
    privateKeyPath: keys.privateKeyPath
  });
  const commands = [];
  await assert.rejects(
    installRelease({
      archivePath: release.archivePath,
      publicKeyPath: keys.publicKeyPath,
      expectedKeyFingerprint: "0".repeat(64),
      requireSignature: true,
      releaseRoot: workspace.releaseRoot,
      run: fakeCommandRunner(commands),
      skipNpmInstall: true,
      healthUrl: null
    }),
    /release signer fingerprint mismatch/
  );
  assert.deepEqual(commands, []);
  await assert.rejects(fs.readlink(path.join(workspace.releaseRoot, "current")), /ENOENT/);
});

test("release installer rejects unsigned or tampered archives before switching", async (t) => {
  const workspace = await makeWorkspace(t);
  const unsignedRelease = await buildRelease(t, workspace, "6.0.0");
  const tamperedRelease = await buildRelease(t, workspace, "7.0.0");
  const keys = await createSigningKeys(workspace);
  await signReleaseArchive({
    archivePath: tamperedRelease.archivePath,
    privateKeyPath: keys.privateKeyPath
  });
  await fs.appendFile(tamperedRelease.archivePath, "tampered\n");
  const commands = [];
  const run = fakeCommandRunner(commands);
  const base = {
    releaseRoot: workspace.releaseRoot,
    publicKeyPath: keys.publicKeyPath,
    requireSignature: true,
    run,
    skipNpmInstall: true,
    healthUrl: null
  };

  await assert.rejects(
    installRelease({ ...base, archivePath: unsignedRelease.archivePath }),
    /ENOENT/
  );
  await assert.rejects(
    installRelease({ ...base, archivePath: tamperedRelease.archivePath }),
    /release signature verification failed/
  );
  await assert.rejects(
    installRelease({ ...base, publicKeyPath: undefined, archivePath: unsignedRelease.archivePath }),
    /requires a public key path/
  );
  await assert.rejects(
    fs.readlink(path.join(workspace.releaseRoot, "current")),
    /ENOENT/
  );
  assert.deepEqual(commands, []);
});

test("release installer enforces the manifest's minimum Node.js version", async (t) => {
  const workspace = await makeWorkspace(t);
  await fs.writeFile(
    path.join(workspace.sourceDir, "package.json"),
    `${JSON.stringify(
      { name: "rpi4-release-fixture", version: "0.0.0", engines: { node: ">=99.0.0" } },
      null,
      2
    )}\n`
  );
  const release = await buildRelease(t, workspace, "4.0.0");

  await assert.rejects(
    installRelease({
      archivePath: release.archivePath,
      releaseRoot: workspace.releaseRoot,
      run: fakeCommandRunner([]),
      skipNpmInstall: true,
      healthUrl: null
    }),
    /requires Node\.js 99\.0\.0 or newer/
  );
  await assert.rejects(
    fs.readlink(path.join(workspace.releaseRoot, "current")),
    /ENOENT/
  );
});
