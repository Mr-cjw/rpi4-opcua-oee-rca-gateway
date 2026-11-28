"use strict";

const fsp = require("node:fs/promises");
const {
  DEFAULT_MAX_TEMPERATURE_C,
  DEFAULT_WARN_TEMPERATURE_C,
  THERMAL_PATH,
  defaultRunCommand,
  decodeThrottleFlags,
  parseThermalMilliC,
  parseThrottleValue,
  parseVcgencmdTemperature,
  readOptionalText,
  safeRunCommand
} = require("./check");

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

async function sampleHostTelemetry(dependencies = {}) {
  const readFile = dependencies.readFile || fsp.readFile;
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const now = dependencies.now || (() => new Date());
  const errors = [];
  let temperatureC = null;
  let temperatureSource = null;

  const thermal = await readOptionalText(readFile, THERMAL_PATH);
  if (thermal !== null) {
    temperatureC = parseThermalMilliC(thermal);
    if (temperatureC === null) {
      errors.push("thermal_zone_value_invalid");
    } else {
      temperatureSource = "thermal_zone";
    }
  }
  if (temperatureC === null) {
    const command = await safeRunCommand(runCommand, "vcgencmd", ["measure_temp"]);
    if (command.ok) {
      temperatureC = parseVcgencmdTemperature(command.stdout);
      if (temperatureC === null) {
        errors.push("vcgencmd_temperature_invalid");
      } else {
        temperatureSource = "vcgencmd";
      }
    } else {
      errors.push(
        `vcgencmd_temperature_unavailable:${cleanError(command.error || command.code)}`
      );
    }
  }

  let throttled = null;
  const throttleCommand = await safeRunCommand(runCommand, "vcgencmd", ["get_throttled"]);
  if (throttleCommand.ok) {
    const value = parseThrottleValue(throttleCommand.stdout);
    if (value === null) {
      errors.push("vcgencmd_throttle_invalid");
    } else {
      throttled = decodeThrottleFlags(value);
    }
  } else {
    errors.push(
      `vcgencmd_throttle_unavailable:${cleanError(
        throttleCommand.error || throttleCommand.code
      )}`
    );
  }

  return {
    at: now().toISOString(),
    temperatureC,
    temperatureSource,
    throttled,
    errors
  };
}

class HardwareSampler {
  constructor(options = {}, dependencies = {}) {
    this.warnTemperatureC = positiveNumber(
      options.warnTemperatureC ?? DEFAULT_WARN_TEMPERATURE_C,
      "warnTemperatureC"
    );
    this.maxTemperatureC = positiveNumber(
      options.maxTemperatureC ?? DEFAULT_MAX_TEMPERATURE_C,
      "maxTemperatureC"
    );
    if (this.warnTemperatureC >= this.maxTemperatureC) {
      throw new Error("warnTemperatureC must be less than maxTemperatureC");
    }
    this.sampleTelemetry = dependencies.sample || sampleHostTelemetry;
    this.readFile = dependencies.readFile;
    this.runCommand = dependencies.runCommand;
    this.now = dependencies.now || (() => new Date());
    this.attempts = 0;
    this.successfulSamples = 0;
    this.failedSamples = 0;
    this.partialSamples = 0;
    this.firstSampleAt = null;
    this.lastSampleAt = null;
    this.temperatureSamples = 0;
    this.temperatureMinC = null;
    this.temperatureMaxC = null;
    this.temperatureLastC = null;
    this.temperatureWarningSamples = 0;
    this.temperatureFailureSamples = 0;
    this.temperatureSources = new Set();
    this.throttleSamples = 0;
    this.throttledLast = null;
    this.currentConditions = new Set();
    this.occurredConditions = new Set();
    this.flagBits = {};
    this.errors = [];
  }

  async sample() {
    this.attempts += 1;
    let sample;
    try {
      sample = await this.sampleTelemetry({
        readFile: this.readFile,
        runCommand: this.runCommand,
        now: this.now
      });
    } catch (error) {
      this.failedSamples += 1;
      this._recordError(cleanError(error));
      return null;
    }

    const hasTemperature = Number.isFinite(sample?.temperatureC);
    const hasThrottle = sample?.throttled !== null && sample?.throttled !== undefined;
    if (!hasTemperature && !hasThrottle) {
      this.failedSamples += 1;
    } else {
      this.successfulSamples += 1;
    }
    if (!hasTemperature || !hasThrottle) {
      this.partialSamples += 1;
    }
    for (const error of sample?.errors || []) {
      this._recordError(error);
    }

    if (hasTemperature) {
      const value = sample.temperatureC;
      this.temperatureSamples += 1;
      this.temperatureLastC = value;
      this.temperatureMinC =
        this.temperatureMinC === null ? value : Math.min(this.temperatureMinC, value);
      this.temperatureMaxC =
        this.temperatureMaxC === null ? value : Math.max(this.temperatureMaxC, value);
      if (value >= this.maxTemperatureC) {
        this.temperatureFailureSamples += 1;
      } else if (value >= this.warnTemperatureC) {
        this.temperatureWarningSamples += 1;
      }
      if (sample.temperatureSource) {
        this.temperatureSources.add(sample.temperatureSource);
      }
    }

    if (hasThrottle) {
      const { raw, bits, current, occurred } = sample.throttled;
      this.throttleSamples += 1;
      this.throttledLast = raw;
      for (const [name, set] of Object.entries(bits)) {
        if (set) {
          this.flagBits[name] = true;
        }
      }
      for (const condition of current) {
        this.currentConditions.add(condition);
      }
      for (const condition of occurred) {
        this.occurredConditions.add(condition);
      }
    }

    const sampleAt = sample?.at || this.now().toISOString();
    this.firstSampleAt ||= sampleAt;
    this.lastSampleAt = sampleAt;
    return sample;
  }

  _recordError(error) {
    this.errors.push(error);
    if (this.errors.length > 5) {
      this.errors.shift();
    }
  }

  getStatus() {
    const current = [...this.currentConditions].sort();
    const occurred = [...this.occurredConditions].sort();
    const temperatureAvailable = this.temperatureSamples > 0;
    const powerAvailable = this.throttleSamples > 0;
    const healthy =
      this.successfulSamples > 0 &&
      this.failedSamples === 0 &&
      this.partialSamples === 0 &&
      temperatureAvailable &&
      powerAvailable &&
      current.length === 0 &&
      occurred.length === 0 &&
      this.temperatureFailureSamples === 0;
    return {
      enabled: true,
      healthy,
      attempts: this.attempts,
      successfulSamples: this.successfulSamples,
      failedSamples: this.failedSamples,
      partialSamples: this.partialSamples,
      firstSampleAt: this.firstSampleAt,
      lastSampleAt: this.lastSampleAt,
      temperature: {
        available: temperatureAvailable,
        samples: this.temperatureSamples,
        minC: this.temperatureMinC,
        maxC: this.temperatureMaxC,
        lastC: this.temperatureLastC,
        warnC: this.warnTemperatureC,
        maxLimitC: this.maxTemperatureC,
        warningSamples: this.temperatureWarningSamples,
        failureSamples: this.temperatureFailureSamples,
        sources: [...this.temperatureSources].sort()
      },
      power: {
        available: powerAvailable,
        samples: this.throttleSamples,
        throttledLast: this.throttledLast,
        flags: { ...this.flagBits },
        current,
        occurred
      },
      errors: [...this.errors]
    };
  }
}

module.exports = {
  HardwareSampler,
  sampleHostTelemetry
};
