# Raspberry Pi OPC UA Mock PLC

A small, deterministic-by-seed OPC UA server that emulates a production PLC for
Gateway, OEE, and RCA end-to-end testing when real industrial equipment is not
available.

It provides:

- `DeviceStatus`: `RUNNING` or `DOWN`
- `CurrentOutput`: production rate in units per minute
- `GoodCount`: monotonic good-unit counter
- `TemperatureSensor`: synthetic temperature in degrees Celsius
- `AlarmEvents`: JSON snapshot of active/latest alarms
- Standard OPC UA event notifications for downtime and temperature alarms
- Smooth normal-process fluctuations
- Random downtime and temperature-spike injection
- OPC UA methods for deterministic fault injection
- Seed control for repeatable test runs

## Requirements

- Node.js 20 or newer
- A free TCP port, normally `4840`
- No industrial equipment or external OPC UA server is required

## Quick Start

```bash
cd /home/xunmengtong/OPC_project/rpi4-opcua-oee-rca-gateway
npm install
npm start
```

Default endpoint:

```text
opc.tcp://localhost:4840/UA/MockPLC
```

The server binds to `0.0.0.0` by default, but advertises
`opc.tcp://localhost:4840/UA/MockPLC` as its endpoint URL. For access from
another machine or container, set `OPCUA_HOSTNAME` to the Raspberry Pi hostname
or IP address:

```bash
OPCUA_HOSTNAME=192.168.1.50 npm start
# Advertised endpoint:
# opc.tcp://192.168.1.50:4840/UA/MockPLC
```

The default security mode is `None` with anonymous access. This is intentional
for isolated E2E tests and is not suitable for an untrusted production network.

## Gateway OPC UA Client

The Gateway client module connects to the running mock server, creates one
long-lived session and one subscription, monitors all five variables, and
monitors native OPC UA events from `ns=1;s=MockPLC`.

With the mock server running in one terminal, start the Gateway client in a
second terminal:

```bash
npm run gateway
```

The client writes structured JSON logs for each variable change, alarm event,
connection-state change, and reconnect attempt. Example variable log:

```json
{
  "timestamp": "2026-11-13T05:00:00.000Z",
  "level": "info",
  "module": "opcua-client",
  "message": "OPC UA variable update",
  "type": "variable",
  "name": "temperatureSensor",
  "nodeId": "ns=1;s=MockPLC.TemperatureSensor",
  "value": 23.14,
  "dataType": "Double",
  "statusCode": "Good (0x00000000)",
  "sourceTimestamp": "2026-11-13T05:00:00.000Z"
}
```

The reusable implementation is
[`src/gateway/opcua-client.js`](src/gateway/opcua-client.js). It can be embedded
in the main Gateway process:

```js
const { OpcUaGatewayClient } = require("./src/gateway/opcua-client");

const client = new OpcUaGatewayClient({
  endpointUrl: "opc.tcp://localhost:4840/UA/MockPLC",
  subscription: {
    publishingIntervalMs: 250,
    samplingIntervalMs: 250
  }
});

client.on("data", (payload) => {
  // payload.name, payload.value, payload.statusCode, timestamps, etc.
  console.log(payload);
});

client.on("alarm", (payload) => {
  // payload.alarmCode, payload.severity, payload.message, etc.
  console.log(payload);
});

client.on("connectionState", ({ state }) => {
  console.log(`OPC UA state: ${state}`);
});

await client.start(); // resolves after session + subscription are ready
await client.stop();  // terminate subscription, close session, disconnect
```

The module handles one shared session/subscription, sequential reconnect with
bounded exponential backoff, duplicate value suppression, structured alarm
normalization, and deterministic cleanup. `getSnapshot()` returns the latest
value payload for every subscribed variable.

### Gateway client configuration

| Variable | Default | Description |
|---|---:|---|
| `OPCUA_ENDPOINT` | `opc.tcp://localhost:4840/UA/MockPLC` | Server endpoint |
| `OPCUA_SECURITY_MODE` | `None` | OPC UA message security mode |
| `OPCUA_SECURITY_POLICY` | `None` | OPC UA security policy |
| `OPCUA_USERNAME` | empty | Username authentication |
| `OPCUA_PASSWORD` | empty | Password, required with username |
| `OPCUA_CLIENT_NAME` | `RCA-Gateway-OPCUA-Client` | Application name |
| `OPCUA_CLIENT_PKI_ROOT` | `<cwd>/.pki` | Client certificate directory |
| `OPCUA_SESSION_TIMEOUT_MS` | `60000` | Requested session timeout |
| `OPCUA_PUBLISHING_INTERVAL_MS` | `250` | Subscription publish interval |
| `OPCUA_SAMPLING_INTERVAL_MS` | `250` | Monitored-item sampling interval |
| `OPCUA_QUEUE_SIZE` | `20` | Per-variable queue depth |
| `OPCUA_EVENT_QUEUE_SIZE` | `200` | Native event queue depth |
| `OPCUA_RECONNECT_MIN_DELAY_MS` | `500` | Initial reconnect delay |
| `OPCUA_RECONNECT_MAX_DELAY_MS` | `30000` | Maximum reconnect delay |
| `OPCUA_LOG_SNAPSHOT` | unset | Set to `1` to print the initial snapshot |

Example against a remote server:

```bash
OPCUA_ENDPOINT=opc.tcp://192.168.1.50:4840/UA/MockPLC OPCUA_PUBLISHING_INTERVAL_MS=200 npm run gateway
```

## OPC UA Address Space

Namespace index `1` is reserved and enforced by the server so NodeIds stay
stable across restarts. The namespace URI is normally:

```text
urn:rpi4:opcua:mock-plc:server
```

| Browse name | NodeId | Data type | Meaning |
|---|---|---|---|
| `MockPLC` | `ns=1;s=MockPLC` | Object | Root object and OPC UA event notifier |
| `DeviceStatus` | `ns=1;s=MockPLC.DeviceStatus` | `String` | `RUNNING` or `DOWN` |
| `CurrentOutput` | `ns=1;s=MockPLC.CurrentOutput` | `Double` | Units per minute |
| `GoodCount` | `ns=1;s=MockPLC.GoodCount` | `UInt32` | Monotonic good units since server start |
| `TemperatureSensor` | `ns=1;s=MockPLC.TemperatureSensor` | `Double` | Temperature in degrees Celsius |
| `AlarmEvents` | `ns=1;s=MockPLC.AlarmEvents` | `String` | JSON alarm snapshot |
| `AlarmEventCount` | `ns=1;s=MockPLC.AlarmEventCount` | `UInt32` | Monotonic alarm sequence number |
| `TriggerDowntime` | `ns=1;s=MockPLC.TriggerDowntime` | Method | Force a downtime interval |
| `TriggerTemperatureSpike` | `ns=1;s=MockPLC.TriggerTemperatureSpike` | Method | Force a temperature spike |
| `ResumeNormal` | `ns=1;s=MockPLC.ResumeNormal` | Method | Clear forced downtime/spike |

`CurrentOutput` is smoothed with a first-order low-pass filter, so it moves
gradually instead of jumping on every update. `GoodCount` increments only while
the device is `RUNNING`.

### AlarmEvents JSON

`AlarmEvents` is intended for gateways that only support variable
subscriptions. It changes whenever an alarm is raised or cleared:

```json
{
  "sequence": 2,
  "active": [
    {
      "sequence": 1,
      "eventId": "1760000000000-1",
      "time": "2026-11-13T04:00:00.000Z",
      "code": "DOWNTIME",
      "severity": 700,
      "message": "Device stopped: RANDOM_PRODUCTION_ANOMALY",
      "cause": "RANDOM_PRODUCTION_ANOMALY",
      "deviceStatus": "DOWN",
      "temperatureC": 24.12,
      "currentOutput": 118.43,
      "goodCount": 155
    }
  ],
  "latest": {
    "sequence": 2,
    "code": "DOWNTIME_CLEARED",
    "severity": 200,
    "message": "Device recovered: RECOVERY_TIMER_EXPIRED"
  }
}
```

Alarm codes are:

- `DOWNTIME`
- `DOWNTIME_CLEARED`
- `TEMPERATURE_SPIKE`
- `TEMPERATURE_SPIKE_CLEARED`

### Standard OPC UA Events

The `MockPLC` object has `EventNotifier` enabled. Events use the custom
`MockPLCAlarmEventType`, derived from `BaseEventType`. Select the standard event
fields plus these namespace-1 fields:

- `1:AlarmCode`
- `1:AlarmCause`
- `1:DeviceStatus`
- `1:TemperatureC`
- `1:CurrentOutput`
- `1:GoodCount`
- `1:AlarmSequence`

The standard fields include `EventId`, `EventType`, `SourceNode`, `SourceName`,
`Time`, `ReceiveTime`, `Message`, and `Severity`.

Monitor the `EventNotifier` attribute of `ns=1;s=MockPLC`; do not subscribe to
the `AlarmEvents` variable when testing native OPC UA event handling.

## Simulation Behaviour

Normal production uses two low-frequency sine waves plus bounded random noise.
The resulting output and temperature remain smooth and suitable for threshold
and moving-average tests.

Random anomalies are sampled once per update interval using a per-minute rate.
The default rates produce an occasional fault without making every test flaky:

- Downtime: 0.35 expected starts per minute, 12-39 seconds long
- Temperature spike: 0.40 expected starts per minute, 15-39 seconds long
- During downtime, `DeviceStatus` becomes `DOWN` and output decays toward zero
- During a temperature spike, temperature rises smoothly toward 78-100 C

The same seed and the same sequence of update intervals reproduce the same
trajectory. Wall-clock timestamp fields are intentionally excluded from that
guarantee.

## Configuration

All configuration is supplied through environment variables.

| Variable | Default | Description |
|---|---:|---|
| `OPCUA_HOST` | `0.0.0.0` | Local interface on which the server listens |
| `OPCUA_HOSTNAME` | `localhost` | Hostname/IP advertised in the endpoint URL |
| `OPCUA_PORT` | `4840` | OPC UA TCP port |
| `OPCUA_RESOURCE_PATH` | `/UA/MockPLC` | Endpoint resource path |
| `OPCUA_MAX_SESSIONS` | `32` | Maximum sessions reported/enforced |
| `OPCUA_MAX_CONNECTIONS` | `32` | Connections per endpoint |
| `OPCUA_PKI_ROOT` | `<cwd>/.pki` | Writable certificate directory |
| `SIM_INTERVAL_MS` | `500` | Simulation and value update interval |
| `SIM_SEED` | `8675309` | Random seed |
| `SIM_NOMINAL_OUTPUT` | `120` | Normal production rate, units/minute |
| `SIM_YIELD_RATE` | `0.98` | Fraction of output added to `GoodCount` |
| `SIM_AMBIENT_TEMP_C` | `23.5` | Normal ambient temperature |
| `SIM_DOWNTIME_RATE_PER_MIN` | `0.35` | Random downtime starts per minute |
| `SIM_TEMP_SPIKE_RATE_PER_MIN` | `0.40` | Random spike starts per minute |
| `SIM_LOG_EACH_TICK` | unset | Set to `1` to log every simulated sample |

Examples:

```bash
# Fast, deterministic E2E updates with no random faults.
OPCUA_PORT=4840 \
SIM_SEED=42 \
SIM_INTERVAL_MS=250 \
SIM_DOWNTIME_RATE_PER_MIN=0 \
SIM_TEMP_SPIKE_RATE_PER_MIN=0 \
npm start

# Stress the RCA module with frequent random anomalies.
SIM_DOWNTIME_RATE_PER_MIN=2 \
SIM_TEMP_SPIKE_RATE_PER_MIN=2 \
SIM_INTERVAL_MS=250 \
npm start
```

Setting either anomaly rate to `0` disables that random anomaly. Explicit fault
injection methods still work.

## Deterministic Fault Injection

Use the methods when a test needs to know exactly when an anomaly starts and
ends.

### TriggerDowntime

Input:

1. `DurationSeconds`, `UInt32`

Call method `ns=1;s=MockPLC.TriggerDowntime` on object
`ns=1;s=MockPLC`. For example, with the Node.js client:

```js
await session.call({
  objectId: "ns=1;s=MockPLC",
  methodId: "ns=1;s=MockPLC.TriggerDowntime",
  inputArguments: [{ dataType: DataType.UInt32, value: 15 }]
});
```

Expected Gateway/RCA results:

- `DeviceStatus` changes to `DOWN`
- `CurrentOutput` gradually falls toward zero
- `GoodCount` stops increasing
- A `DOWNTIME` event is emitted
- After the duration, status returns to `RUNNING` and a
  `DOWNTIME_CLEARED` event is emitted

### TriggerTemperatureSpike

Inputs:

1. `DurationSeconds`, `UInt32`
2. `PeakCelsius`, `Double`

Expected result: temperature rises smoothly toward the requested peak and then
recovers; a `TEMPERATURE_SPIKE` event is emitted immediately.

### ResumeNormal

No inputs. Clears an active downtime and temperature spike and emits the
corresponding cleared events.

## Gateway Integration

### Connection settings

Configure the Gateway connection pool with:

```text
Endpoint URL: opc.tcp://<mock-server-host>:4840/UA/MockPLC
Security mode: None (test only)
Security policy: None (test only)
Identity: Anonymous
Namespace index: 1
```

Use one long-lived session per PLC connection. Do not create a session per tag.
Create one subscription containing the five data nodes and, if supported, one
event monitored item for `ns=1;s=MockPLC` with `AttributeIds.EventNotifier`.

A subscription interval of `250-500 ms` matches the default simulator update
rate. Sampling faster than `SIM_INTERVAL_MS` is unnecessary because server values
only change on the simulation tick.

### Minimal Node.js client

The following pattern is suitable for validating any Gateway connection pool's
subscribe path:

```js
const {
  AttributeIds,
  DataType,
  OPCUAClient,
  TimestampsToReturn
} = require("node-opcua");

const endpointUrl = "opc.tcp://localhost:4840/UA/MockPLC";
const client = OPCUAClient.create({ endpointMustExist: false });
await client.connect(endpointUrl);
const session = await client.createSession();

const subscription = await session.createSubscription2({
  requestedPublishingInterval: 250,
  requestedLifetimeCount: 300,
  requestedMaxKeepAliveCount: 10,
  maxNotificationsPerPublish: 100,
  publishingEnabled: true
});

const nodes = [
  "ns=1;s=MockPLC.DeviceStatus",
  "ns=1;s=MockPLC.CurrentOutput",
  "ns=1;s=MockPLC.GoodCount",
  "ns=1;s=MockPLC.TemperatureSensor",
  "ns=1;s=MockPLC.AlarmEvents"
];

for (const nodeId of nodes) {
  await subscription.monitor(
    { nodeId, attributeId: AttributeIds.Value },
    { samplingInterval: 250, queueSize: 10, discardOldest: true },
    TimestampsToReturn.Both
  );
}

// Exercise a deterministic fault.
await session.call({
  objectId: "ns=1;s=MockPLC",
  methodId: "ns=1;s=MockPLC.TriggerDowntime",
  inputArguments: [{ dataType: DataType.UInt32, value: 10 }]
});

await subscription.terminate();
await session.close();
await client.disconnect();
```

In production Gateway code, use `try/finally` and run the following cleanup in
order so a failed test does not leak server-side sessions or subscriptions:

1. Terminate subscriptions and monitored items
2. Close the session
3. Disconnect the secure channel
4. Remove application event listeners/timers
5. Reconnect with bounded backoff only when the connection pool requests it

### Node-RED integration

1. Add an **OPC UA Client** node.
2. Endpoint: `opc.tcp://localhost:4840/UA/MockPLC`.
3. Security mode/policy: `None` / `None`, anonymous identity.
4. Add OPC UA Item nodes using the NodeIds in the table above.
5. Add a separate OPC UA Event Item node for `ns=1;s=MockPLC` if the RCA flow
   consumes native events; otherwise consume the `AlarmEvents` JSON variable.
6. Keep one OPC UA Client node and one session shared by all tags.

When the Gap/analysis module consumes anomalies, preserve the event `Time` and
`AlarmSequence` fields. These allow the RCA code to distinguish a delayed
notification from a duplicate event.

### Remote Raspberry Pi / Docker networking

If the Gateway runs on another machine:

```bash
OPCUA_HOST=0.0.0.0 \
OPCUA_HOSTNAME=192.168.1.50 \
npm start
```

Then use:

```text
opc.tcp://192.168.1.50:4840/UA/MockPLC
```

Do not use `localhost` from inside a container to reach a server running on the
host. Use the host gateway/address or a Docker service name. Ensure TCP port
`4840` is reachable through the host firewall.

## Automated Tests

Run the simulation unit tests and the Gateway client integration test:

```bash
npm test
```

The integration test starts an isolated mock server, connects through
`OpcUaGatewayClient`, verifies variable data, injects a downtime, verifies the
normalized native alarm event, and then cleans up the session and subscription.

Run a complete server + client smoke test. This command starts its own server on
port `48401`, verifies reads, variable subscriptions, native OPC UA events,
custom event fields, `AlarmEvents`, and method calls, then shuts everything down:

```bash
npm run e2e
```

To test an already-running server:

```bash
OPCUA_PORT=4840 npm run smoke
# or, for a remote endpoint:
OPCUA_ENDPOINT=opc.tcp://192.168.1.50:4840/UA/MockPLC npm run smoke
```

## Recommended E2E Scenario

1. Start the mock server with random faults disabled.
2. Start the Gateway and confirm that all five values update.
3. Record the initial `GoodCount`; verify that it increases over 10 seconds.
4. Call `TriggerDowntime` for 15 seconds.
5. Verify that `DeviceStatus=DOWN`, output trends to zero, and `GoodCount` is
   flat.
6. Verify that the RCA pipeline receives a downtime event and creates the
   expected root-cause record.
7. Wait for recovery and verify that output and `GoodCount` resume.
8. Call `TriggerTemperatureSpike` with `DurationSeconds=15` and
   `PeakCelsius=95`.
9. Verify that the RCA rule triggers on the temperature threshold and clears
   after recovery.
10. Repeat with one fixed `SIM_SEED` to compare RCA output across builds.

## Raspberry Pi systemd Example

Adjust paths and the advertised IP before installing:

```ini
[Unit]
Description=OPC UA Mock PLC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/rpi4-opcua-oee-rca-gateway
Environment=NODE_ENV=production
Environment=OPCUA_HOST=0.0.0.0
Environment=OPCUA_HOSTNAME=192.168.1.50
Environment=OPCUA_PORT=4840
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3
User=opcua-mock

[Install]
WantedBy=multi-user.target
```

The service user needs write access to `OPCUA_PKI_ROOT` or the default `.pki`
directory. Run `npm install --omit=dev` in the deployment directory before
starting the service.

## Troubleshooting

### `EADDRINUSE`

Another process is using the selected port. Either stop it or choose a different
port:

```bash
OPCUA_PORT=4841 npm start
```

Update the Gateway endpoint to match.

### Endpoint hostname does not match

Set `OPCUA_HOSTNAME` to the IP/hostname clients use. `OPCUA_HOST` controls the
listen interface; `OPCUA_HOSTNAME` controls the advertised endpoint.

### Certificate/PKI permission errors

The server uses a local self-signed certificate even for `SecurityPolicy.None`.
Point `OPCUA_PKI_ROOT` to a writable directory:

```bash
OPCUA_PKI_ROOT=/var/lib/opcua-mock/pki npm start
```

### No native events received

- Monitor `AttributeIds.EventNotifier` on `ns=1;s=MockPLC`.
- Select at least `EventId`, `EventType`, `Time`, `Message`, and `Severity`.
- Prefix custom fields with namespace `1`, for example `"1:AlarmCode"`.
- Confirm the client's event filter was accepted; an invalid browse path can
  result in an empty event stream.

### Values do not update

- Match the Gateway subscription interval to `SIM_INTERVAL_MS`.
- Confirm the namespace index is `1`.
- Read the NodeIds directly with `npm run smoke`.
- Remember that `GoodCount` resets when the mock server restarts.

## Important Limitations

This is a test double, not a PLC emulator suitable for safety, certification, or
production control. It intentionally exposes anonymous/no-security endpoints by
default. It does not model OPC UA redundancy, certificate rotation, PLC scan
cycles, fieldbus jitter, packet loss, or device-specific vendor diagnostics. For
industrial deployment, use an OPC UA stack with certificate-based security,
auditable session policy, monitoring, and a tested resource-limit policy.
