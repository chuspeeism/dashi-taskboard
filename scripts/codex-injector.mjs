#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import {
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";
import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
  restartResidentInjector,
} from "./codex-injector-runtime.mjs";
import { readCodexQuotaStatus } from "./codex-rate-limits.mjs";
import { createTaskboardSupervisor } from "./taskboard-supervisor.mjs";
import {
  CdpPipeBrowser,
  validatedLoopbackCdpWebSocketUrl,
} from "./codex-cdp-pipe.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const defaultCodexDebuggingPort = 9229;
const independentCodexProfilePath = process.env.CODEX_TASKBOARD_CODEX_PROFILE
  ? path.resolve(process.env.CODEX_TASKBOARD_CODEX_PROFILE)
  : process.platform === "linux"
    ? path.join(os.tmpdir(), "codex-taskboard-independent-profile-v2")
    : "/private/tmp/codex-taskboard-independent-profile-v2";
const sourceCodexProfilePath = process.env.CODEX_TASKBOARD_CODEX_SOURCE_PROFILE
  ? path.resolve(process.env.CODEX_TASKBOARD_CODEX_SOURCE_PROFILE)
  : null;
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const taskboardDataDirectory = process.env.CODEX_TASKBOARD_DATA_DIR
  ? path.resolve(process.env.CODEX_TASKBOARD_DATA_DIR)
  : path.join(projectRoot, ".data");
const taskboardRuntimeFile = process.env.CODEX_TASKBOARD_RUNTIME_FILE
  ? path.resolve(process.env.CODEX_TASKBOARD_RUNTIME_FILE)
  : path.join(taskboardDataDirectory, "launcher-runtime.json");
const taskboardListenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
  ? null
  : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
if (taskboardListenFd !== null && (
  !Number.isInteger(taskboardListenFd)
  || taskboardListenFd < 3
  || taskboardListenFd > 255
)) {
  throw new Error("CODEX_TASKBOARD_LISTEN_FD must be an inherited file descriptor");
}
const automationPoliciesPath = path.join(
  taskboardDataDirectory,
  "codex-automation-policies.json",
);
const taskboardInstanceToken = (
  process.env.CODEX_TASKBOARD_INSTANCE_TOKEN?.trim() || randomUUID()
);
process.env.CODEX_TASKBOARD_INSTANCE_TOKEN = taskboardInstanceToken;
const taskboardInstanceSecret = (
  process.env.CODEX_TASKBOARD_INSTANCE_SECRET?.trim() || randomBytes(32).toString("hex")
);
process.env.CODEX_TASKBOARD_INSTANCE_SECRET = taskboardInstanceSecret;
const taskboardVersion = process.env.CODEX_TASKBOARD_VERSION?.trim() || "development";
process.env.CODEX_TASKBOARD_VERSION = taskboardVersion;
const taskboardOrigin = `http://127.0.0.1:${resolvePort()}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const taskboardBaseUrl = `${taskboardOrigin}/${encodeURIComponent(taskboardInstanceToken)}`;
const taskboardPageUrl = `${taskboardBaseUrl}/?host=codex`;
const hostBindingName = "__codexTaskboardHostV1";
const hostRequestMessage = "__codexTaskboardHostRequestV1";
const hostResponseMessage = "__codexTaskboardHostResponseV1";
const hostHeartbeatMessage = "__codexTaskboardHostHeartbeatV1";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV1";
const codexNotificationBindingName = "__codexTaskboardCodexNotificationV1";
const hostCapability = randomUUID();
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const codexAutomationMethods = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);
let codexAutomationRequestSequence = 0;
let codexAppServerRequestSequence = 0;
const taskConversationOperations = new Map();
const taskConversationFailureTtlMs = 120_000;
const quotaPolicyTimers = new Map();
const quotaPolicyRecords = new Map();
const quotaPolicyQueues = new Map();
const quotaPolicyCdps = new Set();
const restoredQuotaPolicyCdps = new WeakSet();
const quotaPolicyRestorePromises = new WeakMap();
const remoteAutomationDecisionWaiters = new Map();
let quotaPoliciesLoadPromise = null;
let quotaPoliciesWritePromise = Promise.resolve();
const taskConversationAppServerTimeoutMs = 30_000;
const remoteAutomationTurnTimeoutMs = 30 * 60_000;

function parseArgs(argv) {
  const options = {
    port: defaultCodexDebuggingPort,
    portExplicit: false,
    cdpPipe: false,
    launch: false,
    watch: false,
    open: false,
    refresh: false,
    refreshIfRunning: false,
    attachExisting: false,
    startupToken: null,
    daemon: false,
    screenshot: null,
    appPath: process.platform === "linux" ? "/usr/bin/chatgpt" : "/Applications/ChatGPT.app",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--cdp-pipe") options.cdpPipe = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--startup-token") {
      options.startupToken = argv[++index];
      if (!/^[a-z0-9-]{1,100}$/i.test(options.startupToken || "")) {
        throw new Error("--startup-token must be an identifier");
      }
    }
    else if (arg === "--daemon") options.daemon = true;
    else if (arg === "--port") {
      options.port = Number(argv[++index]);
      options.portExplicit = true;
    }
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (process.platform === "linux" && options.launch) options.cdpPipe = true;

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (options.cdpPipe && !options.launch) {
    throw new Error("--cdp-pipe requires --launch");
  }
  return options;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isTaskboardReachable() {
  const challenge = randomBytes(32).toString("hex");
  try {
    const response = await fetch(taskboardHealthUrl, {
      headers: { "x-codex-taskboard-challenge": challenge },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    const proof = createHmac("sha256", taskboardInstanceSecret)
      .update(challenge)
      .digest("hex");
    return body?.status === "ok"
      && body.product === "codex-taskboard"
      && body.version === taskboardVersion
      && body.proof === proof;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url, timeoutMs, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    if (await isReachable(url)) return;
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntilTaskboardReachable(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTaskboardReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for authenticated ${taskboardHealthUrl}`);
}

function startTaskboard({ detached, onCodexAppServerRequest }) {
  const baseStdio = taskboardListenFd === null
    ? Array(3).fill(detached ? "ignore" : "inherit")
    : Array.from(
      { length: taskboardListenFd + 1 },
      (_, fd) => (fd === taskboardListenFd ? "inherit" : (fd < 3 && !detached ? "inherit" : "ignore")),
    );
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    stdio: [...baseStdio, "ipc"],
  });
  child.on("message", (message) => {
    if (message?.type !== "taskboard:codex-app-server-request") return;
    void Promise.resolve(onCodexAppServerRequest(message)).then(
      (result) => {
        if (!child.connected) return;
        child.send({
          type: "taskboard:codex-app-server-response",
          requestId: message.requestId,
          hostId: message.hostId,
          result,
        });
      },
      (error) => {
        if (!child.connected) return;
        child.send({
          type: "taskboard:codex-app-server-response",
          requestId: message.requestId,
          hostId: message.hostId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
  return child;
}

async function publishTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  const temporaryPath = `${taskboardRuntimeFile}.${process.pid}.tmp`;
  await mkdir(path.dirname(taskboardRuntimeFile), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, pid: process.pid, url: taskboardBaseUrl })}\n`,
    { mode: 0o600 },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, taskboardRuntimeFile);
  await chmod(taskboardRuntimeFile, 0o600);
}

async function removeTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  try {
    const descriptor = JSON.parse(await readFile(taskboardRuntimeFile, "utf8"));
    if (descriptor.pid === process.pid && descriptor.url === taskboardBaseUrl) {
      await unlink(taskboardRuntimeFile);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function importCodexBrowserProfile() {
  if (!sourceCodexProfilePath || sourceCodexProfilePath === independentCodexProfilePath) return;
  const markerPath = path.join(
    independentCodexProfilePath,
    ".codex-taskboard-browser-profile-imported-v1",
  );
  try {
    await stat(markerPath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const databasePaths = [
    "Default/Partitions/codex-browser-app/Cookies",
    "Default/Partitions/codex-browser-app/Login Data",
    "Default/Partitions/codex-browser-app/Login Data For Account",
  ];
  const sources = [];
  for (const relativePath of databasePaths) {
    const sourcePath = path.join(sourceCodexProfilePath, relativePath);
    try {
      await stat(sourcePath);
      sources.push({ relativePath, sourcePath });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (sources.length === 0) return;

  const { DatabaseSync, backup } = await import("node:sqlite");
  for (const { relativePath, sourcePath } of sources) {
    const destinationPath = path.join(independentCodexProfilePath, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(sourceDatabase, destinationPath);
    } finally {
      sourceDatabase.close();
    }
  }
  if (sources.length === databasePaths.length) {
    await writeFile(markerPath, "1\n");
  }
}

function codexExecutablePath(appPath) {
  if (process.platform === "linux") {
    return appPath === "/usr/bin/chatgpt" ? "/usr/lib/chatgpt/ChatGPT" : appPath;
  }
  if (process.platform !== "darwin") return appPath;
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

function codexAppProcesses(appPath) {
  const processes = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) throw new Error("Unable to inspect the launched Codex process");

  const executable = codexExecutablePath(appPath);
  const matches = [];
  for (const line of processes.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (
      match
      && (match[2] === executable || match[2].startsWith(`${executable} `))
    ) {
      matches.push({ pid: Number(match[1]), command: match[2] });
    }
  }
  return matches;
}

function managedCodexProcesses(appPath) {
  const profileArgument = `--user-data-dir=${independentCodexProfilePath}`;
  return codexAppProcesses(appPath).filter((record) => (
    record.command.includes(` ${profileArgument} `)
  ));
}

function managedCodexProcess(appPath) {
  const processes = managedCodexProcesses(appPath);
  if (processes.length > 1) throw new Error("Multiple managed Codex processes are running");
  return processes[0] ?? null;
}

function codexProcessDebuggingPort(record) {
  const match = record.command.match(/ --remote-debugging-port=(\d+)(?: |$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function managedCodexUsesPort(record, port) {
  return record.command.includes(` --remote-debugging-port=${port} `);
}

function isManagedCodexRunning(record) {
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-p", String(record.pid), "-o", "command="],
    {
      encoding: "utf8",
      env: withoutTaskboardLauncherEnvironment(process.env),
    },
  );
  return result.status === 0 && result.stdout.trimEnd() === record.command;
}

async function launchCodexWithLaunchServices(appPath, port, shouldStop = () => false) {
  const existing = managedCodexProcess(appPath);
  if (existing && managedCodexUsesPort(existing, port)) return existing;
  if (existing) await stopManagedCodex(existing);
  if (shouldStop()) throw new Error("Managed Codex launch stopped");
  if (await isReachable(`http://127.0.0.1:${port}/json/version`)) {
    throw new Error(`Codex CDP port ${port} is already in use`);
  }
  if (shouldStop()) throw new Error("Managed Codex launch stopped");

  const launcher = spawn(
    "/usr/bin/open",
    [
      "-a",
      appPath,
      "--args",
      `--user-data-dir=${independentCodexProfilePath}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ],
    {
      env: withoutTaskboardLauncherEnvironment(process.env),
      stdio: "ignore",
    },
  );
  await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`LaunchServices failed to start Codex (${signal || code})`));
    });
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const launched = managedCodexProcess(appPath);
    if (launched && managedCodexUsesPort(launched, port)) return launched;
    if (launched) throw new Error("LaunchServices started Codex on an unexpected CDP port");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("LaunchServices did not start the managed Codex process");
}

async function stopManagedCodex(record) {
  if (!isManagedCodexRunning(record)) return;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isManagedCodexRunning(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!isManagedCodexRunning(record)) return;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!isManagedCodexRunning(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isManagedCodexRunning(record)) {
    throw new Error("Unable to stop the managed Codex process");
  }
}

function activateCodexApp(pid) {
  if (process.platform !== "darwin") return;
  const activation = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!app || !app.activateWithOptions(1)) throw new Error("Unable to activate Codex");`,
  ], {
    env: withoutTaskboardLauncherEnvironment(process.env),
    stdio: "ignore",
  });
  if (activation.status !== 0) throw new Error("Unable to activate the Codex app");
}

async function launchCodexWithPipe(appPath) {
  const child = spawn(
    codexExecutablePath(appPath),
    [
      `--user-data-dir=${independentCodexProfilePath}`,
      "--remote-debugging-pipe",
    ],
    {
      env: withoutTaskboardLauncherEnvironment(process.env),
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  const browser = new CdpPipeBrowser(child);
  try {
    await browser.open();
    return { child, browser };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleFailure);
        this.socket.removeEventListener("close", handleFailure);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleFailure = () => {
        cleanup();
        this.closed = true;
        reject(new Error("CDP WebSocket connection failed"));
      };
      this.socket.addEventListener("open", handleOpen, { once: true });
      this.socket.addEventListener("error", handleFailure, { once: true });
      this.socket.addEventListener("close", handleFailure, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method) || [];
        this.eventWaiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        const handlers = this.eventHandlers.get(message.method) || [];
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(message.params)).catch((error) => {
              console.error(`CDP ${message.method} handler failed: ${error.message}`);
            });
          } catch (error) {
            console.error(`CDP ${message.method} handler failed: ${error.message}`);
          }
        });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
    });
  }

  send(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket closed"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(isCodexTarget).map((target) => {
    return {
      ...target,
      webSocketDebuggerUrl: validatedLoopbackCdpWebSocketUrl(
        target.webSocketDebuggerUrl,
        port,
      ),
    };
  });
}

function isCodexTarget(target) {
  return (
      target.type === "page" &&
      !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
      !target.url?.includes("initialRoute=%2Favatar-overlay") &&
      (target.url?.startsWith("app://") || target.title === "Codex")
  );
}

function tcpCdpRuntime(port) {
  return {
    targets: () => codexTargets(port),
    connect: async (target) => {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      await connection.open();
      return connection;
    },
    close: () => {},
  };
}

function pipeCdpRuntime(browser) {
  return {
    targets: async () => (await browser.targets())
      .filter(isCodexTarget)
      .map((target) => ({ ...target, id: target.targetId })),
    connect: (target) => browser.connect(target.id),
    isHealthy: () => !browser.closed,
    close: () => browser.close(),
  };
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

function processCwd(pid) {
  const result = spawnSync("/usr/sbin/lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function residentInjectorPids(port) {
  const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [];
  return findResidentInjectorPids({
    processList: processes.stdout,
    currentPid: process.pid,
    injectorPath,
    projectRoot,
    port,
    defaultPort: defaultCodexDebuggingPort,
    cwdForPid: processCwd,
  });
}

function startResidentInjector(
  port,
  shouldOpen,
  attachExisting = false,
  startupToken = null,
) {
  const [existingPid] = residentInjectorPids(port);
  if (existingPid) return { pid: existingPid, started: false };
  const args = [injectorPath, "--watch", "--port", String(port)];
  if (shouldOpen) args.push("--open");
  if (attachExisting) args.push("--attach-existing");
  if (startupToken) args.push("--startup-token", startupToken);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, started: true };
}

async function stopResidentInjector(pid) {
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out stopping resident Taskboard injector ${pid}`);
}

async function waitForResidentInjectorReady(port, pid, startupToken, expectedSourceHash) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      const targets = await codexTargets(port);
      for (const target of targets) {
        const cdp = new CdpConnection(target.webSocketDebuggerUrl);
        await cdp.open();
        try {
          const readiness = await cdp.send("Runtime.evaluate", {
            expression: `({
              token: window[${JSON.stringify(hostStartupTokenName)}],
              taskboardEntryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
              sourceHash: window.__codexTaskboardInjection__?.sourceHash || null
            })`,
            returnByValue: true,
          });
          if (
            readiness.result.value?.token === startupToken
            && readiness.result.value.taskboardEntryMounted
            && readiness.result.value.sourceHash === expectedSourceHash
          ) return;
        } finally {
          cdp.close();
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for resident Taskboard injector ${pid}`);
}

async function restartResidentInjectorForRefresh(port) {
  const { sourceHash } = await currentInjectionSource();
  return restartResidentInjector(port, {
    findResidents: residentInjectorPids,
    stopResident: stopResidentInjector,
    createStartupToken: randomUUID,
    startResident: (targetPort, startupToken) => (
      startResidentInjector(targetPort, false, true, startupToken)
    ),
    waitUntilReady: (targetPort, pid, startupToken) => (
      waitForResidentInjectorReady(targetPort, pid, startupToken, sourceHash)
    ),
  });
}

async function refreshTaskboardFrames(port) {
  const targets = await codexTargets(port);
  const results = [];

  for (const target of targets) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await cdp.send("Runtime.enable");
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.reloadFrame === "function") {
            return { refreshed: taskboard.reloadFrame(), via: "injection" };
          }
          const frame = document.getElementById("codex-taskboard-frame");
          if (!frame) return { refreshed: false, via: "not-mounted" };
          const url = new URL(frame.getAttribute("src") || frame.src);
          url.searchParams.set("__codex_taskboard_refresh", Date.now().toString(36));
          frame.setAttribute("src", url.href);
          return { refreshed: true, via: "fallback", frameUrl: url.href };
        })()`,
        returnByValue: true,
      });
      if (evaluation.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description || "Taskboard frame refresh failed",
        );
      }
      results.push({
        targetId: target.id,
        title: target.title,
        url: target.url,
        ...evaluation.result.value,
      });
    } finally {
      cdp.close();
    }
  }

  return results;
}

function frameTreeContains(frameTree, expectedUrl) {
  if (frameTree.frame?.url === expectedUrl) return true;
  return frameTree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree"),
    ]);
    if (
      targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) ||
      frameTreeContains(frameTree, expectedUrl)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function findFrameByName(frameTree, frameName) {
  if (frameTree.frame?.name === frameName) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByName(child, frameName);
    if (match) return match;
  }
  return null;
}

async function verifiedTaskboardDocument(frameCapability) {
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(taskboardPageUrl, {
    cache: "no-store",
    headers: {
      origin: "app://-",
      "x-codex-taskboard-challenge": challenge,
    },
  });
  if (!response.ok) throw new Error(`Taskboard HTTP ${response.status}`);
  const proof = response.headers.get("x-codex-taskboard-proof") ?? "";
  const expectedProof = createHmac("sha256", taskboardInstanceSecret)
    .update(challenge)
    .digest("hex");
  if (proof !== expectedProof) throw new Error("Taskboard service identity check failed");
  const html = await response.text();
  const head = "<head>";
  if (!html.includes(head)) throw new Error("Taskboard document has no head element");
  return html.replace(
    head,
    `${head}<base href=${JSON.stringify(taskboardPageUrl)}><script>globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__=${JSON.stringify(frameCapability)};</script>`,
  );
}

async function loadTaskboardFrameViaCdp(cdp, frameName, frameCapability) {
  const html = await verifiedTaskboardDocument(frameCapability);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const targetFrame = findFrameByName(frameTree, frameName);
    if (targetFrame) {
      await cdp.send("Page.setDocumentContent", {
        frameId: targetFrame.id,
        html,
      });
      return { loaded: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the isolated Taskboard frame");
}

async function openWithDefaultApplication(target) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "linux" ? "xdg-open" : "/usr/bin/open",
      [target],
      {
        detached: true,
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function revealAttachmentInFinder(attachmentPath, directory) {
  if (process.platform === "linux") {
    await openWithDefaultApplication(directory);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-R", attachmentPath], {
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Finder could not reveal the attachment"));
      });
    });
  } catch {
    await openWithDefaultApplication(directory);
  }
}

async function openExternalUrl(request) {
  await openWithDefaultApplication(request.url);
  return { opened: true };
}

async function openAttachment(request) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/attachments/${encodeURIComponent(request.attachmentId)}/content`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Attachment content returned HTTP ${response.status}`);
  const directory = path.join(
    taskboardDataDirectory,
    "opened-attachments",
    request.attachmentId,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachmentPath = path.join(directory, request.filename);
  await writeFile(attachmentPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  await revealAttachmentInFinder(attachmentPath, directory);
  return { opened: true };
}

async function requestCodexAutomationViaCdp(cdp, executionContextId, method, params) {
  if (!codexAutomationMethods.has(method)) {
    throw new Error(`Unsupported Codex automation method: ${method}`);
  }
  const requestId = [
    "taskboard-automation",
    process.pid,
    Date.now().toString(36),
    (++codexAutomationRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const method = ${JSON.stringify(method)};
      const params = ${JSON.stringify(params)};
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        finish({
          ok: true,
          responseType: message.responseType,
          status: message.status,
          bodyJsonString: message.bodyJsonString,
        });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
        10_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: \`vscode://codex/${method}\`,
        body: JSON.stringify(params),
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex automation request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex automation request failed");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Codex automation request returned HTTP ${response.status}`);
  }
  if (typeof response.bodyJsonString !== "string" || response.bodyJsonString.length === 0) {
    return {};
  }
  try {
    return JSON.parse(response.bodyJsonString);
  } catch {
    throw new Error("Codex automation request returned invalid JSON");
  }
}

async function requestCodexAppServerViaCdp(
  cdp,
  executionContextId,
  hostId,
  method,
  params,
  timeoutMs = taskConversationAppServerTimeoutMs,
) {
  const requestId = [
    "taskboard-thread",
    process.pid,
    Date.now().toString(36),
    (++codexAppServerRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "Codex App Server bridge is unavailable" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage, true);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "mcp-response"
          || message.hostId !== ${JSON.stringify(hostId)}
          || message.message?.id !== requestId
        ) return;
        event.stopImmediatePropagation();
        if (message.message.error) {
          finish({
            ok: false,
            error: message.message.error.message || "Codex App Server request failed",
          });
          return;
        }
        finish({ ok: true, result: message.message.result });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex App Server request timed out" }),
        ${JSON.stringify(timeoutMs)},
      );
      window.addEventListener("message", onMessage, true);
      Promise.resolve(bridge.sendMessageFromView({
        type: "mcp-request",
        hostId: ${JSON.stringify(hostId)},
        request: {
          id: requestId,
          method: ${JSON.stringify(method)},
          params: ${JSON.stringify(params)},
        },
        priority: "interactive",
        source: "taskboard_thread_create",
        timeoutMs: ${JSON.stringify(timeoutMs)},
        expiresAtMs: Date.now() + ${JSON.stringify(timeoutMs)},
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex App Server request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex App Server request failed");
  return response.result;
}

async function taskboardRequest(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    method,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "x-taskboard-client": "taskctl",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Taskboard returned invalid JSON for ${method} ${pathname}`);
    }
  }
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Taskboard returned HTTP ${response.status} for ${method} ${pathname}`,
    );
  }
  return payload;
}

function normalizeRemoteWorkspace(value) {
  const workspacePath = String(value || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(workspacePath)
    ? `${workspacePath[0].toLowerCase()}${workspacePath.slice(1)}`
    : workspacePath;
}

function remoteAutomationTarget(request, task) {
  const workspacePath = task.developmentContext?.type === "worktree"
    ? task.developmentContext.path
    : request.workspacePath;
  const matches = (request.remoteProjects ?? []).filter((project) => (
    project.codexProjectKind === "remote"
    && project.codexHostId === request.codexHostId
    && normalizeRemoteWorkspace(project.workspacePath) === normalizeRemoteWorkspace(workspacePath)
    && (
      task.developmentContext?.type === "worktree"
      || project.codexProjectId === request.codexProjectId
    )
  ));
  return matches.length === 1 ? matches[0] : null;
}

function eligibleRemoteAutomationTask(task) {
  const remoteBinding = task?.threadBinding?.codexProjectKind === "remote"
    && task.threadId === task.threadBinding.threadId;
  return task?.status === "todo"
    && task.archivedAt === null
    && ((!task.threadId && !task.threadBinding) || remoteBinding)
    && (task.relations?.blockedBy ?? []).every((dependency) => dependency.status === "done");
}

function remoteAutomationSnapshot(task, comments, attachments) {
  return JSON.stringify({
    task: {
      version: task.version,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      developmentContext: task.developmentContext,
      blockedBy: (task.relations?.blockedBy ?? []).map((dependency) => [
        dependency.id,
        dependency.status,
      ]),
    },
    comments: comments.map((comment) => [
      comment.id,
      comment.version,
      comment.body,
      (comment.attachments ?? []).map((attachment) => [
        attachment.id,
        attachment.filename,
        attachment.contentType,
        attachment.size,
      ]),
    ]),
    attachments: attachments.map((attachment) => [
      attachment.id,
      attachment.filename,
      attachment.contentType,
      attachment.size,
    ]),
  });
}

function remoteAutomationPrompt(task, comments, attachments, target) {
  const commentText = comments.length > 0
    ? comments.map((comment) => (
      `- ${comment.authorName} (${comment.createdAt}):\n${comment.body}`
    )).join("\n\n")
    : "（无）";
  const attachmentItems = [
    ...attachments,
    ...comments.flatMap((comment) => comment.attachments ?? []),
  ];
  const attachmentText = attachmentItems.length > 0
    ? attachmentItems.map((attachment) => (
      `- ${attachment.filename} (${attachment.contentType}, ${attachment.size} bytes)`
    )).join("\n")
    : "（无）";
  const developmentContext = task.developmentContext
    ? JSON.stringify(task.developmentContext)
    : "（项目根目录）";
  return [
    `处理 Taskboard 议题 ${task.identifier}：${task.title}`,
    "",
    `远程工作目录：${target.workspacePath}`,
    `开发上下文：${developmentContext}`,
    "",
    "完整描述：",
    task.description || "（无）",
    "",
    "全部评论：",
    commentText,
    "",
    "附件：",
    attachmentText,
    "",
    "你只负责在当前远程项目和工作目录内完成实现与直接验证。不要运行 taskctl，也不要访问或修改 Taskboard。完成后返回改动、验证结果、执行结果和剩余限制。",
  ].join("\n");
}

function waitForRemoteAutomationDecision(hostId, threadId) {
  const key = `${hostId}\0${threadId}`;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const finish = (error, answer) => {
      clearTimeout(timer);
      remoteAutomationDecisionWaiters.delete(key);
      if (error) reject(error);
      else resolve(answer);
    };
    const timer = setTimeout(
      () => finish(new Error("Codex 自动认领判断超时")),
      remoteAutomationTurnTimeoutMs,
    );
    timer.unref();
    remoteAutomationDecisionWaiters.set(key, { finish });
    cancel = () => {
      clearTimeout(timer);
      remoteAutomationDecisionWaiters.delete(key);
    };
  });
  return { promise, cancel };
}

function handleRemoteAutomationDecisionNotification(notification) {
  const params = notification.params;
  const waiter = remoteAutomationDecisionWaiters.get(
    `${notification.hostId}\0${params?.threadId}`,
  );
  if (!waiter) return;
  if (notification.method !== "turn/completed") return;
  if (params.turn?.status !== "completed") {
    waiter.finish(new Error(params.turn?.error?.message || "Codex 自动认领判断失败"));
    return;
  }
  const answer = [...params.turn.items].reverse()
    .find((item) => item.type === "agentMessage")?.text?.trim() || "";
  waiter.finish(null, answer);
}

async function remoteAutomationCanStart(cdp, request, task, comments) {
  const latestComment = comments.at(-1);
  const started = await requestCodexAppServerViaCdp(
    cdp,
    undefined,
    request.codexHostId,
    "thread/start",
    {
      ephemeral: true,
      model: request.model,
      cwd: request.workspacePath,
      runtimeWorkspaceRoots: [request.workspacePath],
      approvalPolicy: "never",
      sandbox: "read-only",
    },
  );
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || !threadId || started.thread.ephemeral !== true) {
    throw new Error("Codex 未创建临时自动认领判断线程");
  }

  const completion = waitForRemoteAutomationDecision(request.codexHostId, threadId);
  let turnStarted;
  try {
    turnStarted = await requestCodexAppServerViaCdp(
      cdp,
      undefined,
      request.codexHostId,
      "turn/start",
      {
        threadId,
        input: [{
          type: "text",
          text: [
            "你是 Codex Taskboard 自动认领 Agent。只判断下面的议题当前是否允许开始。",
            "根据完整描述和最新评论做语义判断：若任一处明确要求等待、暂不执行或当前不应开始，decision 为 wait；否则 decision 为 start。不要调用工具，不要解释。",
            JSON.stringify({
              identifier: task.identifier,
              title: task.title,
              description: task.description,
              latestComment: latestComment
                ? {
                    authorName: latestComment.authorName,
                    createdAt: latestComment.createdAt,
                    body: latestComment.body,
                  }
                : null,
            }),
          ].join("\n\n"),
        }],
        effort: request.reasoningEffort,
        outputSchema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["start", "wait"] },
          },
          required: ["decision"],
          additionalProperties: false,
        },
      },
    );
  } catch (error) {
    completion.cancel();
    throw error;
  }
  const turnId = turnStarted?.turn?.id;
  if (typeof turnId !== "string" || !turnId) {
    completion.cancel();
    throw new Error("Codex 未返回自动认领判断 turn");
  }
  const answer = await completion.promise;
  let decision;
  try {
    decision = JSON.parse(answer).decision;
  } catch {}
  if (decision !== "start" && decision !== "wait") {
    throw new Error("Codex 未返回有效的自动认领判断");
  }
  return decision === "start";
}

async function runRemoteTaskboardAutomation(record) {
  const { request, version } = record;
  if (
    !request.enabledByUser
    || request.codexProjectKind !== "remote"
    || quotaPolicyRecords.get(request.taskboardProjectId)?.version !== version
  ) return;

  const listed = await taskboardRequest(
    `/api/tasks?projectId=${encodeURIComponent(request.taskboardProjectId)}&status=todo`,
  );
  const listedTask = listed.tasks?.find(eligibleRemoteAutomationTask);
  if (!listedTask) return;

  const taskPath = `/api/tasks/${encodeURIComponent(listedTask.id)}`;
  const commentsPath = `${taskPath}/comments`;
  const attachmentsPath = `${taskPath}/attachments`;
  const [{ task }, { comments }, { attachments }] = await Promise.all([
    taskboardRequest(taskPath),
    taskboardRequest(commentsPath),
    taskboardRequest(attachmentsPath),
  ]);
  if (!eligibleRemoteAutomationTask(task) || task.projectId !== request.taskboardProjectId) return;
  const cdp = currentQuotaPolicyCdp();
  if (!(await remoteAutomationCanStart(cdp, request, task, comments))) return;
  const existingBinding = task.threadBinding?.codexProjectKind === "remote"
    ? task.threadBinding
    : null;
  const target = existingBinding ?? remoteAutomationTarget(request, task);
  if (!target) {
    await taskboardRequest(commentsPath, {
      method: "POST",
      body: { body: "自动认领未开始：目标 SSH 工作目录没有唯一的已登记 Codex 项目映射。" },
    });
    return;
  }
  const snapshot = remoteAutomationSnapshot(task, comments, attachments);
  const started = await requestCodexAppServerViaCdp(
    cdp,
    undefined,
    target.codexHostId,
    existingBinding ? "thread/resume" : "thread/start",
    {
      ...(existingBinding ? { threadId: existingBinding.threadId } : {}),
      model: request.model,
      cwd: target.workspacePath,
      runtimeWorkspaceRoots: [target.workspacePath],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    },
  );
  const threadId = started?.thread?.id;
  if (
    typeof threadId !== "string"
    || !threadId
    || normalizeRemoteWorkspace(started.thread.cwd) !== normalizeRemoteWorkspace(target.workspacePath)
  ) {
    throw new Error(`Codex did not ${existingBinding ? "resume" : "create"} the automation thread in the selected SSH workspace`);
  }

  const refreshed = await Promise.all([
    taskboardRequest(taskPath),
    taskboardRequest(commentsPath),
    taskboardRequest(attachmentsPath),
  ]);
  const refreshedTask = refreshed[0].task;
  const refreshedComments = refreshed[1].comments;
  const refreshedAttachments = refreshed[2].attachments;
  const refreshedTarget = refreshedTask.threadBinding?.codexProjectKind === "remote"
    ? refreshedTask.threadBinding
    : remoteAutomationTarget(request, refreshedTask);
  if (
    !eligibleRemoteAutomationTask(refreshedTask)
    || remoteAutomationSnapshot(refreshedTask, refreshedComments, refreshedAttachments) !== snapshot
    || refreshedTarget?.codexProjectId !== target.codexProjectId
    || refreshedTarget?.codexProjectKind !== target.codexProjectKind
    || refreshedTarget?.codexHostId !== target.codexHostId
    || refreshedTarget?.workspacePath !== target.workspacePath
    || refreshedTarget?.threadId !== target.threadId
  ) return;

  const threadBinding = existingBinding ?? {
    threadId,
    codexProjectId: target.codexProjectId,
    codexProjectKind: "remote",
    codexHostId: target.codexHostId,
    workspacePath: target.workspacePath,
  };
  let ownedTask = (
    await taskboardRequest(`${taskPath}/move`, {
      method: "POST",
      body: {
        version: refreshedTask.version,
        status: "in_progress",
        threadId,
        threadBinding,
      },
    })
  ).task;

  try {
    const turnStarted = await requestCodexAppServerViaCdp(
      cdp,
      undefined,
      target.codexHostId,
      "turn/start",
      {
        threadId,
        input: [{
          type: "text",
          text: remoteAutomationPrompt(
            refreshedTask,
            refreshedComments,
            refreshedAttachments,
            target,
          ),
        }],
        effort: request.reasoningEffort,
      },
    );
    const turnId = turnStarted?.turn?.id;
    if (typeof turnId !== "string" || !turnId) {
      throw new Error("Codex did not return the remote automation turn id");
    }

    const deadline = Date.now() + remoteAutomationTurnTimeoutMs;
    let finalText = "";
    while (Date.now() < deadline) {
      let read;
      try {
        read = await requestCodexAppServerViaCdp(
          cdp,
          undefined,
          target.codexHostId,
          "thread/read",
          { threadId, includeTurns: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("rollout") || !message.includes("is empty")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      const turn = read?.thread?.turns?.find((candidate) => candidate.id === turnId);
      if (turn?.status === "completed") {
        finalText = [...turn.items].reverse().find((item) => item.type === "agentMessage")?.text?.trim() || "";
        if (!finalText) throw new Error("Codex completed without a final result");
        break;
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        throw new Error(turn.error?.message || `Codex remote turn ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!finalText) throw new Error("Codex remote automation turn timed out");

    await taskboardRequest(commentsPath, {
      method: "POST",
      body: {
        body: [
          "自动认领远程执行完成。",
          `- Codex host：${target.codexHostId}`,
          `- 远程目录：${target.workspacePath}`,
          `- 远程 thread：${threadId}`,
          "",
          finalText,
        ].join("\n").slice(0, 100_000),
        threadId,
        threadBinding,
      },
    });
    ownedTask = (
      await taskboardRequest(`${taskPath}/move`, {
        method: "POST",
        body: {
          version: ownedTask.version,
          status: "in_review",
          threadId,
          threadBinding,
        },
      })
    ).task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await taskboardRequest(commentsPath, {
      method: "POST",
      body: {
        body: `自动认领远程执行失败：${message}`.slice(0, 100_000),
        threadId,
        threadBinding,
      },
    });
    await taskboardRequest(`${taskPath}/move`, {
      method: "POST",
      body: {
        version: ownedTask.version,
        status: "blocked",
        threadId,
        threadBinding,
      },
    });
  }
}

function remoteAutomationItem(request, status, nextRunAt) {
  return {
    id: request.automationId || `taskboard-${request.taskboardProjectId}`,
    status,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${request.intervalMinutes}`,
    nextRunAt: status === "ACTIVE" ? nextRunAt : null,
  };
}

async function applyTaskboardAutomationPolicy(
  request,
  rpc,
  stillCurrent = () => true,
  { explicit = false, previousQuotaState, remoteNextRunAt } = {},
) {
  const todoResponse = request.enabledByUser
    ? await fetch(
      `${taskboardBaseUrl}/api/tasks?projectId=${encodeURIComponent(request.taskboardProjectId)}&status=todo`,
      { cache: "no-store" },
    )
    : null;
  if (todoResponse && !todoResponse.ok) {
    throw new Error(`Taskboard todo check returned HTTP ${todoResponse.status}`);
  }
  const todoPayload = todoResponse ? await todoResponse.json() : null;
  if (todoPayload && !Array.isArray(todoPayload.tasks)) {
    throw new Error("Taskboard todo check returned invalid JSON");
  }
  const hasTodo = todoPayload ? todoPayload.tasks.length > 0 : null;
  const quota = request.quotaAware && hasTodo !== false
    ? await readCodexQuotaStatus(request.model)
    : null;
  if (!stillCurrent()) return { quota, stale: true };
  if (request.codexProjectKind === "remote") {
    const currentStatus = request.enabledByUser
      && (!request.quotaAware || previousQuotaState === "available")
      ? "ACTIVE"
      : "PAUSED";
    const currentItem = remoteAutomationItem(request, currentStatus, remoteNextRunAt);
    const operation = taskboardAutomationPolicyOperation(request, {
      explicit,
      hasTodo,
      previousQuotaState,
      quotaState: quota?.state,
      currentStatus,
    });
    const status = operation === "pause" ? "PAUSED" : "ACTIVE";
    const existingNextRunAt = Number(remoteNextRunAt);
    const nextRunAt = status === "ACTIVE"
      ? (
        Number.isFinite(existingNextRunAt) && existingNextRunAt > Date.now()
          ? existingNextRunAt
          : Date.now() + request.intervalMinutes * 60_000
      )
      : null;
    const item = operation === "list"
      ? currentItem
      : remoteAutomationItem(request, status, nextRunAt);
    return {
      item,
      items: [item],
      operation,
      hasTodo,
      ...(quota ? { quota } : {}),
    };
  }
  let listed = null;
  let currentItem;
  if (!explicit && request.enabledByUser) {
    listed = await reconcileTaskboardAutomation({ ...request, operation: "list" }, rpc);
    const items = Array.isArray(listed.items) ? listed.items : [];
    currentItem = (
      request.automationId
        ? items.find((item) => item.id === request.automationId)
        : null
    ) ?? items[0];
  }
  const operation = taskboardAutomationPolicyOperation(request, {
    explicit,
    hasTodo,
    previousQuotaState,
    quotaState: quota?.state,
    currentStatus: currentItem?.status,
  });
  const result = operation === "list"
    ? { item: currentItem, items: listed.items }
    : await reconcileTaskboardAutomation({ ...request, operation }, rpc);
  if (result?.error === "not-found") {
    return { operation, hasTodo, ...(quota ? { quota } : {}) };
  }
  return { ...result, operation, hasTodo, ...(quota ? { quota } : {}) };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    codexProjectKind: request.codexProjectKind,
    codexHostId: request.codexHostId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
    remoteProjects: request.remoteProjects ?? [],
    skillPath: request.skillPath,
    ...(request.automationId ? { automationId: request.automationId } : {}),
    enabledByUser: request.enabledByUser,
    quotaAware: request.quotaAware,
    intervalMinutes: request.intervalMinutes,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

function restoredAutomationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { nextRunAt, quota, ...stored } = value;
  const request = parseTaskboardAutomationHostRequest({
    ...stored,
    id: "restored-policy",
    action: "automation",
    requestId: "restored-policy",
    operation: "apply-policy",
  });
  return request
    ? {
      request,
      ...(quota ? { quota } : {}),
      ...(Number.isFinite(nextRunAt) ? { nextRunAt } : {}),
    }
    : null;
}

async function ensureQuotaPoliciesLoaded() {
  if (quotaPoliciesLoadPromise) return quotaPoliciesLoadPromise;
  quotaPoliciesLoadPromise = (async () => {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(automationPoliciesPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const value of Object.values(stored)) {
      const restored = restoredAutomationPolicy(value);
      if (!restored) continue;
      quotaPolicyRecords.set(restored.request.taskboardProjectId, {
        version: 1,
        ...restored,
      });
    }
  })();
  return quotaPoliciesLoadPromise;
}

function persistQuotaPolicies() {
  const data = Object.fromEntries(
    [...quotaPolicyRecords.entries()].map(([projectId, record]) => [
      projectId,
      {
        ...storedAutomationPolicy(record.request),
        ...(record.quota ? { quota: record.quota } : {}),
        ...(Number.isFinite(record.nextRunAt) ? { nextRunAt: record.nextRunAt } : {}),
      },
    ]),
  );
  quotaPoliciesWritePromise = quotaPoliciesWritePromise
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(automationPoliciesPath), { recursive: true });
      await writeFile(automationPoliciesPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  return quotaPoliciesWritePromise;
}

function registerQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
  quotaPolicyCdps.add(cdp);
}

function unregisterQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
}

function currentQuotaPolicyCdp() {
  const candidates = [...quotaPolicyCdps].reverse();
  for (const cdp of candidates) {
    if (!cdp.closed) return cdp;
    quotaPolicyCdps.delete(cdp);
  }
  throw new Error("No live Codex renderer is available for quota automation");
}

function scheduleQuotaPolicyCheck(record, result) {
  const { request, version } = record;
  const key = request.taskboardProjectId;
  const previous = quotaPolicyTimers.get(key);
  if (previous) clearTimeout(previous);
  quotaPolicyTimers.delete(key);
  if (!request.enabledByUser) return;

  const nextRunAt = Number(result.item?.nextRunAt);
  const nextRunDelay = Number.isFinite(nextRunAt) && nextRunAt > Date.now()
    ? Math.max(
      1_000,
      nextRunAt - Date.now() - (request.codexProjectKind === "remote" ? 0 : 15_000),
    )
    : 60_000;
  const resetDelay = result.quota?.state === "blocked"
    && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  const timer = setTimeout(async () => {
    if (quotaPolicyRecords.get(key)?.version !== version) return;
    try {
      if (request.codexProjectKind === "remote" && result.item?.status === "ACTIVE") {
        await runRemoteTaskboardAutomation(record);
      }
      await enqueueCurrentQuotaPolicy(key);
    } catch (error) {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      const current = quotaPolicyRecords.get(key);
      if (current?.version === version) {
        scheduleQuotaPolicyCheck(current, { quota: { state: "unknown" } });
      }
    }
  }, Math.min(nextRunDelay, resetDelay));
  timer.unref();
  quotaPolicyTimers.set(key, timer);
}

function enqueueQuotaPolicyMutation(record, rpc, { explicit = false } = {}) {
  const key = record.request.taskboardProjectId;
  const previous = quotaPolicyQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = quotaPolicyRecords.get(key);
      if (!current || current.version !== record.version) return { stale: true };
      const result = await applyTaskboardAutomationPolicy(
        current.request,
        rpc,
        () => quotaPolicyRecords.get(key)?.version === current.version,
        {
          explicit,
          previousQuotaState: current.quota?.state,
          remoteNextRunAt: current.nextRunAt,
        },
      );
      if (result.stale) return result;
      if (result.hasTodo === false && result.operation === "pause") {
        current.version += 1;
        current.request = { ...current.request, enabledByUser: false };
      } else if (!explicit && result.operation === "list" && result.item?.status === "PAUSED") {
        current.version += 1;
        current.request = { ...current.request, enabledByUser: false };
      }
      if (result.item?.id) {
        current.request = { ...current.request, automationId: result.item.id };
      }
      if (current.request.codexProjectKind === "remote") {
        const nextRunAt = Number(result.item?.nextRunAt);
        if (result.item?.status === "ACTIVE" && Number.isFinite(nextRunAt)) {
          current.nextRunAt = nextRunAt;
        } else {
          delete current.nextRunAt;
        }
      }
      if (current.request.quotaAware && result.quota) current.quota = result.quota;
      else if (!current.request.quotaAware) delete current.quota;
      await persistQuotaPolicies();
      scheduleQuotaPolicyCheck(current, result);
      return result;
    });
  const tracked = run.finally(() => {
    if (quotaPolicyQueues.get(key) === tracked) quotaPolicyQueues.delete(key);
  });
  quotaPolicyQueues.set(key, tracked);
  return tracked;
}

async function updateAndApplyQuotaPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const previous = quotaPolicyRecords.get(request.taskboardProjectId);
  const record = {
    version: (previous?.version ?? 0) + 1,
    request,
    ...(request.quotaAware && previous?.quota ? { quota: previous.quota } : {}),
  };
  quotaPolicyRecords.set(request.taskboardProjectId, record);
  try {
    await persistQuotaPolicies();
    const result = await enqueueQuotaPolicyMutation(record, rpc, { explicit: true });
    const current = quotaPolicyRecords.get(request.taskboardProjectId);
    return {
      ...result,
      policy: storedAutomationPolicy(current.request),
      ...(current.quota ? { quota: current.quota } : {}),
    };
  } catch (error) {
    if (quotaPolicyRecords.get(request.taskboardProjectId)?.version === record.version) {
      if (previous) quotaPolicyRecords.set(request.taskboardProjectId, previous);
      else quotaPolicyRecords.delete(request.taskboardProjectId);
      await persistQuotaPolicies();
    }
    throw error;
  }
}

async function reconcileStoredAutomationPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const projectId = request.taskboardProjectId;
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return null;
  if (
    record.request.codexProjectId !== request.codexProjectId
    || record.request.codexProjectKind !== request.codexProjectKind
    || record.request.codexHostId !== request.codexHostId
    || record.request.workspacePath !== request.workspacePath
    || JSON.stringify(record.request.remoteProjects ?? []) !== JSON.stringify(request.remoteProjects ?? [])
  ) {
    return updateAndApplyQuotaPolicy({
      ...request,
      automationId: record.request.automationId,
      enabledByUser: record.request.enabledByUser,
      quotaAware: record.request.quotaAware,
      intervalMinutes: record.request.intervalMinutes,
      model: record.request.model,
      reasoningEffort: record.request.reasoningEffort,
    }, rpc);
  }
  const result = await enqueueQuotaPolicyMutation(record, rpc);
  const current = quotaPolicyRecords.get(projectId);
  return {
    ...result,
    policy: storedAutomationPolicy(current.request),
    ...(current.quota ? { quota: current.quota } : {}),
  };
}

async function enqueueCurrentQuotaPolicy(projectId) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return { stale: true };
  return enqueueQuotaPolicyMutation(
    record,
    (method, body) => requestCodexAutomationViaCdp(
      currentQuotaPolicyCdp(),
      undefined,
      method,
      body,
    ),
  );
}

async function restoreQuotaPolicies(cdp) {
  registerQuotaPolicyCdp(cdp);
  if (restoredQuotaPolicyCdps.has(cdp)) return;
  const pending = quotaPolicyRestorePromises.get(cdp);
  if (pending) return pending;
  const restoring = (async () => {
    await ensureQuotaPoliciesLoaded();
    for (const [projectId, record] of quotaPolicyRecords) {
      if (record.request.enabledByUser) {
        await enqueueCurrentQuotaPolicy(projectId);
      }
    }
    restoredQuotaPolicyCdps.add(cdp);
  })();
  quotaPolicyRestorePromises.set(cdp, restoring);
  try {
    await restoring;
  } finally {
    quotaPolicyRestorePromises.delete(cdp);
  }
}

async function startTaskConversationViaCdp(cdp, executionContextId, request) {
  const {
    codexHostId,
    instruction,
    previousThreadId,
    projectless,
    targetRoot,
    title,
  } = request;
  const normalizeWorkspaceRoot = (value) => {
    const root = String(value || "").trim();
    if (!root) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(root) || root.includes("\\");
    const normalizedSlashes = windowsPath ? root.replace(/\\/g, "/") : root;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  };
  const normalizedTargetRoot = normalizeWorkspaceRoot(targetRoot);
  const deadline = Date.now() + 8_000;
  let submitted = false;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const root = Array.from(document.querySelectorAll(
          '[data-codex-composer-root][data-composer-placement="home"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const conversationId = root
          ?.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id')
          ?.trim() || "";
        const editor = Array.from(root?.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        ) || []).find((candidate) => candidate.getClientRects().length > 0);
        if (
          !root
          || conversationId
          || !editor
          || (editor.innerText || "") !== ${JSON.stringify(instruction)}
        ) return false;
        editor.focus();
        return true;
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (prepared.result.value !== true) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    submitted = true;
    break;
  }
  if (!submitted) throw new Error("Codex new conversation composer did not become ready");

  const threadDeadline = Date.now() + 12_000;
  let discoveredThreadId = "";
  try {
    while (Date.now() < threadDeadline) {
      const started = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const root = Array.from(document.querySelectorAll(
            '[data-codex-composer-root][data-composer-placement="thread"]'
          )).find((candidate) => candidate.getClientRects().length > 0);
          const threadId = root
            ?.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id')
            ?.trim() || "";
          return threadId.replace(/^(?:local|cloud):/i, "");
        })()`,
        contextId: executionContextId,
        returnByValue: true,
      });
      const threadId = typeof started.result.value === "string" ? started.result.value : "";
      if (threadId && threadId !== previousThreadId) {
        discoveredThreadId = threadId;
        const readyDeadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < readyDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (
              result?.thread?.id === threadId
              && (
                projectless
                || normalizeWorkspaceRoot(result.thread.cwd) === normalizedTargetRoot
              )
            ) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (!ready) {
          throw new Error(projectless
            ? "Codex did not confirm the projectless task conversation"
            : "Codex did not confirm the task conversation workspace root");
        }

        try {
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();
          if (!message.includes("rollout") || !message.includes("is empty")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        }

        const titleDeadline = Date.now() + 10_000;
        while (Date.now() < titleDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (result?.thread?.id === threadId && result.thread.name === title) {
              return { threadId, title };
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error("Codex did not confirm the task conversation title");
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error("Timed out while starting the Codex conversation");
  } catch (error) {
    if (error && typeof error === "object") {
      if (discoveredThreadId) error.threadId = discoveredThreadId;
      else if (submitted) error.uncertain = true;
    }
    throw error;
  }
}

function getOrStartTaskConversation(cdp, executionContextId, request) {
  const existing = taskConversationOperations.get(request.taskId);
  if (existing) return existing.promise;

  const operation = { promise: null };
  const promise = Promise.resolve().then(() => (
    startTaskConversationViaCdp(cdp, executionContextId, request)
  ));
  operation.promise = promise;
  taskConversationOperations.set(request.taskId, operation);
  const clearSettledOperation = () => {
    if (taskConversationOperations.get(request.taskId) === operation) {
      taskConversationOperations.delete(request.taskId);
    }
  };
  const retainCreatedOrUncertainFailure = (error) => {
    if (!(
      error
      && typeof error === "object"
      && (typeof error.threadId === "string" || error.uncertain === true)
    )) {
      clearSettledOperation();
      return;
    }
    const timer = setTimeout(() => {
      clearSettledOperation();
    }, taskConversationFailureTtlMs);
    timer.unref?.();
  };
  void promise.then(clearSettledOperation, retainCreatedOrUncertainFailure);
  return promise;
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.postMessage({
      type: ${JSON.stringify(hostResponseMessage)},
      capability: ${JSON.stringify(hostCapability)},
      response: ${JSON.stringify(response)}
    }, window.location.origin)`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

function installTaskboardHostBinding(
  cdp,
  supervisor,
  startupToken,
  onCodexAppServerNotification,
  onCodexAppServerReady,
) {
  let activeContextId = null;
  let installInFlight = null;

  cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.executionContextId !== activeContextId) return;
    if (params.name === codexNotificationBindingName) {
      try {
        const notification = JSON.parse(params.payload);
        if (
          notification
          && typeof notification.hostId === "string"
          && typeof notification.method === "string"
        ) onCodexAppServerNotification(cdp, notification);
      } catch {}
      return;
    }
    if (params.name !== hostBindingName) return;
    await handleHostBindingPayload(params, {
      isAuthorizedContext: (executionContextId) => executionContextId === activeContextId,
      parseAutomationRequest: parseTaskboardAutomationHostRequest,
      ensure: () => supervisor.ensure({ force: true }),
      loadFrame: (request) => loadTaskboardFrameViaCdp(
        cdp,
        request.frameName,
        request.frameCapability,
      ),
      openExternal: openExternalUrl,
      openAttachment,
      runAutomation: (request) => (
        (async () => {
          const rpc = (method, body) => requestCodexAutomationViaCdp(
            cdp,
            undefined,
            method,
            body,
          );
          if (request.operation === "list") {
            const stored = await reconcileStoredAutomationPolicy(
              request,
              rpc,
            );
            return stored ?? (
              request.codexProjectKind === "remote"
                ? { items: [] }
                : reconcileTaskboardAutomation(request, rpc)
            );
          }
          return request.operation === "apply-policy"
            ? updateAndApplyQuotaPolicy(request, rpc)
            : reconcileTaskboardAutomation(request, rpc);
        })()
      ),
      startConversation: (request) => (
        getOrStartTaskConversation(cdp, undefined, request)
      ),
      sendResponse: (executionContextId, response) => (
        sendHostResponse(cdp, executionContextId, response)
      ),
    });
  });

  async function install() {
    if (installInFlight) return installInFlight;
    installInFlight = (async () => {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const isolatedWorld = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "codex-taskboard-host",
      });
      activeContextId = isolatedWorld.executionContextId;
      await cdp.send("Runtime.addBinding", {
        name: hostBindingName,
        executionContextId: activeContextId,
      });
      await cdp.send("Runtime.addBinding", {
        name: codexNotificationBindingName,
        executionContextId: activeContextId,
      });
      await cdp.send("Runtime.evaluate", {
        contextId: activeContextId,
        expression: `(() => {
          const capability = ${JSON.stringify(hostCapability)};
          if (globalThis.__codexTaskboardIsolatedBridgeV1 === capability) return;
          globalThis.__codexTaskboardIsolatedBridgeV1 = capability;
          window.addEventListener("message", (event) => {
            const message = event.data;
            if (
              !message
              || typeof message !== "object"
            ) return;
            if (
              message.type === "mcp-notification"
              && typeof message.hostId === "string"
              && typeof message.method === "string"
            ) {
              globalThis[${JSON.stringify(codexNotificationBindingName)}](JSON.stringify({
                hostId: message.hostId,
                method: message.method,
                params: message.params
              }));
              return;
            }
            if (
              event.source !== window
              || event.origin !== window.location.origin
              || message.type !== ${JSON.stringify(hostRequestMessage)}
              || message.capability !== capability
            ) return;
            globalThis[${JSON.stringify(hostBindingName)}](JSON.stringify(message.payload));
          });
        })()`,
        returnByValue: true,
      });
      onCodexAppServerReady(cdp);
      await restoreQuotaPolicies(cdp);
      return activeContextId;
    })();
    try {
      return await installInFlight;
    } finally {
      installInFlight = null;
    }
  }

  async function publishHeartbeat() {
    let timeout;
    try {
      await Promise.race([
        (async () => {
          const executionContextId = await install();
          await cdp.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: `window.postMessage({
              type: ${JSON.stringify(hostHeartbeatMessage)},
              capability: ${JSON.stringify(hostCapability)},
              at: Date.now(),
              startupToken: ${JSON.stringify(startupToken)}
            }, window.location.origin)`,
            returnByValue: true,
          });
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            cdp.close();
            reject(new Error("Timed out publishing the Taskboard host heartbeat"));
          }, 3_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { install, publishHeartbeat };
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: document.getElementById("codex-taskboard-page")?.hidden === false,
      frameReady: window.__codexTaskboardInjection__?.ready === true,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

async function waitForInjectionStatus(cdp, shouldOpen, expectedSourceHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && (
      status.sourceHash !== expectedSourceHash
      || !status.entryMounted
      || (shouldOpen && (!status.pageVisible || !status.frameUrl || !status.frameReady))
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await readInjectionStatus(cdp);
  }
  return status;
}

async function evaluateInjectionSource(cdp, source) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description || "Taskboard injection failed",
    );
  }
}

async function publishInjectionScriptIdentifier(cdp, scriptIdentifier) {
  await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(injectionScriptIdentifierName)}] = ${JSON.stringify(scriptIdentifier)}`,
    returnByValue: true,
  });
}

async function registerInjectionSource(cdp, source) {
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${source}\n//# sourceURL=codex-taskboard.user.js`,
  });
  return registration.identifier;
}

async function injectTarget(
  runtime,
  target,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
  onCodexAppServerNotification,
  onCodexAppServerReady,
  onCodexAppServerUnavailable,
) {
  const cdp = await runtime.connect(target);
  let retained = false;
  const hostBridge = keepAlive
    ? installTaskboardHostBinding(
        cdp,
        supervisor,
        startupToken,
        onCodexAppServerNotification,
        onCodexAppServerReady,
      )
    : null;
  cdp.hostBridge = hostBridge;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    if (keepAlive) await hostBridge.install();
    if (keepAlive && attachExisting) {
      const currentStatus = await readInjectionStatus(cdp);
      const reconciled = await reconcileInjectionRuntime({
        currentStatus,
        source,
        sourceHash,
        removeRegisteredSource: (identifier) => cdp.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
        ),
        registerCurrentSource: (currentSource) => registerInjectionSource(cdp, currentSource),
        evaluateCurrentSource: (currentSource) => evaluateInjectionSource(cdp, currentSource),
        publishRegistration: (identifier) => publishInjectionScriptIdentifier(cdp, identifier),
        reopen: () => cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        }),
      });
      cdp.on("Page.loadEventFired", async () => {
        await hostBridge.install();
        await publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier);
        await hostBridge.publishHeartbeat();
      });
      await hostBridge.publishHeartbeat();
      if (shouldOpen && !reconciled.shouldRemainOpen) {
        await cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        });
      }
      const shouldRemainOpen = shouldOpen || reconciled.shouldRemainOpen;
      const status = await waitForInjectionStatus(
        cdp,
        shouldRemainOpen,
        sourceHash,
        15_000,
      );
      const frameLoaded = status.frameUrl
        ? await waitForFrame(cdp, status.frameUrl, 15_000)
        : false;
      if (shouldRemainOpen && (!status.frameReady || !frameLoaded)) {
        throw new Error("Taskboard frame did not report ready in the Codex renderer");
      }
      retained = true;
      return {
        result: { ...status, cspBypassed: true, frameLoaded },
        connection: cdp,
      };
    }
    const scriptIdentifier = await registerInjectionSource(cdp, source);
    cdp.on("Page.loadEventFired", async () => {
      if (keepAlive) await hostBridge.install();
      await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
      if (keepAlive) await hostBridge.publishHeartbeat();
    });
    await evaluateInjectionSource(cdp, source);
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    if (keepAlive) await hostBridge.publishHeartbeat();
    if (shouldOpen) {
      await waitForInjectionStatus(cdp, false, sourceHash, 60_000);
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          taskboard?.close();
          taskboard?.open();
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = await waitForInjectionStatus(cdp, shouldOpen, sourceHash, 15_000);
    const frameLoaded = status.frameUrl
      ? await waitForFrame(cdp, status.frameUrl, 15_000)
      : false;
    if (shouldOpen && (!status.frameReady || !frameLoaded)) {
      throw new Error("Taskboard frame did not report ready in the Codex renderer");
    }
    const result = {
      ...status,
      cspBypassed: true,
      frameLoaded,
    };
    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }
    retained = keepAlive;
    return { result, connection: retained ? cdp : null };
  } finally {
    if (!retained) {
      onCodexAppServerUnavailable(cdp);
      unregisterQuotaPolicyCdp(cdp);
      cdp.close();
    }
  }
}

async function injectAll(
  runtime,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
  onCodexAppServerNotification,
  onCodexAppServerReady,
  onCodexAppServerUnavailable,
) {
  const targets = await runtime.targets();
  if (targets.length === 0) {
    if (keepAlive) return [];
    throw new Error("No Codex renderer target found");
  }

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      onCodexAppServerUnavailable(connection);
      unregisterQuotaPolicyCdp(connection);
      connection.close();
      injectedTargets.delete(id);
    }
  }

  const results = [];
  for (const target of targets) {
    if (injectedTargets.has(target.id)) continue;
    const firstTarget = injectedTargets.size === 0 && results.length === 0;
    const { result, connection } = await injectTarget(
      runtime,
      target,
      source,
      sourceHash,
      shouldOpen && firstTarget,
      firstTarget ? screenshotPath : null,
      keepAlive,
      supervisor,
      attachExisting,
      startupToken,
      onCodexAppServerNotification,
      onCodexAppServerReady,
      onCodexAppServerUnavailable,
    );
    if (connection) injectedTargets.set(target.id, connection);
    results.push({ targetId: target.id, title: target.title, url: target.url, ...result });
  }
  return results;
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
window.__CODEX_TASKBOARD_HOST_CAPABILITY__ = ${JSON.stringify(hostCapability)};
window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
${userScript}`;
  const sourceHash = createHash("sha256").update(runtimeSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};
${runtimeSource}`,
  };
}

async function resolveRunnableCodexExecutable(appPath) {
  const executable = resolveCodexExecutable({ appPath });
  if (process.platform !== "win32" || !executable.toLowerCase().includes("\\windowsapps\\")) {
    return executable;
  }

  const source = await stat(executable);
  const cacheDirectory = path.join(taskboardDataDirectory, "codex-runtime");
  const cachedExecutable = path.join(cacheDirectory, "codex.exe");
  try {
    const cached = await stat(cachedExecutable);
    if (cached.size === source.size && cached.mtimeMs === source.mtimeMs) {
      return cachedExecutable;
    }
  } catch {}

  await mkdir(cacheDirectory, { recursive: true });
  await pipeline(createReadStream(executable), createWriteStream(cachedExecutable));
  await utimes(cachedExecutable, source.atime, source.mtime);
  return cachedExecutable;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.startupToken ??= taskboardInstanceToken;
  process.env.CODEX_EXECUTABLE = await resolveRunnableCodexExecutable(options.appPath);
  const cdpVersionUrl = `http://127.0.0.1:${options.port}/json/version`;

  if (options.daemon) {
    let port = options.port;
    if (!options.portExplicit) {
      const candidates = codexDebuggingPorts(options.port);
      const activePort = await Promise.any(candidates.map(async (candidate) => {
        if (!(await isReachable(`http://127.0.0.1:${candidate}/json/version`))) {
          throw new Error("unreachable");
        }
        if ((await codexTargets(candidate)).length === 0) throw new Error("not Codex");
        return candidate;
      })).catch(() => null);
      if (!activePort) throw new Error("No debuggable Codex window found");
      port = activePort;
    }
    console.log(JSON.stringify({ launcher: startResidentInjector(port, options.open), port }, null, 2));
    return;
  }

  if (options.refresh || options.refreshIfRunning) {
    const ports = options.portExplicit
      ? [options.port]
      : codexDebuggingPorts(options.port);
    const refreshed = [];
    for (const port of ports) {
      if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
      if (options.refreshIfRunning) await restartResidentInjectorForRefresh(port);
      const results = await refreshTaskboardFrames(port);
      refreshed.push(...results.map((result) => ({ port, ...result })));
    }
    if (refreshed.length === 0) {
      if (options.refreshIfRunning) {
        console.log(JSON.stringify({ refreshed: [], skipped: "No debuggable Codex window is running" }));
        return;
      }
      throw new Error(`No debuggable Codex window found on ports: ${ports.join(", ")}`);
    }
    console.log(JSON.stringify({ refreshed }, null, 2));
    return;
  }

  let codexProcess = null;
  let managedCodex = null;
  let pendingCodexLaunch = null;
  let cdpRuntime = null;
  let codexAppPid = null;
  let nativeCodexBrowser = false;
  let runtimePublishPromise = null;
  const injectedTargets = new Map();
  const remoteCodexConnections = new Map();
  const routableCodexConnections = new Set();
  const codexRendererWaiters = new Set();
  const waitForCodexRenderer = () => new Promise((resolve) => {
    codexRendererWaiters.add(resolve);
  });
  const wakeCodexRendererRequests = () => {
    for (const resolve of codexRendererWaiters) resolve();
    codexRendererWaiters.clear();
  };
  const registerRoutableCodexConnection = (connection) => {
    routableCodexConnections.add(connection);
    wakeCodexRendererRequests();
  };
  const unregisterRoutableCodexConnection = (connection) => {
    routableCodexConnections.delete(connection);
    for (const [hostId, current] of remoteCodexConnections) {
      if (current === connection) remoteCodexConnections.delete(hostId);
    }
  };
  let taskboardChild = null;
  let idleAfterNormalExit = false;
  let openRequestGeneration = options.open ? 1 : 0;
  let openedRequestGeneration = 0;
  const hasOpenPending = () => openedRequestGeneration < openRequestGeneration;
  const queueTaskboardOpen = () => {
    openRequestGeneration += 1;
    console.log(JSON.stringify({ openTaskboardSignalQueued: true }));
  };
  let openControl = null;
  const requestTaskboardOpen = async () => {
    const generation = openRequestGeneration;
    if (generation <= openedRequestGeneration) return true;
    const connection = injectedTargets.values().next().value;
    if (!nativeCodexBrowser && !connection) return false;
    try {
      if (nativeCodexBrowser) {
        const deepLink = new URL("codex://threads/new");
        deepLink.searchParams.set("browserUrl", taskboardPageUrl);
        await new Promise((resolve, reject) => {
          const child = spawn("/usr/bin/open", [deepLink.toString()], {
            env: withoutTaskboardLauncherEnvironment(process.env),
            stdio: "ignore",
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`LaunchServices could not open Taskboard (${code})`));
          });
        });
        openedRequestGeneration = Math.max(openedRequestGeneration, generation);
        console.log(JSON.stringify({ openedTaskboardInExistingCodex: true }));
        return true;
      }
      const evaluation = await connection.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.open !== "function") return false;
          taskboard.open();
          return true;
        })()`,
        returnByValue: true,
      });
      if (evaluation.result.value !== true) {
        throw new Error("Taskboard injection is not ready");
      }
      await connection.send("Page.bringToFront");
      activateCodexApp(codexAppPid);
      openedRequestGeneration = Math.max(openedRequestGeneration, generation);
      return true;
    } catch (error) {
      console.error(`Waiting to open Taskboard: ${error.message}`);
      return false;
    }
  };
  let stopping = false;
  let wakeStop;
  const stopRequested = new Promise((resolve) => {
    wakeStop = resolve;
  });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    wakeCodexRendererRequests();
    wakeStop();
    cleanup().catch((error) => {
      console.error(`Cleanup failed: ${error.message}`);
    });
  };
  if (options.watch) {
    if (process.platform === "win32") {
      openControl = createInterface({ input: process.stdin, terminal: false });
      openControl.on("line", (line) => {
        if (line.trim() === "open") queueTaskboardOpen();
        else if (line.trim() === "stop") requestStop();
      });
    } else {
      process.on("SIGUSR2", queueTaskboardOpen);
    }
    console.log(JSON.stringify({ openTaskboardSignalReady: true }));
  }
  const detached = !options.watch;
  const codexConnectionForHost = async (hostId) => {
    while (!stopping) {
      for (const connection of routableCodexConnections) {
        if (connection.closed) routableCodexConnections.delete(connection);
      }
      const current = remoteCodexConnections.get(hostId);
      if (current && routableCodexConnections.has(current)) {
        return current;
      }
      const connection = routableCodexConnections.values().next().value;
      if (connection) {
        remoteCodexConnections.set(hostId, connection);
        return connection;
      }
      await waitForCodexRenderer();
    }
    throw new Error("Codex renderer stopped before the remote request was sent");
  };
  const handleCodexAppServerRequest = async (message) => {
    if (
      typeof message.requestId !== "string"
      || typeof message.hostId !== "string"
      || typeof message.method !== "string"
    ) throw new Error("Invalid Codex host request");
    const connection = await codexConnectionForHost(message.hostId);
    return requestCodexAppServerViaCdp(
      connection,
      undefined,
      message.hostId,
      message.method,
      message.params,
    );
  };
  const forwardCodexAppServerNotification = (cdp, notification) => {
    handleRemoteAutomationDecisionNotification(notification);
    if (remoteCodexConnections.get(notification.hostId) !== cdp) return;
    if (!taskboardChild?.connected) return;
    taskboardChild.send({
      type: "taskboard:codex-app-server-notification",
      hostId: notification.hostId,
      method: notification.method,
      params: notification.params,
    });
  };
  const supervisor = createTaskboardSupervisor({
    detached,
    isReachable: isTaskboardReachable,
    waitUntilReachable: waitUntilTaskboardReachable,
    start: () => {
      const child = startTaskboard({
        detached,
        onCodexAppServerRequest: handleCodexAppServerRequest,
      });
      taskboardChild = child;
      child.once("exit", () => {
        if (taskboardChild === child) taskboardChild = null;
      });
      return child;
    },
    onProcessError: (error) => {
      console.error(`Taskboard process error: ${error.message}`);
    },
    onUnexpectedExit: (code, signal) => {
      console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
    },
  });

  const publishRuntime = async () => {
    const pending = publishTaskboardRuntime();
    runtimePublishPromise = pending;
    try {
      await pending;
    } finally {
      if (runtimePublishPromise === pending) runtimePublishPromise = null;
    }
  };

  const startManagedCodex = async () => {
    if (stopping) return false;
    if (!options.cdpPipe) {
      const runningCodex = codexAppProcesses(options.appPath);
      let debuggingCodexFound = false;
      for (const record of runningCodex) {
        const port = codexProcessDebuggingPort(record);
        if (!port) continue;
        debuggingCodexFound = true;
        if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
        try {
          if ((await codexTargets(port)).length === 0) continue;
        } catch {
          continue;
        }
        cdpRuntime = tcpCdpRuntime(port);
        codexAppPid = record.pid;
        options.attachExisting = true;
        console.log(JSON.stringify({ reusedCodexPid: record.pid, cdpPort: port }));
        return true;
      }
      if (runningCodex.length > 0) {
        if (debuggingCodexFound) return false;
        nativeCodexBrowser = true;
        return false;
      }
    }
    if (options.launch) {
      await importCodexBrowserProfile();
      if (stopping) return false;
    }
    if (options.cdpPipe) {
      const launchPromise = (async () => {
        const launched = await launchCodexWithPipe(options.appPath);
        codexProcess = launched.child;
        cdpRuntime = pipeCdpRuntime(launched.browser);
      })();
      pendingCodexLaunch = launchPromise;
      try {
        await launchPromise;
      } catch (error) {
        if (!stopping) throw error;
      } finally {
        if (pendingCodexLaunch === launchPromise) pendingCodexLaunch = null;
      }
      return true;
    }
    const launchPromise = launchCodexWithLaunchServices(
      options.appPath,
      options.port,
      () => stopping,
    );
    pendingCodexLaunch = launchPromise;
    try {
      managedCodex = await launchPromise;
      codexAppPid = managedCodex.pid;
    } catch (error) {
      if (!stopping) throw error;
    } finally {
      if (pendingCodexLaunch === launchPromise) pendingCodexLaunch = null;
    }
    if (stopping) return false;
    try {
      await waitUntilReachable(cdpVersionUrl, 30_000, () => stopping);
    } catch (error) {
      if (stopping) return false;
      throw error;
    }
    if (!stopping) cdpRuntime = tcpCdpRuntime(options.port);
    return !stopping;
  };

  let cleanupPromise = null;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      injectedTargets.forEach((connection) => {
        unregisterRoutableCodexConnection(connection);
        unregisterQuotaPolicyCdp(connection);
        connection.close();
      });
      injectedTargets.clear();
      cdpRuntime?.close();
      cdpRuntime = null;
      const supervisorCleanupPromise = supervisor.stop();
      const runtimeCleanupPromise = (async () => {
        const pendingRuntimePublish = runtimePublishPromise;
        if (pendingRuntimePublish) {
          try {
            await pendingRuntimePublish;
          } catch (_) {}
        }
        await removeTaskboardRuntime();
      })();
      supervisorCleanupPromise.catch(() => {});
      runtimeCleanupPromise.catch(() => {});
      const launchPromise = pendingCodexLaunch;
      if (launchPromise) {
        try {
          await launchPromise;
        } catch (_) {}
        cdpRuntime?.close();
        cdpRuntime = null;
      }
      const launchedCodex = codexProcess;
      let launchedManagedCodex = managedCodex;
      if (!launchedManagedCodex && !options.cdpPipe) {
        const discovered = managedCodexProcess(options.appPath);
        if (discovered && managedCodexUsesPort(discovered, options.port)) {
          launchedManagedCodex = discovered;
        }
      }
      codexProcess = null;
      managedCodex = null;
      if (launchedManagedCodex) await stopManagedCodex(launchedManagedCodex);
      if (
        launchedCodex
        && launchedCodex.exitCode === null
        && launchedCodex.signalCode === null
      ) {
        const codexExitPromise = new Promise((resolve) => {
          launchedCodex.once("exit", () => resolve(true));
        });
        launchedCodex.kill("SIGTERM");
        const codexExited = await Promise.race([
          codexExitPromise,
          new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        if (!codexExited && launchedCodex.exitCode === null) {
          launchedCodex.kill("SIGKILL");
          await Promise.race([
            codexExitPromise,
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
      }
      await Promise.all([supervisorCleanupPromise, runtimeCleanupPromise]);
    })();
    return cleanupPromise;
  };
  if (options.watch) {
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
  }
  try {
    if (stopping) return;
    let cdpReachable = false;
    if (!options.cdpPipe) {
      cdpReachable = await isReachable(cdpVersionUrl);
      if (!cdpReachable && options.watch && !options.launch) {
        await waitUntilReachable(cdpVersionUrl, 60_000);
        cdpReachable = true;
      }
      if (!cdpReachable && !options.launch) {
        throw new Error(`Codex CDP is not listening on 127.0.0.1:${options.port}`);
      }
    }
    if (stopping) return;

    await supervisor.ensure({ force: true });
    if (stopping) return;
    await publishRuntime();
    if (stopping) return;

    if (options.cdpPipe || !cdpReachable) {
      idleAfterNormalExit = !(await startManagedCodex()) && !nativeCodexBrowser;
    } else {
      if (options.launch) {
        const runningCodex = codexAppProcesses(options.appPath)
          .find((record) => codexProcessDebuggingPort(record) === options.port);
        if (!runningCodex || (await codexTargets(options.port)).length === 0) {
          throw new Error(`Codex CDP port ${options.port} belongs to another process`);
        }
        managedCodex = managedCodexProcesses(options.appPath)
          .find((record) => record.pid === runningCodex.pid) ?? null;
        codexAppPid = runningCodex.pid;
        if (!managedCodex) {
          options.attachExisting = true;
          console.log(JSON.stringify({ reusedCodexPid: runningCodex.pid, cdpPort: options.port }));
        }
      } else {
        codexAppPid = codexAppProcesses(options.appPath)
          .find((record) => codexProcessDebuggingPort(record) === options.port)?.pid ?? null;
      }
      cdpRuntime = tcpCdpRuntime(options.port);
    }
    if (stopping) return;

    const { source, sourceHash } = await currentInjectionSource();
    if (stopping) return;
    let firstResults = [];
    const firstOpenGeneration = openRequestGeneration;
    const shouldOpenFirstTarget = firstOpenGeneration > openedRequestGeneration;
    if (!idleAfterNormalExit && !nativeCodexBrowser) {
      try {
        firstResults = await injectAll(
          cdpRuntime,
          source,
          sourceHash,
          shouldOpenFirstTarget,
          options.screenshot,
          injectedTargets,
          options.watch,
          supervisor,
          options.attachExisting,
          options.startupToken,
          forwardCodexAppServerNotification,
          registerRoutableCodexConnection,
          unregisterRoutableCodexConnection,
        );
      } catch (error) {
        if (!options.watch) throw error;
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
    if (stopping) return;
    if (firstResults.length > 0) {
      if (shouldOpenFirstTarget) {
        openedRequestGeneration = Math.max(openedRequestGeneration, firstOpenGeneration);
        activateCodexApp(codexAppPid);
      }
      console.log(JSON.stringify({ injected: firstResults }, null, 2));
    }
    if (hasOpenPending()) {
      await requestTaskboardOpen();
    }
    if (!options.watch) {
      if (options.cdpPipe) codexProcess?.unref();
      return;
    }

    while (!stopping) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2_000)),
        stopRequested,
      ]);
      if (stopping) break;
      try {
        const service = await supervisor.ensure();
        if (service.restarted && !stopping) await publishRuntime();
      } catch (error) {
        console.error(`Waiting for Taskboard service: ${error.message}`);
      }
      if (stopping) break;
      for (const connection of injectedTargets.values()) {
        try {
          await connection.hostBridge?.publishHeartbeat();
        } catch (_) {}
      }
      if (nativeCodexBrowser) {
        if (codexAppProcesses(options.appPath).length === 0) {
          nativeCodexBrowser = false;
          idleAfterNormalExit = true;
          console.error(
            "Waiting for Codex after exit; open Codex Taskboard again to restart it.",
          );
          continue;
        }
        if (hasOpenPending()) await requestTaskboardOpen();
        continue;
      }
      if (idleAfterNormalExit) {
        if (!hasOpenPending()) continue;
        try {
          if (!(await startManagedCodex())) {
            if (nativeCodexBrowser) await requestTaskboardOpen();
            continue;
          }
          idleAfterNormalExit = false;
        } catch (restartError) {
          console.error(`Waiting to restart Codex: ${restartError.message}`);
          continue;
        }
      }
      try {
        const results = await injectAll(
          cdpRuntime,
          source,
          sourceHash,
          false,
          null,
          injectedTargets,
          true,
          supervisor,
          options.attachExisting,
          options.startupToken,
          forwardCodexAppServerNotification,
          registerRoutableCodexConnection,
          unregisterRoutableCodexConnection,
        );
        if (results.length > 0) {
          console.log(JSON.stringify({ injected: results }, null, 2));
        }
        if (hasOpenPending()) {
          await requestTaskboardOpen();
        }
      } catch (error) {
        if (stopping) break;
        if (options.cdpPipe && !cdpRuntime.isHealthy()) {
          const launchedCodex = codexProcess;
          if (
            launchedCodex
            && launchedCodex.exitCode === null
            && launchedCodex.signalCode === null
          ) {
            await Promise.race([
              new Promise((resolve) => launchedCodex.once("exit", resolve)),
              new Promise((resolve) => setTimeout(resolve, 250)),
            ]);
          }
          if (launchedCodex?.exitCode === 0) {
            injectedTargets.forEach((connection) => {
              unregisterRoutableCodexConnection(connection);
              unregisterQuotaPolicyCdp(connection);
              connection.close();
            });
            injectedTargets.clear();
            cdpRuntime.close();
            cdpRuntime = null;
            codexProcess = null;
            idleAfterNormalExit = true;
            console.error(
              "Waiting for Codex after normal exit; open Codex Taskboard again to restart it.",
            );
            continue;
          }
          if (
            !launchedCodex
            || (launchedCodex.exitCode === null && launchedCodex.signalCode === null)
          ) {
            throw error;
          }
        }
        const launchedCodexExited = options.cdpPipe
          ? codexProcess
            && (codexProcess.exitCode !== null || codexProcess.signalCode !== null)
          : codexAppPid && !codexAppProcesses(options.appPath)
            .some((record) => record.pid === codexAppPid);
        if (launchedCodexExited) {
          injectedTargets.forEach((connection) => {
            unregisterRoutableCodexConnection(connection);
            unregisterQuotaPolicyCdp(connection);
            connection.close();
          });
          injectedTargets.clear();
          cdpRuntime?.close();
          cdpRuntime = null;
          if (options.cdpPipe) {
            const exitCode = codexProcess.exitCode;
            codexProcess = null;
            if (exitCode === 0) {
              idleAfterNormalExit = true;
              console.error(
                "Waiting for Codex after normal exit; open Codex Taskboard again to restart it.",
              );
              continue;
            }
            console.error("Codex exited unexpectedly; restarting it for the taskboard launcher.");
            try {
              await startManagedCodex();
              if (options.open) openRequestGeneration += 1;
            } catch (restartError) {
              console.error(`Waiting to restart Codex: ${restartError.message}`);
            }
            continue;
          }
          managedCodex = null;
          codexAppPid = null;
          idleAfterNormalExit = true;
          console.error(
            "Waiting for Codex after exit; open Codex Taskboard again to restart it.",
          );
          continue;
        }
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
  } finally {
    if (options.watch) {
      process.removeListener("SIGINT", requestStop);
      process.removeListener("SIGTERM", requestStop);
      if (process.platform === "win32") openControl?.close();
      else process.removeListener("SIGUSR2", queueTaskboardOpen);
      await cleanup();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
