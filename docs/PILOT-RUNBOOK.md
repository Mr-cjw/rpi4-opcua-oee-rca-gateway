# Field Pilot Runbook

Status date: 2026-11-28

This runbook covers commissioning, operation, upgrade, rollback, monitoring,
and incident handling for one Raspberry Pi Gateway attached to one PLC/station.
It is written for a controlled field pilot, not for unattended plant-wide
deployment.

Companion documents:

- [Deployment guide](../deploy/README.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
- [Security review](SECURITY-REVIEW.md)
- [Roadmap and release gates](ROADMAP.md)

## 1. Scope and Responsibilities

The Gateway is a read-only observer. It reads configured OPC UA values and
events, records bounded local evidence, calculates OEE, and reports RCA
candidates. It does not command the PLC, replace a safety device, or update
QA/MES disposition.

Record these owners before commissioning:

| Role | Responsibility |
| --- | --- |
| Site production owner | Confirms the pilot line, shift plan, acceptance window, and business impact |
| PLC/controls engineer | Confirms NodeIds, data types, timestamps, counters, alarm semantics, and certificate/account setup |
| Gateway operator | Installs releases, applies configuration, runs diagnostics, monitors health, and preserves evidence |
| Security reviewer | Approves network exposure, credentials, certificate trust, and incident handling |
| QA/MES owner | Confirms quality-event retry, reconciliation, and downstream delivery behavior |

Every pilot change must have a timestamp, operator, release ID or Git commit,
configuration diff summary, validation output, and rollback decision.

## 2. Fault-Domain Model

Separate equipment faults from Gateway faults before taking corrective action.
The Gateway can report a bad PLC condition correctly while the production
equipment is healthy.

| Observation | Primary domain | Safe first action |
| --- | --- | --- |
| PLC shows stopped, failed sensor, unsafe temperature, or operator-triggered stop | Equipment/PLC | Follow the site control plan; do not restart the Gateway to hide the condition |
| `opcuaConnected=false`, repeated reconnect failures, or endpoint timeout | PLC, network, certificate, or Gateway client | Confirm PLC endpoint reachability and certificate validity before restarting either side |
| OPC UA values are Bad, Uncertain, stale, future-dated, or clock-skewed | PLC point, PLC clock, or mapping | Read `/healthz.plc.variables[]`; verify the PLC tag and timestamp at source |
| Gateway `/healthz` is degraded while the PLC and API still respond | Gateway health | Inspect the reported `plc`, `clock`, `storage`, and sequence fields |
| Quality API returns `503` | Gateway storage | Free or replace storage, then retry the same `sourceEventId` |
| OEE counter delta is inconsistent with observed production | Mapping, counter reset, or OEE inputs | Check counter continuity, planned time, cycle time, and NG reconciliation evidence |
| RCA lists a candidate but the operator believes the cause is elsewhere | Correlation analysis | Treat RCA as evidence, not proof; inspect the retained window and apply site knowledge |
| Pi loses power or storage reports I/O errors | Gateway host | Preserve logs, check storage integrity, and restore a verified state backup if needed |

The first recovery principle is to preserve evidence. Restarting or deleting
state can erase the distinction between a transient equipment event and a
Gateway defect.

## 3. Preflight Checklist

### 3.1 Host and Runtime

- Raspberry Pi 4, 64-bit Raspberry Pi OS, and a supported Node.js runtime.
- `node --version` reports `v22.13.0` or newer. Node.js 20 is not supported by
  the current OPC UA dependency.
- A quality SSD or industrial SD card is preferred. Document the storage type,
  serial number, and expected write endurance.
- The Pi has a stable power source; a UPS is recommended for the pilot.
- NTP is enabled and synchronized before the Gateway starts.
- The service account is `rpi4-gateway` and has no interactive login shell.
- `/var/lib/rpi4-gateway` has enough free space for logs, rotation, temporary
  writes, and the idempotency ledger.
- The systemd unit passes `systemd-analyze verify deploy/rpi4-gateway.service`.

### 3.2 Network and Security

- The HTTP API remains bound to `127.0.0.1` unless an approved reverse proxy
  provides TLS, authentication, rate limiting, and access logging.
- `GATEWAY_API_TOKEN` is set to a unique high-entropy value for any deployment
  where the API is not strictly local to the operator.
- The OPC UA endpoint uses `SignAndEncrypt` and `Basic256Sha256` unless the
  controls/security owners approve a documented exception.
- `OPCUA_TRUST_UNKNOWN_CERTIFICATES=false`; only the PLC certificate recorded
  during commissioning is trusted.
- OPC UA credentials are supplied through mode-`0600` files owned by the
  service account, never through Git or shell history.
- The Pi firewall exposes only the ports required by the approved design. Do
  not expose the Gateway HTTP API directly to the plant or business network.

### 3.3 PLC Interface and Process Semantics

- Endpoint URL, security mode, policy, account, and certificate fingerprint are
  recorded in the commissioning record.
- Every required NodeId, browse name, data type, engineering unit, and access
  level is confirmed against the PLC documentation.
- `GoodCount` and `TotalProducedCount` semantics, reset behavior, and rollover
  limits are confirmed. The total counter may be disabled only when the agreed
  fallback is acceptable.
- Source timestamps advance with the PLC scan or data change. Timestamp source
  and quality behavior are known.
- Alarm codes, active/cleared semantics, and event subscription behavior are
  recorded.
- Planned-time windows, time zone, ideal cycle time or nominal output, product
  cycle times, and NG source-event IDs are validated with production.

### 3.4 Pilot Data and Acceptance

- Work-order, serial-number, correlation-ID, and product-ID ownership is
  defined. Confirm who updates runtime work context and when.
- QA/MES delivery uses `sourceEventId` for retries and treats only HTTP `200` or
  `201` as accepted.
- The pilot start/end time, OEE reporting window, KPI tolerance, incident
  contacts, and escalation path are agreed in writing.
- A verified checksummed release archive and an off-device state backup location
  are ready before installation.

## 4. Commissioning Procedure

1. Install Node.js 22.13 or newer and verify `node --version` and
   `npm --version`.
2. Verify the release archive and checksum on a management host. Do not build
   or modify source on the production Pi.
3. Follow [the deployment guide](../deploy/README.md) to install the service
   user, unit, environment file, and immutable release.
4. Apply the approved environment file with mode `0600`. Store
   `OPCUA_USERNAME_FILE` and `OPCUA_PASSWORD_FILE` separately with mode `0600`.
5. Provision the PLC certificate in the Gateway client trust store and compare
   its SHA-256 fingerprint with the commissioning record.
6. Create a clean state directory and confirm ownership by `rpi4-gateway`.
7. Run the read-only commissioning doctor with the production environment and
   archive its strict report:

   ```bash
   sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
     cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run doctor -- --strict --json' \
     | sudo tee /var/backups/rpi4-gateway/commissioning-doctor.json
   ```

8. Start the service and verify health before accepting production data:

   ```bash
   sudo systemctl enable --now rpi4-gateway.service
   curl -s http://127.0.0.1:8080/healthz | jq '{status,opcuaConnected,clock,storage,plc}'
   ```

9. Read the latest context and OEE response. Confirm timestamps, work context,
   counter mode, planned time, quality inputs, and warning fields.
10. Inject or wait for one known equipment fault. Confirm that the alarm,
    process-context, OEE loss classification, and RCA candidate agree with the
    site event record.
11. Take a baseline state backup after the pilot dataset and process semantics
    are accepted.

## 5. Install, Upgrade, and Rollback

### 5.1 Upgrade

Use only a verified archive built from a clean Git commit. The Pi installer
checks the archive, manifest, checksums, Node.js minimum, and package lock,
installs production dependencies, switches `current`, restarts the service,
and checks `/healthz`.

```bash
sudo systemctl stop rpi4-gateway.service
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run state:backup -- --output /var/backups/rpi4-gateway/20261128T120000 && \
  npm run state:verify -- --backup /var/backups/rpi4-gateway/20261128T120000'

sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js install \
  --archive /var/tmp/<archive>.tar.gz \
  --checksum /var/tmp/<archive>.tar.gz.sha256 \
  --release-root /opt/rpi4-opcua-oee-rca-gateway \
  --state-backup /var/backups/rpi4-gateway/20261128T120000

curl -s http://127.0.0.1:8080/healthz | jq '{status,opcuaConnected,clock,storage,plc}'
```

Copy the backup off the Pi before deleting local copies. Keep the failed or
superseded release and `/opt/rpi4-opcua-oee-rca-gateway/last-release.json` until
the change record is closed.

### 5.2 Rollback

The installer automatically restores `previous` when the new release cannot
become healthy. For an operator-initiated rollback:

```bash
sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js status \
  --release-root /opt/rpi4-opcua-oee-rca-gateway
sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js rollback \
  --release-root /opt/rpi4-opcua-oee-rca-gateway \
  --state-backup /var/backups/rpi4-gateway/20261128T120000
curl -s http://127.0.0.1:8080/healthz | jq .status
```

Code rollback does not change `/var/lib/rpi4-gateway`. If the release note
declares a state-format migration, restore the verified pre-upgrade backup only
after stopping the service and before starting the older release.

## 6. Monitoring and Routine Checks

### 6.1 Health and Metrics

```bash
curl -s http://127.0.0.1:8080/healthz | jq .
curl -s -H "Authorization: Bearer <token>" \
  http://127.0.0.1:8080/metrics | rg 'rpi4_gateway_(opcua|plc|clock|storage|event_sequence)'
```

Treat `/healthz` as `ok` only when the response reports `status: ok`,
`opcuaConnected: true`, `storage.status: ok`, `clock.status: ok` when required,
and PLC diagnostics are healthy. `/healthz` is unauthenticated by design; keep
it on loopback or protect it at the network boundary.

Monitoring baseline:

- Page on `opcuaConnected=false`, `storage.status != ok` when persistence is
  required, a required unsynchronized clock, or an unresolved certificate error.
- Warn on PLC bad/uncertain/stale/future-dated values, event-subscription loss,
  growing reconnect gaps, or recurring sequence gaps.
- Alert before the configured storage warning threshold, not only after the
  critical threshold.
- Monitor CPU, memory, temperature, SD/SSD health, and power events outside the
  Gateway. Application metrics do not diagnose host hardware failure.

### 6.2 Routine Checks

| Interval | Check |
| --- | --- |
| Every shift | `/healthz`, PLC connectivity, latest context age, clock sync, storage status |
| Daily | Service restarts, warning/critical log entries, sequence gaps, quality API failures, free space |
| Weekly | Backup integrity, off-device backup copy, log volume, certificate expiry horizon, OS updates |
| Each change | Strict doctor, security E2E, release verification, state backup, rollback rehearsal |
| Before pilot exit | 72-hour soak and hardware recovery gates in the roadmap |

## 7. Incident Response

For every incident:

1. Record time, operator, release ID, current health/status output, and the
   affected work order/product.
2. Preserve logs, `last-release.json`, systemd journal output, and the affected
   state files before destructive recovery.
3. Classify the fault domain with Section 2.
4. Prefer the least destructive action: fix the PLC, network, clock, or storage
   before restarting the Gateway.
5. Record every accepted quality event separately from events whose write was
   rejected or whose acceptance is unknown.
6. Escalate security events through the site process; do not attempt to hide a
   credential or certificate incident by editing logs.

### 7.1 PLC or Network Loss

Check the PLC endpoint, route, firewall, certificate expiry, account lockout,
and PLC diagnostics. When the PLC returns, confirm the Gateway reconnects and
that the latest context timestamp advances. A reconnect gap is expected evidence;
do not erase it merely to make the dashboard green.

### 7.2 Bad, Uncertain, or Stale Values

Inspect `plc.variables[].issues`, NodeId mapping, status code, source timestamp,
and data type. `alarmEvents` is a change-driven snapshot and is exempt from stale
and source/server skew checks. Do not raise
`GATEWAY_PLC_STALE_WARNING_MS` until the PLC tag is confirmed to remain quiet by
design. For a clock-skew issue, correct the PLC or Pi clock and verify both
timestamps again.

### 7.3 Clock Unsynchronized

Keep `GATEWAY_CLOCK_SYNC_REQUIRED=true` in production. Repair NTP connectivity
or the selected time source. Do not disable the gate to clear an alert. Record
the affected time interval because OEE and RCA windows depend on clock accuracy.

### 7.4 Storage Warning, Full, or Write Failure

Free or replace the state volume. Preserve the existing JSONL and idempotency
ledger; do not truncate them to regain space. If quality ingestion returns
`503`, the event was not accepted: retry the same `sourceEventId` after storage
recovers. If accepted quality events may be missing after a power event, use the
last verified backup and reconcile against QA/MES records.

### 7.5 Sequence Gap, Duplicate, or Ordering Warning

Correlate the warning with restarts, forced kills, log rotation, clock changes,
or storage failures. Do not reset sequence watermarks without a documented
change record. A sequence gap is evidence of a possible missing record, not
permission to invent the missing event.

### 7.6 Certificate Rotation

Pause the change, verify the new certificate fingerprint with the PLC owner,
trust only that certificate, remove the obsolete trust entry, and restart the
service. Certificate trust is loaded at startup. Roll back the trust change if
the fingerprint cannot be reconciled.

### 7.7 Power Loss

After power returns, check filesystem errors, service startup, storage health,
sequence status, latest context age, and the last accepted quality event. If the
storage device reports I/O errors, replace it rather than repeatedly formatting
the same device. Restore only a verified backup and document the accepted-event
reconciliation result.

## 8. Pilot Acceptance and Exit Criteria

### 8.1 Software Gates

All of the following must pass on the release candidate:

```bash
git diff --check
npm run check:contracts
npm run check:docs
npm test
npm run e2e
npm run e2e:gateway
npm run e2e:diagnostics
npm run e2e:security
npm run e2e:clock
SOAK_DURATION_MS=20000 npm run soak
npm run security:audit
```

The release archive must also pass `release:package`, `release:verify`,
`release:sign`, `release:verify-signature`, and a test
install/health-check/rollback cycle. Record the public-key SHA-256 fingerprint
from the signature report and require it during the signed install. The release
private key must remain on the trusted signing host and must not be copied to
the Pi.

### 8.2 Hardware and Field Gates

The software gates are not a field acceptance. The following remain mandatory
before declaring the pilot production-ready:

- 72-hour soak with API load, quality ingestion, fault injection, reconnect
  cycles, retention, and log-budget checks on the target Pi.
- Verified NTP behavior and clock-failure degradation on the target network.
- Physical power-cut and disk-full recovery tests on the target storage.
- Install, upgrade, automatic rollback, explicit rollback, and state restore on
  actual Raspberry Pi hardware.
- PLC certificate rotation and rejected-certificate behavior with the real PLC.
- Confirmed OEE inputs and quality reconciliation against the agreed production
  baseline.

### 8.3 Pilot Exit Decision

| Decision | Criteria |
| --- | --- |
| Continue | All software and hardware gates pass; no unresolved critical security finding; accepted-event loss is zero; documented OEE/quality reconciliation is within the agreed tolerance |
| Conditional continue | A bounded, documented defect remains, with compensating controls, an owner, a fix date, and a tested rollback path |
| Stop or roll back | Unaccepted data loss, unresolved trust/security failure, unsafe equipment behavior, uncontrolled storage corruption, or no reliable recovery path |

The pilot exit record must include the release ID, configuration checksum or
diff, release-signing public-key fingerprint, validation evidence, incidents,
accepted-event counts, OEE reconciliation, open risks, and sign-off from the
production, PLC, Gateway, security, and QA/MES owners.
