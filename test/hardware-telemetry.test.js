"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeThrottleFlags } = require("../src/hardware/check");
const {
  HardwareSampler,
  sampleHostTelemetry
} = require("../src/hardware/telemetry");

test("host telemetry prefers thermal_zone and decodes power flags", async () => {
  const sample = await sampleHostTelemetry({
    now: () => new Date("2026-11-28T15:00:00.000Z"),
    readFile: async () => "52500\n",
    runCommand: async (command, args) => {
      assert.equal(command, "vcgencmd");
      assert.deepEqual(args, ["get_throttled"]);
      return { ok: true, stdout: "throttled=0x50000\n", stderr: "" };
    }
  });

  assert.equal(sample.at, "2026-11-28T15:00:00.000Z");
  assert.equal(sample.temperatureC, 52.5);
  assert.equal(sample.temperatureSource, "thermal_zone");
  assert.equal(sample.throttled.raw, "0x50000");
  assert.equal(sample.throttled.bits.underVoltageOccurred, true);
  assert.deepEqual(sample.errors, []);
});

test("host telemetry falls back to vcgencmd when thermal_zone is unavailable", async () => {
  const sample = await sampleHostTelemetry({
    readFile: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runCommand: async (command, args) => {
      assert.equal(command, "vcgencmd");
      if (args[0] === "measure_temp") {
        return { ok: true, stdout: "temp=56.0'C\n", stderr: "" };
      }
      return { ok: true, stdout: "throttled=0x0\n", stderr: "" };
    }
  });

  assert.equal(sample.temperatureC, 56);
  assert.equal(sample.temperatureSource, "vcgencmd");
  assert.equal(sample.throttled.raw, "0x0");
  assert.deepEqual(sample.errors, []);
});

test("hardware sampler aggregates temperature and latched power evidence", async () => {
  const samples = [
    {
      at: "2026-11-28T15:00:00.000Z",
      temperatureC: 52,
      temperatureSource: "thermal_zone",
      throttled: decodeThrottleFlags(0),
      errors: []
    },
    {
      at: "2026-11-28T15:01:00.000Z",
      temperatureC: 72,
      temperatureSource: "thermal_zone",
      throttled: decodeThrottleFlags(0x50000),
      errors: []
    },
    {
      at: "2026-11-28T15:02:00.000Z",
      temperatureC: 81,
      temperatureSource: "thermal_zone",
      throttled: decodeThrottleFlags(0x1),
      errors: []
    }
  ];
  const sampler = new HardwareSampler(
    { warnTemperatureC: 70, maxTemperatureC: 80 },
    { sample: async () => samples.shift() }
  );

  await sampler.sample();
  await sampler.sample();
  await sampler.sample();
  const status = sampler.getStatus();

  assert.equal(status.healthy, false);
  assert.equal(status.successfulSamples, 3);
  assert.equal(status.failedSamples, 0);
  assert.equal(status.temperature.minC, 52);
  assert.equal(status.temperature.maxC, 81);
  assert.equal(status.temperature.warningSamples, 1);
  assert.equal(status.temperature.failureSamples, 1);
  assert.equal(status.power.available, true);
  assert.equal(status.power.flags.underVoltage, true);
  assert.equal(status.power.flags.underVoltageOccurred, true);
  assert.deepEqual(status.power.current, ["under-voltage detected"]);
  assert.deepEqual(status.power.occurred, [
    "throttling occurred",
    "under-voltage occurred"
  ]);
});

test("hardware sampler marks missing telemetry as failed evidence", async () => {
  const sampler = new HardwareSampler(
    {},
    {
      sample: async () => {
        throw new Error("telemetry unavailable");
      }
    }
  );

  assert.equal(await sampler.sample(), null);
  const status = sampler.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.healthy, false);
  assert.equal(status.successfulSamples, 0);
  assert.equal(status.failedSamples, 1);
  assert.equal(status.temperature.available, false);
  assert.equal(status.power.available, false);
  assert.deepEqual(status.errors, ["telemetry unavailable"]);
});
