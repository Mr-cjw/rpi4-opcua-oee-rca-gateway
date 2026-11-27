"use strict";

const path = require("node:path");
const {
  DataType,
  DataValue,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAServer,
  SecurityPolicy,
  StatusCodes,
  Variant
} = require("node-opcua");
const { MockPlcSimulator } = require("./simulator");
const { loadConfig } = require("./config");

const NODE_IDS = Object.freeze({
  mockPlc: "ns=1;s=MockPLC",
  deviceStatus: "ns=1;s=MockPLC.DeviceStatus",
  currentOutput: "ns=1;s=MockPLC.CurrentOutput",
  goodCount: "ns=1;s=MockPLC.GoodCount",
  totalProducedCount: "ns=1;s=MockPLC.TotalProducedCount",
  temperatureSensor: "ns=1;s=MockPLC.TemperatureSensor",
  alarmEvents: "ns=1;s=MockPLC.AlarmEvents",
  alarmEventCount: "ns=1;s=MockPLC.AlarmEventCount",
  triggerDowntime: "ns=1;s=MockPLC.TriggerDowntime",
  triggerTemperatureSpike: "ns=1;s=MockPLC.TriggerTemperatureSpike",
  resumeNormal: "ns=1;s=MockPLC.ResumeNormal"
});

function variableValue(dataType, value) {
  return { dataType, value };
}

function addAlarmEventType(namespace) {
  const eventType = namespace.addEventType({
    browseName: "MockPLCAlarmEventType",
    subtypeOf: "BaseEventType"
  });

  const fields = [
    ["AlarmCode", DataType.String],
    ["AlarmCause", DataType.String],
    ["DeviceStatus", DataType.String],
    ["TemperatureC", DataType.Double],
    ["CurrentOutput", DataType.Double],
    ["GoodCount", DataType.UInt32],
    ["TotalProducedCount", DataType.UInt32],
    ["AlarmSequence", DataType.UInt32]
  ];

  for (const [browseName, dataType] of fields) {
    namespace.addVariable({
      browseName,
      propertyOf: eventType,
      modellingRule: "Mandatory",
      dataType
    });
  }

  return eventType;
}

function addNodeSet(server, simulator) {
  const addressSpace = server.engine.addressSpace;
  const namespace = addressSpace.getOwnNamespace();
  const namespaceIndex = namespace.index;

  if (namespaceIndex !== 1) {
    throw new Error(
      `Mock PLC needs OPC UA namespace index 1 for stable NodeIds, but got ${namespaceIndex}`
    );
  }

  const mockPlc = namespace.addObject({
    nodeId: "s=MockPLC",
    browseName: "MockPLC",
    displayName: "Raspberry Pi Mock PLC",
    description: "Deterministic mock production cell used for Gateway and RCA E2E tests",
    typeDefinition: "FolderType",
    eventNotifier: 0x01,
    organizedBy: addressSpace.rootFolder.objects
  });

  const deviceStatus = namespace.addVariable({
    nodeId: "s=MockPLC.DeviceStatus",
    browseName: "DeviceStatus",
    displayName: "Device Status",
    description: "RUNNING when production is active, DOWN during a simulated fault",
    componentOf: mockPlc,
    dataType: DataType.String,
    value: variableValue(DataType.String, simulator.deviceStatus),
    minimumSamplingInterval: 100
  });

  const currentOutput = namespace.addAnalogDataItem({
    nodeId: "s=MockPLC.CurrentOutput",
    browseName: "CurrentOutput",
    displayName: "Current Output",
    description: "Current production rate in units per minute",
    componentOf: mockPlc,
    dataType: DataType.Double,
    valuePrecision: 0.001,
    engineeringUnitsRange: { low: 0, high: 1000 },
    engineeringUnits: {
      unitId: 4408922,
      displayName: { text: "1/min" },
      description: { text: "units per minute" },
      namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact"
    },
    value: variableValue(DataType.Double, simulator.currentOutput)
  });

  const goodCount = namespace.addVariable({
    nodeId: "s=MockPLC.GoodCount",
    browseName: "GoodCount",
    displayName: "Good Count",
    description: "Monotonic count of good units produced",
    componentOf: mockPlc,
    dataType: DataType.UInt32,
    value: variableValue(DataType.UInt32, simulator.goodCount),
    minimumSamplingInterval: 100
  });

  const totalProducedCount = namespace.addVariable({
    nodeId: "s=MockPLC.TotalProducedCount",
    browseName: "TotalProducedCount",
    displayName: "Total Produced Count",
    description: "Monotonic count of all units produced, including good and rejected units",
    componentOf: mockPlc,
    dataType: DataType.UInt32,
    value: variableValue(DataType.UInt32, simulator.totalProducedCount),
    minimumSamplingInterval: 100
  });

  const temperatureSensor = namespace.addAnalogDataItem({
    nodeId: "s=MockPLC.TemperatureSensor",
    browseName: "TemperatureSensor",
    displayName: "Temperature Sensor",
    description: "Synthetic process temperature in degrees Celsius",
    componentOf: mockPlc,
    dataType: DataType.Double,
    valuePrecision: 0.001,
    engineeringUnitsRange: { low: -40, high: 150 },
    engineeringUnits: {
      unitId: 4408652,
      displayName: { text: "°C" },
      description: { text: "degree Celsius" },
      namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact"
    },
    value: variableValue(DataType.Double, simulator.temperatureC)
  });

  const alarmEvents = namespace.addVariable({
    nodeId: "s=MockPLC.AlarmEvents",
    browseName: "AlarmEvents",
    displayName: "Alarm Events",
    description: "JSON snapshot of active and latest alarms; standard OPC UA events are also emitted",
    componentOf: mockPlc,
    dataType: DataType.String,
    value: variableValue(DataType.String, simulator.alarmEventsJson()),
    minimumSamplingInterval: 100
  });

  const alarmEventCount = namespace.addVariable({
    nodeId: "s=MockPLC.AlarmEventCount",
    browseName: "AlarmEventCount",
    displayName: "Alarm Event Count",
    description: "Monotonic sequence number for emitted alarm events",
    componentOf: mockPlc,
    dataType: DataType.UInt32,
    value: variableValue(DataType.UInt32, simulator.sequence),
    minimumSamplingInterval: 100
  });

  const alarmEventType = addAlarmEventType(namespace);
  mockPlc.addReference({
    referenceType: "AlwaysGeneratesEvent",
    nodeId: alarmEventType.nodeId
  });

  function bindControlMethod(browseName, inputArguments, handler) {
    const method = namespace.addMethod(mockPlc, {
      nodeId: `s=MockPLC.${browseName}`,
      browseName,
      inputArguments,
      outputArguments: []
    });

    method.bindMethod((inputArgumentsFromClient, _context, callback) => {
      try {
        const result = handler(inputArgumentsFromClient);
        if (!result.ok) {
          callback(null, {
            statusCode: result.statusCode,
            outputArguments: []
          });
          return;
        }

        callback(null, {
          statusCode: StatusCodes.Good,
          outputArguments: []
        });
      } catch (error) {
        callback(null, {
          statusCode: StatusCodes.BadInternalError,
          outputArguments: [],
          diagnosticInfos: [{ localizedText: { text: error.message } }]
        });
      }
    });

    return method;
  }

  const durationArgument = (name) => ({
    name,
    dataType: DataType.UInt32,
    description: { text: `${name} in seconds` }
  });

  bindControlMethod(
    "TriggerDowntime",
    [durationArgument("DurationSeconds")],
    (args) => {
      const event = simulator.triggerDowntime(Number(args[0]?.value ?? 20));
      return event
        ? { ok: true }
        : { ok: false, statusCode: StatusCodes.BadInvalidState };
    }
  );

  bindControlMethod(
    "TriggerTemperatureSpike",
    [durationArgument("DurationSeconds"), {
      name: "PeakCelsius",
      dataType: DataType.Double,
      description: { text: "Peak temperature in degrees Celsius" }
    }],
    (args) => {
      const event = simulator.triggerTemperatureSpike(
        Number(args[0]?.value ?? 20),
        Number(args[1]?.value ?? 88)
      );
      return event
        ? { ok: true }
        : { ok: false, statusCode: StatusCodes.BadInvalidState };
    }
  );

  bindControlMethod("ResumeNormal", [], () => {
    simulator.resumeNormal();
    return { ok: true };
  });

  return {
    namespaceIndex,
    namespaceUri: namespace.namespaceUri,
    nodes: {
      mockPlc,
      deviceStatus,
      currentOutput,
      goodCount,
      totalProducedCount,
      temperatureSensor,
      alarmEvents,
      alarmEventCount
    },
    alarmEventType
  };
}

function updateVariable(
  node,
  dataType,
  value,
  {
    statusCode = StatusCodes.Good,
    sourceTimestamp = new Date(),
    serverTimestamp = null
  } = {}
) {
  if (serverTimestamp) {
    node._internal_set_dataValue(
      new DataValue({
        value: new Variant(variableValue(dataType, value)),
        statusCode,
        sourceTimestamp,
        serverTimestamp
      })
    );
    return;
  }
  node.setValueFromSource(
    variableValue(dataType, value),
    statusCode,
    sourceTimestamp
  );
}

function createMockPlcServer(options = loadConfig()) {
  const simulator = MockPlcSimulator.create(options.simulation);
  const opcua = options.opcua;

  const serverCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(opcua.pkiRoot, "server"),
    automaticallyAcceptUnknownCertificate: true
  });

  const userCertificateManager = new OPCUACertificateManager({
    rootFolder: path.join(opcua.pkiRoot, "server-user"),
    automaticallyAcceptUnknownCertificate: true
  });

  const server = new OPCUAServer({
    host: opcua.host,
    serverCertificateManager,
    userCertificateManager,
    hostname: opcua.hostname,
    port: opcua.port,
    resourcePath: opcua.resourcePath,
    allowAnonymous: true,
    securityModes: [MessageSecurityMode.None],
    securityPolicies: [SecurityPolicy.None],
    maxConnectionsPerEndpoint: opcua.maxConnectionsPerEndpoint,
    serverCapabilities: {
      maxSessions: opcua.maxSessions,
      maxSubscriptions: 100,
      maxMonitoredItems: 5000,
      maxSubscriptionsPerSession: 20,
      maxMonitoredItemsPerSubscription: 1000
    },
    serverInfo: {
      applicationName: "Raspberry Pi Mock PLC",
      applicationUri: "urn:rpi4:opcua:mock-plc:server",
      productUri: "urn:rpi4:opcua:mock-plc:product"
    },
    buildInfo: {
      productName: "rpi4-opcua-mock-plc",
      manufacturerName: "Mock Industrial Lab",
      softwareVersion: "1.0.0"
    }
  });

  let nodeSet;
  let timer = null;
  let started = false;
  let stopped = false;
  let onAlarm = null;
  let onSample = null;
  let updateSnapshot = null;
  const injectedFaults = {
    statuses: new Map(),
    frozen: new Set(),
    sourceTimestampOffsetMs: 0
  };

  function requireVariable(name) {
    const node = nodeSet?.nodes?.[name];
    if (!node) {
      throw new Error(`Unknown Mock PLC variable: ${name}`);
    }
    return node;
  }

  function requireFaultInjectionReady() {
    if (!started || !nodeSet || typeof updateSnapshot !== "function") {
      throw new Error("Mock PLC fault injection requires a started server");
    }
  }

  function injectVariableStatus(name, statusCode) {
    requireFaultInjectionReady();
    requireVariable(name);
    if (statusCode === null || statusCode === undefined) {
      injectedFaults.statuses.delete(name);
    } else {
      injectedFaults.statuses.set(name, statusCode);
    }
    updateSnapshot();
  }

  function freezeVariable(name, frozen = true) {
    requireFaultInjectionReady();
    requireVariable(name);
    if (frozen) {
      injectedFaults.frozen.add(name);
    } else {
      injectedFaults.frozen.delete(name);
      updateSnapshot();
    }
  }

  function setSourceTimestampOffsetMs(offsetMs) {
    requireFaultInjectionReady();
    if (!Number.isFinite(offsetMs)) {
      throw new Error("sourceTimestampOffsetMs must be a finite number");
    }
    injectedFaults.sourceTimestampOffsetMs = offsetMs;
    updateSnapshot();
  }

  function clearInjectedFaults() {
    requireFaultInjectionReady();
    injectedFaults.statuses.clear();
    injectedFaults.frozen.clear();
    injectedFaults.sourceTimestampOffsetMs = 0;
    updateSnapshot();
  }

  async function start() {
    try {
      await server.initialize();
      nodeSet = addNodeSet(server, simulator);

      onAlarm = (event) => {
        console.log(
          `[alarm] seq=${event.sequence} code=${event.code} severity=${event.severity} ${event.message}`
        );
        updateVariable(
          nodeSet.nodes.alarmEvents,
          DataType.String,
          simulator.alarmEventsJson()
        );
        updateVariable(
          nodeSet.nodes.alarmEventCount,
          DataType.UInt32,
          event.sequence
        );
        updateVariable(
          nodeSet.nodes.deviceStatus,
          DataType.String,
          simulator.deviceStatus
        );

        nodeSet.nodes.mockPlc.raiseEvent(nodeSet.alarmEventType, {
          sourceNode: {
            dataType: DataType.NodeId,
            value: nodeSet.nodes.mockPlc.nodeId
          },
          sourceName: {
            dataType: DataType.String,
            value: "MockPLC"
          },
          time: {
            dataType: DataType.DateTime,
            value: new Date(event.time)
          },
          receiveTime: {
            dataType: DataType.DateTime,
            value: new Date()
          },
          message: {
            dataType: DataType.LocalizedText,
            value: { text: event.message }
          },
          severity: {
            dataType: DataType.UInt16,
            value: event.severity
          },
          alarmCode: {
            dataType: DataType.String,
            value: event.code
          },
          alarmCause: {
            dataType: DataType.String,
            value: event.cause
          },
          deviceStatus: {
            dataType: DataType.String,
            value: event.deviceStatus
          },
          temperatureC: {
            dataType: DataType.Double,
            value: event.temperatureC
          },
          currentOutput: {
            dataType: DataType.Double,
            value: event.currentOutput
          },
          goodCount: {
            dataType: DataType.UInt32,
            value: event.goodCount
          },
          totalProducedCount: {
            dataType: DataType.UInt32,
            value: event.totalProducedCount
          },
          alarmSequence: {
            dataType: DataType.UInt32,
            value: event.sequence
          }
        });
      };
      simulator.on("alarm", onAlarm);

      if (options.simulation.logEachTick) {
        onSample = (snapshot) => {
          console.log(
            `[sample] seq=${snapshot.sequence} status=${snapshot.deviceStatus} ` +
              `output=${snapshot.currentOutput} good=${snapshot.goodCount} ` +
              `total=${snapshot.totalProducedCount} ` +
              `temperature=${snapshot.temperatureC}`
          );
        };
        simulator.on("sample", onSample);
      }

      await server.start();
      started = true;

      updateSnapshot = () => {
        const snapshot = simulator.snapshot();
        const now = Date.now();
        const sourceTimestamp = new Date(now + injectedFaults.sourceTimestampOffsetMs);
        const serverTimestamp = new Date(now);
        const update = (name, dataType, value) => {
          if (injectedFaults.frozen.has(name)) {
            return;
          }
          updateVariable(nodeSet.nodes[name], dataType, value, {
            statusCode: injectedFaults.statuses.get(name) ?? StatusCodes.Good,
            sourceTimestamp,
            serverTimestamp
          });
        };

        update("deviceStatus", DataType.String, snapshot.deviceStatus);
        update("currentOutput", DataType.Double, snapshot.currentOutput);
        update("goodCount", DataType.UInt32, snapshot.goodCount);
        update("totalProducedCount", DataType.UInt32, snapshot.totalProducedCount);
        update("temperatureSensor", DataType.Double, snapshot.temperatureC);
      };

      timer = setInterval(() => {
        try {
          simulator.tick(options.simulation.intervalMs);
          updateSnapshot();
        } catch (error) {
          console.error("[simulator] update failed:", error);
        }
      }, options.simulation.intervalMs);

      updateSnapshot();

      return {
        server,
        simulator,
        namespaceIndex: nodeSet.namespaceIndex,
        namespaceUri: nodeSet.namespaceUri,
        nodeIds: NODE_IDS,
        endpointUrl: `opc.tcp://${opcua.hostname}:${opcua.port}${opcua.resourcePath}`
      };
    } catch (error) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (onAlarm) {
        simulator.off("alarm", onAlarm);
        onAlarm = null;
      }
      if (onSample) {
        simulator.off("sample", onSample);
        onSample = null;
      }
      if (started) {
        await server.shutdown(5000).catch(() => undefined);
      }
      throw error;
    }
  }

  async function stop() {
    if (stopped) {
      return;
    }
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (onAlarm) {
      simulator.off("alarm", onAlarm);
      onAlarm = null;
    }
    if (onSample) {
      simulator.off("sample", onSample);
      onSample = null;
    }
    if (started) {
      await server.shutdown(5000);
      started = false;
    }
  }

  return {
    server,
    simulator,
    injectVariableStatus,
    freezeVariable,
    setSourceTimestampOffsetMs,
    clearInjectedFaults,
    start,
    stop
  };
}

module.exports = {
  NODE_IDS,
  createMockPlcServer
};
