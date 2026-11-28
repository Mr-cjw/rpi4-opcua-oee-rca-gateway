"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { verifyEdge } = require("../edge/verify");
const { loadGatewayConfig } = require("../gateway/config");
const { runGatewayDoctor } = require("../gateway/doctor");
const { listReleases } = require("../release/installer");

const execFileAsync = promisify(execFile);

const DEFAULT_ORIGIN_URL = "http://127.0.0.1:8080";
const DEFAULT_RELEASE_ROOT = "/opt/rpi4-opcua-oee-rca-gateway";
const DEFAULT_SERVICE = "rpi4-gateway";
const MINIMUM_NODE_VERSION = "22.13.0";
const MAX_HEALTH_BYTES = 1024 * 1024;

function check(name, status, summary, details = {}) {
  return { name, status, summary, details };
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
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

function healthProbeUrl(value, name) {
  const url = parseAbsoluteUrl(value, name);
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url;
}

function nodeCheck(version) {
  const comparison = compareVersions(version, MINIMUM_NODE_VERSION);
  if (comparison === null) {
    return check("node_runtime", "fail", `cannot parse Node.js version ${version}`);
  }
  if (comparison < 0) {
    return check(
      "node_runtime",
      "fail",
      `Node.js ${version} is older than required ${MINIMUM_NODE_VERSION}`,
      { version, minimumVersion: MINIMUM_NODE_VERSION }
    );
  }
  return check(
    "node_runtime",
    "pass",
    `Node.js ${version} satisfies the minimum ${MINIMUM_NODE_VERSION}`,
    { version, minimumVersion: MINIMUM_NODE_VERSION }
  );
}

async function defaultRunCommand(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: options.timeoutMs || 10000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    encoding: "utf8"
  });
  return { stdout, stderr };
}

function parseProperties(output) {
  const properties = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      properties[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return properties;
}

async function serviceChecks(options, dependencies) {
  if ((dependencies.platform || process.platform) !== "linux") {
    return [
      check(
        "service_active",
        "warn",
        "systemd service checks are unavailable; run strict acceptance on the target Linux host"
      )
    ];
  }
  const run = dependencies.runCommand || defaultRunCommand;
  try {
    const { stdout } = await run("systemctl", [
      "show",
      options.service,
      "--no-pager",
      "--property=ActiveState,SubState,UnitFileState,NRestarts,ExecMainStartTimestamp"
    ]);
    const properties = parseProperties(stdout);
    const active = properties.ActiveState === "active";
    const enabled = properties.UnitFileState === "enabled";
    return [
      check(
        "service_active",
        active ? "pass" : "fail",
        active
          ? `${options.service} is active (${properties.SubState || "unknown"})`
          : `${options.service} is ${properties.ActiveState || "unknown"}`,
        properties
      ),
      check(
        "service_enabled",
        enabled ? "pass" : "warn",
        enabled
          ? `${options.service} is enabled at boot`
          : `${options.service} is not enabled at boot (${properties.UnitFileState || "unknown"})`,
        properties
      )
    ];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [
        check("service_active", "warn", "systemctl is unavailable; service state was not verified")
      ];
    }
    return [
      check("service_active", "fail", `service state check failed: ${cleanError(error)}`)
    ];
  }
}

async function releaseChecks(options, dependencies) {
  const list = dependencies.listReleaseStatus || listReleases;
  try {
    const status = await list({ releaseRoot: options.releaseRoot });
    const current = status.releases?.find((entry) => entry.releaseId === status.current) || null;
    const checks = [];
    if (!status.current) {
      checks.push(
        check("release_current", "fail", "no current release is installed", {
          releaseRoot: status.releaseRoot
        })
      );
    } else if (!current || current.error) {
      checks.push(
        check(
          "release_current",
          "fail",
          `current release metadata is invalid: ${current?.error || "release not found"}`,
          { releaseRoot: status.releaseRoot, currentReleaseId: status.current }
        )
      );
    } else {
      checks.push(
        check("release_current", "pass", `current release is ${status.current}`, {
          releaseRoot: status.releaseRoot,
          currentReleaseId: status.current,
          version: current.version,
          commit: current.commit,
          createdAt: current.createdAt
        })
      );
    }
    checks.push(
      status.previous
        ? check("release_rollback", "pass", `rollback release is ${status.previous}`, {
            previousReleaseId: status.previous
          })
        : check("release_rollback", "warn", "no previous release is available for rollback")
    );
    return checks;
  } catch (error) {
    return [
      check("release_current", "fail", `release status check failed: ${cleanError(error)}`)
    ];
  }
}

async function defaultProbeHealth(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json", connection: "close" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_HEALTH_BYTES) {
    throw new Error(`health response exceeded ${MAX_HEALTH_BYTES} bytes`);
  }
  const text = bytes.toString("utf8");
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { statusCode: response.status, body, text };
}

function healthChecks(probe, options) {
  const checks = [];
  if (probe.statusCode !== 200) {
    checks.push(
      check("health_endpoint", "fail", `health endpoint returned ${probe.statusCode}, expected 200`)
    );
    return checks;
  }
  if (!probe.body || typeof probe.body !== "object") {
    checks.push(check("health_endpoint", "fail", "health endpoint did not return a JSON object"));
    return checks;
  }
  const health = probe.body;
  checks.push(check("health_endpoint", "pass", "health endpoint returned HTTP 200 JSON"));
  checks.push(
    check(
      "health_overall",
      health.status === "ok" ? "pass" : "fail",
      `health status is ${health.status || "unknown"}`,
      {
        status: health.status || null,
        uptimeSeconds: health.uptimeSeconds ?? null,
        opcuaConnected: health.opcuaConnected ?? null
      }
    )
  );

  const plcStatus = health.plc?.status || null;
  let plcCheckStatus = "warn";
  if (health.opcuaConnected !== true) {
    plcCheckStatus = "fail";
  } else if (plcStatus === "ok") {
    plcCheckStatus = "pass";
  } else if (plcStatus === "critical") {
    plcCheckStatus = "fail";
  }
  checks.push(
    check(
      "plc_link",
      plcCheckStatus,
      health.opcuaConnected !== true
        ? "Gateway is not connected to the PLC"
        : `PLC diagnostics status is ${plcStatus || "unavailable"}`,
      {
        opcuaConnected: health.opcuaConnected ?? null,
        plcStatus,
        plcHealthy: health.plc?.healthy ?? null
      }
    )
  );

  const clock = health.clock;
  let clockStatus = "warn";
  if (clock?.status === "ok") {
    clockStatus = "pass";
  } else if (clock?.required === true && clock?.status && clock.status !== "ok") {
    clockStatus = "fail";
  }
  checks.push(
    check(
      "clock_sync",
      clockStatus,
      clock?.status === "ok"
        ? `clock is synchronized via ${clock.source || "unknown source"}`
        : `clock status is ${clock?.status || "unavailable"}${clock?.required ? " and is required" : ""}`,
      clock || {}
    )
  );

  const storageStatus = health.storage?.status || "unknown";
  const storageCheckStatus =
    storageStatus === "ok" ? "pass" : storageStatus === "warning" ? "warn" : "fail";
  checks.push(
    check(
      "storage_health",
      storageCheckStatus,
      `storage status is ${storageStatus}`,
      health.storage || {}
    )
  );

  if (options.maxUptimeSeconds !== null) {
    const uptime = Number(health.uptimeSeconds);
    checks.push(
      check(
        "uptime_window",
        Number.isFinite(uptime) && uptime <= options.maxUptimeSeconds ? "pass" : "fail",
        Number.isFinite(uptime)
          ? `Gateway uptime is ${Math.round(uptime)} seconds (limit ${options.maxUptimeSeconds})`
          : "Gateway uptime is unavailable",
        { uptimeSeconds: Number.isFinite(uptime) ? uptime : null, limit: options.maxUptimeSeconds }
      )
    );
  }

  return checks;
}

function doctorCheck(report) {
  const status =
    report.overallStatus === "pass" ? "pass" : report.overallStatus === "warn" ? "warn" : "fail";
  return check(
    "doctor",
    status,
    `OPC UA doctor: ${report.overallStatus} (${report.summary?.pass || 0} pass, ` +
      `${report.summary?.warn || 0} warn, ${report.summary?.fail || 0} fail)`,
    { endpointUrl: report.endpointUrl, security: report.security, summary: report.summary }
  );
}

function edgeCheck(report) {
  const status =
    report.overallStatus === "pass" ? "pass" : report.overallStatus === "warn" ? "warn" : "fail";
  return check(
    "edge_verification",
    status,
    `edge verification: ${report.overallStatus} (${report.counts?.pass || 0} pass, ` +
      `${report.counts?.warn || 0} warn, ${report.counts?.fail || 0} fail, ` +
      `${report.counts?.skip || 0} skip)`,
    { target: report.target, counts: report.counts }
  );
}

function edgeOptionsFrom(options) {
  return {
    url: options.url,
    httpUrl: options.httpUrl,
    originUrl: options.originUrl,
    tokenFile: options.tokenFile,
    caFile: options.caFile,
    clientCertFile: options.clientCertFile,
    clientKeyFile: options.clientKeyFile,
    minCertDays: options.minCertDays,
    timeoutMs: options.timeoutMs,
    skipHttpRedirect: options.skipHttpRedirect,
    strict: false
  };
}

async function runCommission(options, dependencies = {}) {
  const resolved = {
    url: options.url || null,
    httpUrl: options.httpUrl || null,
    originUrl: options.originUrl || DEFAULT_ORIGIN_URL,
    tokenFile: options.tokenFile || null,
    caFile: options.caFile || null,
    clientCertFile: options.clientCertFile || null,
    clientKeyFile: options.clientKeyFile || null,
    minCertDays: options.minCertDays ?? 14,
    timeoutMs: options.timeoutMs ?? 10000,
    skipHttpRedirect: options.skipHttpRedirect === true,
    releaseRoot: options.releaseRoot || DEFAULT_RELEASE_ROOT,
    service: options.service || DEFAULT_SERVICE,
    maxUptimeSeconds:
      options.maxUptimeSeconds === undefined ? null : options.maxUptimeSeconds,
    strict: options.strict === true
  };

  const originTarget = healthProbeUrl(resolved.originUrl, "--origin-url");
  if (resolved.url) {
    const target = parseAbsoluteUrl(resolved.url, "--url");
    if (target.protocol !== "https:") {
      throw new Error("--url must use https");
    }
  } else if (options.edge !== false) {
    throw new Error("--url is required unless --skip-edge is used");
  }
  if (!/^[A-Za-z0-9_.@-]+$/.test(resolved.service)) {
    throw new Error("--service contains unsupported characters");
  }

  const checks = [];
  checks.push(nodeCheck(dependencies.nodeVersion || process.versions.node));
  checks.push(...(await releaseChecks(resolved, dependencies)));
  checks.push(...(await serviceChecks(resolved, dependencies)));

  let health = null;
  const probeHealth = dependencies.probeHealth || defaultProbeHealth;
  try {
    const probe = await probeHealth(originTarget.toString(), resolved.timeoutMs);
    health = probe.body;
    checks.push(...healthChecks(probe, resolved));
  } catch (error) {
    checks.push(
      check("health_endpoint", "fail", `health endpoint check failed: ${cleanError(error)}`, {
        originUrl: resolved.originUrl,
        healthUrl: originTarget.toString()
      })
    );
  }

  let doctor = null;
  if (options.doctor === false) {
    checks.push(check("doctor", "warn", "OPC UA doctor was skipped"));
  } else {
    try {
      const runDoctor =
        dependencies.runDoctor ||
        (() => runGatewayDoctor(loadGatewayConfig()));
      doctor = await runDoctor();
      checks.push(doctorCheck(doctor));
    } catch (error) {
      checks.push(check("doctor", "fail", `OPC UA doctor failed: ${cleanError(error)}`));
    }
  }

  let edge = null;
  if (options.edge === false) {
    checks.push(check("edge_verification", "warn", "edge verification was skipped"));
  } else {
    try {
      const runEdge = dependencies.runEdge || verifyEdge;
      edge = await runEdge(edgeOptionsFrom(resolved));
      checks.push(edgeCheck(edge));
    } catch (error) {
      checks.push(
        check("edge_verification", "fail", `edge verification failed: ${cleanError(error)}`)
      );
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of checks) {
    counts[item.status] += 1;
  }
  const overallStatus = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  const exitCode = counts.fail > 0 ? 1 : resolved.strict && counts.warn > 0 ? 1 : 0;
  return {
    schemaVersion: "1.0",
    generatedAt: (dependencies.now || (() => new Date()))().toISOString(),
    overallStatus,
    exitCode,
    counts,
    host: {
      hostname: (dependencies.hostname || os.hostname)(),
      platform: dependencies.platform || process.platform,
      arch: process.arch,
      nodeVersion: dependencies.nodeVersion || process.versions.node,
      osRelease: os.release(),
      osUptimeSeconds: Math.round((dependencies.uptime || os.uptime)())
    },
    settings: {
      releaseRoot: resolved.releaseRoot,
      service: resolved.service,
      originUrl: resolved.originUrl,
      healthUrl: originTarget.toString(),
      edgeTarget: resolved.url,
      doctorSkipped: options.doctor === false,
      edgeSkipped: options.edge === false
    },
    checks,
    health,
    doctor,
    edge
  };
}

function formatCommissionReport(report) {
  const lines = [
    "Gateway commissioning report",
    `Generated: ${report.generatedAt}`,
    `Host: ${report.host.hostname} (${report.host.platform}/${report.host.arch})`,
    `Node.js: ${report.host.nodeVersion}`,
    `Release root: ${report.settings.releaseRoot}`,
    `Service: ${report.settings.service}`,
    ""
  ];
  for (const item of report.checks) {
    lines.push(`[${item.status.toUpperCase()}] ${item.name}: ${item.summary}`);
  }
  lines.push(
    "",
    `Summary: ${report.counts.pass} pass, ${report.counts.warn} warn, ` +
      `${report.counts.fail} fail, ${report.counts.skip} skip`,
    `Result: ${report.overallStatus.toUpperCase()}`
  );
  if (report.outputPath) {
    lines.push(`Report: ${report.outputPath}`);
  }
  return lines.join("\n");
}

async function writeCommissionReport(report, outputPath, options = {}) {
  const resolvedPath = path.resolve(outputPath);
  report.outputPath = resolvedPath;
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  await fs.chmod(resolvedPath, 0o600);
  return resolvedPath;
}

function parseCommissionArgs(args) {
  const options = {
    url: null,
    httpUrl: null,
    originUrl: DEFAULT_ORIGIN_URL,
    tokenFile: null,
    caFile: null,
    clientCertFile: null,
    clientKeyFile: null,
    minCertDays: 14,
    timeoutMs: 10000,
    skipHttpRedirect: false,
    releaseRoot: DEFAULT_RELEASE_ROOT,
    service: DEFAULT_SERVICE,
    maxUptimeSeconds: null,
    output: null,
    force: false,
    strict: false,
    json: false,
    help: false,
    edge: true,
    doctor: true
  };
  const valueOptions = new Map([
    ["--url", "url"],
    ["--http-url", "httpUrl"],
    ["--origin-url", "originUrl"],
    ["--token-file", "tokenFile"],
    ["--ca-file", "caFile"],
    ["--client-cert-file", "clientCertFile"],
    ["--client-key-file", "clientKeyFile"],
    ["--release-root", "releaseRoot"],
    ["--service", "service"],
    ["--output", "output"]
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
    if (
      argument === "--min-cert-days" ||
      argument === "--timeout-ms" ||
      argument === "--max-uptime-seconds"
    ) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} requires a positive integer`);
      }
      options[
        argument === "--min-cert-days"
          ? "minCertDays"
          : argument === "--timeout-ms"
            ? "timeoutMs"
            : "maxUptimeSeconds"
      ] = value;
      index += 1;
      continue;
    }
    if (argument === "--skip-http-redirect") {
      options.skipHttpRedirect = true;
      continue;
    }
    if (argument === "--skip-edge") {
      options.edge = false;
      continue;
    }
    if (argument === "--skip-doctor") {
      options.doctor = false;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
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

  if (!options.help && options.edge && !options.url) {
    throw new Error("--url is required unless --skip-edge is used");
  }
  if (!/^[A-Za-z0-9_.@-]+$/.test(options.service)) {
    throw new Error("--service contains unsupported characters");
  }
  return options;
}

module.exports = {
  DEFAULT_ORIGIN_URL,
  DEFAULT_RELEASE_ROOT,
  DEFAULT_SERVICE,
  MINIMUM_NODE_VERSION,
  formatCommissionReport,
  parseCommissionArgs,
  runCommission,
  writeCommissionReport
};
