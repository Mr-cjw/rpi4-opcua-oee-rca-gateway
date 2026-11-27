#!/usr/bin/env node
"use strict";

const { loadGatewayConfig } = require("../src/gateway/config");
const { formatDoctorReport, runGatewayDoctor } = require("../src/gateway/doctor");

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--json", "--strict", "--help"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) {
    throw new Error(`unknown option: ${unknown}`);
  }
  if (args.includes("--help")) {
    console.log(
      [
        "Usage: npm run doctor -- [--json] [--strict]",
        "",
        "Reads the configured OPC UA endpoint and validates NodeIds, data types,",
        "status codes, timestamps, and counter invariants.",
        "",
        "  --json    Print the full machine-readable report.",
        "  --strict  Exit non-zero for warnings as well as failures."
      ].join("\n")
    );
    return;
  }

  const config = loadGatewayConfig();
  const report = await runGatewayDoctor(config);
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }

  if (report.overallStatus === "fail" || (args.includes("--strict") && report.overallStatus === "warn")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[doctor] ${error.message}`);
  process.exitCode = 2;
});
