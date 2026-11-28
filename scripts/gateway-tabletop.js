#!/usr/bin/env node
"use strict";

const {
  formatTabletopReport,
  parseTabletopArgs,
  runOfflineTabletop
} = require("../src/tabletop/exercise");

async function main() {
  let options;
  try {
    options = parseTabletopArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[tabletop] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: npm run tabletop -- [options]",
        "",
        "Runs the offline operational tabletop for PLC loss, disk-full, NTP",
        "loss, failed upgrade and automatic rollback, explicit rollback,",
        "state restore, and state-format rejection.",
        "",
        "Options:",
        "  --output <file>        Report path (default data/offline-tabletop-report.json)",
        "  --evidence-dir <dir>   Per-scenario evidence directory (mode 0700)",
        "  --force                Replace an existing report and evidence set",
        "  --json                 Print the machine-readable result",
        "  --help, -h             Show this help",
        "",
        "The exercise uses local processes, synthetic release archives, and",
        "injected failures. Its L1/L2 evidence cannot satisfy an L3/L4",
        "hardware, network, power-loss, certificate, or site-acceptance gate."
      ].join("\n")
    );
    return;
  }

  try {
    const result = await runOfflineTabletop(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTabletopReport(result.report));
    }
    process.exitCode = result.report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(`[tabletop] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
