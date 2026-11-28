"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const {
  CHECKSUM_FILE,
  MANIFEST_FILE,
  SBOM_FILE,
  createReleasePackage,
  verifyReleasePackage
} = require("../src/release/package");

const execFileAsync = promisify(execFile);
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

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "gateway"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "edge"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "commission"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "field-drill"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "hardware"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "deploy"), { recursive: true });
  await fs.mkdir(path.join(root, "security"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "rpi4-release-fixture",
        version: "1.2.3",
        engines: { node: ">=22.13.0" }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(root, "README.md"), "# Release fixture\n");
  await fs.writeFile(
    path.join(root, "deploy", "rpi4-gateway.service"),
    "[Service]\nExecStart=/usr/bin/node src/gateway/index.js\n"
  );
  await fs.writeFile(path.join(root, "scripts", "gateway-commission.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "scripts", "gateway-edge-verify.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "scripts", "gateway-field-drill.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "scripts", "gateway-hardware-check.js"), '"use strict";\n');
  await fs.writeFile(
    path.join(root, "security", "advisory-dispositions.json"),
    '{"schemaVersion":"1.0","dispositions":[]}\n'
  );
  await fs.writeFile(path.join(root, "src", "commission", "report.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "src", "edge", "verify.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "src", "field-drill", "drill.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "src", "hardware", "check.js"), '"use strict";\n');
  await fs.writeFile(path.join(root, "src", "gateway", "index.js"), '"use strict";\n');
  return root;
}

function source(overrides = {}) {
  return {
    files: RELEASE_FILES,
    commit: COMMIT,
    dirty: false,
    ...overrides
  };
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

test("release package includes a manifest, internal checksums, and archive checksum", async (t) => {
  const root = await makeFixture(t);
  const outputDir = path.join(root, "dist");
  const result = await createReleasePackage({
    rootDir: root,
    outputDir,
    source: source(),
    clock: () => NOW
  });

  assert.equal(result.manifest.schemaVersion, "1.0");
  assert.equal(result.manifest.releaseId, "1.2.3-aaaaaaaaaaaa");
  assert.equal(result.manifest.fileCount, RELEASE_FILES.length + 1);
  assert.equal(result.manifest.createdAt, new Date(NOW).toISOString());
  assert.equal(result.manifest.runtime.minimumNodeMajor, 22);
  assert.equal(result.manifest.runtime.minimumNodeVersion, "22.13.0");
  assert.equal(result.manifest.sbom.path, SBOM_FILE);
  assert.equal(result.manifest.sbom.format, "CycloneDX");
  assert.equal(result.sbom.componentCount, 0);
  assert.match(
    await fs.readFile(result.checksumPath, "utf8"),
    new RegExp(`^${result.archiveSha256}  ${path.basename(result.archivePath)}$`, "m")
  );

  const verified = await verifyReleasePackage({ archivePath: result.archivePath });
  try {
    assert.equal(verified.manifest.releaseId, result.manifest.releaseId);
    assert.equal(verified.manifest.files.length, RELEASE_FILES.length + 1);
    assert.equal(verified.archiveSha256, result.archiveSha256);
    assert.equal(verified.sbom.componentCount, result.manifest.sbom.componentCount);
    assert.ok(
      await fs.stat(path.join(verified.extractDir, MANIFEST_FILE)).then((stats) => stats.isFile())
    );
    assert.ok(
      await fs.stat(path.join(verified.extractDir, CHECKSUM_FILE)).then((stats) => stats.isFile())
    );
    const sbom = JSON.parse(
      await fs.readFile(path.join(verified.extractDir, SBOM_FILE), "utf8")
    );
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.metadata.component.name, "rpi4-release-fixture");
    assert.equal(sbom.metadata.component.version, "1.2.3");
  } finally {
    await verified.cleanup();
  }
});

test("release package rejects dirty tracked changes and missing required files", async (t) => {
  const root = await makeFixture(t);
  await assert.rejects(
    createReleasePackage({
      rootDir: root,
      outputDir: path.join(root, "dirty"),
      source: source({ dirty: true })
    }),
    /refusing to package tracked changes/
  );
  await assert.rejects(
    createReleasePackage({
      rootDir: root,
      outputDir: path.join(root, "missing"),
      source: source({ files: RELEASE_FILES.filter((file) => file !== "src/gateway/index.js") })
    }),
    /missing required file: src\/gateway\/index.js/
  );
});

test("release verification rejects archive checksum and file-content tampering", async (t) => {
  const root = await makeFixture(t);
  const result = await createReleasePackage({
    rootDir: root,
    outputDir: path.join(root, "dist"),
    source: source(),
    clock: () => NOW
  });

  await assert.rejects(
    verifyReleasePackage({
      archivePath: result.archivePath,
      expectedArchiveSha256: "0".repeat(64)
    }),
    /changed after signature verification/
  );

  await fs.writeFile(
    result.checksumPath,
    `${"0".repeat(64)}  ${path.basename(result.archivePath)}\n`
  );
  await assert.rejects(
    verifyReleasePackage({ archivePath: result.archivePath }),
    /archive checksum mismatch/
  );

  const verified = await verifyReleasePackage({
    archivePath: result.archivePath,
    checksumPath: path.join(root, "missing.sha256"),
    requireChecksum: false
  });
  const tamperedDir = verified.extractDir;
  try {
    await fs.appendFile(path.join(tamperedDir, "README.md"), "tampered\n");
    const tamperedArchive = path.join(root, "tampered.tar.gz");
    await execFileAsync("tar", ["-czf", tamperedArchive, "-C", tamperedDir, "."]);
    const tamperedChecksum = `${await sha256(tamperedArchive)}  ${path.basename(tamperedArchive)}\n`;
    const tamperedChecksumPath = `${tamperedArchive}.sha256`;
    await fs.writeFile(tamperedChecksumPath, tamperedChecksum);
    await assert.rejects(
      verifyReleasePackage({
        archivePath: tamperedArchive,
        checksumPath: tamperedChecksumPath
      }),
      /release (size|checksum) mismatch for README\.md/
    );
  } finally {
    await verified.cleanup();
  }
});

test("release package CLI accepts a version override for rehearsal archives", async (t) => {
  const root = await makeFixture(t);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "release-test@example.invalid"], {
    cwd: root
  });
  await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

  const script = path.join(__dirname, "..", "scripts", "gateway-release.js");
  const outputDir = path.join(root, "dist-cli");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      script,
      "package",
      "--root",
      root,
      "--output",
      outputDir,
      "--version",
      "9.8.7-rehearsal-cli",
      "--json"
    ],
    { cwd: path.join(__dirname, "..") }
  );
  const result = JSON.parse(stdout);
  assert.equal(result.manifest.version, "9.8.7-rehearsal-cli");
  assert.match(result.manifest.releaseId, /^9\.8\.7-rehearsal-cli-[0-9a-f]{12}$/);
  assert.match(path.basename(result.archivePath), /^rpi4-release-fixture-9\.8\.7-rehearsal-cli-/);
});
