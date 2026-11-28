# Release Signing Key and Trust Policy

Status date: 2026-11-28

This document defines the release-signing trust policy for the Raspberry Pi
Gateway. It covers signer authorization, rotation, revocation, custody, and the
evidence required for a promotion. The detached archive signature remains the
cryptographic authority; the trust policy only decides which public-key
identity may be accepted and for which purpose.

The software implements the trust-policy format and enforcement. HSM/KMS
custody and independent site approval remain open hardware/site gates.

## 1. Policy File

The reviewed policy is a JSON document:

```json
{
  "schemaVersion": "1.0",
  "kind": "rpi4-gateway-release-trust-policy",
  "policyId": "pilot-release-2026",
  "sequence": 4,
  "issuedAt": "2026-11-28T00:00:00.000Z",
  "keys": [
    {
      "name": "release-2026-primary",
      "fingerprint": "<64 lowercase hex characters>",
      "status": "active",
      "notBefore": "2026-11-01T00:00:00.000Z",
      "notAfter": null
    },
    {
      "name": "release-2025-old",
      "fingerprint": "<64 lowercase hex characters>",
      "status": "retired",
      "notBefore": "2025-01-01T00:00:00.000Z",
      "notAfter": "2026-10-31T23:59:59.000Z"
    }
  ]
}
```

A revoked key additionally requires `revokedAt` and `revocationReason`:

```json
{
  "name": "release-compromised",
  "fingerprint": "<64 lowercase hex characters>",
  "status": "revoked",
  "revokedAt": "2026-11-28T06:00:00.000Z",
  "revocationReason": "signing host compromise"
}
```

Required rules:

- `schemaVersion` is `1.0` and `kind` is
  `rpi4-gateway-release-trust-policy`.
- `policyId` identifies the approved policy set and contains only letters,
  digits, dot, colon, underscore, or hyphen.
- `sequence` is a positive integer that increases whenever policy content
  changes. A lower sequence is never used to undo a later policy.
- `issuedAt` is an ISO-8601 timestamp.
- Each fingerprint is a SHA-256 digest of the public key in SPKI DER form.
- A fingerprint appears only once in a policy.
- `status` is `active`, `retired`, or `revoked`.
- `notBefore` and `notAfter` are optional ISO-8601 timestamps. `notBefore` must
  be earlier than `notAfter` when both are present.
- A revoked key includes `revokedAt` and `revocationReason`; non-revoked keys do
  not.

## 2. Enforcement Semantics

- An `active` key authorizes a new install only inside its validity window.
- A `retired` key never authorizes a new install. It can verify historical
  evidence only when the operator explicitly supplies
  `--allow-retired-signer`.
- A `revoked` key always fails. The retired-signer override cannot reactivate a
  revoked key.
- A signer fingerprint absent from the policy is rejected before archive
  extraction or release switching.
- `--policy-sha256` pins the exact policy-file digest. Use the digest recorded in
  the approved change record.
- `--minimum-policy-sequence` fails closed when the supplied policy is older
  than the approved sequence.
- Installation compares the policy sequence with `last-release.json` and rejects
  a different policy whose sequence is not newer.
- Release evidence records the policy digest, policy ID, sequence, signer name,
  signer status, and a protected copy of the exact policy used.

## 3. Provisioning

Keep private keys off the Raspberry Pi and out of Git, release archives, chat,
CI logs, and shell history. Provision only the public key and trust policy on the
Pi:

```text
/etc/rpi4-gateway/release-public.pem        root:root 0644
/etc/rpi4-gateway/release-trust-policy.json root:root 0644
```

The directory itself should be root-controlled and not writable by the Gateway
service account. Record the policy digest in the release change record before
distribution.

Validate the policy before use:

```bash
npm run release:trust-policy -- \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-sequence>
```

Use the same trust policy when verifying, auditing, creating evidence, and
installing:

```bash
npm run release:verify-signature -- \
  --archive <release.tar.gz> \
  --public-key /etc/rpi4-gateway/release-public.pem \
  --signer-fingerprint <approved-fingerprint> \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-sequence>

sudo npm run release:install -- \
  --archive <release.tar.gz> \
  --public-key /etc/rpi4-gateway/release-public.pem \
  --signer-fingerprint <approved-fingerprint> \
  --trust-policy /etc/rpi4-gateway/release-trust-policy.json \
  --policy-sha256 <approved-policy-sha256> \
  --minimum-policy-sequence <approved-sequence> \
  --require-signature
```

The field drill accepts the same `--trust-policy`, `--policy-sha256`, and
`--minimum-policy-sequence` options during preflight. It binds the accepted
policy digest into drill state and requires the install phase to use that exact
digest.

## 4. Rotation

Use an overlap window so a failed cutover does not require reverting to an older
policy:

1. Generate the replacement key pair on the approved signing host or HSM.
2. Record the new public-key SHA-256 fingerprint in the change request.
3. Issue policy sequence `N+1` with both the current and replacement keys
   `active`. Keep both public keys available during the overlap.
4. Sign a base and candidate release with the replacement key and run
   `release:rehearse` with the overlap policy.
5. Create release evidence, verify it offline, and retain the policy sidecar.
6. Distribute the new policy and public key atomically under change control.
7. After successful promotion, issue sequence `N+2` marking the old key
   `retired` and keeping the replacement key `active`.
8. Retain retired keys for historical evidence verification. Do not delete the
   policy history needed to verify retained releases.

Do not reuse a policy sequence for different content. If a mistake must be
corrected, issue a new, higher sequence rather than restoring an older file.

## 5. Revocation and Compromise

If a signing key is suspected compromised:

1. Stop promotions signed by that key and preserve relevant logs, archives, and
   evidence.
2. Issue the next policy sequence with the key marked `revoked`, including
   `revokedAt` and a concrete `revocationReason`.
3. Obtain security-owner approval and distribute the policy through the same
   controlled path as the public key.
4. Rebuild and re-sign the intended release with an approved key, then repeat
   audit, evidence, offline rehearsal, and the applicable hardware gate.
5. Review every release promoted during the suspected exposure window.

A revoked status is final for that fingerprint. Replacing a compromised key
requires a new key pair and a new fingerprint, not a status edit back to active.

## 6. Rollback and Retention

- Code rollback does not change the signer policy sequence or release evidence.
- Never restore an older trust-policy file in place. If an older authorization
  set is required, issue a new higher sequence containing only the keys and
  statuses that are currently approved.
- Retain the policy digest, signer fingerprint, signature, SBOM, audit, VEX, and
  evidence together for the release retention period.
- Evidence contains a protected copy of the policy used. Keep that sidecar with
  the evidence manifest; do not replace it with the current site policy.

## 7. Open Site Actions

The software gate is implemented, but a production promotion still requires:

- approved signing-key custody, backup, dual control, and HSM/KMS procedures;
- independent review of the first production policy and fingerprint list;
- a site-approved rotation calendar and emergency revocation contact;
- reconciliation of the first real-Pi `field:drill` policy binding with the
  change record.

