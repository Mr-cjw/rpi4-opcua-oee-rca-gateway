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
  "src/gateway/index.js"
];

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "gateway"), { recursive: true });
  await fs.mkdir(path.join(root, "deploy"), { recursive: true });
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
  assert.equal(result.manifest.fileCount, RELEASE_FILES.length);
  assert.equal(result.manifest.createdAt, new Date(NOW).toISOString());
  assert.equal(result.manifest.runtime.minimumNodeMajor, 22);
  assert.equal(result.manifest.runtime.minimumNodeVersion, "22.13.0");
  assert.match(
    await fs.readFile(result.checksumPath, "utf8"),
    new RegExp(`^${result.archiveSha256}  ${path.basename(result.archivePath)}$`, "m")
  );

  const verified = await verifyReleasePackage({ archivePath: result.archivePath });
  try {
    assert.equal(verified.manifest.releaseId, result.manifest.releaseId);
    assert.equal(verified.manifest.files.length, RELEASE_FILES.length);
    assert.equal(verified.archiveSha256, result.archiveSha256);
    assert.ok(
      await fs.stat(path.join(verified.extractDir, MANIFEST_FILE)).then((stats) => stats.isFile())
    );
    assert.ok(
      await fs.stat(path.join(verified.extractDir, CHECKSUM_FILE)).then((stats) => stats.isFile())
    );
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
