"use strict";

const { EventEmitter } = require("node:events");

const TWO_PI = Math.PI * 2;

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function probabilityPerTick(ratePerMinute, intervalMs) {
  if (ratePerMinute <= 0) {
    return 0;
  }
  return 1 - Math.exp((-ratePerMinute * intervalMs) / 60000);
}

class MockPlcSimulator extends EventEmitter {
  constructor(options) {
    super();

    this.options = options;
    this.random = mulberry32(options.seed);
    this.elapsedMs = 0;
    this.sequence = 0;
    this.deviceStatus = "RUNNING";
    this.currentOutput = options.nominalOutputPerMinute;
    this.goodCount = 0;
    this.goodCountAccumulator = 0;
    this.totalProducedCount = 0;
    this.totalProducedAccumulator = 0;
    this.temperatureC = options.ambientTemperatureC;

    this.downtimeRemainingMs = 0;
    this.downtimeTotalMs = 0;
    this.temperatureSpikeRemainingMs = 0;
    this.temperatureSpikeTotalMs = 0;
    this.temperaturePeakC = 0;
    this.activeAlarms = new Map();
    this.latestAlarm = null;
  }

  static create(options) {
    return new MockPlcSimulator(options);
  }

  get isRunning() {
    return this.deviceStatus === "RUNNING";
  }

  get isTemperatureSpiking() {
    return this.temperatureSpikeRemainingMs > 0;
  }

  triggerDowntime(durationSeconds = 20, cause = "MANUAL_FAULT_INJECTION") {
    if (this.downtimeRemainingMs > 0) {
      return null;
    }

    const durationMs = clamp(Math.round(durationSeconds * 1000), 1000, 24 * 60 * 60 * 1000);
    this.downtimeRemainingMs = durationMs;
    this.downtimeTotalMs = durationMs;
    this.deviceStatus = "DOWN";
    return this._recordAlarm({
      code: "DOWNTIME",
      severity: 700,
      message: `Device stopped: ${cause}`,
      cause
    });
  }

  triggerTemperatureSpike(durationSeconds = 20, peakC = 88) {
    if (this.temperatureSpikeRemainingMs > 0) {
      return null;
    }

    const durationMs = clamp(Math.round(durationSeconds * 1000), 1000, 24 * 60 * 60 * 1000);
    this.temperatureSpikeRemainingMs = durationMs;
    this.temperatureSpikeTotalMs = durationMs;
    this.temperaturePeakC = clamp(peakC, 60, 150);
    return this._recordAlarm({
      code: "TEMPERATURE_SPIKE",
      severity: 800,
      message: `Temperature spike target: ${round(this.temperaturePeakC, 1)} C`,
      cause: "MANUAL_FAULT_INJECTION"
    });
  }

  resumeNormal() {
    const events = [];

    if (this.downtimeRemainingMs > 0) {
      this.downtimeRemainingMs = 0;
      events.push(this._completeDowntime("MANUAL_RESUME"));
    }

    if (this.temperatureSpikeRemainingMs > 0) {
      this.temperatureSpikeRemainingMs = 0;
      events.push(this._completeTemperatureSpike("MANUAL_RESUME"));
    }

    return events.filter(Boolean);
  }

  tick(deltaMs = this.options.intervalMs) {
    const dt = clamp(deltaMs, 1, 60000);
    this.elapsedMs += dt;
    const events = [];

    if (this.downtimeRemainingMs > 0) {
      this.downtimeRemainingMs = Math.max(0, this.downtimeRemainingMs - dt);
      if (this.downtimeRemainingMs === 0) {
        const event = this._completeDowntime("RECOVERY_TIMER_EXPIRED");
        if (event) {
          events.push(event);
        }
      }
    } else if (
      this.isRunning &&
      this.random() < probabilityPerTick(this.options.downtimeRatePerMinute, dt)
    ) {
      const durationSeconds = 12 + Math.round(this.random() * 28);
      const event = this.triggerDowntime(durationSeconds, "RANDOM_PRODUCTION_ANOMALY");
      if (event) {
        events.push(event);
      }
    }

    if (this.temperatureSpikeRemainingMs > 0) {
      this.temperatureSpikeRemainingMs = Math.max(0, this.temperatureSpikeRemainingMs - dt);
      if (this.temperatureSpikeRemainingMs === 0) {
        const event = this._completeTemperatureSpike("RECOVERY_TIMER_EXPIRED");
        if (event) {
          events.push(event);
        }
      }
    } else if (this.random() < probabilityPerTick(this.options.temperatureSpikeRatePerMinute, dt)) {
      const durationSeconds = 15 + Math.round(this.random() * 25);
      const peakC = 78 + this.random() * 22;
      const event = this.triggerTemperatureSpike(durationSeconds, peakC);
      if (event) {
        events.push(event);
      }
    }

    this._updateProcessValues(dt);
    const snapshot = this.snapshot();
    if (this.options.logEachTick) {
      this.emit("sample", snapshot);
    }

    return { snapshot, events };
  }

  snapshot() {
    return {
      timestamp: new Date().toISOString(),
      sequence: this.sequence,
      deviceStatus: this.deviceStatus,
      currentOutput: round(this.currentOutput, 3),
      goodCount: this.goodCount,
      totalProducedCount: this.totalProducedCount,
      temperatureC: round(this.temperatureC, 3),
      activeAlarms: [...this.activeAlarms.values()].map((alarm) => ({ ...alarm })),
      latestAlarm: this.latestAlarm ? { ...this.latestAlarm } : null
    };
  }

  alarmEventsJson() {
    return JSON.stringify({
      sequence: this.sequence,
      active: [...this.activeAlarms.values()],
      latest: this.latestAlarm
    });
  }

  _updateProcessValues(dt) {
    const seconds = this.elapsedMs / 1000;
    const runningTarget =
      this.options.nominalOutputPerMinute *
      (1 + 0.06 * Math.sin((TWO_PI * seconds) / 90) + 0.025 * Math.sin((TWO_PI * seconds) / 13));
    const outputTarget = this.isRunning ? Math.max(0, runningTarget) : 0;
    const outputSmoothing = 1 - Math.exp(-dt / 1200);
    this.currentOutput += (outputTarget - this.currentOutput) * outputSmoothing;
    this.currentOutput += (this.random() - 0.5) * 0.5;
    this.currentOutput = clamp(this.currentOutput, 0, this.options.nominalOutputPerMinute * 1.25);

    const normalTemperatureTarget =
      this.options.ambientTemperatureC +
      1.8 * Math.sin((TWO_PI * seconds) / 180) +
      this.currentOutput * 0.012;
    const spikeProgress =
      this.temperatureSpikeRemainingMs > 0
        ? 1 - this.temperatureSpikeRemainingMs / this.temperatureSpikeTotalMs
        : 0;
    const spikeEnvelope =
      this.temperatureSpikeRemainingMs > 0 ? Math.sin(Math.PI * clamp(spikeProgress, 0, 1)) : 0;
    const temperatureTarget =
      normalTemperatureTarget + (this.temperaturePeakC - normalTemperatureTarget) * spikeEnvelope;
    const temperatureSmoothing = 1 - Math.exp(-dt / 900);
    this.temperatureC += (temperatureTarget - this.temperatureC) * temperatureSmoothing;
    this.temperatureC += (this.random() - 0.5) * 0.12;

    if (this.isRunning && this.currentOutput > 0) {
      const outputUnits = (this.currentOutput / 60000) * dt;
      this.totalProducedAccumulator += outputUnits;
      this.goodCountAccumulator += outputUnits * this.options.yieldRate;
      const completedTotal = Math.floor(this.totalProducedAccumulator);
      if (completedTotal > 0) {
        this.totalProducedCount = Math.min(
          0xffffffff,
          this.totalProducedCount + completedTotal
        );
        this.totalProducedAccumulator -= completedTotal;
      }
      const completedUnits = Math.floor(this.goodCountAccumulator);
      if (completedUnits > 0) {
        this.goodCount = Math.min(0xffffffff, this.goodCount + completedUnits);
        this.goodCountAccumulator -= completedUnits;
      }
    }
  }

  _completeDowntime(cause) {
    this.deviceStatus = "RUNNING";
    this.activeAlarms.delete("DOWNTIME");
    return this._recordAlarm({
      code: "DOWNTIME_CLEARED",
      severity: 200,
      message: `Device recovered: ${cause}`,
      cause
    });
  }

  _completeTemperatureSpike(cause) {
    this.activeAlarms.delete("TEMPERATURE_SPIKE");
    return this._recordAlarm({
      code: "TEMPERATURE_SPIKE_CLEARED",
      severity: 200,
      message: `Temperature recovered: ${cause}`,
      cause
    });
  }

  _recordAlarm({ code, severity, message, cause }) {
    this.sequence += 1;
    const event = {
      sequence: this.sequence,
      eventId: `${Date.now()}-${this.sequence}`,
      time: new Date().toISOString(),
      code,
      severity,
      message,
      cause,
      deviceStatus: this.deviceStatus,
      temperatureC: round(this.temperatureC, 3),
      currentOutput: round(this.currentOutput, 3),
      goodCount: this.goodCount,
      totalProducedCount: this.totalProducedCount
    };

    this.latestAlarm = event;

    if (code === "DOWNTIME" || code === "TEMPERATURE_SPIKE") {
      this.activeAlarms.set(code, event);
    }

    this.emit("alarm", event);
    return event;
  }
}

module.exports = {
  MockPlcSimulator,
  mulberry32
};
