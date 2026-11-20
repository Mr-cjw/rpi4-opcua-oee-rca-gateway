"use strict";

const { loadGatewayConfig } = require("./config");
const { OpcUaGatewayClient } = require("./opcua-client");

async function main() {
  const config = loadGatewayConfig();
  const client = new OpcUaGatewayClient(config);

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
      await client.stop();
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
    await client.start();
  } catch (error) {
    if (shuttingDown) {
      return;
    }
    throw error;
  }

  console.log("[gateway] OPC UA client is connected and subscribed.");
  if (process.env.OPCUA_LOG_SNAPSHOT === "1") {
    console.log(
      `[gateway] Initial snapshot: ${JSON.stringify(client.getSnapshot(), null, 2)}`
    );
  }
}

main().catch((error) => {
  console.error("[gateway] Unable to start OPC UA client:", error);
  process.exitCode = 1;
});
