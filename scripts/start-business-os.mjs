#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, readlink, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const modulePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(modulePath), "..");
const injectorPath = path.join(projectRoot, "scripts", "codex-injector.mjs");
const dataDirectory = path.resolve(
  process.env.CODEX_TASKBOARD_DATA_DIR || path.join(projectRoot, ".data"),
);
const runtimeFile = path.resolve(
  process.env.CODEX_TASKBOARD_RUNTIME_FILE || path.join(dataDirectory, "launcher-runtime.json"),
);
const host = process.env.CODEX_TASKBOARD_HOST || "127.0.0.1";
const port = parsePort(process.env.CODEX_TASKBOARD_PORT || "47823", "CODEX_TASKBOARD_PORT");
const cdpPort = parsePort(process.env.CODEX_TASKBOARD_CODEX_PORT || "9231", "CODEX_TASKBOARD_CODEX_PORT");
const launchLockPort = resolveLaunchLockPort(
  process.env.CODEX_TASKBOARD_LAUNCH_LOCK_PORT,
  port,
  cdpPort,
);
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

function resolveLaunchLockPort(value, servicePort, browserPort) {
  if (servicePort === browserPort) {
    throw new Error("CODEX_TASKBOARD_PORT must differ from CODEX_TASKBOARD_CODEX_PORT");
  }
  let resolved;
  if (value) {
    resolved = parsePort(value, "CODEX_TASKBOARD_LAUNCH_LOCK_PORT");
  } else {
    resolved = servicePort === 65_535 ? 1 : servicePort + 1;
    if (resolved === browserPort) resolved = resolved === 65_535 ? 1 : resolved + 1;
  }
  if (resolved === servicePort || resolved === browserPort) {
    throw new Error(
      "CODEX_TASKBOARD_LAUNCH_LOCK_PORT must differ from CODEX_TASKBOARD_PORT and CODEX_TASKBOARD_CODEX_PORT",
    );
  }
  return resolved;
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
  const commandPromise = execFile("/bin/ps", ["-p", String(pid), "-o", "command="]);
  const cwdPromise = process.platform === "linux"
    ? readlink(`/proc/${pid}/cwd`)
    : execFile(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    ).then(({ stdout }) => stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n"))
      ?.slice(1));
  const [{ stdout: command }, cwd] = await Promise.all([commandPromise, cwdPromise]);
  return { command: command.trim(), cwd: cwd ? path.resolve(cwd) : null };
}

async function bindLaunchLock() {
  const server = net.createServer((socket) => socket.destroy());
  server.unref();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: launchLockPort, exclusive: true });
  });
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
    return { state: "stale" };
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
  try {
    return await bindLaunchLock();
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }

  for (let wait = 0; wait < 40; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const runtime = await inspectRuntime();
    if (runtime.state === "active") {
      requestOpen(runtime);
      return null;
    }
    try {
      return await bindLaunchLock();
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(
    `Codex 全业务任务中心正在启动，或本机协调端口 ${launchLockPort} 已被其他程序占用；未改动现有进程`,
  );
}

async function releaseLock(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main().catch((error) => {
    process.stderr.write(`Business OS launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  acquireLock,
  bindLaunchLock,
  inspectRuntime,
  launchLockPort,
  processDetails,
  releaseLock,
  resolveLaunchLockPort,
};
