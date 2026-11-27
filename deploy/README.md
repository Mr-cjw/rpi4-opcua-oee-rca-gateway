# Raspberry Pi Gateway Deployment

The unit assumes the repository is installed at
`/opt/rpi4-opcua-oee-rca-gateway` and runs as the `rpi4-gateway` user.

```bash
sudo useradd --system --home /var/lib/rpi4-gateway --shell /usr/sbin/nologin rpi4-gateway
sudo mkdir -p /opt/rpi4-opcua-oee-rca-gateway
# Copy or clone the repository into /opt/rpi4-opcua-oee-rca-gateway first.
cd /opt/rpi4-opcua-oee-rca-gateway
sudo npm ci --omit=dev

sudo install -m 0644 deploy/rpi4-gateway.service /etc/systemd/system/rpi4-gateway.service
sudo install -m 0600 deploy/rpi4-gateway.env.example /etc/rpi4-gateway.env
sudo editor /etc/rpi4-gateway.env

sudo systemctl daemon-reload
sudo systemctl enable --now rpi4-gateway.service
sudo systemctl status rpi4-gateway.service --no-pager
curl http://127.0.0.1:8080/healthz
```

Before starting or restarting a real-PLC deployment, run the commissioning
doctor with the production environment file loaded:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; npm run doctor'
```

Use `npm run doctor -- --json` to archive the report or `--strict` in change
control when warnings must block commissioning. The doctor only reads the PLC.

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

### State backup and restore

Stop the service before backup or restore so JSONL, the idempotency ledger, and
work-context state form a consistent snapshot. The backup command uses the
production environment file and writes a checksummed manifest beside the copied
state files:

```bash
sudo systemctl stop rpi4-gateway.service
sudo install -d -o rpi4-gateway -g rpi4-gateway -m 0750 /var/backups/rpi4-gateway
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway && npm run state:backup -- --output /var/backups/rpi4-gateway/20261127T120000'
sudo systemctl start rpi4-gateway.service
curl http://127.0.0.1:8080/healthz
```

Verify the backup before moving it off the Pi, and periodically test a restore
on a spare directory or device:

```bash
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway && npm run state:verify -- --backup /var/backups/rpi4-gateway/20261127T120000'
```

To restore, stop the service and use `--force` only after confirming the target
state directory and backup timestamp. Restore verifies every checksum first,
stages all files, and atomically replaces each destination:

```bash
sudo systemctl stop rpi4-gateway.service
sudo -u rpi4-gateway sh -c 'set -a; . /etc/rpi4-gateway.env; set +a; cd /opt/rpi4-opcua-oee-rca-gateway && npm run state:restore -- --backup /var/backups/rpi4-gateway/20261127T120000 --force'
sudo systemctl start rpi4-gateway.service
curl http://127.0.0.1:8080/healthz
```

The backup excludes OPC UA PKI private keys and certificates; back those up
through the certificate procedure. Files in the state directory that are not
listed in the manifest remain untouched, so inspect stale rotated segments
after restoring an older snapshot.

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

For `bad_status` or `uncertain_status`, check the PLC point, NodeId, access
permissions, and vendor diagnostics before restarting the Gateway. For
`stale_value`, compare `plc_value_age_seconds` and the source timestamp with the
PLC scan/change cadence; a static tag can be reported stale because data-change
subscriptions may suppress unchanged values. `alarmEvents` is exempt from stale
checking. Do not increase `GATEWAY_PLC_STALE_WARNING_MS` without confirming that
the tag is expected to remain quiet. For clock issues, synchronize both the Pi
and PLC clocks and verify the configured skew threshold.

## Operational notes

- Keep `GATEWAY_HTTP_HOST=127.0.0.1` unless a reverse proxy and network policy
  are in place. Set `GATEWAY_API_TOKEN` if the API is reachable beyond loopback.
- Use a secured OPC UA endpoint for a real PLC. `None` security is for isolated
  mock/testing only.
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
