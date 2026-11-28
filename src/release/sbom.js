"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./common");

const SBOM_FILE = "sbom.cdx.json";
const SBOM_FORMAT = "CycloneDX";
const PROPERTY_PREFIX = "rpi4:gateway:";

function sbomSidecarPathForArchive(archivePath) {
  const resolved = path.resolve(archivePath);
  const fileName = path.basename(resolved).replace(/\.tar\.gz$/, "");
  return path.join(path.dirname(resolved), `${fileName}.sbom.cdx.json`);
}

function deterministicSerialNumber(seed) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex
    .slice(12, 16)
    .join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function validateCycloneDxSbom(sbom, expected = {}) {
  if (!sbom || typeof sbom !== "object" || Array.isArray(sbom)) {
    throw new Error("release SBOM must be an object");
  }
  if (sbom.bomFormat !== SBOM_FORMAT) {
    throw new Error(`release SBOM format must be ${SBOM_FORMAT}`);
  }
  if (typeof sbom.specVersion !== "string" || !/^1\.\d+$/.test(sbom.specVersion)) {
    throw new Error("release SBOM has an unsupported specVersion");
  }
  const component = sbom.metadata?.component;
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    throw new Error("release SBOM metadata.component must be an object");
  }
  if (typeof component["bom-ref"] !== "string" || !component["bom-ref"]) {
    throw new Error("release SBOM metadata.component must include bom-ref");
  }
  if (typeof component.name !== "string" || !component.name) {
    throw new Error("release SBOM metadata.component must include name");
  }
  if (typeof component.version !== "string" || !component.version) {
    throw new Error("release SBOM metadata.component must include version");
  }
  if (typeof component.type !== "string" || !component.type) {
    throw new Error("release SBOM metadata.component must include type");
  }
  if (expected.product && component.name !== expected.product) {
    throw new Error(
      `release SBOM component name mismatch: expected ${expected.product}, got ${component.name}`
    );
  }
  if (expected.version && component.version !== expected.version) {
    throw new Error(
      `release SBOM component version mismatch: expected ${expected.version}, got ${component.version}`
    );
  }
  if (!Array.isArray(sbom.components)) {
    throw new Error("release SBOM components must be an array");
  }
  const references = new Set([component["bom-ref"]]);
  for (const entry of sbom.components) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("release SBOM contains an invalid component");
    }
    if (typeof entry["bom-ref"] !== "string" || !entry["bom-ref"]) {
      throw new Error("release SBOM component is missing bom-ref");
    }
    if (references.has(entry["bom-ref"])) {
      throw new Error(`release SBOM contains a duplicate bom-ref: ${entry["bom-ref"]}`);
    }
    if (typeof entry.type !== "string" || !entry.type) {
      throw new Error(`release SBOM component is missing type: ${entry["bom-ref"]}`);
    }
    if (typeof entry.name !== "string" || !entry.name) {
      throw new Error(`release SBOM component is missing name: ${entry["bom-ref"]}`);
    }
    references.add(entry["bom-ref"]);
  }
  const dependencies = Array.isArray(sbom.dependencies) ? sbom.dependencies : [];
  if (sbom.dependencies !== undefined && !Array.isArray(sbom.dependencies)) {
    throw new Error("release SBOM dependencies must be an array");
  }
  const dependencyRefs = new Set();
  for (const entry of dependencies) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("release SBOM contains an invalid dependency entry");
    }
    if (typeof entry.ref !== "string" || !entry.ref) {
      throw new Error("release SBOM dependency entry is missing ref");
    }
    if (dependencyRefs.has(entry.ref)) {
      throw new Error(`release SBOM contains duplicate dependency ref: ${entry.ref}`);
    }
    if (!Array.isArray(entry.dependsOn) || entry.dependsOn.some((ref) => typeof ref !== "string")) {
      throw new Error(`release SBOM dependency entry is invalid: ${entry.ref}`);
    }
    dependencyRefs.add(entry.ref);
  }
  return {
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
    serialNumber: typeof sbom.serialNumber === "string" ? sbom.serialNumber : null,
    componentCount: sbom.components.length,
    dependencyCount: dependencies.length
  };
}

function normalizeReleaseSbom(sbom, options) {
  const root = sbom.metadata.component;
  const previousRootReference = root["bom-ref"];
  const rootReference = `${options.packageJson.name}@${options.version}`;
  root.name = options.packageJson.name;
  root.version = options.version;
  if (options.packageJson.description) {
    root.description = options.packageJson.description;
  }
  root["bom-ref"] = rootReference;
  if (typeof root.purl === "string") {
    root.purl = root.purl.replace(/@[^@/]+$/, `@${options.version}`);
  }
  sbom.metadata.timestamp = options.createdAt;
  sbom.serialNumber = deterministicSerialNumber(
    `${options.packageJson.name}@${options.version}:${options.releaseId}:${options.commit}:${options.dirty}:${options.createdAt}`
  );
  sbom.version = Number.isInteger(sbom.version) ? sbom.version : 1;
  const retainedProperties = Array.isArray(root.properties)
    ? root.properties.filter((property) => !String(property?.name || "").startsWith(PROPERTY_PREFIX))
    : [];
  root.properties = [
    ...retainedProperties,
    { name: `${PROPERTY_PREFIX}release:id`, value: options.releaseId },
    { name: `${PROPERTY_PREFIX}git:commit`, value: options.commit },
    { name: `${PROPERTY_PREFIX}git:dirty`, value: String(options.dirty) },
    {
      name: `${PROPERTY_PREFIX}runtime:node-engine`,
      value: options.packageJson.engines?.node || "unspecified"
    }
  ];
  if (Array.isArray(sbom.components)) {
    sbom.components.sort((left, right) =>
      String(left?.["bom-ref"] || "").localeCompare(String(right?.["bom-ref"] || ""))
    );
  }
  if (Array.isArray(sbom.dependencies)) {
    for (const dependency of sbom.dependencies) {
      if (dependency?.ref === previousRootReference) {
        dependency.ref = rootReference;
      }
    }
    sbom.dependencies.sort((left, right) =>
      String(left?.ref || "").localeCompare(String(right?.ref || ""))
    );
    for (const dependency of sbom.dependencies) {
      if (Array.isArray(dependency.dependsOn)) {
        dependency.dependsOn.sort();
      }
    }
  }
  return validateCycloneDxSbom(sbom, {
    product: options.packageJson.name,
    version: options.version
  });
}

async function generateReleaseSbom(options) {
  const run = options.run || runProcess;
  const npmCommand = options.npmCommand || "npm";
  const outputPath = path.resolve(options.outputPath);
  let stdout;
  try {
    ({ stdout } = await run(
      npmCommand,
      [
        "sbom",
        "--package-lock-only",
        "--omit=dev",
        "--sbom-format=cyclonedx",
        "--sbom-type=application"
      ],
      { cwd: path.resolve(options.rootDir), timeoutMs: 120000 }
    ));
  } catch (error) {
    throw new Error(`unable to generate release SBOM with npm: ${error.message}`);
  }
  let sbom;
  try {
    sbom = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm sbom produced invalid JSON: ${error.message}`);
  }
  validateCycloneDxSbom(sbom);
  normalizeReleaseSbom(sbom, options);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644
  });
  return {
    path: outputPath,
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
    serialNumber: sbom.serialNumber,
    componentCount: sbom.components.length,
    dependencyCount: sbom.dependencies?.length || 0
  };
}

module.exports = {
  SBOM_FILE,
  SBOM_FORMAT,
  deterministicSerialNumber,
  generateReleaseSbom,
  normalizeReleaseSbom,
  sbomSidecarPathForArchive,
  validateCycloneDxSbom
};
