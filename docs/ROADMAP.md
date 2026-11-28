# Raspberry Pi Gateway Roadmap

Status date: 2026-11-28

## Goal

Turn the current deterministic Mock PLC and Gateway prototype into a
field-deployable Raspberry Pi edge node that can:

- collect process context from a real OPC UA PLC;
- calculate explainable OEE with shift, downtime, counter, and quality semantics;
- survive disconnects, restarts, power loss, and bounded storage;
- provide stable local APIs and observable health for integration;
- support RCA as evidence correlation, without presenting time overlap as proof of causation.

The plan is ordered by dependency. A later phase should not be used to hide a
correctness gap in an earlier phase.

## Guiding Principles

- Correctness before feature count. Every OEE number must expose its inputs,
  counter mode, data-quality warnings, and calculation basis.
- Backward compatibility matters. New event and API fields are additive; old
  JSONL and existing consumers must keep working.
- One Gateway process owns one station/line context. Multi-line deployments use
  multiple isolated instances until a proven need changes that decision.
- Keep the Raspberry Pi deployment small and operable. Prefer local-first,
  bounded, inspectable storage over a distributed stack.
- Every milestone must ship with unit tests, E2E coverage, documentation,
  deployment-config updates, and a rollback note.
- RCA remains explainable. The Gateway reports candidates, evidence, and limits;
  it does not claim automatic causal proof.

## Current Baseline

- Deterministic OPC UA Mock PLC with process, alarm, fault-injection, and total/good counters.
- OPC UA Gateway with reconnecting subscription, configurable NodeIds, and optional native events.
- Durable process-context and quality-event JSONL with bounded rotation and replay.
- Runtime work-order, serial-number, correlation, and product context with atomic persistence.
- Idempotent NG quality-event ingestion with a durable idempotency ledger.
- OEE with availability, performance, quality, total-counter mode, proxy fallback, and per-SKU cycle times.
- Time-window RCA for downtime and temperature anomalies, scoped by work context.
- Local HTTP API, bearer token option, Prometheus metrics, systemd deployment, and E2E tests.
- A read-only OPC UA commissioning doctor for NodeIds, types, status, timestamps, counters, and events.
- Immutable release archives with manifest/checksum verification, atomic
  `current` switching, health-checked upgrade, automatic rollback, and explicit
  rollback/status commands, plus optional detached SHA-256 signatures and
  fail-closed required-signature installs, and an embedded CycloneDX SBOM for
  production dependencies.
- A reviewed nginx TLS reverse-proxy baseline for approved remote access, with
  TLS 1.2/1.3, loopback-only proxying, source restrictions, rate/concurrency
  limits, credential-safe access logs, bounded retention, and certificate
  rotation guidance.
- An edge verifier for deployed certificate chains, TLS versions, redirects,
  security headers, health, authenticated metrics and `/v1` endpoints, unknown
  paths, private CAs, and mTLS client material, with JSON and strict exit modes.
- A field-acceptance report that aggregates release/rollback readiness, systemd,
  health, PLC/clock/storage, OPC UA doctor, and edge evidence with strict gates.
- A staged Pi field drill that verifies a signed release install, host reboot,
  edge-certificate rotation, rollback to the original release, preflight and
  post-reboot hardware readiness, and a checksummed evidence bundle without
  automating reboot or certificate changes.
- A Pi hardware-readiness report for board/architecture profile, temperature,
  under-voltage/throttling history, firmware telemetry, NTP, and storage
  headroom, with strict exit semantics for missing evidence.
- Node.js 22.13+ runtime baseline, patched `node-opcua` dependency, production
  dependency audit in CI, and an expanded systemd sandbox.
- Field-pilot runbook, known-limitations register, and conditional security
  review.

## Milestones

### M1. OEE Correctness and Data Quality

Priority: P0, immediate.

Problem: the observed query window is currently treated as planned production
time, all non-running time is effectively unplanned, and product/changeover
context is absent. Counter continuity and NG-feed reconciliation also need
first-class output fields.

Progress:

- Completed 2026-11-27: configurable time-zone-aware daily/weekly shift windows,
  overnight windows, planned-time clipping, and `plannedSeconds` /
  `plannedStopSeconds` / `outsidePlanRunningSeconds` OEE outputs. The default
  remains 24-hour planned time for backward compatibility.
- Completed 2026-11-27: active-alarm-code classification for planned downtime
  and changeover, device-status classification for unplanned/unknown stops, and
  availability, speed, and quality loss breakdowns.
- Completed 2026-11-27: counter reset/epoch detection with reset-adjusted
  deltas, explicit `counterContinuity` evidence, and replay continuity across
  Gateway restarts.
- Completed 2026-11-27: structured OEE `dataQuality` issues plus counter-vs-NG
  reconciliation status, deltas, and mismatch warnings.
- Completed 2026-11-27: a global validated ideal-cycle-time input with config
  and per-query overrides plus explicit Performance provenance.
- Completed 2026-11-27: runtime `productId` context, product-scoped API/RCA
  filters, per-SKU `OEE_PRODUCT_CYCLE_TIMES` lookup, mixed-product theoretical
  output summation, and explicit fallback/data-quality warnings.

Deliverables:

- Add explicit planned-time and shift-calendar configuration, including timezone
  and shift-boundary handling.
- Classify downtime as planned stop, unplanned stop, changeover, or unknown;
  expose the classification and source in OEE results.
- Add counter-reset/epoch detection that survives PLC and Gateway restarts
  without silently turning a reset into zero production.
- Add quality reconciliation fields, for example `counterScrapDelta`,
  `qualityEventQuantity`, and a reconciliation delta/warning.
- Add `dataQuality` and loss-breakdown output while preserving existing OEE fields.
- Define product/SKU or ideal-cycle-time inputs needed for correct Performance.

Acceptance:

- A window crossing a shift boundary splits or clips planned time correctly.
- Planned stop, unplanned stop, changeover, counter reset, and missing-counter
  scenarios have deterministic tests.
- Existing `PROCESS_CONTEXT` events and OEE consumers remain compatible.
- OEE output states whether the total counter, good-count proxy, or a degraded
  calculation was used, and why.

### M2. Durable Storage and Edge Resilience

Priority: P0/P1, after M1 data semantics are stable.

Problem: bounded JSONL is simple and inspectable, but disk-full behavior, write
backpressure, crash recovery, and long-running retention need stronger guarantees.

Deliverables:

- Introduce a storage boundary so process events, quality events, idempotency,
  and future outbox records use a consistent durability contract.
- Evaluate SQLite WAL for indexed retention and crash-safe state; retain JSONL
  import/replay compatibility where it remains useful.
- Define behavior when storage is full or writes slow down: fail closed, degrade
  health, drop policy, and operator-visible metrics.
- Add event sequence/watermark checks for gaps, duplicates, and out-of-order data.
- Add backup/export and restore procedures for the Raspberry Pi state directory.

Progress:

- Completed 2026-11-27: configurable disk free-space monitoring, per-component
  write health, storage fields in `/healthz`, and Prometheus metrics for disk
  pressure and write failures.
- Completed 2026-11-27: NG quality ingestion waits for JSONL durability, returns
  `503` with in-memory rollback when the append fails, and serializes in-flight
  duplicate requests. Work-context persistence failures also restore the prior
  in-memory context.
- Completed 2026-11-27: runtime fault-injection tests cover a real `ENOSPC`
  target, slow log writes, and no early acknowledgement of in-flight duplicates.
- Completed 2026-11-27: checksummed state backup/export/verify/restore tooling
  with a manifest, preflight validation, file-mode preservation, and atomic
  per-file restore; deployment runbook updated for quiesced backups.
- Completed 2026-11-27: per-stream event sequence watermarks with duplicate,
  gap, missing-event, and out-of-order diagnostics in `/healthz` and Prometheus;
  legacy JSONL without sequence fields remains replayable.
- Completed 2026-11-27: forced-kill recovery test for a large quality JSONL
  append, plus automatic isolation of a crash-truncated final line so the next
  valid record is not concatenated into the corrupt fragment.
- Completed 2026-11-27: reproducible JSONL/SQLite WAL benchmark and storage
  decision; SQLite is a conditional next backend, while JSONL remains the
  default until runtime, importer, backup, and Pi power-loss gates are met.
- Completed 2026-11-27: checked-in legacy JSONL migration fixtures covering
  rotated segments, records without `sequence`, and idempotency entries whose
  source events have left the retained event window.
- Completed 2026-11-27: fsync durability contract for acknowledged quality
  events, atomic work-context/idempotency state, and optional process-context
  sync; sync-barrier failure recovery is covered by tests.
- Completed 2026-11-27: three virtual-day retention and disk-budget tests cover
  4,320 context samples, JSONL rotation limits, quality retention, the
  idempotency horizon, replay, and sequence continuity.
- Remaining: physical power-cut validation on Raspberry Pi storage, the 72-hour
  hardware soak, and the gated SQLite importer/backend if adoption proceeds.

Acceptance:

- Power-loss and forced-kill tests recover without corrupting the active store.
- Disk-full and slow-storage simulations produce explicit health degradation and
  do not silently acknowledge unpersisted critical events.
- Retention stays within configured disk budgets over a multi-day run.
- Migration from the current JSONL layout is tested on existing fixtures.

### M3. Real PLC Commissioning and Security

Priority: P1, required before a field pilot.

Problem: the default path is optimized for the Mock PLC. A real deployment needs
preflight validation, stale-value handling, secured OPC UA, and clock diagnostics.

Deliverables:

- Add named station profiles/environment templates for real PLC mappings.
- Completed 2026-11-27: commissioning/doctor command validates endpoint
  reachability, NodeIds, data types, status codes, timestamps, event notifier,
  and expected counter invariants with pass/warn/fail and JSON output.
- Completed 2026-11-27: live subscriber diagnostics detect Bad/Uncertain status,
  stale notifications, missing/future source timestamps, source/server clock
  skew, reconnect gaps, and native-event subscription failures/recoveries;
  expose them through `/healthz.plc` and Prometheus metrics. Non-Good values are
  excluded from process snapshots so incomplete context is visible.
- Completed 2026-11-27: injected full-path diagnostics E2E covers Bad/Uncertain
  status, stale tags, future/source-server clock skew, process-context
  pause/resume, and recovery after a PLC restart/reconnect. The default
  `StatusValueTimestamp` trigger keeps unchanged scanned tags fresh.
- Completed 2026-11-28: support OPC UA Sign and Sign&Encrypt, explicit server
  certificate trust, pre-provisioned or generated client certificates,
  restart-based certificate rotation, and credential injection from protected
  files. Production startup rejects `None` security or unknown-certificate
  auto-trust unless explicitly overridden. `npm run e2e:security` covers the
  secured path and rotation.
- Completed 2026-11-28: OS clock synchronization diagnostics detect
  `timedatectl`/`chronyc` NTP state and offset, expose `/healthz.clock` and
  Prometheus metrics, support staleness/required thresholds, document Pi NTP
  commissioning, and provide injected `npm run e2e:clock` coverage.
- Completed 2026-11-28: remote-access TLS template and runbook cover nginx
  termination, TLS 1.2/1.3, loopback proxying, source-network policy for
  `/healthz`, bearer-token preservation, optional mTLS/Basic Auth guidance,
  rate/connection limits, security headers, HSTS gating, certificate rotation,
  firewall checks, and bounded access-log retention.
- Completed 2026-11-28: `npm run edge:verify` provides repeatable deployed-edge
  verification with trusted certificate validation, TLS probes, redirect and
  security-header checks, token handling from protected files/environment, mTLS
  support, optional loopback-origin checks, JSON output, and strict exit status.
- Completed 2026-11-28: `npm run commission` produces a mode-`0600` field
  acceptance report spanning release/rollback readiness, systemd, health,
  PLC/clock/storage, OPC UA doctor, and edge verification, with a post-reboot
  uptime gate and strict handling for skipped gates.
- Completed 2026-11-28: `npm run field:drill` provides an explicit staged
  preflight/install/post-install/reboot/post-reboot/certificate-rotation/
  rollback workflow with protected persistent state, boot-ID and certificate-
  fingerprint gates, hardware-readiness reports, retry-safe rollback
  commissioning, and a checksummed evidence manifest.
- Completed 2026-11-28: `npm run hardware:check` records Pi 4 model/runtime,
  temperature, current and historical throttle/under-voltage flags, firmware,
  NTP, and storage headroom in a mode-`0600` report, with explicit warnings for
  missing `vcgencmd` telemetry.

Acceptance:

- A checklist run can prove that a real PLC mapping is usable before production data is trusted.
- Long disconnect/reconnect, stale tag, bad status, and clock-skew scenarios are covered by E2E tests.
- No default credentials or private keys are stored in the repository or logs.

### M4. Integration and Operational Observability

Priority: P1, can start once M1/M3 contracts are stable.

Deliverables:

- Publish an OpenAPI document for the local Gateway API.
- Add an optional durable sink/outbox for MES/UA/HTTP/MQTT consumers with retry,
  backoff, idempotency, and replay controls.
- Expand Prometheus metrics for OEE gauges, data freshness, capture latency,
  reconnect counts, storage usage, warning counts, and sink backlog.
- Add structured audit events for configuration changes, work-context changes,
  ingestion decisions, and persistence failures.
- Provide health/readiness semantics suitable for systemd and an external monitor.

Acceptance:

- Consumers can retrieve the same event twice without creating duplicate work.
- A sink outage does not lose source events or block OPC UA collection.
- Operators can identify whether a problem is PLC, Gateway, storage, or downstream integration.

### M5. RCA and Quality Feedback

Priority: P2, after dependable data and integration.

Deliverables:

- Make anomaly rules configurable per line/station and support additional signal
  sources such as vibration, pressure, speed, and recipe changes.
- Add baseline/statistical anomaly detection alongside fixed thresholds, with
  complete evidence and threshold provenance.
- Support manual annotations and feedback on candidates without rewriting raw evidence.
- Add exportable evidence bundles linking quality events, process context, alarms,
  and RCA candidates.
- Keep the explicit non-causal disclaimer and expose confidence limitations.

Acceptance:

- Every candidate can be reproduced from retained evidence.
- Rule changes are versioned and do not alter historical results retroactively.
- Feedback is stored separately from raw measurements and is auditable.

### M6. Pilot Hardening and Release

Priority: release gate.

Deliverables:

- Completed 2026-11-27: GitHub Actions CI for Node 22.13/24 unit/integration
  tests, generated-event JSON Schema checks, documentation link checks, E2E,
  doctor, security, clock, and a 20-second soak smoke. Production dependency
  audit now runs before release packaging.
- Completed 2026-11-27: repeatable soak harness covering API load, quality
  ingestion, fault injection, PLC reconnect cycles, retention and log-budget
  checks. A full 72-hour run remains a release gate.
- Completed 2026-11-28: optional hardware sampling in the soak harness records
  minimum/maximum CPU temperature and current/historical under-voltage or
  throttling flags, and fails the run when Pi telemetry is missing or unhealthy.
- Completed 2026-11-28: versioned release packaging with per-file SHA-256,
  archive checksums, Git/runtime/state-format provenance, Node engine checks,
  immutable release directories, health-checked upgrades with automatic
  rollback, explicit rollback/status commands, and state-backup/migration
  procedures.
- Completed 2026-11-28: security review of OPC UA, HTTP, logs, secrets, release
  integrity, dependencies, and the systemd sandbox.
- Completed 2026-11-28: field-pilot runbook with acceptance/exit criteria and a
  known-limitations register.
- Completed 2026-11-28: detached release signing and verification commands,
  mandatory-signature installation gate, public-key fingerprint recording and
  pinning, offline evidence reverification, and CI signing smoke coverage.
- Completed 2026-11-28: native npm CycloneDX 1.5 SBOM generation embedded in
  release archives, covered by manifest checksums and archive signatures, with
  verified sidecar extraction and CI artifact export.
- A 72-hour soak test with fault injection, reconnect cycles, storage pressure, and API load.

Acceptance:

- Pilot release passes all previous milestone gates.
- A failed upgrade can be rolled back without losing accepted events.
- Operators have a documented recovery path for PLC loss, storage loss, and power loss.

## Immediate Backlog

The next implementation-sized units are:

1. Finish the M2 storage boundary with physical power-cut validation on
   Raspberry Pi hardware and the gated SQLite importer/backend if the documented
   adoption gates are met.
2. Validate NTP synchronization and run the long-duration injected fault matrix
   alongside the 72-hour soak on Raspberry Pi hardware with hardware sampling
   enabled; retain strict hardware readiness reports before and after the run.
3. Exercise signed release upgrade/rollback and state restore on Raspberry Pi
   hardware with the staged `field:drill` workflow; complete release-key custody,
   rotation, and revocation procedures around the implemented fingerprint-pinning
   gate; retain the release audit and CycloneDX VEX evidence generated for the
   embedded SBOM.
4. Complete a real-PLC certificate-rotation drill, then approve, install, and
   exercise the supplied reverse-proxy/TLS template on the target network before
   exposing the API beyond loopback.

M1 is complete, and the live PLC diagnostics software is complete. Prioritize
the remaining M2 hardware/durability gates and M3 security/E2E validation before
adding new outward integrations.

## Release Gates

A release is not field-ready unless all of these are true:

- Unit tests, schema checks, Mock PLC E2E, and Gateway E2E pass.
- Security E2E, clock E2E, dependency audit, and systemd unit verification pass.
- 72-hour soak and reconnect/power-loss/disk-full tests pass.
- OEE responses state their time basis, counter mode, loss classification, and data-quality warnings.
- Backup, restore, upgrade, and rollback have been exercised on Raspberry Pi hardware.
- Production installs require and verify the detached release signature, pin the
  approved signer public-key fingerprint, and retain that fingerprint in the
  approval record.
- HTTP and OPC UA security settings are explicit; no insecure production default is silent.
- Remote access, if enabled, uses the approved TLS template or equivalent;
  port 8080 is not externally reachable and the nginx protocol, authentication,
  source-network, rate-limit, certificate-rotation, and log-retention checks pass.
- The runbook distinguishes equipment faults from Gateway faults.
- The security review has no unresolved critical finding and its required
  compensating controls are recorded in the deployment approval.

## Explicit Non-Goals

- Replacing a safety PLC or providing closed-loop equipment control.
- Becoming a full MES, historian, or scheduling system.
- Guaranteeing causal root causes from time-series overlap alone.
- Supporting multi-line orchestration in one process before single-station field reliability is proven.

## Suggested Delivery Rhythm

Use small, independently reversible releases. A practical sequence is one to
three iterations per milestone, with M1-M3 completed before expanding RCA and
integration features. Every release should update this roadmap when a decision
or acceptance criterion changes.
