"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const OPENAPI_PATH = path.resolve(__dirname, "../../contracts/http-api.openapi.json");
const OPENAPI_ID = "https://rpi4.local/contracts/http-api.openapi.json";
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodePointerToken(value) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(document, pointer) {
  if (pointer === "" || pointer === "#") {
    return document;
  }
  const normalized = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!normalized.startsWith("/")) {
    throw new Error(`unsupported JSON pointer: ${pointer}`);
  }
  let current = document;
  for (const raw of normalized.slice(1).split("/")) {
    const token = decodePointerToken(raw.replaceAll("~2", "~"));
    if (!isObject(current) || !(token in current)) {
      throw new Error(`JSON pointer does not resolve: ${pointer}`);
    }
    current = current[token];
  }
  return current;
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function inlineExternalReferences(value, baseDir, cache = new Map()) {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => inlineExternalReferences(item, baseDir, cache)));
  }
  if (!isObject(value)) {
    return value;
  }
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value.$ref)) {
      throw new Error(`remote OpenAPI references are not supported: ${value.$ref}`);
    }
    const [rawFile, rawPointer = ""] = value.$ref.split("#", 2);
    const referencePath = path.resolve(baseDir, rawFile);
    let loaded = cache.get(referencePath);
    if (!loaded) {
      loaded = await readJson(referencePath, "OpenAPI external schema");
      loaded = await inlineExternalReferences(loaded, path.dirname(referencePath), cache);
      cache.set(referencePath, loaded);
    }
    const resolved = rawPointer ? resolveJsonPointer(loaded, `#${rawPointer}`) : loaded;
    const siblings = { ...value };
    delete siblings.$ref;
    return inlineExternalReferences({ ...resolved, ...siblings }, baseDir, cache);
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await inlineExternalReferences(item, baseDir, cache);
  }
  return result;
}

async function loadOpenApiDocument(filePath = OPENAPI_PATH) {
  const resolvedPath = path.resolve(filePath);
  const raw = await readJson(resolvedPath, "OpenAPI document");
  const bundled = await inlineExternalReferences(raw, path.dirname(resolvedPath));
  return { filePath: resolvedPath, raw, bundled };
}

function operationEntries(document) {
  const entries = [];
  for (const [routePath, pathItem] of Object.entries(document.paths || {})) {
    if (!isObject(pathItem)) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isObject(operation)) {
        continue;
      }
      entries.push({ routePath, method: method.toUpperCase(), operation });
    }
  }
  return entries;
}

function openApiOperations(document) {
  return operationEntries(document)
    .map(({ routePath, method }) => `${method} ${routePath}`)
    .sort();
}

function operationsFromHttpSource(source) {
  const operations = new Set();
  const exactPattern =
    /pathname\s*===\s*"([^"]+)"\s*&&\s*request\.method\s*===\s*"([A-Z]+)"/g;
  for (const match of String(source).matchAll(exactPattern)) {
    operations.add(`${match[2]} ${match[1]}`);
  }
  const prefixPattern =
    /pathname\.startsWith\("([^"]+)"\)\s*&&\s*request\.method\s*===\s*"([A-Z]+)"/g;
  for (const match of String(source).matchAll(prefixPattern)) {
    const parameter = match[1] === "/v1/quality-events/" ? "qualityEventId" : "id";
    operations.add(`${match[2]} ${match[1]}{${parameter}}`);
  }
  return [...operations].sort();
}

function createAjv(document) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const id = document.$id || OPENAPI_ID;
  const schemaDocument = { ...document, $id: id };
  ajv.addSchema(schemaDocument, id);
  return { ajv, id };
}

function absoluteSchemaRef(id, schema) {
  if (schema && typeof schema.$ref === "string") {
    return schema.$ref.startsWith("#") ? `${id}${schema.$ref}` : schema.$ref;
  }
  return schema;
}

function formatAjvErrors(errors) {
  return (errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "validation failed"}`)
    .join("; ");
}

async function createApiContract(options = {}) {
  const loaded = await loadOpenApiDocument(options.filePath);
  const { ajv, id } = createAjv(loaded.bundled);
  const validatorCache = new Map();

  function validatorForSchema(schema) {
    const target = absoluteSchemaRef(id, schema);
    if (typeof target === "string") {
      if (!validatorCache.has(target)) {
        validatorCache.set(target, ajv.compile({ $ref: target }));
      }
      return validatorCache.get(target);
    }
    const key = JSON.stringify(schema);
    if (!validatorCache.has(key)) {
      validatorCache.set(key, ajv.compile(schema));
    }
    return validatorCache.get(key);
  }

  function assertValidSchema(schema, value, label) {
    const validate = validatorForSchema(schema);
    if (!validate(value)) {
      throw new Error(`${label} does not satisfy its schema: ${formatAjvErrors(validate.errors)}`);
    }
  }

  function responseSchema(routePath, method, statusCode) {
    const operation = loaded.raw.paths?.[routePath]?.[method.toLowerCase()];
    if (!operation) {
      throw new Error(`OpenAPI operation not found: ${method} ${routePath}`);
    }
    let response = operation.responses?.[String(statusCode)];
    if (!response) {
      throw new Error(`OpenAPI response not found: ${method} ${routePath} ${statusCode}`);
    }
    if (typeof response.$ref === "string" && response.$ref.startsWith("#")) {
      response = resolveJsonPointer(loaded.bundled, response.$ref);
    }
    const content = response.content || {};
    const mediaType = content["application/json"] || content["text/plain"];
    if (!mediaType?.schema) {
      throw new Error(`OpenAPI response has no schema: ${method} ${routePath} ${statusCode}`);
    }
    return mediaType.schema;
  }

  function validateResponse(routePath, method, statusCode, value) {
    assertValidSchema(
      responseSchema(routePath, method, statusCode),
      value,
      `${method} ${routePath} ${statusCode} response`
    );
  }

  function resolveExample(example) {
    if (!isObject(example) || typeof example.$ref !== "string") {
      return example;
    }
    return resolveJsonPointer(loaded.bundled, example.$ref);
  }

  function validateDocumentedExamples() {
    let count = 0;
    for (const { routePath, method, operation } of operationEntries(loaded.bundled)) {
      const bodies = [];
      if (operation.requestBody) {
        bodies.push({ location: "request", content: operation.requestBody.content || {} });
      }
      for (const [statusCode, response] of Object.entries(operation.responses || {})) {
        bodies.push({
          location: `response ${statusCode}`,
          content: response.content || {}
        });
      }
      for (const { location, content } of bodies) {
        for (const [mediaType, media] of Object.entries(content)) {
          const examples = media.examples || {};
          for (const [name, rawExample] of Object.entries(examples)) {
            const example = resolveExample(rawExample);
            if (!isObject(example) || !Object.prototype.hasOwnProperty.call(example, "value")) {
              throw new Error(`OpenAPI example ${name} must include a value`);
            }
            if (media.schema) {
              assertValidSchema(
                media.schema,
                example.value,
                `${method} ${routePath} ${location} ${mediaType} example ${name}`
              );
            }
            count += 1;
          }
        }
      }
    }
    return count;
  }

  return {
    document: loaded.raw,
    bundledDocument: loaded.bundled,
    filePath: loaded.filePath,
    operations: openApiOperations(loaded.raw),
    assertValidSchema,
    resolveExample,
    responseSchema,
    validateDocumentedExamples,
    validateResponse
  };
}

function collectSchemaPaths(schema, prefix = "", paths = new Set()) {
  if (!isObject(schema)) {
    return paths;
  }
  if (isObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = prefix ? `${prefix}.${name}` : name;
      paths.add(childPath);
      collectSchemaPaths(child, childPath, paths);
    }
  }
  if (isObject(schema.items)) {
    collectSchemaPaths(schema.items, `${prefix}[]`, paths);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[keyword])) {
      for (const child of schema[keyword]) {
        collectSchemaPaths(child, prefix, paths);
      }
    }
  }
  return paths;
}

function collectRequiredPaths(schema, prefix = "", paths = new Set()) {
  if (!isObject(schema)) {
    return paths;
  }
  if (isObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = prefix ? `${prefix}.${name}` : name;
      if (required.has(name)) {
        paths.add(childPath);
      }
      collectRequiredPaths(child, childPath, paths);
    }
  }
  if (isObject(schema.items)) {
    collectRequiredPaths(schema.items, `${prefix}[]`, paths);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[keyword])) {
      for (const child of schema[keyword]) {
        collectRequiredPaths(child, prefix, paths);
      }
    }
  }
  return paths;
}

function contractSurface(document) {
  const schemas = {};
  const required = {};
  const parameters = {};
  const responses = {};
  for (const [name, schema] of Object.entries(document.components?.schemas || {})) {
    schemas[name] = [...collectSchemaPaths(schema)].sort();
    required[name] = [...collectRequiredPaths(schema)].sort();
  }
  for (const { routePath, method, operation } of operationEntries(document)) {
    const operationKey = `${method} ${routePath}`;
    parameters[operationKey] = (operation.parameters || [])
      .filter((parameter) => parameter && typeof parameter.name === "string")
      .map((parameter) => `${parameter.in || "unknown"}:${parameter.name}`)
      .sort();
    responses[operationKey] = Object.keys(operation.responses || {}).sort();
  }
  return {
    schemaVersion: "1.1",
    contractVersion: document.info?.version || null,
    operations: openApiOperations(document),
    parameters,
    responses,
    schemas,
    required
  };
}

function missingEntries(expected, actual) {
  const current = new Set(actual);
  return expected.filter((entry) => !current.has(entry));
}

function compareWithBaseline(surface, baseline) {
  const failures = [];
  const missingOperations = missingEntries(baseline.operations || [], surface.operations);
  if (missingOperations.length > 0) {
    failures.push(`removed operations: ${missingOperations.join(", ")}`);
  }
  for (const [operation, expectedParameters] of Object.entries(baseline.parameters || {})) {
    if (!surface.parameters[operation]) {
      continue;
    }
    const missing = missingEntries(expectedParameters, surface.parameters[operation]);
    if (missing.length > 0) {
      failures.push(`removed parameters from ${operation}: ${missing.join(", ")}`);
    }
  }
  for (const [operation, expectedResponses] of Object.entries(baseline.responses || {})) {
    if (!surface.responses[operation]) {
      continue;
    }
    const missing = missingEntries(expectedResponses, surface.responses[operation]);
    if (missing.length > 0) {
      failures.push(`removed response status codes from ${operation}: ${missing.join(", ")}`);
    }
  }
  for (const [name, expectedPaths] of Object.entries(baseline.schemas || {})) {
    if (!surface.schemas[name]) {
      failures.push(`removed schema: ${name}`);
      continue;
    }
    const missing = missingEntries(expectedPaths, surface.schemas[name]);
    if (missing.length > 0) {
      failures.push(`removed fields from ${name}: ${missing.join(", ")}`);
    }
  }
  for (const [name, expectedRequired] of Object.entries(baseline.required || {})) {
    if (!surface.required[name]) {
      failures.push(`removed required-field contract for schema: ${name}`);
      continue;
    }
    const missing = missingEntries(expectedRequired, surface.required[name]);
    if (missing.length > 0) {
      failures.push(`fields changed from required to optional in ${name}: ${missing.join(", ")}`);
    }
  }
  return failures;
}

module.exports = {
  OPENAPI_ID,
  OPENAPI_PATH,
  compareWithBaseline,
  contractSurface,
  createApiContract,
  loadOpenApiDocument,
  openApiOperations,
  operationsFromHttpSource,
  resolveJsonPointer
};
