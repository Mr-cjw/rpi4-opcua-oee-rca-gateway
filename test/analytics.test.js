"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateOee } = require("../src/analytics/oee");
const { analyzeRca } = require("../src/analytics/rca");

const BASE_MS = Date.parse("2026-11-27T00:00:00.000Z");

function at(seconds) {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function sample(seconds, overrides = {}) {
  return {
    occurredAt: at(seconds),
    metrics: {
      deviceStatus: "RUNNING",
      currentOutput: 120,
      goodCount: seconds,
      temperatureC: 24,
      ...overrides
    }
  };
}

test("OEE decomposes availability, performance and quality inputs", () => {
  const goodCounts = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18];
  const samples = goodCounts.map((goodCount, second) => sample(second, { goodCount }));

  const result = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 2
  });

  assert.equal(result.availability, 1);
  assert.equal(result.performance, 0.9);
  assert.equal(result.quality, 0.9);
  assert.equal(result.oee, 0.81);
  assert.equal(result.observedSeconds, 10);
  assert.equal(result.runningSeconds, 10);
  assert.equal(result.goodDelta, 18);
  assert.equal(result.theoreticalGood, 20);
  assert.deepEqual(result.warnings, []);
});

test("OEE counts a simulated downtime against availability and freezes GoodCount", () => {
  const goodCountBySecond = [0, 1, 2, 3, 4, 4, 4, 5, 6, 7, 8];
  const samples = goodCountBySecond.map((goodCount, second) =>
    sample(second, {
      deviceStatus: second === 4 || second === 5 ? "DOWN" : "RUNNING",
      goodCount
    })
  );

  const result = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 2
  });

  assert.equal(result.availability, 0.8);
  assert.equal(result.performance, 0.5);
  assert.equal(result.quality, 0.8);
  assert.equal(result.oee, 0.32);
  assert.equal(result.runningSeconds, 8);
  assert.equal(result.downtimeSeconds, 2);
  assert.equal(result.goodDelta, 8);
});

test("OEE warns when NG count is omitted and does not invent quality data", () => {
  const result = calculateOee([sample(0), sample(10, { goodCount: 20 })], {
    nominalOutputPerMinute: 120
  });

  assert.equal(result.quality, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("ngCount")));
});

test("OEE returns an explicit zero result when the window has too few samples", () => {
  const result = calculateOee([sample(0)], { ngCount: 1 });

  assert.equal(result.oee, 0);
  assert.equal(result.inputs.sampleCount, 1);
  assert.ok(result.warnings.length > 0);
});

test("RCA reports temperature and downtime as non-causal candidates", () => {
  const events = [
    sample(40, { goodCount: 80, temperatureC: 24 }),
    sample(50, { goodCount: 80, deviceStatus: "DOWN", temperatureC: 25 }),
    sample(55, { goodCount: 80, deviceStatus: "DOWN", temperatureC: 92 }),
    sample(60, { goodCount: 80, deviceStatus: "RUNNING", temperatureC: 74 }),
    sample(70, { goodCount: 100, temperatureC: 30 })
  ];
  events[2].alarms = [
    {
      eventId: "alarm-temp-1",
      occurredAt: at(54),
      code: "TEMPERATURE_SPIKE",
      severity: 800,
      message: "Temperature spike"
    }
  ];
  events[1].alarms = [
    {
      eventId: "alarm-down-1",
      occurredAt: at(50),
      code: "DOWNTIME",
      severity: 700,
      message: "Device stopped"
    }
  ];

  const result = analyzeRca(events, {
    targetAt: at(60),
    windowMs: 30_000,
    temperatureThresholdC: 70
  });

  assert.equal(result.sampleCount, 5);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.some((candidate) => candidate.code === "TEMPERATURE_SPIKE"));
  assert.ok(result.candidates.some((candidate) => candidate.code === "DOWNTIME"));
  for (const candidate of result.candidates) {
    assert.equal(candidate.causalClaim, false);
    assert.match(candidate.confidenceLabel, /not causal proof/i);
    assert.ok(candidate.evidence.length >= 2);
  }
  const temperature = result.candidates.find(
    (candidate) => candidate.code === "TEMPERATURE_SPIKE"
  );
  assert.equal(temperature.metrics.peakTemperatureC, 92);
});

test("RCA returns inconclusive when the anomaly is outside the target window", () => {
  const result = analyzeRca(
    [
      sample(0, { temperatureC: 95, deviceStatus: "DOWN" }),
      sample(10, { temperatureC: 24, deviceStatus: "RUNNING" })
    ],
    { targetAt: at(10 * 60), windowMs: 30_000 }
  );

  assert.equal(result.conclusion, "INCONCLUSIVE");
  assert.deepEqual(result.candidates, []);
});

test("RCA accepts explicitly supplied alarm history", () => {
  const result = analyzeRca([sample(59, { temperatureC: 25 })], {
    targetAt: at(60),
    windowMs: 30_000,
    temperatureThresholdC: 70,
    alarms: [
      {
        occurredAt: at(58),
        code: "TEMPERATURE_SPIKE",
        message: "Spike captured between samples"
      }
    ]
  });

  assert.equal(result.conclusion, "TEMPERATURE_SPIKE");
  assert.equal(result.alarmCount, 1);
});
