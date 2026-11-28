#!/usr/bin/env node
"use strict";

const {
  formatSupplyChainReport,
  parseSupplyChainArgs,
  runSupplyChainReview
} = require("../src/release/supply-chain");

async function main() {
  let options;
  try {
    options = parseSupplyChainArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[supply-chain] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: npm run supply-chain:check -- [options]",
        "       npm run supply-chain:baseline -- [options]",
        "",
        "Validates the lockfile, direct dependency ranges, production dependency",
        "inventory, Node.js minimum-runtime coverage, and advisory dispositions",
        "against security/supply-chain-baseline.json.",
        "",
        "Options:",
        "  --root <dir>          Repository root (default current directory)",
        "  --baseline <file>     Baseline path (default security/supply-chain-baseline.json)",
        "  --dispositions <file> VEX dispositions path",
        "  --output <file>       Write a mode-0600 review report",
        "  --write-baseline      Replace the baseline after an intentional review",
        "  --json                Print the machine-readable result",
        "  --help, -h            Show this help",
        "",
        "Do not hand-edit the baseline. Update dependencies, run audit/VEX review,",
        "then regenerate it and review the resulting diff."
      ].join("\n")
    );
    return;
  }

  try {
    const result = await runSupplyChainReview(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatSupplyChainReport(result.report));
    }
    process.exitCode = result.report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(`[supply-chain] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
