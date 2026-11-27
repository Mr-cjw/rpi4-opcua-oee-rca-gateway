#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { loadGatewayConfig } = require("../src/gateway/config");
const {
  MANIFEST_FILE,
  createStateBackup,
  restoreStateBackup,
  verifyStateBackup
} = require("../src/gateway/state-backup");

function usage() {
  console.log(
    [
      "Usage:",
      "  npm run state:backup -- --output <directory> [--state-dir <directory>] [--force] [--json]",
      "  npm run state:verify -- --backup <directory> [--json]",
      "  npm run state:restore -- --backup <directory> [--state-dir <directory>] [--force] [--json]",
      "",
      "Backup includes the configured process-context and quality JSONL files",
      "(including rotated segments), the quality idempotency ledger, and the",
      "work-context state. Stop the Gateway before backup or restore for a",
      "consistent snapshot. OPC UA PKI material is intentionally excluded.",
      "",
      "  --force  Replace an existing backup directory or restore destination.",
      "  --json   Print the machine-readable result."
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    force: false,
    json: false,
    help: false
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const valueOptions = new Map([
      ["--output", "output"],
      ["--backup", "backup"],
      ["--state-dir", "stateDir"]
    ]);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (
    options.help ||
    !new Set(["backup", "verify", "restore"]).has(options.command)
  ) {
    usage();
    if (!options.help) {
      process.exitCode = 2;
    }
    return;
  }

  if (options.command === "verify") {
    if (!options.backup) {
      throw new Error("verify requires --backup <directory>");
    }
    const result = await verifyStateBackup({ backupDir: options.backup });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`State backup verified: ${result.backupDir}`);
      console.log(`Files: ${result.manifest.fileCount}`);
      console.log(`Created: ${result.manifest.createdAt}`);
    }
    return;
  }

  const config = loadGatewayConfig();
  const stateDir = path.resolve(options.stateDir || config.storage.diskPath);
  if (options.command === "backup") {
    if (!options.output) {
      throw new Error("backup requires --output <directory>");
    }
    const result = await createStateBackup({
      stateDir,
      outputPath: options.output,
      config,
      force: options.force
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`State backup created: ${result.outputPath}`);
      console.log(`Files: ${result.manifest.fileCount}`);
      console.log(`Bytes: ${result.manifest.totalBytes}`);
      console.log(`Missing configured files: ${result.manifest.missingFiles.length}`);
      console.log(`Manifest: ${path.join(result.outputPath, MANIFEST_FILE)}`);
    }
    return;
  }

  if (!options.backup) {
    throw new Error("restore requires --backup <directory>");
  }
  const result = await restoreStateBackup({
    backupDir: options.backup,
    stateDir,
    force: options.force
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`State restored to: ${result.stateDir}`);
    console.log(`Files restored: ${result.restoredFiles.length}`);
    console.log(`Backup created: ${result.manifest.createdAt}`);
  }
}

main().catch((error) => {
  console.error(`[state] ${error.message}`);
  process.exitCode = 1;
});
