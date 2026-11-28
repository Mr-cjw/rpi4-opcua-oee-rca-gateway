"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  generateReleaseSbom,
  sbomSidecarPathForArchive,
  validateCycloneDxSbom
} = require("../src/release/sbom");

function sampleSbom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: {
      timestamp: "2026-11-28T00:00:00.000Z",
      component: {
        "bom-ref": "directory-name@1.0.0",
        type: "application",
        name: "directory-name",
        version: "1.0.0",
        purl: "pkg:npm/release-fixture@1.0.0",
        properties: []
      }
    },
    components: [
      { "bom-ref": "z-package@1.0.0", type: "library", name: "z-package", version: "1.0.0" },
      { "bom-ref": "a-package@1.0.0", type: "library", name: "a-package", version: "1.0.0" }
    ],
    dependencies: [
      { ref: "z-package@1.0.0", dependsOn: [] },
      { ref: "directory-name@1.0.0", dependsOn: ["z-package@1.0.0", "a-package@1.0.0"] }
    ]
  };
}

test("release SBOM generation normalizes npm CycloneDX output deterministically", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-sbom-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "sbom.cdx.json");
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: JSON.stringify(sampleSbom()), stderr: "" };
  };
  const options = {
    rootDir: root,
    outputPath,
    packageJson: {
      name: "release-fixture",
      version: "0.9.0",
      description: "Fixture application",
      engines: { node: ">=22.13.0" }
    },
    version: "1.1.0",
    releaseId: "1.0.0-aaaaaaaaaaaa",
    commit: "a".repeat(40),
    dirty: false,
    createdAt: "2026-11-28T06:00:00.000Z",
    run
  };

  const result = await generateReleaseSbom(options);
  const sbom = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npm");
  assert.ok(calls[0].args.includes("--package-lock-only"));
  assert.ok(calls[0].args.includes("--omit=dev"));
  assert.equal(result.componentCount, 2);
  assert.equal(result.dependencyCount, 2);
  assert.match(result.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(sbom.metadata.timestamp, options.createdAt);
  assert.equal(sbom.metadata.component.name, "release-fixture");
  assert.equal(sbom.metadata.component["bom-ref"], "release-fixture@1.1.0");
  assert.equal(sbom.metadata.component.version, "1.1.0");
  assert.equal(sbom.metadata.component.purl, "pkg:npm/release-fixture@1.1.0");
  assert.equal(sbom.metadata.component.description, "Fixture application");
  assert.deepEqual(
    sbom.components.map((component) => component["bom-ref"]),
    ["a-package@1.0.0", "z-package@1.0.0"]
  );
  assert.ok(
    sbom.metadata.component.properties.some(
      (property) => property.name === "rpi4:gateway:release:id"
    )
  );
  const rootDependency = sbom.dependencies.find((entry) => entry.ref === "release-fixture@1.1.0");
  assert.deepEqual(rootDependency.dependsOn, ["a-package@1.0.0", "z-package@1.0.0"]);
  assert.ok(sbom.dependencies.some((entry) => entry.ref === "z-package@1.0.0"));

  const second = await generateReleaseSbom(options);
  assert.equal(second.serialNumber, result.serialNumber);
});

test("release SBOM validation rejects malformed CycloneDX output", async () => {
  assert.throws(
    () => validateCycloneDxSbom({ bomFormat: "SPDX" }),
    /format must be CycloneDX/
  );
  const duplicate = sampleSbom();
  duplicate.components.push({ ...duplicate.components[0] });
  assert.throws(() => validateCycloneDxSbom(duplicate), /duplicate bom-ref/);

  await assert.rejects(
    generateReleaseSbom({
      rootDir: os.tmpdir(),
      outputPath: path.join(os.tmpdir(), "invalid-sbom.cdx.json"),
      packageJson: { name: "fixture", version: "1.0.0" },
      version: "1.0.0",
      releaseId: "1.0.0-test",
      commit: "a".repeat(40),
      dirty: false,
      createdAt: "2026-11-28T06:00:00.000Z",
      run: async () => ({ stdout: "not json", stderr: "" })
    }),
    /npm sbom produced invalid JSON/
  );
  await assert.rejects(
    generateReleaseSbom({
      rootDir: os.tmpdir(),
      outputPath: path.join(os.tmpdir(), "unsupported-sbom.cdx.json"),
      packageJson: { name: "fixture", version: "1.0.0" },
      version: "1.0.0",
      releaseId: "1.0.0-test",
      commit: "a".repeat(40),
      dirty: false,
      createdAt: "2026-11-28T06:00:00.000Z",
      run: async () => {
        throw new Error("unknown command sbom");
      }
    }),
    /unable to generate release SBOM with npm/
  );
});

test("release SBOM sidecar path is derived from the archive name", () => {
  assert.equal(
    sbomSidecarPathForArchive("/tmp/release-1.0.0.tar.gz"),
    "/tmp/release-1.0.0.sbom.cdx.json"
  );
});
