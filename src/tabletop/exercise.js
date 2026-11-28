"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ClockSyncMonitor } = require("../gateway/clock-sync");
const { loadGatewayConfig } = require("../gateway/config");
const { GatewayRuntime } = require("../gateway/runtime");
const { hashFile, pathExists, writeJsonAtomic } = require("../release/common");
const { createReleasePackage, REQUIRED_RELEASE_FILES } = require("../release/package");
const { runReleaseRehearsal } = require("../release/rehearsal");

const TABLETOP_SCHEMA_VERSION = "1.0";
const TABLETOP_KIND = "rpi4-gateway-offline-operational-tabletop";
const TABLETOP_MODE = "offline-simulation";
const TABLETOP_EVIDENCE_LEVEL = "L1/L2 local simulation";
const DEFAULT_OUTPUT_PATH = path.join("data", "offline-tabletop-report.json");
const FIXTURE_COMMIT = "a".repeat(40);
const SLEEP_MS = 25;

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(SLEEP_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function healthSnapshot(health) {
  return {
    status: health?.status,
    opcuaConnected: health?.opcuaConnected,
    storageStatus: health?.storage?.status,
    qualityLogStatus: health?.storage?.components?.["quality-event-log"]?.status || null,
    clockStatus: health?.clock?.status,
    plcStatus: health?.plc?.status,
    latestOccurredAt: health?.context?.latestOccurredAt || null,
    sequence: health?.sequences?.quality || null
  };
}

class TabletopGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.goodCount = 100;
    this.reconnectCount = 0;
  }

  async start() {
    this.isConnected = true;
    return this;
  }

  async stop() {
    this.isConnected = false;
  }

  setConnected(connected) {
    this.isConnected = Boolean(connected);
    if (this.isConnected) {
      this.reconnectCount += 1;
    }
  }

  getSnapshot() {
    this.goodCount += 1;
    return {
      deviceStatus: { value: "RUNNING" },
      currentOutput: { value: 120 },
      goodCount: { value: this.goodCount },
      totalProducedCount: { value: this.goodCount + 1 },
      temperatureSensor: { value: 24.5 },
      alarmEvents: { alarmSnapshot: { sequence: 0, active: [] } }
    };
  }

  getStatus() {
    const healthy = this.isConnected;
    return {
      status: healthy ? "ok" : "critical",
      healthy,
      connected: healthy,
      connection: {
        reconnectCount: this.reconnectCount,
        lastReconnectGapMs: healthy && this.reconnectCount > 0 ? 500 : null,
        maxReconnectGapMs: this.reconnectCount > 0 ? 500 : 0,
        totalReconnectGapMs: this.reconnectCount > 0 ? 500 : 0,
        currentGapMs: healthy ? 0 : 500
      },
      eventSubscription: {
        status: healthy ? "disabled" : "unavailable",
        failures: healthy ? 0 : 1,
        recoveries: healthy ? 1 : 0
      },
      summary: {
        variables: 6,
        badValues: 0,
        uncertainValues: 0,
        staleValues: 0,
        clockSkewValues: 0,
        futureTimestampValues: 0
      },
      variables: []
    };
  }
}

function createClockMonitor(required = true) {
  return new ClockSyncMonitor(
    {
      required,
      checkIntervalMs: 60000,
      maxAgeMs: 180000,
      maxOffsetMs: 1000
    },
    {
      checkClock: async () => ({
        synchronized: true,
        source: "tabletop-injected",
        offsetMs: 0,
        leapStatus: "Normal"
      })
    }
  );
}

function createRuntime(root, overrides = {}) {
  const config = loadGatewayConfig({
    OPCUA_ENDPOINT: "opc.tcp://tabletop.invalid:4840/UA/MockPLC",
    PROCESS_CONTEXT_LOG: "off",
    PROCESS_CONTEXT_SAMPLE_INTERVAL_MS: "50",
    PROCESS_CONTEXT_RETENTION_MS: "60000",
    PROCESS_CONTEXT_MAX_EVENTS: "1000",
    QUALITY_EVENT_LOG: "off",
    QUALITY_EVENT_IDEMPOTENCY_FILE: "off",
    GATEWAY_HTTP_HOST: "127.0.0.1",
    GATEWAY_HTTP_PORT: "0",
    GATEWAY_API_TOKEN: "",
    GATEWAY_WORK_CONTEXT_FILE: "off",
    GATEWAY_CLOCK_SYNC_REQUIRED: "true",
    GATEWAY_STORAGE_DISK_PATH: root,
    ...overrides
  });
  const client = new TabletopGatewayClient();
  const runtime = new GatewayRuntime(config, {
    client,
    clockSyncMonitor: createClockMonitor()
  });
  return { runtime, client };
}

async function request(api, routePath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${api.address}${routePath}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  return {
    status: response.status,
    body: contentType.includes("application/json") ? JSON.parse(text) : text,
    text
  };
}

async function health(runtime) {
  return (await request(runtime.api, "/healthz")).body;
}

async function runPlcLossScenario(root) {
  const { runtime, client } = createRuntime(root);
  try {
    await runtime.start();
    await waitFor(() => runtime.getLatestContext()?.occurredAt, 5000, "initial context");
    const before = await health(runtime);
    assertCondition(before.status === "ok", "expected healthy Gateway before PLC loss");
    assertCondition(before.opcuaConnected === true, "expected OPC UA connected before PLC loss");
    const beforeAt = Date.parse(before.context.latestOccurredAt);

    client.setConnected(false);
    await runtime.collector.stop();
    const outage = await health(runtime);
    assertCondition(outage.status === "degraded", "PLC loss did not degrade health");
    assertCondition(outage.opcuaConnected === false, "PLC loss did not clear opcuaConnected");
    assertCondition(outage.plc.status === "critical", "PLC diagnostics did not become critical");

    client.setConnected(true);
    runtime.collector.start(client);
    const recoveryStartedAt = Date.now();
    await waitFor(
      () => Date.parse(runtime.getLatestContext()?.occurredAt || "0") > recoveryStartedAt,
      5000,
      "process context after PLC recovery"
    );
    const recovered = await health(runtime);
    assertCondition(recovered.status === "ok", "PLC recovery did not restore healthy status");
    assertCondition(recovered.opcuaConnected === true, "PLC recovery did not reconnect");
    assertCondition(
      Date.parse(recovered.context.latestOccurredAt) > beforeAt,
      "process context did not advance after PLC recovery"
    );

    return {
      observed: {
        before: healthSnapshot(before),
        outage: healthSnapshot(outage),
        recovered: healthSnapshot(recovered),
        contextAdvanced: true
      },
      checks: [
        { name: "healthy-baseline", status: "pass" },
        { name: "loss-degrades-health", status: "pass" },
        { name: "reconnect-restores-context", status: "pass" }
      ]
    };
  } finally {
    await runtime.stop().catch(() => undefined);
  }
}

async function runDiskFullScenario(root) {
  const stateRoot = path.join(root, "disk-full");
  await fs.mkdir(stateRoot, { recursive: true });
  const qualityLogPath = path.join(stateRoot, "quality-events.jsonl");
  const { runtime } = createRuntime(stateRoot, {
    QUALITY_EVENT_LOG: qualityLogPath
  });
  const baselineSourceEventId = "QC-TABLETOP-DISK-BASELINE";
  const sourceEventId = "QC-TABLETOP-DISK-001";
  const baselineBody = JSON.stringify({
    sourceEventId: baselineSourceEventId,
    result: "NG",
    occurredAt: new Date().toISOString(),
    quantity: 1
  });
  const body = JSON.stringify({
    sourceEventId,
    result: "NG",
    occurredAt: new Date().toISOString(),
    quantity: 1
  });
  try {
    await runtime.start();
    await waitFor(() => runtime.getLatestContext()?.occurredAt, 5000, "initial context");
    const baseline = await request(runtime.api, "/v1/quality-events", {
      method: "POST",
      body: baselineBody
    });
    assertCondition(baseline.status === 201, `expected baseline 201, got ${baseline.status}`);
    assertCondition(runtime.getQualityEvents().length === 1, "baseline event was not retained");
    const logStore = runtime.qualityEvents._logStore;
    const appendText = logStore._appendText.bind(logStore);
    logStore._appendText = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC"
      });
    };

    const rejected = await request(runtime.api, "/v1/quality-events", {
      method: "POST",
      body
    });
    assertCondition(rejected.status === 503, `expected 503 on simulated ENOSPC, got ${rejected.status}`);
    const degraded = await health(runtime);
    assertCondition(degraded.status === "degraded", "disk-full write did not degrade health");
    assertCondition(
      degraded.storage.components["quality-event-log"].status === "critical",
      "quality-event-log did not become critical"
    );
    assertCondition(runtime.getQualityEvents().length === 1, "rejected event remained in memory");

    logStore._appendText = appendText;
    const retry = await request(runtime.api, "/v1/quality-events", {
      method: "POST",
      body
    });
    assertCondition(retry.status === 201, `expected 201 after storage recovery, got ${retry.status}`);
    assertCondition(retry.body.event.sourceEventId === sourceEventId, "retry changed sourceEventId");
    assertCondition(runtime.getQualityEvents().length === 2, "retry did not retain exactly two events");
    const recovered = await health(runtime);
    const sequence = runtime.qualityEvents.getSequenceStatus();
    assertCondition(sequence.gapsTotal === 1, "expected a sequence gap after rejected write");
    assertCondition(sequence.missingEvents === 1, "expected one missing quality sequence");
    assertCondition(
      recovered.storage.components["quality-event-log"].status === "ok",
      "quality storage did not recover after successful retry"
    );

    return {
      observed: {
        baseline: {
          status: baseline.status,
          sourceEventId: baseline.body.event.sourceEventId,
          sequence: baseline.body.event.sequence
        },
        rejected: {
          status: rejected.status,
          body: rejected.body,
          health: healthSnapshot(degraded)
        },
        retry: {
          status: retry.status,
          duplicate: retry.body.duplicate,
          qualityEventId: retry.body.event.qualityEventId,
          sequence: retry.body.event.sequence,
          sourceEventId: retry.body.event.sourceEventId
        },
        retainedEvents: runtime.getQualityEvents().length,
        sequenceGap: sequence,
        recoveredHealth: healthSnapshot(recovered)
      },
      checks: [
        { name: "enospc-returns-503", status: "pass" },
        { name: "rejected-event-rolled-back", status: "pass" },
        { name: "same-source-event-id-retry-accepted", status: "pass" },
        { name: "sequence-gap-preserved", status: "pass" }
      ]
    };
  } finally {
    await runtime.stop().catch(() => undefined);
  }
}

async function runNtpLossScenario() {
  const clockState = {
    synchronized: true,
    source: "tabletop-injected",
    offsetMs: 5,
    leapStatus: "Normal"
  };
  const monitor = new ClockSyncMonitor(
    {
      required: true,
      checkIntervalMs: 60000,
      maxAgeMs: 180000,
      maxOffsetMs: 1000
    },
    { checkClock: async () => ({ ...clockState }) }
  );
  try {
    await monitor.start();
    const synchronized = monitor.getStatus();
    assertCondition(synchronized.status === "ok", "expected synchronized clock baseline");

    clockState.synchronized = false;
    clockState.leapStatus = "Not synchronised";
    await monitor.checkNow();
    const lost = monitor.getStatus();
    assertCondition(lost.status === "warning", "NTP loss did not produce warning");
    assertCondition(lost.healthy === false, "NTP loss remained healthy");
    assertCondition(lost.reason === "not_synchronized", "NTP loss reason was not explicit");

    clockState.synchronized = true;
    clockState.leapStatus = "Normal";
    await monitor.checkNow();
    const recovered = monitor.getStatus();
    assertCondition(recovered.status === "ok", "NTP recovery did not restore ok status");

    return {
      observed: {
        synchronized,
        lost,
        recovered
      },
      checks: [
        { name: "synchronized-baseline", status: "pass" },
        { name: "loss-warns", status: "pass" },
        { name: "recovery-restores-ok", status: "pass" }
      ]
    };
  } finally {
    await monitor.stop();
  }
}

async function createReleaseFixture(root, clock) {
  const sourceDir = path.join(root, "release-source");
  for (const relativePath of REQUIRED_RELEASE_FILES) {
    const filePath = path.join(sourceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '"use strict";\n');
  }
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "rpi4-gateway-tabletop-fixture",
        version: "1.0.0",
        engines: { node: ">=22.13.0" }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(sourceDir, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(sourceDir, "README.md"), "# Offline tabletop fixture\n");
  await fs.writeFile(
    path.join(sourceDir, "security", "advisory-dispositions.json"),
    '{"schemaVersion":"1.0","dispositions":[]}\n'
  );

  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "process-context.jsonl"), '{"kind":"context"}\n');
  await fs.writeFile(path.join(stateDir, "quality-events.jsonl"), '{"kind":"quality"}\n');
  await fs.writeFile(
    path.join(stateDir, "quality-idempotency.json"),
    '{"schemaVersion":"1.0","entries":[]}\n',
    { mode: 0o600 }
  );
  await fs.writeFile(
    path.join(stateDir, "work-context.json"),
    '{"schemaVersion":"1.0","workOrderId":null,"serialNumber":null,"correlationId":null,"productId":null}\n',
    { mode: 0o600 }
  );

  async function packageRelease(version) {
    return createReleasePackage({
      rootDir: sourceDir,
      outputDir: path.join(root, `dist-${version}`),
      version,
      source: {
        files: [...REQUIRED_RELEASE_FILES],
        commit: FIXTURE_COMMIT,
        dirty: false
      },
      clock
    });
  }

  return {
    stateDir,
    base: await packageRelease("1.0.0"),
    candidate: await packageRelease("1.0.1")
  };
}

function findReleaseScenario(report, id) {
  const scenario = report.scenarios.find((entry) => entry.id === id);
  assertCondition(scenario, `release rehearsal did not produce scenario ${id}`);
  return scenario;
}

function releaseScenarioSpec(id, title, releaseScenario, { commands, expected, decisions, hardwareOnlyFrom }) {
  assertCondition(releaseScenario.status === "passed", `${id} failed: ${releaseScenario.error}`);
  return {
    id,
    title,
    category: "release",
    status: "passed",
    commands,
    expectedObservations: expected,
    observed: releaseScenario.details,
    checks: [{ name: "release-rehearsal-scenario", status: "pass", details: id }],
    decisionPoints: decisions,
    hardwareOnlyFrom
  };
}

async function runReleaseScenarios(root, evidenceDir, clock) {
  const fixture = await createReleaseFixture(root, clock);
  const outputPath = path.join(evidenceDir, "release-rehearsal.json");
  const rehearsal = await runReleaseRehearsal({
    baseArchivePath: fixture.base.archivePath,
    candidateArchivePath: fixture.candidate.archivePath,
    stateDir: fixture.stateDir,
    outputPath,
    workDir: path.join(root, "release-rehearsal-work"),
    force: true,
    clock
  });
  const commonCommand =
    "npm run release:rehearse -- --base-archive <base.tar.gz> " +
    "--candidate-archive <candidate.tar.gz> --state-dir <state-dir> " +
    `--output ${outputPath}`;
  const state = findReleaseScenario(rehearsal.report, "state-backup-restore");
  const explicit = findReleaseScenario(rehearsal.report, "upgrade-and-explicit-rollback");
  const automatic = findReleaseScenario(rehearsal.report, "failed-upgrade-auto-rollback");
  const boundary = findReleaseScenario(rehearsal.report, "state-format-migration-boundary");

  return {
    releaseRehearsal: {
      outputPath: rehearsal.outputPath,
      outputSha256: rehearsal.outputSha256,
      status: rehearsal.report.status,
      baseReleaseId: rehearsal.report.inputs.base.releaseId,
      candidateReleaseId: rehearsal.report.inputs.candidate.releaseId
    },
    scenarios: [
      releaseScenarioSpec(
        "failed-upgrade-auto-rollback",
        "Failed candidate health check triggers automatic rollback",
        automatic,
        {
          commands: [commonCommand],
          expected: [
            "Candidate install fails its health gate.",
            "The installer reports the restored base release.",
            "current points back to the base release."
          ],
          decisions: [
            "If automatic rollback does not restore base, stop and execute explicit rollback using the verified previous release.",
            "If base also fails health after rollback, isolate the host/storage fault before another install."
          ],
          hardwareOnlyFrom:
            "Repeat the failed health gate with the real systemd service on the target Pi; simulated service commands cannot prove reboot or process-manager behavior."
        }
      ),
      releaseScenarioSpec(
        "explicit-rollback",
        "Operator-initiated rollback restores the previous release",
        explicit,
        {
          commands: [commonCommand],
          expected: [
            "Candidate becomes current after the simulated upgrade.",
            "Explicit rollback restores the base release as current."
          ],
          decisions: [
            "If the rollback target is missing, stop and restore from the release archive under the approved procedure.",
            "If rollback mode is state-restore-required, restore the verified backup before starting the older release."
          ],
          hardwareOnlyFrom:
            "Repeat the explicit rollback on the target Pi with systemd and the real health endpoint; verify service state and reboot survival."
        }
      ),
      releaseScenarioSpec(
        "state-restore",
        "Verified state backup restores modified state",
        state,
        {
          commands: [commonCommand],
          expected: [
            "A checksummed backup is created before mutation.",
            "The restored state matches every verified backup checksum."
          ],
          decisions: [
            "If checksum verification fails, stop and preserve both backup and damaged state.",
            "If the backup predates the incident, reconcile QA/MES records before accepting restored state."
          ],
          hardwareOnlyFrom:
            "Restore the verified backup on the target state filesystem and verify ownership, permissions, disk I/O, and service startup."
        }
      ),
      releaseScenarioSpec(
        "state-format-boundary",
        "Incompatible v2 state format is rejected before switching",
        boundary,
        {
          commands: [commonCommand],
          expected: [
            "The synthetic v2 release is rejected with a specific diagnostic.",
            "Accepted v1 state remains byte-for-byte unchanged.",
            "The verified v1 backup remains restorable."
          ],
          decisions: [
            "Do not bypass a state-format mismatch by deleting state.",
            "A real migration requires a reviewed migration contract and a verified pre-migration backup."
          ],
          hardwareOnlyFrom:
            "A real state-format migration, including power loss during and after migration, remains a target-Pi qualification gate."
        }
      )
    ]
  };
}

async function runTabletopScenario(spec, action) {
  const base = {
    id: spec.id,
    title: spec.title,
    category: spec.category,
    evidenceLevel: "L1/L2",
    satisfiesHardwareGate: false,
    commands: spec.commands,
    expectedObservations: spec.expectedObservations || spec.expected || [],
    decisionPoints: spec.decisionPoints || spec.decisions || [],
    hardwareOnlyFrom: spec.hardwareOnlyFrom,
    hardwareHandoff: {
      required: true,
      reason: "This exercise uses local processes, synthetic archives, or injected failures and cannot close an L3/L4 hardware or site gate.",
      beginsAt: spec.hardwareOnlyFrom
    }
  };
  try {
    const result = await action();
    return {
      ...base,
      status: result.status || "passed",
      observed: result.observed,
      checks: result.checks || [],
      ...(result.error ? { error: result.error } : {})
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      observed: {},
      checks: [{ name: "scenario-execution", status: "fail", details: error.message }],
      error: error.message
    };
  }
}

function scenarioSpec(id, title, details) {
  return { id, title, ...details };
}

async function writeScenarioEvidence(evidenceDir, scenario) {
  const evidencePath = path.join(evidenceDir, `${scenario.id}.json`);
  const evidence = {
    schemaVersion: TABLETOP_SCHEMA_VERSION,
    kind: "rpi4-gateway-offline-tabletop-scenario",
    mode: TABLETOP_MODE,
    evidenceLevel: TABLETOP_EVIDENCE_LEVEL,
    satisfiesHardwareGate: false,
    scenario
  };
  await writeJsonAtomic(evidencePath, evidence, { mode: 0o600 });
  return {
    ...scenario,
    evidencePath,
    evidenceSha256: await hashFile(evidencePath)
  };
}

async function runOfflineTabletop(options = {}) {
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
  const evidenceDir = path.resolve(
    options.evidenceDir || `${outputPath.replace(/\.json$/i, "")}.evidence`
  );
  const clock = options.clock || Date.now;
  if (!options.force && (await pathExists(outputPath))) {
    throw new Error(`tabletop output already exists: ${outputPath}`);
  }
  if (!options.force && (await pathExists(path.join(evidenceDir, "plc-loss.json")))) {
    throw new Error(`tabletop evidence already exists: ${evidenceDir}`);
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "rpi4-offline-tabletop-"));
  if (outputPath.startsWith(`${workDir}${path.sep}`) || evidenceDir.startsWith(`${workDir}${path.sep}`)) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw new Error("tabletop output and evidence directory must be outside the temporary work directory");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await fs.chmod(evidenceDir, 0o700);

  try {
    const releaseResult = await runReleaseScenarios(workDir, evidenceDir, clock).catch((error) => ({
      releaseRehearsal: { status: "failed", error: error.message },
      scenarios: [
        "failed-upgrade-auto-rollback",
        "explicit-rollback",
        "state-restore",
        "state-format-boundary"
      ].map((id) => ({
        id,
        title: id,
        category: "release",
        status: "failed",
        observed: { error: error.message },
        expectedObservations: [],
        checks: [{ name: "release-fixture", status: "fail", details: error.message }],
        error: error.message,
        decisionPoints: [],
        hardwareOnlyFrom: "Hardware-only execution remains required.",
        hardwareHandoff: {
          required: true,
          reason: error.message,
          beginsAt: "Hardware-only execution remains required."
        }
      }))
    }));

    const scenarios = [];
    scenarios.push(
      await runTabletopScenario(
        scenarioSpec("plc-loss", "PLC loss and reconnect recovery", {
          category: "plc",
          commands: ["curl -s http://127.0.0.1:8080/healthz | jq '{status,opcuaConnected,plc}'"],
          expectedObservations: [
            "PLC loss sets opcuaConnected=false and degrades health.",
            "PLC diagnostics become critical while the frozen context remains visible.",
            "After reconnect, context timestamps advance and health returns to ok."
          ],
          decisionPoints: [
            "Confirm PLC endpoint, network, certificate, and account before restarting the Gateway.",
            "If context does not advance after reconnect, treat it as a Gateway/PLC integration fault and preserve logs."
          ],
          hardwareOnlyFrom:
            "Use the real PLC, plant network, and installed service; the local client is synthetic."
        }),
        () => runPlcLossScenario(path.join(workDir, "plc"))
      )
    );
    scenarios.push(
      await runTabletopScenario(
        scenarioSpec("disk-full", "State filesystem full and quality retry", {
          category: "storage",
          commands: [
            "curl -s -X POST http://127.0.0.1:8080/v1/quality-events -H 'content-type: application/json' -d '{\"sourceEventId\":\"QC-RETRY\",\"result\":\"NG\"}'",
            "curl -s http://127.0.0.1:8080/healthz | jq '{status,storage,sequences}'"
          ],
          expectedObservations: [
            "The full-write path returns 503 and does not retain the event.",
            "Storage health becomes critical and the rejected sequence leaves a visible gap.",
            "After storage recovery, retrying the same sourceEventId returns 201."
          ],
          decisionPoints: [
            "Free or replace storage; never truncate JSONL or the idempotency ledger to regain space.",
            "Retry the same sourceEventId after recovery; do not create a new key because of 503."
          ],
          hardwareOnlyFrom:
            "Fill the actual target filesystem and verify I/O behavior, fsync, and recovery on the Pi storage device."
        }),
        () => runDiskFullScenario(path.join(workDir, "disk"))
      )
    );
    scenarios.push(
      await runTabletopScenario(
        scenarioSpec("ntp-loss", "Required NTP loss and recovery", {
          category: "clock",
          commands: [
            "timedatectl show --property=NTPSynchronized --value",
            "curl -s http://127.0.0.1:8080/healthz | jq '.clock'"
          ],
          expectedObservations: [
            "A required unsynchronized clock produces warning/degraded health.",
            "Recovery to a synchronized source restores clock status ok."
          ],
          decisionPoints: [
            "Repair NTP connectivity or the selected time source; do not disable the required clock gate.",
            "Record the affected time interval because OEE and RCA windows depend on clock accuracy."
          ],
          hardwareOnlyFrom:
            "Inject NTP loss on the plant network and validate the real timedatectl/chronyc source and timing side effects."
        }),
        () => runNtpLossScenario()
      )
    );
    for (const releaseScenario of releaseResult.scenarios) {
      scenarios.push(
        await runTabletopScenario(releaseScenario, async () => ({
          status: releaseScenario.status,
          observed: releaseScenario.observed || releaseScenario.observations || {},
          checks: releaseScenario.checks,
          error: releaseScenario.error
        }))
      );
    }

    const evidenceScenarios = [];
    for (const scenario of scenarios) {
      evidenceScenarios.push(await writeScenarioEvidence(evidenceDir, scenario));
    }
    const failed = evidenceScenarios.filter((scenario) => scenario.status !== "passed");
    const report = {
      schemaVersion: TABLETOP_SCHEMA_VERSION,
      kind: TABLETOP_KIND,
      mode: TABLETOP_MODE,
      evidenceLevel: TABLETOP_EVIDENCE_LEVEL,
      generatedAt: new Date(clock()).toISOString(),
      status: failed.length === 0 ? "passed" : "failed",
      satisfiesHardwareGate: false,
      hardwareGateNote:
        "This report is simulated evidence only. It cannot satisfy L3/L4 hardware, network, certificate, power-loss, or site-acceptance gates.",
      command:
        `npm run tabletop -- --output ${outputPath} --evidence-dir ${evidenceDir}`,
      outputPath,
      evidenceDir,
      releaseRehearsal: releaseResult.releaseRehearsal,
      summary: {
        total: evidenceScenarios.length,
        passed: evidenceScenarios.length - failed.length,
        failed: failed.length
      },
      scenarios: evidenceScenarios,
      hardwareHandoff: [
        "Repeat PLC loss/reconnect with the real OPC UA endpoint and plant network.",
        "Fill the target state filesystem and validate disk-full recovery, fsync, and idempotent QA retry.",
        "Inject NTP loss on the site network and verify timedatectl/chronyc behavior.",
        "Repeat signed install, automatic rollback, explicit rollback, reboot, and state restore on the target Pi.",
        "Complete the staged field drill and 72-hour soak before claiming L3/L4 evidence."
      ],
      limitations: [
        "No Raspberry Pi hardware, real PLC, plant network, production certificate, or real NTP source was exercised.",
        "PLC and NTP faults are injected into local objects; disk-full is simulated at the JSONL append boundary.",
        "Release install and rollback use synthetic unsigned archives with systemd commands and npm installation simulated.",
        "A passing tabletop report is L1/L2 evidence and cannot close a hardware or field gate."
      ]
    };
    await writeJsonAtomic(outputPath, report, { mode: 0o600 });
    return {
      outputPath,
      outputSha256: await hashFile(outputPath),
      evidenceDir,
      report
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatTabletopReport(report) {
  const lines = [
    `Offline operational tabletop: ${report.status.toUpperCase()}`,
    `Evidence level: ${report.evidenceLevel}; hardware gate satisfied: ${report.satisfiesHardwareGate}`,
    `Scenarios: ${report.summary.passed}/${report.summary.total} passed`,
    `Report: ${report.outputPath}`,
    `Evidence: ${report.evidenceDir}`
  ];
  for (const scenario of report.scenarios) {
    lines.push(`- ${scenario.id}: ${scenario.status} (${scenario.evidencePath})`);
  }
  lines.push(`Hardware handoff: ${report.hardwareGateNote}`);
  return lines.join("\n");
}

function parseTabletopArgs(args) {
  const options = {
    outputPath: DEFAULT_OUTPUT_PATH,
    evidenceDir: null,
    force: false,
    json: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--output" || argument === "--evidence-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--output") {
        options.outputPath = value;
      } else {
        options.evidenceDir = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

module.exports = {
  DEFAULT_OUTPUT_PATH,
  TABLETOP_KIND,
  TABLETOP_MODE,
  TABLETOP_SCHEMA_VERSION,
  TABLETOP_EVIDENCE_LEVEL,
  formatTabletopReport,
  parseTabletopArgs,
  runOfflineTabletop
};
