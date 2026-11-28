# Reliability and Supply-Chain Maintenance

Status date: 2026-11-28

This document defines the software-only maintenance loop that keeps the Gateway
baseline promotable while target hardware and site access are unavailable. It
covers dependency review, lockfile/SBOM drift, advisory and VEX dispositions,
the fixed accelerated-soak cadence, CI duration, flaky-test quarantine, and
Node.js runtime changes.

Companion documents:

- [Delivery plan](DELIVERY-PLAN.md)
- [Roadmap and release gates](ROADMAP.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
- [Pilot runbook](PILOT-RUNBOOK.md)
- [Offline operational tabletop](OFFLINE-TABLETOP.md)

## 1. Evidence Boundary

This maintenance loop proves software reproducibility, dependency visibility,
and local fault recovery only. A weekly accelerated soak does not replace the
72-hour target-hardware soak, physical power-loss testing, storage-device
failure testing, plant-network NTP validation, real PLC acceptance, or site
sign-off.

Release evidence remains reproducible from the same source commit only when the
lockfile, dependency baseline, SBOM inputs, audit inputs, and dispositions are
all reviewed together. Do not update one of those artifacts to hide a change in
another.

## 2. Supply-Chain Gate

The tracked baseline is
[`security/supply-chain-baseline.json`](../security/supply-chain-baseline.json).
It records:

- The Node.js minimum engine and CI matrix coverage.
- The `package-lock.json` version and SHA-256.
- Direct production, development, and optional dependency ranges.
- The normalized production dependency inventory digest and component count.
- The advisory-disposition schema, count, and SHA-256.

The production inventory is derived from the lockfile, excluding development
entries. It includes each production package path, name, version, integrity,
license, and optional flag. This is the reviewable lockfile/SBOM input; the
release archive still contains the native npm CycloneDX 1.5 SBOM and release
audit.

Run the check before every promotion:

```bash
npm run check:supply-chain
```

The command fails when:

- `package.json` and the lockfile root dependency ranges disagree.
- The lockfile is not version 3 or the direct production dependency is missing.
- The lockfile digest or normalized production inventory changed.
- The Node.js minimum is absent from the CI matrix, the matrix includes an
  older runtime, or fewer than two runtime majors are covered.
- A VEX disposition is malformed or expired.
- The disposition file digest changed without regenerating the baseline.

An intentional dependency change follows this sequence:

1. Update `package.json` and `package-lock.json` with npm in one reviewed change.
2. Run `npm ci`, `npm test`, the E2E suites, and `npm run security:audit`.
3. Review high/critical advisories and add or update only justified VEX
   dispositions with an owner, detail, and future expiry.
4. Run `npm run supply-chain:baseline` after the review is approved.
5. Review the diff in `package-lock.json` and
   `security/supply-chain-baseline.json`.
6. Run `npm run check:supply-chain` again and retain the review report.

Do not hand-edit the baseline. Regenerating it records the reviewed state and
updates `generatedAt`.

The CI release job also writes the review to
`dist/supply-chain/review.json` and uploads it with the release audit, VEX, and
evidence artifacts. The release audit independently validates that advisory
packages are present in the embedded SBOM and blocks unaccepted high or critical
findings.

## 3. Advisory and VEX Review

Production advisories are reviewed with:

```bash
npm run security:audit
```

High and critical findings block promotion unless an active disposition is
accepted for that package and advisory ID. Every disposition must include:

- `id`, `package`, and optional aliases.
- A supported VEX state and justification when required.
- A concrete `detail` and accountable `owner`.
- A future `expiresAt` timestamp.

Expired dispositions fail the supply-chain check even when no current audit
finding matches them. This prevents stale risk acceptance from silently
surviving into a later release. Review unused dispositions and remove them when
the associated advisory is no longer present.

## 4. Fixed Reliability Cadence

| Trigger | Scope | Purpose |
| --- | --- | --- |
| Push and pull request | Contracts, docs, supply chain, quarantine registry, full unit/integration tests on Node 22.13 and 24 | Prevent baseline drift and runtime regression |
| Push and pull request | Mock PLC, Gateway, diagnostics, security, clock E2E, and 20-second soak smoke | Exercise live protocol paths and basic fault recovery |
| Push and pull request | Signed release, audit/VEX/evidence, offline upgrade rehearsal | Keep release evidence reproducible |
| Weekly schedule | Governance checks plus production audit and full tests on Node 22.13 | Detect advisory and dependency changes outside pushes |
| Weekly schedule | Five-minute accelerated soak with API, quality, fault, and reconnect load | Detect slow failures and reconnect/retention regressions |
| Manual dispatch | Same weekly workflow | Reproduce a failure or run an out-of-band review |

The schedule is Monday at `03:17 UTC` in
[`reliability.yml`](../.github/workflows/reliability.yml). GitHub scheduled
workflows are best-effort; record the actual run ID when using the result as
release evidence.

The accelerated soak uses:

```text
duration=300000ms apiInterval=250ms qualityInterval=1000ms
faultInterval=2000ms reconnectInterval=10000ms reconnectDown=1000ms
```

It must pass API latency, context progress, quality ingestion, fault injection,
reconnect recovery, event bounds, storage bounds, connectivity, and configured
hardware checks. The report is uploaded as a workflow artifact. A five-minute
run is a regression signal, not a 72-hour endurance result.

## 5. CI Duration Budget

The current job budgets are:

| Job | Timeout |
| --- | --- |
| Node 22.13/24 checks | 20 minutes |
| E2E and soak smoke | 30 minutes |
| Release archive and rehearsal | 15 minutes |
| Weekly governance checks | 20 minutes |
| Weekly accelerated soak | 20 minutes |

Review actual job durations during the weekly maintenance run. If a job exceeds
80 percent of its budget for two consecutive weeks, open a tracked remediation
item before raising the timeout. Raising a timeout without a reason makes a
regression look healthy. The soak report also records its actual duration,
request counts, reconnect cycles, storage bounds, and latency percentiles.

## 6. Flaky-Test Quarantine

The authoritative registry is
[`security/flaky-tests.json`](../security/flaky-tests.json). It is empty by
default. Every quarantined test record requires:

- `test`: stable test file and name.
- `owner`: accountable team or role.
- `reason`: why the test is unreliable and what behavior is still covered.
- `issue`: a tracking URL or identifier.
- `quarantinedAt`: when isolation began.
- `removeBy`: a future removal date.
- `evidence`: retained failure/rerun evidence.

Validate the registry with:

```bash
npm run check:quarantine
```

Duplicate tests, missing fields, future quarantine dates, invalid timestamps,
and expired `removeBy` dates fail the check. A quarantined test must be skipped
explicitly in its test file with a comment naming the registry record; it must
not disappear from CI without a trace. Release promotion records must reference
the registry digest and any open removal item.

Quarantine is not a substitute for a fix. It is only an owner-approved,
time-bounded exception. A test that can hide accepted-event loss, storage
corruption, signature failure, or unsafe release switching cannot be
quarantined without a stop decision.

## 7. Node.js Runtime Baseline

The current baseline is Node.js `>=22.13.0`, with CI coverage for `22.13.0` and
`24`. The supply-chain check reads the CI matrix and fails if the minimum is not
covered, if an older runtime is present, or if only one runtime major is tested.

Changing the minimum runtime requires one reviewed change that:

1. States the reason, dependency requirement, and rollback impact.
2. Updates `package.json` engines and the CI matrix together.
3. Runs the full unit/integration, E2E, soak smoke, release, and tabletop suites
   on the new minimum.
4. Regenerates the supply-chain baseline and reviews the runtime diff.
5. Confirms Raspberry Pi OS arm64 package availability for the target pilot.

The current Raspberry Pi field gate still requires the supported runtime to be
installed and validated on the target host. A CI-only pass does not approve a
runtime change for the pilot.

## 8. Promotion and Stop Rules

Do not promote a release when any of these conditions is unresolved:

- The supply-chain baseline check fails or was regenerated without review.
- A high or critical production advisory lacks a valid VEX disposition.
- A disposition is expired, malformed, or has no accountable owner.
- The quarantine registry is malformed or contains an expired removal date.
- The CI matrix does not cover the declared minimum Node.js runtime.
- A weekly accelerated soak regression has no recorded owner or decision.
- The release evidence, SBOM, audit, lockfile, and baseline do not describe the
  same source commit.

The next hardware-only gate remains the full 72-hour target-Pi soak and the
power-loss, storage, NTP, certificate, PLC, and site-acceptance campaign in the
[delivery plan](DELIVERY-PLAN.md#5-hardware-qualification-campaign).
