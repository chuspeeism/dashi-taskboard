import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { executableCommand } from "../shared/executable-command.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BUFFER = 4 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;

export class CodexAppServerError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "CodexAppServerError";
    this.details = details;
  }
}

export class CodexAppServer {
  constructor({ executable, processEnv = process.env, requestTimeoutMs } = {}) {
    this.executable = executable;
    this.processEnv = withoutTaskboardLauncherEnvironment(processEnv);
    this.requestTimeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = null;
    this.starting = null;
    this.closing = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stdoutBuffer = "";
    this.stderr = "";
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSkills(workspacePath, { forceReload = false } = {}) {
    const result = await this.request("skills/list", {
      cwds: [workspacePath],
      forceReload,
    });
    return Array.isArray(result?.data) ? result.data : [];
  }

  startThread(params) {
    return this.request("thread/start", params);
  }

  resumeThread(params) {
    return this.request("thread/resume", params);
  }

  startTurn(params) {
    return this.request("turn/start", params);
  }

  interruptTurn(params) {
    return this.request("turn/interrupt", params);
  }

  compactThread(threadId) {
    return this.request("thread/compact/start", { threadId });
  }

  async request(method, params) {
    await this.#ensureStarted();
    return this.#sendRequest(method, params);
  }

  async close() {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.#rejectPending(new CodexAppServerError("Codex app-server closed"));
    this.listeners.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  async #ensureStarted() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.starting) return this.starting;
    if (this.closing) throw new CodexAppServerError("Codex app-server is closing");

    this.starting = new Promise((resolve, reject) => {
      const command = executableCommand(this.executable, ["app-server", "--stdio"]);
      const child = spawn(command.executable, command.args, {
        env: this.processEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.stdoutBuffer = "";
      this.stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.#handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT);
      });
      child.stdin.on("error", (error) => this.#handleExit(error));
      child.once("error", (error) => {
        this.#handleExit(error);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
        const error = new CodexAppServerError(
          `Codex app-server exited (${signal || code})${suffix}`,
          { code, signal },
        );
        this.#handleExit(error);
      });
      child.once("spawn", () => {
        this.#sendRequest("initialize", {
          clientInfo: {
            name: "codex-taskboard",
            title: "Codex Taskboard",
            version: "1.0.1",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        }).then(() => {
          this.#sendNotification("initialized");
          resolve();
        }, reject);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  #sendRequest(method, params) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not running"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex app-server request '${method}' timed out`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  #sendNotification(method) {
    this.child?.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  #handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      this.child?.kill("SIGTERM");
      this.#handleExit(new CodexAppServerError("Codex app-server output exceeded its limit"));
      return;
    }
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          this.#handleMessage(JSON.parse(line));
        } catch (error) {
          console.error("Codex app-server returned invalid JSON", error);
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerError(
          `Codex app-server rejected '${pending.method}': ${message.error.message ?? "unknown error"}`,
          message.error,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message?.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      this.child?.stdin.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request '${message.method}'` },
      })}\n`);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Codex app-server notification handler failed", error);
      }
    }
  }

  #handleExit(error) {
    if (this.child && this.child.exitCode !== null) this.child = null;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexHostAppServer {
  constructor({ hostId, ipc = process, requestTimeoutMs } = {}) {
    this.hostId = hostId;
    this.ipc = ipc;
    this.requestTimeoutMs = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.handleMessage = (message) => this.#handleMessage(message);
    this.ipc.on?.("message", this.handleMessage);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSkills(workspacePath, { forceReload = false } = {}) {
    const result = await this.request("skills/list", {
      cwds: [workspacePath],
      forceReload,
    });
    return Array.isArray(result?.data) ? result.data : [];
  }

  startThread(params) {
    return this.request("thread/start", params);
  }

  resumeThread(params) {
    return this.request("thread/resume", params);
  }

  startTurn(params) {
    return this.request("turn/start", params);
  }

  interruptTurn(params) {
    return this.request("turn/interrupt", params);
  }

  compactThread(threadId) {
    return this.request("thread/compact/start", { threadId });
  }

  request(method, params) {
    if (this.closed || typeof this.ipc.send !== "function" || this.ipc.connected === false) {
      return Promise.reject(new CodexAppServerError("Codex host bridge is unavailable"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexAppServerError(`Codex host request '${method}' timed out`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(requestId, { method, resolve, reject, timer });
      this.ipc.send({
        type: "taskboard:codex-app-server-request",
        requestId,
        hostId: this.hostId,
        method,
        params,
      }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.ipc.off?.("message", this.handleMessage);
    this.#rejectPending(new CodexAppServerError("Codex host bridge closed"));
    this.listeners.clear();
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object" || message.hostId !== this.hostId) return;
    if (message.type === "taskboard:codex-app-server-response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerError(
          `Codex host rejected '${pending.method}': ${message.error}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      message.type !== "taskboard:codex-app-server-notification"
      || typeof message.method !== "string"
    ) return;
    const notification = { method: message.method, params: message.params };
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (error) {
        console.error("Codex host notification handler failed", error);
      }
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
