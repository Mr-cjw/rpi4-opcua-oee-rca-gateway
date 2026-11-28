# Offline Operational Tabletop

Status date: 2026-11-28

This exercise proves that the Gateway recovery procedures are executable before
the target Raspberry Pi, PLC, storage device, plant network, and production
certificates are available. It is a software and operator-readiness exercise,
not a hardware qualification.

Companion documents:

- [Field pilot runbook](PILOT-RUNBOOK.md)
- [Delivery plan](DELIVERY-PLAN.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
- [API contract](API-CONTRACT.md)
- [State migration procedure](STATE-MIGRATION.md)

## 1. Evidence Boundary

Every result is marked `mode: offline-simulation`, `evidenceLevel: L1/L2 local
simulation`, and `satisfiesHardwareGate: false`. A passing tabletop cannot close
an L3/L4 hardware, network, power-loss, certificate, or site-acceptance gate.

The exercise uses:

- A synthetic OPC UA client for PLC disconnect and reconnect.
- An injected `ENOSPC` at the JSONL append boundary for disk-full behavior.
- An injected clock-source loss for the required NTP gate.
- Synthetic release archives, simulated systemd commands, and simulated npm
  installation for upgrade and rollback.
- Temporary state files and an isolated backup directory for restore checks.

The report records commands, expected observations, observed values, decision
points, evidence paths, and the exact point where target-hardware execution
must begin. The synthetic v2 state-format rejection proves the safety boundary;
it does not execute a real migration.

## 2. Run the Exercise

Run from the repository root:

```bash
npm run tabletop -- \
  --output data/offline-tabletop-report.json \
  --evidence-dir data/offline-tabletop-report.evidence \
  --force
```

Use `--json` for a machine-readable command result. The command exits `0` when
all seven scenarios pass, `1` when the exercise fails, and `2` for invalid
arguments. Use `npm run tabletop -- --help` for all options.

The default paths are:

- Report: `data/offline-tabletop-report.json`
- Evidence directory: `data/offline-tabletop-report.evidence/`

The report and every scenario file are written mode `0600`; the evidence
directory is mode `0700`. Preserve both the report and the complete evidence
directory. The report includes each evidence SHA-256 for consistency checking.

## 3. Output Contract

The top-level report contains:

- `status`: `passed` or `failed`.
- `summary`: total, passed, and failed scenario counts.
- `hardwareGateNote`: the explicit non-qualification statement.
- `releaseRehearsal`: the underlying release rehearsal status and archive IDs.
- `scenarios[]`: commands, expectations, observations, checks, decision points,
  hardware handoff, evidence path, and evidence digest.
- `hardwareHandoff[]` and `limitations[]`: the remaining physical work.

Each scenario evidence file contains the same scenario record plus its own
schema, mode, evidence level, and `satisfiesHardwareGate: false` marker.

## 4. Fault-Domain Checklist

Use this table before taking corrective action. A correct Gateway alarm can
describe an equipment fault, and a Gateway fault can occur while the PLC remains
healthy.

| Observation | Primary domain | First safe action |
| --- | --- | --- |
| PLC is stopped, a sensor failed, temperature is unsafe, or an operator stopped the line | Equipment/PLC | Follow the site control plan; do not restart the Gateway to hide the condition |
| `opcuaConnected=false`, reconnect timeouts, or certificate/account rejection | PLC, network, certificate, or Gateway client | Confirm the endpoint, route, certificate, and account before restarting either side |
| OPC UA values are Bad, Uncertain, stale, future-dated, or clock-skewed | PLC point, PLC clock, or mapping | Check `/healthz.plc.variables[]` and the source tag timestamp |
| `/healthz` is degraded while PLC and API still respond | Gateway health | Inspect the reported `plc`, `clock`, `storage`, and sequence fields |
| Quality ingestion returns `503` | Gateway storage | Preserve logs, free or replace storage, then retry the same `sourceEventId` |
| OEE counters disagree with observed production | Mapping, counter reset, or OEE inputs | Check counter continuity, planned time, cycle time, and NG reconciliation |
| RCA candidate conflicts with operator knowledge | Correlation analysis | Treat RCA as evidence, not proof; inspect the retained window and site record |
| Power or storage I/O failure affects the host | Gateway host | Preserve evidence, check storage integrity, and restore a verified backup if required |

The first recovery principle is to preserve evidence. Never delete state or
truncate the quality log merely to make health green.

## 5. Scenario Procedures

The paths below use `<evidenceDir>` for the selected evidence directory. Every
scenario must retain its file even when the overall exercise fails.

### 5.1 PLC Loss and Reconnect

Evidence: `<evidenceDir>/plc-loss.json`

Commands and observations:

```bash
curl -s http://127.0.0.1:8080/healthz | jq '{status,opcuaConnected,plc}'
```

Expected observations:

- Baseline health is `ok`, `opcuaConnected=true`, and the PLC is healthy.
- Loss sets `opcuaConnected=false`, health to `degraded`, and PLC diagnostics to
  `critical` while the last frozen context remains visible.
- Reconnect advances the process-context timestamp and restores health to `ok`.

Decision points:

- Confirm PLC endpoint, network, certificate, and account before restarting the
  Gateway.
- If the endpoint recovers but context does not advance, classify it as a
  Gateway/PLC integration fault and preserve logs.

Hardware handoff: repeat against the real OPC UA endpoint, installed service,
PLC, and plant network. The synthetic client cannot prove session, certificate,
subscription, or reconnect behavior on the real link.

### 5.2 Disk Full and Idempotent Retry

Evidence: `<evidenceDir>/disk-full.json`

Commands and observations:

```bash
curl -s http://127.0.0.1:8080/healthz | jq '{status,storage,sequences}'
curl -s -X POST http://127.0.0.1:8080/v1/quality-events \
  -H 'content-type: application/json' \
  -d '{"sourceEventId":"QC-RETRY","result":"NG"}'
```

Expected observations:

- A baseline quality event is accepted before the fault.
- The injected full-write path returns `503`; the rejected event is rolled back
  from memory and the quality component becomes `critical`.
- The failed sequence is not persisted, so recovery leaves a visible sequence
  gap rather than silently reusing the number.
- After storage recovers, retrying the same `sourceEventId` returns `201`, keeps
  one retained event per source ID, and restores storage health.

Decision points:

- Free or replace storage; never truncate JSONL or the idempotency ledger to
  regain space.
- Retry the same `sourceEventId` after recovery. Do not create a new key because
  the original request returned `503`.

Hardware handoff: fill the actual target filesystem and verify I/O failure,
fsync, rotation, log recovery, and QA/MES retry behavior on the Pi storage
device. The injection does not test the kernel, filesystem, or physical media.

### 5.3 Required NTP Loss and Recovery

Evidence: `<evidenceDir>/ntp-loss.json`

Commands and observations:

```bash
timedatectl show --property=NTPSynchronized --value
curl -s http://127.0.0.1:8080/healthz | jq '.clock'
```

Expected observations:

- The synchronized baseline reports clock status `ok`.
- Loss of synchronization produces `warning`, `healthy=false`, and reason
  `not_synchronized` when the clock gate is required.
- Restoration of a synchronized source returns status `ok`.

Decision points:

- Repair NTP connectivity or the approved time source; do not disable the
  required clock gate to clear an alert.
- Record the affected interval because OEE and RCA windows depend on clock
  accuracy.

Hardware handoff: inject NTP loss on the plant network and validate the real
`timedatectl`/`chronyc` source, time-zone behavior, offsets, and timing side
effects on the target Pi.

### 5.4 Failed Upgrade and Automatic Rollback

Evidence: `<evidenceDir>/failed-upgrade-auto-rollback.json`

Commands and observations:

```bash
npm run release:rehearse -- \
  --base-archive <base.tar.gz> \
  --candidate-archive <candidate.tar.gz> \
  --state-dir <state-dir> \
  --output <evidenceDir>/release-rehearsal.json
```

Expected observations:

- The candidate install fails its health gate.
- The installer reports the restored base release.
- The release `current` pointer returns to the base release and remains there.

Decision points:

- If automatic rollback does not restore the base release, stop and execute an
  explicit rollback using the verified previous release.
- If the base release also fails health, isolate the host or storage fault
  before another install.

Hardware handoff: repeat the failure with the real systemd service, installed
release root, and health endpoint. Simulated service commands cannot prove
process-manager or reboot behavior.

### 5.5 Explicit Rollback

Evidence: `<evidenceDir>/explicit-rollback.json`

Commands and observations:

```bash
npm run release:status -- --release-root <release-root>
npm run release:rollback -- \
  --release-root <release-root>
curl -s http://127.0.0.1:8080/healthz | jq .status
```

Expected observations:

- The candidate becomes current after the simulated upgrade.
- An operator-initiated rollback restores the base release as current.
- The previous link and recorded command count identify the successful path.

Decision points:

- If the rollback target is missing, stop and restore from the approved release
  archive under the rollback procedure.
- If the release manifest requires `state-restore-required`, restore the
  verified pre-upgrade backup before starting the older release.

Hardware handoff: repeat with systemd, the real release root, the real health
endpoint, and a reboot. Verify service state, links, and accepted events across
the rollback.

### 5.6 State Backup and Restore

Evidence: `<evidenceDir>/state-restore.json`

Commands and observations:

```bash
npm run state:backup -- --state-dir <state-dir> --output <backup-dir>
npm run state:verify -- --backup <backup-dir>
npm run state:restore -- --backup <backup-dir> --state-dir <restore-dir> --force
```

Expected observations:

- A checksummed backup is created before mutation.
- Every restored file matches its verified backup checksum and expected mode.
- Missing files are reported explicitly rather than replaced with empty data.

Decision points:

- If checksum verification fails, stop and preserve both backup and damaged
  state.
- If the backup predates the incident, reconcile QA/MES records before accepting
  the restored state.

Hardware handoff: restore on the target state filesystem and verify ownership,
permissions, disk I/O, service startup, and restart replay on the Pi.

### 5.7 State-Format Boundary

Evidence: `<evidenceDir>/state-format-boundary.json`

Commands and observations:

```bash
npm run release:rehearse -- \
  --base-archive <v1-base.tar.gz> \
  --candidate-archive <synthetic-v2.tar.gz> \
  --state-dir <state-dir> \
  --output <evidenceDir>/release-rehearsal.json
```

Expected observations:

- The synthetic v2 release is rejected with a specific state-format diagnostic.
- The release switch does not occur.
- Accepted v1 state remains byte-for-byte unchanged and its verified backup
  remains restorable.

Decision points:

- Do not bypass a state-format mismatch by deleting state.
- A real migration requires a reviewed migration contract and a verified
  pre-migration backup.

Hardware handoff: a real state-format migration, including power loss during
and after migration, remains a target-Pi qualification gate. This scenario
proves rejection and backup preservation only; it does not execute a migration.

## 6. Hardware Handoff Summary

A tabletop result is complete only when every scenario states its handoff. The
target campaign must repeat these checks in the following order:

1. PLC loss, rejected certificate, reconnect, and subscription recovery on the
   real endpoint and plant network.
2. Disk-full, storage-I/O failure, rotation, fsync, and idempotent QA/MES retry
   on the installed state filesystem.
3. NTP loss, offset, time-zone, and recovery behavior on the site network.
4. Signed install, failed upgrade, automatic rollback, explicit rollback, state
   restore, reboot, and the staged `field:drill` evidence chain on the Pi.
5. A reviewed state migration with a verified backup if a future release changes
   the state format.
6. The long-duration soak and hardware resilience matrix required by
   [the delivery plan](DELIVERY-PLAN.md#5-hardware-qualification-campaign).

Do not promote a release or close a hardware gate from the offline report. The
L3/L4 decision belongs to the staged hardware and site-acceptance process in
the [field pilot runbook](PILOT-RUNBOOK.md).
