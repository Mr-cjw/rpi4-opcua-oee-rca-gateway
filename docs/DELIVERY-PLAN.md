# Raspberry Pi Gateway Delivery Plan

Status date: 2026-11-28

This plan turns the [roadmap](ROADMAP.md) into sequenced work packages. It is a
delivery-control document, not a promise of calendar dates. Dates are set only
after hardware, site owners, and pilot windows are confirmed.

The controlling rule is simple: simulated evidence cannot close a hardware or
site gate. When the target Pi, PLC, or plant network is unavailable, work stays
at the software and offline-release levels and the open gate remains visible.

## 1. Evidence Levels

| Level | Evidence | What it can prove | What it cannot prove |
| --- | --- | --- | --- |
| L0 | Unit and property tests | Individual logic, validation, and failure paths | Process integration or deployment behavior |
| L1 | Mock PLC, injected faults, and local E2E | Gateway behavior against deterministic simulated inputs | Real PLC, plant network, Pi, power, or storage behavior |
| L2 | Signed release audit, evidence bundle, and offline upgrade rehearsal | Release integrity, upgrade logic, rollback logic, and state-backup code paths | systemd, reboot, physical power loss, hardware storage, or real service health |
| L3 | Raspberry Pi hardware and lab network | Runtime, storage, reboot, power-cut, NTP, and hardware-readiness behavior | Site firewall, production PLC, operator process, and production traffic |
| L4 | Controlled field pilot | End-to-end acceptance with the real PLC, network, owners, and production constraints | Broad plant-wide rollout without a separate decision |

Current software work is complete through L2 for the release chain. Mock PLC and
injected-fault coverage is at L1. L3 and L4 remain open.

## 2. Planning Constraints

- No Raspberry Pi, real PLC, production certificate, or plant network is
  currently available in the development environment.
- One Gateway process represents one station and one line context.
- A state-format change is a release-level contract change, not an incidental
  migration.
- A 72-hour soak cannot be shortened by a local smoke run.
- A release may be promoted only with matching archive, checksum, signature,
  signer fingerprint, SBOM, audit, VEX, and evidence artifacts.
- New integration features must not displace unresolved durability and release
  gates unless the production owner explicitly accepts the added risk.

## 3. Dependency Order

The order below is intentional. A later item must not be used to hide a defect
in an earlier item.

1. OEE, event, and persistence correctness.
2. Storage durability, backup, restore, and state-format compatibility.
3. Signed release integrity, upgrade, and rollback.
4. PLC security, clock behavior, and hardware readiness.
5. Remote-access and network acceptance.
6. Integration sinks, RCA extensions, and broader observability.

## 4. Software Iterations Before Hardware Arrives

These iterations can be developed and reviewed at L0-L2. Each iteration must
leave an explicit statement about which hardware evidence is still missing.

### S1. Release-Signing Trust Policy and Rotation

Goal: move beyond one pinned fingerprint without weakening the current
fail-closed behavior.

Deliverables:

- Define a reviewed trust-policy format for active, retired, and revoked
  release-signing fingerprints.
- Keep the archive detached signature as the cryptographic authority; the
  policy controls identity and rotation only.
- Add fixtures for normal verification, rotation overlap, retired-key
  verification, revoked-key rejection, malformed policy, and policy rollback.
- Bind the policy-file hash and approved signer identity into release evidence.
- Update the key-management procedure for custody, dual control where required,
  rotation, revocation, and compromise response.

Acceptance:

- A valid signature from an unapproved or revoked signer fails before archive
  extraction or release switching.
- Rotation can be rehearsed without editing application source.
- Removing or expiring a trust entry is itself a reviewed, reversible change.

Still missing: HSM/KMS custody and independent site approval.

### S2. State-Format Migration Boundary

Goal: make state-format changes deliberate, testable, and reversible.

Deliverables:

- Add synthetic state-format v2 fixtures that are not accepted by the current
  runtime.
- Require every state-format change to include a migration manifest, preflight
  compatibility rule, post-migration validation, and rollback procedure.
- Extend the offline rehearsal with a migration scenario that proves an
  incompatible candidate is rejected before release switching.
- Add a restore test proving that a v1 backup can be restored after a rejected
  v2 rehearsal without altering accepted state.

Acceptance:

- A state-format mismatch fails with a specific diagnostic.
- The release note identifies whether rollback is code-only or also requires a
  verified state restore.
- No migration can be promoted without a tested pre-migration backup.

Still missing: physical power-loss testing during and after the real migration.

### S3. API and Event Contract Freeze

Goal: reduce integration churn before downstream consumers connect.

Deliverables:

- Publish an OpenAPI document for the current HTTP API.
- Add schema validation for request and response examples used by QA/MES and
  operator clients.
- Document additive-field, deprecation, and version-negotiation rules.
- Add a contract check to CI that fails on undocumented endpoint or field
  removal.

Acceptance:

- Existing E2E clients pass unchanged against the published contract.
- New fields remain additive and optional unless a versioned endpoint is added.
- Operator and consumer error semantics are documented, including `503` retry
  and idempotency behavior.

### S4. Offline Operational Tabletop

Goal: prove that recovery procedures are executable before hardware is present.

Deliverables:

- Script a tabletop exercise for PLC loss, disk-full, NTP loss, failed upgrade,
  automatic rollback, explicit rollback, and state restore against mock or
  simulated storage.
- Record commands, expected observations, evidence paths, decision points, and
  the point at which a hardware-only step would begin.
- Add a checklist that distinguishes equipment faults from Gateway faults.

Acceptance:

- An operator can follow the runbook without relying on undocumented state.
- Every tabletop result is marked as simulated and cannot satisfy an L3/L4 gate.
- Any procedure requiring a real reboot, power cut, certificate, or network
  change ends with an explicit hardware handoff.

### S5. Reliability and Supply-Chain Maintenance

Goal: keep the software baseline promotable while hardware is unavailable.

Deliverables:

- Review production advisories, VEX dispositions, SBOM changes, and lockfile
  drift on every release.
- Run the accelerated soak and fault-injection suites on a fixed cadence.
- Track CI duration and flaky tests; quarantine only with an owner and removal
  date.
- Validate Node.js baseline coverage before changing the minimum runtime.

Acceptance:

- No unexpired high or critical advisory is untriaged.
- A known flaky test cannot silently block or bypass release promotion without a
  recorded decision.
- The release evidence bundle remains reproducible from the same source commit.

## 5. Hardware Qualification Campaign

Run these gates in order once the target Pi, storage, PLC, and site access are
available. Every gate produces a report tied to the release ID and approved
signer fingerprint.

### H0. Host and Evidence Preflight

- Confirm Pi 4-class hardware, arm64 OS, supported Node.js, storage identity,
  power source, and network path.
- Run a clean-boot strict hardware check and retain the pre-change state backup.
- Confirm the approved release archive, public key, signer fingerprint, and
  evidence bundle.

Exit: no strict hardware, signature, key-identity, or state-backup failure.

### H1. Install, Reboot, and Field Drill

- Install the signed release with required signature and pinned fingerprint.
- Reboot, prove a changed boot ID, run strict commissioning, rotate the edge
  certificate, roll back, and finalize the evidence bundle.
- Repeat explicit and automatic rollback at least once.

Exit: the complete `field:drill` evidence chain passes; accepted events are not
lost across the drill.

### H2. Long-Duration Soak

- Run the full 72-hour soak with API load, quality ingestion, injected faults,
  reconnect cycles, retention pressure, and hardware telemetry.
- Retain hardware reports before and after the run.

Exit: no unexplained process exit, accepted-event loss, storage-budget breach,
thermal threshold breach, or unresolved under-voltage/throttling flag.

### H3. Host Resilience Matrix

- Execute controlled power-cut cycles, disk-full, storage-I/O failure, and NTP
  loss/offset/recovery tests.
- Verify restart, idempotent QA retry, sequence-gap evidence, health degradation,
  and state restoration.
- Repeat the install/rollback check after recovery.

Exit: every scenario has a preserved report and a documented recovery decision.

### H4. Real PLC and Network Acceptance

- Complete PLC certificate rotation and rejected-certificate handling.
- Validate the real NodeIds, timestamps, counters, alarms, and clock behavior.
- Install the approved reverse proxy, verify TLS, authentication, source limits,
  rate limits, redirects, and log retention, then exercise the API through it.

Exit: controls, security, and QA/MES owners accept the reports and residual
risks.

### H5. Pilot Exit Decision

The decision is `continue`, `conditional continue`, or `stop/rollback` under the
criteria in the [pilot runbook](PILOT-RUNBOOK.md). Only this decision may close
the L4 gate.

## 6. Release Train

| Release type | Allowed changes | Required evidence |
| --- | --- | --- |
| Patch | Bug fix, documentation, or dependency security update with no state-format change | Unit/E2E, signed release, audit, evidence, offline rehearsal |
| Minor additive | New optional API/event fields, diagnostics, or operational controls | Patch evidence plus contract tests and compatibility review |
| State-format change | Persisted event, idempotency, work-context, backup, or migration semantics | Minor evidence plus migration/rollback rehearsal and hardware durability gate before field use |
| Emergency security release | Narrowly scoped remediation | Expedited review, full signature/audit/evidence chain, post-release review within the next working cycle |

Every promotion record must contain the release ID, Git commit, archive SHA-256,
signer fingerprint, SBOM review, audit/VEX result, rehearsal result, hardware
gate status, approver roles, and rollback target.

## 7. Definition of Ready and Done

Definition of ready:

- The problem and affected contract are named.
- The work has an evidence level and an owner role.
- Hardware dependencies are identified rather than assumed.
- A rollback or disable path exists.

Definition of done:

- Tests cover success, rejection, and recovery paths.
- Documentation and deployment configuration are updated.
- CI is green and security/audit implications are reviewed.
- Operation reports bind the source commit and relevant evidence hashes.
- Any remaining hardware or site gate is listed explicitly; it is not implied by
  a local simulation.

## 8. Stop Conditions

Do not promote or continue a gate when any of the following is unresolved:

- an accepted quality event can be lost or acknowledged without durable storage;
- a signature, key fingerprint, archive hash, SBOM, audit, or evidence binding
  does not match;
- a state format is unknown or a migration lacks a tested backup and rollback;
- a high or critical advisory lacks a valid disposition;
- the service cannot prove a healthy restart or a reliable rollback;
- hardware telemetry is missing or reports an uncleared power/thermal condition;
- remote access bypasses the approved TLS and authentication boundary;
- the evidence does not state its evidence level or implies that a simulation
  satisfied a hardware gate.

## 9. Planning Review

Review this plan at every release and at least once per iteration. Update the
[roadmap](ROADMAP.md), [known limitations](KNOWN-LIMITATIONS.md), security
review, and pilot runbook when a decision, constraint, or acceptance criterion
changes. Preserve completed evidence rather than replacing it with a newer
summary.
