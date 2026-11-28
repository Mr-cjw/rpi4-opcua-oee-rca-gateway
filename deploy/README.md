# Raspberry Pi Gateway Deployment

The unit runs an immutable release through
`/opt/rpi4-opcua-oee-rca-gateway/current` as the `rpi4-gateway` user. Production
installs should use a verified release archive rather than editing the live
version in place. The host requires Node.js 22.13.0 or newer; the release
installer rejects an older runtime from its manifest.

For field work, pair this guide with the
[pilot runbook](../docs/PILOT-RUNBOOK.md), [known limitations](../docs/KNOWN-LIMITATIONS.md),
[security review](../docs/SECURITY-REVIEW.md), and
[release key management](../docs/RELEASE-KEY-MANAGEMENT.md).

Transfer the release archive, its `.sha256` and `.sig` files, the approved
public key, and the approved trust policy together. Never transfer the signing
private key to the Pi.

```bash
sudo useradd --system --home /var/lib/rpi4-gateway --shell /usr/sbin/nologin rpi4-gateway
cd /var/tmp
sha256sum -c <archive>.tar.gz.sha256
sudo install -d -m 0755 /etc/rpi4-gateway
sudo install -m 0644 /var/tmp/release-public.pem /etc/rpi4-gateway/release-public.pem
sudo install -m 0644 /var/tmp/release-trust-policy.json \
  /etc/rpi4-gateway/release-trust-policy.json
sudo install -d -m 0755 /opt/rpi4-gateway-bootstrap
sudo tar -xzf /var/tmp/<archive>.tar.gz -C /opt/rpi4-gateway-bootstrap
sudo /usr/bin/node /opt/rpi4-gateway-bootstrap/scripts/gateway-release.js verify-signature \
  --archive /var/tmp/<archive>.tar.gz \
  --signature /var/tmp/<archive>.tar.gz.sig \
  --public-key /etc/rpi4-gateway/release-public.pem \
  --signer-fingerprint <approved-public-key-sha256> \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-policy-sequence>
sudo install -m 0644 /opt/rpi4-gateway-bootstrap/deploy/rpi4-gateway.service /etc/systemd/system/rpi4-gateway.service
sudo install -m 0600 /opt/rpi4-gateway-bootstrap/deploy/rpi4-gateway.env.example /etc/rpi4-gateway.env
sudo editor /etc/rpi4-gateway.env

sudo systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/rpi4-gateway.service
sudo /usr/bin/node /opt/rpi4-gateway-bootstrap/scripts/gateway-release.js install \
  --archive /var/tmp/<archive>.tar.gz \
  --checksum /var/tmp/<archive>.tar.gz.sha256 \
  --signature /var/tmp/<archive>.tar.gz.sig \
  --public-key /etc/rpi4-gateway/release-public.pem \
  --signer-fingerprint <approved-public-key-sha256> \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-policy-sequence> \
  --require-signature \
  --release-root /opt/rpi4-opcua-oee-rca-gateway
sudo systemctl enable --now rpi4-gateway.service
sudo systemctl status rpi4-gateway.service --no-pager
curl http://127.0.0.1:8080/healthz
sudo rm -rf /opt/rpi4-gateway-bootstrap
```

Before starting or restarting a real-PLC deployment, run the commissioning
doctor with the production environment file loaded:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; npm run doctor'
```

Use `npm run doctor -- --json` to archive the report or `--strict` in change
control when warnings must block commissioning. The doctor only reads the PLC.

### OPC UA security, credentials, and certificates

The example environment targets `SignAndEncrypt` with `Basic256Sha256` and sets
`OPCUA_TRUST_UNKNOWN_CERTIFICATES=false`. With `NODE_ENV=production`, the
Gateway refuses to start with `None` security or automatic unknown-certificate
trust unless `GATEWAY_ALLOW_INSECURE_OPCUA=true` is explicitly set for an
isolated test deployment.

Store credentials in files readable only by the service account instead of
inline environment values:

```bash
sudo install -d -o rpi4-gateway -g rpi4-gateway -m 0750 /etc/rpi4-gateway
sudo -u rpi4-gateway sh -c 'umask 077; printf "%s\n" "replace-with-opcua-user" > /etc/rpi4-gateway/opcua-user'
sudo -u rpi4-gateway sh -c 'umask 077; printf "%s\n" "replace-with-opcua-password" > /etc/rpi4-gateway/opcua-password'
```

Set `OPCUA_USERNAME_FILE=/etc/rpi4-gateway/opcua-user` and
`OPCUA_PASSWORD_FILE=/etc/rpi4-gateway/opcua-password`. Confirm
`stat -c '%a %U:%G %n' /etc/rpi4-gateway/opcua-*` reports mode `600` and the
Gateway service owner. Never put production passwords in Git, shell history, or
the JSONL logs.

Provision the PLC certificate under
`$OPCUA_CLIENT_PKI_ROOT/gateway-client/trusted/certs/`. A rejected certificate
appears under `rejected/certs/`; compare its SHA-256 fingerprint with the PLC
commissioning record before moving only that file into `trusted/certs/` and
removing the obsolete certificate. Then run:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run doctor -- --strict'
sudo systemctl restart rpi4-gateway.service
curl http://127.0.0.1:8080/healthz
```

Certificate trust is loaded at Gateway startup, so a PLC certificate rotation
requires restarting the service after updating the trust folder. Back up the
Gateway client certificate/key and the trusted PLC certificate off the Pi using
an approved encrypted process; they are excluded from ordinary state backups.
For managed PKI, set both `OPCUA_CLIENT_CERTIFICATE_FILE` and
`OPCUA_CLIENT_PRIVATE_KEY_FILE` in the environment file.

The service uses `StateDirectory=rpi4-gateway`, so `/var/lib/rpi4-gateway` is
created with the service user's ownership. JSONL logs and the OPC UA client PKI
directory live there. Runtime work order/SN/correlation/product updates are
persisted to `/var/lib/rpi4-gateway/work-context.json` and restored on restart.
Quality source-event IDs live in `/var/lib/rpi4-gateway/quality-idempotency.json`,
with a seven-day and 100,000-entry default horizon. The repository `data/`
directory is also writable for development runs.

Keep `GATEWAY_STORAGE_DISK_PATH` pointed at this state directory. The example
environment file warns below 100 MiB free and marks storage critical below
32 MiB. `GET /healthz` reports the resolved path, free/total bytes, disk usage,
and per-component write failures; `GET /metrics` exports the same storage state.
Size the thresholds for JSONL rotation, the idempotency ledger, and atomic
temporary files, not only for the current log sizes.

### Remote access and TLS termination

The Gateway does not terminate TLS and must remain on `127.0.0.1:8080`. For
approved remote access, install the nginx template and follow the complete
installation, authentication, firewall, certificate-rotation, and log-retention
procedure in [`nginx/README.md`](nginx/README.md).

Before enabling the edge, confirm:

- `GATEWAY_API_TOKEN` is unique, high-entropy, and stored in the protected
  environment file.
- The site PKI issued a certificate for the exact Gateway DNS name; the private
  key is root-owned, mode `0600`, and is not in Git or a release archive.
- nginx listens on 443 and proxies only to `http://127.0.0.1:8080`; there is no
  external 8080 listener.
- `/healthz` remains loopback-only or is restricted to an approved monitoring
  subnet. `/v1/*` and `/metrics` require the application bearer token.
- TLS 1.2/1.3 succeed, older protocols fail, HTTP redirects to HTTPS, and the
  edge applies request-body, rate, and concurrency limits.
- The site approved mTLS, Basic Auth, or HTTPS plus bearer token as the operator
  authentication baseline. Basic Auth must carry the application token in a
  separate header rather than reusing `Authorization`.
- Access logs use the supplied format and bounded retention; they never include
  authorization headers, cookies, tokens, or request bodies.
- HSTS remains disabled until the site confirms permanent HTTPS for the DNS name.

Minimal validation after installation:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo ss -lntp | rg '(:443|:8080)'
curl --fail http://127.0.0.1:8080/healthz
sudo sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run edge:verify -- --url https://<gateway-name> --origin-url http://127.0.0.1:8080 --strict'
```

The verifier reads `GATEWAY_API_TOKEN` from the sourced environment or from a
mode-`0600` `--token-file`. It validates the certificate without an insecure
override, tests TLS 1.2/1.3, checks the redirect and security headers, verifies
anonymous `/metrics` and `/v1` rejection plus authenticated access, and probes
unknown-path handling. Add `--ca-file` for a private CA or client-certificate
options for mTLS. Archive `--json` output in the commissioning record.

For a consolidated post-install, post-reboot, or post-rollback acceptance record,
run the commission command as the service user:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run commission -- \
    --url https://gateway.example.invalid \
    --origin-url http://127.0.0.1:8080 \
    --strict --json \
    --output "/var/lib/rpi4-gateway/commissioning-$(date -u +%Y%m%dT%H%M%SZ).json"'
```

The report aggregates release/rollback status, systemd state, health, PLC,
clock, storage, OPC UA doctor, and edge checks. It is written with mode `0600`
and refuses to overwrite an existing report unless `--force` is supplied. Add
`--max-uptime-seconds 600` immediately after reboot to prove the Gateway process
restarted within that window. `--skip-doctor` and `--skip-edge` are partial
diagnostics only: the resulting warnings make `--strict` exit non-zero. Strict
acceptance also requires a previous release as the rollback target.

Record the host hardware baseline before accepting the Pi:

```bash
sudo sh -c 'cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run hardware:check -- \
    --storage-path /var/lib/rpi4-gateway \
    --strict --json \
    --output "/var/backups/rpi4-gateway/hardware-$(date -u +%Y%m%dT%H%M%SZ).json"'
```

The report covers the Pi model and 64-bit runtime, CPU temperature,
under-voltage/throttling flags, firmware/voltage telemetry, NTP state, and free
space. `vcgencmd` must be installed for power/thermal evidence; if it is missing,
the report warns and `--strict` exits non-zero. The output is mode `0600` and
refuses to overwrite an existing file unless `--force` is supplied. This is a
point-in-time acceptance check, not continuous host monitoring.

For a staged hardware drill, use one protected state directory across the
phases. Run the drill as root because install and rollback restart systemd
services; the state directory and evidence files are created mode `0700` and
`0600`. Preflight and post-reboot also run the strict Pi hardware check against
`/var/lib/rpi4-gateway` by default; use `--storage-path` for a different state
filesystem. `--skip-hardware` is for partial diagnostics and leaves a warning
in the evidence bundle. The command deliberately does not reboot the Pi or
rotate certificates.

```bash
sudo sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; \
  cd /opt/rpi4-opcua-oee-rca-gateway/current && \
  npm run field:drill -- \
    --state-dir /var/lib/rpi4-gateway/field-drill-20261128T120000Z \
    --phase preflight \
    --archive /var/tmp/<release>.tar.gz \
    --require-signature \
    --public-key /etc/rpi4-gateway/release-public.pem \
    --state-backup /var/backups/rpi4-gateway/20261128T120000Z \
    --url https://gateway.example.invalid --json'
```

Then run `install --execute`, `post-install`, reboot the host, run
`post-reboot`, rotate and verify the edge certificate, run `rotation-after`, and
finish with `rollback --execute`. The rollback phase auto-finalizes
`drill-manifest.json` and `SHA256SUMS`. Follow the full sequence and evidence
handling in [the pilot runbook](../docs/PILOT-RUNBOOK.md#53-staged-release-and-certificate-drill).

### Clock synchronization

Production OEE and RCA timestamps must use a synchronized Pi clock. The example
environment sets `GATEWAY_CLOCK_SYNC_REQUIRED=true`, so a missing or
unsynchronized NTP source degrades `/healthz`. Enable and verify systemd time
synchronization before starting the Gateway:

```bash
sudo timedatectl set-ntp true
timedatectl status
timedatectl show --property=NTPSynchronized --value
curl -s http://127.0.0.1:8080/healthz | jq '.clock'
curl -s http://127.0.0.1:8080/metrics | rg 'rpi4_gateway_clock_'
```

The monitor uses `timedatectl` and falls back to `chronyc -n tracking`. It
samples every `GATEWAY_CLOCK_SYNC_CHECK_INTERVAL_MS`, warns when the latest
check is older than `GATEWAY_CLOCK_SYNC_MAX_AGE_MS`, and warns when the reported
offset exceeds `GATEWAY_CLOCK_SYNC_MAX_OFFSET_MS`. If the provider is
unavailable, `/healthz.clock.status` is `unknown`. Resolve NTP reachability and
service status instead of setting `GATEWAY_CLOCK_SYNC_REQUIRED=false` in a
production deployment.

### State backup and restore

Stop the service before backup or restore so JSONL, the idempotency ledger, and
work-context state form a consistent snapshot. The backup command uses the
production environment file and writes a checksummed manifest beside the copied
state files:

```bash
sudo systemctl stop rpi4-gateway.service
sudo install -d -o rpi4-gateway -g rpi4-gateway -m 0750 /var/backups/rpi4-gateway
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run state:backup -- --output /var/backups/rpi4-gateway/20261127T120000'
sudo systemctl start rpi4-gateway.service
curl http://127.0.0.1:8080/healthz
```

Verify the backup before moving it off the Pi, and periodically test a restore
on a spare directory or device:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run state:verify -- --backup /var/backups/rpi4-gateway/20261127T120000'
```

To restore, stop the service and use `--force` only after confirming the target
state directory and backup timestamp. Restore verifies every checksum first,
stages all files, and atomically replaces each destination:

```bash
sudo systemctl stop rpi4-gateway.service
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run state:restore -- --backup /var/backups/rpi4-gateway/20261127T120000 --force'
sudo systemctl start rpi4-gateway.service
curl http://127.0.0.1:8080/healthz
```

The backup excludes OPC UA PKI private keys and certificates; back those up
through the certificate procedure. Files in the state directory that are not
listed in the manifest remain untouched, so inspect stale rotated segments
after restoring an older snapshot.

### Versioned releases and rollback

The release root contains immutable `releases/<release-id>` directories,
`current` and `previous` symlinks, and `last-release.json`. The installer
verifies the archive checksum and optional required signature, installs
production dependencies in staging, atomically switches `current`, restarts the
service, and checks `/healthz`. A failed health check automatically restores the
previous release.

Release signing and verification use a detached `<archive>.tar.gz.sig` file.
Sign on a trusted administrative host with `npm run release:sign -- --archive
<archive> --private-key <private-key.pem>` and verify before transfer with
`npm run release:verify-signature -- --archive <archive> --public-key
<public-key.pem>`. Keep the private key off the Pi. Production installs must
pass `--require-signature` and use the approved trust policy with
`--signer-fingerprint`, `--policy-sha256`, and `--minimum-policy-sequence`; the
verified public-key fingerprint, policy digest, policy sequence, signer name,
and signer status are recorded in `last-release.json`. Follow the
[release key-management procedure](../docs/RELEASE-KEY-MANAGEMENT.md) for
rotation and revocation.

Each release also embeds a CycloneDX 1.5 `sbom.cdx.json` covering production
dependencies. It is included in the manifest checksums and the signed archive.
Extract a sidecar from the verified archive when a downstream review system needs
one:

```bash
npm run release:sbom -- \
  --archive /var/tmp/<archive>.tar.gz \
  --output /var/tmp/<release>.sbom.cdx.json
```

Upgrade procedure:

```bash
sudo systemctl stop rpi4-gateway.service
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run state:backup -- --output /var/backups/rpi4-gateway/20261128T120000'
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway/current && npm run state:verify -- --backup /var/backups/rpi4-gateway/20261128T120000'
sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js install \
  --archive /var/tmp/<archive>.tar.gz \
  --checksum /var/tmp/<archive>.tar.gz.sha256 \
  --signature /var/tmp/<archive>.tar.gz.sig \
  --public-key /etc/rpi4-gateway/release-public.pem \
  --signer-fingerprint <approved-public-key-sha256> \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-policy-sequence> \
  --require-signature \
  --release-root /opt/rpi4-opcua-oee-rca-gateway \
  --state-backup /var/backups/rpi4-gateway/20261128T120000
curl http://127.0.0.1:8080/healthz
```

Inspect or roll back the code:

```bash
sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js status \
  --release-root /opt/rpi4-opcua-oee-rca-gateway
sudo /usr/bin/node /opt/rpi4-opcua-oee-rca-gateway/current/scripts/gateway-release.js rollback \
  --release-root /opt/rpi4-opcua-oee-rca-gateway
```

Code rollback does not modify `/var/lib/rpi4-gateway`. If a future release note
declares a state-format migration, stop the service, restore the verified
pre-upgrade backup with the state restore command, then run the code rollback so
the old release starts only after its data format is restored. Keep the failed
release directory and `last-release.json` for diagnosis until the incident is
closed.

### Live PLC diagnostics and alerts

After startup, inspect the live PLC view before trusting OEE or RCA output:

```bash
curl -s http://127.0.0.1:8080/healthz | jq '.plc'
curl -s http://127.0.0.1:8080/metrics | rg 'rpi4_gateway_plc_'
```

Recommended alerting baseline:

- Page on `rpi4_gateway_opcua_connected == 0` or
  `rpi4_gateway_plc_bad_values > 0`; these are critical PLC-path failures.
- Warn on `rpi4_gateway_plc_diagnostics_healthy == 0` after a short grace
  period, and inspect `.plc.variables[].issues` to separate bad, uncertain,
  stale, missing-timestamp, future-timestamp, and clock-skew cases.
- Alert on a reconnect-rate increase, a growing
  `rpi4_gateway_plc_current_disconnect_gap_seconds`, or
  `rpi4_gateway_plc_event_subscription_healthy == 0`. Event-subscription loss
  still allows value collection but means native alarm events are missing.
- Page on `rpi4_gateway_clock_sync_healthy == 0` when
  `rpi4_gateway_clock_sync_required == 1`; check `rpi4_gateway_clock_sync_known`
  and `.clock.reason` to distinguish NTP loss, excessive offset, a stale check,
  and an unavailable provider.

For `bad_status` or `uncertain_status`, check the PLC point, NodeId, access
permissions, and vendor diagnostics before restarting the Gateway. For
`stale_value`, compare `plc_value_age_seconds` and the source timestamp with the
PLC scan/change cadence. Keep `OPCUA_DATA_CHANGE_TRIGGER=StatusValueTimestamp`
when the PLC advances source timestamps on each scan. If you change it to
`StatusValue` to reduce traffic, unchanged static tags may legitimately report
stale. `alarmEvents` is a change-driven snapshot and is exempt from stale and
source/server skew checks. Do not increase
`GATEWAY_PLC_STALE_WARNING_MS` without confirming that the tag is expected to
remain quiet. For clock issues, synchronize both the Pi and PLC clocks and verify
the configured skew threshold.

## Operational notes

- Verify `node --version` reports `v22.13.0` or newer before installing or
  rolling back a release.
- Keep `GATEWAY_HTTP_HOST=127.0.0.1` even when nginx terminates TLS. For remote
  access, use the approved [nginx template](nginx/README.md), keep
  `GATEWAY_API_TOKEN` enabled, and expose only the proxy port to approved
  networks.
- Use a secured OPC UA endpoint for a real PLC. `None` security is for isolated
  mock/testing only; `NODE_ENV=production` rejects it unless the explicit
  insecure override is set.
- Keep unknown server certificates untrusted. Update the Gateway trust folder
  from the PLC commissioning record and restart the service after rotation.
- Run `npm run e2e:security` after changing security modes, policies,
  credentials, or certificate-trust handling.
- Run `npm run security:audit` and `npm audit` before every field release. CI
  blocks high/critical production advisories, but audit results are
  point-in-time and still require review.
- The Gateway only reads PLC points. It does not write controls.
- Run `npm run doctor` after every NodeId, credential, certificate, or PLC
  firmware change. A failed result should block production cutover.
- JSONL logs are replayed at startup and rotate by size. The default maximum is
  10 MiB per file with three retained backups; tune
  `PROCESS_CONTEXT_LOG_MAX_*` and `QUALITY_EVENT_LOG_MAX_*` to the available SD
  card or SSD budget.
- A storage warning degrades `/healthz` before the disk is full. If the quality
  JSONL can no longer be appended, `POST /v1/quality-events` returns `503` and
  the caller must retry with the same `sourceEventId`; do not treat the event as
  accepted until a success response arrives. Free space and replace/expand the
  state volume before restarting the service.
- A critical `plc` diagnostic means the latest PLC snapshot may be incomplete.
  Do not treat OEE/RCA output as production truth until the connection recovers
  and `rpi4_gateway_plc_diagnostics_healthy` returns to `1`.
- Run `npm run e2e:diagnostics` after changing the OPC UA trigger, stale/skew
  thresholds, or subscription timing; it exercises the injected PLC fault path.
- Run `npm run e2e:clock` after changing NTP detection, clock thresholds, or
  health-degradation behavior.
- Build and verify a release archive before every Pi upgrade, retain the prior
  verified archive and state backup, and exercise a rollback during change
  control rather than only after a failed field upgrade.
- The systemd unit removes capabilities and applies filesystem, device, kernel,
  hostname, IPC, realtime, and address-family restrictions. Re-run
  `systemd-analyze verify` after any unit edit and test the service on the target
  OS image; sandboxing is not a substitute for OS/SSH hardening.
- Keep at least one recent verified state backup off the Raspberry Pi. A
  backup stored on the same failing SD card or SSD does not protect accepted
  quality events after hardware loss.
- After a forced kill or power loss, check the log for
  `Isolated a partial JSONL record before appending`. Complete records replay
  normally; the interrupted record is skipped and a resulting event-sequence
  gap remains visible in `/healthz` and Prometheus.
- Keep `QUALITY_EVENT_LOG_FSYNC=true` in production so an accepted NG event has
  crossed the disk barrier before the API responds. Process-context sync is
  disabled by default to limit SD-card write amplification; enable
  `PROCESS_CONTEXT_LOG_FSYNC` when losing the newest sample after power loss is
  not acceptable.
- `OEE_NOMINAL_OUTPUT_PER_MIN` or `OEE_IDEAL_CYCLE_TIME_MS`, planned time, and
  quality-event connectivity must be validated before quoting OEE as a
  production metric. When `OEE_PRODUCT_CYCLE_TIMES` is used, validate every
  configured SKU value and confirm the runtime `GATEWAY_PRODUCT_ID` / PLC
  product context matches the SKU actually running; missing or unmapped
  products fall back with an explicit data-quality warning.
