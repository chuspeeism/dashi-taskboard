#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import {
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
} from "../shared/taskboard-automation.mjs";
import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
  reloadPageAndWait,
  removeRegisteredPageScript,
  restartResidentInjector,
  shouldStopWatchingForMissingRenderer,
  waitForWebSocketOpen,
} from "./codex-injector-runtime.mjs";
import { readCodexQuotaStatus } from "./codex-rate-limits.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const defaultCodexDebuggingPort = 9229;
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const automationPoliciesPath = path.join(projectRoot, ".data", "codex-automation-policies.json");
const taskboardOrigin = `http://127.0.0.1:${resolvePort()}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const taskboardPageUrl = `${taskboardOrigin}/?host=codex`;
const hostBindingName = "__codexTaskboardHostV1";
const hostHeartbeatName = "__codexTaskboardHostHeartbeatV1";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV1";
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const cdpConnectionTimeoutMs = 3_000;
const cdpCommandTimeoutMs = 10_000;
const rendererRecoveryGraceMs = 10_000;
const codexAutomationMethods = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);
let codexAutomationRequestSequence = 0;
const quotaPolicyTimers = new Map();
const quotaPolicyRecords = new Map();
const quotaPolicyQueues = new Map();
let quotaPoliciesLoadPromise = null;
let quotaPoliciesWritePromise = Promise.resolve();
let quotaPoliciesRestored = false;

function parseArgs(argv) {
  const options = {
    port: defaultCodexDebuggingPort,
    portExplicit: false,
    launch: false,
    watch: false,
    open: false,
    refresh: false,
    refreshIfRunning: false,
    attachExisting: false,
    managedTaskboard: false,
    startupToken: null,
    daemon: false,
    screenshot: null,
    appPath: "/Applications/ChatGPT.app",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--managed-taskboard") options.managedTaskboard = true;
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

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
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

async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startTaskboard({ detached }) {
  return spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    stdio: detached ? "ignore" : "inherit",
  });
}

function createTaskboardSupervisor({ detached, managed }) {
  let child = null;
  let ensureInFlight = null;
  let retryAfter = 0;
  let stopping = false;

  async function ensure({ force = false } = {}) {
    if (await isReachable(taskboardHealthUrl)) {
      return { status: "ok", restarted: false };
    }
    if (ensureInFlight) return ensureInFlight;
    if (!force && Date.now() < retryAfter) {
      throw new Error("Taskboard restart is waiting before its next attempt");
    }

    ensureInFlight = (async () => {
      if (managed) {
        await waitUntilReachable(taskboardHealthUrl, 10_000);
        return { status: "ok", restarted: false };
      }
      if (child?.exitCode === null && !child.killed) {
        try {
          await waitUntilReachable(taskboardHealthUrl, 3_000);
          return { status: "ok", restarted: false };
        } catch (_) {}
      }

      const started = startTaskboard({ detached });
      child = started;
      if (detached) started.unref();
      started.once("error", (error) => {
        if (!stopping) console.error(`Taskboard process error: ${error.message}`);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && !detached && code !== 0) {
          console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
        }
      });

      try {
        await waitUntilReachable(taskboardHealthUrl, 10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true };
      } catch (error) {
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  function stop() {
    stopping = true;
    if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  return { ensure, stop };
}

export function codexLaunchArguments(
  appPath,
  port,
  userDataPath = process.env.CODEX_TASKBOARD_CODEX_USER_DATA_PATH,
) {
  const args = [
    "-W",
    "-n",
  ];
  if (userDataPath) {
    args.push("--env", `CODEX_ELECTRON_USER_DATA_PATH=${userDataPath}`);
  }
  args.push(
    "-a",
    appPath,
    "--args",
    ...(userDataPath ? [`--user-data-dir=${userDataPath}`] : []),
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  );
  return args;
}

function launchCodex(appPath, port) {
  return spawn(
    "/usr/bin/open",
    codexLaunchArguments(appPath, port),
    { stdio: "ignore" },
  );
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
    try {
      await waitForWebSocketOpen(this.socket, cdpConnectionTimeoutMs);
    } catch (error) {
      this.closed = true;
      try {
        this.socket.close();
      } catch {}
      throw error;
    }
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
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => {
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP WebSocket closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.closed = true;
        try {
          this.socket.close();
        } catch {}
        reject(new Error(`Timed out waiting for CDP command ${method}`));
      }, cdpCommandTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitFor(method, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("CDP WebSocket closed"));
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      let timeout = null;
      const cleanup = (waiter) => {
        clearTimeout(timeout);
        const remaining = (this.eventWaiters.get(method) || [])
          .filter((candidate) => candidate !== waiter);
        if (remaining.length > 0) this.eventWaiters.set(method, remaining);
        else this.eventWaiters.delete(method);
      };
      const waiter = {
        resolve: (value) => {
          cleanup(waiter);
          resolve(value);
        },
        reject: (error) => {
          cleanup(waiter);
          reject(error);
        },
      };
      timeout = setTimeout(
        () => waiter.reject(new Error(`Timed out waiting for CDP event ${method}`)),
        timeoutMs,
      );
      waiters.push(waiter);
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
    try {
      this.socket.close();
    } catch {}
  }
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
      !target.url?.includes("initialRoute=%2Favatar-overlay") &&
      target.url?.startsWith("app://"),
  );
}

async function waitForInitialInjection(runInjection, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const results = await runInjection();
      if (results.length > 0) return results;
      lastError = new Error("No Codex renderer accepted the Taskboard injection");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const detail = lastError ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for a stable Codex renderer${detail}`);
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
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

function orphanedCodexAppServerPids() {
  const processes = spawnSync("/bin/ps", ["-x", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [];

  const appServerPath = /(?:^|\s)\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/codex(?=\s|$)/;
  const orphaned = [];
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== 1) continue;
    const command = match[3];
    if (
      appServerPath.test(command)
      && /(?:^|\s)-c\s+features\.code_mode_host=true(?=\s|$)/.test(command)
      && /(?:^|\s)app-server(?=\s|$)/.test(command)
      && /(?:^|\s)--analytics-default-enabled(?=\s|$)/.test(command)
    ) {
      orphaned.push(Number(match[1]));
    }
  }
  return orphaned;
}

async function stopOrphanedCodexAppServers() {
  const orphaned = new Set(orphanedCodexAppServerPids());
  if (orphaned.size === 0) return [];

  for (const pid of orphaned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code === "ESRCH") orphaned.delete(pid);
      else throw error;
    }
  }

  const deadline = Date.now() + 5_000;
  while (orphaned.size > 0 && Date.now() < deadline) {
    for (const pid of orphaned) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") orphaned.delete(pid);
        else throw error;
      }
    }
    if (orphaned.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (orphaned.size > 0) {
    throw new Error(`Timed out stopping orphaned Codex app-server pids: ${[...orphaned].join(", ")}`);
  }
  return [...orphaned];
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
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function residentInjectorPids(port) {
  const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
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
  managedTaskboard = false,
) {
  const [existingPid] = residentInjectorPids(port);
  if (existingPid) return { pid: existingPid, started: false };
  const args = [injectorPath, "--watch", "--port", String(port)];
  if (shouldOpen) args.push("--open");
  if (attachExisting) args.push("--attach-existing");
  if (managedTaskboard) args.push("--managed-taskboard");
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
              hostBindingReady: typeof window[${JSON.stringify(hostBindingName)}] === "function",
              heartbeatAge: Date.now() - Number(window[${JSON.stringify(hostHeartbeatName)}] || 0),
              taskboardEntryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
              sourceHash: window.__codexTaskboardInjection__?.sourceHash || null
            })`,
            returnByValue: true,
          });
          if (
            readiness.result.value?.token === startupToken
            && readiness.result.value.hostBindingReady
            && readiness.result.value.heartbeatAge <= 8_000
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
  const managedTaskboard = residentInjectorPids(port).some((pid) => {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    return result.status === 0 && /(?:^|\s)--managed-taskboard(?=\s|$)/.test(result.stdout);
  });
  return restartResidentInjector(port, {
    findResidents: residentInjectorPids,
    stopResident: stopResidentInjector,
    createStartupToken: randomUUID,
    startResident: (targetPort, startupToken) => (
      startResidentInjector(targetPort, false, true, startupToken, managedTaskboard)
    ),
    waitUntilReady: (targetPort, pid, startupToken) => (
      waitForResidentInjectorReady(targetPort, pid, startupToken, sourceHash)
    ),
  });
}

export function decideRefreshTaskboardPass({
  currentTargets,
  successfulResults,
  attemptedTargets,
  failures,
}) {
  const currentIds = new Set(currentTargets.map((target) => target.id));
  for (const targetId of successfulResults.keys()) {
    if (!currentIds.has(targetId)) successfulResults.delete(targetId);
  }
  const unresolvedTargets = currentTargets.filter(
    (target) => !successfulResults.has(target.id),
  );
  const focusedFailures = unresolvedTargets.filter(
    (target) => failures.get(target.id)?.focused === true,
  );
  if (focusedFailures.length > 0) {
    const details = focusedFailures.map(
      (target) => `${target.id}: ${failures.get(target.id).message}`,
    );
    return {
      action: "fail",
      message: `Taskboard open failed in the focused Codex renderer: ${details.join("; ")}`,
    };
  }

  const focusedSuccess = [...successfulResults.values()]
    .some((result) => result.focused === true);
  if (focusedSuccess) {
    return { action: "success", results: [...successfulResults.values()] };
  }

  const newTargets = unresolvedTargets.filter(
    (target) => !attemptedTargets.has(target.id),
  );
  if (newTargets.length > 0) return { action: "retry" };
  if (successfulResults.size > 0) {
    return { action: "success", results: [...successfulResults.values()] };
  }

  const persistentFailures = unresolvedTargets.filter(
    (target) => attemptedTargets.has(target.id),
  );
  if (persistentFailures.length > 0) {
    const details = persistentFailures.map(
      (target) => `${target.id}: ${failures.get(target.id)?.message || "Taskboard did not open"}`,
    );
    return {
      action: "fail",
      message: `Taskboard open failed in a live Codex renderer: ${details.join("; ")}`,
    };
  }
  return { action: "retry" };
}

async function refreshTaskboardFrames(port, shouldOpen = false) {
  async function refreshTarget(target, signal) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    const cancel = () => cdp.close();
    let focused = false;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error("Taskboard refresh was superseded");
      await cdp.open();
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      if (shouldOpen) await cdp.send("Page.bringToFront");
      const focusStatus = await cdp.send("Runtime.evaluate", {
        expression: "document.hasFocus()",
        returnByValue: true,
      });
      focused = focusStatus.result.value === true;
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (${shouldOpen ? "true" : "false"} && typeof taskboard?.open === "function") {
            taskboard.open();
            return { refreshed: false, opened: true, via: "injection" };
          }
          if (typeof taskboard?.reloadFrame === "function") {
            const refreshed = taskboard.reloadFrame();
            if (refreshed) return { refreshed: true, via: "injection" };
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
      const outcome = evaluation.result.value;
      let openStatus = null;
      if (shouldOpen) {
        if (!outcome?.opened) {
          throw new Error("Taskboard injection is not mounted in the Codex renderer");
        }
        const status = await waitForInjectionStatus(cdp, true, null, 15_000);
        if (!injectionStatusReady(status, true, null)) {
          throw new Error("Taskboard injection did not become ready in the Codex renderer");
        }
        openStatus = status;
      }
      return {
        targetId: target.id,
        title: target.title,
        url: target.url,
        focused,
        ...outcome,
        ...(openStatus || {}),
        ...(shouldOpen ? { frameLoaded: openStatus.frameReady === true } : {}),
      };
    } catch (error) {
      if (error && typeof error === "object") error.codexTargetFocused = focused;
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      cdp.close();
    }
  }

  const successfulResults = new Map();
  const attemptedTargets = new Set();
  const failures = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    const targets = (await codexTargets(port))
      .filter((target) => !successfulResults.has(target.id));
    targets.forEach((target) => attemptedTargets.add(target.id));
    const controller = new AbortController();
    const attempts = targets.map((target) => (
      refreshTarget(target, controller.signal).then(
        (value) => ({ status: "fulfilled", focused: value.focused === true, target, value }),
        (error) => ({
          status: "rejected",
          focused: error?.codexTargetFocused === true,
          target,
          message: error?.message || String(error),
        }),
      )
    ));
    const batch = shouldOpen
      ? await waitForFocusedRendererAttempt(attempts)
      : { action: "all-settled", outcomes: await Promise.all(attempts) };
    if (batch.action === "focused-success") {
      const currentTargets = await codexTargets(port);
      if (currentTargets.some((target) => target.id === batch.outcome.target.id)) {
        successfulResults.set(batch.outcome.target.id, batch.outcome.value);
        controller.abort();
        await Promise.all(attempts);
        return [...successfulResults.values()];
      }
    }
    const outcomes = batch.action === "all-settled"
      ? batch.outcomes
      : await Promise.all(attempts);
    outcomes.forEach((attempt) => {
      const { target } = attempt;
      if (attempt.status === "fulfilled") {
        successfulResults.set(target.id, attempt.value);
        failures.delete(target.id);
      } else {
        failures.set(target.id, {
          focused: attempt.focused,
          message: attempt.message,
        });
      }
    });

    const currentTargets = await codexTargets(port);
    const decision = decideRefreshTaskboardPass({
      currentTargets,
      successfulResults,
      attemptedTargets,
      failures,
    });
    if (decision.action === "success") return decision.results;
    if (decision.action === "fail") throw new Error(decision.message);
    if (pass < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Codex renderer kept changing before Taskboard could open");
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

async function applyTaskboardAutomationPolicy(request, rpc, stillCurrent = () => true) {
  const quota = request.quotaAware
    ? await readCodexQuotaStatus(request.model)
    : null;
  if (!stillCurrent()) return { quota, stale: true };
  const shouldRun = request.enabledByUser
    && (!request.quotaAware || quota?.state === "available");
  const result = await reconcileTaskboardAutomation(
    { ...request, operation: shouldRun ? "ensure-active" : "pause" },
    rpc,
  );
  if (result?.error === "not-found") {
    return { ...(quota ? { quota } : {}) };
  }
  return { ...result, ...(quota ? { quota } : {}) };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
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
  return parseTaskboardAutomationHostRequest({
    ...value,
    id: "restored-policy",
    action: "automation",
    requestId: "restored-policy",
    operation: "apply-policy",
  });
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
      const request = restoredAutomationPolicy(value);
      if (!request) continue;
      quotaPolicyRecords.set(request.taskboardProjectId, { version: 1, request });
    }
  })();
  return quotaPoliciesLoadPromise;
}

function persistQuotaPolicies() {
  const data = Object.fromEntries(
    [...quotaPolicyRecords.entries()].map(([projectId, record]) => [
      projectId,
      storedAutomationPolicy(record.request),
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

function scheduleQuotaPolicyCheck(record, cdp, result) {
  const { request, version } = record;
  const key = request.taskboardProjectId;
  const previous = quotaPolicyTimers.get(key);
  if (previous) clearTimeout(previous);
  quotaPolicyTimers.delete(key);
  if (!request.enabledByUser || !request.quotaAware) return;

  const nextRunAt = Number(result.item?.nextRunAt);
  const nextRunDelay = Number.isFinite(nextRunAt) && nextRunAt > Date.now()
    ? Math.max(1_000, nextRunAt - Date.now() - 15_000)
    : 60_000;
  const resetDelay = result.quota?.state === "blocked"
    && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  const timer = setTimeout(async () => {
    if (quotaPolicyRecords.get(key)?.version !== version) return;
    try {
      await enqueueCurrentQuotaPolicy(key, cdp);
    } catch (error) {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      const current = quotaPolicyRecords.get(key);
      if (current?.version === version) {
        scheduleQuotaPolicyCheck(current, cdp, { quota: { state: "unknown" } });
      }
    }
  }, Math.min(nextRunDelay, resetDelay));
  timer.unref();
  quotaPolicyTimers.set(key, timer);
}

function enqueueQuotaPolicyMutation(record, cdp, rpc) {
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
      );
      if (result.stale) return result;
      if (result.item?.id && quotaPolicyRecords.get(key)?.version === current.version) {
        current.request = { ...current.request, automationId: result.item.id };
        await persistQuotaPolicies();
      }
      scheduleQuotaPolicyCheck(current, cdp, result);
      return result;
    });
  const tracked = run.finally(() => {
    if (quotaPolicyQueues.get(key) === tracked) quotaPolicyQueues.delete(key);
  });
  quotaPolicyQueues.set(key, tracked);
  return tracked;
}

async function updateAndApplyQuotaPolicy(request, cdp, rpc) {
  await ensureQuotaPoliciesLoaded();
  const previous = quotaPolicyRecords.get(request.taskboardProjectId);
  const record = {
    version: (previous?.version ?? 0) + 1,
    request,
  };
  quotaPolicyRecords.set(request.taskboardProjectId, record);
  try {
    await persistQuotaPolicies();
    return await enqueueQuotaPolicyMutation(record, cdp, rpc);
  } catch (error) {
    if (quotaPolicyRecords.get(request.taskboardProjectId)?.version === record.version) {
      if (previous) quotaPolicyRecords.set(request.taskboardProjectId, previous);
      else quotaPolicyRecords.delete(request.taskboardProjectId);
      await persistQuotaPolicies();
    }
    throw error;
  }
}

async function readStoredAutomationPolicy(projectId) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  return record ? storedAutomationPolicy(record.request) : null;
}

async function enqueueCurrentQuotaPolicy(projectId, cdp) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return { stale: true };
  return enqueueQuotaPolicyMutation(
    record,
    cdp,
    (method, body) => requestCodexAutomationViaCdp(cdp, undefined, method, body),
  );
}

async function restoreQuotaPolicies(cdp) {
  if (quotaPoliciesRestored) return;
  quotaPoliciesRestored = true;
  await ensureQuotaPoliciesLoaded();
  for (const [projectId, record] of quotaPolicyRecords) {
    if (record.request.enabledByUser && record.request.quotaAware) {
      void enqueueCurrentQuotaPolicy(projectId, cdp).catch((error) => {
        console.error(`Taskboard quota policy restore failed: ${error.message}`);
      });
    }
  }
}

async function prefillTaskComposerViaCdp(cdp, executionContextId, request) {
  const {
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  } = request;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const mention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        if (mention && (editor.textContent || "").includes(instruction)) {
          return { ready: true, matches: true };
        }
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return { ready: true, matches: false };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (!prepared.result.value?.ready) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    if (prepared.result.value.matches) return { prefilled: true };

    await cdp.send("Input.insertText", { text: "$" });
    break;
  }

  let selectedSkill = false;
  while (Date.now() < deadline) {
    const selection = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const displayName = ${JSON.stringify(skillDisplayName)};
        const overlay = Array.from(document.querySelectorAll(
          '[data-composer-overlay-floating-ui="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!overlay) return { ready: false };
        const button = Array.from(overlay.querySelectorAll(
          'button[data-list-navigation-item="true"]'
        )).find((candidate) => Array.from(candidate.querySelectorAll("span"))
          .some((label) => (label.textContent || "").trim() === displayName));
        if (!button) return { ready: true, found: false };
        button.click();
        return { ready: true, found: true };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (selection.result.value?.found) {
      selectedSkill = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!selectedSkill) {
    throw new Error(`Timed out while selecting the ${skillDisplayName} Skill`);
  }

  let mentionReady = false;
  while (Date.now() < deadline) {
    const mention = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const selected = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => candidate.getAttribute("skill-mention-name") === skillName);
        return {
          ready: Boolean(selected),
          pathMatches: selected?.getAttribute("skill-mention-path") === skillPath,
        };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (mention.result.value?.ready) {
      if (!mention.result.value.pathMatches) {
        throw new Error(`Codex selected a different ${skillDisplayName} Skill`);
      }
      mentionReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!mentionReady) {
    throw new Error(`Timed out while creating the ${skillDisplayName} Skill mention`);
  }

  await cdp.send("Input.insertText", { text: instruction });
  while (Date.now() < deadline) {
    const verified = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const mention = editor && Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        return Boolean(mention && (editor.textContent || "").includes(instruction));
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (verified.result.value === true) return { prefilled: true };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out while writing the issue instruction into the Codex composer");
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.__codexTaskboardInjection__?.hostResponse(${JSON.stringify(response)})`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

async function installTaskboardHostBinding(cdp, supervisor) {
  cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.name !== hostBindingName) return;
    await handleHostBindingPayload(params, {
      parseAutomationRequest: parseTaskboardAutomationHostRequest,
      ensure: () => supervisor.ensure({ force: true }),
      runAutomation: (request, executionContextId) => (
        (async () => {
          const rpc = (method, body) => requestCodexAutomationViaCdp(
            cdp,
            executionContextId,
            method,
            body,
          );
          const result = request.operation === "apply-policy"
            ? await updateAndApplyQuotaPolicy(request, cdp, rpc)
            : await reconcileTaskboardAutomation(request, rpc);
          if (request.operation === "list") {
            const policy = await readStoredAutomationPolicy(request.taskboardProjectId);
            return { ...result, ...(policy ? { policy } : {}) };
          }
          return result;
        })()
      ),
      prefill: (request, executionContextId) => (
        prefillTaskComposerViaCdp(cdp, executionContextId, request)
      ),
      sendResponse: (executionContextId, response) => (
        sendHostResponse(cdp, executionContextId, response)
      ),
    });
  });
  await cdp.send("Runtime.addBinding", { name: hostBindingName });
}

async function publishHostHeartbeat(cdp, startupToken) {
  const heartbeat = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      window[${JSON.stringify(hostHeartbeatName)}] = Date.now();
      window[${JSON.stringify(hostStartupTokenName)}] = ${JSON.stringify(startupToken)};
      return typeof window[${JSON.stringify(hostBindingName)}] === "function";
    })()`,
    returnByValue: true,
  });
  if (heartbeat.result.value !== true) {
    throw new Error("Taskboard host binding is unavailable");
  }
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      hostBindingReady: typeof window[${JSON.stringify(hostBindingName)}] === "function",
      heartbeatAge: Date.now() - Number(window[${JSON.stringify(hostHeartbeatName)}] || 0),
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: document.getElementById("codex-taskboard-page")?.hidden === false,
      frameReady: window.__codexTaskboardInjection__?.frameReady === true,
      frameVisible: document.getElementById("codex-taskboard-frame")?.hidden === false,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

function injectionStatusReady(status, shouldOpen, expectedSourceHash) {
  return Boolean(
    (expectedSourceHash === null || status.sourceHash === expectedSourceHash)
    && status.entryMounted
    && (
      !shouldOpen
      || (
        status.hostBindingReady
        && status.heartbeatAge <= 8_000
        && status.pageVisible
        && status.frameReady
        && status.frameVisible
        && status.frameUrl
      )
    ),
  );
}

async function waitForInjectionStatus(
  cdp,
  shouldOpen,
  expectedSourceHash,
  timeoutMs,
  refreshReadiness = null,
) {
  const deadline = Date.now() + timeoutMs;
  let nextReadinessRefreshAt = Date.now() + 2_000;
  let nextOpenAttemptAt = Date.now();
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && !injectionStatusReady(status, shouldOpen, expectedSourceHash)
  ) {
    if (
      shouldOpen
      && !refreshReadiness
      && (!status.hostBindingReady || status.heartbeatAge > 8_000)
    ) return status;
    if (
      shouldOpen
      && status.entryMounted
      && !status.pageVisible
      && Date.now() >= nextOpenAttemptAt
    ) {
      await cdp.send("Runtime.evaluate", {
        expression: "window.__codexTaskboardInjection__?.open()",
        returnByValue: true,
      });
      nextOpenAttemptAt = Date.now() + 500;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (refreshReadiness && Date.now() >= nextReadinessRefreshAt) {
      await refreshReadiness();
      nextReadinessRefreshAt = Date.now() + 2_000;
    }
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
  target,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  let retained = false;
  let focused = false;
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    if (shouldOpen) {
      await cdp.send("Page.bringToFront");
      const focusStatus = await cdp.send("Runtime.evaluate", {
        expression: "document.hasFocus()",
        returnByValue: true,
      });
      focused = focusStatus.result.value === true;
    }
    if (keepAlive) await installTaskboardHostBinding(cdp, supervisor);
    if (keepAlive && attachExisting) {
      const previousStatus = await readInjectionStatus(cdp);
      await removeRegisteredPageScript(
        (identifier) => cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }),
        previousStatus.scriptIdentifier,
      );
      await reloadPageAndWait(cdp);
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
        forceOpen: shouldOpen,
      });
      cdp.on("Page.loadEventFired", () => (
        publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier)
      ));
      await publishHostHeartbeat(cdp, startupToken);
      const status = await waitForInjectionStatus(
        cdp,
        reconciled.shouldRemainOpen,
        sourceHash,
        15_000,
        () => publishHostHeartbeat(cdp, startupToken),
      );
      if (!injectionStatusReady(status, reconciled.shouldRemainOpen, sourceHash)) {
        throw new Error("Taskboard injection did not become ready in the Codex renderer");
      }
      const frameLoaded = status.frameReady === true;
      retained = true;
      return {
        result: { ...status, focused, cspBypassed: true, frameLoaded },
        connection: cdp,
      };
    }
    const previousStatus = await readInjectionStatus(cdp);
    await removeRegisteredPageScript(
      (identifier) => cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }),
      previousStatus.scriptIdentifier,
    );
    const scriptIdentifier = await registerInjectionSource(cdp, source);
    cdp.on("Page.loadEventFired", () => (
      publishInjectionScriptIdentifier(cdp, scriptIdentifier)
    ));
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    await reloadPageAndWait(cdp);
    await evaluateInjectionSource(cdp, source);
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    if (keepAlive) await publishHostHeartbeat(cdp, startupToken);
    if (shouldOpen) {
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          taskboard?.close();
          taskboard?.open();
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = await waitForInjectionStatus(
      cdp,
      shouldOpen,
      sourceHash,
      15_000,
      keepAlive ? () => publishHostHeartbeat(cdp, startupToken) : null,
    );
    if (!injectionStatusReady(status, shouldOpen, sourceHash)) {
      throw new Error("Taskboard injection did not become ready in the Codex renderer");
    }
    const frameLoaded = status.frameReady === true;
    const result = {
      ...status,
      focused,
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
  } catch (error) {
    if (error && typeof error === "object") error.codexTargetFocused = focused;
    throw error;
  } finally {
    if (!retained) cdp.close();
  }
}

export async function waitForFocusedRendererAttempt(attempts) {
  const pendingForever = new Promise(() => {});
  const focusedSuccess = Promise.race(attempts.map((attempt) => (
    Promise.resolve(attempt).then(
      (outcome) => (
        outcome.status === "fulfilled" && outcome.focused
          ? { action: "focused-success", outcome }
          : pendingForever
      ),
      () => pendingForever,
    )
  )));
  const allSettled = Promise.all(attempts).then((outcomes) => ({
    action: "all-settled",
    outcomes,
  }));
  return Promise.race([focusedSuccess, allSettled]);
}

async function injectAll(
  port,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  injectionAttempts,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const targets = await codexTargets(port);
  if (targets.length === 0) throw new Error("No Codex renderer target found");

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      connection.close();
      injectedTargets.delete(id);
    }
  }

  const hadInjectedTargets = injectedTargets.size > 0;
  const screenshotTargetId = targets.find(
    (target) => !injectedTargets.has(target.id) && !injectionAttempts.has(target.id),
  )?.id;
  for (const target of targets) {
    if (injectedTargets.has(target.id) || injectionAttempts.has(target.id)) continue;
    let attempt;
    attempt = (async () => {
      try {
        const { result, connection } = await injectTarget(
          target,
          source,
          sourceHash,
          shouldOpen,
          target.id === screenshotTargetId ? screenshotPath : null,
          keepAlive,
          supervisor,
          attachExisting,
          startupToken,
        );
        if (connection) injectedTargets.set(target.id, connection);
        return {
          status: "fulfilled",
          focused: result.focused === true,
          value: { targetId: target.id, title: target.title, url: target.url, ...result },
        };
      } catch (error) {
        return {
          status: "rejected",
          focused: error?.codexTargetFocused === true,
          targetId: target.id,
          message: error?.message || String(error),
        };
      }
    })().finally(() => {
      if (injectionAttempts.get(target.id) === attempt) injectionAttempts.delete(target.id);
    });
    injectionAttempts.set(target.id, attempt);
  }

  if (hadInjectedTargets) return [];
  const attempts = targets
    .map((target) => injectionAttempts.get(target.id))
    .filter(Boolean);
  if (attempts.length === 0) return [];
  const decision = screenshotPath
    ? { action: "all-settled", outcomes: await Promise.all(attempts) }
    : await waitForFocusedRendererAttempt(attempts);
  if (decision.action === "focused-success") return [decision.outcome.value];

  const focusedFailure = decision.outcomes.find(
    (outcome) => outcome.status === "rejected" && outcome.focused,
  );
  if (focusedFailure) {
    throw new Error(
      `Taskboard injection failed in the focused Codex renderer: ${focusedFailure.targetId}: ${focusedFailure.message}`,
    );
  }
  const results = decision.outcomes
    .filter((outcome) => outcome.status === "fulfilled")
    .map((outcome) => outcome.value);
  if (results.length === 0) {
    const failures = decision.outcomes.map(
      (outcome) => `${outcome.targetId}: ${outcome.message}`,
    );
    throw new Error(`Taskboard injection failed in every Codex renderer: ${failures.join("; ")}`);
  }
  return results;
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
if (typeof window.__CODEX_TASKBOARD_URL__ !== "string" || !window.__CODEX_TASKBOARD_URL__.trim()) {
  window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
}
${userScript}`;
  const sourceHash = createHash("sha256").update(runtimeSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};
${runtimeSource}`,
  };
}

function isTransientRendererDisconnect(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "No Codex renderer target found"
    || message === "fetch failed"
    || message === "CDP WebSocket closed"
    || message === "CDP WebSocket connection failed";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
    console.log(JSON.stringify({
      launcher: startResidentInjector(port, options.open, false, null, options.managedTaskboard),
      port,
    }, null, 2));
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
      const results = await refreshTaskboardFrames(port, options.open);
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
  const supervisor = createTaskboardSupervisor({
    detached: !options.watch,
    managed: options.managedTaskboard,
  });

  try {
    const cdpReachable = await isReachable(cdpVersionUrl);
    if (!cdpReachable) {
      if (!options.launch) {
        throw new Error(`Codex CDP is not listening on 127.0.0.1:${options.port}`);
      }
    }

    await supervisor.ensure({ force: true });

    if (!cdpReachable) {
      await stopOrphanedCodexAppServers();
      codexProcess = launchCodex(options.appPath, options.port);
      await waitUntilReachable(cdpVersionUrl, 30_000);
    }

    const { source, sourceHash } = await currentInjectionSource();
    const injectedTargets = new Map();
    const injectionAttempts = new Map();
    const firstResults = await waitForInitialInjection(
      () => injectAll(
        options.port,
        source,
        sourceHash,
        options.open,
        options.screenshot,
        injectedTargets,
        injectionAttempts,
        options.watch,
        supervisor,
        options.attachExisting,
        options.startupToken,
      ),
      30_000,
    );
    console.log(JSON.stringify({ injected: firstResults }, null, 2));

    if (!options.watch) {
      codexProcess?.unref();
      return;
    }

    const stop = () => {
      injectedTargets.forEach((connection) => connection.close());
      supervisor.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    let missingRendererSince = null;
    let rendererMissingLogged = false;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        await supervisor.ensure();
      } catch (error) {
        console.error(`Waiting for Taskboard service: ${error.message}`);
      }
      for (const [targetId, connection] of injectedTargets) {
        try {
          await publishHostHeartbeat(connection, options.startupToken);
        } catch (error) {
          connection.close();
          injectedTargets.delete(targetId);
          console.error(`Reconnecting Taskboard host binding: ${error.message}`);
        }
      }
      try {
        const results = await injectAll(
          options.port,
          source,
          sourceHash,
          options.open,
          null,
          injectedTargets,
          injectionAttempts,
          true,
          supervisor,
          options.attachExisting,
          options.startupToken,
        );
        missingRendererSince = null;
        rendererMissingLogged = false;
        if (results.length > 0) console.log(JSON.stringify({ injected: results }, null, 2));
      } catch (error) {
        const codexProcessExited = Boolean(codexProcess && codexProcess.exitCode !== null);
        const cdpReachable = await isReachable(cdpVersionUrl);
        if (!cdpReachable || isTransientRendererDisconnect(error)) {
          missingRendererSince ??= Date.now();
          if (shouldStopWatchingForMissingRenderer({
            missingSince: missingRendererSince,
            graceMs: rendererRecoveryGraceMs,
            codexProcessExited,
          })) break;
          if (!rendererMissingLogged) {
            console.error("Codex renderer unavailable; waiting briefly for a normal reopen.");
            rendererMissingLogged = true;
          }
          continue;
        }
        missingRendererSince = null;
        rendererMissingLogged = false;
        if (codexProcessExited) break;
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
    supervisor.stop();
  } catch (error) {
    supervisor.stop();
    codexProcess?.unref();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === injectorPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
