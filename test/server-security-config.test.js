"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");

test("mock PLC config defaults to anonymous None security", () => {
  const config = loadConfig({});

  assert.deepEqual(config.opcua.securityModes, ["None"]);
  assert.deepEqual(config.opcua.securityPolicies, ["None"]);
  assert.equal(config.opcua.allowAnonymous, true);
  assert.equal(config.opcua.username, "");
  assert.equal(config.opcua.password, "");
  assert.equal(config.opcua.trustUnknownClientCertificates, true);
});

test("mock PLC config supports secured endpoints and secret-file users", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-plc-security-"));
  const usernameFile = path.join(runDir, "username");
  const passwordFile = path.join(runDir, "password");
  try {
    await fs.writeFile(usernameFile, "cell-operator\n");
    await fs.writeFile(passwordFile, "replace-me\n");

    const config = loadConfig({
      MOCK_PLC_SECURITY_MODES: "Sign, SignAndEncrypt",
      MOCK_PLC_SECURITY_POLICIES: "Basic256Sha256,Aes128_Sha256_RsaOaep",
      MOCK_PLC_ALLOW_ANONYMOUS: "false",
      MOCK_PLC_USERNAME_FILE: usernameFile,
      MOCK_PLC_PASSWORD_FILE: passwordFile,
      MOCK_PLC_TRUST_UNKNOWN_CLIENT_CERTIFICATES: "false"
    });

    assert.deepEqual(config.opcua.securityModes, ["Sign", "SignAndEncrypt"]);
    assert.deepEqual(config.opcua.securityPolicies, [
      "Basic256Sha256",
      "Aes128_Sha256_RsaOaep"
    ]);
    assert.equal(config.opcua.allowAnonymous, false);
    assert.equal(config.opcua.username, "cell-operator");
    assert.equal(config.opcua.password, "replace-me");
    assert.equal(config.opcua.trustUnknownClientCertificates, false);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("mock PLC config rejects unusable security combinations", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-plc-security-invalid-"));
  const emptyFile = path.join(runDir, "empty");
  try {
    await fs.writeFile(emptyFile, "\n");

    assert.throws(
      () =>
        loadConfig({
          MOCK_PLC_SECURITY_MODES: "None,Sign",
          MOCK_PLC_SECURITY_POLICIES: "None,Basic256Sha256"
        }),
      /cannot mix None with secured modes/
    );
    assert.throws(
      () =>
        loadConfig({
          MOCK_PLC_SECURITY_MODES: "Sign",
          MOCK_PLC_SECURITY_POLICIES: "None"
        }),
      /must both select None or both select secured endpoints/
    );
    assert.throws(
      () => loadConfig({ MOCK_PLC_ALLOW_ANONYMOUS: "false" }),
      /requires MOCK_PLC_USERNAME and MOCK_PLC_PASSWORD/
    );
    assert.throws(
      () =>
        loadConfig({
          MOCK_PLC_ALLOW_ANONYMOUS: "false",
          MOCK_PLC_USERNAME_FILE: emptyFile,
          MOCK_PLC_PASSWORD_FILE: emptyFile
        }),
      /MOCK_PLC_USERNAME must not be empty/
    );
    assert.throws(
      () => loadConfig({ MOCK_PLC_SECURITY_MODES: "Aes256_Sha256_RsaPss" }),
      /MOCK_PLC_SECURITY_MODES/
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
