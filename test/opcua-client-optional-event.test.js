"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { createMockPlcServer } = require("../src/server");
const { OpcUaGatewayClient } = require("../src/gateway/opcua-client");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForData(client, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("data", onData);
      reject(new Error("Timed out waiting for variable data"));
    }, timeoutMs);
    function onData(payload) {
      if (payload.name === "deviceStatus") {
        clearTimeout(timer);
        client.off("data", onData);
        resolve(payload);
      }
    }
    client.on("data", onData);
  });
}

test("gateway client connects without native OPC UA event subscription", { timeout: 20000 }, async (t) => {
  const port = await getFreePort();
  const pkiRoot = path.join(os.tmpdir(), `opcua-optional-event-${Date.now()}-${port}`);
  const serverConfig = loadConfig({
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: pkiRoot,
    SIM_INTERVAL_MS: "100",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0"
  });
  const server = createMockPlcServer(serverConfig);
  const running = await server.start();
  const client = new OpcUaGatewayClient({
    endpointUrl: running.endpointUrl,
    pkiRoot,
    eventNodeId: null,
    subscription: {
      publishingIntervalMs: 100,
      samplingIntervalMs: 100
    },
    logger: { info() {}, warn() {}, error() {} }
  });

  t.after(async () => {
    await client.stop();
    await server.stop();
    await fs.rm(pkiRoot, { recursive: true, force: true });
  });

  const data = waitForData(client);
  await client.start();
  const payload = await data;
  assert.equal(payload.value, "RUNNING");
  assert.equal(client.isConnected, true);
});
