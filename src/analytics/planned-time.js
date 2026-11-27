"use strict";

const DAY_NAMES = Object.freeze([
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT"
]);
const DAY_INDEX = Object.freeze(
  Object.fromEntries(
    DAY_NAMES.flatMap((name) => [
      [name, DAY_NAMES.indexOf(name)],
      [name.toLowerCase(), DAY_NAMES.indexOf(name)]
    ])
  )
);
const DAY_ALIASES = Object.freeze({
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
});
const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const DEFAULT_SHIFT_WINDOWS = "00:00-24:00";
const WINDOW_PATTERN =
  /^\s*(?:(?<days>[A-Za-z*]+(?:\s*-\s*[A-Za-z*]+)?(?:\s*,\s*[A-Za-z*]+(?:\s*-\s*[A-Za-z*]+)?)*)\s*:\s*)?(?<start>\d{1,2}:\d{2})\s*-\s*(?<end>\d{1,2}:\d{2})\s*$/;

function resolveDay(token) {
  const upper = token.trim().toUpperCase();
  if (upper in DAY_ALIASES) {
    return DAY_ALIASES[upper];
  }
  if (upper in DAY_INDEX) {
    return DAY_INDEX[upper];
  }
  throw new Error(`invalid day name "${token}"`);
}

function parseDaySpec(raw) {
  if (!raw || raw.trim() === "" || raw.trim() === "*") {
    return [...ALL_DAYS];
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ALL" || normalized === "DAILY") {
    return [...ALL_DAYS];
  }

  const days = new Set();
  for (const token of normalized.split(",")) {
    const item = token.trim();
    if (item === "") {
      throw new Error("empty day in shift schedule");
    }
    if (item.includes("-")) {
      const [startText, endText, extra] = item.split("-");
      if (extra !== undefined) {
        throw new Error(`invalid day range "${item}"`);
      }
      const start = resolveDay(startText);
      const end = resolveDay(endText);
      let day = start;
      for (let count = 0; count < 7; count += 1) {
        days.add(day);
        if (day === end) {
          break;
        }
        day = (day + 1) % 7;
      }
    } else {
      days.add(resolveDay(item));
    }
  }
  return ALL_DAYS.filter((day) => days.has(day));
}

function parseClock(raw, { allowEndOfDay = false } = {}) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`invalid time "${raw}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) {
    if (allowEndOfDay && hour === 24 && minute === 0) {
      return 24 * 60;
    }
    throw new Error(`invalid time "${raw}"`);
  }
  return hour * 60 + minute;
}

function parseShiftWindow(expression) {
  const match = WINDOW_PATTERN.exec(expression);
  if (!match) {
    throw new Error(
      `invalid shift window "${expression}"; expected [DAYS:]HH:MM-HH:MM`
    );
  }
  const days = parseDaySpec(match.groups.days || "");
  const startMinute = parseClock(match.groups.start);
  const endMinute = parseClock(match.groups.end, { allowEndOfDay: true });
  if (endMinute === startMinute) {
    throw new Error(`shift window "${expression}" must have a positive duration`);
  }

  return Object.freeze({
    text: expression.trim(),
    days: Object.freeze(days),
    dayMask: days.reduce((mask, day) => mask | (1 << day), 0),
    startMinute,
    endMinute
  });
}

function parseShiftSchedule(raw = DEFAULT_SHIFT_WINDOWS) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("shift schedule cannot be empty");
  }
  const expressions = raw
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (expressions.length === 0) {
    throw new Error("shift schedule cannot be empty");
  }
  return Object.freeze(expressions.map(parseShiftWindow));
}

function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validateTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new Error("time zone cannot be empty");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`invalid time zone "${timeZone}"`);
  }
}

function createShiftCalendar(schedule = parseShiftSchedule(), timeZone = defaultTimeZone()) {
  validateTimeZone(timeZone);
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error("shift schedule must contain at least one window");
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const localPartsCache = new Map();
  const scheduleText = schedule.map((entry) => entry.text || "").join("; ");

  function localParts(timestamp) {
    const minuteKey = Math.floor(timestamp / 60000);
    const cached = localPartsCache.get(minuteKey);
    if (cached) {
      return cached;
    }
    const parts = formatter.formatToParts(new Date(timestamp));
    const value = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );
    const day = resolveDay(value.weekday);
    const result = {
      day,
      minuteOfDay: Number(value.hour) * 60 + Number(value.minute)
    };
    localPartsCache.set(minuteKey, result);
    return result;
  }

  function isPlannedAt(timestamp) {
    const { day, minuteOfDay } = localParts(timestamp);
    const previousDay = (day + 6) % 7;
    for (const entry of schedule) {
      const selectedToday = (entry.dayMask & (1 << day)) !== 0;
      const selectedYesterday = (entry.dayMask & (1 << previousDay)) !== 0;
      if (entry.endMinute === 24 * 60) {
        if (selectedToday && minuteOfDay >= entry.startMinute) {
          return true;
        }
      } else if (entry.endMinute > entry.startMinute) {
        if (
          selectedToday &&
          minuteOfDay >= entry.startMinute &&
          minuteOfDay < entry.endMinute
        ) {
          return true;
        }
      } else if (
        (selectedToday && minuteOfDay >= entry.startMinute) ||
        (selectedYesterday && minuteOfDay < entry.endMinute)
      ) {
        return true;
      }
    }
    return false;
  }

  function plannedMillisecondsBetween(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error("planned time boundaries must be finite milliseconds");
    }
    let plannedMs = 0;
    let cursor = Math.min(from, to);
    const end = Math.max(from, to);
    while (cursor < end) {
      const nextMinute = (Math.floor(cursor / 60000) + 1) * 60000;
      const chunkEnd = Math.min(end, nextMinute);
      const probe = cursor + (chunkEnd - cursor) / 2;
      if (isPlannedAt(probe)) {
        plannedMs += chunkEnd - cursor;
      }
      cursor = chunkEnd;
    }
    return plannedMs;
  }

  return Object.freeze({
    timeZone,
    schedule,
    scheduleText,
    isPlannedAt,
    plannedMillisecondsBetween
  });
}

module.exports = {
  ALL_DAYS,
  DEFAULT_SHIFT_WINDOWS,
  createShiftCalendar,
  defaultTimeZone,
  parseShiftSchedule,
  validateTimeZone
};
