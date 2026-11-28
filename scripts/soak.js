"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { createMockPlcServer } = require("../src/server");
const { loadGatewayConfig } = require("../src/gateway/config");
const { GatewayRuntime } = require("../src/gateway/runtime");
const { HardwareSampler } = require("../src/hardware/telemetry");

function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

class LatencyStats {
  constructor(limit = 2048) {
    this.limit = limit;
    this.count = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    this.samples = [];
  }

  record(durationMs) {
    this.count += 1;
    this.sumMs += durationMs;
    this.maxMs = Math.max(this.maxMs, durationMs);
    this.samples.push(durationMs);
    if (this.samples.length > this.limit) {
      this.samples.shift();
    }
  }

  snapshot() {
    const sorted = [...this.samples].sort((left, right) => left - right);
    const p95Index = sorted.length === 0 ? 0 : Math.ceil(sorted.length * 0.95) - 1;
    return {
      count: this.count,
      meanMs: this.count === 0 ? 0 : Number((this.sumMs / this.count).toFixed(2)),
      maxMs: Number(this.maxMs.toFixed(2)),
      p95Ms: sorted.length === 0 ? 0 : Number(sorted[p95Index].toFixed(2))
    };
  }
}

function createOptions() {
  return {
    durationMs: envInteger("SOAK_DURATION_MS", 60000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 }),
    apiIntervalMs: envInteger("SOAK_API_INTERVAL_MS", 1000, { min: 100, max: 60000 }),
    qualityIntervalMs: envInteger("SOAK_QUALITY_INTERVAL_MS", 3000, { min: 500, max: 600000 }),
    workContextIntervalMs: envInteger("SOAK_WORK_CONTEXT_INTERVAL_MS", 10000, {
      min: 1000,
      max: 3600000
    }),
    faultIntervalMs: envInteger("SOAK_FAULT_INTERVAL_MS", 5000, { min: 500, max: 3600000 }),
    reconnectIntervalMs: envInteger("SOAK_RECONNECT_INTERVAL_MS", 15000, {
      min: 5000,
      max: 24 * 60 * 60 * 1000
    }),
    reconnectDownMs: envInteger("SOAK_RECONNECT_DOWN_MS", 500, { min: 100, max: 60000 }),
    reconnectTimeoutMs: envInteger("SOAK_RECONNECT_TIMEOUT_MS", 30000, {
      min: 1000,
      max: 300000
    }),
    apiTimeoutMs: envInteger("SOAK_API_TIMEOUT_MS", 5000, { min: 100, max: 60000 }),
    maxApiP95Ms: envInteger("SOAK_MAX_API_P95_MS", 2000, { min: 1, max: 60000 }),
    hardwareIntervalMs: envInteger("SOAK_HARDWARE_INTERVAL_MS", 0, {
      min: 0,
      max: 3600000
    }),
    hardwareWarnTemperatureC: envInteger("SOAK_HARDWARE_WARN_TEMP_C", 70, {
      min: 1,
      max: 200
    }),
    hardwareMaxTemperatureC: envInteger("SOAK_HARDWARE_MAX_TEMP_C", 80, {
      min: 1,
      max: 200
    }),
    reportPath: path.resolve(
      process.env.SOAK_REPORT_PATH || path.join(process.cwd(), "data", "soak-report.json")
    )
  };
  if (options.hardwareWarnTemperatureC >= options.hardwareMaxTemperatureC) {
    throw new Error("SOAK_HARDWARE_WARN_TEMP_C must be less than SOAK_HARDWARE_MAX_TEMP_C");
  }
  return options;
}

async function startServer(serverConfig, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const server = createMockPlcServer(serverConfig);
    try {
      return { server, running: await server.start() };
    } catch (error) {
      lastError = error;
      await server.stop().catch(() => undefined);
      if (attempt < attempts) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastError;
}

function createRunner() {
  const options = createOptions();
  const latency = {};
  const failures = [];
  const loggerCounts = { info: 0, warn: 0, error: 0 };
  const counters = {
    apiRequests: 0,
    apiFailures: 0,
    qualityEventsAccepted: 0,
    faultsInjected: 0,
    reconnectCycles: 0,
    healthDegradedObservations: 0,
    workContextUpdates: 0,
    rcaRequests: 0,
    maxContextEvents: 0,
    maxQualityEvents: 0,
    maxHeapUsedBytes: 0
  };
  let interrupted = false;

  process.once("SIGINT", () => {
    interrupted = true;
    console.error("soak: SIGINT received; finishing the current iteration...");
  });
  process.once("SIGTERM", () => {
    interrupted = true;
    console.error("soak: SIGTERM received; finishing the current iteration...");
  });

  async function request(name, url, requestOptions = {}) {
    const started = process.hrtime.bigint();
    counters.apiRequests += 1;
    let response;
    try {
      response = await fetch(url, {
        ...requestOptions,
        signal: AbortSignal.timeout(options.apiTimeoutMs)
      });
    } catch (error) {
      throw new Error(`${name} request failed: ${error.message}`);
    }
    const text = await response.text();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    latency[name] = latency[name] || new LatencyStats();
    latency[name].record(durationMs);
    if (!response.ok) {
      throw new Error(`${name} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    let body = text;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${name} returned invalid JSON`);
      }
    }
    return { status: response.status, body, text };
  }

  function recordFailure(error) {
    counters.apiFailures += 1;
    if (failures.length < 20) {
      failures.push(error.message);
    }
  }

  async function probeApi(api, runtime, sequence) {
    const [health, metrics, events, oee, quality, latest] = await Promise.all([
      request("healthz", `${api}/healthz`),
      request("metrics", `${api}/metrics`),
      request("events", `${api}/v1/events?limit=20`),
      request("oee", `${api}/v1/oee?windowMs=60000&ngCount=0`),
      request("quality-events", `${api}/v1/quality-events?limit=20`),
      request("context-latest", `${api}/v1/context/latest`)
    ]);

    if (!health.body || !["ok", "degraded"].includes(health.body.status)) {
      throw new Error(`healthz returned an invalid status: ${JSON.stringify(health.body)}`);
    }
    if (!metrics.text.includes("rpi4_gateway_up 1")) {
      throw new Error("metrics did not report rpi4_gateway_up 1");
    }
    if (!Number.isInteger(events.body?.count) || !Array.isArray(events.body?.events)) {
      throw new Error("events response has an invalid shape");
    }
    for (const field of ["availability", "performance", "quality", "oee"]) {
      if (!Number.isFinite(oee.body?.[field]) || oee.body[field] < 0 || oee.body[field] > 1) {
        throw new Error(`OEE field ${field} is invalid: ${oee.body?.[field]}`);
      }
    }
    if (!Number.isInteger(quality.body?.count) || !Array.isArray(quality.body?.events)) {
      throw new Error("quality-events response has an invalid shape");
    }
    if (latest.body?.eventType !== "PROCESS_CONTEXT") {
      throw new Error("context/latest did not return a PROCESS_CONTEXT event");
    }
    if (health.body.status === "degraded" || !health.body.opcuaConnected) {
      counters.healthDegradedObservations += 1;
    }

    if (sequence % 3 === 0) {
      await request("rca", `${api}/v1/rca`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetAt: new Date().toISOString(), windowMs: 30000 })
      });
      counters.rcaRequests += 1;
    }
    return { health: health.body, oee: oee.body, latest: latest.body };
  }

  async function main() {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-gateway-soak-"));
    const port = await getFreePort();
    const serverConfig = loadConfig({
      OPCUA_HOST: "127.0.0.1",
      OPCUA_HOSTNAME: "localhost",
      OPCUA_PORT: String(port),
      OPCUA_PKI_ROOT: path.join(runDir, "server-pki"),
      SIM_INTERVAL_MS: "50",
      SIM_DOWNTIME_RATE_PER_MIN: "0",
      SIM_TEMP_SPIKE_RATE_PER_MIN: "0",
      SIM_SEED: "4242",
      SIM_YIELD_RATE: "0.98"
    });

    const contextLogPath = path.join(runDir, "process-context.jsonl");
    const qualityLogPath = path.join(runDir, "quality-events.jsonl");
    const idempotencyPath = path.join(runDir, "quality-idempotency.json");
    let server = null;
    let runtime = null;
    let hardwareSampler = null;
    let fatalError = null;
    let stopRequested = false;
    let latestAt = 0;
    let initialLatestAt = 0;
    let finalHealth = null;
    let finalOee = null;
    let finalRca = null;
    let startedAt = null;
    let finishedAt = null;
    let sequence = 0;
    let currentProduct = "SKU-SOAK-A";

    try {
      const started = await startServer(serverConfig);
      server = started.server;
      const gatewayConfig = loadGatewayConfig({
        OPCUA_ENDPOINT: started.running.endpointUrl,
        OPCUA_CLIENT_PKI_ROOT: path.join(runDir, "client-pki"),
        PROCESS_CONTEXT_LOG: contextLogPath,
        PROCESS_CONTEXT_LOG_MAX_BYTES: "65536",
        PROCESS_CONTEXT_LOG_MAX_FILES: "2",
        PROCESS_CONTEXT_RETENTION_MS: "60000",
        PROCESS_CONTEXT_MAX_EVENTS: "5000",
        PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "100",
        QUALITY_EVENT_LOG: qualityLogPath,
        QUALITY_EVENT_LOG_MAX_BYTES: "65536",
        QUALITY_EVENT_LOG_MAX_FILES: "2",
        QUALITY_EVENT_RETENTION_MS: "60000",
        QUALITY_EVENT_MAX_EVENTS: "5000",
        QUALITY_EVENT_IDEMPOTENCY_FILE: idempotencyPath,
        QUALITY_EVENT_IDEMPOTENCY_RETENTION_MS: "60000",
        QUALITY_EVENT_IDEMPOTENCY_MAX_ENTRIES: "5000",
        GATEWAY_WORK_CONTEXT_FILE: path.join(runDir, "work-context.json"),
        GATEWAY_HTTP_PORT: "0",
        GATEWAY_API_TOKEN: "",
        GATEWAY_LINE_ID: "SOAK-LINE-01",
        GATEWAY_STATION_ID: "SOAK-STATION-01",
        GATEWAY_WORK_ORDER_ID: "WO-SOAK-001",
        GATEWAY_CORRELATION_ID: "corr-soak-001",
        GATEWAY_PRODUCT_ID: currentProduct,
        OEE_PRODUCT_CYCLE_TIMES: "SKU-SOAK-A=500,SKU-SOAK-B=750",
        OEE_NOMINAL_OUTPUT_PER_MIN: "120",
        OEE_WINDOW_MS: "60000"
      });
      runtime = new GatewayRuntime(gatewayConfig, {
        logger: {
          info() {
            loggerCounts.info += 1;
          },
          warn() {
            loggerCounts.warn += 1;
          },
          error() {
            loggerCounts.error += 1;
          }
        }
      });
      await runtime.start();
      await waitFor(
        () => runtime.getLatestContext()?.occurredAt !== undefined,
        30000,
        "the initial gateway context"
      );

      const api = runtime.api.address;
      console.log(`soak: Gateway API ${api}`);
      console.log(`soak: OPC UA endpoint ${started.running.endpointUrl}`);
      console.log(
        `soak: duration=${options.durationMs}ms apiInterval=${options.apiIntervalMs}ms reconnectInterval=${options.reconnectIntervalMs}ms`
      );

      startedAt = Date.now();
      initialLatestAt = Date.parse(runtime.getLatestContext().occurredAt);
      latestAt = initialLatestAt;
      if (options.hardwareIntervalMs > 0) {
        hardwareSampler = new HardwareSampler({
          warnTemperatureC: options.hardwareWarnTemperatureC,
          maxTemperatureC: options.hardwareMaxTemperatureC
        });
        await hardwareSampler.sample();
      }
      let nextApiAt = startedAt;
      let nextQualityAt = startedAt;
      let nextWorkContextAt = startedAt;
      let nextFaultAt = startedAt + options.faultIntervalMs;
      let nextReconnectAt = startedAt + options.reconnectIntervalMs;
      let nextHardwareAt = startedAt + options.hardwareIntervalMs;
      let nextProgressAt = startedAt + 10000;

      while (!interrupted && !stopRequested && Date.now() - startedAt < options.durationMs) {
        const now = Date.now();
        sequence += 1;

        if (hardwareSampler && now >= nextHardwareAt) {
          await hardwareSampler.sample();
          nextHardwareAt = Date.now() + options.hardwareIntervalMs;
        }

        if (now >= nextReconnectAt && options.reconnectIntervalMs <= options.durationMs) {
          const contextBeforeRestart = Date.parse(runtime.getLatestContext()?.occurredAt);
          await server.stop();
          counters.reconnectCycles += 1;
          await waitFor(
            () => !runtime.client.isConnected,
            options.reconnectTimeoutMs,
            "the Gateway to detect the PLC disconnect"
          );
          await sleep(options.reconnectDownMs);
          const restarted = await startServer(serverConfig);
          server = restarted.server;
          await waitFor(
            () => runtime.client.isConnected,
            options.reconnectTimeoutMs,
            "the Gateway to reconnect after a PLC restart"
          );
          const reconnectedAt = Date.now();
          await waitFor(
            () => {
              const latest = runtime.getLatestContext();
              return latest && Date.parse(latest.occurredAt) > reconnectedAt;
            },
            options.reconnectTimeoutMs,
            "process context after reconnect"
          );
          const contextAfterRestart = Date.parse(runtime.getLatestContext()?.occurredAt);
          if (!(contextAfterRestart > contextBeforeRestart)) {
            throw new Error("process context did not advance across the reconnect cycle");
          }
          nextReconnectAt = Date.now() + options.reconnectIntervalMs;
          console.log(`soak: reconnect cycle ${counters.reconnectCycles} recovered`);
        }

        if (now >= nextFaultAt && options.faultIntervalMs <= options.durationMs) {
          server.simulator.triggerDowntime(2, `soak-${sequence}`);
          server.simulator.triggerTemperatureSpike(2, 95);
          counters.faultsInjected += 1;
          nextFaultAt = Date.now() + options.faultIntervalMs;
        }

        if (now >= nextQualityAt && options.qualityIntervalMs <= options.durationMs) {
          try {
            const response = await request("quality-ingest", `${api}/v1/quality-events`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sourceEventId: `QC-SOAK-${startedAt}-${sequence}`,
                result: "NG",
                occurredAt: new Date().toISOString(),
                productId: currentProduct,
                quantity: 1,
                defectType: "SOAK_INJECTED",
                metadata: { sequence }
              })
            });
            if (!response.body?.event?.qualityEventId) {
              throw new Error("quality ingest did not return a qualityEventId");
            }
            counters.qualityEventsAccepted += 1;
          } catch (error) {
            recordFailure(error);
          }
          nextQualityAt = Date.now() + options.qualityIntervalMs;
        }

        if (now >= nextWorkContextAt && options.workContextIntervalMs <= options.durationMs) {
          currentProduct = currentProduct === "SKU-SOAK-A" ? "SKU-SOAK-B" : "SKU-SOAK-A";
          try {
            await request("work-context", `${api}/v1/work-context`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workOrderId: "WO-SOAK-001", productId: currentProduct })
            });
            counters.workContextUpdates += 1;
          } catch (error) {
            recordFailure(error);
          }
          nextWorkContextAt = Date.now() + options.workContextIntervalMs;
        }

        if (now >= nextApiAt) {
          try {
            const sample = await probeApi(api, runtime, sequence);
            latestAt = Math.max(latestAt, Date.parse(sample.latest.occurredAt));
          } catch (error) {
            recordFailure(error);
          }
          nextApiAt = Date.now() + options.apiIntervalMs;
        }

        const status = runtime.getStatus();
        counters.maxContextEvents = Math.max(counters.maxContextEvents, status.context.eventCount);
        counters.maxQualityEvents = Math.max(counters.maxQualityEvents, status.quality.eventCount);
        counters.maxHeapUsedBytes = Math.max(
          counters.maxHeapUsedBytes,
          process.memoryUsage().heapUsed
        );

        if (Date.now() >= nextProgressAt) {
          console.log(
            `soak: t=${Math.round((Date.now() - startedAt) / 1000)}s context=${status.context.eventCount} quality=${status.quality.eventCount} connected=${status.opcuaConnected} apiFailures=${counters.apiFailures}`
          );
          nextProgressAt = Date.now() + 10000;
        }

        await sleep(Math.max(0, Math.min(options.apiIntervalMs, nextApiAt - Date.now())));
      }

      stopRequested = true;
      finishedAt = Date.now();
      if (!runtime.client.isConnected) {
        await waitFor(
          () => runtime.client.isConnected,
          options.reconnectTimeoutMs,
          "the Gateway to be connected at the end of the soak"
        );
      }
      finalHealth = runtime.getStatus();
      finalOee = runtime.calculateOee({ windowMs: 60000, ngCount: 0 });
      finalRca = runtime.analyzeRca({ targetAt: Date.now(), windowMs: 60000 });
    } catch (error) {
      fatalError = error;
      finishedAt = Date.now();
    } finally {
      if (hardwareSampler) {
        await hardwareSampler.sample();
      }
      if (runtime) {
        await runtime.stop().catch((error) => {
          fatalError = fatalError || error;
        });
      }
      if (server) {
        await server.stop().catch((error) => {
          fatalError = fatalError || error;
        });
      }
    }

    const maxContextLogBytes = 65536;
    const maxContextLogFiles = 2;
    const maxQualityLogBytes = 65536;
    const maxQualityLogFiles = 2;
    const contextSegments = await Promise.all(
      [0, 1, 2].map((index) =>
        fileSize(index === 0 ? contextLogPath : `${contextLogPath}.${index}`)
      )
    );
    const qualitySegments = await Promise.all(
      [0, 1, 2].map((index) =>
        fileSize(index === 0 ? qualityLogPath : `${qualityLogPath}.${index}`)
      )
    );
    const contextLogBytes = contextSegments.reduce((sum, size) => sum + size, 0);
    const qualityLogBytes = qualitySegments.reduce((sum, size) => sum + size, 0);
    const contextBudgetBytes = (maxContextLogFiles + 1) * maxContextLogBytes + 4096;
    const qualityBudgetBytes = (maxQualityLogFiles + 1) * maxQualityLogBytes + 4096;
    const idempotencyBytes = await fileSize(idempotencyPath);

    const checks = [];
    function check(name, passed, details) {
      checks.push({ name, status: passed ? "pass" : "fail", details });
    }
    const latencySnapshot = Object.fromEntries(
      Object.entries(latency).map(([name, stats]) => [name, stats.snapshot()])
    );
    const worstP95 = Math.max(0, ...Object.values(latencySnapshot).map((entry) => entry.p95Ms));
    const reconnectExpected = options.reconnectIntervalMs <= options.durationMs;
    const faultExpected = options.faultIntervalMs <= options.durationMs;
    const qualityExpected = options.qualityIntervalMs <= options.durationMs;
    const hardware = hardwareSampler
      ? hardwareSampler.getStatus()
      : { enabled: false, healthy: null };

    check("no_runtime_error", fatalError === null, fatalError?.message || null);
    check("no_api_failures", counters.apiFailures === 0, failures);
    check("api_latency", worstP95 <= options.maxApiP95Ms, {
      worstP95Ms: worstP95,
      limitMs: options.maxApiP95Ms
    });
    check("context_progress", latestAt > initialLatestAt, {
      initialLatestAt,
      latestAt
    });
    check("quality_ingest", !qualityExpected || counters.qualityEventsAccepted > 0, {
      accepted: counters.qualityEventsAccepted,
      expected: qualityExpected
    });
    check("fault_injection", !faultExpected || counters.faultsInjected > 0, {
      injected: counters.faultsInjected,
      expected: faultExpected
    });
    check(
      "reconnect_recovery",
      !reconnectExpected || counters.reconnectCycles > 0,
      { cycles: counters.reconnectCycles, expected: reconnectExpected }
    );
    check("event_bounds", counters.maxContextEvents <= 5000 && counters.maxQualityEvents <= 5000, {
      maxContextEvents: counters.maxContextEvents,
      maxQualityEvents: counters.maxQualityEvents,
      limits: { context: 5000, quality: 5000 }
    });
    check(
      "storage_bounds",
      contextLogBytes <= contextBudgetBytes && qualityLogBytes <= qualityBudgetBytes,
      {
        contextLogBytes,
        contextBudgetBytes,
        qualityLogBytes,
        qualityBudgetBytes,
        contextSegments,
        qualitySegments
      }
    );
    check("final_connectivity", finalHealth?.opcuaConnected === true, {
      connected: finalHealth?.opcuaConnected ?? null
    });
    if (hardware.enabled) {
      check(
        "hardware_telemetry",
        hardware.successfulSamples > 0 &&
          hardware.failedSamples === 0 &&
          hardware.partialSamples === 0 &&
          hardware.temperature.available &&
          hardware.power.available,
        hardware
      );
      check(
        "hardware_temperature",
        hardware.temperature.available && hardware.temperature.failureSamples === 0,
        hardware.temperature
      );
      check(
        "hardware_power",
        hardware.power.available &&
          hardware.power.current.length === 0 &&
          hardware.power.occurred.length === 0,
        hardware.power
      );
    }

    const report = {
      schemaVersion: "1.0",
      status: checks.every((entry) => entry.status === "pass") ? "pass" : "fail",
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      durationMs: startedAt && finishedAt ? finishedAt - startedAt : null,
      targetDurationMs: options.durationMs,
      interrupted,
      options,
      counters,
      latency: latencySnapshot,
      logger: loggerCounts,
      failures,
      checks,
      hardware,
      storage: {
        contextLogBytes,
        qualityLogBytes,
        idempotencyBytes,
        contextSegments,
        qualitySegments
      },
      final: {
        health: finalHealth,
        oee: finalOee
          ? {
              availability: finalOee.availability,
              performance: finalOee.performance,
              quality: finalOee.quality,
              oee: finalOee.oee,
              counterMode: finalOee.counterMode,
              dataQuality: finalOee.dataQuality,
              performanceSource: finalOee.performanceSource,
              appliedCycleTimes: finalOee.appliedCycleTimes
            }
          : null,
        rca: finalRca
          ? {
              conclusion: finalRca.conclusion,
              candidateCount: finalRca.candidates.length,
              warningCount: (finalRca.warnings || []).length
            }
          : null
      },
      runDir
    };

    if (options.reportPath) {
      await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
      await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.chmod(options.reportPath, 0o600);
    }

    console.log(
      `soak: ${report.status.toUpperCase()} duration=${report.durationMs}ms context=${counters.maxContextEvents} quality=${counters.qualityEventsAccepted} reconnects=${counters.reconnectCycles} apiFailures=${counters.apiFailures}`
    );
    if (hardware.enabled) {
      console.log(
        `soak: hardware samples=${hardware.successfulSamples} ` +
          `temperature=${hardware.temperature.minC}-${hardware.temperature.maxC}C ` +
          `currentFlags=${hardware.power.current.length} ` +
          `historicalFlags=${hardware.power.occurred.length}`
      );
    }
    console.log(`soak: report ${options.reportPath}`);
    for (const entry of checks.filter((item) => item.status === "fail")) {
      console.error(`soak: failed check ${entry.name}: ${JSON.stringify(entry.details)}`);
    }

    const keepRunDir = report.status !== "pass" || process.env.SOAK_KEEP_RUN_DIR === "1";
    if (!keepRunDir) {
      await fs.rm(runDir, { recursive: true, force: true });
    } else {
      console.error(`soak: preserved run directory ${runDir}`);
    }

    if (report.status !== "pass") {
      throw new Error(`soak failed; see ${options.reportPath}`);
    }
  }

  return main();
}

createRunner().catch((error) => {
  console.error(`soak failed: ${error.message}`);
  process.exitCode = 1;
});
