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

function normalizeAlarmCodes(sample) {
  const alarms = Array.isArray(sample?.alarms) ? sample.alarms : [];
  const codes = new Set();
  for (const alarm of alarms) {
    const code = alarm?.code ?? alarm?.alarmCode;
    if (typeof code === "string" && code.trim() !== "") {
      codes.add(code.trim().toUpperCase());
    }
  }
  return codes;
}

function findMatchingAlarmCode(row, configuredCodes) {
  if (configuredCodes.size === 0) {
    return null;
  }
  for (const code of row.alarmCodes) {
    if (configuredCodes.has(code)) {
      return code;
    }
  }
  return null;
}

function analyzeCounterSeries(rows, field, invalidFlag) {
  const resets = [];
  let delta = 0;
  let epochs = 0;
  let previous = null;
  let present = false;
  let invalid = false;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (invalidFlag && row[invalidFlag]) {
      invalid = true;
    }
    const value = row[field];
    if (value === null) {
      continue;
    }
    present = true;
    if (!Number.isFinite(value) || value < 0) {
      invalid = true;
      continue;
    }
    if (previous === null) {
      epochs = 1;
      previous = { value, at: row.at };
      continue;
    }
    if (value < previous.value) {
      epochs += 1;
      resets.push({
        counter: field,
        epoch: epochs,
        sampleIndex: index,
        sampleAt: new Date(row.at).toISOString(),
        previousSampleAt: new Date(previous.at).toISOString(),
        previousValue: previous.value,
        value
      });
    } else {
      delta += value - previous.value;
    }
    previous = { value, at: row.at };
  }

  let status = "continuous";
  if (!present && !invalid) {
    status = "not-present";
  } else if (invalid) {
    status = "incomplete";
  } else if (rows.length < 2) {
    status = "insufficient";
  } else if (resets.length > 0) {
    status = "reset-adjusted";
  }

  return {
    status,
    epochs,
    resetCount: resets.length,
    delta: present && !invalid ? round(delta) : null,
    resets
  };
}

function buildCounterContinuity(rows) {
  const goodCount = analyzeCounterSeries(rows, "goodCount");
  const totalProducedCount = analyzeCounterSeries(
    rows,
    "totalProducedCount",
    "invalidTotalProducedCount"
  );
  const resets = [...goodCount.resets, ...totalProducedCount.resets].sort(
    (left, right) =>
      left.sampleIndex - right.sampleIndex || left.counter.localeCompare(right.counter)
  );
  let status = "continuous";
  if (rows.length < 2) {
    status = "insufficient";
  } else if (resets.length > 0) {
    status = "reset-adjusted";
  }
  return {
    status,
    resetCount: resets.length,
    epochs: Math.max(goodCount.epochs, totalProducedCount.epochs),
    deltaBasis:
      resets.length > 0
        ? "sum-of-observed-increments-within-counter-epochs"
        : "last-minus-first",
    goodCount: {
      status: goodCount.status,
      epochs: goodCount.epochs,
      resetCount: goodCount.resetCount,
      delta: goodCount.delta
    },
    totalProducedCount: {
      status: totalProducedCount.status,
      epochs: totalProducedCount.epochs,
      resetCount: totalProducedCount.resetCount,
      delta: totalProducedCount.delta
    },
    resets
  };
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
        alarmCodes: normalizeAlarmCodes(sample),
        deviceStatus,
        sample
      };
    })
    .sort((left, right) => left.at - right.at);
}

function resolveCounterMode(rows, goodDelta, ngCount, warnings, counterContinuity) {
  const proxy = {
    counterMode:
      counterContinuity.goodCount.resetCount > 0
        ? "good-count-proxy-reset-adjusted"
        : "good-count-proxy",
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

  const belowGoodIndex = rows.findIndex(
    (row) => row.totalProducedCount < row.goodCount
  );
  if (belowGoodIndex >= 0) {
    warnings.push(
      `totalProducedCount is below goodCount at sample ${belowGoodIndex}; falling back to the goodCount proxy.`
    );
    return proxy;
  }

  const totalDelta = counterContinuity.totalProducedCount.delta;
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
    counterMode:
      counterContinuity.totalProducedCount.resetCount > 0
        ? "total-produced-reset-adjusted"
        : "total-produced",
    totalDelta: round(totalDelta),
    counterScrapDelta: round(Math.max(0, totalDelta - goodDelta))
  };
}

function calculateOee(samples, options = {}) {
  const rows = normalizeSamples(samples);
  const counterContinuity = buildCounterContinuity(rows);
  const shiftCalendar = createShiftCalendar(
    options.plannedTime?.schedule,
    options.plannedTime?.timeZone || defaultTimeZone()
  );
  const plannedTime = {
    timeZone: shiftCalendar.timeZone,
    windows: shiftCalendar.scheduleText
  };
  const plannedAlarmCodes = new Set(
    (options.downtimeClassification?.plannedAlarmCodes || []).map((code) =>
      String(code).trim().toUpperCase()
    )
  );
  const changeoverAlarmCodes = new Set(
    (options.downtimeClassification?.changeoverAlarmCodes || []).map((code) =>
      String(code).trim().toUpperCase()
    )
  );
  const downtimeSources = {
    plannedStop: "shift-schedule",
    plannedDowntime: plannedAlarmCodes.size ? "active-alarm-code" : "disabled",
    changeover: changeoverAlarmCodes.size ? "active-alarm-code" : "disabled",
    unplannedStop: "device-status",
    unknownStop: "device-status"
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
      plannedProductionSeconds: 0,
      runningSeconds: 0,
      downtimeSeconds: 0,
      plannedStopSeconds: 0,
      plannedDowntimeSeconds: 0,
      changeoverSeconds: 0,
      unplannedStopSeconds: 0,
      unknownStopSeconds: 0,
      outsidePlanRunningSeconds: 0,
      goodDelta: 0,
      theoreticalGood: 0,
      totalDelta: counterMode === "total-produced" ? 0 : null,
      counterScrapDelta: null,
      counterMode,
      counterContinuity,
      ngCount,
      nominalOutputPerMinute,
      plannedTime,
      downtimeSources,
      lossBreakdown: {
        availabilityLossSeconds: 0,
        plannedStopSeconds: 0,
        plannedDowntimeSeconds: 0,
        changeoverSeconds: 0,
        unplannedStopSeconds: 0,
        unknownStopSeconds: 0,
        outsidePlanRunningSeconds: 0,
        speedLossUnits: 0,
        qualityLossUnits: 0,
        speedLossSource: "unavailable",
        qualityLossSource: "unavailable"
      },
      inputs: {
        sampleCount: rows.length,
        firstSampleAt: rows[0]?.sample?.occurredAt ?? null,
        lastSampleAt: rows[0]?.sample?.occurredAt ?? null,
        counterMode,
        counterScope: "first-to-last sample in observed window",
        counterContinuity,
        plannedTime,
        downtimeSources,
        qualityBasis
      },
      warnings: ["At least two samples are required to calculate OEE."],
      basis: {
        plannedTime: "intersection of sampled window and configured shift windows",
        availability:
          "RUNNING planned intervals / available planned intervals after planned downtime and changeover",
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
  let plannedDowntimeMs = 0;
  let changeoverMs = 0;
  let unplannedStopMs = 0;
  let unknownStopMs = 0;

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
    } else if (intervalPlannedMs > 0) {
      const changeoverCode = findMatchingAlarmCode(previous, changeoverAlarmCodes);
      const plannedDowntimeCode = findMatchingAlarmCode(
        previous,
        plannedAlarmCodes
      );
      if (changeoverCode) {
        changeoverMs += intervalPlannedMs;
      } else if (plannedDowntimeCode) {
        plannedDowntimeMs += intervalPlannedMs;
      } else if (previous.deviceStatus === "DOWN") {
        unplannedStopMs += intervalPlannedMs;
      } else {
        unknownStopMs += intervalPlannedMs;
      }
    }
  }

  for (const reset of counterContinuity.resets) {
    warnings.push(
      `${reset.counter} reset/rollback detected at sample ${reset.sampleIndex} (${reset.previousValue} -> ${reset.value}); production is summed across ${counterContinuity.epochs} observed counter epochs and increments hidden at the reset are not estimated.`
    );
  }
  const goodDelta = counterContinuity.goodCount.delta ?? 0;
  if (unknownStopMs > 0) {
    warnings.push("Unknown device statuses are treated as non-running time.");
  }
  if (outsidePlanRunningMs > 0) {
    warnings.push(
      "The equipment was RUNNING outside configured shift windows; counters still reflect the observed sample window."
    );
  }

  const observedSeconds = observedMs / 1000;
  const plannedSeconds = plannedMs / 1000;
  const plannedProductionMs = Math.max(
    0,
    plannedMs - plannedDowntimeMs - changeoverMs
  );
  const plannedProductionSeconds = plannedProductionMs / 1000;
  const runningSeconds = runningMs / 1000;
  const availability =
    plannedProductionMs > 0 ? clamp(runningMs / plannedProductionMs, 0, 1) : 0;
  const theoreticalGood = nominalOutputPerMinute * (runningSeconds / 60);
  const counter = resolveCounterMode(
    rows,
    goodDelta,
    ngCount,
    warnings,
    counterContinuity
  );
  const usesTotalCounter = counter.counterMode.startsWith("total-produced");
  const performanceNumerator =
    usesTotalCounter ? counter.totalDelta : goodDelta;
  const performance =
    theoreticalGood > 0 ? clamp(performanceNumerator / theoreticalGood, 0, 1) : 0;
  const qualityDenominator =
    usesTotalCounter ? counter.totalDelta : goodDelta + ngCount;
  const quality = qualityDenominator > 0 ? clamp(goodDelta / qualityDenominator, 0, 1) : 0;
  const oee = availability * performance * quality;
  const qualityBasis =
    usesTotalCounter
      ? "goodCount delta / totalProducedCount delta"
      : "goodDelta / (goodDelta + ngCount)";
  const performanceBasis =
    usesTotalCounter
      ? "totalProducedCount delta / theoretical produced units at nominal output"
      : "goodCount delta / theoretical good units at nominal output";
  const availabilityLossMs = unplannedStopMs + unknownStopMs;
  const speedLossUnits = Math.max(0, theoreticalGood - performanceNumerator);
  const qualityLossUnits =
    usesTotalCounter ? counter.counterScrapDelta : ngCount;
  const lossBreakdown = {
    availabilityLossSeconds: round(availabilityLossMs / 1000, 3),
    plannedStopSeconds: round(Math.max(0, observedSeconds - plannedSeconds), 3),
    plannedDowntimeSeconds: round(plannedDowntimeMs / 1000, 3),
    changeoverSeconds: round(changeoverMs / 1000, 3),
    unplannedStopSeconds: round(unplannedStopMs / 1000, 3),
    unknownStopSeconds: round(unknownStopMs / 1000, 3),
    outsidePlanRunningSeconds: round(outsidePlanRunningMs / 1000, 3),
    speedLossUnits: round(speedLossUnits, 3),
    qualityLossUnits: round(qualityLossUnits, 3),
    speedLossSource:
      usesTotalCounter
        ? "total-counter-gap"
        : "good-counter-gap",
    qualityLossSource:
      usesTotalCounter
        ? "total-counter-scrap"
        : options.ngCount === undefined
          ? "ngCount-not-supplied"
          : "ngCount"
  };

  if (plannedMs === 0) {
    warnings.push("No planned production time overlaps the observed sample window.");
  }
  if (plannedMs > 0 && plannedProductionMs === 0) {
    warnings.push(
      "No available planned production time remains after planned downtime and changeover."
    );
  }
  if (options.ngCount === undefined && !usesTotalCounter) {
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
    plannedProductionSeconds: round(plannedProductionSeconds, 3),
    runningSeconds: round(runningSeconds, 3),
    downtimeSeconds: round(
      (plannedDowntimeMs + changeoverMs + unplannedStopMs + unknownStopMs) / 1000,
      3
    ),
    plannedStopSeconds: round(Math.max(0, observedSeconds - plannedSeconds), 3),
    plannedDowntimeSeconds: round(plannedDowntimeMs / 1000, 3),
    changeoverSeconds: round(changeoverMs / 1000, 3),
    unplannedStopSeconds: round(unplannedStopMs / 1000, 3),
    unknownStopSeconds: round(unknownStopMs / 1000, 3),
    outsidePlanRunningSeconds: round(outsidePlanRunningMs / 1000, 3),
    goodDelta,
    theoreticalGood: round(theoreticalGood, 3),
    totalDelta: counter.totalDelta,
    counterScrapDelta: counter.counterScrapDelta,
    counterMode: counter.counterMode,
    counterContinuity,
    ngCount,
    nominalOutputPerMinute,
    plannedTime,
    downtimeSources,
    lossBreakdown,
    inputs: {
      sampleCount: rows.length,
      firstSampleAt: new Date(first.at).toISOString(),
      lastSampleAt: new Date(last.at).toISOString(),
      counterMode: counter.counterMode,
      counterScope:
        counterContinuity.resetCount > 0
          ? "sum of adjacent increments within observed counter epochs"
          : "first-to-last sample in observed window",
      totalDelta: counter.totalDelta,
      counterContinuity,
      plannedTime,
      downtimeSources,
      qualityBasis
    },
    warnings,
    basis: {
      plannedTime: "intersection of sampled window and configured shift windows",
      availability:
        "RUNNING planned intervals / available planned intervals after planned downtime and changeover",
      performance: performanceBasis,
      quality: qualityBasis,
      lossBreakdown:
        "planned stops, planned downtime, changeover, unplanned/unknown stops, speed loss, and quality loss"
    }
  };
}

module.exports = {
  DEFAULT_NOMINAL_OUTPUT_PER_MINUTE,
  calculateOee,
  metricValue,
  toMillis
};
