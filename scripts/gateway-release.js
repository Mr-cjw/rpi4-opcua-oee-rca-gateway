#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  createReleasePackage,
  verifyReleasePackage
} = require("../src/release/package");
const {
  installRelease,
  listReleases,
  rollbackRelease
} = require("../src/release/installer");
const {
  signReleaseArchive,
  signaturePathFor,
  verifyReleaseArchiveSignature
} = require("../src/release/signature");
const { sbomSidecarPathForArchive } = require("../src/release/sbom");
const { generateReleaseAudit } = require("../src/release/vulnerability-audit");
const {
  createReleaseEvidence,
  verifyReleaseEvidence
} = require("../src/release/evidence");
const { hashFile, pathExists, resolveWithin } = require("../src/release/common");
const { verifyStateBackup } = require("../src/gateway/state-backup");

const DEFAULT_RELEASE_ROOT = "/opt/rpi4-opcua-oee-rca-gateway";
const DEFAULT_HEALTH_URL = "http://127.0.0.1:8080/healthz";

function usage() {
  console.log(
    [
      "Usage:",
      "  npm run release:package -- [--root <directory>] [--output <directory>] [--allow-dirty] [--force] [--json]",
      "  npm run release:verify -- --archive <file.tar.gz> [--checksum <file.sha256>] [--json]",
      "  npm run release:sign -- --archive <file.tar.gz> --private-key <file.pem> [--signature <file.sig>] [--json]",
      "  npm run release:verify-signature -- --archive <file.tar.gz> --public-key <file.pem> [--signature <file.sig>] [--json]",
      "  npm run release:sbom -- --archive <file.tar.gz> [--output <file.cdx.json>] [--force] [--json]",
      "  npm run release:audit -- --archive <file.tar.gz> [--checksum <file.sha256>] [--dispositions <file.json>] [--public-key <file.pem>] [--signature <file.sig>] [--require-signature] [--output <file.json>] [--vex-output <file.cdx.json>] [--force] [--json]",
      "  npm run release:evidence -- --archive <file.tar.gz> --sbom <file.cdx.json> --audit <file.json> --vex <file.cdx.json> [--public-key <file.pem>] [--signature <file.sig>] [--require-signature] [--output <file.json>] [--force] [--json]",
      "  npm run release:verify-evidence -- --evidence <file.json> [--public-key <file.pem>] [--json]",
      "  npm run release:install -- --archive <file.tar.gz> [--checksum <file.sha256>] [--public-key <file.pem>] [--signature <file.sig>] [--require-signature] [--release-root <directory>] [--state-backup <directory>] [--service <name>] [--health-url <url>] [--json]",
      "  npm run release:rollback -- [--to <release-id>] [--release-root <directory>] [--service <name>] [--health-url <url>] [--json]",
      "  npm run release:status -- [--release-root <directory>] [--json]",
      "",
      "Release archives contain tracked source files, package-lock.json, deploy",
      "files, a release manifest, SHA256SUMS, and an embedded CycloneDX SBOM.",
      "State, node_modules, secrets, and untracked files are not included.",
      "",
      "  --allow-dirty  Build a diagnostic archive from tracked working-tree changes.",
      "  --force        Replace an existing output archive.",
      "  --require-signature  Refuse to install unless the detached signature verifies.",
      "  --json         Print a machine-readable result."
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    json: false,
    force: false,
    allowDirty: false,
    requireSignature: false,
    help: false
  };
  const valueOptions = new Map([
    ["--root", "root"],
    ["--output", "output"],
    ["--archive", "archive"],
    ["--checksum", "checksum"],
    ["--release-root", "releaseRoot"],
    ["--state-backup", "stateBackup"],
    ["--service", "service"],
    ["--health-url", "healthUrl"],
    ["--health-timeout-ms", "healthTimeoutMs"],
    ["--private-key", "privateKey"],
    ["--public-key", "publicKey"],
    ["--signature", "signature"],
    ["--dispositions", "dispositions"],
    ["--vex-output", "vexOutput"],
    ["--sbom", "sbom"],
    ["--audit", "audit"],
    ["--vex", "vex"],
    ["--evidence", "evidence"],
    ["--to", "to"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (argument === "--require-signature") {
      options.requireSignature = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (key) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function releaseRoot(options) {
  return path.resolve(options.releaseRoot || DEFAULT_RELEASE_ROOT);
}

function healthTimeout(options) {
  if (options.healthTimeoutMs === undefined) {
    return 30000;
  }
  const value = Number(options.healthTimeoutMs);
  if (!Number.isInteger(value) || value < 1 || value > 15 * 60 * 1000) {
    throw new Error("--health-timeout-ms must be an integer from 1 to 900000");
  }
  return value;
}

async function verifyBackupIfProvided(options) {
  if (!options.stateBackup) {
    console.error(
      "[release] warning: no --state-backup supplied; verify a state backup before an install or rollback"
    );
    return;
  }
  const result = await verifyStateBackup({ backupDir: options.stateBackup });
  console.error(
    `[release] verified state backup: ${result.manifest.fileCount} files, created ${result.manifest.createdAt}`
  );
}

function printPackage(result) {
  console.log(`Release archive: ${result.archivePath}`);
  console.log(`Checksum: ${result.checksumPath}`);
  console.log(`Release: ${result.manifest.releaseId}`);
  console.log(`Files: ${result.manifest.fileCount}`);
  console.log(`Bytes: ${result.manifest.totalBytes}`);
  console.log(
    `SBOM: ${result.sbom.format} ${result.sbom.specVersion}, ${result.sbom.componentCount} components (embedded)`
  );
}

function printVerification(result) {
  console.log(`Release archive verified: ${result.archivePath}`);
  console.log(`Release: ${result.manifest.releaseId}`);
  console.log(`Version: ${result.manifest.version}`);
  console.log(`Created: ${result.manifest.createdAt}`);
  console.log(`Commit: ${result.manifest.git?.commit || "unknown"}`);
  console.log(`Files: ${result.manifest.fileCount}`);
  console.log(`Archive SHA-256: ${result.archiveSha256}`);
  if (result.sbom) {
    console.log(
      `SBOM: ${result.sbom.format} ${result.sbom.specVersion}, ${result.sbom.componentCount} components`
    );
  }
}

function printSignature(result) {
  console.log(`Release archive: ${result.archivePath}`);
  console.log(`Signature: ${result.signaturePath}`);
  console.log(`Algorithm: ${result.algorithm}`);
  console.log(`Public key SHA-256: ${result.keyFingerprint}`);
}

function printAudit(result) {
  console.log(`Release archive: ${result.archivePath}`);
  console.log(`Release: ${result.report.release.releaseId}`);
  console.log(`Audit status: ${result.report.status}`);
  console.log(
    `Advisories: ${result.report.summary.advisoryCount} (${result.report.summary.blocking} blocking)`
  );
  console.log(`Audit report: ${result.outputPath}`);
  console.log(`VEX: ${result.vexOutputPath}`);
  console.log(
    result.report.release.signature
      ? `Signature: verified (${result.report.release.signature.algorithm}, key ${result.report.release.signature.keyFingerprint})`
      : "Signature: not verified"
  );
}

function printEvidence(result) {
  console.log(`Release: ${result.evidence.release.releaseId}`);
  console.log(`Evidence status: ${result.evidence.status}`);
  console.log(`Evidence manifest: ${result.outputPath}`);
  console.log(`Evidence SHA-256: ${result.outputSha256}`);
  console.log(
    result.evidence.artifacts.signature
      ? `Signature: verified (${result.evidence.artifacts.signature.algorithm}, key ${result.evidence.artifacts.signature.keyFingerprint})`
      : "Signature: not included"
  );
}

function printVerifiedEvidence(result) {
  console.log(`Release evidence verified: ${result.evidencePath}`);
  console.log(`Release: ${result.release.releaseId}`);
  console.log(`Evidence status: ${result.status}`);
  console.log(`Checks: ${result.checks.length}`);
}

async function verifySignatureOrThrow(options, label = "verify-signature") {
  if (!options.archive) {
    throw new Error(`${label} requires --archive <file.tar.gz>`);
  }
  if (!options.publicKey) {
    throw new Error(`${label} requires --public-key <file.pem>`);
  }
  const result = await verifyReleaseArchiveSignature({
    archivePath: options.archive,
    signaturePath: options.signature || signaturePathFor(options.archive),
    publicKeyPath: options.publicKey
  });
  if (!result.valid) {
    throw new Error(`release signature verification failed: ${result.signaturePath}`);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commands = new Set([
    "package",
    "verify",
    "sign",
    "verify-signature",
    "sbom",
    "audit",
    "evidence",
    "verify-evidence",
    "install",
    "rollback",
    "status"
  ]);
  if (options.help || !commands.has(options.command)) {
    usage();
    if (!options.help) {
      process.exitCode = 2;
    }
    return;
  }

  if (options.command === "package") {
    const outputDir = path.resolve(options.output || "dist/release");
    const result = await createReleasePackage({
      rootDir: path.resolve(options.root || process.cwd()),
      outputDir,
      allowDirty: options.allowDirty,
      force: options.force
    });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            archivePath: result.archivePath,
            checksumPath: result.checksumPath,
            archiveSha256: result.archiveSha256,
            sbom: result.sbom,
            manifest: {
              releaseId: result.manifest.releaseId,
              version: result.manifest.version,
              createdAt: result.manifest.createdAt,
              git: result.manifest.git,
              fileCount: result.manifest.fileCount,
              totalBytes: result.manifest.totalBytes
            }
          },
          null,
          2
        )
      );
    } else {
      printPackage(result);
    }
    return;
  }

  if (options.command === "verify") {
    if (!options.archive) {
      throw new Error("verify requires --archive <file.tar.gz>");
    }
    const result = await verifyReleasePackage({
      archivePath: options.archive,
      checksumPath: options.checksum
    });
    try {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              archivePath: result.archivePath,
              archiveSha256: result.archiveSha256,
              sbom: result.sbom,
              manifest: result.manifest
            },
            null,
            2
          )
        );
      } else {
        printVerification(result);
      }
    } finally {
      await result.cleanup();
    }
    return;
  }

  if (options.command === "sign") {
    if (!options.archive) {
      throw new Error("sign requires --archive <file.tar.gz>");
    }
    if (!options.privateKey) {
      throw new Error("sign requires --private-key <file.pem>");
    }
    const result = await signReleaseArchive({
      archivePath: options.archive,
      privateKeyPath: options.privateKey,
      outputPath: options.signature
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSignature(result);
      console.log("Signature written: yes");
    }
    return;
  }

  if (options.command === "verify-signature") {
    const result = await verifySignatureOrThrow(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSignature(result);
      console.log("Signature verified: yes");
    }
    return;
  }

  if (options.command === "sbom") {
    if (!options.archive) {
      throw new Error("sbom requires --archive <file.tar.gz>");
    }
    const verified = await verifyReleasePackage({
      archivePath: options.archive,
      checksumPath: options.checksum
    });
    try {
      if (!verified.manifest.sbom) {
        throw new Error("release archive does not contain an SBOM");
      }
      const outputPath = path.resolve(
        options.output || sbomSidecarPathForArchive(verified.archivePath)
      );
      if (
        outputPath === verified.archivePath ||
        outputPath === path.resolve(verified.checksumPath)
      ) {
        throw new Error("SBOM output must differ from the archive and checksum file");
      }
      if (!options.force && (await pathExists(outputPath))) {
        throw new Error(`SBOM output already exists: ${outputPath}`);
      }
      const sourcePath = resolveWithin(verified.extractDir, verified.manifest.sbom.path, "SBOM path");
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.copyFile(sourcePath, outputPath);
      await fsp.chmod(outputPath, 0o644);
      const result = {
        archivePath: verified.archivePath,
        outputPath,
        sha256: await hashFile(outputPath),
        ...verified.sbom
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Release archive: ${result.archivePath}`);
        console.log(`SBOM output: ${result.outputPath}`);
        console.log(`Format: ${result.format} ${result.specVersion}`);
        console.log(`Components: ${result.componentCount}`);
        console.log(`Dependencies: ${result.dependencyCount}`);
        console.log(`SBOM SHA-256: ${result.sha256}`);
      }
    } finally {
      await verified.cleanup();
    }
    return;
  }

  if (options.command === "audit") {
    if (!options.archive) {
      throw new Error("audit requires --archive <file.tar.gz>");
    }
    let signature = null;
    if (options.publicKey || options.signature || options.requireSignature) {
      signature = await verifySignatureOrThrow(options, "audit");
    }
    const result = await generateReleaseAudit({
      archivePath: options.archive,
      checksumPath: options.checksum,
      dispositionsPath: options.dispositions,
      signature,
      outputPath: options.output,
      vexOutputPath: options.vexOutput,
      force: options.force
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printAudit(result);
    }
    if (result.report.status !== "passed") {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "evidence") {
    if (!options.archive || !options.sbom || !options.audit || !options.vex) {
      throw new Error(
        "evidence requires --archive, --sbom, --audit, and --vex"
      );
    }
    const signaturePath =
      options.signature ||
      (options.publicKey || options.requireSignature
        ? signaturePathFor(options.archive)
        : undefined);
    if (options.requireSignature && !signaturePath) {
      throw new Error("evidence --require-signature requires a signature file");
    }
    if (signaturePath && !options.publicKey) {
      throw new Error("evidence signature verification requires --public-key <file.pem>");
    }
    const result = await createReleaseEvidence({
      archivePath: options.archive,
      checksumPath: options.checksum,
      sbomPath: options.sbom,
      auditPath: options.audit,
      vexPath: options.vex,
      signaturePath,
      publicKeyPath: options.publicKey,
      outputPath: options.output,
      force: options.force
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printEvidence(result);
    }
    if (result.evidence.status !== "passed") {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "verify-evidence") {
    if (!options.evidence) {
      throw new Error("verify-evidence requires --evidence <file.json>");
    }
    const result = await verifyReleaseEvidence({
      evidencePath: options.evidence,
      publicKeyPath: options.publicKey
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printVerifiedEvidence(result);
    }
    if (result.status !== "passed") {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "status") {
    const result = await listReleases({ releaseRoot: releaseRoot(options) });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Release root: ${result.releaseRoot}`);
    console.log(`Current: ${result.current || "none"}`);
    console.log(`Previous: ${result.previous || "none"}`);
    if (result.releases.length === 0) {
      console.log("Installed releases: none");
      return;
    }
    console.log("Installed releases:");
    for (const release of result.releases) {
      const marker = release.current ? "*" : release.previous ? "^" : " ";
      console.log(
        `  ${marker} ${release.releaseId}${release.error ? ` (invalid: ${release.error})` : ""}`
      );
    }
    return;
  }

  if (options.command === "install") {
    if (!options.archive) {
      throw new Error("install requires --archive <file.tar.gz>");
    }
    await verifyBackupIfProvided(options);
    const result = await installRelease({
      archivePath: options.archive,
      checksumPath: options.checksum,
      releaseRoot: releaseRoot(options),
      stateBackup: options.stateBackup,
      service: options.service || "rpi4-gateway",
      healthUrl: options.healthUrl || DEFAULT_HEALTH_URL,
      healthTimeoutMs: healthTimeout(options),
      requireSignature: options.requireSignature,
      publicKeyPath: options.publicKey,
      signaturePath: options.signature
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Release installed: ${result.releaseId}`);
      console.log(`Release directory: ${result.releaseDir}`);
      console.log(`Previous: ${result.previousReleaseId || "none"}`);
      console.log(
        result.signature
          ? `Signature: verified (SHA-256, key ${result.signature.keyFingerprint})`
          : "Signature: not verified"
      );
    }
    return;
  }

  await verifyBackupIfProvided(options);
  const result = await rollbackRelease({
    toReleaseId: options.to,
    releaseRoot: releaseRoot(options),
    service: options.service || "rpi4-gateway",
    healthUrl: options.healthUrl || DEFAULT_HEALTH_URL,
    healthTimeoutMs: healthTimeout(options)
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Release rolled back to: ${result.releaseId}`);
    console.log(`Previous: ${result.previousReleaseId}`);
  }
}

main().catch((error) => {
  console.error(`[release] ${error.message}`);
  process.exitCode = 1;
});
