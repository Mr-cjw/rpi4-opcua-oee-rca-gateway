"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SIGNATURE_EXTENSION = ".sig";

function signaturePathFor(archivePath) {
  return `${archivePath}${SIGNATURE_EXTENSION}`;
}

function publicKeyFingerprint(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function archiveFingerprint(archive) {
  return crypto.createHash("sha256").update(archive).digest("hex");
}

async function signReleaseArchive({ archivePath, privateKeyPath, outputPath } = {}) {
  if (!archivePath) {
    throw new Error("release signing requires an archive path");
  }
  if (!privateKeyPath) {
    throw new Error("release signing requires a private key path");
  }
  const resolvedArchive = path.resolve(archivePath);
  const resolvedPrivateKey = path.resolve(privateKeyPath);
  const resolvedOutput = path.resolve(outputPath || signaturePathFor(resolvedArchive));
  if (resolvedOutput === resolvedArchive || resolvedOutput === resolvedPrivateKey) {
    throw new Error("release signature output must differ from the archive and private key");
  }
  const [archive, privateKeyPem] = await Promise.all([
    fsp.readFile(resolvedArchive),
    fsp.readFile(resolvedPrivateKey)
  ]);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new Error(`unable to read release signing key: ${error.message}`);
  }
  const signature = crypto.sign("sha256", archive, privateKey);
  await fsp.writeFile(resolvedOutput, signature, { mode: 0o644 });
  return {
    archivePath: resolvedArchive,
    archiveSha256: archiveFingerprint(archive),
    signaturePath: resolvedOutput,
    algorithm: "sha256",
    keyFingerprint: publicKeyFingerprint(crypto.createPublicKey(privateKey))
  };
}

async function verifyReleaseArchiveSignature({
  archivePath,
  signaturePath,
  publicKeyPath
} = {}) {
  if (!archivePath) {
    throw new Error("release signature verification requires an archive path");
  }
  if (!signaturePath) {
    throw new Error("release signature verification requires a signature path");
  }
  if (!publicKeyPath) {
    throw new Error("release signature verification requires a public key path");
  }
  const resolvedArchive = path.resolve(archivePath);
  const resolvedSignature = path.resolve(signaturePath);
  const [archive, signature, publicKeyPem] = await Promise.all([
    fsp.readFile(resolvedArchive),
    fsp.readFile(resolvedSignature),
    fsp.readFile(path.resolve(publicKeyPath))
  ]);
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (error) {
    throw new Error(`unable to read release verification key: ${error.message}`);
  }
  return {
    archivePath: resolvedArchive,
    archiveSha256: archiveFingerprint(archive),
    signaturePath: resolvedSignature,
    algorithm: "sha256",
    keyFingerprint: publicKeyFingerprint(publicKey),
    valid: crypto.verify("sha256", archive, publicKey, signature)
  };
}

module.exports = {
  SIGNATURE_EXTENSION,
  publicKeyFingerprint,
  signReleaseArchive,
  signaturePathFor,
  verifyReleaseArchiveSignature
};
