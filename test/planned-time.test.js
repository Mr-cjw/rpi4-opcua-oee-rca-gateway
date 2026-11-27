"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ALL_DAYS,
  createShiftCalendar,
  parseShiftSchedule,
  validateTimeZone
} = require("../src/analytics/planned-time");

test("default shift schedule covers every day for 24 hours", () => {
  const schedule = parseShiftSchedule();

  assert.equal(schedule.length, 1);
  assert.deepEqual(schedule[0].days, ALL_DAYS);
  assert.equal(schedule[0].startMinute, 0);
  assert.equal(schedule[0].endMinute, 24 * 60);
});

test("weekly and overnight shift windows are parsed", () => {
  const schedule = parseShiftSchedule(
    "MON-FRI:08:00-20:00; SAT:08:00-12:00; FRI:20:00-08:00"
  );

  assert.deepEqual(schedule[0].days, [1, 2, 3, 4, 5]);
  assert.equal(schedule[0].startMinute, 8 * 60);
  assert.equal(schedule[0].endMinute, 20 * 60);
  assert.deepEqual(schedule[1].days, [6]);
  assert.equal(schedule[2].startMinute, 20 * 60);
  assert.equal(schedule[2].endMinute, 8 * 60);
});

test("invalid shift schedules and time zones are rejected", () => {
  assert.throws(() => parseShiftSchedule(""), /cannot be empty/);
  assert.throws(() => parseShiftSchedule("MON-FRI 08:00-20:00"), /invalid shift window/);
  assert.throws(() => parseShiftSchedule("FUN:08:00-20:00"), /invalid day/);
  assert.throws(() => parseShiftSchedule("08:00-08:00"), /positive duration/);
  assert.throws(() => parseShiftSchedule("25:00-26:00"), /invalid time/);
  assert.throws(() => validateTimeZone("Not/A_Zone"), /invalid time zone/);
});

test("planned time clips weekday windows in the configured time zone", () => {
  const calendar = createShiftCalendar(
    parseShiftSchedule("MON-FRI:08:00-20:00"),
    "Asia/Shanghai"
  );

  assert.equal(calendar.isPlannedAt(Date.parse("2026-11-27T02:00:00.000Z")), true);
  assert.equal(calendar.isPlannedAt(Date.parse("2026-11-28T02:00:00.000Z")), false);
  assert.equal(
    calendar.plannedMillisecondsBetween(
      Date.parse("2026-11-26T23:30:00.000Z"),
      Date.parse("2026-11-27T01:00:00.000Z")
    ),
    60 * 60 * 1000
  );
});

test("planned time carries overnight windows into the next local day", () => {
  const calendar = createShiftCalendar(parseShiftSchedule("FRI:20:00-08:00"), "Asia/Shanghai");

  assert.equal(calendar.isPlannedAt(Date.parse("2026-11-27T13:00:00.000Z")), true);
  assert.equal(calendar.isPlannedAt(Date.parse("2026-11-27T20:00:00.000Z")), true);
  assert.equal(calendar.isPlannedAt(Date.parse("2026-11-28T02:00:00.000Z")), false);
  assert.equal(
    calendar.plannedMillisecondsBetween(
      Date.parse("2026-11-27T12:00:00.000Z"),
      Date.parse("2026-11-28T01:00:00.000Z")
    ),
    12 * 60 * 60 * 1000
  );
});
