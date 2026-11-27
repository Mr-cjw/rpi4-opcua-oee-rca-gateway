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

The service uses `StateDirectory=rpi4-gateway`, so `/var/lib/rpi4-gateway` is
created with the service user's ownership. JSONL logs and the OPC UA client PKI
directory live there. The repository `data/` directory is also writable for
development runs.

## Operational notes

- Keep `GATEWAY_HTTP_HOST=127.0.0.1` unless a reverse proxy and network policy
  are in place. Set `GATEWAY_API_TOKEN` if the API is reachable beyond loopback.
- Use a secured OPC UA endpoint for a real PLC. `None` security is for isolated
  mock/testing only.
- The Gateway only reads PLC points. It does not write controls.
- JSONL logs are replayed at startup and are not rotated automatically. Add a
  logrotate policy or truncate them during planned maintenance after validating
  retention requirements.
- `OEE_NOMINAL_OUTPUT_PER_MIN`, planned time, and quality-event connectivity must
  be validated before quoting OEE as a production metric.
