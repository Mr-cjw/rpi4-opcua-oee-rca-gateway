"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = process.env.OPCUA_PORT || "48401";
const env = {
  ...process.env,
  OPCUA_PORT: port,
  SIM_DOWNTIME_RATE_PER_MIN: "0",
  SIM_TEMP_SPIKE_RATE_PER_MIN: "0",
  SIM_INTERVAL_MS: "100"
};

function waitForLine(child, matcher, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Server did not become ready within ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);

    function onData(chunk) {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
      if (matcher.test(output)) {
        cleanup();
        resolve();
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Server exited before becoming ready (code=${code}, signal=${signal})`));
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code=${code}, signal=${signal}`));
      }
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15000);
    timer.unref();

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForLine(server, /Raspberry Pi Mock PLC is running/, 30000);
    await run(process.execPath, ["scripts/smoke-test.js"], {
      cwd: root,
      env,
      stdio: "inherit"
    });
    console.log("E2E test passed.");
  } finally {
    await stopChild(server);
  }
}

main().catch((error) => {
  console.error("E2E test failed:", error);
  process.exitCode = 1;
});
