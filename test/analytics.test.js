"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateOee } = require("../src/analytics/oee");
const { parseShiftSchedule } = require("../src/analytics/planned-time");
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
  assert.equal(result.counterMode, "good-count-proxy");
  assert.deepEqual(result.warnings, []);
});

test("OEE uses total production counter deltas when available", () => {
  const goodCounts = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18];
  const samples = goodCounts.map((goodCount, second) =>
    sample(second, {
      goodCount,
      totalProducedCount: second * 2
    })
  );

  const result = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 2
  });

  assert.equal(result.counterMode, "total-produced");
  assert.equal(result.performance, 1);
  assert.equal(result.quality, 0.9);
  assert.equal(result.oee, 0.9);
  assert.equal(result.goodDelta, 18);
  assert.equal(result.totalDelta, 20);
  assert.equal(result.counterScrapDelta, 2);
  assert.equal(result.lossBreakdown.speedLossUnits, 0);
  assert.equal(result.lossBreakdown.qualityLossUnits, 2);
  assert.equal(result.lossBreakdown.qualityLossSource, "total-counter-scrap");
  assert.equal(result.qualityReconciliation.status, "reconciled");
  assert.equal(result.qualityReconciliation.delta, 0);
  assert.equal(result.dataQuality.status, "ok");
  assert.deepEqual(result.warnings, []);
});

test("OEE reconciles counter scrap with the effective quality feed", () => {
  const samples = [
    sample(0, { goodCount: 0, totalProducedCount: 0 }),
    sample(1, { goodCount: 4, totalProducedCount: 6 }),
    sample(2, { goodCount: 8, totalProducedCount: 10 })
  ];
  const reconciled = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 2,
    qualitySource: "quality-events",
    qualityEventCount: 1,
    qualityEventQuantity: 2
  });
  assert.equal(reconciled.counterScrapDelta, 2);
  assert.equal(reconciled.qualityReconciliation.status, "reconciled");
  assert.equal(reconciled.qualityReconciliation.qualityInputQuantity, 2);
  assert.equal(reconciled.qualityReconciliation.qualityEventQuantity, 2);
  assert.equal(reconciled.qualityReconciliation.delta, 0);
  assert.equal(reconciled.qualityReconciliation.eventDelta, 0);
  assert.equal(reconciled.dataQuality.status, "ok");

  const mismatch = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 1,
    qualitySource: "quality-events",
    qualityEventCount: 1,
    qualityEventQuantity: 1
  });
  assert.equal(mismatch.qualityReconciliation.status, "mismatch");
  assert.equal(mismatch.qualityReconciliation.delta, 1);
  assert.equal(mismatch.dataQuality.status, "warning");
  assert.ok(
    mismatch.dataQuality.issues.some(
      (issue) => issue.code === "QUALITY_RECONCILIATION_MISMATCH"
    )
  );
  assert.ok(mismatch.warnings.some((warning) => warning.includes("differs")));
});

test("OEE reports an empty quality feed in structured data quality", () => {
  const result = calculateOee(
    [
      sample(0, { goodCount: 0, totalProducedCount: 0 }),
      sample(1, { goodCount: 4, totalProducedCount: 6 })
    ],
    {
      nominalOutputPerMinute: 120,
      ngCount: 0,
      qualitySource: "quality-events",
      qualityEventCount: 0,
      qualityEventQuantity: 0
    }
  );

  assert.equal(result.dataQuality.status, "warning");
  assert.ok(
    result.dataQuality.issues.some((issue) => issue.code === "QUALITY_EVENT_FEED_EMPTY")
  );
  assert.equal(result.qualityReconciliation.status, "mismatch");
  assert.equal(result.qualityReconciliation.qualityEventCount, 0);
});

test("OEE detects counter reset epochs and preserves observed production", () => {
  const result = calculateOee(
    [
      sample(0, { goodCount: 100, totalProducedCount: 200 }),
      sample(1, { goodCount: 102, totalProducedCount: 204 }),
      sample(2, { goodCount: 0, totalProducedCount: 0 }),
      sample(3, { goodCount: 2, totalProducedCount: 4 }),
      sample(4, { goodCount: 4, totalProducedCount: 8 })
    ],
    { nominalOutputPerMinute: 120, ngCount: 0 }
  );

  assert.equal(result.counterMode, "total-produced-reset-adjusted");
  assert.equal(result.goodDelta, 6);
  assert.equal(result.totalDelta, 12);
  assert.equal(result.counterScrapDelta, 6);
  assert.equal(result.quality, 0.5);
  assert.equal(result.counterContinuity.status, "reset-adjusted");
  assert.equal(result.counterContinuity.epochs, 2);
  assert.equal(result.counterContinuity.resetCount, 2);
  assert.equal(result.counterContinuity.goodCount.delta, 6);
  assert.equal(result.counterContinuity.totalProducedCount.delta, 12);
  assert.equal(
    result.counterContinuity.deltaBasis,
    "sum-of-observed-increments-within-counter-epochs"
  );
  assert.deepEqual(
    result.counterContinuity.resets.map((reset) => ({
      counter: reset.counter,
      sampleIndex: reset.sampleIndex,
      previousValue: reset.previousValue,
      value: reset.value
    })),
    [
      { counter: "goodCount", sampleIndex: 2, previousValue: 102, value: 0 },
      { counter: "totalProducedCount", sampleIndex: 2, previousValue: 204, value: 0 }
    ]
  );
  assert.ok(result.warnings.some((warning) => warning.includes("reset/rollback")));
  assert.equal(result.dataQuality.status, "warning");
  assert.equal(
    result.dataQuality.issues.filter((issue) => issue.code === "COUNTER_RESET").length,
    2
  );
  assert.equal(
    result.inputs.counterScope,
    "sum of adjacent increments within observed counter epochs"
  );
});

test("OEE uses a reset-adjusted good-count proxy without a total counter", () => {
  const result = calculateOee(
    [
      sample(0, { goodCount: 10 }),
      sample(1, { goodCount: 12 }),
      sample(2, { goodCount: 0 }),
      sample(3, { goodCount: 2 })
    ],
    { nominalOutputPerMinute: 120, ngCount: 0 }
  );

  assert.equal(result.counterMode, "good-count-proxy-reset-adjusted");
  assert.equal(result.goodDelta, 4);
  assert.equal(result.counterContinuity.status, "reset-adjusted");
  assert.equal(result.counterContinuity.goodCount.resetCount, 1);
  assert.equal(result.counterContinuity.totalProducedCount.status, "not-present");
  assert.ok(result.warnings.some((warning) => warning.includes("goodCount reset/rollback")));
});

test("OEE falls back when total production counters are incomplete or inconsistent", () => {

  const mixedSamples = [
    sample(0, { goodCount: 0, totalProducedCount: 0 }),
    sample(1, { goodCount: 1 }),
    sample(2, { goodCount: 2, totalProducedCount: 4 })
  ];
  const mixed = calculateOee(mixedSamples, {
    nominalOutputPerMinute: 120,
    ngCount: 0
  });
  assert.equal(mixed.counterMode, "good-count-proxy");
  assert.ok(mixed.warnings.some((warning) => warning.includes("missing or invalid")));
  assert.equal(mixed.dataQuality.status, "degraded");
  assert.ok(
    mixed.dataQuality.issues.some((issue) => issue.code === "TOTAL_COUNTER_INCOMPLETE")
  );

  const belowGood = calculateOee(
    [
      sample(0, { goodCount: 0, totalProducedCount: 0 }),
      sample(1, { goodCount: 5, totalProducedCount: 4 })
    ],
    { nominalOutputPerMinute: 120, ngCount: 0 }
  );
  assert.equal(belowGood.counterMode, "good-count-proxy");
  assert.ok(belowGood.warnings.some((warning) => warning.includes("below goodCount")));
  assert.equal(belowGood.dataQuality.status, "degraded");
});

test("OEE reports zero quality when total production does not advance", () => {
  const result = calculateOee(
    [
      sample(0, { goodCount: 0, totalProducedCount: 0 }),
      sample(10, { goodCount: 0, totalProducedCount: 0 })
    ],
    { nominalOutputPerMinute: 120, ngCount: 1 }
  );

  assert.equal(result.counterMode, "total-produced");
  assert.equal(result.totalDelta, 0);
  assert.equal(result.quality, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("did not advance")));
});

test("OEE clips availability to configured planned-time windows", () => {
  const result = calculateOee(
    [
      sample(50, { goodCount: 0 }),
      sample(70, { goodCount: 20 })
    ],
    {
      nominalOutputPerMinute: 120,
      ngCount: 0,
      plannedTime: {
        schedule: parseShiftSchedule("00:00-00:01"),
        timeZone: "UTC"
      }
    }
  );

  assert.equal(result.observedSeconds, 20);
  assert.equal(result.plannedSeconds, 10);
  assert.equal(result.plannedStopSeconds, 10);
  assert.equal(result.runningSeconds, 10);
  assert.equal(result.downtimeSeconds, 0);
  assert.equal(result.availability, 1);
  assert.equal(result.theoreticalGood, 20);
  assert.equal(result.plannedTime.windows, "00:00-00:01");
  assert.equal(result.plannedTime.timeZone, "UTC");
});

test("OEE warns when running occurs outside the planned shift", () => {
  const result = calculateOee(
    [
      sample(50, { goodCount: 0 }),
      sample(70, { goodCount: 20 })
    ],
    {
      nominalOutputPerMinute: 120,
      ngCount: 0,
      plannedTime: {
        schedule: parseShiftSchedule("00:01-00:02"),
        timeZone: "UTC"
      }
    }
  );

  assert.equal(result.plannedSeconds, 10);
  assert.equal(result.outsidePlanRunningSeconds, 10);
  assert.ok(result.warnings.some((warning) => warning.includes("outside configured shift")));
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
  assert.equal(result.plannedProductionSeconds, 10);
  assert.equal(result.unplannedStopSeconds, 2);
  assert.equal(result.lossBreakdown.availabilityLossSeconds, 2);
  assert.equal(result.goodDelta, 8);
});

test("OEE classifies planned downtime, changeover, unplanned and unknown stops", () => {
  const samples = [
    sample(0, { deviceStatus: "RUNNING", goodCount: 0 }),
    sample(2, { deviceStatus: "DOWN", goodCount: 2 }),
    sample(4, { deviceStatus: "DOWN", goodCount: 2 }),
    sample(6, { deviceStatus: "DOWN", goodCount: 2 }),
    sample(8, { deviceStatus: "UNKNOWN", goodCount: 2 }),
    sample(10, { deviceStatus: "RUNNING", goodCount: 2 })
  ];
  samples[1].alarms = [{ code: "planned_maint" }];
  samples[2].alarms = [{ code: "CHANGEOVER" }];

  const result = calculateOee(samples, {
    nominalOutputPerMinute: 120,
    ngCount: 0,
    downtimeClassification: {
      plannedAlarmCodes: ["PLANNED_MAINT"],
      changeoverAlarmCodes: ["CHANGEOVER"]
    }
  });

  assert.equal(result.availability, 0.333333);
  assert.equal(result.performance, 0.5);
  assert.equal(result.quality, 1);
  assert.equal(result.plannedProductionSeconds, 6);
  assert.equal(result.plannedDowntimeSeconds, 2);
  assert.equal(result.changeoverSeconds, 2);
  assert.equal(result.unplannedStopSeconds, 2);
  assert.equal(result.unknownStopSeconds, 2);
  assert.equal(result.downtimeSeconds, 8);
  assert.equal(result.lossBreakdown.availabilityLossSeconds, 4);
  assert.equal(result.lossBreakdown.speedLossUnits, 2);
  assert.equal(result.lossBreakdown.qualityLossUnits, 0);
  assert.equal(result.downtimeSources.plannedDowntime, "active-alarm-code");
  assert.equal(result.downtimeSources.changeover, "active-alarm-code");
  assert.ok(result.warnings.some((warning) => warning.includes("Unknown device status")));
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
  assert.equal(result.dataQuality.status, "insufficient");
  assert.equal(result.dataQuality.errorCount, 1);
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
