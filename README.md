# Raspberry Pi OPC UA Mock PLC

A small, deterministic-by-seed OPC UA server that emulates a production PLC for
Gateway, OEE, and RCA end-to-end testing when real industrial equipment is not
available.

It provides:

- `DeviceStatus`: `RUNNING` or `DOWN`
- `CurrentOutput`: production rate in units per minute
- `GoodCount`: monotonic good-unit counter
- `TotalProducedCount`: monotonic counter for all produced units
- `TemperatureSensor`: synthetic temperature in degrees Celsius
- `AlarmEvents`: JSON snapshot of active/latest alarms
- Standard OPC UA event notifications for downtime and temperature alarms
- Smooth normal-process fluctuations
- Random downtime and temperature-spike injection
- OPC UA methods for deterministic fault injection
- Seed control for repeatable test runs
- A Gateway runtime that records `PROCESS_CONTEXT` events to JSONL
- Loopback HTTP endpoints for process context, OEE decomposition, and RCA candidates
- Optional bearer-protected Prometheus metrics
- Runtime-updatable work-order, serial-number, and correlation context
- Durable quality-event idempotency independent of log rotation
- Configurable read-only PLC NodeIds with optional native-event/alarm sources
- Time-zone-aware shift windows for planned production time
- Classified stoppage and OEE loss breakdown

The phased plan from the current prototype to a field pilot is documented in
[`docs/ROADMAP.md`](docs/ROADMAP.md). The immediate priority is OEE correctness:
shift/planned time, downtime classification, counter continuity, and quality
reconciliation.

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

## Gateway Runtime: Process Context, OEE and RCA

`npm run gateway` now starts the full Gateway runtime, not only the OPC UA
client. With the mock server already running, use two terminals:

```bash
# Terminal 1: PLC, real or mock
npm start

# Terminal 2: Gateway runtime
GATEWAY_LINE_ID=JX-LINE-01 \
GATEWAY_STATION_ID=JX-LINQIN-STATION-01 \
PROCESS_CONTEXT_LOG=data/process-context.jsonl \
npm run gateway
```

The runtime performs four jobs:

1. Connects to one OPC UA endpoint and keeps one subscription alive.
2. Samples the latest PLC values into a versioned `ProcessContextEvent` and
   appends it to JSONL.
3. Exposes a loopback HTTP API for the latest context, retained events, OEE,
   and RCA candidates.
4. Keeps alarm history separately so alarms raised between sampling ticks are
   still available to RCA.

The event contract is
[`contracts/process-context-event.schema.json`](contracts/process-context-event.schema.json).
Analysis only reads context events; it never changes QA or MES delivery state.

### HTTP API

The default bind address is `127.0.0.1:8080`. Set `GATEWAY_API_TOKEN` to require
`Authorization: Bearer <token>` on every endpoint except `/healthz`.

```bash
curl http://127.0.0.1:8080/healthz
curl -H 'Authorization: Bearer <token>' http://127.0.0.1:8080/metrics
curl http://127.0.0.1:8080/v1/context/latest
curl http://127.0.0.1:8080/v1/work-context
curl -X POST http://127.0.0.1:8080/v1/work-context \
  -H 'content-type: application/json' \
  -d '{"workOrderId":"WO-JX-001","serialNumber":"SN-JX-001","correlationId":"corr-jx-001"}'
curl 'http://127.0.0.1:8080/v1/events?workOrderId=WO-JX-001&limit=20'
curl 'http://127.0.0.1:8080/v1/oee?windowMs=300000&workOrderId=WO-JX-001'
curl -X POST http://127.0.0.1:8080/v1/quality-events \
  -H 'content-type: application/json' \
  -d '{"sourceEventId":"QC-JX-001","result":"NG","occurredAt":"2026-11-27T06:00:00.000Z","workOrderId":"WO-JX-001","correlationId":"corr-jx-001","quantity":1}'
curl 'http://127.0.0.1:8080/v1/alarms?workOrderId=WO-JX-001&limit=20'
curl 'http://127.0.0.1:8080/v1/quality-events?limit=20'
curl -X POST http://127.0.0.1:8080/v1/rca \
  -H 'content-type: application/json' \
  -d '{"qualityEventId":"qevt-...","windowMs":300000,"workOrderId":"WO-JX-001"}'
```

`GET /metrics` exposes Prometheus text metrics for process uptime, OPC UA
connectivity, retained context/alarm/quality counts, latest context timestamp,
and the current line/work context. It uses the same `GATEWAY_API_TOKEN` check as
the `/v1/*` endpoints; only `/healthz` is unauthenticated.

`/v1/events`, `/v1/alarms`, `/v1/quality-events`, and `/v1/oee` accept optional
`workOrderId` and `correlationId` query parameters. `/v1/rca` accepts the same
fields in its JSON body. Filters are applied before limit/OEE aggregation, so a
5-minute OEE window does not mix two work orders when one is selected. Scoped
OEE responses echo the active filter in `scope`; an explicit `ngCount` still
overrides the quality-event input. Alarm-history entries retain the work
context active when the alarm was recorded.

### Runtime work context

`GET /v1/work-context` returns the current work order, serial number, and
correlation ID. `POST /v1/work-context` updates any subset of those fields:

- omitted fields keep their current values;
- `null`, `undefined`, or an empty string clears a field;
- any other non-string value returns `400`.

New `PROCESS_CONTEXT` samples use the updated values on the next capture.
Quality events that omit work-order, serial-number, or correlation fields also
inherit the current runtime values; explicit quality-event values take
precedence for that event. `POST /v1/correlation` remains available as a
compatibility shortcut for updating only the correlation ID. Runtime updates
are atomically persisted with `GATEWAY_WORK_CONTEXT_FILE` and restored when the
Gateway restarts; set the path to `off` to keep the context in memory only.

### NG quality-event ingestion

`POST /v1/quality-events` accepts the quality-side event that matters for OEE
and RCA. It is deliberately analysis input only; it does not send anything to
MES or change delivery state.

The endpoint:

- accepts NG events only;
- requires `sourceEventId` and uses it for idempotency;
- fills `lineId`/`stationId` from Gateway configuration and rejects mismatches;
- accepts `quantity`, work order, serial, correlation ID, defect type,
  confidence, image ID, and free-form metadata;
- returns `201` for the first write and `200` with `duplicate: true` for a
  replay. Duplicate responses include `retained`; when the original event has
  already left the in-memory window, `event` contains the compact archived
  record and `retained` is `false`.

Idempotency keys are stored in a separate atomically replaced ledger, not just
in the event-retention window. By default the ledger retains 100,000 source
event IDs for seven days, so a retry remains a duplicate across event-log
rotation and Gateway restarts. The ledger is bounded by
`QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS` and
`QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES`; set
`QUALITY_EVENT_IDEMPOTENCY_FILE=off` to disable durable deduplication.

When `/v1/oee` is called without an explicit `ngCount`, the Gateway sums the NG
quantity recorded in the same time window. `/v1/rca` accepts
`{"qualityEventId":"qevt-..."}` and uses that event's `occurredAt` and
`correlationId` as the analysis target.

The event contract is
[`contracts/quality-event.schema.json`](contracts/quality-event.schema.json).
Quality events are appended to JSONL and replayed on startup, so OEE/RCA keep
their recent NG feed across a Gateway restart. The replay window is bounded by
the retention settings below.

### OEE inputs and limits

The API intentionally exposes every input instead of only showing a single
headline number:

- Availability = `RUNNING` intervals / available planned intervals after planned downtime and changeover;
- Performance = production-count delta / theoretical units at nominal output;
- Quality = good-count delta / production-count delta;
- OEE = Availability x Performance x Quality.

Planned time is the intersection of the sampled window and the configured
`OEE_SHIFT_WINDOWS` in `OEE_TIMEZONE`. The default is
`00:00-24:00` every day, which preserves the previous observed-window behavior.
Shift windows use `[DAYS:]HH:MM-HH:MM`, separated by semicolons. Examples:

```text
00:00-24:00
MON-FRI:08:00-20:00;SAT:08:00-12:00
FRI:20:00-08:00
```

A day prefix names the day on which the window starts, so an overnight window
continues into the next local day. OEE responses expose `plannedSeconds`,
`plannedStopSeconds`, and `outsidePlanRunningSeconds`; `downtimeSeconds` is now
the non-running portion of planned time. Running outside plan is excluded from
Availability and produces a warning, while counters still reflect the observed
sample window.

Stoppage classification uses the active alarm codes on each process-context
sample:

- outside the shift schedule: `plannedStopSeconds`;
- inside planned time with a code from `OEE_PLANNED_DOWNTIME_ALARM_CODES`:
  `plannedDowntimeSeconds`;
- inside planned time with a code from `OEE_CHANGEOVER_ALARM_CODES`:
  `changeoverSeconds`;
- inside planned time with `DeviceStatus=DOWN` and no configured planned code:
  `unplannedStopSeconds`;
- inside planned time with any other non-running status: `unknownStopSeconds`.

Changeover matching takes precedence over planned downtime, and both are
excluded from the Availability denominator. `downtimeSources` states where each
classification came from. `lossBreakdown` combines those time losses with
`speedLossUnits` and `qualityLossUnits`; the latter uses counter scrap when the
total counter is valid and `ngCount` in proxy mode.

When every sample in the window has a valid `totalProducedCount`,
`counterMode` is `total-produced`: Performance uses the
`totalProducedCount` delta and Quality uses `goodCount` delta divided by that
same total delta. Responses also include `totalDelta` and
`counterScrapDelta` (`totalDelta - goodDelta`) for reconciliation, while
`ngCount`, `qualitySource`, `qualityEventCount`, and `qualityEventQuantity`
remain available for comparison with the quality feed.

Legacy or mixed samples without a valid total counter keep the previous
`good-count-proxy` behavior:

- Performance = `goodCount` delta / theoretical good units at nominal output;
- Quality = `goodCount` delta / (`goodCount` delta + recorded NG quantity).

Explicit downtime classification, changeover handling, product-mix ideal cycle
time, and speed-loss attribution still need to be added before using this as a
formal production OEE figure. If `ngCount` is omitted, the API uses recorded
quality events; if none exist in the window it returns a warning because the
quality feed may not be connected. If a total counter rolls back, falls below
`goodCount`, or is missing from only part of the window, the API falls back to
`good-count-proxy` and returns an explicit warning.

### RCA boundary

RCA first performs explainable time-window correlation. It looks for downtime
and temperature anomalies around the requested `targetAt` and returns candidate
root causes with raw evidence and a confidence label. Every candidate has
`causalClaim: false`; time overlap is not presented as proof of causation.

When the target is a quality event with `workOrderId` or `correlationId`, RCA
uses that context to exclude unrelated samples and alarms. If no context or
alarm matches and no filter was explicitly supplied, it falls back to the
unscoped time window and adds a warning; explicit RCA filters fail closed with
an `INCONCLUSIVE` result. Responses expose `scope` and `scopeApplied` so callers
can see which mode was used.

Example response shape:

```json
{
  "conclusion": "TEMPERATURE_SPIKE",
  "candidates": [
    {
      "code": "TEMPERATURE_SPIKE",
      "score": 0.91,
      "confidence": "medium-high",
      "confidenceLabel": "time overlap, not causal proof",
      "causalClaim": false,
      "evidence": []
    }
  ],
  "disclaimer": "Candidates are derived from time-window overlap. They are not evidence of causation and require human confirmation."
}
```

### Real PLC node mapping

The Gateway does not require the Mock PLC address space. Map the four required
read-only points with full OPC UA NodeIds; also map the optional total counter
when the PLC exposes one:

```bash
OPCUA_ENDPOINT=opc.tcp://192.168.1.50:4840 \
OPCUA_DEVICE_STATUS_NODE='ns=2;s=Line1.RunState' \
OPCUA_CURRENT_OUTPUT_NODE='ns=2;s=Line1.Output' \
OPCUA_GOOD_COUNT_NODE='ns=2;s=Line1.GoodCount' \
OPCUA_TOTAL_PRODUCED_NODE='ns=2;s=Line1.TotalProduced' \
OPCUA_TEMPERATURE_NODE='ns=2;s=Line1.Temperature' \
OPCUA_ALARM_EVENTS_NODE=off \
OPCUA_EVENT_NODE=off \
npm run gateway
```

`OPCUA_TOTAL_PRODUCED_NODE`, `OPCUA_ALARM_EVENTS_NODE`, and `OPCUA_EVENT_NODE`
are optional and can be set to `off` when a real PLC has no equivalent point.
With the total counter disabled, OEE remains on the `good-count-proxy`
behavior. If native event subscription fails, the client logs a warning and
keeps the value subscription alive. In that mode RCA still uses sampled
downtime and temperature thresholds, but it will not have native PLC alarm
messages.

The required values must be convertible to a status string and to numbers, and
`DeviceStatus` should remain `RUNNING`/`DOWN` (or be mapped upstream). The
Gateway only reads points; it does not write PLC controls.

### Gateway runtime configuration

| Variable | Default | Description |
|---|---:|---|
| `GATEWAY_LINE_ID` | `LINE-01` | Line identifier written into context events |
| `GATEWAY_STATION_ID` | `STATION-01` | Station identifier written into context events |
| `GATEWAY_WORK_ORDER_ID` | empty | Initial current work order; runtime-updatable |
| `GATEWAY_SERIAL_NUMBER` | empty | Initial current serial number; runtime-updatable |
| `GATEWAY_CORRELATION_ID` | empty | Initial correlation ID; runtime-updatable |
| `GATEWAY_WORK_CONTEXT_FILE` | `data/work-context.json` | Atomic runtime work-context state; `off` disables persistence |
| `OPCUA_DEVICE_STATUS_NODE` | `ns=1;s=MockPLC.DeviceStatus` | Device status NodeId |
| `OPCUA_CURRENT_OUTPUT_NODE` | `ns=1;s=MockPLC.CurrentOutput` | Current output NodeId |
| `OPCUA_GOOD_COUNT_NODE` | `ns=1;s=MockPLC.GoodCount` | Good count NodeId |
| `OPCUA_TOTAL_PRODUCED_NODE` | `ns=1;s=MockPLC.TotalProducedCount` | Optional total-produced NodeId; `off` enables proxy mode |
| `OPCUA_TEMPERATURE_NODE` | `ns=1;s=MockPLC.TemperatureSensor` | Temperature NodeId |
| `OPCUA_ALARM_EVENTS_NODE` | `ns=1;s=MockPLC.AlarmEvents` | Optional alarm JSON NodeId; `off` disables |
| `OPCUA_EVENT_NODE` | `ns=1;s=MockPLC` | Optional native event NodeId; `off` disables |
| `PROCESS_CONTEXT_SAMPLE_INTERVAL_MS` | `1000` | Context sampling interval |
| `PROCESS_CONTEXT_RETENTION_MS` | `3600000` | In-memory retention window |
| `PROCESS_CONTEXT_MAX_EVENTS` | `10000` | Maximum retained events/alarms |
| `PROCESS_CONTEXT_LOG` | `data/process-context.jsonl` | JSONL path; use `off` to disable or `stdout` to stream |
| `PROCESS_CONTEXT_LOG_MAX_BYTES` | `10485760` | Rotate the active context log after this many bytes |
| `PROCESS_CONTEXT_LOG_MAX_FILES` | `3` | Number of rotated context-log backups to retain |
| `OEE_NOMINAL_OUTPUT_PER_MIN` | `120` | Theoretical output for Performance |
| `OEE_TIMEZONE` | system time zone | IANA time zone for shift and planned-time calculations |
| `OEE_SHIFT_WINDOWS` | `00:00-24:00` | Daily shift windows; `[DAYS:]HH:MM-HH:MM` separated by semicolons |
| `OEE_PLANNED_DOWNTIME_ALARM_CODES` | empty | Comma-separated active alarm codes classified as planned downtime |
| `OEE_CHANGEOVER_ALARM_CODES` | empty | Comma-separated active alarm codes classified as changeover |
| `OEE_WINDOW_MS` | `300000` | Default OEE query window |
| `RCA_WINDOW_MS` | `300000` | Default RCA +/- window |
| `RCA_TEMPERATURE_THRESHOLD_C` | `70` | Temperature anomaly threshold |
| `QUALITY_EVENT_RETENTION_MS` | `3600000` | In-memory NG event retention |
| `QUALITY_EVENT_MAX_EVENTS` | `10000` | Maximum retained NG events |
| `QUALITY_EVENT_LOG` | `data/quality-events.jsonl` | NG JSONL path; use `off` to disable or `stdout` to stream |
| `QUALITY_EVENT_LOG_MAX_BYTES` | `10485760` | Rotate the active quality log after this many bytes |
| `QUALITY_EVENT_LOG_MAX_FILES` | `3` | Number of rotated quality-log backups to retain |
| `QUALITY_EVENT_IDEMPOTENCY_FILE` | `data/quality-idempotency.json` | Atomic source-event ID ledger; use `off` to disable |
| `QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS` | `604800000` | Deduplication horizon; must be at least `QUALITY_EVENT_RETENTION_MS` |
| `QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES` | `100000` | Maximum retained source-event IDs; must be at least `QUALITY_EVENT_MAX_EVENTS` |
| `GATEWAY_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `GATEWAY_HTTP_PORT` | `8080` | HTTP port; `0` selects a free port |
| `GATEWAY_API_TOKEN` | empty | Optional bearer token |

Both process-context and quality-event JSONL logs are replayed at startup,
including retained rotated segments. Logs rotate by size with three backups by
default, so disk use is bounded by `(MAX_FILES + 1) x MAX_BYTES` for each
stream. This is a bounded operational log, not a long-term historian; move to
SQLite or a time-series store before a real pilot. The small runtime
work-context state file is replaced atomically on every update and is safe to
back up independently. The quality-idempotency ledger is also replaced
atomically and should be backed up with the quality JSONL when duplicate
suppression matters across recovery.

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
| `TotalProducedCount` | `ns=1;s=MockPLC.TotalProducedCount` | `UInt32` | Monotonic all units since server start |
| `TemperatureSensor` | `ns=1;s=MockPLC.TemperatureSensor` | `Double` | Temperature in degrees Celsius |
| `AlarmEvents` | `ns=1;s=MockPLC.AlarmEvents` | `String` | JSON alarm snapshot |
| `AlarmEventCount` | `ns=1;s=MockPLC.AlarmEventCount` | `UInt32` | Monotonic alarm sequence number |
| `TriggerDowntime` | `ns=1;s=MockPLC.TriggerDowntime` | Method | Force a downtime interval |
| `TriggerTemperatureSpike` | `ns=1;s=MockPLC.TriggerTemperatureSpike` | Method | Force a temperature spike |
| `ResumeNormal` | `ns=1;s=MockPLC.ResumeNormal` | Method | Clear forced downtime/spike |

`CurrentOutput` is smoothed with a first-order low-pass filter, so it moves
gradually instead of jumping on every update. `TotalProducedCount` accumulates
all completed output while `GoodCount` accumulates output multiplied by
`SIM_YIELD_RATE`; both stop while the device is not `RUNNING`, and
`GoodCount` never exceeds `TotalProducedCount`.

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
      "goodCount": 155,
      "totalProducedCount": 160
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
- `1:TotalProducedCount`
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
| `SIM_YIELD_RATE` | `0.98` | Fraction of completed output added to `GoodCount`; total output goes to `TotalProducedCount` |
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
  "ns=1;s=MockPLC.TotalProducedCount",
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

Run the simulation, OEE/RCA, process-context, HTTP API, and Gateway client
integration tests:

```bash
npm test
```

The suite covers deterministic simulation, OEE input decomposition, downtime
impact, RCA candidate/evidence behavior, the versioned process-context event,
JSONL persistence, NG quality-event ingestion and idempotency, bearer-token
enforcement, restart replay, and an end-to-end runtime API. The OPC UA
integration test starts an isolated mock server, connects through
`OpcUaGatewayClient`, verifies variable data, injects a downtime, verifies the
normalized native alarm event, and then cleans up the session and subscription.

Run a complete server + client smoke test. This command starts its own server on
port `48401`, verifies reads, variable subscriptions, native OPC UA events,
custom event fields, `AlarmEvents`, and method calls, then shuts everything down:

```bash
npm run e2e
```

Run the full Gateway path against a live mock PLC. This starts the PLC, connects
the real OPC UA client, samples process context, injects downtime plus a
temperature spike, posts an NG quality event, and verifies the HTTP OEE/RCA
responses:

```bash
npm run e2e:gateway
```

To test an already-running server:

```bash
OPCUA_PORT=4840 npm run smoke
# or, for a remote endpoint:
OPCUA_ENDPOINT=opc.tcp://192.168.1.50:4840/UA/MockPLC npm run smoke
```

## Recommended E2E Scenario

1. Start the mock server with random faults disabled.
2. Start the Gateway and confirm that all six values update.
3. Record the initial `GoodCount` and `TotalProducedCount`; verify that both
   increase over 10 seconds and that `GoodCount <= TotalProducedCount`.
4. Call `TriggerDowntime` for 15 seconds.
5. Verify that `DeviceStatus=DOWN`, output trends to zero, and both counters
   are flat.
6. Verify that the RCA pipeline receives a downtime event and creates the
   expected root-cause record.
7. Query `/v1/oee` and `/v1/rca`; confirm that every OEE component and RCA
   candidate includes its inputs/evidence rather than only a headline value.
8. Wait for recovery and verify that output, `GoodCount`, and
   `TotalProducedCount` resume.
9. Call `TriggerTemperatureSpike` with `DurationSeconds=15` and
   `PeakCelsius=95`.
10. Verify that the RCA rule triggers on the temperature threshold and clears
   after recovery.
11. Repeat with one fixed `SIM_SEED` to compare RCA output across builds.

## Raspberry Pi systemd Example

For the Gateway runtime, use the hardened unit and environment template under
[`deploy/`](deploy/README.md):

```bash
deploy/rpi4-gateway.service
deploy/rpi4-gateway.env.example
```

That unit runs `src/gateway/index.js`, keeps state under
`/var/lib/rpi4-gateway`, and binds the HTTP API to loopback by default. The
example below is for the standalone Mock PLC service.

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
- Remember that `GoodCount` and `TotalProducedCount` reset when the mock server
  restarts.

## Important Limitations

This is a test double, not a PLC emulator suitable for safety, certification, or
production control. It intentionally exposes anonymous/no-security endpoints by
default. It does not model OPC UA redundancy, certificate rotation, PLC scan
cycles, fieldbus jitter, packet loss, or device-specific vendor diagnostics. For
industrial deployment, use an OPC UA stack with certificate-based security,
auditable session policy, monitoring, and a tested resource-limit policy.
