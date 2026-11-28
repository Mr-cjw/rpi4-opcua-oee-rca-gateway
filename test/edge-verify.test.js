"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseEdgeArgs, verifyEdge } = require("../src/edge/verify");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function edgeHeaders() {
  return {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  };
}

test("edge verifier checks TLS, redirects, health, headers, and bearer auth", { timeout: 30000 }, async (t) => {
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (openssl.error) {
    t.skip("openssl is required to generate the local test certificate");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-edge-verify-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const certPath = path.join(root, "cert.pem");
  const keyPath = path.join(root, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1"
    ],
    { stdio: "ignore" }
  );
  const tokenPath = path.join(root, "api-token");
  await fs.writeFile(tokenPath, "test-edge-token\n", { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
  const wrongTokenPath = path.join(root, "wrong-api-token");
  await fs.writeFile(wrongTokenPath, "wrong-token\n", { mode: 0o600 });
  await fs.chmod(wrongTokenPath, 0o600);

  const secure = https.createServer(
    {
      key: await fs.readFile(keyPath),
      cert: await fs.readFile(certPath),
      minVersion: "TLSv1.2"
    },
    (request, response) => {
      const headers = edgeHeaders();
      if (request.url === "/healthz") {
        Object.assign(headers, { "cache-control": "no-store" });
        response.writeHead(200, headers);
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/metrics") {
        if (request.headers.authorization !== "Bearer test-edge-token") {
          response.writeHead(401, headers);
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response.writeHead(200, { ...headers, "content-type": "text/plain" });
        response.end("rpi4_gateway_up 1\n");
        return;
      }
      if (request.url === "/v1/work-context") {
        if (request.headers.authorization !== "Bearer test-edge-token") {
          response.writeHead(401, headers);
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response.writeHead(200, headers);
        response.end(JSON.stringify({ workOrderId: null }));
        return;
      }
      response.writeHead(404, headers);
      response.end(JSON.stringify({ error: "not found" }));
    }
  );
  const httpsPort = await listen(secure);
  t.after(() => close(secure));

  const redirect = http.createServer((request, response) => {
    response.writeHead(301, {
      location: `https://127.0.0.1:${httpsPort}/healthz`
    });
    response.end();
  });
  const httpPort = await listen(redirect);
  t.after(() => close(redirect));

  const report = await verifyEdge({
    url: `https://127.0.0.1:${httpsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    tokenFile: tokenPath,
    caFile: certPath,
    clientCertFile: null,
    clientKeyFile: null,
    minCertDays: 14,
    timeoutMs: 5000,
    skipHttpRedirect: false,
    originUrl: null,
    strict: true
  });

  assert.equal(report.overallStatus, "pass");
  assert.equal(report.exitCode, 0);
  for (const name of [
    "http_redirect",
    "tls_1_2",
    "tls_1_3",
    "certificate",
    "health",
    "security_headers",
    "metrics_auth_required",
    "metrics_authenticated",
    "api_auth_required",
    "api_authenticated",
    "unknown_path"
  ]) {
    assert.equal(report.checks.find((item) => item.name === name)?.status, "pass", name);
  }
  assert.notEqual(report.checks.find((item) => item.name === "tls_1_1_rejected")?.status, "fail");
  assert.doesNotMatch(JSON.stringify(report), /test-edge-token/);

  const rejected = await verifyEdge({
    url: `https://127.0.0.1:${httpsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    tokenFile: wrongTokenPath,
    caFile: certPath,
    clientCertFile: null,
    clientKeyFile: null,
    minCertDays: 14,
    timeoutMs: 5000,
    skipHttpRedirect: true,
    originUrl: null,
    strict: true
  });
  assert.equal(rejected.overallStatus, "fail");
  assert.equal(rejected.exitCode, 1);
  assert.equal(
    rejected.checks.find((item) => item.name === "metrics_authenticated")?.status,
    "fail"
  );
});

test("edge verifier rejects unsafe command-line configuration", () => {
  assert.throws(() => parseEdgeArgs([]), /--url is required/);
  assert.throws(() => parseEdgeArgs(["--url"]), /requires a value/);
  assert.throws(
    () => parseEdgeArgs(["--url", "https://gateway.example", "--timeout-ms", "0"]),
    /positive integer/
  );
  assert.throws(
    () => parseEdgeArgs(["--url", "https://gateway.example", "--token", "secret"]),
    /unknown option/
  );
});
