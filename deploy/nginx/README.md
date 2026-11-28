# Raspberry Pi Gateway Remote TLS Reverse Proxy

The Gateway application does not terminate TLS. For remote access, an approved
nginx instance on the Pi terminates TLS and proxies only to the loopback HTTP
API. This keeps the application bound to `127.0.0.1:8080` while giving the site a
single, reviewable network edge.

This guide is a baseline, not a substitute for the site's network, PKI, and
security approval. The supplied files are templates:

- [`rpi4-gateway.conf`](rpi4-gateway.conf) is the nginx `conf.d` snippet.
- [`rpi4-gateway.logrotate`](rpi4-gateway.logrotate) retains bounded edge logs.

## Security Boundary

The template is designed to fail closed:

- nginx exposes 443 and redirects HTTP on 80 to HTTPS.
- `proxy_pass` targets only `http://127.0.0.1:8080`; the Gateway must remain
  bound to `GATEWAY_HTTP_HOST=127.0.0.1`.
- TLS 1.2 and 1.3 are enabled with ECDHE cipher suites. SSLv3, TLS 1.0, and TLS
  1.1 are disabled.
- Request bodies are capped at 1 MiB, matching the application limit.
- Per-source limits start at 10 requests/second with a burst of 20 and 20
  concurrent connections.
- `/healthz` is denied except from loopback. Add only the approved monitoring
  subnet. It remains unauthenticated by the application and must not be exposed
  to a general-purpose network.
- `/v1/*` and `/metrics` remain protected by `GATEWAY_API_TOKEN`. The proxy
  forwards the application `Authorization` header but does not add it to access
  logs.
- Unknown URI paths return 404 instead of being blindly proxied.
- Access logs contain request metadata and user agent, but never authorization
  headers, cookies, request bodies, or configured tokens.

The reverse proxy does not provide RBAC, a WAF, DDoS protection, MES delivery
semantics, or automatic credential rotation. Those remain site or application
responsibilities.

## Prerequisites

Before installing the template:

1. Obtain site approval for remote access, source networks, edge authentication,
   log retention, and certificate ownership.
2. Install nginx from the approved Raspberry Pi OS repository and keep it
   patched.
3. Obtain a certificate whose subject alternative name exactly matches the
   Gateway DNS name from the site PKI. Do not generate a self-signed certificate
   for production unless the security owner explicitly approves that exception.
4. Set a unique high-entropy `GATEWAY_API_TOKEN` in `/etc/rpi4-gateway.env`.
5. Keep `GATEWAY_HTTP_HOST=127.0.0.1` and confirm the service is healthy on the
   loopback API before adding the proxy.
6. Decide whether the edge requires mTLS, Basic Auth, or only HTTPS plus the
   application bearer token. mTLS is preferred when the site has a client PKI.

## Install

Copy the certificate and private key to a root-controlled directory. The nginx
master process reads the key before workers drop privileges.

```bash
sudo install -d -o root -g root -m 0750 /etc/rpi4-gateway/tls
sudo install -o root -g root -m 0644 /secure/staging/fullchain.pem \
  /etc/rpi4-gateway/tls/fullchain.pem
sudo install -o root -g root -m 0600 /secure/staging/privkey.pem \
  /etc/rpi4-gateway/tls/privkey.pem
sudo install -o root -g root -m 0644 deploy/nginx/rpi4-gateway.conf \
  /etc/nginx/conf.d/rpi4-gateway.conf
sudo install -o root -g root -m 0644 deploy/nginx/rpi4-gateway.logrotate \
  /etc/logrotate.d/rpi4-gateway
```

Edit `/etc/nginx/conf.d/rpi4-gateway.conf` and replace:

- both `server_name gateway.example.invalid;` entries with the approved DNS name;
- the certificate paths if the site uses a different protected location;
- the commented `allow` line under `/healthz` with the monitoring subnet, if
  remote health polling is approved.

The template uses the `listen ... http2` form for compatibility with nginx 1.22
on Raspberry Pi OS. Newer nginx releases support the standalone `http2 on;`
directive and may emit a deprecation warning for the listen parameter. If the
host has IPv6 disabled, remove both `listen [::]` lines so `nginx -t` does not
fail on an unavailable address family.

Do not add a wildcard health endpoint, publish port 8080, or copy `privkey.pem`
into the repository, a release archive, a log, or a support bundle.

Validate and reload:

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

## Verify

First prove that the application is still reachable only on loopback:

```bash
sudo ss -lntp | rg '(:443|:8080)'
curl --fail http://127.0.0.1:8080/healthz
```

The expected listeners are nginx on 443 and the Gateway on
`127.0.0.1:8080`. There must be no `0.0.0.0:8080` or `[::]:8080` listener.

From an approved client network, verify redirect, certificate, TLS version, and
authentication:

```bash
curl -I http://gateway.example.invalid/
curl --fail https://gateway.example.invalid/healthz
curl --fail -H "Authorization: Bearer <token>" \
  https://gateway.example.invalid/metrics
openssl s_client -connect gateway.example.invalid:443 \
  -servername gateway.example.invalid -tls1_2 </dev/null
openssl s_client -connect gateway.example.invalid:443 \
  -servername gateway.example.invalid -tls1_1 </dev/null
```

The HTTP request must return a 301 to HTTPS. TLS 1.2 must complete. TLS 1.1 and
older must fail. `/healthz` must be denied from sources outside the approved
monitoring subnet. A missing or wrong bearer token must return 401 from the
Gateway for `/metrics` and `/v1/*`.

Inspect an access-log line to confirm no credential material is present:

```bash
sudo tail -n 5 /var/log/nginx/rpi4-gateway-access.log
```

## Firewall

Apply the site's firewall tool. The policy must allow 443 only from approved
client or monitoring networks and must not allow inbound 8080. Port 80 may be
permitted only for the approved HTTP-to-HTTPS redirect path; otherwise deny it
at the perimeter as well.

For a simple UFW deployment, adapt the networks to the approved design:

```bash
sudo ufw default deny incoming
sudo ufw allow from <approved-client-cidr> to any port 443 proto tcp
sudo ufw allow from <approved-monitoring-cidr> to any port 443 proto tcp
sudo ufw deny 8080/tcp
sudo ufw status verbose
```

Do not use `0.0.0.0/0` unless the security owner has approved Internet-facing
exposure and the site has the corresponding monitoring and incident process.

## Edge Authentication

### mTLS (Preferred With a Client PKI)

Install the client CA certificate at a root-controlled path, for example
`/etc/rpi4-gateway/tls/edge-client-ca.pem`, with mode 0644. In the 443 server
block, uncomment:

```nginx
ssl_client_certificate /etc/rpi4-gateway/tls/edge-client-ca.pem;
ssl_verify_client optional;
```

Then uncomment the matching guard in `/metrics` and `/v1/`:

```nginx
if ($ssl_client_verify != SUCCESS) { return 403; }
```

Keep `/healthz` on its source-network allowlist rather than requiring a client
certificate from the monitoring system unless that system supports mTLS. Test
that a request without a client certificate is rejected and a request with an
approved certificate still requires the application bearer token.

### Basic Auth (Site-Approved Alternative)

Basic Auth uses the standard `Authorization` header. It must not be reused as
the application bearer token. If the site mandates Basic Auth:

1. Put `auth_basic` and `auth_basic_user_file` in `/metrics` and `/v1/` only.
2. Change the upstream header in those locations from
   `proxy_set_header Authorization $http_authorization;` to
   `proxy_set_header Authorization $http_x_gateway_authorization;`.
3. Require clients to send the application token separately as
   `X-Gateway-Authorization: Bearer <token>`.
4. Keep `GATEWAY_API_TOKEN` enabled and verify that Basic credentials alone do
   not satisfy the application token check.

Example location directives after creating a root-readable password file:

```nginx
auth_basic "RPi4 Gateway";
auth_basic_user_file /etc/nginx/rpi4-gateway.htpasswd;
```

### Bearer Token Only

If the site accepts HTTPS plus the application bearer token as the authentication
baseline, leave edge authentication disabled. Use a high-entropy token, rotate it
on personnel or incident changes, and restrict 443 by source network. This is
still a shared credential without per-user audit or online revocation.

## Certificates and Rotation

Before every rotation, record the current certificate subject, issuer, serial,
validity dates, and SHA-256 fingerprint in the change record. Confirm the new
certificate's subject alternative name and fingerprint with the PKI owner.

Stage the new `fullchain.pem` and `privkey.pem`, preserve `0600` root-only
permissions on the key, run `sudo nginx -t`, and only then reload nginx. Verify
the served certificate and an authenticated API request:

```bash
openssl s_client -connect gateway.example.invalid:443 \
  -servername gateway.example.invalid </dev/null 2>/dev/null | \
  openssl x509 -noout -subject -issuer -serial -dates -fingerprint -sha256
curl --fail -H "Authorization: Bearer <token>" \
  https://gateway.example.invalid/metrics
```

If validation fails, restore the previous certificate and key, reload, and
record the rollback. Certificate reload does not require restarting the
Gateway. Do not remove the previous known-good material until the change window
closes.

## HSTS

HSTS is intentionally disabled in the template. Enable it only after the site
confirms that this DNS name will use HTTPS permanently and that all approved
clients can follow the policy. A long `max-age` is difficult to undo during
rollback. Test an extended pilot window before adding `includeSubDomains` or a
HSTS preload request.

## Access Logs and Retention

The template writes JSON-line access and error logs to `/var/log/nginx/` and the
logrotate file rotates them daily, retaining 30 compressed files with a maximum
age of 90 days. The site may require a shorter or longer period; change the
values through change control and ensure the log partition has a bounded size.

Access logs can contain work-order or product identifiers embedded in query
strings. Treat them as production data: restrict read access, ship them only
through an approved channel, and include them in incident preservation. Do not
add authorization headers, cookies, tokens, or request bodies to the log format.

## Rate Limits and Upstream Proxies

The baseline limits are deliberately conservative starting points, not tuned
capacity limits. Review them against real API and scrape rates. If a trusted
load balancer or ingress sits in front of nginx, all requests otherwise appear to
come from that proxy and share one rate-limit bucket. Configure
`set_real_ip_from` with only the exact approved proxy addresses, choose the
correct `real_ip_header`, and test spoofing resistance before relying on client
IPs for rate limits or source policy.

## Change-Control Checklist

- Remote access, DNS name, certificate chain, client networks, edge
  authentication method, and log-retention period are approved.
- The Gateway still listens only on `127.0.0.1:8080` and has a strong API token.
- The private key is root-owned, mode 0600, and absent from Git and release
  archives.
- `sudo nginx -t` passes before every reload.
- TLS 1.2/1.3 succeed, older protocols fail, and HTTP redirects to HTTPS.
- `/healthz` is reachable only from the approved monitoring network.
- `/v1/*` and `/metrics` reject missing or invalid application tokens.
- Rate limits, source allowlists, and access-log retention are tested.
- Certificate expiry, rotation, rollback, and access-log review are on the
  operational calendar.
