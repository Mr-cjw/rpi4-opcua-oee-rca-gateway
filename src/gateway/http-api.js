"use strict";

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function prometheusLabel(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function metricsPayload(runtime) {
  const status = runtime.getStatus();
  const latestAt = status.context.latestOccurredAt
    ? Date.parse(status.context.latestOccurredAt) / 1000
    : 0;
  const identity = status.identity;
  return [
    "# HELP rpi4_gateway_up Gateway process is running.",
    "# TYPE rpi4_gateway_up gauge",
    "rpi4_gateway_up 1",
    "# HELP rpi4_gateway_opcua_connected Whether the OPC UA session is connected.",
    "# TYPE rpi4_gateway_opcua_connected gauge",
    `rpi4_gateway_opcua_connected ${status.opcuaConnected ? 1 : 0}`,
    "# HELP rpi4_gateway_uptime_seconds Gateway process uptime.",
    "# TYPE rpi4_gateway_uptime_seconds gauge",
    `rpi4_gateway_uptime_seconds ${status.uptimeSeconds}`,
    "# HELP rpi4_gateway_process_context_events Retained process-context events.",
    "# TYPE rpi4_gateway_process_context_events gauge",
    `rpi4_gateway_process_context_events ${status.context.eventCount}`,
    "# HELP rpi4_gateway_alarm_history_events Retained alarm-history entries.",
    "# TYPE rpi4_gateway_alarm_history_events gauge",
    `rpi4_gateway_alarm_history_events ${status.context.alarmCount}`,
    "# HELP rpi4_gateway_quality_events Retained NG quality events.",
    "# TYPE rpi4_gateway_quality_events gauge",
    `rpi4_gateway_quality_events ${status.quality.eventCount}`,
    "# HELP rpi4_gateway_last_context_timestamp_seconds Latest context timestamp.",
    "# TYPE rpi4_gateway_last_context_timestamp_seconds gauge",
    `rpi4_gateway_last_context_timestamp_seconds ${latestAt}`,
    "# HELP rpi4_gateway_work_order_info Current line and work context.",
    "# TYPE rpi4_gateway_work_order_info gauge",
    `rpi4_gateway_work_order_info{line_id="${prometheusLabel(identity.lineId)}",` +
      `station_id="${prometheusLabel(identity.stationId)}",` +
      `work_order_id="${prometheusLabel(identity.workOrderId)}",` +
      `serial_number="${prometheusLabel(identity.serialNumber)}",` +
      `correlation_id="${prometheusLabel(identity.correlationId)}"} 1`,
    ""
  ].join("\n");
}

function secureTokenMatches(provided, expected) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body exceeds 1 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function integerQuery(searchParams, name) {
  const raw = searchParams.get(name);
  if (raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HttpError(400, `${name} must be an integer`);
  }
  return value;
}

function positiveIntegerQuery(searchParams, name) {
  const value = integerQuery(searchParams, name);
  if (value !== undefined && value <= 0) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return value;
}

function createGatewayApi(runtime, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 8080;
  const token = options.token || "";
  const logger = options.logger || null;
  let server = null;
  let boundPort = null;

  async function handle(request, response) {
    const url = new URL(request.url || "/", `http://${host}:${boundPort || port}`);
    const pathname = url.pathname;

    if (pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, runtime.getStatus());
      return;
    }

    if (token) {
      const authorization = request.headers.authorization || "";
      const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!secureTokenMatches(provided, token)) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
    }

    if (pathname === "/metrics" && request.method === "GET") {
      sendText(response, 200, metricsPayload(runtime), "text/plain; version=0.0.4");
      return;
    }

    if (pathname === "/v1/context/latest" && request.method === "GET") {
      const latest = runtime.getLatestContext();
      if (!latest) {
        sendJson(response, 404, { error: "no process context has been captured yet" });
        return;
      }
      sendJson(response, 200, latest);
      return;
    }

    if (pathname === "/v1/work-context" && request.method === "GET") {
      sendJson(response, 200, runtime.getWorkContext());
      return;
    }

    if (pathname === "/v1/work-context" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runtime.updateWorkContext(body));
      return;
    }

    if (pathname === "/v1/events" && request.method === "GET") {
      const events = runtime.getContextEvents({
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        workOrderId: url.searchParams.get("workOrderId") || undefined,
        correlationId: url.searchParams.get("correlationId") || undefined,
        limit: integerQuery(url.searchParams, "limit")
      });
      sendJson(response, 200, { count: events.length, events });
      return;
    }

    if (pathname === "/v1/alarms" && request.method === "GET") {
      const alarms = runtime.getAlarmHistory({
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        workOrderId: url.searchParams.get("workOrderId") || undefined,
        correlationId: url.searchParams.get("correlationId") || undefined,
        limit: integerQuery(url.searchParams, "limit")
      });
      sendJson(response, 200, { count: alarms.length, alarms });
      return;
    }

    if (pathname === "/v1/oee" && request.method === "GET") {
      const result = runtime.calculateOee({
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        workOrderId: url.searchParams.get("workOrderId") || undefined,
        correlationId: url.searchParams.get("correlationId") || undefined,
        windowMs: integerQuery(url.searchParams, "windowMs"),
        idealCycleTimeMs: positiveIntegerQuery(url.searchParams, "idealCycleTimeMs"),
        ngCount: integerQuery(url.searchParams, "ngCount")
      });
      sendJson(response, 200, result);
      return;
    }

    if (pathname === "/v1/quality-events" && request.method === "POST") {
      const body = await readJsonBody(request);
      const result = runtime.recordQualityEvent(body);
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }

    if (pathname === "/v1/quality-events" && request.method === "GET") {
      const events = runtime.getQualityEvents({
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        workOrderId: url.searchParams.get("workOrderId") || undefined,
        correlationId: url.searchParams.get("correlationId") || undefined,
        limit: integerQuery(url.searchParams, "limit")
      });
      sendJson(response, 200, { count: events.length, events });
      return;
    }

    if (pathname.startsWith("/v1/quality-events/") && request.method === "GET") {
      let qualityEventId;
      try {
        qualityEventId = decodeURIComponent(pathname.slice("/v1/quality-events/".length));
      } catch {
        throw new HttpError(400, "qualityEventId is not valid URL encoding");
      }
      const event = qualityEventId ? runtime.getQualityEvent(qualityEventId) : null;
      if (!event) {
        sendJson(response, 404, { error: `quality event not found: ${qualityEventId}` });
        return;
      }
      sendJson(response, 200, event);
      return;
    }

    if (pathname === "/v1/rca" && request.method === "POST") {
      const body = await readJsonBody(request);
      const result = runtime.analyzeRca({
        targetAt: body.targetAt,
        qualityEventId: body.qualityEventId,
        workOrderId: body.workOrderId,
        correlationId: body.correlationId,
        windowMs: body.windowMs,
        temperatureThresholdC: body.temperatureThresholdC
      });
      sendJson(response, 200, result);
      return;
    }

    if (pathname === "/v1/correlation" && request.method === "POST") {
      const body = await readJsonBody(request);
      const correlationId = await runtime.setCorrelationId(body.correlationId);
      sendJson(response, 200, { correlationId });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  const api = {
    get port() {
      return boundPort;
    },
    get address() {
      return boundPort === null ? null : `http://${host}:${boundPort}`;
    },
    async listen() {
      if (server) {
        return api.address;
      }
      server = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
          const statusCode =
            error instanceof HttpError
              ? error.statusCode
              : Number.isInteger(error?.statusCode)
                ? error.statusCode
                : 500;
          if (statusCode >= 500 && logger?.error) {
            logger.error({
              timestamp: new Date().toISOString(),
              level: "error",
              module: "gateway-api",
              message: "HTTP request failed",
              path: request.url,
              error: error.message
            });
          }
          if (!response.headersSent) {
            sendJson(response, statusCode, { error: error.message || "internal server error" });
          } else {
            response.destroy();
          }
        });
      });
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          const address = server.address();
          boundPort = typeof address === "object" && address ? address.port : port;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return api.address;
    },
    async close() {
      if (!server) {
        return;
      }
      const closing = server;
      server = null;
      await new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
      boundPort = null;
    }
  };

  return api;
}

module.exports = {
  createGatewayApi,
  HttpError
};
