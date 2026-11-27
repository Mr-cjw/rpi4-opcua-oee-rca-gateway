# Raspberry Pi Gateway Roadmap

Status date: 2026-11-27

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
- Detect stale values, Bad status, clock skew, reconnect gaps, and subscription
  recovery events; expose them in health and metrics.
- Support OPC UA Sign and Sign&Encrypt with client certificates, certificate
  rotation, and external credential injection.
- Synchronize the Pi clock and record source/server timestamps for analytics.

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

- Completed 2026-11-27: GitHub Actions CI for Node 20/22 unit/integration
  tests, generated-event JSON Schema checks, documentation link checks, E2E,
  doctor, and a 20-second soak smoke.
- Completed 2026-11-27: repeatable soak harness covering API load, quality
  ingestion, fault injection, PLC reconnect cycles, retention and log-budget
  checks. A full 72-hour run remains a release gate.
- Versioned release packaging, upgrade, rollback, and state-migration procedures.
- A 72-hour soak test with fault injection, reconnect cycles, storage pressure, and API load.
- Security review of OPC UA, HTTP, logs, secrets, and the systemd sandbox.
- Field-pilot runbook, acceptance criteria, and a known-limitations document.

Acceptance:

- Pilot release passes all previous milestone gates.
- A failed upgrade can be rolled back without losing accepted events.
- Operators have a documented recovery path for PLC loss, storage loss, and power loss.

## Immediate Backlog

The next implementation-sized units are:

1. Begin the M2 storage boundary and disk-pressure behavior.
2. Add live health/metrics detection for stale values, Bad status, clock skew,
   reconnect gaps, and subscription recovery.
3. Execute the 72-hour soak on Raspberry Pi hardware and add release packaging,
   upgrade, and rollback procedures.

M1 is complete. Prioritize M2 durability and M3 live PLC diagnostics before
adding new outward integrations.

## Release Gates

A release is not field-ready unless all of these are true:

- Unit tests, schema checks, Mock PLC E2E, and Gateway E2E pass.
- 72-hour soak and reconnect/power-loss/disk-full tests pass.
- OEE responses state their time basis, counter mode, loss classification, and data-quality warnings.
- Backup, restore, upgrade, and rollback have been exercised on Raspberry Pi hardware.
- HTTP and OPC UA security settings are explicit; no insecure production default is silent.
- The runbook distinguishes equipment faults from Gateway faults.

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
