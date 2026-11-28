"use strict";

const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  AttributeIds,
  DataChangeFilter,
  DataChangeTrigger,
  DataType,
  DeadbandType,
  OPCUACertificateManager,
  OPCUAClient,
  TimestampsToReturn,
  UserTokenType,
  coerceMessageSecurityMode,
  coerceSecurityPolicy,
  constructEventFilter,
  ofType
} = require("node-opcua");
const { PlcDiagnostics, isGoodStatus } = require("./plc-diagnostics");

const DEFAULT_VARIABLES = Object.freeze([
  { name: "deviceStatus", nodeId: "ns=1;s=MockPLC.DeviceStatus" },
  { name: "currentOutput", nodeId: "ns=1;s=MockPLC.CurrentOutput" },
  { name: "goodCount", nodeId: "ns=1;s=MockPLC.GoodCount" },
  { name: "totalProducedCount", nodeId: "ns=1;s=MockPLC.TotalProducedCount" },
  { name: "temperatureSensor", nodeId: "ns=1;s=MockPLC.TemperatureSensor" },
  { name: "alarmEvents", nodeId: "ns=1;s=MockPLC.AlarmEvents" }
]);

const DEFAULT_EVENT_NODE_ID = "ns=1;s=MockPLC";
const EVENT_FIELDS = Object.freeze([
  "EventId",
  "EventType",
  "SourceNode",
  "SourceName",
  "Time",
  "Message",
  "Severity",
  "1:AlarmCode",
  "1:AlarmCause",
  "1:DeviceStatus",
  "1:TemperatureC",
  "1:CurrentOutput",
  "1:GoodCount",
  "1:TotalProducedCount",
  "1:AlarmSequence"
]);

const defaultLogger = {
  info(record) {
    console.log(JSON.stringify(record));
  },
  warn(record) {
    console.warn(JSON.stringify(record));
  },
  error(record) {
    console.error(JSON.stringify(record));
  }
};

function monitorItem(subscription, itemToMonitor, parameters) {
  return new Promise((resolve, reject) => {
    subscription.monitor(
      itemToMonitor,
      parameters,
      TimestampsToReturn.Both,
      (error, monitoredItem) => (error ? reject(error) : resolve(monitoredItem))
    );
  });
}

function dataChangeFilter(triggerName) {
  const trigger = DataChangeTrigger[triggerName];
  if (trigger === undefined) {
    throw new Error(`Unsupported OPC UA data-change trigger: ${triggerName}`);
  }
  return new DataChangeFilter({
    trigger,
    deadbandType: DeadbandType.None,
    deadbandValue: 0
  });
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === "object") {
    if (typeof value.toString === "function" && value.constructor?.name === "NodeId") {
      return value.toString();
    }
    if (Object.prototype.hasOwnProperty.call(value, "text")) {
      return value.text;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = normalizeValue(item);
    }
    return result;
  }
  return value;
}

function normalizeVariant(variant) {
  if (variant && typeof variant === "object" && "value" in variant) {
    return normalizeValue(variant.value);
  }
  return normalizeValue(variant);
}

function dataTypeName(variant) {
  if (!variant || typeof variant.dataType !== "number") {
    return undefined;
  }
  return DataType[variant.dataType] || String(variant.dataType);
}

function isoOrNull(value) {
  return value instanceof Date ? value.toISOString() : null;
}

function parseJsonIfPossible(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

class OpcUaGatewayClient extends EventEmitter {
  constructor(options) {
    super();
    if (!options?.endpointUrl) {
      throw new Error("OpcUaGatewayClient requires an endpointUrl");
    }

    this.options = {
      applicationName: "RCA-Gateway-OPCUA-Client",
      applicationUri: "urn:rpi4:gateway:opcua-client",
      pkiRoot: path.resolve(process.cwd(), ".pki"),
      securityMode: "None",
      securityPolicy: "None",
      trustUnknownCertificates: false,
      clientCertificateFile: null,
      clientPrivateKeyFile: null,
      username: "",
      password: "",
      requestedSessionTimeout: 60000,
      connection: {
        initialDelayMs: 500,
        maxDelayMs: 30000,
        randomisationFactor: 0.2
      },
      subscription: {
        dataChangeTrigger: "StatusValueTimestamp",
        publishingIntervalMs: 250,
        samplingIntervalMs: 250,
        queueSize: 20,
        eventQueueSize: 200
      },
      variables: DEFAULT_VARIABLES,
      eventNodeId: DEFAULT_EVENT_NODE_ID,
      ...options
    };
    this.options.connection = {
      initialDelayMs: 500,
      maxDelayMs: 30000,
      randomisationFactor: 0.2,
      ...(options.connection || {})
    };
    this.options.subscription = {
      dataChangeTrigger: "StatusValueTimestamp",
      publishingIntervalMs: 250,
      samplingIntervalMs: 250,
      queueSize: 20,
      eventQueueSize: 200,
      ...(options.subscription || {})
    };

    this.logger = options.logger || defaultLogger;
    this._diagnostics =
      options.diagnostics ||
      new PlcDiagnostics({
        ...(this.options.plcDiagnostics || {}),
        eventSubscriptionConfigured: Boolean(this.options.eventNodeId)
      });
    this._running = false;
    this._connected = false;
    this._client = null;
    this._session = null;
    this._subscription = null;
    this._certificateManager = null;
    this._monitoredItems = [];
    this._disconnectWaiter = null;
    this._sleepTimer = null;
    this._sleepResolve = null;
    this._retryCount = 0;
    this._lastValues = new Map();
    this._lastEventId = null;
    this._disconnectRequests = new WeakSet();
    this._disconnectSignaled = false;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._readySettled = false;
    this._runPromise = null;
  }

  get isConnected() {
    return this._connected;
  }

  getSnapshot() {
    const snapshot = {};
    for (const [name, entry] of this._lastValues.entries()) {
      if (!entry.payload.statusCode || isGoodStatus(entry.payload.statusCode)) {
        snapshot[name] = entry.payload;
      }
    }
    return snapshot;
  }

  getStatus() {
    return this._diagnostics.getStatus();
  }

  async start() {
    if (this._readyPromise) {
      return this._readyPromise;
    }
    if (this._running) {
      return this;
    }

    this._running = true;
    this._retryCount = 0;
    this._readySettled = false;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this._runPromise = this._runLoop();
    this._runPromise.catch((error) => {
      this._log("error", "OPC UA client loop terminated", {
        error: error.message
      });
      this._rejectReady(error);
    });

    return this._readyPromise;
  }

  async stop() {
    if (!this._running && !this._runPromise) {
      return;
    }

    this._running = false;
    this._signalDisconnect(null, new Error("OPC UA client stopped"));
    this._wakeSleep();

    if (this._client) {
      await this._disconnectClient(this._client);
    }

    if (this._runPromise) {
      await this._runPromise;
    }

    this._rejectReady(new Error("OPC UA client stopped before it became ready"));
    this._readyPromise = null;
    this._runPromise = null;
  }

  async _runLoop() {
    while (this._running) {
      try {
        this._diagnostics.recordConnectionAttempt();
        await this._connectOnce();
        this._retryCount = 0;
        await this._waitForDisconnect();
      } catch (error) {
        if (!this._running) {
          break;
        }
        this._diagnostics.recordConnectionFailure(error);
        this._log("error", "OPC UA connection attempt failed", {
          endpointUrl: this.options.endpointUrl,
          error: error.message,
          retryAttempt: this._retryCount + 1
        });
        this.emit("clientError", error);
      } finally {
        await this._cleanupConnection();
      }

      if (this._running) {
        const delayMs = this._nextRetryDelay();
        this._retryCount += 1;
        this._log("warn", "Reconnecting to OPC UA server", {
          endpointUrl: this.options.endpointUrl,
          delayMs,
          retryAttempt: this._retryCount
        });
        await this._sleep(delayMs);
      }
    }
  }

  async _connectOnce() {
    const certificateManager = new OPCUACertificateManager({
      rootFolder: path.join(this.options.pkiRoot, "gateway-client"),
      automaticallyAcceptUnknownCertificate: this.options.trustUnknownCertificates
    });
    const clientOptions = {
      applicationName: this.options.applicationName,
      applicationUri: this.options.applicationUri,
      clientCertificateManager: certificateManager,
      endpointMustExist: false,
      securityMode: coerceMessageSecurityMode(this.options.securityMode),
      securityPolicy: coerceSecurityPolicy(this.options.securityPolicy),
      requestedSessionTimeout: this.options.requestedSessionTimeout,
      keepSessionAlive: true,
      connectionStrategy: {
        initialDelay: this.options.connection.initialDelayMs,
        maxDelay: this.options.connection.maxDelayMs,
        maxRetry: 0,
        randomisationFactor: this.options.connection.randomisationFactor
      }
    };
    if (this.options.clientCertificateFile) {
      clientOptions.certificateFile = this.options.clientCertificateFile;
      clientOptions.privateKeyFile = this.options.clientPrivateKeyFile;
    }
    const client = OPCUAClient.create(clientOptions);

    this._certificateManager = certificateManager;
    this._client = client;
    this._disconnectSignaled = false;

    const onConnectionLost = (message) => {
      this._signalDisconnect(client, new Error(message || "OPC UA connection lost"));
    };
    const onClose = (error) => {
      this._signalDisconnect(client, error || new Error("OPC UA connection closed"));
    };
    client.on("connection_lost", onConnectionLost);
    client.on("close", onClose);

    this._log("info", "Connecting to OPC UA server", {
      endpointUrl: this.options.endpointUrl,
      securityMode: this.options.securityMode,
      securityPolicy: this.options.securityPolicy,
      trustUnknownCertificates: this.options.trustUnknownCertificates
    });

    await client.connect(this.options.endpointUrl);
    if (!this._running) {
      throw new Error("OPC UA client stopped during connect");
    }

    const userIdentity = this.options.username
      ? {
          type: UserTokenType.UserName,
          userName: this.options.username,
          password: this.options.password
        }
      : { type: UserTokenType.Anonymous };

    const session = await client.createSession(userIdentity);
    this._session = session;
    session.once("session_closed", (statusCode) => {
      this._signalDisconnect(
        client,
        new Error(`OPC UA session closed: ${statusCode?.toString?.() || "Unknown"}`)
      );
    });

    const subscription = await session.createSubscription2({
      requestedPublishingInterval: this.options.subscription.publishingIntervalMs,
      requestedLifetimeCount: 300,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10
    });
    this._subscription = subscription;
    this._diagnostics.recordValueSubscription(true, subscription.subscriptionId);

    for (const definition of this.options.variables) {
      const item = await monitorItem(
        subscription,
        { nodeId: definition.nodeId, attributeId: AttributeIds.Value },
        {
          filter: dataChangeFilter(this.options.subscription.dataChangeTrigger),
          samplingInterval: this.options.subscription.samplingIntervalMs,
          queueSize: this.options.subscription.queueSize,
          discardOldest: true
        }
      );
      this._monitoredItems.push(item);
      item.on("changed", (dataValue) => {
        this._handleVariableData(definition, dataValue);
      });
    }

    if (this.options.eventNodeId) {
      try {
        const eventFilter = constructEventFilter(EVENT_FIELDS, ofType("BaseEventType"));
        const eventItem = await monitorItem(
          subscription,
          { nodeId: this.options.eventNodeId, attributeId: AttributeIds.EventNotifier },
          {
            samplingInterval: 0,
            queueSize: this.options.subscription.eventQueueSize,
            discardOldest: false,
            filter: eventFilter
          }
        );
        this._monitoredItems.push(eventItem);
        this._diagnostics.recordEventSubscription("active");
        eventItem.on("changed", (eventFields) => {
          this._handleOpcUaEvent(eventFields);
        });
      } catch (error) {
        this._diagnostics.recordEventSubscription("unavailable", error);
        this._log("warn", "Unable to subscribe to OPC UA events; continuing with values", {
          eventNodeId: this.options.eventNodeId,
          error: error.message
        });
      }
    } else {
      this._diagnostics.recordEventSubscription("disabled");
    }

    await this._readInitialValues(session);

    this._connected = true;
    this._diagnostics.recordConnected({
      subscriptionId: subscription.subscriptionId,
      valueSubscriptionActive: true
    });
    this._emitState("connected", {
      endpointUrl: this.options.endpointUrl,
      subscriptionId: subscription.subscriptionId
    });
    this._resolveReady(this);
  }

  async _readInitialValues(session) {
    for (const definition of this.options.variables) {
      const dataValue = await session.read({
        nodeId: definition.nodeId,
        attributeId: AttributeIds.Value
      });
      if (dataValue.statusCode.isNotGood()) {
        throw new Error(
          `Cannot read ${definition.nodeId}: ${dataValue.statusCode.toString()}`
        );
      }
      this._handleVariableData(definition, dataValue);
    }
  }

  _handleVariableData(definition, dataValue) {
    const value = normalizeVariant(dataValue.value);
    const statusCode = dataValue.statusCode.toString();
    const sourceTimestamp = isoOrNull(dataValue.sourceTimestamp);
    const serverTimestamp = isoOrNull(dataValue.serverTimestamp);
    const fingerprint = `${statusCode}|${sourceTimestamp}|${JSON.stringify(value)}`;
    const previous = this._lastValues.get(definition.name);
    if (previous?.fingerprint === fingerprint) {
      return;
    }

    const payload = {
      type: "variable",
      name: definition.name,
      nodeId: definition.nodeId,
      value,
      dataType: dataTypeName(dataValue.value),
      statusCode,
      sourceTimestamp,
      serverTimestamp
    };

    if (definition.name === "alarmEvents") {
      const parsed = parseJsonIfPossible(value);
      if (parsed !== undefined) {
        payload.alarmSnapshot = parsed;
      }
    }

    this._diagnostics.observe(payload);
    this._lastValues.set(definition.name, { payload, fingerprint });
    this._log("info", "OPC UA variable update", payload);
    this.emit("data", payload);
  }

  _handleOpcUaEvent(eventFields) {
    const values = {};
    EVENT_FIELDS.forEach((field, index) => {
      values[field] = normalizeVariant(eventFields[index]);
    });

    const eventId = values.EventId || `${values.Time || ""}:${values.SourceNode || ""}:${values.Message || ""}`;
    if (eventId === this._lastEventId) {
      return;
    }
    this._lastEventId = eventId;
    this._diagnostics.recordEventReceived();

    const payload = {
      type: "event",
      eventId,
      eventType: values.EventType,
      sourceNode: values.SourceNode,
      sourceName: values.SourceName,
      time: values.Time,
      message: values.Message,
      severity: values.Severity,
      alarmCode: values["1:AlarmCode"],
      alarmCause: values["1:AlarmCause"],
      deviceStatus: values["1:DeviceStatus"],
      temperatureC: values["1:TemperatureC"],
      currentOutput: values["1:CurrentOutput"],
      goodCount: values["1:GoodCount"],
      totalProducedCount: values["1:TotalProducedCount"],
      alarmSequence: values["1:AlarmSequence"]
    };

    this._log("info", "OPC UA event received", payload);
    this.emit("event", payload);
    if (payload.alarmCode) {
      this.emit("alarm", payload);
    }
  }

  _waitForDisconnect() {
    if (!this._running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._disconnectWaiter = resolve;
    });
  }

  _signalDisconnect(client, error) {
    if (client && client !== this._client) {
      return;
    }
    if (this._disconnectSignaled) {
      return;
    }
    if (!this._connected && !this._client) {
      return;
    }
    this._disconnectSignaled = true;
    this._connected = false;
    this._diagnostics.recordDisconnected(error?.message || "OPC UA connection lost");
    this._emitState("disconnected", {
      endpointUrl: this.options.endpointUrl,
      reason: error?.message || "unknown"
    });
    const resolve = this._disconnectWaiter;
    this._disconnectWaiter = null;
    if (resolve) {
      resolve();
    }
  }

  async _cleanupConnection() {
    const subscription = this._subscription;
    const session = this._session;
    const client = this._client;
    const certificateManager = this._certificateManager;

    this._subscription = null;
    this._session = null;
    this._client = null;
    this._certificateManager = null;
    this._disconnectWaiter = null;
    this._disconnectSignaled = false;
    this._diagnostics.recordValueSubscription(false);

    for (const item of this._monitoredItems) {
      item.removeAllListeners("changed");
    }
    this._monitoredItems = [];
    this._lastValues.clear();
    this._lastEventId = null;

    if (subscription) {
      await this._settle(subscription.terminate(), 3000);
    }
    if (session) {
      await this._settle(session.close(), 3000);
    }
    if (client) {
      await this._disconnectClient(client);
    }
    if (certificateManager) {
      await this._settle(certificateManager.dispose(), 3000);
    }
  }

  async _disconnectClient(client) {
    if (this._disconnectRequests.has(client)) {
      return;
    }
    this._disconnectRequests.add(client);
    try {
      await this._settle(client.disconnect(), 5000);
    } catch {
      // A connection can already be gone when cleanup runs after a network fault.
    }
  }

  async _settle(promise, timeoutMs) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve(promise).catch((error) => {
          throw error;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs} ms`)), timeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      this._log("warn", "OPC UA cleanup operation failed", { error: error.message });
    } finally {
      clearTimeout(timer);
    }
  }

  _nextRetryDelay() {
    const initial = this.options.connection.initialDelayMs;
    const maximum = this.options.connection.maxDelayMs;
    const exponential = Math.min(maximum, initial * 2 ** Math.min(this._retryCount, 10));
    const factor = this.options.connection.randomisationFactor;
    const jitter = 1 + (Math.random() * 2 - 1) * factor;
    return Math.max(50, Math.round(exponential * jitter));
  }

  _sleep(delayMs) {
    if (!this._running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = null;
        this._sleepResolve = null;
        resolve();
      }, delayMs);
    });
  }

  _wakeSleep() {
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer);
      this._sleepTimer = null;
    }
    const resolve = this._sleepResolve;
    this._sleepResolve = null;
    if (resolve) {
      resolve();
    }
  }

  _resolveReady(value) {
    if (this._readySettled) {
      return;
    }
    this._readySettled = true;
    this._readyResolve?.(value);
  }

  _rejectReady(error) {
    if (this._readySettled) {
      return;
    }
    this._readySettled = true;
    this._readyReject?.(error);
  }

  _emitState(state, data) {
    this._log("info", `OPC UA connection state: ${state}`, {
      state,
      ...data
    });
    this.emit("connectionState", { state, ...data });
  }

  _log(level, message, data = {}) {
    const method = this.logger?.[level] || this.logger?.info || console.log;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      module: "opcua-client",
      message,
      ...data
    };
    try {
      method.call(this.logger || console, record);
    } catch (error) {
      console.error("OPC UA client logger failed:", error);
    }
  }
}

module.exports = {
  DEFAULT_EVENT_NODE_ID,
  DEFAULT_VARIABLES,
  EVENT_FIELDS,
  OpcUaGatewayClient,
  dataTypeName,
  isoOrNull,
  normalizeVariant
};
