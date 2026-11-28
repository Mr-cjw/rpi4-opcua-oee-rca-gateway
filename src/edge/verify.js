"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);

function check(name, status, summary, details = {}) {
  return { name, status, summary, details };
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

function stripIpv6Brackets(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function normalizedHostname(url) {
  return stripIpv6Brackets(url.hostname);
}

function servernameFor(url) {
  const hostname = normalizedHostname(url);
  return net.isIP(hostname) ? undefined : hostname;
}

function portFor(url) {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function parseAbsoluteUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed;
}

function healthUrl(baseUrl) {
  const url = new URL(baseUrl.toString());
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url;
}

function defaultHttpUrl(httpsUrl) {
  const url = new URL(httpsUrl.toString());
  url.protocol = "http:";
  url.port = "";
  return healthUrl(url);
}

function tlsSocketOptions(url, options, overrides = {}) {
  return {
    host: normalizedHostname(url),
    port: portFor(url),
    servername: servernameFor(url),
    ca: options.ca,
    cert: options.clientCertificate,
    key: options.clientKey,
    rejectUnauthorized: true,
    timeout: options.timeoutMs,
    ...overrides
  };
}

function probeTls(url, options, overrides = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    try {
      socket = tls.connect(tlsSocketOptions(url, options, overrides));
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`TLS handshake timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timer.unref?.();

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const cipher = socket.getCipher();
      const result = {
        protocol: socket.getProtocol(),
        cipher: cipher?.name || null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || null,
        certificate: certificate && Object.keys(certificate).length > 0 ? certificate : null
      };
      socket.end();
      finish(null, result);
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      finish(new Error("TLS connection closed before the handshake completed"));
    });
  });
}

function probeHttp(url, options, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const requestOptions = {
      method: "GET",
      hostname: normalizedHostname(url),
      port: portFor(url),
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        connection: "close",
        ...extraHeaders
      },
      agent: false
    };
    if (url.protocol === "https:") {
      Object.assign(requestOptions, {
        servername: servernameFor(url),
        ca: options.ca,
        cert: options.clientCertificate,
        key: options.clientKey,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2"
      });
    }

    let settled = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const request = transport.request(requestOptions, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        finish(null, {
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`HTTP request timed out after ${options.timeoutMs} ms`));
    });
    request.once("error", (error) => finish(error));
    request.end();
  });
}

async function fileModeCheck(filePath, name, label) {
  if (process.platform === "win32") {
    return check(name, "skip", `${label} permission checks are not available on Windows`);
  }
  const stats = await fs.stat(filePath);
  const exposedBits = stats.mode & 0o077;
  if (exposedBits !== 0) {
    return check(
      name,
      "fail",
      `${label} is accessible by group or other users`,
      { mode: (stats.mode & 0o777).toString(8), path: filePath }
    );
  }
  return check(name, "pass", `${label} is owner-only`, {
    mode: (stats.mode & 0o777).toString(8),
    path: filePath
  });
}

async function loadToken(options, checks) {
  let token = "";
  if (options.tokenFile) {
    checks.push(await fileModeCheck(options.tokenFile, "token_file_permissions", "token file"));
    token = (await fs.readFile(options.tokenFile, "utf8")).trim();
  } else if (process.env.GATEWAY_API_TOKEN) {
    token = process.env.GATEWAY_API_TOKEN.trim();
  }
  return token || null;
}

async function loadTlsMaterial(options, checks) {
  const material = {
    ca: options.caFile ? await fs.readFile(options.caFile) : undefined,
    clientCertificate: undefined,
    clientKey: undefined
  };
  if (Boolean(options.clientCertFile) !== Boolean(options.clientKeyFile)) {
    throw new Error("--client-cert-file and --client-key-file must be provided together");
  }
  if (options.clientKeyFile) {
    checks.push(
      await fileModeCheck(options.clientKeyFile, "client_key_permissions", "client private key")
    );
    material.clientCertificate = await fs.readFile(options.clientCertFile);
    material.clientKey = await fs.readFile(options.clientKeyFile);
  }
  return material;
}

function certificateCheck(tls13, tls12, minimumDays) {
  const result = tls13 || tls12;
  if (!result?.certificate) {
    return check("certificate", "fail", "no peer certificate was available");
  }
  const certificate = result.certificate;
  const validTo = Date.parse(certificate.valid_to);
  if (!Number.isFinite(validTo)) {
    return check("certificate", "fail", "peer certificate has no parseable expiration date");
  }
  const daysRemaining = Math.floor((validTo - Date.now()) / 86400000);
  const details = {
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    daysRemaining,
    serialNumber: certificate.serialNumber,
    fingerprint256: certificate.fingerprint256,
    subjectAltName: certificate.subjectaltname || null
  };
  if (result.authorized !== true) {
    return check(
      "certificate",
      "fail",
      `certificate verification failed: ${result.authorizationError || "unknown error"}`,
      details
    );
  }
  if (daysRemaining < minimumDays) {
    return check(
      "certificate",
      "fail",
      `certificate expires in ${daysRemaining} day(s), below minimum ${minimumDays}`,
      details
    );
  }
  return check(
    "certificate",
    "pass",
    `certificate is trusted and expires in ${daysRemaining} day(s)`,
    details
  );
}

async function tlsVersionCheck(name, version, target, options) {
  try {
    const result = await probeTls(target, options, {
      minVersion: version,
      maxVersion: version
    });
    if (result.protocol !== version) {
      return {
        check: check(name, "fail", `negotiated ${result.protocol || "unknown"} instead of ${version}`),
        result
      };
    }
    return {
      check: check(name, "pass", `${version} negotiated with ${result.cipher || "unknown cipher"}`),
      result
    };
  } catch (error) {
    return {
      check: check(name, "fail", `${version} handshake failed: ${cleanError(error)}`),
      result: null
    };
  }
}

async function oldTlsCheck(target, options) {
  try {
    const result = await probeTls(target, options, {
      minVersion: "TLSv1.1",
      maxVersion: "TLSv1.1"
    });
    return check(
      "tls_1_1_rejected",
      "fail",
      `TLS 1.1 was unexpectedly accepted (${result.protocol || "unknown protocol"})`
    );
  } catch (error) {
    if (/NO_PROTOCOLS_AVAILABLE|no protocols available/i.test(`${error.code || ""} ${error.message || ""}`)) {
      return check(
        "tls_1_1_rejected",
        "skip",
        "the local Node/OpenSSL runtime cannot initiate TLS 1.1; confirm with the deployed nginx policy or an approved scanner"
      );
    }
    if (NETWORK_ERROR_CODES.has(error.code)) {
      return check(
        "tls_1_1_rejected",
        "fail",
        `TLS 1.1 probe could not reach the endpoint: ${cleanError(error)}`
      );
    }
    return check(
      "tls_1_1_rejected",
      "pass",
      `TLS 1.1 handshake was rejected: ${cleanError(error)}`
    );
  }
}

function checkSecurityHeaders(headers) {
  const missing = [];
  if (!String(headers["x-content-type-options"] || "").toLowerCase().includes("nosniff")) {
    missing.push("x-content-type-options");
  }
  if (String(headers["x-frame-options"] || "").toUpperCase() !== "DENY") {
    missing.push("x-frame-options");
  }
  if (!headers["content-security-policy"]) {
    missing.push("content-security-policy");
  }
  if (missing.length > 0) {
    return check(
      "security_headers",
      "fail",
      `missing or unexpected security headers: ${missing.join(", ")}`
    );
  }
  return check("security_headers", "pass", "edge security headers are present");
}

async function verifyEdge(options) {
  const target = parseAbsoluteUrl(options.url, "--url");
  if (target.protocol !== "https:") {
    throw new Error("--url must use https");
  }
  const httpTarget = options.skipHttpRedirect
    ? null
    : options.httpUrl
      ? parseAbsoluteUrl(options.httpUrl, "--http-url")
      : defaultHttpUrl(target);
  if (httpTarget && httpTarget.protocol !== "http:") {
    throw new Error("--http-url must use http");
  }
  const originTarget = options.originUrl
    ? parseAbsoluteUrl(options.originUrl, "--origin-url")
    : null;
  if (originTarget && originTarget.protocol !== "http:") {
    throw new Error("--origin-url must use http");
  }

  const checks = [];
  const tlsMaterial = await loadTlsMaterial(options, checks);
  const token = await loadToken(options, checks);
  const runtimeOptions = { ...options, ...tlsMaterial };

  if (httpTarget) {
    try {
      const response = await probeHttp(healthUrl(httpTarget), runtimeOptions);
      let location;
      try {
        location = new URL(String(response.headers.location || ""));
      } catch {
        location = null;
      }
      if (!REDIRECT_STATUSES.has(response.statusCode)) {
        checks.push(
          check(
            "http_redirect",
            "fail",
            `HTTP health endpoint returned ${response.statusCode}, expected a redirect`
          )
        );
      } else if (
        !location ||
        location.protocol !== "https:" ||
        location.hostname !== target.hostname ||
        location.port !== target.port
      ) {
        checks.push(
          check(
            "http_redirect",
            "fail",
            "HTTP redirect does not target the configured HTTPS origin",
            { statusCode: response.statusCode, location: response.headers.location || null }
          )
        );
      } else {
        checks.push(
          check("http_redirect", "pass", `HTTP ${response.statusCode} redirects to the HTTPS origin`)
        );
      }
    } catch (error) {
      checks.push(
        check("http_redirect", "fail", `HTTP redirect check failed: ${cleanError(error)}`)
      );
    }
  } else {
    checks.push(check("http_redirect", "skip", "HTTP redirect check was disabled"));
  }

  const [tls12, tls13, tls11] = await Promise.all([
    tlsVersionCheck("tls_1_2", "TLSv1.2", target, runtimeOptions),
    tlsVersionCheck("tls_1_3", "TLSv1.3", target, runtimeOptions),
    oldTlsCheck(target, runtimeOptions)
  ]);
  checks.push(tls12.check, tls13.check, tls11);
  checks.push(certificateCheck(tls13.result, tls12.result, options.minCertDays));

  let healthResponse = null;
  try {
    healthResponse = await probeHttp(healthUrl(target), runtimeOptions);
    if (healthResponse.statusCode !== 200) {
      checks.push(
        check("health", "fail", `/healthz returned ${healthResponse.statusCode}, expected 200`)
      );
    } else {
      let healthBody = null;
      try {
        healthBody = JSON.parse(healthResponse.body);
      } catch {
        checks.push(check("health", "fail", "/healthz did not return valid JSON"));
      }
      if (healthBody) {
        if (healthBody.status && healthBody.status !== "ok") {
          checks.push(
            check("health", "warn", `/healthz reachable but application status is ${healthBody.status}`)
          );
        } else {
          checks.push(check("health", "pass", "/healthz returned HTTP 200 and status ok"));
        }
      }
      checks.push(checkSecurityHeaders(healthResponse.headers));
    }
  } catch (error) {
    checks.push(check("health", "fail", `health check failed: ${cleanError(error)}`));
  }

  if (!healthResponse || healthResponse.statusCode !== 200) {
    checks.push(
      check("security_headers", "fail", "security headers could not be checked without a health response")
    );
  }

  if (token) {
    try {
      const anonymous = await probeHttp(new URL("/metrics", target.origin), runtimeOptions);
      if (anonymous.statusCode === 401) {
        checks.push(check("metrics_auth_required", "pass", "/metrics rejects missing bearer tokens"));
      } else {
        checks.push(
          check(
            "metrics_auth_required",
            "fail",
            `/metrics returned ${anonymous.statusCode} without a bearer token, expected 401`
          )
        );
      }

      const authenticated = await probeHttp(new URL("/metrics", target.origin), runtimeOptions, {
        authorization: `Bearer ${token}`
      });
      if (authenticated.statusCode === 200 && authenticated.body.includes("rpi4_gateway_")) {
        checks.push(check("metrics_authenticated", "pass", "/metrics accepts the configured token"));
      } else {
        checks.push(
          check(
            "metrics_authenticated",
            "fail",
            `/metrics authenticated probe returned ${authenticated.statusCode} or no Gateway metrics`
          )
        );
      }

      const anonymousApi = await probeHttp(
        new URL("/v1/work-context", target.origin),
        runtimeOptions
      );
      if (anonymousApi.statusCode === 401) {
        checks.push(check("api_auth_required", "pass", "/v1 endpoints reject missing bearer tokens"));
      } else {
        checks.push(
          check(
            "api_auth_required",
            "fail",
            `/v1/work-context returned ${anonymousApi.statusCode} without a bearer token, expected 401`
          )
        );
      }

      const authenticatedApi = await probeHttp(
        new URL("/v1/work-context", target.origin),
        runtimeOptions,
        { authorization: `Bearer ${token}` }
      );
      if (authenticatedApi.statusCode === 200) {
        checks.push(check("api_authenticated", "pass", "/v1 endpoints accept the configured token"));
      } else {
        checks.push(
          check(
            "api_authenticated",
            "fail",
            `/v1/work-context authenticated probe returned ${authenticatedApi.statusCode}, expected 200`
          )
        );
      }
    } catch (error) {
      checks.push(check("metrics_auth_required", "fail", `metrics probe failed: ${cleanError(error)}`));
      checks.push(check("metrics_authenticated", "fail", `metrics probe failed: ${cleanError(error)}`));
      checks.push(check("api_auth_required", "fail", `API probe failed: ${cleanError(error)}`));
      checks.push(check("api_authenticated", "fail", `API probe failed: ${cleanError(error)}`));
    }
  } else {
    checks.push(
      check(
        "metrics_authenticated",
        "warn",
        "authenticated metrics and /v1 checks were skipped; provide --token-file or GATEWAY_API_TOKEN"
      )
    );
  }

  try {
    const unknown = await probeHttp(
      new URL("/__rpi4_edge_verify_not_found__", target.origin),
      runtimeOptions
    );
    if (unknown.statusCode === 404) {
      checks.push(check("unknown_path", "pass", "unknown paths return 404 at the edge"));
    } else {
      checks.push(
        check("unknown_path", "fail", `unknown path returned ${unknown.statusCode}, expected 404`)
      );
    }
  } catch (error) {
    checks.push(check("unknown_path", "fail", `unknown-path probe failed: ${cleanError(error)}`));
  }

  if (originTarget) {
    const originHostname = normalizedHostname(originTarget);
    const loopback =
      originHostname === "localhost" ||
      originHostname === "::1" ||
      originHostname === "0:0:0:0:0:0:0:1" ||
      originHostname.startsWith("127.");
    if (!loopback) {
      checks.push(
        check("origin_loopback", "warn", "origin URL does not use a loopback hostname")
      );
    } else {
      checks.push(check("origin_loopback", "pass", "origin URL uses a loopback hostname"));
    }
    try {
      const origin = await probeHttp(healthUrl(originTarget), runtimeOptions);
      if (origin.statusCode === 200) {
        checks.push(check("origin_health", "pass", "loopback origin health is reachable"));
      } else {
        checks.push(
          check("origin_health", "fail", `origin health returned ${origin.statusCode}, expected 200`)
        );
      }
    } catch (error) {
      checks.push(check("origin_health", "fail", `origin health failed: ${cleanError(error)}`));
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of checks) {
    counts[item.status] += 1;
  }
  const overallStatus = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  const exitCode = counts.fail > 0 ? 1 : options.strict && counts.warn > 0 ? 1 : 0;
  return {
    generatedAt: new Date().toISOString(),
    target: target.toString(),
    httpTarget: httpTarget?.toString() || null,
    overallStatus,
    exitCode,
    counts,
    checks
  };
}

function formatEdgeReport(report) {
  const lines = [
    "Gateway edge verification",
    `Target: ${report.target}`,
    `HTTP target: ${report.httpTarget || "skipped"}`
  ];
  for (const item of report.checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.name}: ${item.summary}`);
  }
  lines.push(
    `Summary: ${report.counts.pass} pass, ${report.counts.warn} warn, ` +
      `${report.counts.fail} fail, ${report.counts.skip} skip`
  );
  lines.push(`Result: ${report.overallStatus.toUpperCase()}`);
  return lines.join("\n");
}

function parseEdgeArgs(args) {
  const options = {
    url: null,
    httpUrl: null,
    originUrl: null,
    tokenFile: null,
    caFile: null,
    clientCertFile: null,
    clientKeyFile: null,
    minCertDays: 14,
    timeoutMs: 10000,
    skipHttpRedirect: false,
    strict: false,
    json: false,
    help: false
  };
  const valueOptions = new Map([
    ["--url", "url"],
    ["--http-url", "httpUrl"],
    ["--origin-url", "originUrl"],
    ["--token-file", "tokenFile"],
    ["--ca-file", "caFile"],
    ["--client-cert-file", "clientCertFile"],
    ["--client-key-file", "clientKeyFile"]
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[valueOptions.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === "--min-cert-days" || argument === "--timeout-ms") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} requires a positive integer`);
      }
      options[argument === "--min-cert-days" ? "minCertDays" : "timeoutMs"] = value;
      index += 1;
      continue;
    }
    if (argument === "--skip-http-redirect") {
      options.skipHttpRedirect = true;
      continue;
    }
    if (argument === "--strict") {
      options.strict = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (!options.help && !options.url) {
    throw new Error("--url is required");
  }
  return options;
}

module.exports = {
  formatEdgeReport,
  parseEdgeArgs,
  verifyEdge
};
