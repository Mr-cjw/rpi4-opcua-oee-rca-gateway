"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  OPCUACertificateManager,
  OPCUAClient,
  UserTokenType,
  coerceMessageSecurityMode,
  coerceSecurityPolicy
} = require("node-opcua");
const { loadConfig } = require("../src/config");
const { createMockPlcServer } = require("../src/server");
const { loadGatewayConfig } = require("../src/gateway/config");
const { GatewayRuntime } = require("../src/gateway/runtime");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`
  );
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

function certificateToDer(pem) {
  const match = pem.toString().match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
  );
  if (!match) {
    throw new Error("expected a PEM encoded certificate");
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

async function trustCertificateAt(rootFolder, certificatePath) {
  const certificateManager = new OPCUACertificateManager({
    rootFolder,
    automaticallyAcceptUnknownCertificate: false
  });
  await certificateManager.initialize();
  try {
    await certificateManager.trustCertificate(
      certificateToDer(await fs.readFile(certificatePath))
    );
  } finally {
    await certificateManager.dispose();
  }
}

async function trustServerCertificate(clientPkiRoot, certificatePath) {
  await trustCertificateAt(
    path.join(clientPkiRoot, "gateway-client"),
    certificatePath
  );
}

function serverEnvironment({ port, pkiRoot, usernameFile, passwordFile }) {
  return loadConfig({
    OPCUA_HOST: "127.0.0.1",
    OPCUA_HOSTNAME: "localhost",
    OPCUA_PORT: String(port),
    OPCUA_PKI_ROOT: pkiRoot,
    MOCK_PLC_SECURITY_MODES: "Sign,SignAndEncrypt",
    MOCK_PLC_SECURITY_POLICIES: "Basic256Sha256",
    MOCK_PLC_ALLOW_ANONYMOUS: "false",
    MOCK_PLC_USERNAME_FILE: usernameFile,
    MOCK_PLC_PASSWORD_FILE: passwordFile,
    MOCK_PLC_TRUST_UNKNOWN_CLIENT_CERTIFICATES: "true",
    SIM_INTERVAL_MS: "50",
    SIM_DOWNTIME_RATE_PER_MIN: "0",
    SIM_TEMP_SPIKE_RATE_PER_MIN: "0",
    SIM_SEED: "91",
    SIM_YIELD_RATE: "0.98"
  });
}

async function startServer(environment, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const server = createMockPlcServer(environment);
    try {
      const running = await server.start();
      const certificatePath = path.join(
        environment.opcua.pkiRoot,
        "server",
        "own",
        "certs",
        "certificate.pem"
      );
      await waitFor(
        () => fileExists(certificatePath),
        10000,
        "the Mock PLC server certificate"
      );
      return { server, running, certificatePath };
    } catch (error) {
      lastError = error;
      await server.stop().catch(() => undefined);
      if (attempt < attempts) {
        await sleep(300 * attempt);
      }
    }
  }
  throw lastError;
}

function gatewayEnvironment({
  endpointUrl,
  clientPkiRoot,
  securityMode,
  usernameFile,
  passwordFile
}) {
  return loadGatewayConfig({
    OPCUA_ENDPOINT: endpointUrl,
    OPCUA_CLIENT_PKI_ROOT: clientPkiRoot,
    OPCUA_SECURITY_MODE: securityMode,
    OPCUA_SECURITY_POLICY: "Basic256Sha256",
    OPCUA_TRUST_UNKNOWN_CERTIFICATES: "false",
    OPCUA_USERNAME_FILE: usernameFile,
    OPCUA_PASSWORD_FILE: passwordFile,
    OPCUA_PUBLISHING_INTERVAL_MS: "100",
    OPCUA_SAMPLING_INTERVAL_MS: "100",
    OPCUA_RECONNECT_MIN_DELAY_MS: "100",
    OPCUA_RECONNECT_MAX_DELAY_MS: "500",
    PROCESS_CONTEXT_LOG: "off",
    QUALITY_EVENT_LOG: "off",
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
    PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "100",
    GATEWAY_WORK_CONTEXT_FILE: "off",
    GATEWAY_HTTP_PORT: "0"
  });
}

async function startGateway(config, label) {
  const logRecords = [];
  const runtime = new GatewayRuntime(config, {
    logger: {
      info(record) {
        logRecords.push(record);
      },
      warn(record) {
        logRecords.push(record);
      },
      error(record) {
        logRecords.push(record);
      }
    }
  });
  try {
    await withTimeout(runtime.start(), 45000, `${label} startup`);
    assert.equal(runtime.getStatus().opcuaConnected, true, `${label} must connect`);
    return { runtime, logRecords };
  } catch (error) {
    if (process.env.DEBUG_SECURITY_E2E === "1") {
      console.error(JSON.stringify(logRecords, null, 2));
    }
    await runtime.stop().catch(() => undefined);
    throw error;
  }
}

async function expectSessionRejected({
  endpointUrl,
  certificatePath,
  clientPkiRoot,
  identity,
  description
}) {
  const certificateManagerRoot = path.join(clientPkiRoot, "client");
  await trustCertificateAt(certificateManagerRoot, certificatePath);
  const certificateManager = new OPCUACertificateManager({
    rootFolder: certificateManagerRoot,
    automaticallyAcceptUnknownCertificate: false
  });
  await certificateManager.initialize();

  const client = OPCUAClient.create({
    applicationName: `RPI4-Security-E2E-${description}`,
    applicationUri: `urn:rpi4:security-e2e:${description.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    clientCertificateManager: certificateManager,
    endpointMustExist: false,
    securityMode: coerceMessageSecurityMode("SignAndEncrypt"),
    securityPolicy: coerceSecurityPolicy("Basic256Sha256"),
    connectionStrategy: {
      initialDelay: 100,
      maxDelay: 500,
      maxRetry: 1,
      randomisationFactor: 0
    }
  });

  try {
    await withTimeout(client.connect(endpointUrl), 15000, `${description} connection`);
    let rejection;
    try {
      await withTimeout(client.createSession(identity), 10000, `${description} session`);
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, `${description} unexpectedly created a session`);
    assert.doesNotMatch(rejection.message, /timed out/, `${description} must fail explicitly`);
  } finally {
    await client.disconnect().catch(() => undefined);
    await certificateManager.dispose().catch(() => undefined);
  }
}

async function main() {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-gateway-security-e2e-"));
  const port = await getFreePort();
  const serverPki1 = path.join(runDir, "server-pki-1");
  const serverPki2 = path.join(runDir, "server-pki-2");
  const clientPki = path.join(runDir, "client-pki");
  const usernameFile = path.join(runDir, "username");
  const passwordFile = path.join(runDir, "password");
  const wrongPasswordFile = path.join(runDir, "wrong-password");
  const username = "security-e2e-operator";
  const password = "security-e2e-password";

  await fs.writeFile(usernameFile, `${username}\n`);
  await fs.writeFile(passwordFile, `${password}\n`);
  await fs.writeFile(wrongPasswordFile, "not-the-password\n");

  let started = null;
  let runtime = null;
  try {
    started = await startServer(
      serverEnvironment({
        port,
        pkiRoot: serverPki1,
        usernameFile,
        passwordFile
      })
    );
    await trustServerCertificate(clientPki, started.certificatePath);
    console.log(`Secure OPC UA endpoint: ${started.running.endpointUrl}`);

    const sign = await startGateway(
      gatewayEnvironment({
        endpointUrl: started.running.endpointUrl,
        clientPkiRoot: clientPki,
        securityMode: "Sign",
        usernameFile,
        passwordFile
      }),
      "Sign gateway"
    );
    runtime = sign.runtime;
    assert.equal(runtime.config.securityMode, "Sign");
    assert.equal(runtime.config.username, username);
    assert.ok(runtime.client.getStatus().variables.length >= 4);
    assert.equal(JSON.stringify(sign.logRecords).includes(password), false);
    await runtime.stop();
    runtime = null;
    console.log("Verified Sign with username authentication from secret files.");

    const encryptedConfig = gatewayEnvironment({
      endpointUrl: started.running.endpointUrl,
      clientPkiRoot: clientPki,
      securityMode: "SignAndEncrypt",
      usernameFile,
      passwordFile
    });
    const encrypted = await startGateway(encryptedConfig, "SignAndEncrypt gateway");
    runtime = encrypted.runtime;
    assert.equal(runtime.config.securityMode, "SignAndEncrypt");
    assert.equal(JSON.stringify(encrypted.logRecords).includes(password), false);
    console.log("Verified SignAndEncrypt with username authentication.");

    await expectSessionRejected({
      endpointUrl: started.running.endpointUrl,
      certificatePath: started.certificatePath,
      clientPkiRoot: path.join(runDir, "wrong-password-client"),
      identity: {
        type: UserTokenType.UserName,
        userName: username,
        password: "not-the-password"
      },
      description: "wrong-password"
    });
    await expectSessionRejected({
      endpointUrl: started.running.endpointUrl,
      certificatePath: started.certificatePath,
      clientPkiRoot: path.join(runDir, "anonymous-client"),
      identity: { type: UserTokenType.Anonymous },
      description: "anonymous"
    });
    console.log("Verified wrong credentials and anonymous access are rejected.");

    const originalCertificate = await fs.readFile(started.certificatePath);
    await started.server.stop();
    started = null;
    await waitFor(
      () => runtime.getStatus().opcuaConnected === false,
      10000,
      "Gateway disconnect after the PLC stops"
    );

    started = await startServer(
      serverEnvironment({
        port,
        pkiRoot: serverPki2,
        usernameFile,
        passwordFile
      })
    );
    const rotatedCertificate = await fs.readFile(started.certificatePath);
    assert.notDeepEqual(rotatedCertificate, originalCertificate);
    await sleep(1500);
    assert.equal(
      runtime.getStatus().opcuaConnected,
      false,
      "an untrusted rotated certificate must not be accepted"
    );

    await trustServerCertificate(clientPki, started.certificatePath);
    const trustedFolder = path.join(clientPki, "gateway-client", "trusted", "certs");
    const trustedFiles = await fs.readdir(trustedFolder);
    const trustedContents = await Promise.all(
      trustedFiles.map((filename) => fs.readFile(path.join(trustedFolder, filename)))
    );
    assert.ok(
      trustedContents.some((contents) =>
        certificateToDer(contents).equals(certificateToDer(rotatedCertificate))
      ),
      "the rotated certificate must be present in the client trust folder"
    );
    const verificationManager = new OPCUACertificateManager({
      rootFolder: path.join(clientPki, "gateway-client"),
      automaticallyAcceptUnknownCertificate: false
    });
    await verificationManager.initialize();
    const verifyStatus = await verificationManager.getTrustStatus(
      certificateToDer(rotatedCertificate)
    );
    await verificationManager.dispose();
    assert.equal(verifyStatus.value, 0, "the rotated certificate must have Good trust status");
    await runtime.stop();
    runtime = null;
    const restarted = await startGateway(encryptedConfig, "rotated-certificate gateway");
    runtime = restarted.runtime;
    assert.equal(runtime.getStatus().status, "ok");
    console.log(
      "Verified certificate rotation requires an explicit trust update and Gateway restart."
    );
    console.log("Gateway security E2E test passed.");
  } finally {
    if (runtime) {
      await runtime.stop().catch(() => undefined);
    }
    if (started) {
      await started.server.stop().catch(() => undefined);
    }
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Gateway security E2E test failed:", error);
  process.exitCode = 1;
});
