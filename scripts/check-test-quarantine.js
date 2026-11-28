#!/usr/bin/env node
"use strict";

const {
  formatQuarantineReport,
  parseQuarantineArgs,
  runTestQuarantineCheck
} = require("../src/reliability/test-quarantine");

async function main() {
  let options;
  try {
    options = parseQuarantineArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[test-quarantine] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: npm run check:quarantine -- [options]",
        "",
        "Validates security/flaky-tests.json. Every quarantined test requires an",
        "owner, reason, tracking issue, evidence, quarantine date, and future",
        "removal date. Expired or malformed records fail the release gate.",
        "",
        "Options:",
        "  --root <dir>       Repository root (default current directory)",
        "  --registry <file>  Registry path (default security/flaky-tests.json)",
        "  --output <file>    Write a mode-0600 review report",
        "  --json             Print the machine-readable result",
        "  --help, -h         Show this help"
      ].join("\n")
    );
    return;
  }

  try {
    const result = await runTestQuarantineCheck(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatQuarantineReport(result.report));
    }
    process.exitCode = result.report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(`[test-quarantine] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
