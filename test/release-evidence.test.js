"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createReleasePackage, verifyReleasePackage } = require("../src/release/package");
const {
  signReleaseArchive,
  verifyReleaseArchiveSignature
} = require("../src/release/signature");
const { generateReleaseAudit } = require("../src/release/vulnerability-audit");
const {
  createReleaseEvidence,
  evidenceSidecarPathForArchive,
  verifyReleaseEvidence
} = require("../src/release/evidence");

const NOW = Date.parse("2026-11-28T06:00:00.000Z");
const COMMIT = "a".repeat(40);
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

function emptyAudit() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 0, dev: 0, optional: 0, total: 0 }
    }
  };
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  for (const directory of [
    "deploy",
    "scripts",
    "security",
    "src/commission",
    "src/edge",
    "src/field-drill",
    "src/gateway",
    "src/hardware"
  ]) {
    await fs.mkdir(path.join(sourceDir, directory), { recursive: true });
  }
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rpi4-evidence-fixture",
        version: "1.0.0",
        engines: { node: ">=22.13.0" }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(sourceDir, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(sourceDir, "README.md"), "# Evidence fixture\n");
  await fs.writeFile(
    path.join(sourceDir, "deploy", "rpi4-gateway.service"),
    "[Service]\nExecStart=/usr/bin/node src/gateway/index.js\n"
  );
  for (const file of [
    "scripts/gateway-commission.js",
    "scripts/gateway-edge-verify.js",
    "scripts/gateway-field-drill.js",
    "scripts/gateway-hardware-check.js",
    "src/commission/report.js",
    "src/edge/verify.js",
    "src/field-drill/drill.js",
    "src/gateway/index.js",
    "src/hardware/check.js"
  ]) {
    await fs.writeFile(path.join(sourceDir, file), '"use strict";\n');
  }
  await fs.writeFile(
    path.join(sourceDir, "security", "advisory-dispositions.json"),
    '{"schemaVersion":"1.0","dispositions":[]}\n'
  );
  return { root, sourceDir };
}

async function buildArtifacts(t) {
  const fixture = await makeFixture(t);
  const outputDir = path.join(fixture.root, "dist");
  const release = await createReleasePackage({
    rootDir: fixture.sourceDir,
    outputDir,
    source: { files: RELEASE_FILES, commit: COMMIT, dirty: false },
    clock: () => NOW
  });
  const archivePath = release.archivePath;
  const sbomPath = `${archivePath.slice(0, -7)}.sbom.cdx.json`;
  const auditPath = `${archivePath.slice(0, -7)}.audit.json`;
  const vexPath = `${archivePath.slice(0, -7)}.vex.cdx.json`;
  const verified = await verifyReleasePackage({ archivePath });
  try {
    await fs.copyFile(
      path.join(verified.extractDir, verified.manifest.sbom.path),
      sbomPath
    );
  } finally {
    await verified.cleanup();
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = path.join(fixture.root, "release-private.pem");
  const publicKeyPath = path.join(fixture.root, "release-public.pem");
  await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  await signReleaseArchive({ archivePath, privateKeyPath });
  const signature = await verifyReleaseArchiveSignature({
    archivePath,
    signaturePath: `${archivePath}.sig`,
    publicKeyPath
  });
  await generateReleaseAudit({
    archivePath,
    dispositionsPath: path.join(fixture.sourceDir, "security", "advisory-dispositions.json"),
    outputPath: auditPath,
    vexOutputPath: vexPath,
    signature,
    run: async () => ({ stdout: JSON.stringify(emptyAudit()), stderr: "" }),
    clock: () => NOW
  });
  return {
    root: fixture.root,
    archivePath,
    sbomPath,
    auditPath,
    vexPath,
    signaturePath: `${archivePath}.sig`,
    publicKeyPath
  };
}

test("release evidence binds all signed release artifacts and verifies offline", async (t) => {
  const artifacts = await buildArtifacts(t);
  const outputPath = evidenceSidecarPathForArchive(artifacts.archivePath);
  const created = await createReleaseEvidence({
    archivePath: artifacts.archivePath,
    sbomPath: artifacts.sbomPath,
    auditPath: artifacts.auditPath,
    vexPath: artifacts.vexPath,
    signaturePath: artifacts.signaturePath,
    publicKeyPath: artifacts.publicKeyPath,
    outputPath,
    clock: () => NOW
  });

  assert.equal(created.evidence.status, "passed");
  assert.equal(created.evidence.artifacts.signature.algorithm, "sha256");
  assert.match(created.evidence.artifacts.signature.keyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(created.evidence.artifacts.dispositions.path, "security/advisory-dispositions.json");
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);

  const verified = await verifyReleaseEvidence({
    evidencePath: outputPath,
    publicKeyPath: artifacts.publicKeyPath,
    clock: () => NOW
  });
  assert.equal(verified.status, "passed");
  assert.equal(verified.release.releaseId, created.evidence.release.releaseId);
  assert.equal(verified.artifacts.archive.sha256, created.evidence.artifacts.archive.sha256);
});

test("release evidence verification rejects changed sidecars and missing keys", async (t) => {
  const artifacts = await buildArtifacts(t);
  const outputPath = evidenceSidecarPathForArchive(artifacts.archivePath);
  await createReleaseEvidence({
    archivePath: artifacts.archivePath,
    sbomPath: artifacts.sbomPath,
    auditPath: artifacts.auditPath,
    vexPath: artifacts.vexPath,
    signaturePath: artifacts.signaturePath,
    publicKeyPath: artifacts.publicKeyPath,
    outputPath,
    clock: () => NOW
  });
  await assert.rejects(
    verifyReleaseEvidence({ evidencePath: outputPath, clock: () => NOW }),
    /requires a public key/
  );
  await fs.appendFile(artifacts.auditPath, "\n");
  await assert.rejects(
    verifyReleaseEvidence({
      evidencePath: outputPath,
      publicKeyPath: artifacts.publicKeyPath,
      clock: () => NOW
    }),
    /artifacts or bindings changed/
  );
});

test("release evidence sidecar path is derived from the archive name", () => {
  assert.equal(
    evidenceSidecarPathForArchive("/tmp/release-1.0.0.tar.gz"),
    "/tmp/release-1.0.0.evidence.json"
  );
});
