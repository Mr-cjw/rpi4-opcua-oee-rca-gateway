"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DataType } = require("node-opcua");
const { OpcUaGatewayClient } = require("../src/gateway/opcua-client");

function dataValue(value, statusCode, now) {
  return {
    value: { value, dataType: DataType.Double },
    statusCode: { toString: () => statusCode },
    sourceTimestamp: new Date(now),
    serverTimestamp: new Date(now)
  };
}

test("gateway snapshot excludes non-Good values while diagnostics retain them", () => {
  const now = Date.parse("2026-11-27T10:00:00.000Z");
  const client = new OpcUaGatewayClient({
    endpointUrl: "opc.tcp://127.0.0.1:1/UA/MockPLC",
    variables: [],
    logger: { info() {}, warn() {}, error() {} }
  });

  client._handleVariableData(
    { name: "temperatureSensor", nodeId: "ns=1;s=Temperature" },
    dataValue(24.5, "Good (0x00000000)", now)
  );
  client._handleVariableData(
    { name: "currentOutput", nodeId: "ns=1;s=CurrentOutput" },
    dataValue(null, "Bad (0x80340000)", now)
  );

  assert.deepEqual(Object.keys(client.getSnapshot()), ["temperatureSensor"]);
  const diagnostics = client.getStatus();
  assert.equal(diagnostics.summary.variables, 2);
  assert.equal(diagnostics.summary.badValues, 1);
  assert.equal(
    diagnostics.variables.find((variable) => variable.name === "currentOutput").good,
    false
  );
});
