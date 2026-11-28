#!/usr/bin/env node
"use strict";

const {
  formatEdgeReport,
  parseEdgeArgs,
  verifyEdge
} = require("../src/edge/verify");

async function main() {
  const options = parseEdgeArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: npm run edge:verify -- --url <https-url> [options]",
        "",
        "Verifies the site-facing nginx edge without bypassing certificate checks.",
        "",
        "Options:",
        "  --http-url <url>          HTTP base URL for the redirect check",
        "  --skip-http-redirect      Skip the HTTP-to-HTTPS redirect check",
        "  --origin-url <url>        Loopback Gateway URL, typically http://127.0.0.1:8080",
        "  --token-file <file>       Mode-0600 file containing GATEWAY_API_TOKEN",
        "  --ca-file <file>          Private CA chain for the edge certificate",
        "  --client-cert-file <file> mTLS client certificate in PEM format",
        "  --client-key-file <file>  Mode-0600 mTLS client private key",
        "  --min-cert-days <n>       Minimum certificate lifetime remaining (default 14)",
        "  --timeout-ms <n>          Per-connection timeout (default 10000)",
        "  --strict                  Fail on warnings as well as failures",
        "  --json                    Print the machine-readable report",
        "",
        "If --token-file is omitted, GATEWAY_API_TOKEN is read from the environment.",
        "Do not pass tokens on the command line."
      ].join("\n")
    );
    return;
  }

  const report = await verifyEdge(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatEdgeReport(report));
  }
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  console.error(`[edge:verify] ${error.message}`);
  process.exitCode = 2;
});
