"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { hashFile } = require("../src/release/common");
const {
  publicKeyFingerprint,
  signReleaseArchive
} = require("../src/release/signature");
const {
  TRUST_POLICY_KIND,
  TRUST_POLICY_SCHEMA_VERSION,
  assertTrustPolicyContinuity,
  loadTrustPolicy,
  normalizeTrustPolicy,
  verifyReleaseWithTrustPolicy
} = require("../src/release/trust-policy");

const NOW = Date.parse("2026-11-28T06:00:00.000Z");

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-trust-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createSigner(root, name) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = path.join(root, `${name}-private.pem`);
  const publicKeyPath = path.join(root, `${name}-public.pem`);
  await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  return {
    name,
    privateKeyPath,
    publicKeyPath,
    keyFingerprint: publicKeyFingerprint(publicKey)
  };
}

async function signFixture(root, signer, archiveName = "release.tar.gz") {
  const archivePath = path.join(root, archiveName);
  await fs.writeFile(archivePath, `release bytes for ${signer.name}\n`);
  const signed = await signReleaseArchive({
    archivePath,
    privateKeyPath: signer.privateKeyPath
  });
  return { archivePath, ...signed };
}

function policy(keys, overrides = {}) {
  return {
    schemaVersion: TRUST_POLICY_SCHEMA_VERSION,
    kind: TRUST_POLICY_KIND,
    policyId: "pilot-release-2026",
    sequence: 2,
    issuedAt: "2026-11-01T00:00:00.000Z",
    keys,
    ...overrides
  };
}

function keyEntry(signer, overrides = {}) {
  return {
    name: signer.name,
    fingerprint: signer.keyFingerprint,
    status: "active",
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: null,
    ...overrides
  };
}

async function writePolicy(root, value, fileName = "trust-policy.json") {
  const policyPath = path.join(root, fileName);
  await fs.writeFile(policyPath, `${JSON.stringify(value, null, 2)}\n`);
  return policyPath;
}

test("trust policy authorizes an active signer and binds policy identity", async (t) => {
  const root = await makeRoot(t);
  const signer = await createSigner(root, "primary");
  const signed = await signFixture(root, signer);
  const policyPath = await writePolicy(root, policy([keyEntry(signer)]));
  const policySha256 = await hashFile(policyPath);

  const result = await verifyReleaseWithTrustPolicy({
    archivePath: signed.archivePath,
    signaturePath: signed.signaturePath,
    publicKeyPath: signer.publicKeyPath,
    trustPolicyPath: policyPath,
    expectedKeyFingerprint: signer.keyFingerprint,
    expectedPolicySha256: policySha256,
    minimumPolicySequence: 2,
    now: NOW
  });
  assert.equal(result.valid, true);
  assert.equal(result.signerName, "primary");
  assert.equal(result.signerStatus, "active");
  assert.equal(result.trustPolicy.policyId, "pilot-release-2026");
  assert.equal(result.trustPolicy.sequence, 2);
  assert.equal(result.trustPolicy.sha256, policySha256);

  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: signed.archivePath,
      signaturePath: signed.signaturePath,
      publicKeyPath: signer.publicKeyPath,
      trustPolicyPath: policyPath,
      expectedPolicySha256: "0".repeat(64),
      now: NOW
    }),
    /trust policy SHA-256 mismatch/
  );
  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: signed.archivePath,
      signaturePath: signed.signaturePath,
      publicKeyPath: signer.publicKeyPath,
      trustPolicyPath: policyPath,
      minimumPolicySequence: 3,
      now: NOW
    }),
    /older than required 3/
  );
});

test("trust policy supports rotation overlap and historical retired keys", async (t) => {
  const root = await makeRoot(t);
  const oldSigner = await createSigner(root, "old");
  const newSigner = await createSigner(root, "new");
  const overlapPolicy = await writePolicy(
    root,
    policy([keyEntry(oldSigner), keyEntry(newSigner)]),
    "overlap-policy.json"
  );
  const oldRelease = await signFixture(root, oldSigner, "old-release.tar.gz");
  const newRelease = await signFixture(root, newSigner, "new-release.tar.gz");

  for (const [signer, release] of [
    [oldSigner, oldRelease],
    [newSigner, newRelease]
  ]) {
    const verified = await verifyReleaseWithTrustPolicy({
      archivePath: release.archivePath,
      signaturePath: release.signaturePath,
      publicKeyPath: signer.publicKeyPath,
      trustPolicyPath: overlapPolicy,
      now: NOW
    });
    assert.equal(verified.signerName, signer.name);
    assert.equal(verified.signerStatus, "active");
  }

  const retiredPolicy = await writePolicy(
    root,
    policy([keyEntry(oldSigner, { status: "retired" }), keyEntry(newSigner)]),
    "retired-policy.json"
  );
  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: oldRelease.archivePath,
      signaturePath: oldRelease.signaturePath,
      publicKeyPath: oldSigner.publicKeyPath,
      trustPolicyPath: retiredPolicy,
      now: NOW
    }),
    /is retired/
  );
  const historical = await verifyReleaseWithTrustPolicy({
    archivePath: oldRelease.archivePath,
    signaturePath: oldRelease.signaturePath,
    publicKeyPath: oldSigner.publicKeyPath,
    trustPolicyPath: retiredPolicy,
    allowRetiredSigner: true,
    now: NOW
  });
  assert.equal(historical.signerStatus, "retired");
});

test("trust policy rejects unapproved and revoked signers", async (t) => {
  const root = await makeRoot(t);
  const approved = await createSigner(root, "approved");
  const unapproved = await createSigner(root, "unapproved");
  const release = await signFixture(root, unapproved);
  const approvedPolicy = await writePolicy(root, policy([keyEntry(approved)]));
  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: release.archivePath,
      signaturePath: release.signaturePath,
      publicKeyPath: unapproved.publicKeyPath,
      trustPolicyPath: approvedPolicy,
      now: NOW
    }),
    /is not authorized by trust policy/
  );

  const revokedPolicy = await writePolicy(
    root,
    policy([
      keyEntry(unapproved, {
        status: "revoked",
        revokedAt: "2026-11-20T00:00:00.000Z",
        revocationReason: "signing host compromise"
      })
    ]),
    "revoked-policy.json"
  );
  for (const allowRetiredSigner of [false, true]) {
    await assert.rejects(
      verifyReleaseWithTrustPolicy({
        archivePath: release.archivePath,
        signaturePath: release.signaturePath,
        publicKeyPath: unapproved.publicKeyPath,
        trustPolicyPath: revokedPolicy,
        allowRetiredSigner,
        now: NOW
      }),
      /was revoked by trust policy/
    );
  }
});

test("trust policy validates malformed documents and key status fields", async (t) => {
  const root = await makeRoot(t);
  const signer = await createSigner(root, "invalid");
  const signerKey = keyEntry(signer);
  const cases = [
    [{ ...policy([signerKey]), kind: "other" }, /unsupported kind/],
    [{ ...policy([signerKey]), schemaVersion: "2.0" }, /unsupported schema/],
    [{ ...policy([]) }, /at least one key/],
    [{ ...policy([signerKey, signerKey]) }, /repeats signer fingerprint/],
    [{ ...policy([signerKey]), sequence: 0 }, /positive integer/],
    [{ ...policy([signerKey]), issuedAt: "not-a-date" }, /ISO-8601 timestamp/],
    [
      {
        ...policy([keyEntry(signer, { status: "revoked" })])
      },
      /revokedAt must be an ISO-8601 timestamp/
    ],
    [
      {
        ...policy([
          keyEntry(signer, {
            status: "revoked",
            revokedAt: "2026-11-20T00:00:00.000Z"
          })
        ])
      },
      /revocationReason must be a non-empty string/
    ],
    [
      {
        ...policy([keyEntry(signer, { status: "retired", revokedAt: "2026-11-20T00:00:00.000Z" })])
      },
      /revokedAt is only allowed/
    ]
  ];
  for (const [document, expected] of cases) {
    await assert.rejects(loadTrustPolicy({
      policyPath: await writePolicy(root, document, `invalid-${Math.random()}.json`)
    }), expected);
  }

  await assert.rejects(
    loadTrustPolicy({ policyPath: path.join(root, "missing.json") }),
    /trust policy not found/
  );
  await fs.writeFile(path.join(root, "broken.json"), "{not json\n");
  await assert.rejects(
    loadTrustPolicy({ policyPath: path.join(root, "broken.json") }),
    /not valid JSON/
  );
});

test("trust policy rejects signer validity windows and policy rollback", async (t) => {
  const root = await makeRoot(t);
  const signer = await createSigner(root, "window");
  const release = await signFixture(root, signer);
  const futurePolicy = await writePolicy(
    root,
    policy([keyEntry(signer, { notBefore: "2026-12-01T00:00:00.000Z" })]),
    "future-policy.json"
  );
  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: release.archivePath,
      signaturePath: release.signaturePath,
      publicKeyPath: signer.publicKeyPath,
      trustPolicyPath: futurePolicy,
      now: NOW
    }),
    /is not valid before/
  );

  const expiredPolicy = await writePolicy(
    root,
    policy([keyEntry(signer, { notAfter: "2026-11-01T00:00:00.000Z" })]),
    "expired-policy.json"
  );
  await assert.rejects(
    verifyReleaseWithTrustPolicy({
      archivePath: release.archivePath,
      signaturePath: release.signaturePath,
      publicKeyPath: signer.publicKeyPath,
      trustPolicyPath: expiredPolicy,
      now: NOW
    }),
    /expired at/
  );

  const current = normalizeTrustPolicy(policy([keyEntry(signer)], { sequence: 3 }));
  assert.throws(
    () =>
      assertTrustPolicyContinuity({
        policy: current,
        policySha256: "b".repeat(64),
        previousTrustPolicy: { sequence: 3, sha256: "a".repeat(64) }
      }),
    /rollback detected/
  );
  assert.throws(
    () =>
      assertTrustPolicyContinuity({
        policy: current,
        policySha256: "b".repeat(64),
        previousTrustPolicy: { sequence: 4, sha256: "a".repeat(64) }
      }),
    /rollback detected/
  );
  assert.doesNotThrow(() =>
    assertTrustPolicyContinuity({
      policy: current,
      policySha256: "b".repeat(64),
      previousTrustPolicy: { sequence: 2, sha256: "a".repeat(64) }
    })
  );
  assert.doesNotThrow(() =>
    assertTrustPolicyContinuity({
      policy: current,
      policySha256: "a".repeat(64),
      previousTrustPolicy: { sequence: 3, sha256: "a".repeat(64) }
    })
  );
});
