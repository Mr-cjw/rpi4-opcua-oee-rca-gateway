"use strict";

const { createShiftCalendar, defaultTimeZone } = require("./planned-time");

const DEFAULT_NOMINAL_OUTPUT_PER_MINUTE = 120;

function toMillis(value, label = "timestamp") {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${label} must be an ISO timestamp, Date, or epoch milliseconds`);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function metricValue(sample, metric) {
  if (sample?.metrics && sample.metrics[metric] !== undefined) {
    return sample.metrics[metric];
  }
  return sample?.[metric];
}

function sampleTime(sample) {
  return toMillis(sample?.occurredAt ?? sample?.timestamp ?? sample?.at, "sample timestamp");
}

function normalizeSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new Error("samples must be an array");
  }

  return samples
    .map((sample, index) => {
      const at = sampleTime(sample);
      const goodCount = Number(metricValue(sample, "goodCount"));
      const totalProducedRaw = metricValue(sample, "totalProducedCount");
      let totalProducedCount = null;
      let invalidTotalProducedCount = false;
      if (
        totalProducedRaw !== undefined &&
        totalProducedRaw !== null &&
        totalProducedRaw !== ""
      ) {
        const candidate = Number(totalProducedRaw);
        if (Number.isFinite(candidate) && candidate >= 0) {
          totalProducedCount = candidate;
        } else {
          invalidTotalProducedCount = true;
        }
      }
      const deviceStatus = String(metricValue(sample, "deviceStatus") || "UNKNOWN").toUpperCase();
      if (!Number.isFinite(goodCount)) {
        throw new Error(`samples[${index}].goodCount must be a finite number`);
      }
      return {
        at,
        goodCount,
        totalProducedCount,
        invalidTotalProducedCount,
        deviceStatus,
        sample
      };
    })
    .sort((left, right) => left.at - right.at);
}

function resolveCounterMode(rows, goodDelta, ngCount, warnings) {
  const proxy = {
    counterMode: "good-count-proxy",
    totalDelta: null,
    counterScrapDelta: null
  };
  const hasTotalFields = rows.some(
    (row) => row.totalProducedCount !== null || row.invalidTotalProducedCount
  );
  if (!hasTotalFields) {
    return proxy;
  }
  if (rows.some((row) => row.invalidTotalProducedCount || row.totalProducedCount === null)) {
    warnings.push(
      "totalProducedCount is missing or invalid in one or more samples; falling back to the goodCount proxy."
    );
    return proxy;
  }

  const rollbackIndex = rows.findIndex(
    (row, index) => index > 0 && row.totalProducedCount < rows[index - 1].totalProducedCount
  );
  if (rollbackIndex >= 0) {
    warnings.push(
      `totalProducedCount moved backwards at sample ${rollbackIndex}; falling back to the goodCount proxy.`
    );
    return proxy;
  }

  const belowGoodIndex = rows.findIndex(
    (row) => row.totalProducedCount < row.goodCount
  );
  if (belowGoodIndex >= 0) {
    warnings.push(
      `totalProducedCount is below goodCount at sample ${belowGoodIndex}; falling back to the goodCount proxy.`
    );
    return proxy;
  }

  const totalDelta = rows[rows.length - 1].totalProducedCount - rows[0].totalProducedCount;
  if (totalDelta < goodDelta) {
    warnings.push(
      "totalProducedCount delta is below goodCount delta; falling back to the goodCount proxy."
    );
    return proxy;
  }
  if (totalDelta === 0 && ngCount > 0) {
    warnings.push(
      "totalProducedCount did not advance although NG quantity was recorded; quality is reported as zero."
    );
  }
  return {
    counterMode: "total-produced",
    totalDelta: round(totalDelta),
    counterScrapDelta: round(Math.max(0, totalDelta - goodDelta))
  };
}

function calculateOee(samples, options = {}) {
  const rows = normalizeSamples(samples);
  const shiftCalendar = createShiftCalendar(
    options.plannedTime?.schedule,
    options.plannedTime?.timeZone || defaultTimeZone()
  );
  const plannedTime = {
    timeZone: shiftCalendar.timeZone,
    windows: shiftCalendar.scheduleText
  };
  const nominalOutputPerMinute = Number(
    options.nominalOutputPerMinute ?? DEFAULT_NOMINAL_OUTPUT_PER_MINUTE
  );
  const ngCount = Number(options.ngCount ?? 0);

  if (!Number.isFinite(nominalOutputPerMinute) || nominalOutputPerMinute <= 0) {
    throw new Error("nominalOutputPerMinute must be a positive number");
  }
  if (!Number.isInteger(ngCount) || ngCount < 0) {
    throw new Error("ngCount must be a non-negative integer");
  }

  const warnings = [];
  if (rows.length < 2) {
    const counterMode =
      rows.length === 1 &&
      rows[0].totalProducedCount !== null &&
      !rows[0].invalidTotalProducedCount
        ? "total-produced"
        : "good-count-proxy";
    const qualityBasis =
      counterMode === "total-produced"
        ? "goodCount delta / totalProducedCount delta"
        : "goodDelta / (goodDelta + ngCount)";
    const performanceBasis =
      counterMode === "total-produced"
        ? "totalProducedCount delta / theoretical produced units at nominal output"
        : "goodCount delta / theoretical good units at nominal output";
    return {
      availability: 0,
      performance: 0,
      quality: 0,
      oee: 0,
      observedSeconds: 0,
      plannedSeconds: 0,
      runningSeconds: 0,
      downtimeSeconds: 0,
      plannedStopSeconds: 0,
      outsidePlanRunningSeconds: 0,
      goodDelta: 0,
      theoreticalGood: 0,
      totalDelta: counterMode === "total-produced" ? 0 : null,
      counterScrapDelta: null,
      counterMode,
      ngCount,
      nominalOutputPerMinute,
      plannedTime,
      inputs: {
        sampleCount: rows.length,
        firstSampleAt: rows[0]?.sample?.occurredAt ?? null,
        lastSampleAt: rows[0]?.sample?.occurredAt ?? null,
        counterMode,
        counterScope: "first-to-last sample in observed window",
        plannedTime,
        qualityBasis
      },
      warnings: ["At least two samples are required to calculate OEE."],
      basis: {
        plannedTime: "intersection of sampled window and configured shift windows",
        availability: "RUNNING planned intervals / planned intervals",
        performance: performanceBasis,
        quality: qualityBasis
      }
    };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const observedMs = Math.max(0, last.at - first.at);
  let plannedMs = 0;
  let runningMs = 0;
  let outsidePlanRunningMs = 0;
  let unknownStatusMs = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const intervalMs = Math.max(0, current.at - previous.at);
    const intervalPlannedMs = shiftCalendar.plannedMillisecondsBetween(
      previous.at,
      current.at
    );
    plannedMs += intervalPlannedMs;
    if (previous.deviceStatus === "RUNNING") {
      runningMs += intervalPlannedMs;
      outsidePlanRunningMs += intervalMs - intervalPlannedMs;
    } else if (previous.deviceStatus !== "DOWN") {
      unknownStatusMs += intervalPlannedMs;
    }
  }

  const goodDelta = last.goodCount >= first.goodCount ? last.goodCount - first.goodCount : 0;
  if (last.goodCount < first.goodCount) {
    warnings.push("goodCount moved backwards; the delta is treated as zero.");
  }
  if (unknownStatusMs > 0) {
    warnings.push("Unknown device statuses are treated as non-running time.");
  }
  if (outsidePlanRunningMs > 0) {
    warnings.push(
      "The equipment was RUNNING outside configured shift windows; counters still reflect the observed sample window."
    );
  }

  const observedSeconds = observedMs / 1000;
  const plannedSeconds = plannedMs / 1000;
  const runningSeconds = runningMs / 1000;
  const availability = plannedMs > 0 ? clamp(runningMs / plannedMs, 0, 1) : 0;
  const theoreticalGood = nominalOutputPerMinute * (runningSeconds / 60);
  const counter = resolveCounterMode(rows, goodDelta, ngCount, warnings);
  const performanceNumerator =
    counter.counterMode === "total-produced" ? counter.totalDelta : goodDelta;
  const performance =
    theoreticalGood > 0 ? clamp(performanceNumerator / theoreticalGood, 0, 1) : 0;
  const qualityDenominator =
    counter.counterMode === "total-produced" ? counter.totalDelta : goodDelta + ngCount;
  const quality = qualityDenominator > 0 ? clamp(goodDelta / qualityDenominator, 0, 1) : 0;
  const oee = availability * performance * quality;
  const qualityBasis =
    counter.counterMode === "total-produced"
      ? "goodCount delta / totalProducedCount delta"
      : "goodDelta / (goodDelta + ngCount)";
  const performanceBasis =
    counter.counterMode === "total-produced"
      ? "totalProducedCount delta / theoretical produced units at nominal output"
      : "goodCount delta / theoretical good units at nominal output";

  if (plannedMs === 0) {
    warnings.push("No planned production time overlaps the observed sample window.");
  }
  if (options.ngCount === undefined && counter.counterMode === "good-count-proxy") {
    warnings.push(
      "ngCount was not supplied; quality assumes zero NG units and may overstate OEE."
    );
  }

  return {
    availability: round(availability),
    performance: round(performance),
    quality: round(quality),
    oee: round(oee),
    observedSeconds: round(observedSeconds, 3),
    plannedSeconds: round(plannedSeconds, 3),
    runningSeconds: round(runningSeconds, 3),
    downtimeSeconds: round(Math.max(0, plannedSeconds - runningSeconds), 3),
    plannedStopSeconds: round(Math.max(0, observedSeconds - plannedSeconds), 3),
    outsidePlanRunningSeconds: round(outsidePlanRunningMs / 1000, 3),
    goodDelta,
    theoreticalGood: round(theoreticalGood, 3),
    totalDelta: counter.totalDelta,
    counterScrapDelta: counter.counterScrapDelta,
    counterMode: counter.counterMode,
    ngCount,
    nominalOutputPerMinute,
    plannedTime,
    inputs: {
      sampleCount: rows.length,
      firstSampleAt: new Date(first.at).toISOString(),
      lastSampleAt: new Date(last.at).toISOString(),
      counterMode: counter.counterMode,
      counterScope: "first-to-last sample in observed window",
      totalDelta: counter.totalDelta,
      plannedTime,
      qualityBasis
    },
    warnings,
    basis: {
      plannedTime: "intersection of sampled window and configured shift windows",
      availability: "RUNNING planned intervals / planned intervals",
      performance: performanceBasis,
      quality: qualityBasis
    }
  };
}

module.exports = {
  DEFAULT_NOMINAL_OUTPUT_PER_MINUTE,
  calculateOee,
  metricValue,
  toMillis
};
