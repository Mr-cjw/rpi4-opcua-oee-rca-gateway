# HTTP API and Event Contract

Status date: 2026-11-28

This document defines the supported HTTP integration surface for the Raspberry
Pi Gateway. It is the human-readable policy that accompanies the machine
artifacts below. The Gateway remains an analysis and process-context service; it
is not the QA/MES delivery authority.

## 1. Contract Artifacts

| Artifact | Purpose |
| --- | --- |
| [`contracts/http-api.openapi.json`](../contracts/http-api.openapi.json) | OpenAPI 3.1 description of all supported HTTP operations, parameters, request bodies, responses, examples, and authentication. |
| [`contracts/http-api.surface.json`](../contracts/http-api.surface.json) | Frozen machine baseline of operations, parameters, response status codes, schema fields, and required fields. |
| [`contracts/process-context-event.schema.json`](../contracts/process-context-event.schema.json) | Versioned `ProcessContextEvent` event schema. |
| [`contracts/quality-event.schema.json`](../contracts/quality-event.schema.json) | Versioned `QualityEvent` event schema. |
| [`src/gateway/api-contract.js`](../src/gateway/api-contract.js) | Loads and bundles OpenAPI references, validates examples and real responses, extracts the source-route surface, and compares it with the frozen baseline. |
| [`scripts/check-contracts.js`](../scripts/check-contracts.js) | CI entry point for event schemas, OpenAPI examples, source-route equality, and baseline compatibility. |
| [`test/api-contract.test.js`](../test/api-contract.test.js) | Validates documented success and error responses against a live Gateway HTTP server. |

The OpenAPI document is the client-facing description. The surface baseline is a
regression guard, not a permission to remove or rename anything. A baseline
change is a reviewed contract change and must include the corresponding OpenAPI,
examples, tests, documentation, and consumer migration note.

## 2. Supported Operations

The v1 surface contains these operations:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | Public process-health probe. |
| `GET` | `/metrics` | Prometheus text exposition format `0.0.4`. |
| `GET` | `/v1/context/latest` | Latest retained process-context event. |
| `GET` | `/v1/work-context` | Active work-order context. |
| `POST` | `/v1/work-context` | Replace any subset of the active work context. |
| `GET` | `/v1/events` | Filtered process-context event list. |
| `GET` | `/v1/alarms` | Filtered alarm-history list. |
| `GET` | `/v1/oee` | OEE, loss decomposition, data quality, and calculation basis. |
| `POST` | `/v1/quality-events` | Durable, idempotent NG quality-event ingestion. |
| `GET` | `/v1/quality-events` | Filtered quality-event list. |
| `GET` | `/v1/quality-events/{qualityEventId}` | One retained quality event. |
| `POST` | `/v1/rca` | Explainable RCA candidates for a time target or quality event. |
| `POST` | `/v1/correlation` | Deprecated compatibility shortcut for updating only the correlation ID. |

`GET /healthz` is exempt from bearer authentication. When
`GATEWAY_API_TOKEN` is configured, every other operation requires
`Authorization: Bearer <token>`. A missing or invalid token returns `401` with
`WWW-Authenticate: Bearer`.

## 3. Versioning and Compatibility

The major HTTP version is encoded in the URL path, currently `/v1`. The OpenAPI
`info.version` identifies the published contract revision.

There is currently no `Accept`-based version negotiation and no runtime
`Deprecation`, `Sunset`, or version-negotiation response header. Clients must not
infer a version from an unlisted header. A future incompatible HTTP surface will
use a new major path such as `/v2`.

Within v1:

- Additive response fields must be optional. Consumers must ignore unknown
  object properties and must not require an undocumented field to be absent.
- Existing endpoints, query parameters, response status codes, declared schema
  fields, and required fields cannot be removed or renamed.
- A required response field cannot become optional without a new major path.
- A property type, meaning, default, unit, or status-code meaning cannot change
  incompatibly in place.
- A new endpoint or optional query parameter may be added when it does not alter
  the meaning of existing calls.
- Request schemas list the supported input fields. Clients must not depend on the
  server accepting unknown body or query properties; the current server may
  ignore some unknown properties rather than enforcing JSON Schema at runtime.

Event payloads carry their own `schemaVersion`. `ProcessContextEvent`,
`QualityEvent`, `QualityEventInput`, `WorkContextUpdate`, and other schemas with
`additionalProperties: false` are closed for that version. Adding, removing, or
renaming an event property is therefore a contract decision, not an incidental
code change; a breaking event change requires a new event schema version and
consumer migration.

### Deprecation

`POST /v1/correlation` is deprecated. It remains implemented for v1
compatibility; new clients should use `POST /v1/work-context` with a
`correlationId` property.

When another operation is deprecated:

1. Mark it `deprecated: true` in OpenAPI and document the replacement.
2. Keep the old operation available for the agreed v1 support period.
3. Add tests for both the deprecated and replacement paths.
4. Remove it only in a new major API version or after an explicit,
   site-approved consumer migration. The baseline guard must then be changed in
   the same reviewed release.

## 4. Error and Retry Semantics

JSON errors use this shape:

```json
{
  "error": "human-readable diagnostic"
}
```

The `error` string is diagnostic text, not a stable machine-readable code. Do
not branch on its exact wording. Use the HTTP status and operation semantics.

| Status | Meaning for the caller |
| --- | --- |
| `400` | Malformed JSON, invalid field value/type, invalid integer query parameter, or invalid URL encoding. Correct the request before retrying. |
| `401` | Bearer token is missing or invalid. Do not retry until credentials are corrected. |
| `404` | The requested context, quality event, or referenced RCA target does not exist. Do not retry unchanged unless the resource is expected to appear later. |
| `413` | Request body exceeds 1 MiB. Reduce or split the request. |
| `500` | Unexpected server failure. Retry only with an idempotent operation and after checking `/healthz`; preserve the original idempotency key. |
| `503` | A durable write was not accepted because storage was unavailable or a write/sync failed. Resolve the storage condition, then retry. |

The Gateway uses a 15-second HTTP request timeout, a 10-second headers timeout,
and a 1 MiB body limit.

### Quality-event idempotency

`sourceEventId` is the authoritative idempotency key for
`POST /v1/quality-events`.

- First durable acceptance: `201`, `duplicate: false`.
- Retry of a known key: `200`, `duplicate: true`, with the retained event. If the
  original event has left the in-memory retention window, `retained` is
  `false` and the response contains the compact archived record.
- Storage failure: `503`. The event is not accepted. Fix storage and retry with
  the same `sourceEventId`; do not generate a new key merely because of `503`.

QA/MES clients should treat both `200` and `201` duplicate-aware responses as
accepted and should retry transport failures, timeouts, and `503` with the same
`sourceEventId` using bounded exponential backoff. A duplicate request that
arrives while the original write is still in flight waits for that write instead
of being acknowledged early.

### Work-context and correlation writes

`POST /v1/work-context` and deprecated `POST /v1/correlation` are value-replacing
upserts, not queued commands. If durable work-context persistence fails, the
Gateway restores the previous in-memory context and returns `503`. Repeating the
same request after storage recovery is safe because it sets the requested value
again. There is no separate request ID for these endpoints.

## 5. Validation in CI

Run the local checks with:

```bash
npm run check:contracts
npm run check:docs
npm test
```

`check:contracts` performs four gates:

1. Generates and validates real process-context and NG event examples against the
   shared event schemas.
2. Validates every request and response example embedded in OpenAPI.
3. Requires the HTTP routing source and OpenAPI operation list to match exactly.
4. Compares the current operation, parameter, response-status, field, and
   required-field surface with `contracts/http-api.surface.json` and fails on any
   removal.

`test/api-contract.test.js` also starts a real HTTP listener and validates
documented success and failure responses, including `201`, duplicate `200`,
authentication failure, payload limits, not-found responses, and `503` retry
behavior.

The baseline can be printed for review without changing files:

```bash
npm run --silent check:contracts -- --print-surface > /tmp/http-api.surface.json
```

Compare the output with the committed baseline. Do not regenerate or replace the
baseline automatically in CI. A diff must be reviewed as an explicit contract
change.

## 6. Change Checklist

Before merging an HTTP or event contract change:

- Update the OpenAPI document and request/response examples.
- Update the shared event schema when event payloads change.
- Run the real response-validation tests.
- Review any `http-api.surface.json` diff as a breaking-change decision.
- Document additive, deprecated, or removed behavior and the consumer action.
- Confirm that existing E2E clients still pass unchanged unless a major version
  is being introduced.
- Keep `503` retry and `sourceEventId` idempotency semantics intact.

## 7. Open Limitations

- JSON Schema is used by CI and client tooling; the HTTP server does not execute
  the OpenAPI request schema on every request.
- There is no per-user authorization, API-key directory, token expiry, or online
  revocation beyond the single bearer-token deployment model.
- There is no machine-readable error-code catalog beyond the HTTP status and
  stable operation semantics.
- There is no runtime version-negotiation header or automatic deprecation
  signaling.
- Downstream QA/MES retry behavior and long-duration idempotency must still be
  exercised during the controlled field pilot.
