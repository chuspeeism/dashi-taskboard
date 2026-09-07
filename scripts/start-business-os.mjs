#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { open, mkdir, readFile, stat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injectorPath = path.join(projectRoot, "scripts", "codex-injector.mjs");
const dataDirectory = path.resolve(
  process.env.CODEX_TASKBOARD_DATA_DIR || path.join(projectRoot, ".data"),
);
const runtimeFile = path.resolve(
  process.env.CODEX_TASKBOARD_RUNTIME_FILE || path.join(dataDirectory, "launcher-runtime.json"),
);
const lockFile = path.join(dataDirectory, "business-os-launch.lock");
const recoveryLockFile = `${lockFile}.recovery`;
const host = process.env.CODEX_TASKBOARD_HOST || "127.0.0.1";
const port = parsePort(process.env.CODEX_TASKBOARD_PORT || "47823", "CODEX_TASKBOARD_PORT");
const cdpPort = parsePort(process.env.CODEX_TASKBOARD_CODEX_PORT || "9231", "CODEX_TASKBOARD_CODEX_PORT");
const expectedOrigin = `http://${host}:${port}`;

if (host !== "127.0.0.1") {
  throw new Error("Business OS launcher requires CODEX_TASKBOARD_HOST=127.0.0.1");
}

function parsePort(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processDetails(pid) {
  const [{ stdout: command }, { stdout: cwdOutput }] = await Promise.all([
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="]),
    execFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
  ]);
  const cwd = cwdOutput
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return { command: command.trim(), cwd: cwd ? path.resolve(cwd) : null };
}

function metadataUrl(runtimeUrl) {
  const url = new URL(runtimeUrl);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/meta`;
  return url;
}

async function inspectRuntime() {
  let descriptor;
  let descriptorMode;
  try {
    const [source, details] = await Promise.all([
      readFile(runtimeFile, "utf8"),
      stat(runtimeFile),
    ]);
    descriptor = JSON.parse(source);
    descriptorMode = details.mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    return { state: "invalid" };
  }

  if (descriptorMode & 0o077) {
    return { state: "conflict", reason: "runtime descriptor permissions are not private" };
  }
  if (!Number.isInteger(descriptor?.pid) || typeof descriptor?.url !== "string") {
    return { state: "invalid" };
  }
  if (!processIsAlive(descriptor.pid)) return { state: "stale" };

  let details;
  try {
    details = await processDetails(descriptor.pid);
  } catch {
    return { state: "conflict", reason: "cannot verify the process recorded by the runtime descriptor" };
  }
  if (
    details.cwd !== projectRoot
    || !details.command.includes("scripts/codex-injector.mjs")
  ) {
    return { state: "conflict", reason: "the runtime descriptor belongs to another launcher" };
  }

  let runtimeUrl;
  try {
    runtimeUrl = new URL(descriptor.url);
  } catch {
    return { state: "conflict", reason: "the runtime descriptor contains an invalid URL" };
  }
  if (
    runtimeUrl.origin !== expectedOrigin
    || runtimeUrl.pathname.split("/").filter(Boolean).length !== 1
  ) {
    return { state: "conflict", reason: "the runtime descriptor targets another service" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(metadataUrl(runtimeUrl), { signal: controller.signal });
    if (!response.ok) return { state: "conflict", reason: "the recorded launcher is not healthy" };
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || !("capabilities" in payload)) {
      return { state: "conflict", reason: "the recorded launcher returned an unexpected response" };
    }
  } catch {
    return { state: "conflict", reason: "the recorded launcher is unreachable" };
  } finally {
    clearTimeout(timeout);
  }
  return { state: "active", pid: descriptor.pid };
}

function requestOpen(runtime) {
  process.kill(runtime.pid, "SIGUSR2");
  process.stdout.write("Codex 全业务任务中心已在运行，已请求打开现有页面。\n");
}

async function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

async function acquireLock() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      for (let readAttempt = 0; readAttempt < 20; readAttempt += 1) {
        try {
          const source = (await readFile(lockFile, "utf8")).trim();
          if (/^[1-9]\d*$/.test(source)) {
            owner = Number(source);
            break;
          }
        } catch (readError) {
          if (readError?.code === "ENOENT") break;
          throw readError;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (owner === null) {
        throw new Error("Codex 全业务任务中心的启动锁正在初始化，未改动现有进程，请稍后再试");
      }
      if (processIsAlive(owner)) {
        for (let wait = 0; wait < 40; wait += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const runtime = await inspectRuntime();
          if (runtime.state === "active") {
            requestOpen(runtime);
            return null;
          }
        }
        throw new Error("Codex 全业务任务中心正在启动，请稍后再试");
      }
      let recoveryHandle;
      try {
        recoveryHandle = await open(recoveryLockFile, "wx", 0o600);
        await recoveryHandle.writeFile(`${process.pid}\n`, "utf8");
      } catch (recoveryError) {
        if (recoveryError?.code === "EEXIST") {
          throw new Error("Codex 全业务任务中心正在恢复上次启动，未改动现有进程，请稍后再试");
        }
        throw recoveryError;
      }
      try {
        const confirmedSource = (await readFile(lockFile, "utf8")).trim();
        const confirmedOwner = /^[1-9]\d*$/.test(confirmedSource)
          ? Number(confirmedSource)
          : null;
        if (confirmedOwner !== owner || processIsAlive(confirmedOwner)) continue;
        await unlink(lockFile);
      } finally {
        await recoveryHandle.close();
        try {
          await unlink(recoveryLockFile);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
    }
  }
  throw new Error("Cannot acquire the Business OS launcher lock");
}

async function releaseLock(handle) {
  if (!handle) return;
  await handle.close();
  try {
    const owner = Number((await readFile(lockFile, "utf8")).trim());
    if (owner === process.pid) await unlink(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function main() {
  const current = await inspectRuntime();
  if (current.state === "active") {
    requestOpen(current);
    return;
  }
  if (current.state === "conflict") {
    throw new Error(`Cannot reuse Taskboard: ${current.reason}`);
  }

  const lock = await acquireLock();
  if (!lock) return;
  try {
    const afterLock = await inspectRuntime();
    if (afterLock.state === "active") {
      requestOpen(afterLock);
      return;
    }
    if (afterLock.state === "conflict") {
      throw new Error(`Cannot reuse Taskboard: ${afterLock.reason}`);
    }
    if (await portIsOpen()) {
      throw new Error(`Port ${port} is already used by an unknown process; no process was stopped`);
    }

    const child = spawn(
      process.execPath,
      [injectorPath, "--launch", "--watch", "--open", "--port", String(cdpPort)],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          CODEX_TASKBOARD_DATA_DIR: dataDirectory,
          CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile,
          CODEX_TASKBOARD_HOST: host,
          CODEX_TASKBOARD_PORT: String(port),
        },
        stdio: "inherit",
      },
    );
    const forwardSignal = (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (result.code !== 0) {
      throw new Error(`Business OS launcher exited (${result.signal || result.code})`);
    }
  } finally {
    await releaseLock(lock);
  }
}

main().catch((error) => {
  process.stderr.write(`Business OS launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
