"use strict";

const { loadConfig } = require("./config");
const { createMockPlcServer } = require("./server");

async function main() {
  const config = loadConfig();
  const instance = createMockPlcServer(config);
  const running = await instance.start();

  console.log("Raspberry Pi Mock PLC is running");
  console.log(`  Endpoint: ${running.endpointUrl}`);
  console.log(`  Namespace: ${running.namespaceUri} (ns=${running.namespaceIndex})`);
  console.log(`  Update interval: ${config.simulation.intervalMs} ms`);
  console.log(`  Random seed: ${config.simulation.seed}`);
  console.log("  Security: None / anonymous (E2E test use only)");
  console.log("Press Ctrl+C to stop.");

  let shuttingDown = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\nStopping mock PLC (${reason})...`);

    const forcedExit = setTimeout(() => {
      console.error("Mock PLC shutdown timed out.");
      process.exit(exitCode || 1);
    }, 15000);
    forcedExit.unref();

    try {
      await instance.stop();
      clearTimeout(forcedExit);
      process.exitCode = exitCode;
    } catch (error) {
      clearTimeout(forcedExit);
      console.error("Mock PLC shutdown failed:", error);
      process.exitCode = exitCode || 1;
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
    void shutdown("unhandledRejection", 1);
  });
}

main().catch((error) => {
  console.error("Unable to start Raspberry Pi Mock PLC:", error);
  process.exitCode = 1;
});
