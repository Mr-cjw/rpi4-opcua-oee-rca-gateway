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
- [Delivery plan and hardware qualification sequence](DELIVERY-PLAN.md)

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
- `npm run hardware:check -- --strict --json` passes with the state filesystem
  selected through `--storage-path /var/lib/rpi4-gateway`. The Pi must report an
  approved Pi 4-class model, an arm64 runtime, a temperature below the warning
  threshold, no active under-voltage/throttling flags, and synchronized NTP.
  Historical under-voltage or throttling flags require a reboot and a clean
  repeat before acceptance. Missing `vcgencmd` telemetry is a warning and fails
  `--strict`.

### 3.2 Network and Security

- The HTTP API remains bound to `127.0.0.1` unless an approved reverse proxy
  provides TLS, authentication, rate limiting, and access logging.
- If remote access is approved, the supplied nginx template or an equivalent
  reviewed design is installed. Only 443 is reachable from approved networks;
  port 8080 is not exposed, TLS 1.2/1.3 are enforced, and edge access logs have
  an approved retention period.
- `GATEWAY_API_TOKEN` is set to a unique high-entropy value for any deployment
  where the API is not strictly local to the operator.
- The edge certificate matches the approved DNS name, its private key is
  root-owned and mode `0600`, and rotation/rollback has been exercised. HSTS is
  enabled only after permanent HTTPS is confirmed.
- `npm run edge:verify` passes in strict mode against the approved DNS name,
  with private-CA/mTLS options as required, and its JSON output is archived in
  the commissioning record. TLS 1.1 `skip` results require an approved external
  scanner because the local OpenSSL client may not initiate the protocol.
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

### 5.3 Staged Release and Certificate Drill

Use `field:drill` to produce one auditable chain of evidence for a controlled
Pi drill: signed release install, process restart, edge-certificate rotation,
and rollback to the original release. It is intentionally operator-driven. The
tool never reboots the host and never replaces a certificate. `install` and
`rollback` fail unless `--execute` is supplied.

Before starting, prepare:

- A verified release archive, checksum, detached signature, and release public
  key. Use `--require-signature` and the approved public-key SHA-256 fingerprint
  from the change record with `--signer-fingerprint`.
- A verified state backup copied off the Pi. Do not use the live state directory.
- A known-good current release and its previous release metadata.
- The approved HTTPS URL, optional private CA or mTLS files, and the API token
  in `/etc/rpi4-gateway.env` or a mode-`0600` `--token-file`.
- The new edge certificate/key and a maintenance window in which nginx can be
  reloaded and the Gateway can be rebooted.
- A Pi with `vcgencmd` installed, a clean boot, and enough free space on
  `/var/lib/rpi4-gateway`; preflight and post-reboot fail on hardware warnings.

Run all phases as root because release installation and rollback stop and
restart systemd services. Keep the same mode-`0700` state directory for every
phase. Replace the sample timestamp with the drill's UTC start time.

```bash
DRILL_STATE=/var/lib/rpi4-gateway/field-drill-20261128T120000Z
export DRILL_STATE

# 1. Verify the release, state backup, rollback target, hardware, and boot ID.
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- \
    --state-dir "$DRILL_STATE" --phase preflight \
    --archive /var/tmp/<release>.tar.gz \
    --public-key /etc/rpi4-gateway/release-public.pem \
    --signer-fingerprint <approved-public-key-sha256> \
    --require-signature \
    --state-backup /var/backups/rpi4-gateway/20261128T120000Z \
    --url https://gateway.example.invalid --json'

# 2. Install the release and run strict commissioning.
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- --state-dir "$DRILL_STATE" --phase install --execute --json'
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- --state-dir "$DRILL_STATE" --phase post-install --json'

# 3. Reboot the Pi, reconnect, restore DRILL_STATE, and prove boot ID changed.
sudo systemctl reboot
DRILL_STATE=/var/lib/rpi4-gateway/field-drill-20261128T120000Z
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- --state-dir "$DRILL_STATE" --phase post-reboot --json'

# 4. Install the new edge certificate, reload nginx, and verify the public edge.
sudo install -m 0600 -o root -g root /var/tmp/<new-cert>.pem \
  /etc/rpi4-gateway/tls/fullchain.pem
sudo install -m 0600 -o root -g root /var/tmp/<new-key>.pem \
  /etc/rpi4-gateway/tls/privkey.pem
sudo nginx -t && sudo systemctl reload nginx
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run edge:verify -- --url https://gateway.example.invalid --strict --json'

# 5. Require the thumbprint to change, then roll back and auto-finalize.
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- --state-dir "$DRILL_STATE" --phase rotation-after --json'
sudo env DRILL_STATE="$DRILL_STATE" sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- --state-dir "$DRILL_STATE" --phase rollback --execute --json'
```

Preflight and `post-reboot` run the strict hardware check against
`/var/lib/rpi4-gateway` and store the reports in the evidence bundle. A
hardware warning or failure blocks progression; `--skip-hardware` is for
partial diagnostics and leaves a warning. The `post-reboot` phase reads
`/proc/sys/kernel/random/boot_id`; an unchanged ID is a hard failure.
`rotation-after` reads the served certificate SHA-256 fingerprint and fails when
it equals the post-install fingerprint. Every commissioning phase also runs the
same strict release, systemd, health, PLC/clock/storage, doctor, and edge checks
as `npm run commission`.

If `rollback --execute` completes the release switch but post-rollback
commissioning fails, rerun the same phase after fixing the cause. The recorded
rollback operation is reused, so the release is not switched a second time.
Completed phases reject accidental replay. Use the `finalize` phase to rebuild
the manifest only after every required phase has passed.

The protected state directory contains `drill-state.json`,
`drill-manifest.json`, `SHA256SUMS`, and the preflight, install, commission,
hardware, rotation, and rollback JSON evidence. The manifest records release
IDs, boot IDs, certificate fingerprints, hardware-readiness summaries,
signature-key fingerprint, state-backup summary, and phase results. Verify and
copy the bundle off the Pi while the change record is open:

```bash
sudo env DRILL_STATE="$DRILL_STATE" sh -c \
  'cd "$DRILL_STATE" && sha256sum -c SHA256SUMS'
```

A production drill must not leave preflight warnings for a missing signature,
state backup, or skipped hardware check. A `WARN` result is still exit code `0`;
inspect the JSON `status` and final phase results rather than relying only on
the shell exit code.

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

For an approved remote deployment, repeat these checks through the TLS endpoint
from the approved monitoring network. Confirm HTTP redirects to HTTPS, the edge
certificate is valid and not near expiry, `/healthz` is rejected outside its
allowlist, and `/metrics` rejects a missing or wrong bearer token. Review the
named nginx access log for authentication failures and rate-limit responses.
Archive `npm run edge:verify -- --json --strict` output after certificate,
authentication, firewall, or proxy changes.

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
# Remote deployments only, against the approved DNS name:
npm run edge:verify -- --url https://<gateway-name> --strict
# Target Pi hardware and installed-Gateway acceptance evidence:
npm run hardware:check -- --storage-path /var/lib/rpi4-gateway --strict --json
# Installed Pi acceptance evidence:
npm run commission -- --url https://<gateway-name> --strict --json \
  --output commissioning-report.json
```

For the release-gate soak on the target Pi, run as root with hardware sampling
enabled so the report retains power and thermal evidence:

```bash
sudo env SOAK_DURATION_MS=259200000 \
  SOAK_API_INTERVAL_MS=1000 \
  SOAK_RECONNECT_INTERVAL_MS=3600000 \
  SOAK_HARDWARE_INTERVAL_MS=30000 \
  SOAK_REPORT_PATH=/var/backups/rpi4-gateway/soak-72h.json \
  npm run soak
```

Hardware sampling fails the soak if CPU temperature reaches the configured
limit, any current or historical under-voltage/throttling flag is observed, or
`vcgencmd` evidence is incomplete. A historical flag means the Pi experienced a
power event since boot; reboot it and repeat the hardware baseline before
accepting the soak. The report is written with mode `0600`.

The release archive must also pass `release:package`, `release:verify`,
`release:sign`, `release:verify-signature`, `release:sbom`, a signed
`release:audit`, `release:evidence`, `release:verify-evidence`, and a test
install/health-check/rollback cycle. Preserve the evidence manifest, audit report,
and CycloneDX VEX sidecar with the archive checksum and signature. Confirm the
extracted SBOM identifies the expected application version and production
component set, and that every high or critical advisory has an active disposition
or no longer appears. Confirm the release manifest declares the expected Gateway
state format version and that the rehearsal reports it as compatible. Record the
public-key SHA-256 fingerprint from the signature report and pass it through
`--signer-fingerprint` during verification, evidence, rehearsal, and signed
install. A different public key must fail even if it produces a
cryptographically valid signature. The release private key must remain on the
trusted signing host and must not be copied to the Pi. Key rotation and
revocation are change-controlled: approve the replacement fingerprint before
distributing the new public key, and reject the old fingerprint after cutover.

When target hardware is unavailable, run `release:rehearse` with the previous and
candidate archives plus a copy of the target state directory. It verifies signed
installation, manifest-schema and declared state-format compatibility, explicit
rollback, failed-health automatic rollback, and state backup/restore in an
isolated work directory. Keep its mode-`0600` report as pre-hardware regression
evidence. CI repeats the signed rehearsal with separately versioned base and
candidate archives and an ephemeral key. This rehearsal does not satisfy the Pi
reboot, power-cut, systemd, network, or 72-hour soak gates.

`commission` produces a single point-in-time acceptance report covering release
and rollback readiness, systemd state, health/PLC/clock/storage, the OPC UA
doctor, and edge verification. Run it after installation, every reboot,
certificate or firewall change, and rollback. Immediately after reboot, add
`--max-uptime-seconds 600` to prove the Gateway process restarted. Preserve the
JSON report with the release ID and configuration change record. A skipped
doctor or edge gate is a warning and fails `--strict`.

On the target Pi, execute the staged drill in Section 5.3 to bind the signed
install, boot-ID change, edge-certificate fingerprint change, and rollback into
one checksummed evidence bundle. A successful drill is required before pilot
exit, but it does not replace the 72-hour soak or physical power-cut test.

### 8.2 Hardware and Field Gates

The software gates are not a field acceptance. The following remain mandatory
before declaring the pilot production-ready:

- A passing strict hardware report on the target Pi with a clean boot, no
  under-voltage/throttling flags, acceptable temperature, synchronized NTP, and
  sufficient storage headroom.
- 72-hour soak with API load, quality ingestion, fault injection, reconnect
  cycles, retention, log-budget checks, and temperature/under-voltage sampling
  on the target Pi.
- Commissioning reports after install, reboot, power-cut recovery, certificate
  rotation, upgrade, and rollback, with all strict gates passing.
- Verified NTP behavior and clock-failure degradation on the target network.
- Physical power-cut and disk-full recovery tests on the target storage.
- Install, upgrade, automatic rollback, explicit rollback, and state restore on
  actual Raspberry Pi hardware, preferably through the staged `field:drill`
  evidence chain.
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
diff, release-signing public-key fingerprint, commissioning JSON reports,
validation evidence, incidents, SBOM review result, accepted-event counts, OEE
reconciliation, open risks, and sign-off from the production, PLC, Gateway,
security, and QA/MES owners.
