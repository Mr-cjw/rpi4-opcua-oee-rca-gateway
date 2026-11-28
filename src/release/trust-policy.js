"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  normalizeKeyFingerprint,
  signaturePathFor,
  verifyReleaseArchiveSignature
} = require("./signature");

const TRUST_POLICY_SCHEMA_VERSION = "1.0";
const TRUST_POLICY_KIND = "rpi4-gateway-release-trust-policy";
const SIGNER_STATUSES = Object.freeze(["active", "retired", "revoked"]);
const SIGNER_STATUS_SET = new Set(SIGNER_STATUSES);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return normalizeTimestamp(value, label);
}

function normalizeSequence(value, label = "trust policy sequence") {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeSigner(entry, index) {
  const label = `trust policy key ${index + 1}`;
  requireObject(entry, label);
  const name = requireString(entry.name, `${label} name`);
  if (name.length > 160) {
    throw new Error(`${label} name is too long`);
  }
  const fingerprint = normalizeKeyFingerprint(entry.fingerprint, `${label} fingerprint`);
  if (!SIGNER_STATUS_SET.has(entry.status)) {
    throw new Error(
      `${label} status must be one of ${SIGNER_STATUSES.join(", ")}`
    );
  }
  const notBefore = optionalTimestamp(entry.notBefore, `${label} notBefore`);
  const notAfter = optionalTimestamp(entry.notAfter, `${label} notAfter`);
  if (notBefore && notAfter && Date.parse(notBefore) >= Date.parse(notAfter)) {
    throw new Error(`${label} notBefore must be earlier than notAfter`);
  }

  let revokedAt = null;
  let revocationReason = null;
  if (entry.status === "revoked") {
    revokedAt = normalizeTimestamp(entry.revokedAt, `${label} revokedAt`);
    revocationReason = requireString(entry.revocationReason, `${label} revocationReason`);
  } else if (entry.revokedAt !== undefined && entry.revokedAt !== null) {
    throw new Error(`${label} revokedAt is only allowed for a revoked key`);
  } else if (entry.revocationReason !== undefined && entry.revocationReason !== null) {
    throw new Error(`${label} revocationReason is only allowed for a revoked key`);
  }

  return {
    name,
    fingerprint,
    status: entry.status,
    notBefore,
    notAfter,
    revokedAt,
    revocationReason
  };
}

function normalizeTrustPolicy(document) {
  requireObject(document, "release trust policy");
  if (document.schemaVersion !== TRUST_POLICY_SCHEMA_VERSION) {
    throw new Error(
      `release trust policy has an unsupported schema: ${document.schemaVersion || "missing"}`
    );
  }
  if (document.kind !== TRUST_POLICY_KIND) {
    throw new Error(
      `release trust policy has an unsupported kind: ${document.kind || "missing"}`
    );
  }
  const policyId = requireString(document.policyId, "release trust policy ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(policyId)) {
    throw new Error("release trust policy ID contains unsupported characters");
  }
  const sequence = normalizeSequence(document.sequence);
  const issuedAt = normalizeTimestamp(document.issuedAt, "release trust policy issuedAt");
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error("release trust policy must contain at least one key");
  }
  const keys = document.keys.map(normalizeSigner);
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key.fingerprint)) {
      throw new Error(`release trust policy repeats signer fingerprint ${key.fingerprint}`);
    }
    seen.add(key.fingerprint);
  }
  return {
    schemaVersion: TRUST_POLICY_SCHEMA_VERSION,
    kind: TRUST_POLICY_KIND,
    policyId,
    sequence,
    issuedAt,
    keys
  };
}

function policyHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function loadTrustPolicy({
  policyPath,
  expectedPolicySha256,
  minimumPolicySequence
} = {}) {
  if (!policyPath) {
    throw new Error("release trust policy verification requires a policy path");
  }
  const resolvedPath = path.resolve(policyPath);
  let content;
  try {
    content = await fsp.readFile(resolvedPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`release trust policy not found: ${resolvedPath}`);
    }
    throw error;
  }
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(`release trust policy is not valid JSON: ${error.message}`);
  }
  const policy = normalizeTrustPolicy(document);
  const policySha256 = policyHash(content);
  if (expectedPolicySha256 !== undefined && expectedPolicySha256 !== null) {
    const expected = normalizeKeyFingerprint(
      expectedPolicySha256,
      "expected trust policy SHA-256"
    );
    if (policySha256 !== expected) {
      throw new Error(
        `release trust policy SHA-256 mismatch: expected ${expected}, got ${policySha256}`
      );
    }
  }
  if (minimumPolicySequence !== undefined && minimumPolicySequence !== null) {
    const minimum = normalizeSequence(
      Number(minimumPolicySequence),
      "minimum trust policy sequence"
    );
    if (policy.sequence < minimum) {
      throw new Error(
        `release trust policy sequence ${policy.sequence} is older than required ${minimum}`
      );
    }
  }
  return {
    policy,
    policyPath: resolvedPath,
    policySha256,
    metadata: {
      policyId: policy.policyId,
      sequence: policy.sequence,
      issuedAt: policy.issuedAt,
      sha256: policySha256
    }
  };
}

function authorizeSigner({ policy, keyFingerprint, now = Date.now(), allowRetiredSigner = false }) {
  const normalizedFingerprint = normalizeKeyFingerprint(keyFingerprint);
  const key = policy.keys.find((entry) => entry.fingerprint === normalizedFingerprint);
  if (!key) {
    throw new Error(
      `release signer ${normalizedFingerprint} is not authorized by trust policy ${policy.policyId}`
    );
  }
  if (key.status === "revoked") {
    throw new Error(
      `release signer ${normalizedFingerprint} was revoked by trust policy ` +
        `${policy.policyId} at ${key.revokedAt}: ${key.revocationReason}`
    );
  }
  const nowMs = typeof now === "function" ? now() : now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) {
    throw new Error("release trust policy evaluation requires a valid current time");
  }
  if (key.notBefore && nowMs < Date.parse(key.notBefore)) {
    throw new Error(
      `release signer ${normalizedFingerprint} is not valid before ${key.notBefore}`
    );
  }
  if (key.status === "retired" && allowRetiredSigner !== true) {
    throw new Error(
      `release signer ${normalizedFingerprint} is retired; use --allow-retired-signer only ` +
        "for historical verification"
    );
  }
  if (key.status === "active" && key.notAfter && nowMs >= Date.parse(key.notAfter)) {
    throw new Error(
      `release signer ${normalizedFingerprint} expired at ${key.notAfter}`
    );
  }
  return { ...key };
}

function assertTrustPolicyContinuity({ policy, policySha256, previousTrustPolicy }) {
  if (!previousTrustPolicy) {
    return;
  }
  if (
    typeof previousTrustPolicy.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(previousTrustPolicy.sha256) ||
    !Number.isInteger(previousTrustPolicy.sequence)
  ) {
    throw new Error("previous release trust policy record is invalid");
  }
  if (previousTrustPolicy.sha256 === policySha256) {
    return;
  }
  if (policy.sequence <= previousTrustPolicy.sequence) {
    throw new Error(
      `release trust policy rollback detected: current sequence ${policy.sequence} is not ` +
        `newer than previous sequence ${previousTrustPolicy.sequence}`
    );
  }
}

async function verifyReleaseWithTrustPolicy({
  archivePath,
  signaturePath,
  publicKeyPath,
  trustPolicyPath,
  expectedKeyFingerprint,
  expectedPolicySha256,
  minimumPolicySequence,
  allowRetiredSigner = false,
  previousTrustPolicy,
  now
} = {}) {
  if (!archivePath) {
    throw new Error("trust policy signature verification requires an archive path");
  }
  if (!publicKeyPath) {
    throw new Error("trust policy signature verification requires a public key path");
  }
  const loaded = await loadTrustPolicy({
    policyPath: trustPolicyPath,
    expectedPolicySha256,
    minimumPolicySequence
  });
  assertTrustPolicyContinuity({
    policy: loaded.policy,
    policySha256: loaded.policySha256,
    previousTrustPolicy
  });
  const resolvedSignaturePath = signaturePath || signaturePathFor(archivePath);
  const signature = await verifyReleaseArchiveSignature({
    archivePath,
    signaturePath: resolvedSignaturePath,
    publicKeyPath,
    expectedKeyFingerprint
  });
  if (!signature.valid) {
    throw new Error(`release signature verification failed: ${signature.signaturePath}`);
  }
  const signer = authorizeSigner({
    policy: loaded.policy,
    keyFingerprint: signature.keyFingerprint,
    now: now === undefined ? Date.now() : now,
    allowRetiredSigner
  });
  return {
    ...signature,
    signerName: signer.name,
    signerStatus: signer.status,
    trustPolicy: loaded.metadata
  };
}

module.exports = {
  SIGNER_STATUSES,
  TRUST_POLICY_KIND,
  TRUST_POLICY_SCHEMA_VERSION,
  assertTrustPolicyContinuity,
  authorizeSigner,
  loadTrustPolicy,
  normalizeTrustPolicy,
  verifyReleaseWithTrustPolicy
};
