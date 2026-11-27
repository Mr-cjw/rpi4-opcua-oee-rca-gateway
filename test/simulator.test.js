"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MockPlcSimulator } = require("../src/simulator");

function simulationOptions(overrides = {}) {
  return {
    intervalMs: 500,
    seed: 12345,
    nominalOutputPerMinute: 120,
    yieldRate: 0.98,
    ambientTemperatureC: 23.5,
    downtimeRatePerMinute: 0,
    temperatureSpikeRatePerMinute: 0,
    logEachTick: false,
    ...overrides
  };
}

test("normal production is smooth and increases GoodCount", () => {
  const simulator = MockPlcSimulator.create(simulationOptions());
  const samples = [];

  for (let index = 0; index < 120; index += 1) {
    const result = simulator.tick(250);
    samples.push(result.snapshot);
    assert.equal(result.events.length, 0);
  }

  const outputs = samples.map((sample) => sample.currentOutput);
  for (let index = 1; index < outputs.length; index += 1) {
    assert.ok(
      Math.abs(outputs[index] - outputs[index - 1]) < 5,
      "normal production output should not change abruptly"
    );
  }

  assert.equal(simulator.deviceStatus, "RUNNING");
  assert.ok(simulator.currentOutput > 100 && simulator.currentOutput < 140);
  assert.ok(simulator.temperatureC > 20 && simulator.temperatureC < 32);
  assert.ok(simulator.goodCount > 0);
  assert.ok(simulator.totalProducedCount >= simulator.goodCount);
  assert.ok(simulator.totalProducedCount > simulator.goodCount);
});

test("downtime freezes GoodCount and recovers after its duration", () => {
  const simulator = MockPlcSimulator.create(simulationOptions());
  for (let index = 0; index < 8; index += 1) {
    simulator.tick(250);
  }

  const event = simulator.triggerDowntime(2, "unit-test");
  assert.equal(event.code, "DOWNTIME");
  const countAtStop = simulator.goodCount;
  const totalAtStop = simulator.totalProducedCount;

  for (let index = 0; index < 6; index += 1) {
    simulator.tick(250);
  }

  assert.equal(simulator.deviceStatus, "DOWN");
  assert.equal(simulator.goodCount, countAtStop);
  assert.equal(simulator.totalProducedCount, totalAtStop);
  assert.ok(simulator.currentOutput < 80);

  simulator.tick(750);
  assert.equal(simulator.deviceStatus, "RUNNING");
  assert.ok(simulator.latestAlarm.code === "DOWNTIME_CLEARED");
});

test("temperature spike raises the temperature and emits a cleared event", () => {
  const simulator = MockPlcSimulator.create(simulationOptions());
  const startTemperature = simulator.temperatureC;
  const event = simulator.triggerTemperatureSpike(4, 95);
  assert.equal(event.code, "TEMPERATURE_SPIKE");

  let maximum = startTemperature;
  for (let index = 0; index < 18; index += 1) {
    simulator.tick(250);
    maximum = Math.max(maximum, simulator.temperatureC);
  }

  assert.ok(maximum > startTemperature + 20);
  assert.equal(simulator.isTemperatureSpiking, false);
  assert.equal(simulator.latestAlarm.code, "TEMPERATURE_SPIKE_CLEARED");
});

test("the same seed produces deterministic snapshots", () => {
  const first = MockPlcSimulator.create(simulationOptions({ seed: 99 }));
  const second = MockPlcSimulator.create(simulationOptions({ seed: 99 }));

  const firstSnapshots = [];
  const secondSnapshots = [];
  for (let index = 0; index < 40; index += 1) {
    firstSnapshots.push(first.tick(500).snapshot);
    secondSnapshots.push(second.tick(500).snapshot);
  }

  for (let index = 0; index < firstSnapshots.length; index += 1) {
    assert.equal(firstSnapshots[index].currentOutput, secondSnapshots[index].currentOutput);
    assert.equal(firstSnapshots[index].goodCount, secondSnapshots[index].goodCount);
    assert.equal(
      firstSnapshots[index].totalProducedCount,
      secondSnapshots[index].totalProducedCount
    );
    assert.equal(firstSnapshots[index].temperatureC, secondSnapshots[index].temperatureC);
  }
});
