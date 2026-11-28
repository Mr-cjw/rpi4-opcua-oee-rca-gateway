#!/usr/bin/env node
"use strict";

const {
  formatFieldDrillResult,
  parseFieldDrillArgs,
  runFieldDrill
} = require("../src/field-drill/drill");

async function main() {
  let options;
  try {
    options = parseFieldDrillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[field:drill] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      [
        "Usage: npm run field:drill -- --state-dir <dir> --phase <phase> [options]",
        "",
        "Runs a staged Raspberry Pi field drill without rebooting or changing",
        "certificates automatically. Run preflight first; later phases reuse the",
        "configuration stored in the protected state directory.",
        "",
        "Phases:",
        "  preflight       Verify archive/signature/hardware and record boot ID",
        "  install         Install the release; requires --execute",
        "  post-install    Run strict commissioning after install",
        "  post-reboot     Require a new boot ID, hardware pass, and commissioning",
        "  rotation-after  Require the edge certificate fingerprint to change",
        "  rollback        Roll back, commission, and finalize evidence",
        "  finalize        Rebuild the evidence manifest and checksums",
        "",
        "Preflight options:",
        "  --archive <file>           Signed release archive",
        "  --checksum <file>          Archive checksum (default <archive>.sha256)",
        "  --signature <file>         Detached signature (default <archive>.sig)",
        "  --public-key <file>        Release-signing public key",
        "  --signer-fingerprint <sha256>  Pin the release public key fingerprint",
        "  --require-signature        Fail unless the signature verifies",
        "  --state-backup <dir>       Verified state backup for the drill",
        "  --url <https-url>          Approved edge URL",
        "  --http-url <url>           HTTP redirect URL override",
        "  --origin-url <url>         Loopback Gateway URL",
        "  --token-file <file>        Mode-0600 GATEWAY_API_TOKEN file",
        "  --ca-file <file>           Private edge CA chain",
        "  --client-cert-file <file>  mTLS client certificate",
        "  --client-key-file <file>   Mode-0600 mTLS client key",
        "  --max-uptime-seconds <n>   Post-reboot uptime limit (default 600)",
        "  --release-root <dir>       Installed release root",
        "  --service <name>           systemd service name",
        "  --storage-path <dir>       State filesystem for hardware checks",
        "  --skip-hardware            Skip preflight/post-reboot hardware reports",
        "",
        "Phase control:",
        "  --state-dir <dir>          Mode-0700 drill state directory (required)",
        "  --phase <name>             Phase to execute (required)",
        "  --execute                  Permit install or rollback mutations",
        "  --json                     Print the machine-readable result",
        "",
        "The operator must reboot between post-install and post-reboot and must",
        "rotate the edge certificate between post-reboot and rotation-after.",
        "Tokens are read only from --token-file or GATEWAY_API_TOKEN."
      ].join("\n")
    );
    return;
  }

  try {
    const result = await runFieldDrill(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatFieldDrillResult(result));
    }
    process.exitCode = result.status === "fail" ? 1 : 0;
  } catch (error) {
    console.error(`[field:drill] ${error.message}`);
    process.exitCode = error.exitCode || 1;
  }
}

main();
