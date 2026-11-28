#!/usr/bin/env node
"use strict";

const {
  formatCommissionReport,
  parseCommissionArgs,
  runCommission,
  writeCommissionReport
} = require("../src/commission/report");

async function main() {
  const options = parseCommissionArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: npm run commission -- --url <https-url> [options]",
        "",
        "Runs field-acceptance checks for an installed Raspberry Pi Gateway.",
        "",
        "Options:",
        "  --url <https-url>          Edge URL to verify (required unless --skip-edge)",
        "  --http-url <url>           HTTP base URL for the redirect check",
        "  --skip-http-redirect       Skip the HTTP-to-HTTPS redirect check",
        "  --origin-url <url>         Loopback Gateway URL (default http://127.0.0.1:8080)",
        "  --token-file <file>        Mode-0600 file containing GATEWAY_API_TOKEN",
        "  --ca-file <file>           Private CA chain for the edge certificate",
        "  --client-cert-file <file>  mTLS client certificate in PEM format",
        "  --client-key-file <file>   Mode-0600 mTLS client private key",
        "  --min-cert-days <n>        Minimum certificate lifetime remaining (default 14)",
        "  --timeout-ms <n>           Per-connection timeout (default 10000)",
        "  --release-root <dir>       Installed release root",
        "  --service <name>           systemd service name (default rpi4-gateway)",
        "  --max-uptime-seconds <n>   Fail unless the Gateway started within this window",
        "  --skip-doctor              Skip the read-only OPC UA doctor",
        "  --skip-edge                Skip edge verification",
        "  --output <file>            Write the JSON acceptance report",
        "  --force                    Replace an existing report",
        "  --strict                   Return non-zero for warnings as well as failures",
        "  --json                     Print the machine-readable report",
        "",
        "If --token-file is omitted, GATEWAY_API_TOKEN is read from the environment.",
        "Do not pass tokens on the command line."
      ].join("\n")
    );
    return;
  }

  const report = await runCommission(options);
  if (options.output) {
    report.outputPath = await writeCommissionReport(report, options.output, {
      force: options.force
    });
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCommissionReport(report));
  }
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  console.error(`[commission] ${error.message}`);
  process.exitCode = 2;
});
