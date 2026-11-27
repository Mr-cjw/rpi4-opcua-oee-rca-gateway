"use strict";

const WORK_CONTEXT_FIELDS = Object.freeze([
  "workOrderId",
  "serialNumber",
  "correlationId"
]);

class WorkContextValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkContextValidationError";
    this.statusCode = 400;
  }
}

function normalizeWorkContextUpdate(update) {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new WorkContextValidationError("work context body must be an object");
  }

  const normalized = {};
  for (const field of WORK_CONTEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) {
      continue;
    }
    const value = update[field];
    if (value === undefined || value === null || value === "") {
      normalized[field] = null;
      continue;
    }
    if (typeof value !== "string") {
      throw new WorkContextValidationError(`${field} must be a string or null`);
    }
    normalized[field] = value;
  }
  return normalized;
}

function workContextFrom(options = {}) {
  return {
    workOrderId: options.workOrderId || null,
    serialNumber: options.serialNumber || null,
    correlationId: options.correlationId || null
  };
}

module.exports = {
  WORK_CONTEXT_FIELDS,
  WorkContextValidationError,
  normalizeWorkContextUpdate,
  workContextFrom
};
