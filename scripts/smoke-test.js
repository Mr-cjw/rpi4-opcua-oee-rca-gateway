"use strict";

const path = require("node:path");
const {
  AttributeIds,
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  constructEventFilter,
  ofType
} = require("node-opcua");
const { loadConfig } = require("../src/config");
const { NODE_IDS } = require("../src/server");

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function monitor(subscription, itemToMonitor, parameters) {
  return new Promise((resolve, reject) => {
    subscription.monitor(
      itemToMonitor,
      parameters,
      TimestampsToReturn.Both,
      (error, monitoredItem) => (error ? reject(error) : resolve(monitoredItem))
    );
  });
}

async function main() {
  const config = loadConfig();
  const endpointUrl =
    process.env.OPCUA_ENDPOINT ||
    `opc.tcp://localhost:${config.opcua.port}${config.opcua.resourcePath}`;
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: {
      initialDelay: 250,
      maxRetry: 3,
      maxDelay: 2000
    },
    clientCertificateManager: new OPCUACertificateManager({
      rootFolder: path.join(config.opcua.pkiRoot, "smoke-client"),
      automaticallyAcceptUnknownCertificate: true
    })
  });

  let session;
  let subscription;
  let statusItem;
  let eventItem;

  try {
    await client.connect(endpointUrl);
    session = await client.createSession();

    console.log(`Connected to ${endpointUrl}`);
    const values = {};
    for (const [name, nodeId] of Object.entries(NODE_IDS)) {
      if (name.startsWith("trigger") || name === "resumeNormal" || name === "mockPlc") {
        continue;
      }
      const dataValue = await session.read({ nodeId, attributeId: AttributeIds.Value });
      values[name] = dataValue.value?.value;
      console.log(
        `  ${name.padEnd(20)} ${String(values[name])} (${dataValue.statusCode.toString()})`
      );
    }

    subscription = await session.createSubscription2({
      requestedPublishingInterval: 250,
      requestedLifetimeCount: 300,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10
    });

    const statusChanged = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("DeviceStatus subscription timed out")), 5000);
      statusItem = null;
      monitor(
        subscription,
        { nodeId: NODE_IDS.deviceStatus, attributeId: AttributeIds.Value },
        { samplingInterval: 100, queueSize: 10, discardOldest: true }
      ).then((item) => {
        statusItem = item;
        item.on("changed", (dataValue) => {
          if (dataValue.value?.value === "DOWN") {
            clearTimeout(timeout);
            resolve(dataValue.value.value);
          }
        });
      }, reject);
    });

    const eventReceived = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Alarm event subscription timed out")), 5000);
      const fields = [
        "EventId",
        "EventType",
        "SourceNode",
        "SourceName",
        "Time",
        "Message",
        "Severity",
        "1:AlarmCode",
        "1:AlarmSequence"
      ];
      const eventFilter = constructEventFilter(fields, ofType("BaseEventType"));
      monitor(
        subscription,
        { nodeId: NODE_IDS.mockPlc, attributeId: AttributeIds.EventNotifier },
        {
          samplingInterval: 0,
          queueSize: 100,
          discardOldest: false,
          filter: eventFilter
        }
      ).then((item) => {
        eventItem = item;
        item.on("changed", (eventFields) => {
          clearTimeout(timeout);
          resolve(eventFields);
        });
      }, reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 600));

    const callResult = await session.call({
      objectId: NODE_IDS.mockPlc,
      methodId: NODE_IDS.triggerDowntime,
      inputArguments: [{ dataType: DataType.UInt32, value: 8 }]
    });

    if (callResult.statusCode.isNot(StatusCodes.Good)) {
      throw new Error(`TriggerDowntime failed: ${callResult.statusCode.toString()}`);
    }

    const [status, eventFields] = await Promise.all([
      withTimeout(statusChanged, 5000, "DeviceStatus subscription"),
      withTimeout(eventReceived, 5000, "Alarm event subscription")
    ]);

    console.log(`Subscription confirmed DeviceStatus=${status}`);
    const customAlarmCode = eventFields.at(-2)?.value;
    if (customAlarmCode !== "DOWNTIME") {
      throw new Error(`Unexpected custom event field AlarmCode=${customAlarmCode}`);
    }
    console.log(
      `Alarm event received (${eventFields.length} selected fields, AlarmCode=${customAlarmCode})`
    );

    const alarms = await session.read({
      nodeId: NODE_IDS.alarmEvents,
      attributeId: AttributeIds.Value
    });
    const alarmSnapshot = JSON.parse(alarms.value.value);
    if (alarmSnapshot.latest?.code !== "DOWNTIME") {
      throw new Error(`Unexpected AlarmEvents payload: ${alarms.value.value}`);
    }
    console.log(`AlarmEvents node confirms code=${alarmSnapshot.latest.code}`);

    await session.call({
      objectId: NODE_IDS.mockPlc,
      methodId: NODE_IDS.resumeNormal,
      inputArguments: []
    });

    console.log("Smoke test passed.");
  } finally {
    if (eventItem) {
      await eventItem.terminate().catch(() => undefined);
    }
    if (statusItem) {
      await statusItem.terminate().catch(() => undefined);
    }
    if (subscription) {
      await subscription.terminate().catch(() => undefined);
    }
    if (session) {
      await session.close().catch(() => undefined);
    }
    await client.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});
