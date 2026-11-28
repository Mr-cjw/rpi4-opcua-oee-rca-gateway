"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseSupplyChainArgs,
  runSupplyChainReview
} = require("../src/release/supply-chain");

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const ROOT = path.resolve(__dirname, "..");

function packageManifest(overrides = {}) {
  return {
    name: "supply-chain-fixture",
    version: "1.0.0",
    dependencies: {
      alpha: "1.0.0",
      "@scope/bravo": "^2.0.0"
    },
    devDependencies: {
      "dev-tool": "^3.0.0"
    },
    optionalDependencies: {
      "optional-native": "1.0.0"
    },
    engines: { node: ">=22.13.0" },
    ...overrides
  };
}

function packageLock(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        optionalDependencies: manifest.optionalDependencies,
        engines: manifest.engines
      },
      "node_modules/alpha": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
        integrity: "sha512-alpha",
        license: "MIT"
      },
      "node_modules/alpha/node_modules/transitive": {
        version: "4.0.0",
        resolved: "https://registry.npmjs.org/transitive/-/transitive-4.0.0.tgz",
        integrity: "sha512-transitive",
        license: "ISC"
      },
      "node_modules/@scope/bravo": {
        version: "2.1.0",
        resolved: "https://registry.npmjs.org/@scope/bravo/-/bravo-2.1.0.tgz",
        integrity: "sha512-bravo",
        license: "Apache-2.0"
      },
      "node_modules/optional-native": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/optional-native/-/optional-native-1.0.0.tgz",
        integrity: "sha512-optional",
        license: "BSD-3-Clause",
        optional: true
      },
      "node_modules/dev-tool": {
        version: "3.1.0",
        resolved: "https://registry.npmjs.org/dev-tool/-/dev-tool-3.1.0.tgz",
        integrity: "sha512-dev",
        license: "MIT",
        dev: true
      }
    }
  };
}

function workflow(nodeVersions = ["22.13.0", "24"]) {
  return [
    "jobs:",
    "  unit:",
    "    strategy:",
    "      matrix:",
    "        node-version:",
    ...nodeVersions.map((version) => `          - ${version}`),
    ""
  ].join("\n");
}

function emptyDispositions() {
  return { schemaVersion: "1.0", dispositions: [] };
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supply-chain-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "security"), { recursive: true });
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  return root;
}

async function writeFixture(root, options = {}) {
  const manifest = packageManifest(options.manifestOverrides);
  const lock = packageLock(manifest);
  if (options.mutateLock) {
    options.mutateLock(lock);
  }
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, ".github", "workflows", "ci.yml"),
    workflow(options.nodeVersions)
  );
  await fs.writeFile(
    path.join(root, "security", "advisory-dispositions.json"),
    `${JSON.stringify(options.dispositions || emptyDispositions(), null, 2)}\n`
  );
  return { manifest, lock };
}

async function mode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("supply-chain baseline passes and detects lockfile and dependency drift", async (t) => {
  const root = await makeRoot(t);
  await writeFixture(root);
  const baselinePath = path.join(root, "security", "supply-chain-baseline.json");
  const outputPath = path.join(root, "review.json");

  const written = await runSupplyChainReview({
    rootDir: root,
    writeBaseline: true,
    outputPath,
    clock: () => NOW
  });
  assert.equal(written.report.status, "passed");
  assert.equal(written.report.baselineWritten, true);
  assert.equal(written.report.current.production.componentCount, 4);
  assert.deepEqual(
    written.report.current.production.directDependencies.map((entry) => entry.name),
    ["@scope/bravo", "alpha", "optional-native"]
  );
  assert.equal(await mode(baselinePath), 0o644);
  assert.equal(await mode(outputPath), 0o600);

  const passed = await runSupplyChainReview({ rootDir: root, clock: () => NOW });
  assert.equal(passed.report.status, "passed");
  assert.equal(passed.report.baselineWritten, false);

  await writeFixture(root, {
    mutateLock(lock) {
      lock.packages["node_modules/alpha"].integrity = "sha512-tampered";
    }
  });
  const lockDrift = await runSupplyChainReview({ rootDir: root, clock: () => NOW });
  assert.equal(lockDrift.report.status, "failed");
  assert.equal(
    lockDrift.report.checks.find((check) => check.name === "lockfile-digest").status,
    "fail"
  );
  assert.equal(
    lockDrift.report.checks.find((check) => check.name === "production-inventory").status,
    "fail"
  );

  await writeFixture(root, {
    manifestOverrides: {
      dependencies: { alpha: "^1.1.0", "@scope/bravo": "^2.0.0" }
    }
  });
  const manifestDrift = await runSupplyChainReview({ rootDir: root, clock: () => NOW });
  assert.equal(manifestDrift.report.status, "failed");
  assert.equal(
    manifestDrift.report.checks.find((check) => check.name === "manifest-baseline").status,
    "fail"
  );
});

test("supply-chain review rejects expired VEX dispositions and missing baselines", async (t) => {
  const expiredRoot = await makeRoot(t);
  await writeFixture(expiredRoot, {
    dispositions: {
      schemaVersion: "1.0",
      dispositions: [
        {
          id: "GHSA-aaaa-bbbb-cccc",
          package: "alpha",
          state: "not_affected",
          justification: "code_not_present",
          detail: "Fixture advisory is not reachable.",
          owner: "security",
          expiresAt: "2026-11-01T00:00:00.000Z"
        }
      ]
    }
  });
  await assert.rejects(
    runSupplyChainReview({ rootDir: expiredRoot, writeBaseline: true, clock: () => NOW }),
    /expired dispositions/
  );

  const missingBaselineRoot = await makeRoot(t);
  await writeFixture(missingBaselineRoot);
  const missing = await runSupplyChainReview({
    rootDir: missingBaselineRoot,
    clock: () => NOW
  });
  assert.equal(missing.report.status, "failed");
  assert.equal(
    missing.report.checks.find((check) => check.name === "baseline-loaded").status,
    "fail"
  );
});

test("supply-chain review requires CI coverage for the minimum Node runtime", async (t) => {
  const missingMinimum = await makeRoot(t);
  await writeFixture(missingMinimum, { nodeVersions: ["24"] });
  await assert.rejects(
    runSupplyChainReview({ rootDir: missingMinimum, writeBaseline: true, clock: () => NOW }),
    /does not cover the minimum runtime 22\.13\.0/
  );

  const oneMajor = await makeRoot(t);
  await writeFixture(oneMajor, { nodeVersions: ["22.13.0"] });
  await assert.rejects(
    runSupplyChainReview({ rootDir: oneMajor, writeBaseline: true, clock: () => NOW }),
    /at least two runtime majors/
  );
});

test("supply-chain arguments and CLI use exit code 2 for usage errors", async (t) => {
  assert.throws(() => parseSupplyChainArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseSupplyChainArgs(["--root"]), /requires a value/);
  const parsed = parseSupplyChainArgs([
    "--root",
    "/tmp/repo",
    "--baseline",
    "/tmp/baseline.json",
    "--output",
    "/tmp/review.json",
    "--write-baseline",
    "--json"
  ]);
  assert.equal(parsed.rootDir, "/tmp/repo");
  assert.equal(parsed.baselinePath, "/tmp/baseline.json");
  assert.equal(parsed.outputPath, "/tmp/review.json");
  assert.equal(parsed.writeBaseline, true);
  assert.equal(parsed.json, true);
  assert.equal(parseSupplyChainArgs(["--help"]).help, true);

  const script = path.join(ROOT, "scripts", "check-supply-chain.js");
  const invalid = spawnSync(process.execPath, [script, "--unknown"], {
    encoding: "utf8"
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown option: --unknown/);

  const missing = spawnSync(process.execPath, [script, "--root"], {
    encoding: "utf8"
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--root requires a value/);

  const repository = await runSupplyChainReview({ rootDir: ROOT });
  assert.equal(repository.report.status, "passed");
});
