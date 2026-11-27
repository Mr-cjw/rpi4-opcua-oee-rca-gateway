"use strict";

class EventSequenceTracker {
  constructor(options = {}) {
    this.stream = options.stream || "events";
    this.maxGapRanges = options.maxGapRanges ?? 20;
    this.clock = options.clock || (() => Date.now());
    this.current = 0;
    this.gapsTotal = 0;
    this.missingEvents = 0;
    this.duplicatesTotal = 0;
    this.outOfOrderTotal = 0;
    this.gapRanges = [];
    this.lastObservedAt = null;
  }

  observe(sequence) {
    if (!Number.isInteger(sequence) || sequence <= 0) {
      return { action: "ignored", sequence };
    }
    this.lastObservedAt = new Date(this.clock()).toISOString();
    if (this.current === 0) {
      this.current = sequence;
      return { action: "baseline", sequence };
    }
    if (sequence === this.current) {
      this.duplicatesTotal += 1;
      return { action: "duplicate", sequence };
    }
    if (sequence < this.current) {
      this.outOfOrderTotal += 1;
      return { action: "out_of_order", sequence };
    }
    if (sequence === this.current + 1) {
      this.current = sequence;
      return { action: "ok", sequence };
    }

    const from = this.current + 1;
    const to = sequence - 1;
    const missing = sequence - this.current - 1;
    this.current = sequence;
    this.gapsTotal += 1;
    this.missingEvents += missing;
    this.gapRanges.push({ from, to });
    if (this.gapRanges.length > this.maxGapRanges) {
      this.gapRanges = this.gapRanges.slice(-this.maxGapRanges);
    }
    return { action: "gap", sequence, from, to, missing };
  }

  getStatus() {
    const clean =
      this.gapsTotal === 0 &&
      this.duplicatesTotal === 0 &&
      this.outOfOrderTotal === 0;
    return {
      stream: this.stream,
      status: clean ? "ok" : "warning",
      currentSequence: this.current,
      gapsTotal: this.gapsTotal,
      missingEvents: this.missingEvents,
      duplicatesTotal: this.duplicatesTotal,
      outOfOrderTotal: this.outOfOrderTotal,
      gapRanges: this.gapRanges.map((range) => ({ ...range })),
      lastObservedAt: this.lastObservedAt
    };
  }
}

module.exports = {
  EventSequenceTracker
};
