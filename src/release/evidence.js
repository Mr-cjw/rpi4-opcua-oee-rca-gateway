"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  hashFile,
  pathExists,
  resolveWithin,
  safeRelativePath,
  writeJsonAtomic
} = require("./common");
const { verifyReleasePackage } = require("./package");
const { verifyReleaseArchiveSignature } = require("./signature");
const { validateCycloneDxSbom } = require("./sbom");
const { validateCycloneDxVex } = require("./vulnerability-audit");

const EVIDENCE_SCHEMA_VERSION = "1.0";
const EVIDENCE_KIND = "rpi4-gateway-release-evidence";
const DISPOSITION_ARCHIVE_PATH = "security/advisory-dispositions.json";

function evidenceSidecarPathForArchive(archivePath) {
  const resolved = path.resolve(archivePath);
  return resolved.endsWith(".tar.gz")
    ? `${resolved.slice(0, -7)}.evidence.json`
    : `${resolved}.evidence.json`;
}

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

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function readJson(filePath, label) {
  let content;
  try {
    content = await fsp.readFile(filePath, "utf8");
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

function artifactReference(evidenceDir, filePath, label) {
  const relative = path.relative(evidenceDir, path.resolve(filePath)).split(path.sep).join("/");
  return safeRelativePath(relative, label);
}

function artifactPath(evidenceDir, reference, label) {
  return resolveWithin(evidenceDir, reference, label);
}

async function validateAuditBinding({ audit, archiveSha256, release, sbom, lockfileSha256 }) {
  requireObject(audit, "release audit report");
  if (audit.schemaVersion !== "1.0" || audit.kind !== "rpi4-gateway-release-audit") {
    throw new Error("release audit report has an unsupported schema or kind");
  }
  requireObject(audit.release, "release audit release metadata");
  assertEqual(audit.release.archiveSha256, archiveSha256, "release audit archive SHA-256");
  assertEqual(audit.release.releaseId, release.releaseId, "release audit release ID");
  assertEqual(audit.release.version, release.version, "release audit version");
  assertEqual(audit.release.commit, release.commit, "release audit commit");
  assertEqual(audit.release.dirty, release.dirty, "release audit dirty state");
  assertEqual(audit.release.sbomSha256, sbom.sha256, "release audit SBOM SHA-256");
  assertEqual(
    audit.release.sbomSerialNumber,
    sbom.serialNumber,
    "release audit SBOM serial number"
  );
  assertEqual(audit.release.lockfileSha256, lockfileSha256, "release audit lockfile SHA-256");
  if (audit.audit?.scope !== "production") {
    throw new Error("release audit report must cover production dependencies only");
  }
  if (audit.status !== "passed" && audit.status !== "failed") {
    throw new Error("release audit report status must be passed or failed");
  }
  const blocking = audit.summary?.blocking;
  if (!Number.isInteger(blocking) || blocking < 0) {
    throw new Error("release audit blocking count is invalid");
  }
  if ((blocking > 0 && audit.status !== "failed") || (blocking === 0 && audit.status !== "passed")) {
    throw new Error("release audit status and blocking count are inconsistent");
  }
  return audit;
}

function validateVexBinding({ vex, audit, archiveSha256 }) {
  const summary = validateCycloneDxVex(vex);
  requireObject(audit.vex, "release audit VEX binding");
  assertEqual(audit.vex.serialNumber, summary.serialNumber, "release audit VEX serial number");
  assertEqual(
    audit.vex.vulnerabilityCount,
    summary.vulnerabilityCount,
    "release audit VEX vulnerability count"
  );
  const releaseProperty = vex.metadata?.component?.properties?.find(
    (property) => property.name === "rpi4:gateway:release:id"
  );
  if (releaseProperty) {
    assertEqual(releaseProperty.value, audit.release.releaseId, "VEX release ID");
  }
  for (const vulnerability of vex.vulnerabilities) {
    const archiveProperty = vulnerability.properties?.find(
      (property) => property.name === "rpi4:gateway:release:archive-sha256"
    );
    if (archiveProperty) {
      assertEqual(archiveProperty.value, archiveSha256, "VEX archive SHA-256");
    }
  }
  return summary;
}

async function createEvidenceManifest(options) {
  const evidenceDir = path.resolve(options.evidenceDir);
  const archivePath = path.resolve(options.archivePath);
  const checksumPath = path.resolve(options.checksumPath || `${archivePath}.sha256`);
  const sbomPath = path.resolve(options.sbomPath);
  const auditPath = path.resolve(options.auditPath);
  const vexPath = path.resolve(options.vexPath);
  const signaturePath = options.signaturePath ? path.resolve(options.signaturePath) : null;
  const publicKeyPath = options.publicKeyPath ? path.resolve(options.publicKeyPath) : null;
  if (signaturePath && !publicKeyPath) {
    throw new Error("release evidence signature verification requires a public key");
  }
  if (
    options.expectedKeyFingerprint !== undefined &&
    options.expectedKeyFingerprint !== null &&
    !signaturePath
  ) {
    throw new Error("expected signer fingerprint requires a release signature artifact");
  }
  const verifyRelease = options.verifyRelease || verifyReleasePackage;
  const verifySignature = options.verifySignature || verifyReleaseArchiveSignature;
  const verified = await verifyRelease({ archivePath, checksumPath });
  try {
    if (!verified.manifest.sbom) {
      throw new Error("release archive does not contain an SBOM");
    }
    const embeddedSbomPath = resolveWithin(
      verified.extractDir,
      verified.manifest.sbom.path,
      "embedded SBOM path"
    );
    const embeddedSbom = await readJson(embeddedSbomPath, "embedded release SBOM");
    validateCycloneDxSbom(embeddedSbom, {
      product: verified.manifest.product,
      version: verified.manifest.version
    });
    const embeddedSbomSha256 = await hashFile(embeddedSbomPath);
    const sidecarSbom = await readJson(sbomPath, "release SBOM sidecar");
    validateCycloneDxSbom(sidecarSbom, {
      product: verified.manifest.product,
      version: verified.manifest.version
    });
    const sbomSha256 = await hashFile(sbomPath);
    assertEqual(sbomSha256, embeddedSbomSha256, "SBOM sidecar SHA-256");
    assertEqual(sidecarSbom.serialNumber, embeddedSbom.serialNumber, "SBOM sidecar serial number");

    const lockfilePath = resolveWithin(
      verified.extractDir,
      "package-lock.json",
      "release lockfile path"
    );
    const dispositionPath = resolveWithin(
      verified.extractDir,
      DISPOSITION_ARCHIVE_PATH,
      "advisory disposition path"
    );
    if (!(await pathExists(dispositionPath))) {
      throw new Error(`release archive is missing ${DISPOSITION_ARCHIVE_PATH}`);
    }
    const dispositionSha256 = await hashFile(dispositionPath);

    const audit = await readJson(auditPath, "release audit report");
    const release = {
      releaseId: verified.manifest.releaseId,
      version: verified.manifest.version,
      commit: verified.manifest.git?.commit || null,
      dirty: verified.manifest.git?.dirty === true
    };
    await validateAuditBinding({
      audit,
      archiveSha256: verified.archiveSha256,
      release,
      sbom: {
        sha256: embeddedSbomSha256,
        serialNumber: embeddedSbom.serialNumber || null
      },
      lockfileSha256: await hashFile(lockfilePath)
    });
    assertEqual(
      audit.dispositionFile?.sha256,
      dispositionSha256,
      "release audit disposition SHA-256"
    );

    const vex = await readJson(vexPath, "release VEX");
    const vexSummary = validateVexBinding({
      vex,
      audit,
      archiveSha256: verified.archiveSha256
    });
    const vexSha256 = await hashFile(vexPath);
    assertEqual(audit.vex?.sha256, vexSha256, "release audit VEX SHA-256");

    let signatureArtifact = null;
    if (signaturePath) {
      const signatureResult = await verifySignature({
        archivePath,
        signaturePath,
        publicKeyPath,
        expectedKeyFingerprint: options.expectedKeyFingerprint
      });
      if (!signatureResult.valid) {
        throw new Error("release evidence signature verification failed");
      }
      assertEqual(
        signatureResult.archiveSha256,
        verified.archiveSha256,
        "release signature archive SHA-256"
      );
      const signatureSha256 = await hashFile(signaturePath);
      assertEqual(
        audit.release.signature?.sha256,
        signatureSha256,
        "release audit signature SHA-256"
      );
      assertEqual(
        audit.release.signature?.keyFingerprint,
        signatureResult.keyFingerprint,
        "release audit signature key fingerprint"
      );
      signatureArtifact = {
        path: artifactReference(evidenceDir, signaturePath, "signature artifact path"),
        sha256: signatureSha256,
        algorithm: signatureResult.algorithm,
        keyFingerprint: signatureResult.keyFingerprint
      };
    } else if (audit.release.signature) {
      throw new Error("release audit records a signature but no signature file was supplied");
    }

    const checks = [
      { id: "archive", status: "passed", detail: verified.archiveSha256 },
      { id: "sbom", status: "passed", detail: sbomSha256 },
      { id: "audit-binding", status: "passed", detail: audit.release.archiveSha256 },
      { id: "vex-binding", status: "passed", detail: vexSummary.serialNumber || "none" },
      { id: "disposition", status: "passed", detail: dispositionSha256 },
      {
        id: "signature",
        status: signatureArtifact ? "passed" : "not_required",
        detail: signatureArtifact?.keyFingerprint || null
      },
      {
        id: "audit-gate",
        status: audit.status,
        detail: `${audit.summary.blocking} blocking advisories`
      }
    ];
    const status = checks.some((check) => check.status === "failed") ? "failed" : "passed";
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: EVIDENCE_KIND,
      generatedAt: new Date((options.clock || Date.now)()).toISOString(),
      status,
      release,
      artifacts: {
        archive: {
          path: artifactReference(evidenceDir, archivePath, "archive artifact path"),
          sha256: verified.archiveSha256
        },
        checksum: {
          path: artifactReference(evidenceDir, checksumPath, "checksum artifact path"),
          sha256: await hashFile(checksumPath)
        },
        sbom: {
          path: artifactReference(evidenceDir, sbomPath, "SBOM artifact path"),
          sha256: sbomSha256,
          format: sidecarSbom.bomFormat,
          specVersion: sidecarSbom.specVersion,
          serialNumber: sidecarSbom.serialNumber || null,
          componentCount: sidecarSbom.components.length
        },
        audit: {
          path: artifactReference(evidenceDir, auditPath, "audit artifact path"),
          sha256: await hashFile(auditPath),
          status: audit.status,
          summary: audit.summary
        },
        vex: {
          path: artifactReference(evidenceDir, vexPath, "VEX artifact path"),
          sha256: vexSha256,
          format: vexSummary.format,
          specVersion: vexSummary.specVersion,
          serialNumber: vexSummary.serialNumber,
          vulnerabilityCount: vexSummary.vulnerabilityCount
        },
        signature: signatureArtifact,
        dispositions: {
          path: DISPOSITION_ARCHIVE_PATH,
          sha256: dispositionSha256
        }
      },
      checks
    };
  } finally {
    await verified.cleanup();
  }
}

async function createReleaseEvidence(options) {
  const outputPath = path.resolve(
    options.outputPath || evidenceSidecarPathForArchive(options.archivePath)
  );
  const archivePath = path.resolve(options.archivePath);
  const inputPaths = new Set([
    archivePath,
    path.resolve(options.checksumPath || `${archivePath}.sha256`),
    path.resolve(options.sbomPath),
    path.resolve(options.auditPath),
    path.resolve(options.vexPath),
    ...(options.signaturePath ? [path.resolve(options.signaturePath)] : [])
  ]);
  if (inputPaths.has(outputPath)) {
    throw new Error("release evidence output must differ from all evidence artifacts");
  }
  if (!options.force && (await pathExists(outputPath))) {
    throw new Error(`release evidence output already exists: ${outputPath}`);
  }
  const evidence = await createEvidenceManifest({
    ...options,
    evidenceDir: path.dirname(outputPath)
  });
  await writeJsonAtomic(outputPath, evidence, { mode: 0o600 });
  return {
    outputPath,
    outputSha256: await hashFile(outputPath),
    evidence
  };
}

function resolveEvidenceArtifact(manifest, baseDir, name) {
  const entry = requireObject(manifest.artifacts?.[name], `release evidence ${name} artifact`);
  const reference = safeRelativePath(entry.path, `release evidence ${name} path`);
  return {
    entry,
    path: artifactPath(baseDir, reference, `release evidence ${name} path`)
  };
}

async function verifyReleaseEvidence(options) {
  const evidencePath = path.resolve(options.evidencePath);
  const evidenceDir = path.dirname(evidencePath);
  const manifest = await readJson(evidencePath, "release evidence manifest");
  if (manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION || manifest.kind !== EVIDENCE_KIND) {
    throw new Error("release evidence manifest has an unsupported schema or kind");
  }
  const archive = resolveEvidenceArtifact(manifest, evidenceDir, "archive");
  const checksum = resolveEvidenceArtifact(manifest, evidenceDir, "checksum");
  const sbom = resolveEvidenceArtifact(manifest, evidenceDir, "sbom");
  const audit = resolveEvidenceArtifact(manifest, evidenceDir, "audit");
  const vex = resolveEvidenceArtifact(manifest, evidenceDir, "vex");
  const signature = manifest.artifacts.signature
    ? resolveEvidenceArtifact(manifest, evidenceDir, "signature")
    : null;
  const current = await createEvidenceManifest({
    archivePath: archive.path,
    checksumPath: checksum.path,
    sbomPath: sbom.path,
    auditPath: audit.path,
    vexPath: vex.path,
    signaturePath: signature?.path,
    publicKeyPath: options.publicKeyPath,
    expectedKeyFingerprint: options.expectedKeyFingerprint,
    evidenceDir,
    clock: options.clock,
    verifyRelease: options.verifyRelease,
    verifySignature: options.verifySignature
  });
  if (JSON.stringify(current.artifacts) !== JSON.stringify(manifest.artifacts)) {
    throw new Error("release evidence artifacts or bindings changed after manifest creation");
  }
  assertEqual(current.status, manifest.status, "release evidence status");
  if (JSON.stringify(current.release) !== JSON.stringify(manifest.release)) {
    throw new Error("release evidence release metadata changed after manifest creation");
  }
  if (JSON.stringify(current.checks) !== JSON.stringify(manifest.checks)) {
    throw new Error("release evidence checks changed after manifest creation");
  }
  return {
    evidencePath,
    status: current.status,
    release: current.release,
    artifacts: current.artifacts,
    checks: current.checks
  };
}

module.exports = {
  DISPOSITION_ARCHIVE_PATH,
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  createEvidenceManifest,
  createReleaseEvidence,
  evidenceSidecarPathForArchive,
  verifyReleaseEvidence
};
