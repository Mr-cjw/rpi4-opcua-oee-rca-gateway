# Security Review

Status date: 2026-11-28

Review status: conditional pass for a controlled, loopback-only, single-station
pilot. Remote HTTP exposure, mandatory production use of release signing, and
the remaining hardware gates require site-specific approval before broader
deployment.

This is an internal design and implementation review, not a penetration test or
an independent certification. It covers the Gateway runtime, OPC UA client,
local HTTP API, secret handling, release process, dependency baseline, and
systemd sandbox. It does not certify the PLC, plant network, operating-system
image, physical site, or downstream MES/QA system.

Related documents:

- [Field pilot runbook](PILOT-RUNBOOK.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
- [Deployment guide](../deploy/README.md)

## 1. Executive Summary

The default production posture is fail-closed for OPC UA: `NODE_ENV=production`
rejects `None` security or automatic unknown-certificate trust unless the
operator explicitly sets `GATEWAY_ALLOW_INSECURE_OPCUA=true`. The HTTP API
defaults to loopback, supports a bearer token with constant-time comparison, and
limits request bodies to 1 MiB. A hardened nginx template provides TLS 1.2/1.3
termination, source-network policy, rate and concurrency limits, security
headers, and bounded access logs for approved remote access. Releases are
immutable, checksummed, optionally detached-signed, and health-checked, and the
systemd unit applies a meaningful privilege and filesystem sandbox.

The principal residual risks are deliberate deployment choices: the HTTP API has
no built-in TLS, rate limiting, or user-level authorization; signature
enforcement is opt-in and signing-key custody/rotation remains manual;
credentials and PKI material are plaintext files protected by host permissions;
and the system has no HA or central durable queue. These are acceptable only
with the compensating controls in this review and must be revisited before
remote or multi-site rollout.

## 2. Assets and Trust Boundaries

Protected assets:

- OPC UA username/password and optional client private key.
- PLC certificate trust decisions and the Gateway client PKI store.
- `GATEWAY_API_TOKEN` and any reverse-proxy credentials.
- Process-context, alarm, quality-event, work-context, and idempotency data.
- Release archives, manifests, checksums, signatures, and Git provenance.
- Release signing private keys and the public keys provisioned for verification.
- Availability and integrity of OEE/RCA evidence used by production and QA/MES.

Trust boundaries:

| Boundary | Data crossing | Primary control |
| --- | --- | --- |
| PLC/network to Gateway OPC UA client | Process values, alarms, credentials, certificates | OPC UA security mode/policy, explicit trust, credential files |
| Operator/QA/MES to local HTTP API | Work context, quality events, queries, bearer token | Loopback bind, optional bearer token, input limits; approved nginx TLS template for remote access |
| Build/CI to Raspberry Pi | Source, lockfile, release archive, checksums, detached signature, Node runtime requirement | Immutable release, SHA-256 manifest, required signature verification, `npm ci`, health-checked install |
| Service account to local state/PKI | JSONL, idempotency, work context, private key | `StateDirectory`, file permissions, systemd sandbox, offline backups |
| Metrics scraper to Gateway | Health, counts, identities, diagnostics | Loopback or authenticated `/metrics`, network boundary |

The Gateway assumes the Pi operating system, SSH access, package repositories,
administrative workstations, and physical site are managed by the customer with
at least equivalent care. Compromise of root or physical access is outside the
application's containment boundary.

## 3. Threat Model and Assumptions

Reviewed threat classes:

- An adjacent network attacker probes the HTTP or OPC UA endpoint.
- A stolen or guessed bearer token accesses production context and mutating
  work-context/quality APIs.
- A malicious or accidental certificate is trusted, or an expired/rotated PLC
  certificate causes an outage.
- A compromised dependency, build host, or artifact storage channel alters a
  release.
- A local unprivileged process reads state, logs, credentials, or PKI material.
- Operator error, power loss, disk exhaustion, or an interrupted upgrade causes
  data loss or an unavailable service.
- Logs or error responses disclose secrets or sensitive production data.

Assumptions:

- The HTTP API is not exposed directly to an untrusted network. Direct remote
  access is an approved exception with a hardened reverse proxy.
- The OPC UA endpoint, account, certificate fingerprint, NodeIds, and process
  semantics have been commissioned and recorded.
- The service runs as the dedicated `rpi4-gateway` user under the supplied unit.
- Only trusted administrators can read the environment file, credential files,
  state directory, and PKI directory.
- The host clock is NTP-synchronized and the PLC clock is maintained by its
  owner. Clock failure is reported, not silently corrected.

## 4. OPC UA Controls

- Production startup rejects `OPCUA_SECURITY_MODE=None` or
  `OPCUA_TRUST_UNKNOWN_CERTIFICATES=true` unless
  `GATEWAY_ALLOW_INSECURE_OPCUA=true` is explicitly set.
- The deployment template selects `SignAndEncrypt` with `Basic256Sha256`.
- Unknown server certificates remain untrusted by default. Trust is a manual
  operation against a fingerprint recorded during PLC commissioning.
- Certificate trust is loaded at startup. Rotation requires an explicit trust
  update and service restart, preventing a silent new-certificate acceptance.
- Username and password can be supplied through separate files. Inline and file
  forms cannot be mixed, missing or unreadable files fail startup, and line
  breaks are rejected.
- The Gateway does not log the configured password. This is covered by the
  security E2E test for both Sign and SignAndEncrypt sessions.
- The Gateway opens one shared client session/subscription and does not write
  PLC values. This reduces the attack surface and prevents the application from
  becoming a control path.

Residual risk: the generated client private key is stored as a local file unless
an external key provider is integrated. Protect and back up the PKI directory as
security material, not ordinary application data.

## 5. HTTP API Controls

- The default bind address is `127.0.0.1`; the example environment keeps it on
  loopback.
- The supplied nginx template terminates TLS 1.2/1.3, proxies only to
  `127.0.0.1:8080`, restricts `/healthz` to loopback plus explicit monitoring
  sources, applies request-body/rate/concurrency limits, adds security headers,
  and logs without authorization headers. It is a deployment template that
  requires site-specific approval, not an automatically enabled control.
- `npm run edge:verify` checks the deployed certificate chain, TLS 1.2/1.3,
  HTTP redirect, health response, security headers, anonymous and authenticated
  `/metrics` and `/v1` access, unknown-path handling, and optional loopback
  origin without an insecure certificate option. It supports a private CA and
  mTLS client material.
- `npm run commission` aggregates release/rollback readiness, systemd state,
  health, PLC, clock, storage, OPC UA doctor, and edge verification into a
  mode-`0600` JSON report. Skipped mandatory gates are warnings and fail strict
  acceptance.
- `npm run field:drill` stages signed install, reboot proof, edge-certificate
  rotation, and rollback behind explicit operator actions. It requires
  `--execute` for install and rollback, stores state mode `0600` in a mode-`0700`
  directory, and emits a checksummed evidence manifest without recording API or
  client secrets.
- `npm run hardware:check` records point-in-time Pi model, architecture,
  temperature, under-voltage/throttling flags, firmware, NTP, and storage
  headroom. It reads no credentials, treats missing `vcgencmd` telemetry as a
  warning, and writes an optional mode-`0600` JSON report.
- `GATEWAY_API_TOKEN` protects `/metrics` and `/v1/*` when configured. Bearer
  comparison uses `crypto.timingSafeEqual` after a length check.
- `/healthz` is intentionally unauthenticated and contains status/identity
  context needed for local health checks. It must remain on loopback or be
  protected at the network edge.
- JSON request bodies are capped at 1 MiB. Request and header timeouts are set
  by the HTTP server.
- Responses set `cache-control: no-store` and `x-content-type-options: nosniff`.
- Quality writes are fail-closed: a storage or validation failure does not
  return a success response.
- The API does not execute shell commands, evaluate arbitrary templates, or
  accept file paths from clients.

Residual risks:

- There is no built-in TLS, rate limiting, WAF, or per-user authorization. The
  application must never listen beyond loopback even when the edge template is
  used.
- The edge template does not provide per-user RBAC, token expiry/revocation,
  WAF, DDoS protection, HA, or automatic certificate renewal.
- The token is a shared static secret with no expiry or online revocation.
- The API does not write a per-request audit record.
- Internal error messages can be returned to an API caller; keep the API behind
  a trusted boundary, especially when a token is not configured.

Compensating control: remote exposure requires an approved reverse proxy that
terminates TLS, authenticates operators, enforces source-network policy and rate
limits, and logs requests. The supplied nginx template implements the baseline;
the site must approve its DNS, PKI, authentication, firewall, log retention, and
incident process. Never publish port 8080 directly.

## 6. Secrets and Key Material

- `/etc/rpi4-gateway.env` should be mode `0600` and owned by root, with only the
  required variables visible to systemd.
- `OPCUA_USERNAME_FILE` and `OPCUA_PASSWORD_FILE` should be mode `0600`, owned by
  `rpi4-gateway`, and stored in a directory not readable by other users.
- Production passwords and tokens must not be committed to Git or placed in
  shell history.
- The nginx private key must be root-owned with mode `0600`; certificate chains
  and client CA files must be protected from unapproved modification. Neither
  is included in releases or ordinary state backups.
- The OPC UA PKI directory under `/var/lib/rpi4-gateway/pki` is excluded from
  ordinary state backups. Back it up separately using an encrypted, approved
  process.
- Operator and QA/MES credentials are not managed by the Gateway. Their
  lifecycle remains the responsibility of the downstream service.

Residual risk: environment variables and plaintext files are readable by the
service user and root. There is no HSM, secrets manager, automatic rotation, or
encrypted-at-rest key store. A host compromise must be treated as credential and
PKI compromise.

## 7. Logs and Sensitive Data

- Logs are structured and written to bounded files or the systemd journal.
- The HTTP layer does not log request bodies. The OPC UA security E2E asserts
  that the configured password does not appear in captured Gateway logs.
- The supplied nginx log format excludes authorization headers, cookies, tokens,
  and request bodies. Its access logs can still contain business identifiers in
  query strings and must follow the site's production-data retention policy.
- Event logs contain business identifiers and production/quality evidence and
  must be treated as confidential operational data.
- JSONL retention is bounded by configured time, count, byte, and rotation
  limits. Old records are deleted, not archived automatically.
- The Gateway does not ship logs to a central SIEM or encrypt them at rest.

Compensating control: protect host and backup access, apply site log-retention
policy, and forward security-relevant service/journal events to the approved
monitoring platform outside the Gateway.

## 8. Release and Dependency Integrity

- Release archives contain tracked source, `package-lock.json`, deploy files,
  `release-manifest.json`, `SHA256SUMS`, and an embedded CycloneDX 1.5
  `sbom.cdx.json` inventory of production dependencies.
- Packaging refuses dirty tracked files unless an operator explicitly requests a
  diagnostic dirty build. The manifest records Git commit, dirty state, release
  ID, Node engine, file hashes, and sizes.
- Installation verifies archive and file checksums, the minimum Node.js version,
  optional required detached signatures, creates an immutable release directory,
  and runs `npm ci --omit=dev`.
- Packaging generates the SBOM from the production lockfile graph with npm's
  native CycloneDX output, adds it to manifest hashes and `SHA256SUMS`, and
  authenticates it through the archive signature. `release:sbom` exports the
  signed embedded copy without re-resolving dependencies.
- `release:sign` signs the exact archive bytes with SHA-256 and writes a binary
  `<archive>.sig` file. The private key remains on the trusted signing host; only
  the public key is provisioned on the Pi.
- When `--require-signature` is set, or a public-key/signature path is supplied,
  installation verifies the signature before extraction or release switching.
  Failure is closed and leaves `current` unchanged. `last-release.json` records
  the verified algorithm, public-key SHA-256 fingerprint, and SBOM summary, not
  the key path.
- CI generates an ephemeral key pair and exercises signing plus verification as a
  smoke test. That key is not a production trust anchor and is not uploaded.
- `current` and `previous` are switched atomically. A failed health check
  automatically restores and restarts the previous release.
- The minimum runtime is `Node.js 22.13.0`, matching the upgraded OPC UA
  dependency. CI covers Node 22.13.0 and 24.
- On 2026-11-28, `npm audit --omit=dev` and the full `npm audit` both reported
  zero vulnerabilities after upgrading `node-opcua` from `2.160.0` to `2.188.1`.
  The upgrade removed production advisories that included OPC UA certificate,
  nonce/cache, namespace authorization, and vulnerable transitive packages.
- CI runs the production-only audit before building the release artifact.

Residual risks:

- SHA-256 alone provides integrity against accidental corruption but not
  authenticity against an attacker who can replace both the archive and its
  checksum. The detached signature closes that gap only when required.
- The default compatibility path can still install an unsigned archive. A
  production deployment must enforce `--require-signature` and treat an unsigned
  install as a change-control exception.
- Signature trust depends on the custody of the private key and integrity of the
  provisioned public key. Key compromise or unauthorized public-key replacement
  defeats verification.
- There is no automatic signing-key rotation, revocation, HSM/KMS integration,
  or OTA signing service. Key lifecycle operations remain manual.
- The SBOM is an inventory. It does not include vulnerability status, exploit
  reachability, VEX statements, or a legal license determination, and it does
  not prove that optional platform-specific packages were exercised on the Pi.
- `npm ci` trusts the configured registry and lockfile. A compromised registry,
  build runner, or npm account remains a supply-chain risk.
- Audit results are point-in-time. Re-run the audit and review advisories before
  every field release.

## 9. Systemd and Host Sandbox

The supplied unit runs as `rpi4-gateway` and includes:

- `NoNewPrivileges=true`, empty `CapabilityBoundingSet`, and no write access to
  `/opt` under `ProtectSystem=strict`.
- `ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true`, and a dedicated
  `StateDirectory` for writable state.
- Kernel tunable, module, log, and control-group protection; hostname
  protection; realtime and setuid/setgid restrictions; personality locking; and
  IPC removal.
- Address-family restriction to Unix, IPv4, IPv6, and netlink sockets.
- `UMask=0027`, a non-login service account, and a bounded stop timeout.

Validate the unit after any change:

```bash
systemd-analyze verify deploy/rpi4-gateway.service
```

Residual risk: this is application-level sandboxing, not a hardened OS image.
Secure boot, firmware integrity, SSH hardening, firewall policy, package
management, physical locks, and disk encryption are deployment responsibilities.

## 10. Verification Evidence

The release review should archive the following results:

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
npm run edge:verify -- --url https://<gateway-name> --strict
npm run commission -- --url https://<gateway-name> --strict --json
npm run hardware:check -- --storage-path /var/lib/rpi4-gateway --strict --json
npm run security:audit
npm audit
systemd-analyze verify deploy/rpi4-gateway.service
```

`npm run e2e:security` verifies Sign and SignAndEncrypt sessions, credentials
read from files, rejection of wrong passwords and anonymous sessions, password
absence from captured logs, rejection of a rotated but untrusted server
certificate, persistent trust after an explicit update, and successful reconnect
after restart. The other E2E suites verify context/OEE/RCA, PLC diagnostics, and
clock degradation. `npm test` also statically checks that the nginx template
uses TLS 1.2/1.3 only, proxies to loopback, enforces request-body/rate/concurrency
limits, keeps `/healthz` fail-closed, does not log credentials, and leaves HSTS
disabled. Site deployment still requires `nginx -t`, certificate validation, TLS
protocol probes, source-network tests, and an authenticated API request.
`edge:verify` performs those runtime probes against the approved DNS name without
an insecure certificate bypass. A TLS 1.1 `skip` means the local OpenSSL client
cannot initiate that protocol; the deployed edge must still be confirmed with the
site's approved scanner and the static nginx policy test.
`commission` records the combined Pi acceptance evidence without placing API or
client credentials in the report or on the command line; tokens still come only
from the environment or a mode-`0600` file. `field:drill` binds the signed
install, boot-ID change, edge-certificate fingerprint change, rollback, and
strict commissioning reports into a checksummed bundle; execute the full staged
sequence in the pilot runbook on the target Pi.

## 11. Residual Risk Register

| Risk | Severity if unmitigated | Current control | Deployment action |
| --- | --- | --- | --- |
| Direct HTTP exposure | High | Loopback default; optional bearer token; input limits; reviewed TLS nginx template | Approve and install the template or equivalent; restrict 443 sources; never expose 8080 |
| Single shared API token | Medium | Constant-time comparison; no logging of token | Use high-entropy token; rotate on personnel or incident change |
| Unsigned release mode | Medium | Detached signatures available; required-signature installs fail closed; fingerprint recorded | Require `--require-signature` in production and review `last-release.json` after upgrades |
| Release signing-key compromise | Medium | Private key stays on signing host; Pi receives public key only; fingerprint recorded | Use approved offline/HSM custody, rotate and revoke keys through change control, restrict signing hosts |
| Plaintext secrets/PKI | Medium | File modes, dedicated service user, PKI excluded from state backup | Protect host root, use encrypted off-device backup, reissue on suspected exposure |
| Unencrypted state/logs | Medium | Bounded retention, host permissions | Use encrypted volume or approved backup handling where required |
| Manual certificate trust | Medium | Unknown certs rejected; explicit fingerprint update and restart | Include certificate rotation in change control and pilot drills |
| No HA or central queue | Medium | Local durable logs, fsync for accepted quality, idempotent retries | Define station outage tolerance and downstream retry/reconciliation |
| No per-request audit | Low/Medium | Structured error and process logs; bounded proxy access log for remote deployments | Ship and review edge logs under site retention policy; add per-user identity if required |
| Dependency or registry compromise | Medium | Exact lockfile, `npm ci`, CI audit, embedded CycloneDX SBOM, immutable signed artifact | Protect CI credentials, review advisories, add VEX/advisory reconciliation and stronger key custody |
| Host or physical compromise | High | systemd sandbox, least-privilege account | Harden OS/SSH, restrict physical access, monitor host integrity |

## 12. Security Incident Response

For suspected credential, token, certificate, release, or host compromise:

1. Preserve systemd journal, Gateway state, `last-release.json`, and access logs.
2. Isolate the Pi from untrusted networks without destroying evidence.
3. Revoke or rotate the affected OPC UA account, API token, certificate, or
   administrative credential through the owning system.
4. Stop the Gateway if continuing operation could write untrusted data or expose
   secrets.
5. Rebuild from a verified release and restore only verified state and PKI
   material. Do not trust modified archives, checksum files, or private keys.
6. Reconcile accepted quality events and identify any records requiring QA/MES
   review.
7. Record the incident, scope, affected time window, recovery evidence, and
   follow-up actions.

## 13. Review Conclusion and Open Actions

The current release is suitable for a controlled pilot only when:

- the API remains loopback-only or is protected by an approved reverse proxy;
- OPC UA uses SignAndEncrypt with explicit certificate trust;
- secrets and PKI are restricted to the service account and root;
- releases are transferred through a trusted channel and verified before use;
- the hardware recovery gates in the roadmap are completed.

Open actions before broader deployment:

- Define release-signing key custody, rotation, revocation, and independent
  attestation where required; reconcile embedded SBOMs against advisories/VEX.
- Complete the Raspberry Pi power-cut, disk-full, 72-hour soak, upgrade,
  rollback, and restore gates.
- Approve, install, and exercise the supplied remote-access template on the
  target network, including operator authentication, firewall ACLs, rate limits,
  certificate rotation, and access-log retention.
- Decide whether encrypted state storage or a secrets manager is required by
  site policy.

Suggested sign-off fields for the pilot record:

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| Gateway owner |  |  |  |
| PLC/controls owner |  |  |  |
| Production owner |  |  |  |
| Security reviewer |  |  |  |
| QA/MES owner |  |  |  |
