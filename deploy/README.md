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
- `OEE_NOMINAL_OUTPUT_PER_MIN` or `OEE_IDEAL_CYCLE_TIME_MS`, planned time, and
  quality-event connectivity must be validated before quoting OEE as a
  production metric. When `OEE_PRODUCT_CYCLE_TIMES` is used, validate every
  configured SKU value and confirm the runtime `GATEWAY_PRODUCT_ID` / PLC
  product context matches the SKU actually running; missing or unmapped
  products fall back with an explicit data-quality warning.
