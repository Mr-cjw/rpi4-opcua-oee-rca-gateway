"use strict";

const { metricValue, toMillis } = require("./oee");

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TEMPERATURE_THRESHOLD_C = 70;

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function eventTime(event) {
  return toMillis(event?.occurredAt ?? event?.timestamp ?? event?.at, "event timestamp");
}

function eventAlarms(event) {
  if (!Array.isArray(event?.alarms)) {
    return [];
  }
  return event.alarms.map((alarm) => ({
    ...alarm,
    at: alarm?.occurredAt
      ? toMillis(alarm.occurredAt, "alarm timestamp")
      : alarm?.time
        ? toMillis(alarm.time, "alarm timestamp")
        : eventTime(event)
  }));
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }
  return events
    .map((event) => ({ event, at: eventTime(event), alarms: eventAlarms(event) }))
    .sort((left, right) => left.at - right.at);
}

function evidenceForEvent(event, detail) {
  return {
    type: "process-context",
    eventId: event.eventId || null,
    occurredAt: event.occurredAt || new Date(eventTime(event)).toISOString(),
    correlationId: event.correlationId || null,
    detail
  };
}

function confidenceForScore(score) {
  if (score >= 0.8) {
    return { confidence: "medium-high", confidenceLabel: "time overlap, not causal proof" };
  }
  if (score >= 0.6) {
    return { confidence: "medium", confidenceLabel: "time overlap, not causal proof" };
  }
  return { confidence: "low", confidenceLabel: "weak time overlap, not causal proof" };
}

function analyzeTemperature(rows, alarms, thresholdC, windowFrom, windowTo) {
  const thresholdSamples = rows.filter(({ event }) => {
    const value = Number(metricValue(event, "temperatureC"));
    return Number.isFinite(value) && value >= thresholdC;
  });
  const spikeAlarms = alarms.filter((alarm) => alarm.code === "TEMPERATURE_SPIKE");
  if (thresholdSamples.length === 0 && spikeAlarms.length === 0) {
    return null;
  }

  const peakRow = thresholdSamples.reduce(
    (best, row) => {
      const value = Number(metricValue(row.event, "temperatureC"));
      return !best || value > best.value ? { row, value } : best;
    },
    null
  );
  const peakC = peakRow?.value ?? null;
  const firstSpikeAt = Math.min(
    ...thresholdSamples.map((row) => row.at),
    ...spikeAlarms.map((alarm) => alarm.at)
  );
  const lastSpikeAt = Math.max(
    ...thresholdSamples.map((row) => row.at),
    ...spikeAlarms.map((alarm) => alarm.at)
  );
  const durationSeconds = Math.max(0, (lastSpikeAt - firstSpikeAt) / 1000);
  const windowSeconds = Math.max(0.001, (windowTo - windowFrom) / 1000);
  const exceedance = peakC === null ? 0 : clamp((peakC - thresholdC) / 30, 0, 1);
  const score = clamp(0.55 + exceedance * 0.25 + (durationSeconds / windowSeconds) * 0.1 +
    (spikeAlarms.length > 0 ? 0.05 : 0), 0, 0.95);
  const evidence = [];

  if (peakRow) {
    evidence.push(
      evidenceForEvent(
        peakRow.row.event,
        `temperature ${peakC.toFixed(2)} C reached/exceeded the ${thresholdC} C threshold`
      )
    );
  }
  if (spikeAlarms.length > 0) {
    const alarm = spikeAlarms[0];
    evidence.push({
      type: "alarm",
      eventId: alarm.eventId || null,
      occurredAt: new Date(alarm.at).toISOString(),
      correlationId: null,
      detail: `${alarm.code}${alarm.message ? `: ${alarm.message}` : ""}`
    });
  }
  evidence.push({
    type: "window",
    eventId: null,
    occurredAt: new Date(firstSpikeAt).toISOString(),
    correlationId: null,
    detail: `temperature anomaly overlapped the target window for ${round(durationSeconds, 3)} s`
  });

  return {
    code: "TEMPERATURE_SPIKE",
    title: "Temperature anomaly",
    score: round(score),
    ...confidenceForScore(score),
    causalClaim: false,
    summary:
      "A temperature anomaly overlaps the target event window. This is a candidate correlation, not proof of causation.",
    metrics: {
      peakTemperatureC: peakC === null ? null : round(peakC, 3),
      thresholdC: thresholdC,
      durationSeconds: round(durationSeconds, 3),
      alarmCount: spikeAlarms.length
    },
    evidence
  };
}

function analyzeDowntime(rows, alarms) {
  const downIndexes = [];
  rows.forEach((row, index) => {
    if (String(metricValue(row.event, "deviceStatus") || "").toUpperCase() === "DOWN") {
      downIndexes.push(index);
    }
  });
  const downtimeAlarms = alarms.filter((alarm) => alarm.code === "DOWNTIME");
  if (downIndexes.length === 0 && downtimeAlarms.length === 0) {
    return null;
  }

  const firstDownIndex = downIndexes[0];
  let recoveryIndex = null;
  if (firstDownIndex !== undefined) {
    for (let index = firstDownIndex + 1; index < rows.length; index += 1) {
      if (String(metricValue(rows[index].event, "deviceStatus") || "").toUpperCase() === "RUNNING") {
        recoveryIndex = index;
        break;
      }
    }
  }
  const startAt = firstDownIndex !== undefined
    ? rows[firstDownIndex].at
    : Math.min(...downtimeAlarms.map((alarm) => alarm.at));
  const endAt = recoveryIndex !== null
    ? rows[recoveryIndex].at
    : firstDownIndex !== undefined
      ? rows[rows.length - 1].at
      : Math.max(...downtimeAlarms.map((alarm) => alarm.at));
  const durationSeconds = Math.max(0, (endAt - startAt) / 1000);
  const stillDown = firstDownIndex !== undefined && recoveryIndex === null;
  const score = clamp(0.6 + (downtimeAlarms.length > 0 ? 0.1 : 0) + (stillDown ? 0.15 : 0.05), 0, 0.9);
  const evidence = [];

  if (firstDownIndex !== undefined) {
    evidence.push(
      evidenceForEvent(rows[firstDownIndex].event, "deviceStatus became DOWN in the target window")
    );
  }
  if (recoveryIndex !== null) {
    evidence.push(
      evidenceForEvent(rows[recoveryIndex].event, "deviceStatus returned to RUNNING")
    );
  }
  if (downtimeAlarms.length > 0) {
    const alarm = downtimeAlarms[0];
    evidence.push({
      type: "alarm",
      eventId: alarm.eventId || null,
      occurredAt: new Date(alarm.at).toISOString(),
      correlationId: null,
      detail: `${alarm.code}${alarm.message ? `: ${alarm.message}` : ""}`
    });
  }
  evidence.push({
    type: "window",
    eventId: null,
    occurredAt: new Date(startAt).toISOString(),
    correlationId: null,
    detail: `downtime observed for ${round(durationSeconds, 3)} s${stillDown ? " and was still active at the end of the window" : ""}`
  });

  return {
    code: "DOWNTIME",
    title: "Equipment downtime",
    score: round(score),
    ...confidenceForScore(score),
    causalClaim: false,
    summary:
      "Equipment downtime overlaps the target event window. This is a candidate correlation, not proof of causation.",
    metrics: {
      durationSeconds: round(durationSeconds, 3),
      stillDown,
      alarmCount: downtimeAlarms.length
    },
    evidence
  };
}

function analyzeRca(events, options = {}) {
  const rows = normalizeEvents(events);
  const targetAt = toMillis(options.targetAt, "targetAt");
  const windowMs = Number(options.windowMs ?? DEFAULT_WINDOW_MS);
  const temperatureThresholdC = Number(
    options.temperatureThresholdC ?? DEFAULT_TEMPERATURE_THRESHOLD_C
  );
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be a positive number");
  }
  if (!Number.isFinite(temperatureThresholdC)) {
    throw new Error("temperatureThresholdC must be a finite number");
  }

  const windowFrom = targetAt - windowMs;
  const windowTo = targetAt + windowMs;
  const windowRows = rows.filter(({ at }) => at >= windowFrom && at <= windowTo);
  const suppliedAlarms = Array.isArray(options.alarms)
    ? options.alarms
        .map((alarm) => ({
          ...alarm,
          at: toMillis(
            alarm?.occurredAt ?? alarm?.time ?? alarm?.at,
            "alarm timestamp"
          )
        }))
        .filter(({ at }) => at >= windowFrom && at <= windowTo)
    : [];
  const seenAlarms = new Set();
  const alarms = [
    ...windowRows.flatMap(({ alarms: rowAlarms }) => rowAlarms),
    ...suppliedAlarms
  ].filter((alarm) => {
    const key = alarm.eventId || `${alarm.code}:${alarm.at}`;
    if (seenAlarms.has(key)) {
      return false;
    }
    seenAlarms.add(key);
    return true;
  });
  const candidates = [
    analyzeTemperature(windowRows, alarms, temperatureThresholdC, windowFrom, windowTo),
    analyzeDowntime(windowRows, alarms)
  ]
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return {
    targetAt: new Date(targetAt).toISOString(),
    window: {
      from: new Date(windowFrom).toISOString(),
      to: new Date(windowTo).toISOString(),
      windowMs
    },
    sampleCount: windowRows.length,
    alarmCount: alarms.length,
    conclusion: candidates[0]?.code || "INCONCLUSIVE",
    candidates,
    disclaimer:
      "Candidates are derived from time-window overlap. They are not evidence of causation and require human confirmation."
  };
}

module.exports = {
  DEFAULT_TEMPERATURE_THRESHOLD_C,
  DEFAULT_WINDOW_MS,
  analyzeRca
};
