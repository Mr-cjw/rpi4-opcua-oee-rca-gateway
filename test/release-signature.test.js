"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  normalizeKeyFingerprint,
  signReleaseArchive,
  signaturePathFor,
  verifyReleaseArchiveSignature
} = require("../src/release/signature");

test("release signatures verify the exact archive and reject tampering", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-release-signature-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "release.tar.gz");
  const privateKeyPath = path.join(root, "signing-key.pem");
  const publicKeyPath = path.join(root, "signing-public.pem");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(archivePath, "release archive bytes\n");
  await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

  const signed = await signReleaseArchive({ archivePath, privateKeyPath });
  assert.equal(signed.signaturePath, signaturePathFor(archivePath));
  assert.match(signed.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(signed.keyFingerprint, /^[0-9a-f]{64}$/);

  const verified = await verifyReleaseArchiveSignature({
    archivePath,
    signaturePath: signed.signaturePath,
    publicKeyPath
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.archiveSha256, signed.archiveSha256);
  assert.equal(verified.keyFingerprint, signed.keyFingerprint);

  const colonFingerprint = signed.keyFingerprint.match(/.{2}/g).join(":").toUpperCase();
  const pinned = await verifyReleaseArchiveSignature({
    archivePath,
    signaturePath: signed.signaturePath,
    publicKeyPath,
    expectedKeyFingerprint: `sha256:${colonFingerprint}`
  });
  assert.equal(pinned.expectedKeyFingerprint, signed.keyFingerprint);
  assert.equal(normalizeKeyFingerprint(colonFingerprint), signed.keyFingerprint);
  await assert.rejects(
    verifyReleaseArchiveSignature({
      archivePath,
      signaturePath: signed.signaturePath,
      publicKeyPath,
      expectedKeyFingerprint: "0".repeat(64)
    }),
    /release signer fingerprint mismatch/
  );
  await assert.rejects(
    verifyReleaseArchiveSignature({
      archivePath,
      signaturePath: signed.signaturePath,
      publicKeyPath,
      expectedKeyFingerprint: "not-a-fingerprint"
    }),
    /must be a SHA-256 hex digest/
  );

  await fs.appendFile(archivePath, "tampered\n");
  const tampered = await verifyReleaseArchiveSignature({
    archivePath,
    signaturePath: signed.signaturePath,
    publicKeyPath
  });
  assert.equal(tampered.valid, false);
});

test("release signature verification reports missing inputs clearly", async () => {
  await assert.rejects(
    verifyReleaseArchiveSignature({ archivePath: "release.tar.gz" }),
    /requires a signature path/
  );
  await assert.rejects(
    signReleaseArchive({ archivePath: "release.tar.gz" }),
    /requires a private key path/
  );
  await assert.rejects(
    signReleaseArchive({
      archivePath: "release.tar.gz",
      privateKeyPath: "signing-key.pem",
      outputPath: "signing-key.pem"
    }),
    /must differ from the archive and private key/
  );
});
