"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { hashFile, writeJsonAtomic } = require("./common");
const { loadDispositionDocument } = require("./vulnerability-audit");

const SUPPLY_CHAIN_SCHEMA_VERSION = "1.0";
const SUPPLY_CHAIN_KIND = "rpi4-gateway-supply-chain-review";
const SUPPLY_CHAIN_BASELINE_KIND = "rpi4-gateway-supply-chain-baseline";
const DEFAULT_BASELINE_PATH = path.join("security", "supply-chain-baseline.json");
const DEFAULT_DISPOSITIONS_PATH = path.join("security", "advisory-dispositions.json");
const DEFAULT_CI_WORKFLOW_PATH = path.join(".github", "workflows", "ci.yml");
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

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

async function readJson(filePath, label) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function sha256Value(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function normalizeDependencyMap(source, label) {
  if (source === undefined) {
    return {};
  }
  const value = requireObject(source, label);
  const entries = Object.entries(value).map(([name, spec]) => {
    if (typeof spec !== "string" || spec.trim() === "") {
      throw new Error(`${label}.${name} must be a non-empty version range`);
    }
    return [name, spec.trim()];
  });
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeManifest(manifest) {
  const root = requireObject(manifest, "package.json");
  return {
    dependencies: normalizeDependencyMap(root.dependencies, "package.json dependencies"),
    devDependencies: normalizeDependencyMap(
      root.devDependencies,
      "package.json devDependencies"
    ),
    optionalDependencies: normalizeDependencyMap(
      root.optionalDependencies,
      "package.json optionalDependencies"
    ),
    engines: normalizeDependencyMap(root.engines, "package.json engines")
  };
}

function minimumNodeVersion(nodeEngine) {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(nodeEngine || "");
  if (!match) {
    throw new Error("package.json engines.node must use an exact >=x.y.z baseline");
  }
  return match[1];
}

function compareNodeVersion(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function parseCiNodeVersions(workflowText) {
  const match = workflowText.match(/node-version:\s*\r?\n((?:\s*-\s*[^\r\n]+\r?\n?)+)/);
  if (!match) {
    throw new Error("CI workflow does not declare a node-version matrix");
  }
  const versions = [];
  for (const line of match[1].split(/\r?\n/)) {
    const value = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/);
    if (value) {
      versions.push(value[1]);
    }
  }
  if (versions.length === 0) {
    throw new Error("CI node-version matrix is empty");
  }
  return [...new Set(versions)];
}

function packageNameFromPath(packagePath) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) {
    throw new Error(`cannot derive a package name from lock path: ${packagePath}`);
  }
  return packagePath.slice(index + marker.length);
}

function productionComponents(lock) {
  const packages = requireObject(lock.packages, "package-lock packages");
  const components = [];
  for (const [packagePath, entryValue] of Object.entries(packages)) {
    if (!packagePath) {
      continue;
    }
    const entry = requireObject(entryValue, `package-lock packages.${packagePath}`);
    if (entry.dev === true || entry.devOptional === true || entry.link === true) {
      continue;
    }
    const version = requireString(entry.version, `package-lock ${packagePath} version`);
    components.push({
      path: packagePath,
      name: entry.name || packageNameFromPath(packagePath),
      version,
      integrity: typeof entry.integrity === "string" ? entry.integrity : null,
      license: typeof entry.license === "string" ? entry.license : null,
      optional: entry.optional === true
    });
  }
  components.sort((left, right) => left.path.localeCompare(right.path));
  return components;
}

function directProductionDependencies(lock, manifest) {
  const root = requireObject(lock.packages?.[""], "package-lock root package");
  const rootDependencies = normalizeDependencyMap(
    root.dependencies,
    "package-lock root dependencies"
  );
  for (const field of ["devDependencies", "optionalDependencies"]) {
    const expected = manifest[field];
    const actual = normalizeDependencyMap(root[field], `package-lock root ${field}`);
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`package-lock root ${field} does not match package.json`);
    }
  }
  if (!isDeepStrictEqual(rootDependencies, manifest.dependencies)) {
    throw new Error("package-lock root dependencies do not match package.json");
  }
  if (!isDeepStrictEqual(normalizeDependencyMap(root.engines), manifest.engines)) {
    throw new Error("package-lock root engines do not match package.json");
  }

  const dependencies = [];
  for (const [name, spec] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies
  })) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || typeof entry.version !== "string") {
      throw new Error(`direct production dependency ${name} is missing from package-lock`);
    }
    dependencies.push({ name, spec, version: entry.version });
  }
  dependencies.sort((left, right) => left.name.localeCompare(right.name));
  return dependencies;
}

async function buildCurrentState(rootDir, dispositionsPath, now) {
  const root = path.resolve(rootDir);
  const manifestPath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const workflowPath = path.join(root, DEFAULT_CI_WORKFLOW_PATH);
  const manifestDocument = requireObject(
    await readJson(manifestPath, "package.json"),
    "package.json"
  );
  const lock = requireObject(await readJson(lockPath, "package-lock.json"), "package-lock.json");
  const manifest = normalizeManifest(manifestDocument);
  if (lock.lockfileVersion !== 3) {
    throw new Error(`package-lock.json must use lockfileVersion 3, got ${lock.lockfileVersion}`);
  }
  const rootPackage = requireObject(lock.packages?.[""], "package-lock root package");
  if (rootPackage.name !== manifestDocument.name || rootPackage.version !== manifestDocument.version) {
    throw new Error("package-lock root name/version does not match package.json");
  }
  let workflowText;
  try {
    workflowText = await fs.readFile(workflowPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`CI workflow not found: ${workflowPath}`);
    }
    throw error;
  }
  const ciNodeVersions = parseCiNodeVersions(workflowText);
  const minimum = minimumNodeVersion(manifest.engines.node);
  if (!ciNodeVersions.some((version) => compareNodeVersion(version, minimum) === 0)) {
    throw new Error(`CI node-version matrix does not cover the minimum runtime ${minimum}`);
  }
  if (ciNodeVersions.some((version) => compareNodeVersion(version, minimum) < 0)) {
    throw new Error(`CI node-version matrix includes a runtime below ${minimum}`);
  }
  if (new Set(ciNodeVersions.map((version) => String(version).split(".")[0])).size < 2) {
    throw new Error("CI node-version matrix must cover at least two runtime majors");
  }
  const components = productionComponents(lock);
  const dispositions = await loadDispositionDocument(dispositionsPath);
  const expiredDispositions = dispositions.dispositions
    .filter((disposition) => Date.parse(disposition.expiresAt) <= now)
    .map((disposition) => ({
      id: disposition.id,
      package: disposition.package,
      expiresAt: disposition.expiresAt
    }));
  return {
    manifest,
    lockfile: {
      version: lock.lockfileVersion,
      sha256: await hashFile(lockPath)
    },
    runtime: {
      nodeEngine: manifest.engines.node,
      minimumNodeVersion: minimum,
      ciNodeVersions
    },
    production: {
      componentCount: components.length,
      inventorySha256: sha256Value(components),
      directDependencies: directProductionDependencies(lock, manifest)
    },
    dispositions: {
      path: path.resolve(dispositionsPath),
      schemaVersion: dispositions.schemaVersion,
      count: dispositions.dispositions.length,
      sha256: await hashFile(dispositionsPath),
      expired: expiredDispositions
    }
  };
}

function baselineFromCurrent(current, clock) {
  return {
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    kind: SUPPLY_CHAIN_BASELINE_KIND,
    generatedAt: new Date(clock()).toISOString(),
    runtime: current.runtime,
    lockfile: current.lockfile,
    manifest: current.manifest,
    production: current.production,
    dispositions: {
      schemaVersion: current.dispositions.schemaVersion,
      count: current.dispositions.count,
      sha256: current.dispositions.sha256
    }
  };
}

function validateBaseline(baseline) {
  const document = requireObject(baseline, "supply-chain baseline");
  if (document.schemaVersion !== SUPPLY_CHAIN_SCHEMA_VERSION) {
    throw new Error(`unsupported supply-chain baseline schemaVersion: ${document.schemaVersion}`);
  }
  if (document.kind !== SUPPLY_CHAIN_BASELINE_KIND) {
    throw new Error(`supply-chain baseline kind must be ${SUPPLY_CHAIN_BASELINE_KIND}`);
  }
  requireObject(document.runtime, "supply-chain baseline runtime");
  requireObject(document.lockfile, "supply-chain baseline lockfile");
  requireObject(document.manifest, "supply-chain baseline manifest");
  requireObject(document.production, "supply-chain baseline production");
  requireObject(document.dispositions, "supply-chain baseline dispositions");
  return document;
}

function checkEntry(checks, name, passed, details) {
  checks.push({ name, status: passed ? "pass" : "fail", details });
}

async function runSupplyChainReview(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const baselinePath = path.resolve(
    rootDir,
    options.baselinePath || DEFAULT_BASELINE_PATH
  );
  const dispositionsPath = path.resolve(
    rootDir,
    options.dispositionsPath || DEFAULT_DISPOSITIONS_PATH
  );
  const clock = options.clock || Date.now;
  const current = await buildCurrentState(rootDir, dispositionsPath, clock());
  const checks = [];
  let baseline = null;
  let baselineError = null;
  let baselineWritten = false;

  if (options.writeBaseline) {
    if (current.dispositions.expired.length > 0) {
      throw new Error("cannot write a supply-chain baseline with expired dispositions");
    }
    baseline = baselineFromCurrent(current, clock);
    await writeJsonAtomic(baselinePath, baseline, { mode: 0o644 });
    baselineWritten = true;
  } else {
    try {
      baseline = validateBaseline(await readJson(baselinePath, "supply-chain baseline"));
    } catch (error) {
      baselineError = error.message;
    }
  }

  checkEntry(
    checks,
    "dispositions-current",
    current.dispositions.expired.length === 0,
    {
      count: current.dispositions.count,
      expired: current.dispositions.expired
    }
  );

  if (baseline) {
    checkEntry(checks, "runtime-baseline", isDeepStrictEqual(baseline.runtime, current.runtime), {
      baseline: baseline.runtime,
      current: current.runtime
    });
    checkEntry(
      checks,
      "lockfile-digest",
      baseline.lockfile?.version === current.lockfile.version &&
        baseline.lockfile?.sha256 === current.lockfile.sha256,
      { baseline: baseline.lockfile, current: current.lockfile }
    );
    checkEntry(
      checks,
      "manifest-baseline",
      isDeepStrictEqual(baseline.manifest, current.manifest),
      { baseline: baseline.manifest, current: current.manifest }
    );
    checkEntry(
      checks,
      "production-inventory",
      isDeepStrictEqual(baseline.production, current.production),
      { baseline: baseline.production, current: current.production }
    );
    checkEntry(
      checks,
      "disposition-baseline",
      baseline.dispositions?.schemaVersion === current.dispositions.schemaVersion &&
        baseline.dispositions?.count === current.dispositions.count &&
        baseline.dispositions?.sha256 === current.dispositions.sha256,
      {
        baseline: baseline.dispositions,
        current: {
          schemaVersion: current.dispositions.schemaVersion,
          count: current.dispositions.count,
          sha256: current.dispositions.sha256
        }
      }
    );
  } else {
    checkEntry(checks, "baseline-loaded", false, { error: baselineError });
  }

  const report = {
    schemaVersion: SUPPLY_CHAIN_SCHEMA_VERSION,
    kind: SUPPLY_CHAIN_KIND,
    generatedAt: new Date(clock()).toISOString(),
    status: checks.every((check) => check.status === "pass") ? "passed" : "failed",
    baselinePath,
    baselineWritten,
    baseline: baseline
      ? {
          generatedAt: baseline.generatedAt,
          runtime: baseline.runtime,
          lockfile: baseline.lockfile,
          production: baseline.production,
          dispositions: baseline.dispositions
        }
      : null,
    current: {
      runtime: current.runtime,
      lockfile: current.lockfile,
      production: current.production,
      dispositions: current.dispositions
    },
    checks
  };
  let outputPath = null;
  if (options.outputPath) {
    outputPath = path.resolve(options.outputPath);
    await writeJsonAtomic(outputPath, report, { mode: 0o600 });
  }
  return { baselinePath, outputPath, report };
}

function formatSupplyChainReport(report) {
  const lines = [
    `Supply-chain review: ${report.status.toUpperCase()}`,
    `Minimum Node.js: ${report.current.runtime.minimumNodeVersion} ` +
      `(CI: ${report.current.runtime.ciNodeVersions.join(", ")})`,
    `Production components: ${report.current.production.componentCount}`,
    `Lockfile SHA-256: ${report.current.lockfile.sha256}`,
    `Inventory SHA-256: ${report.current.production.inventorySha256}`,
    `Baseline: ${report.baselinePath}${report.baselineWritten ? " (written)" : ""}`
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.name}: ${check.status}`);
  }
  return lines.join("\n");
}

function parseSupplyChainArgs(args) {
  const options = {
    rootDir: process.cwd(),
    baselinePath: null,
    dispositionsPath: null,
    outputPath: null,
    writeBaseline: false,
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
    if (argument === "--write-baseline") {
      options.writeBaseline = true;
      continue;
    }
    const valueOptions = new Map([
      ["--root", "rootDir"],
      ["--baseline", "baselinePath"],
      ["--dispositions", "dispositionsPath"],
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
  DEFAULT_BASELINE_PATH,
  DEFAULT_DISPOSITIONS_PATH,
  SUPPLY_CHAIN_BASELINE_KIND,
  SUPPLY_CHAIN_KIND,
  SUPPLY_CHAIN_SCHEMA_VERSION,
  formatSupplyChainReport,
  parseSupplyChainArgs,
  runSupplyChainReview
};
