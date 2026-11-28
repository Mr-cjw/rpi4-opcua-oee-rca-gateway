# Known Limitations

Status date: 2026-11-28

This document records the boundaries of the current pilot release. A limitation
is not automatically a defect; it becomes a release blocker when the intended
deployment depends on behavior the Gateway does not provide.

## Operational Scope

- One Gateway process represents one station and one line context. Multi-line
  orchestration requires separate isolated instances until a proven design
  exists.
- There is no active/standby Gateway, clustering, leader election, or automatic
  failover. Losing the Pi stops collection for that station until service is
  restored.
- The Gateway is read-only. It does not provide closed-loop control, safety
  interlocks, recipe management, or PLC writes.
- There is no built-in MES, ERP, historian, scheduling, or QA disposition
  system. Downstream systems remain responsible for their own durability and
  business rules.
- RCA reports time-window candidates and evidence. It does not prove causation,
  and it can miss an actual cause that is outside the selected window or not
  represented in collected data.
- OEE is only as correct as the configured shift calendar, cycle time, counter
  mapping, product identity, and quality-event feed. Invalid assumptions are
  surfaced as warnings, not silently corrected.

## PLC and OPC UA Integration

- The Gateway connects to one OPC UA endpoint with one configured security mode,
  policy, account, and certificate trust store. There is no endpoint failover,
  redundant session, or OPC UA redundancy support.
- Certificate trust is manual. A PLC certificate rotation requires updating the
  trust store and restarting the Gateway; there is no zero-downtime rotation or
  automatic certificate enrollment.
- Trust is performed against the local PKI store. There is no integrated PKI,
  OCSP/CRL service, HSM, or certificate lifecycle automation.
- The OPC UA username/password is a single integration credential. There is no
  per-user attribution or role-based access control on the PLC connection.
- Vendor-specific diagnostics are not interpreted. The Gateway surfaces OPC UA
  status codes, timestamps, and configured-point health, but cannot replace the
  PLC engineering tool.
- A subscription or reconnect gap is recorded as evidence, but data that was
  never delivered by the PLC cannot be reconstructed.
- Source-timestamp quality depends on the PLC. The Gateway warns about bad,
  uncertain, stale, future-dated, and clock-skewed values; it does not correct
  the PLC clock or rewrite timestamps.
- PLC counter resets are detected and preserve observed production by summing
  observed counter epochs, but production hidden inside an unobserved reset
  cannot be recovered.

## Local Storage and Retention

- JSONL is a bounded local evidence log, not a historian. Retention is governed
  by configured time, entry-count, byte, and rotation limits; older records are
  intentionally removed.
- There is no central durable queue. If the Pi storage is unavailable or the
  process is lost before a write is accepted, data can be lost.
- Quality ingestion is fail-closed: a `503` means the event was not accepted.
  Callers must retry with the same `sourceEventId`. There is no durable outbox
  inside the Gateway for downstream QA/MES delivery.
- By default quality-event appends are fsynced before success, while
  process-context appends are buffered to reduce SD-card wear. A power loss can
  therefore lose the newest process-context sample unless
  `PROCESS_CONTEXT_LOG_FSYNC=true` is configured.
- State backups are checksummed but not encrypted. They can contain work-order,
  serial-number, correlation, and quality-event data and must be protected and
  transferred using an approved process.
- State backup is an offline operation. Stop the service so JSONL, idempotency,
  and work-context state form a consistent snapshot; there is no online
  point-in-time database backup.
- JSONL and the idempotency ledger are not encrypted at rest. File-system
  permissions and host access control are the only local protections.
- SD-card endurance, filesystem corruption, and power-loss behavior must be
  validated on the target hardware. A successful development-host test is not a
  Raspberry Pi storage qualification.
- SQLite WAL is evaluated but not enabled. JSONL remains the only authoritative
  event store in this release.

## HTTP API and Security

- The HTTP API is plain HTTP. It has no built-in TLS, client certificate
  authentication, or IP allowlist. Remote access requires the supplied nginx
  template or an equivalent site-approved reverse proxy; keeping the Gateway on
  loopback is still required.
- The application has no built-in rate limiting or request concurrency limit.
  The supplied edge template adds baseline per-source limits, but it is not a
  WAF or DDoS protection service and must be tuned and monitored by the site.
  Request bodies are limited to 1 MiB at both layers.
- Authentication is a single optional bearer token. There is no user directory,
  RBAC, per-operator audit trail, token expiry, or online token revocation.
- `/healthz` is intentionally unauthenticated. Other endpoints and `/metrics`
  are authenticated only when `GATEWAY_API_TOKEN` is configured.
- Binding to `127.0.0.1` is mandatory guidance for direct deployments, not a
  network security boundary. Remote access requires an approved reverse proxy
  with TLS, authentication, rate limiting, and access logging.
- The nginx template is a configuration baseline, not an approved deployment.
  DNS, certificate ownership, source networks, edge authentication, firewall,
  log retention, and incident handling remain site-specific approvals.
- mTLS and Basic Auth are optional edge controls. If neither is enabled, the
  shared application bearer token over HTTPS is the only operator
  authentication control. Basic Auth must not reuse `Authorization` as the
  application token.
- HSTS is disabled in the template. Enabling it before HTTPS is permanent can
  make rollback and client recovery difficult.
- The reverse proxy does not provide per-user authorization, token expiry,
  online revocation, a WAF, DDoS protection, HA, or automatic failover.
- The edge verifier can confirm TLS 1.2/1.3 and certified connectivity, but it
  cannot make a Node/OpenSSL client initiate TLS 1.1 when the runtime disables
  that protocol. It reports this as a skip; static configuration review and an
  approved external TLS scanner remain required.
- The commissioning report is a point-in-time aggregation. It does not replace
  the 72-hour soak, physical power-cut and disk-full tests, long-duration data
  reconciliation, or real PLC certificate-rotation drills.
- The staged field drill verifies a host boot-ID change and the edge certificate
  served after an operator-controlled rotation. It does not reboot the Pi,
  install certificates, prove power-loss recovery, or exercise PLC certificate
  rotation automatically. Its root-only state and evidence directory must be
  copied off the device and reviewed after the maintenance window.
- Credentials are read from environment variables or files. The application
  validates presence and readability, but does not enforce file ownership or
  mode. Operators must enforce `0600` files and a protected environment file.
- There is no secrets manager, automatic credential rotation, HSM integration,
  or encrypted environment store. Root and the service account can read the
  configured secrets.
- Application logs are structured and bounded, but can contain business
  identifiers and process data. They are not encrypted, tokenized, or shipped to
  a SIEM by the Gateway.
- The systemd sandbox reduces privilege but does not harden the operating system,
  SSH service, boot chain, firmware, or physical access.

## Release and Supply Chain

- Releases are immutable and integrity-checked with SHA-256 manifests. Detached
  SHA-256 signatures can be required during installation, but the default
  installation path remains unsigned for backward compatibility. Production
  approval must require `--require-signature` and protect the release public key.
- Signing-key generation, offline custody, rotation, revocation, HSM/KMS use, and
  public-key distribution are manual. There is no built-in OTA signing service
  or automatic trust-store update.
- The embedded CycloneDX SBOM is a dependency inventory generated from the
  production lockfile. It is not a vulnerability report, VEX statement, license
  legal opinion, or proof that optional platform-specific dependencies were
  exercised on a Raspberry Pi.
- There is no automatic over-the-air update service. Installation and rollback
  are operator-driven systemd operations.
- `npm ci --omit=dev` requires either network access to the approved registry or
  a pre-populated package cache for an offline site.
- Dependency audit results are a point-in-time signal, not a guarantee. The
  release process must rerun the audit and review advisories before each field
  deployment.
- Rollback restores code and the `current`/`previous` links. It does not undo a
  state-format migration unless the release note explicitly defines one and the
  verified pre-upgrade state backup is restored.

## Observability and Operations

- The Gateway emits metrics but does not include an alert router. A separate
  Prometheus-compatible scraper and alerting system are required for paging.
- There is no built-in dashboard, log shipping, trace correlation backend, or
  remote support channel.
- `/metrics` and `/healthz` report the Gateway's view of the process. They do not
  prove that a PLC value is physically correct or that the downstream QA/MES
  system has durably accepted a record.
- The Gateway does not monitor its own host power quality, enclosure
  temperature, SD/SSD wear indicators, or physical tamper state continuously.
  `npm run hardware:check` provides a point-in-time Pi temperature,
  under-voltage/throttling, firmware, NTP, and storage report, but it cannot
  prove power quality over time, read SD/SSD endurance registers, or replace
  external power and thermal monitoring.
- Clock-sync checks depend on available `timedatectl`/`chronyc`/project-specific
  providers. A missing provider produces an explicit unknown/degraded state, not
  an estimate.

## Hardware and Field Validation Still Outstanding

The software suite is not a field qualification. The following gates remain
open for the Raspberry Pi pilot:

- 72-hour soak with fault injection, reconnect cycles, storage pressure, and API
  load on the target hardware.
- Strict Pi hardware-readiness reports before and after the soak, including a
  clean reboot after any historical under-voltage/throttling flag.
- Physical power-cut and forced-kill recovery on the target SD card/SSD.
- Disk-full and storage-I/O-failure behavior at the configured thresholds.
- NTP loss, offset, and recovery validation on the plant network.
- Release install, upgrade, automatic rollback, explicit rollback, and state
  restore on an actual Raspberry Pi, including a completed staged field drill
  with signed release, reboot, edge-certificate rotation, and rollback evidence.
- Real PLC certificate rotation and rejected-certificate handling.
- Long-duration event-sequence and quality-idempotency validation against the
  production QA/MES retry behavior.

See [the pilot runbook](PILOT-RUNBOOK.md) and [roadmap](ROADMAP.md) for the
acceptance process.
