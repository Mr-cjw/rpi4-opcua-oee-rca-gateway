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
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function waitForEvent(emitter, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    function onEvent(payload) {
      if (!predicate || predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      emitter.off(eventName, onEvent);
    }

    emitter.on(eventName, onEvent);
  });
}

test("gateway client subscribes to values and native alarm events", { timeout: 30000 }, async (t) => {
  const port = await getFreePort();
  const pkiRoot = path.join(os.tmpdir(), `opcua-client-test-${Date.now()}-${port}`);
  const serverConfig = loadConfig({
    ...process.env,
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: pkiRoot,
    SIM_INTERVAL_MS: "100",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0"
  });
  let server = createMockPlcServer(serverConfig);
  const running = await server.start();

  const logRecords = [];
  const client = new OpcUaGatewayClient({
    endpointUrl: running.endpointUrl,
    pkiRoot,
    subscription: {
      publishingIntervalMs: 100,
      samplingIntervalMs: 100,
      queueSize: 20,
      eventQueueSize: 100
    },
    logger: {
      info: (record) => logRecords.push(record),
      warn: (record) => logRecords.push(record),
      error: (record) => logRecords.push(record)
    }
  });

  t.after(async () => {
    await client.stop();
    await server.stop();
    await fs.rm(pkiRoot, { recursive: true, force: true });
  });

  const initialData = waitForEvent(
    client,
    "data",
    (payload) => payload.name === "deviceStatus" && payload.value === "RUNNING"
  );
  await client.start();
  const initialStatus = await initialData;

  assert.equal(client.isConnected, true);
  assert.equal(initialStatus.dataType, "String");
  assert.equal(initialStatus.statusCode, "Good (0x00000000)");
  assert.equal(client.getSnapshot().deviceStatus.value, "RUNNING");
  assert.equal("fingerprint" in client.getSnapshot().deviceStatus, false);

  const alarmReceived = waitForEvent(
    client,
    "alarm",
    (payload) => payload.alarmCode === "DOWNTIME"
  );
  server.simulator.triggerDowntime(2, "gateway-client-test");
  const alarm = await alarmReceived;

  assert.equal(alarm.sourceName, "MockPLC");
  assert.equal(alarm.deviceStatus, "DOWN");
  assert.ok(alarm.alarmSequence >= 1);
  assert.ok(
    logRecords.some(
      (record) => record.type === "event" && record.alarmCode === "DOWNTIME"
    )
  );

  const disconnected = waitForEvent(
    client,
    "connectionState",
    (payload) => payload.state === "disconnected",
    15000
  );
  await server.stop();
  await disconnected;

  server = createMockPlcServer(serverConfig);
  await server.start();
  await waitForEvent(
    client,
    "connectionState",
    (payload) => payload.state === "connected",
    15000
  );
  assert.equal(client.isConnected, true);
});
