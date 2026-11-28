"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MODEL_PATH,
  OS_RELEASE_PATH,
  THERMAL_PATH,
  decodeThrottleFlags,
  parseHardwareArgs,
  parseOsRelease,
  parseThermalMilliC,
  parseThrottleValue,
  parseVcgencmdTemperature,
  parseVcgencmdVoltage,
  runHardwareCheck,
  writeHardwareReport
} = require("../src/hardware/check");

const NOW = new Date("2026-11-28T14:00:00.000Z");

function makeDependencies(overrides = {}) {
  const calls = { commands: [] };
  const dependencies = {
    platform: "linux",
    arch: "arm64",
    nodeVersion: "22.13.0",
    kernelRelease: "6.6.51+rpt-rpi-v8",
    hostname: () => "rpi4-hardware",
    uptime: () => 7200,
    now: () => NOW,
    readFile: async (filePath) => {
      if (filePath === MODEL_PATH) {
        return "Raspberry Pi 4 Model B Rev 1.5\0";
      }
      if (filePath === OS_RELEASE_PATH) {
        return [
          'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
          "NAME=Debian GNU/Linux",
          "VERSION_ID=12",
          "ID=debian",
          ""
        ].join("\n");
      }
      if (filePath === THERMAL_PATH) {
        return "52000\n";
      }
      const error = new Error(`unexpected file read: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    },
    runCommand: async (command, args) => {
      calls.commands.push([command, ...args].join(" "));
      const joined = args.join(" ");
      if (command === "vcgencmd" && joined === "get_throttled") {
        return { ok: true, stdout: "throttled=0x0\n", stderr: "" };
      }
      if (command === "vcgencmd" && joined === "version") {
        return {
          ok: true,
          stdout: "2024/10/30 13:20:22\nversion abcdef (release)\n",
          stderr: ""
        };
      }
      if (command === "vcgencmd" && joined === "measure_volts core") {
        return { ok: true, stdout: "volt=0.8500V\n", stderr: "" };
      }
      if (command === "vcgencmd" && joined === "measure_temp") {
        return { ok: true, stdout: "temp=52.0'C\n", stderr: "" };
      }
      return { ok: false, code: "ENOENT", stdout: "", stderr: "" };
    },
    statfs: async () => ({
      bsize: 1n,
      blocks: 1000n,
      bavail: 500n
    }),
    checkClock: async () => ({
      synchronized: true,
      source: "timedatectl",
      offsetMs: 2
    }),
    calls
  };
  Object.assign(dependencies, overrides);
  return dependencies;
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-hardware-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function optionsFor(root, overrides = {}) {
  return {
    strict: false,
    storagePath: root,
    warnTemperatureC: 70,
    maxTemperatureC: 80,
    warnFreeBytes: 100,
    criticalFreeBytes: 50,
    ...overrides
  };
}

async function mode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("hardware check accepts a healthy Pi 4 profile and writes a protected report", async (t) => {
  const root = await makeRoot(t);
  const report = await runHardwareCheck(
    optionsFor(root, { strict: true }),
    makeDependencies()
  );

  assert.equal(report.schemaVersion, "1.0");
  assert.equal(report.overallStatus, "pass");
  assert.equal(report.exitCode, 0);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.counts.warn, 0);
  assert.equal(report.model.raspberryPi, true);
  assert.equal(report.model.pi4Class, true);
  assert.match(report.model.text, /Raspberry Pi 4/);
  assert.equal(report.model.osRelease.prettyName, "Debian GNU/Linux 12 (bookworm)");
  assert.equal(report.hardware.temperature.temperatureC, 52);
  assert.equal(report.hardware.temperature.source, "thermal_zone");
  assert.equal(report.hardware.throttling.throttled, "0x0");
  assert.equal(report.hardware.throttling.firmware.coreVoltageV, 0.85);
  assert.match(report.hardware.throttling.firmware.version, /version abcdef/);
  assert.equal(report.hardware.storage.freeBytes, 500);
  assert.equal(report.hardware.clock.synchronized, true);
  assert.equal(report.host.nodeVersion, "22.13.0");
  for (const name of [
    "platform",
    "architecture",
    "raspberry_pi_model",
    "os_release",
    "temperature",
    "throttling",
    "clock_sync",
    "storage"
  ]) {
    assert.equal(report.checks.find((entry) => entry.name === name)?.status, "pass", name);
  }

  const outputPath = path.join(root, "hardware-report.json");
  report.outputPath = await writeHardwareReport(report, outputPath);
  assert.equal(await mode(outputPath), 0o600);
  const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(written.overallStatus, "pass");
  assert.equal(written.outputPath, outputPath);
  await assert.rejects(writeHardwareReport(report, outputPath), /EEXIST/);
  await writeHardwareReport(report, outputPath, { force: true });
});

test("hardware check reports thermal, power-history, and storage warnings", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies({
    readFile: async (filePath) => {
      if (filePath === MODEL_PATH) {
        return "Raspberry Pi 4 Model B Rev 1.5\0";
      }
      if (filePath === OS_RELEASE_PATH) {
        return 'PRETTY_NAME="Raspberry Pi OS"\n';
      }
      if (filePath === THERMAL_PATH) {
        return "75000\n";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runCommand: async (command, args) => {
      if (command === "vcgencmd" && args[0] === "get_throttled") {
        return { ok: true, stdout: "throttled=0x50000\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    statfs: async () => ({ bsize: 1n, blocks: 1000n, bavail: 80n })
  });

  const report = await runHardwareCheck(
    optionsFor(root, { strict: true }),
    dependencies
  );
  assert.equal(report.overallStatus, "warn");
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((entry) => entry.name === "temperature")?.status, "warn");
  assert.equal(report.checks.find((entry) => entry.name === "throttling")?.status, "warn");
  assert.equal(report.checks.find((entry) => entry.name === "storage")?.status, "warn");
  assert.equal(report.hardware.throttling.flags.underVoltageOccurred, true);
  assert.equal(report.hardware.throttling.flags.throttledOccurred, true);

  const nonStrict = await runHardwareCheck(optionsFor(root), dependencies);
  assert.equal(nonStrict.overallStatus, "warn");
  assert.equal(nonStrict.exitCode, 0);
});

test("hardware check fails active under-voltage, overheating, storage exhaustion, and unsynced clock", async (t) => {
  const root = await makeRoot(t);
  const dependencies = makeDependencies({
    readFile: async (filePath) => {
      if (filePath === MODEL_PATH) {
        return "Raspberry Pi 4 Model B Rev 1.5\0";
      }
      if (filePath === OS_RELEASE_PATH) {
        return 'PRETTY_NAME="Raspberry Pi OS"\n';
      }
      if (filePath === THERMAL_PATH) {
        return "85000\n";
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runCommand: async (command, args) => {
      if (command === "vcgencmd" && args[0] === "get_throttled") {
        return { ok: true, stdout: "throttled=0x1\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    statfs: async () => ({ bsize: 1n, blocks: 1000n, bavail: 25n }),
    checkClock: async () => ({ synchronized: false, source: "timedatectl" })
  });

  const report = await runHardwareCheck(
    optionsFor(root, { strict: true }),
    dependencies
  );
  assert.equal(report.overallStatus, "fail");
  assert.equal(report.exitCode, 1);
  for (const name of ["temperature", "throttling", "clock_sync", "storage"]) {
    assert.equal(report.checks.find((entry) => entry.name === name)?.status, "fail", name);
  }
  assert.equal(report.hardware.throttling.flags.underVoltage, true);
  assert.match(
    report.checks.find((entry) => entry.name === "throttling")?.summary,
    /under-voltage detected/
  );
});

test("hardware check treats missing telemetry and non-Pi hardware explicitly", async (t) => {
  const root = await makeRoot(t);
  const missingTelemetry = makeDependencies({
    readFile: async (filePath) => {
      if (filePath === MODEL_PATH) {
        return "Raspberry Pi 4 Model B Rev 1.5\0";
      }
      if (filePath === OS_RELEASE_PATH) {
        return 'PRETTY_NAME="Raspberry Pi OS"\n';
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runCommand: async () => ({ ok: false, code: "ENOENT", stdout: "", stderr: "" }),
    checkClock: async () => ({ synchronized: null, source: "unavailable" })
  });

  const degraded = await runHardwareCheck(
    optionsFor(root, { strict: true }),
    missingTelemetry
  );
  assert.equal(degraded.overallStatus, "warn");
  assert.equal(degraded.exitCode, 1);
  for (const name of ["temperature", "throttling", "clock_sync"]) {
    assert.equal(degraded.checks.find((entry) => entry.name === name)?.status, "warn", name);
  }
  assert.equal(
    degraded.checks.find((entry) => entry.name === "throttling")?.details.available,
    false
  );

  const nonPi = await runHardwareCheck(
    optionsFor(root),
    makeDependencies({
      readFile: async (filePath) => {
        if (filePath === MODEL_PATH) {
          return "Raspberry Pi 3 Model B Rev 1.2\0";
        }
        if (filePath === OS_RELEASE_PATH) {
          return 'PRETTY_NAME="Raspberry Pi OS"\n';
        }
        if (filePath === THERMAL_PATH) {
          return "52000\n";
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    })
  );
  assert.equal(nonPi.overallStatus, "warn");
  assert.equal(
    nonPi.checks.find((entry) => entry.name === "raspberry_pi_model")?.status,
    "warn"
  );

  const unsupported = await runHardwareCheck(
    optionsFor(root),
    makeDependencies({
      platform: "darwin",
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    })
  );
  assert.equal(unsupported.overallStatus, "fail");
  assert.equal(
    unsupported.checks.find((entry) => entry.name === "raspberry_pi_model")?.status,
    "fail"
  );
});

test("hardware parsers decode Raspberry Pi telemetry", () => {
  assert.deepEqual(parseOsRelease('PRETTY_NAME="Raspberry Pi OS"\nID=raspbian\n'), {
    id: "raspbian",
    name: null,
    versionId: null,
    prettyName: "Raspberry Pi OS"
  });
  assert.equal(parseThermalMilliC("52000\n"), 52);
  assert.equal(parseThermalMilliC("bad"), null);
  assert.equal(parseVcgencmdTemperature("temp=53.2'C\n"), 53.2);
  assert.equal(parseVcgencmdVoltage("volt=0.8500V\n"), 0.85);
  assert.equal(parseThrottleValue("throttled=0x50000\n"), 0x50000);
  assert.equal(parseThrottleValue("invalid"), null);
  const flags = decodeThrottleFlags(0x50005);
  assert.equal(flags.raw, "0x50005");
  assert.equal(flags.bits.underVoltage, true);
  assert.equal(flags.bits.currentlyThrottled, true);
  assert.equal(flags.bits.underVoltageOccurred, true);
  assert.equal(flags.bits.throttledOccurred, true);
  assert.deepEqual(flags.current, [
    "under-voltage detected",
    "currently throttled"
  ]);
  assert.deepEqual(flags.occurred, ["under-voltage occurred", "throttling occurred"]);
});

test("hardware arguments and CLI reject unsafe or incomplete configuration", async (t) => {
  const defaults = parseHardwareArgs([]);
  assert.equal(defaults.strict, false);
  assert.equal(defaults.maxTemperatureC, 80);
  assert.equal(defaults.warnFreeBytes, 100 * 1024 * 1024);
  const parsed = parseHardwareArgs([
    "--strict",
    "--json",
    "--output",
    "/tmp/hardware.json",
    "--warn-temp-c",
    "65",
    "--max-temp-c",
    "78",
    "--warn-free-bytes",
    "200",
    "--critical-free-bytes",
    "100",
    "--storage-path",
    "/"
  ]);
  assert.equal(parsed.strict, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.warnTemperatureC, 65);
  assert.equal(parsed.maxTemperatureC, 78);
  assert.equal(parsed.warnFreeBytes, 200);
  assert.equal(parsed.criticalFreeBytes, 100);
  assert.throws(() => parseHardwareArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseHardwareArgs(["--output"]), /requires a value/);
  assert.throws(() => parseHardwareArgs(["--warn-temp-c", "0"]), /positive number/);
  assert.throws(
    () => parseHardwareArgs(["--warn-temp-c", "80"]),
    /must be less than --max-temp-c/
  );
  assert.throws(
    () =>
      parseHardwareArgs([
        "--warn-free-bytes",
        "100",
        "--critical-free-bytes",
        "200"
      ]),
    /must not exceed --warn-free-bytes/
  );

  const root = await makeRoot(t);
  const storageFailure = await runHardwareCheck(
    { storagePath: root, warnFreeBytes: 100, criticalFreeBytes: 50 },
    {
      statfs: async () => {
        throw new Error("statfs failed");
      }
    }
  );
  assert.equal(storageFailure.overallStatus, "fail");
  assert.equal(
    storageFailure.checks.find((entry) => entry.name === "storage")?.status,
    "fail"
  );
  assert.match(
    storageFailure.checks.find((entry) => entry.name === "storage")?.summary,
    /statfs failed/
  );

  const script = path.resolve(__dirname, "..", "scripts", "gateway-hardware-check.js");
  const invalid = spawnSync(process.execPath, [script, "--unknown"], {
    encoding: "utf8"
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown option: --unknown/);
});
