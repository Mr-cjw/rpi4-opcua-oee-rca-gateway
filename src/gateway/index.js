"use strict";

const { loadGatewayConfig } = require("./config");
const { GatewayRuntime } = require("./runtime");

async function main() {
  const config = loadGatewayConfig();
  const runtime = new GatewayRuntime(config);

  let shuttingDown = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gateway] Stopping OPC UA client (${reason})...`);

    const forcedExit = setTimeout(() => {
      console.error("[gateway] OPC UA client shutdown timed out.");
      process.exit(exitCode || 1);
    }, 15000);
    forcedExit.unref();

    try {
      await runtime.stop();
      clearTimeout(forcedExit);
      process.exitCode = exitCode;
    } catch (error) {
      clearTimeout(forcedExit);
      console.error("[gateway] OPC UA client shutdown failed:", error);
      process.exitCode = exitCode || 1;
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    console.error("[gateway] Uncaught exception:", error);
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    console.error("[gateway] Unhandled rejection:", error);
    void shutdown("unhandledRejection", 1);
  });

  try {
    await runtime.start();
  } catch (error) {
    if (shuttingDown) {
      return;
    }
    throw error;
  }

  console.log("[gateway] OPC UA client is connected and subscribed.");
  console.log(`[gateway] Context API: ${runtime.api.address}`);
  console.log(
    `[gateway] Identity: line=${config.identity.lineId} station=${config.identity.stationId}`
  );
  console.log(
    `[gateway] Context log: ${config.context.logPath || "disabled"}`
  );
  if (process.env.OPCUA_LOG_SNAPSHOT === "1") {
    console.log(
      `[gateway] Initial snapshot: ${JSON.stringify(runtime.client.getSnapshot(), null, 2)}`
    );
  }
  console.log("[gateway] Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error("[gateway] Unable to start OPC UA client:", error);
  process.exitCode = 1;
});
