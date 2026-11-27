"use strict";

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
      const deviceStatus = String(metricValue(sample, "deviceStatus") || "UNKNOWN").toUpperCase();
      if (!Number.isFinite(goodCount)) {
        throw new Error(`samples[${index}].goodCount must be a finite number`);
      }
      return { at, goodCount, deviceStatus, sample };
    })
    .sort((left, right) => left.at - right.at);
}

function calculateOee(samples, options = {}) {
  const rows = normalizeSamples(samples);
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
    return {
      availability: 0,
      performance: 0,
      quality: 0,
      oee: 0,
      observedSeconds: 0,
      runningSeconds: 0,
      downtimeSeconds: 0,
      goodDelta: 0,
      theoreticalGood: 0,
      ngCount,
      nominalOutputPerMinute,
      inputs: {
        sampleCount: rows.length,
        firstSampleAt: rows[0]?.sample?.occurredAt ?? null,
        lastSampleAt: rows[0]?.sample?.occurredAt ?? null,
        qualityBasis: "goodDelta / (goodDelta + ngCount)"
      },
      warnings: ["At least two samples are required to calculate OEE."],
      basis: {
        plannedTime: "observed window",
        availability: "RUNNING intervals / observed intervals",
        performance: "goodCount delta / theoretical good units at nominal output",
        quality: "goodCount delta / (goodCount delta + NG count)"
      }
    };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const observedMs = Math.max(0, last.at - first.at);
  let runningMs = 0;
  let unknownStatusMs = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const intervalMs = Math.max(0, current.at - previous.at);
    if (previous.deviceStatus === "RUNNING") {
      runningMs += intervalMs;
    } else if (previous.deviceStatus !== "DOWN") {
      unknownStatusMs += intervalMs;
    }
  }

  const goodDelta = last.goodCount >= first.goodCount ? last.goodCount - first.goodCount : 0;
  if (last.goodCount < first.goodCount) {
    warnings.push("goodCount moved backwards; the delta is treated as zero.");
  }
  if (unknownStatusMs > 0) {
    warnings.push("Unknown device statuses are treated as non-running time.");
  }

  const observedSeconds = observedMs / 1000;
  const runningSeconds = runningMs / 1000;
  const availability = observedMs > 0 ? clamp(runningMs / observedMs, 0, 1) : 0;
  const theoreticalGood = nominalOutputPerMinute * (runningSeconds / 60);
  const performance = theoreticalGood > 0 ? clamp(goodDelta / theoreticalGood, 0, 1) : 0;
  const qualityDenominator = goodDelta + ngCount;
  const quality = qualityDenominator > 0 ? clamp(goodDelta / qualityDenominator, 0, 1) : 0;
  const oee = availability * performance * quality;

  if (options.ngCount === undefined) {
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
    runningSeconds: round(runningSeconds, 3),
    downtimeSeconds: round(Math.max(0, observedSeconds - runningSeconds), 3),
    goodDelta,
    theoreticalGood: round(theoreticalGood, 3),
    ngCount,
    nominalOutputPerMinute,
    inputs: {
      sampleCount: rows.length,
      firstSampleAt: new Date(first.at).toISOString(),
      lastSampleAt: new Date(last.at).toISOString(),
      qualityBasis: "goodDelta / (goodDelta + ngCount)"
    },
    warnings,
    basis: {
      plannedTime: "observed window",
      availability: "RUNNING intervals / observed intervals",
      performance: "goodCount delta / theoretical good units at nominal output",
      quality: "goodCount delta / (goodCount delta + NG count)"
    }
  };
}

module.exports = {
  DEFAULT_NOMINAL_OUTPUT_PER_MINUTE,
  calculateOee,
  metricValue,
  toMillis
};
