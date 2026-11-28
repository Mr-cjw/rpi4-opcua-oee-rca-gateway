"use strict";

const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { defaultCheckClock } = require("../gateway/clock-sync");
const { StorageMonitor } = require("../gateway/storage-health");

const execFileAsync = promisify(execFile);

const MODEL_PATH = "/sys/firmware/devicetree/base/model";
const OS_RELEASE_PATH = "/etc/os-release";
const THERMAL_PATH = "/sys/class/thermal/thermal_zone0/temp";
const DEFAULT_WARN_TEMPERATURE_C = 70;
const DEFAULT_MAX_TEMPERATURE_C = 80;
const DEFAULT_WARN_FREE_BYTES = 100 * 1024 * 1024;
const DEFAULT_CRITICAL_FREE_BYTES = 32 * 1024 * 1024;

const THROTTLE_BITS = Object.freeze([
  [0, "underVoltage", "under-voltage detected", true],
  [1, "armFrequencyCapped", "ARM frequency capped", true],
  [2, "currentlyThrottled", "currently throttled", true],
  [3, "softTemperatureLimit", "soft temperature limit active", true],
  [16, "underVoltageOccurred", "under-voltage occurred", false],
  [17, "armFrequencyCappedOccurred", "ARM frequency capping occurred", false],
  [18, "throttledOccurred", "throttling occurred", false],
  [19, "softTemperatureLimitOccurred", "soft temperature limit occurred", false]
]);

function check(name, status, summary, details = {}) {
  return { name, status, summary, details };
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function stripDeviceTreeString(value) {
  return String(value || "").replace(/\0/g, "").trim();
}

function parseOsRelease(value) {
  const parsed = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let item = match[2].trim();
    if (
      (item.startsWith('"') && item.endsWith('"')) ||
      (item.startsWith("'") && item.endsWith("'"))
    ) {
      item = item.slice(1, -1);
    }
    parsed[match[1]] = item;
  }
  return {
    id: parsed.ID || null,
    name: parsed.NAME || null,
    versionId: parsed.VERSION_ID || null,
    prettyName: parsed.PRETTY_NAME || parsed.NAME || null
  };
}

function parseThermalMilliC(value) {
  const number = Number(String(value || "").trim());
  if (!Number.isFinite(number) || number <= 0 || number >= 200000) {
    return null;
  }
  return number / 1000;
}

function parseVcgencmdTemperature(value) {
  const match = /temp=(-?\d+(?:\.\d+)?)'C/i.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 && number < 200 ? number : null;
}

function parseVcgencmdVoltage(value) {
  const match = /volt=(\d+(?:\.\d+)?)V/i.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 && number < 10 ? number : null;
}

function parseThrottleValue(value) {
  const match = /throttled=(0x[0-9a-f]+|\d+)/i.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function decodeThrottleFlags(value) {
  const bits = {};
  const current = [];
  const occurred = [];
  for (const [bit, name, label, isCurrent] of THROTTLE_BITS) {
    const set = (value & (2 ** bit)) !== 0;
    bits[name] = set;
    if (set) {
      (isCurrent ? current : occurred).push(label);
    }
  }
  return {
    raw: `0x${Math.max(0, Number(value) || 0).toString(16)}`,
    bits,
    current,
    occurred
  };
}

function positiveNumber(value, name, { integer = false } = {}) {
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number <= 0 ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
  }
  return number;
}

function normalizeOptions(options = {}) {
  const warnTemperatureC = positiveNumber(
    options.warnTemperatureC ?? DEFAULT_WARN_TEMPERATURE_C,
    "--warn-temp-c"
  );
  const maxTemperatureC = positiveNumber(
    options.maxTemperatureC ?? DEFAULT_MAX_TEMPERATURE_C,
    "--max-temp-c"
  );
  const warnFreeBytes = positiveNumber(
    options.warnFreeBytes ?? DEFAULT_WARN_FREE_BYTES,
    "--warn-free-bytes",
    { integer: true }
  );
  const criticalFreeBytes = positiveNumber(
    options.criticalFreeBytes ?? DEFAULT_CRITICAL_FREE_BYTES,
    "--critical-free-bytes",
    { integer: true }
  );
  if (warnTemperatureC >= maxTemperatureC) {
    throw new Error("--warn-temp-c must be less than --max-temp-c");
  }
  if (criticalFreeBytes > warnFreeBytes) {
    throw new Error("--critical-free-bytes must not exceed --warn-free-bytes");
  }
  return {
    ...options,
    strict: options.strict === true,
    warnTemperatureC,
    maxTemperatureC,
    warnFreeBytes,
    criticalFreeBytes,
    storagePath: path.resolve(options.storagePath || "/")
  };
}

async function defaultRunCommand(command, args, timeoutMs = 3000) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      encoding: "utf8"
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: cleanError(error)
    };
  }
}

async function safeRunCommand(run, command, args) {
  try {
    return await run(command, args);
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      stdout: "",
      stderr: "",
      error: cleanError(error)
    };
  }
}

async function readOptionalText(readFile, filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function firmwareVersion(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /\bversion\b/i.test(line)) || lines[0] || null;
}

async function temperatureCheck(options, dependencies, runCommand) {
  const readFile = dependencies.readFile || fsp.readFile;
  let temperatureC = null;
  let source = null;
  let error = null;
  const thermal = await readOptionalText(readFile, THERMAL_PATH);
  if (thermal !== null) {
    temperatureC = parseThermalMilliC(thermal);
    source = temperatureC === null ? null : "thermal_zone";
  }
  if (temperatureC === null) {
    const command = await safeRunCommand(runCommand, "vcgencmd", ["measure_temp"]);
    if (command.ok) {
      temperatureC = parseVcgencmdTemperature(command.stdout);
      source = temperatureC === null ? null : "vcgencmd";
    } else {
      error = command.error || command.stderr || `exit ${command.code}`;
    }
  }
  const details = {
    temperatureC,
    source,
    warnTemperatureC: options.warnTemperatureC,
    maxTemperatureC: options.maxTemperatureC,
    error
  };
  if (temperatureC === null) {
    return {
      check: check(
        "temperature",
        "warn",
        "CPU temperature is unavailable; hardware thermal state cannot be verified",
        details
      ),
      details
    };
  }
  if (temperatureC >= options.maxTemperatureC) {
    return {
      check: check(
        "temperature",
        "fail",
        `CPU temperature ${temperatureC.toFixed(1)} C reached the ${options.maxTemperatureC} C limit`,
        details
      ),
      details
    };
  }
  if (temperatureC >= options.warnTemperatureC) {
    return {
      check: check(
        "temperature",
        "warn",
        `CPU temperature ${temperatureC.toFixed(1)} C is above the ${options.warnTemperatureC} C warning threshold`,
        details
      ),
      details
    };
  }
  return {
    check: check(
      "temperature",
      "pass",
      `CPU temperature ${temperatureC.toFixed(1)} C is below the ${options.warnTemperatureC} C warning threshold`,
      details
    ),
    details
  };
}

async function throttleCheck(dependencies, runCommand) {
  const [throttle, version, voltage] = await Promise.all([
    safeRunCommand(runCommand, "vcgencmd", ["get_throttled"]),
    safeRunCommand(runCommand, "vcgencmd", ["version"]),
    safeRunCommand(runCommand, "vcgencmd", ["measure_volts", "core"])
  ]);
  const firmware = {
    version: version.ok ? firmwareVersion(version.stdout) : null,
    coreVoltageV: voltage.ok ? parseVcgencmdVoltage(voltage.stdout) : null
  };
  if (!throttle.ok) {
    return {
      check: check(
        "throttling",
        "warn",
        "vcgencmd is unavailable; under-voltage and throttling cannot be verified",
        {
          available: false,
          error: throttle.error || throttle.stderr || `exit ${throttle.code}`,
          firmware
        }
      ),
      details: { available: false, firmware }
    };
  }
  const value = parseThrottleValue(throttle.stdout);
  if (value === null) {
    return {
      check: check(
        "throttling",
        "warn",
        "vcgencmd returned an unrecognized throttling value",
        { available: true, output: String(throttle.stdout || "").trim(), firmware }
      ),
      details: { available: true, firmware }
    };
  }
  const flags = decodeThrottleFlags(value);
  const details = {
    available: true,
    throttled: flags.raw,
    flags: flags.bits,
    current: flags.current,
    occurred: flags.occurred,
    firmware
  };
  if (flags.current.length > 0) {
    return {
      check: check(
        "throttling",
        "fail",
        `active power/thermal condition: ${flags.current.join(", ")}`,
        details
      ),
      details
    };
  }
  if (flags.occurred.length > 0) {
    return {
      check: check(
        "throttling",
        "warn",
        `historical power/thermal condition: ${flags.occurred.join(", ")}`,
        details
      ),
      details
    };
  }
  return {
    check: check(
      "throttling",
      "pass",
      "no current or historical under-voltage/throttling flags are set",
      details
    ),
    details
  };
}

async function clockCheck(dependencies) {
  const checkClock = dependencies.checkClock || defaultCheckClock;
  let clock;
  try {
    clock = await checkClock();
  } catch (error) {
    clock = { synchronized: null, source: "error", error: cleanError(error) };
  }
  const details = {
    synchronized: clock?.synchronized ?? null,
    source: clock?.source || "unknown",
    offsetMs: clock?.offsetMs ?? null,
    leapStatus: clock?.leapStatus ?? null,
    error: clock?.error ? cleanError(clock.error) : null
  };
  if (details.synchronized === true) {
    return {
      check: check(
        "clock_sync",
        "pass",
        `system clock is synchronized via ${details.source}`,
        details
      ),
      details
    };
  }
  if (details.synchronized === false) {
    return {
      check: check(
        "clock_sync",
        "fail",
        `system clock is not synchronized (source ${details.source})`,
        details
      ),
      details
    };
  }
  return {
    check: check(
      "clock_sync",
      "warn",
      "system clock synchronization is unavailable",
      details
    ),
    details
  };
}

async function storageCheck(options, dependencies) {
  const now = dependencies.now || (() => new Date());
  const monitor = new StorageMonitor({
    diskPath: options.storagePath,
    warnFreeBytes: options.warnFreeBytes,
    criticalFreeBytes: options.criticalFreeBytes,
    checkIntervalMs: 0,
    statfs: dependencies.statfs,
    clock: () => now().getTime()
  });
  const status = await monitor.checkDisk();
  const disk = status.disk;
  const details = {
    path: disk.path,
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    usageRatio: disk.usageRatio,
    warnFreeBytes: options.warnFreeBytes,
    criticalFreeBytes: options.criticalFreeBytes,
    error: disk.lastError
  };
  if (disk.status === "critical") {
    return {
      check: check(
        "storage",
        "fail",
        disk.lastError
          ? `storage check failed: ${disk.lastError}`
          : `free space ${disk.freeBytes} bytes is at or below the critical threshold`,
        details
      ),
      details
    };
  }
  if (disk.status === "warning") {
    return {
      check: check(
        "storage",
        "warn",
        `free space ${disk.freeBytes} bytes is at or below the warning threshold`,
        details
      ),
      details
    };
  }
  return {
    check: check(
      "storage",
      "pass",
      `free space ${disk.freeBytes} bytes is above the warning threshold`,
      details
    ),
    details
  };
}

async function runHardwareCheck(options = {}, dependencies = {}) {
  const resolved = normalizeOptions(options);
  const platform = dependencies.platform || process.platform;
  const arch = dependencies.arch || process.arch;
  const nodeVersion = dependencies.nodeVersion || process.versions.node;
  const kernelRelease = dependencies.kernelRelease || os.release();
  const hostname = (dependencies.hostname || os.hostname)();
  const uptimeSeconds = Math.round((dependencies.uptime || os.uptime)());
  const now = dependencies.now || (() => new Date());
  const readFile = dependencies.readFile || fsp.readFile;
  const runCommand = dependencies.runCommand || defaultRunCommand;

  const [modelRaw, osRaw] = await Promise.all([
    readOptionalText(readFile, MODEL_PATH),
    readOptionalText(readFile, OS_RELEASE_PATH)
  ]);
  const modelText = modelRaw === null ? null : stripDeviceTreeString(modelRaw);
  const osRelease = parseOsRelease(osRaw || "");
  const isRaspberryPi = modelText !== null && /raspberry pi/i.test(modelText);
  const isPi4Class =
    isRaspberryPi &&
    /(?:raspberry pi 4|raspberry pi 400|compute module 4)/i.test(modelText);

  const checks = [];
  checks.push(
    check(
      "platform",
      platform === "linux" ? "pass" : "fail",
      platform === "linux"
        ? "Linux platform detected"
        : `unsupported platform ${platform}; Pi hardware checks require Linux`,
      { platform }
    )
  );
  checks.push(
    check(
      "architecture",
      arch === "arm64" ? "pass" : "fail",
      arch === "arm64"
        ? "64-bit ARM runtime detected"
        : `expected a 64-bit arm64 Node.js runtime, found ${arch}`,
      { arch }
    )
  );
  if (!isRaspberryPi) {
    checks.push(
      check(
        "raspberry_pi_model",
        "fail",
        modelText
          ? `device model is not a Raspberry Pi: ${modelText}`
          : "Raspberry Pi model could not be read from the device tree",
        { model: modelText }
      )
    );
  } else if (!isPi4Class) {
    checks.push(
      check(
        "raspberry_pi_model",
        "warn",
        `Raspberry Pi detected but not the approved Pi 4/CM4 profile: ${modelText}`,
        { model: modelText }
      )
    );
  } else {
    checks.push(
      check(
        "raspberry_pi_model",
        "pass",
        `approved Pi 4-class hardware detected: ${modelText}`,
        { model: modelText }
      )
    );
  }
  checks.push(
    check(
      "os_release",
      osRelease.prettyName ? "pass" : "warn",
      osRelease.prettyName
        ? `operating system: ${osRelease.prettyName}`
        : "operating-system release information is unavailable",
      osRelease
    )
  );

  const [temperature, throttle, clock, storage] = await Promise.all([
    temperatureCheck(resolved, dependencies, runCommand),
    throttleCheck(dependencies, runCommand),
    clockCheck(dependencies),
    storageCheck(resolved, dependencies)
  ]);
  checks.push(temperature.check, throttle.check, clock.check, storage.check);

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of checks) {
    counts[item.status] += 1;
  }
  const overallStatus =
    counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass";
  const exitCode =
    counts.fail > 0 ? 1 : resolved.strict && counts.warn > 0 ? 1 : 0;
  return {
    schemaVersion: "1.0",
    generatedAt: now().toISOString(),
    overallStatus,
    exitCode,
    counts,
    host: {
      hostname,
      platform,
      arch,
      nodeVersion,
      kernelRelease,
      uptimeSeconds
    },
    model: {
      text: modelText,
      raspberryPi: isRaspberryPi,
      pi4Class: isPi4Class,
      osRelease
    },
    hardware: {
      temperature: temperature.details,
      throttling: throttle.details,
      clock: clock.details,
      storage: storage.details
    },
    settings: {
      strict: resolved.strict,
      warnTemperatureC: resolved.warnTemperatureC,
      maxTemperatureC: resolved.maxTemperatureC,
      storagePath: resolved.storagePath,
      warnFreeBytes: resolved.warnFreeBytes,
      criticalFreeBytes: resolved.criticalFreeBytes
    },
    checks
  };
}

function formatHardwareReport(report) {
  const lines = [
    "Raspberry Pi hardware readiness report",
    `Generated: ${report.generatedAt}`,
    `Host: ${report.host.hostname} (${report.host.platform}/${report.host.arch})`,
    `Model: ${report.model.text || "unknown"}`,
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

async function writeHardwareReport(report, outputPath, options = {}) {
  const resolvedPath = path.resolve(outputPath);
  report.outputPath = resolvedPath;
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fsp.writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  await fsp.chmod(resolvedPath, 0o600);
  return resolvedPath;
}

function parseHardwareArgs(args) {
  const options = {
    strict: false,
    json: false,
    output: null,
    force: false,
    help: false,
    warnTemperatureC: DEFAULT_WARN_TEMPERATURE_C,
    maxTemperatureC: DEFAULT_MAX_TEMPERATURE_C,
    warnFreeBytes: DEFAULT_WARN_FREE_BYTES,
    criticalFreeBytes: DEFAULT_CRITICAL_FREE_BYTES,
    storagePath: "/"
  };
  const valueOptions = new Map([
    ["--output", "output"],
    ["--storage-path", "storagePath"]
  ]);
  const numberOptions = new Map([
    ["--warn-temp-c", { name: "warnTemperatureC", integer: false }],
    ["--max-temp-c", { name: "maxTemperatureC", integer: false }],
    ["--warn-free-bytes", { name: "warnFreeBytes", integer: true }],
    ["--critical-free-bytes", { name: "criticalFreeBytes", integer: true }]
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
    if (numberOptions.has(argument)) {
      const definition = numberOptions.get(argument);
      options[definition.name] = positiveNumber(
        args[index + 1],
        argument,
        { integer: definition.integer }
      );
      index += 1;
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
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!options.help) {
    normalizeOptions(options);
  }
  return options;
}

module.exports = {
  DEFAULT_CRITICAL_FREE_BYTES,
  DEFAULT_MAX_TEMPERATURE_C,
  DEFAULT_WARN_FREE_BYTES,
  DEFAULT_WARN_TEMPERATURE_C,
  MODEL_PATH,
  OS_RELEASE_PATH,
  THERMAL_PATH,
  defaultRunCommand,
  decodeThrottleFlags,
  formatHardwareReport,
  parseHardwareArgs,
  parseOsRelease,
  parseThermalMilliC,
  parseThrottleValue,
  parseVcgencmdTemperature,
  parseVcgencmdVoltage,
  readOptionalText,
  runHardwareCheck,
  safeRunCommand,
  writeHardwareReport
};
