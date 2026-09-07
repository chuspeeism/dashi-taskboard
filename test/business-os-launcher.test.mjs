import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { after, test } from "node:test";
import os from "node:os";
import path from "node:path";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function waitForReady(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not become ready: ${stderr}`)), 5_000);
    const onData = () => {
      if (!stdout.includes("ready\n")) return;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve();
    };
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onData);
      reject(new Error(`child exited before ready (${signal || code}): ${stderr}`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

const testDataDirectory = await mkdtemp(path.join(os.tmpdir(), "business-os-launcher-"));
const testLaunchLockPort = await unusedPort();
process.env.CODEX_TASKBOARD_DATA_DIR = testDataDirectory;
process.env.CODEX_TASKBOARD_LAUNCH_LOCK_PORT = String(testLaunchLockPort);

const launcherUrl = new URL("../scripts/start-business-os.mjs", import.meta.url).href;
const {
  acquireLock,
  bindLaunchLock,
  inspectRuntime,
  processDetails,
  releaseLock,
  resolveLaunchLockPort,
} = await import(launcherUrl);
const runtimeFile = path.join(testDataDirectory, "launcher-runtime.json");

after(async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
});

test("process details resolve the current working directory on supported POSIX hosts", {
  skip: !["darwin", "linux"].includes(process.platform),
}, async () => {
  const details = await processDetails(process.pid);
  assert.equal(details.cwd, process.cwd());
  assert.match(details.command, /node/);
});

test("the launch lock port is distinct from the service and browser ports", () => {
  assert.equal(resolveLaunchLockPort(undefined, 47_823, 9_231), 47_824);
  assert.equal(resolveLaunchLockPort(undefined, 9_230, 9_231), 9_232);
  assert.equal(resolveLaunchLockPort(undefined, 65_535, 1), 2);
  assert.throws(
    () => resolveLaunchLockPort(undefined, 9_231, 9_231),
    /CODEX_TASKBOARD_PORT must differ/,
  );
  assert.throws(
    () => resolveLaunchLockPort("47823", 47_823, 9_231),
    /CODEX_TASKBOARD_LAUNCH_LOCK_PORT must differ/,
  );
  assert.throws(
    () => resolveLaunchLockPort("9231", 47_823, 9_231),
    /CODEX_TASKBOARD_LAUNCH_LOCK_PORT must differ/,
  );
});

test("a descriptor whose live PID belongs to another process is stale, not actionable", {
  skip: !["darwin", "linux"].includes(process.platform),
}, async () => {
  await writeFile(runtimeFile, JSON.stringify({
    pid: process.pid,
    url: "http://127.0.0.1:47823/private-instance-token",
  }), { mode: 0o600 });

  assert.deepEqual(await inspectRuntime(), { state: "stale" });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  await rm(runtimeFile, { force: true });
});

test("the operating system grants exactly one launch lock under contention", async () => {
  const results = await Promise.all(Array.from({ length: 24 }, async () => {
    try {
      return { server: await bindLaunchLock() };
    } catch (error) {
      return { error };
    }
  }));
  const winners = results.filter((result) => result.server);
  const losers = results.filter((result) => result.error);

  assert.equal(winners.length, 1);
  assert.equal(losers.length, 23);
  assert.ok(losers.every((result) => result.error?.code === "EADDRINUSE"));
  await releaseLock(winners[0].server);
});

test("a killed launch-lock owner cannot leave a stale lock", async () => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `const { bindLaunchLock } = await import(${JSON.stringify(launcherUrl)});`,
      "await bindLaunchLock();",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
  ], {
    env: {
      ...process.env,
      CODEX_TASKBOARD_DATA_DIR: testDataDirectory,
      CODEX_TASKBOARD_LAUNCH_LOCK_PORT: String(testLaunchLockPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForReady(child);
    const exitPromise = once(child, "exit");
    assert.equal(child.kill(), true);
    await exitPromise;

    const server = await bindLaunchLock();
    await releaseLock(server);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("legacy empty and recovery lock files cannot block a launch", async () => {
  await mkdir(testDataDirectory, { recursive: true, mode: 0o700 });
  const legacyLockFile = path.join(testDataDirectory, "business-os-launch.lock");
  const legacyRecoveryFile = `${legacyLockFile}.recovery`;
  await writeFile(legacyLockFile, "", { mode: 0o600 });
  await writeFile(legacyRecoveryFile, "2147483647\n", { mode: 0o600 });

  const server = await acquireLock();
  assert.ok(server);
  await releaseLock(server);

  await access(legacyLockFile);
  await access(legacyRecoveryFile);
});
