#!/usr/bin/env node
"use strict";

const {
  formatHardwareReport,
  parseHardwareArgs,
  runHardwareCheck,
  writeHardwareReport
} = require("../src/hardware/check");

async function main() {
  let options;
  try {
    options = parseHardwareArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[hardware:check] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: npm run hardware:check -- [options]",
        "",
        "Checks Raspberry Pi 4 hardware readiness: model, 64-bit runtime,",
        "CPU temperature, under-voltage/throttling, NTP, and root storage.",
        "",
        "Options:",
        "  --storage-path <dir>       Filesystem path to check (default /)",
        "  --warn-temp-c <n>          CPU temperature warning threshold (default 70)",
        "  --max-temp-c <n>           CPU temperature failure threshold (default 80)",
        "  --warn-free-bytes <n>      Free-space warning threshold (default 104857600)",
        "  --critical-free-bytes <n>  Free-space failure threshold (default 33554432)",
        "  --output <file>            Write a mode-0600 JSON report",
        "  --force                    Replace an existing report",
        "  --strict                   Return non-zero for warnings as well as failures",
        "  --json                     Print the machine-readable report",
        "",
        "vcgencmd is used when available. Missing telemetry is a warning, not a pass."
      ].join("\n")
    );
    return;
  }

  const report = await runHardwareCheck(options);
  if (options.output) {
    report.outputPath = await writeHardwareReport(report, options.output, {
      force: options.force
    });
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHardwareReport(report));
  }
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  console.error(`[hardware:check] ${error.message}`);
  process.exitCode = 2;
});
