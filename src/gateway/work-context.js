"use strict";

const WORK_CONTEXT_FIELDS = Object.freeze([
  "workOrderId",
  "serialNumber",
  "correlationId",
  "productId"
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
    correlationId: options.correlationId || null,
    productId: options.productId || null
  };
}

function workContextFilterFrom(options = {}) {
  const normalized = normalizeWorkContextUpdate(options);
  return {
    workOrderId: normalized.workOrderId ?? null,
    correlationId: normalized.correlationId ?? null,
    productId: normalized.productId ?? null
  };
}

function matchesWorkContext(record, filter = {}) {
  if (filter.workOrderId && record?.workOrderId !== filter.workOrderId) {
    return false;
  }
  if (filter.correlationId && record?.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.productId && record?.productId !== filter.productId) {
    return false;
  }
  return true;
}

module.exports = {
  WORK_CONTEXT_FIELDS,
  WorkContextValidationError,
  matchesWorkContext,
  normalizeWorkContextUpdate,
  workContextFilterFrom,
  workContextFrom
};
