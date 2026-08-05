const CODEX_HOST_ID = "local";
const MCP_REQUEST_TIMEOUT_MS = 30_000;
const TURN_POLL_INTERVAL_MS = 1_000;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

function validatedDebugPort(debugPort) {
  const port = Number(debugPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Codex debugging port is invalid");
  }
  return port;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Codex task was stopped"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Codex task was stopped"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runCodexDesktopTask({
  debugPort,
  workspacePath,
  model,
  reasoningEffort,
  title,
  prompt,
  onThreadStarted,
  signal,
}) {
  const started = await requestCodexAppServer(debugPort, "thread/start", {
    cwd: workspacePath,
    model,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    threadSource: "automation",
    serviceName: "codex-taskboard",
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || !threadId) {
    throw new Error("Codex Desktop started a task without returning a thread id");
  }

  await requestCodexAppServer(debugPort, "thread/name/set", { threadId, name: title });
  await onThreadStarted(threadId);
  const turnStarted = await requestCodexAppServer(debugPort, "turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: workspacePath,
    model,
    effort: reasoningEffort,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspacePath],
      networkAccess: true,
    },
  });
  const turnId = turnStarted?.turn?.id;
  if (typeof turnId !== "string" || !turnId) {
    throw new Error("Codex Desktop started a turn without returning a turn id");
  }

  while (true) {
    await delay(TURN_POLL_INTERVAL_MS, signal);
    const snapshot = await requestCodexAppServer(debugPort, "thread/read", {
      threadId,
      includeTurns: true,
    });
    const turn = snapshot?.thread?.turns?.find((candidate) => candidate.id === turnId);
    if (!turn || !TERMINAL_TURN_STATUSES.has(turn.status)) continue;
    return {
      threadId,
      turnId,
      status: turn.status,
      error: turn.error ?? null,
    };
  }
}

function codexPageTarget(target) {
  return target?.type === "page"
    && typeof target.webSocketDebuggerUrl === "string"
    && (target.title === "Codex" || target.url?.startsWith("app://"));
}

async function evaluateInCodex(debugPort, expression, timeoutMs = 10_000) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Codex debugging endpoint returned ${response.status}`);
  const targets = await response.json();
  const target = Array.isArray(targets) ? targets.find(codexPageTarget) : null;
  if (!target) throw new Error("No debuggable Codex window is available");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to Codex")), 3_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to Codex"));
    }, { once: true });
  });

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex Desktop request timed out")), timeoutMs);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.result?.exceptionDetails) {
          reject(new Error(message.result.result?.description || "Codex project assignment failed"));
          return;
        }
        resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
  } finally {
    socket.close();
  }
}

async function requestCodexAppServer(debugPort, method, params) {
  const port = validatedDebugPort(debugPort);
  const expression = `(() => new Promise((resolve) => {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      resolve({ ok: false, error: "Codex Desktop host bridge is unavailable" });
      return;
    }
    const id = "taskboard-mcp-" + crypto.randomUUID();
    const finish = (result) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(result);
    };
    const onMessage = (event) => {
      const response = event.data;
      if (
        !response
        || response.type !== "mcp-response"
        || response.hostId !== ${JSON.stringify(CODEX_HOST_ID)}
        || String(response.message?.id) !== id
      ) return;
      finish({ ok: true, message: response.message });
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: "Codex Desktop App Server did not respond" }),
      ${MCP_REQUEST_TIMEOUT_MS},
    );
    window.addEventListener("message", onMessage);
    Promise.resolve(bridge.sendMessageFromView({
      type: "mcp-request",
      request: {
        id,
        method: ${JSON.stringify(method)},
        params: ${JSON.stringify(params)},
      },
      hostId: ${JSON.stringify(CODEX_HOST_ID)},
      priority: "critical",
      source: ${JSON.stringify(method.startsWith("turn/") ? "turn" : "thread")},
      timeoutMs: ${MCP_REQUEST_TIMEOUT_MS},
      expiresAtMs: Date.now() + ${MCP_REQUEST_TIMEOUT_MS},
    })).catch((error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  }))()`;
  const response = await evaluateInCodex(
    port,
    expression,
    MCP_REQUEST_TIMEOUT_MS + 5_000,
  );
  if (!response?.ok) throw new Error(response?.error || "Codex Desktop App Server request failed");
  if (response.message?.error) {
    throw new Error(response.message.error.message || `Codex Desktop rejected ${method}`);
  }
  return response.message?.result;
}

export async function assignThreadToCodexProject({ debugPort, threadId, projectId, cwd }) {
  const port = validatedDebugPort(debugPort);
  const expression = `(() => {
    const hostFetch = (method, params) => new Promise((resolve, reject) => {
      const requestId = "taskboard-project-" + crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        cleanup();
        if (message.responseType === "error" || message.status < 200 || message.status >= 300) {
          reject(new Error(message.bodyJsonString || "Codex host request failed"));
          return;
        }
        resolve(message.bodyJsonString ? JSON.parse(message.bodyJsonString) : {});
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Codex host request timed out"));
      }, 5000);
      window.addEventListener("message", onMessage);
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        cleanup();
        reject(new Error("Codex host bridge is unavailable"));
        return;
      }
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: "vscode://codex/" + method,
        body: JSON.stringify(params),
      })).catch((error) => {
        cleanup();
        reject(error);
      });
    });
    return (async () => {
      const key = "thread-project-assignments";
      const current = await hostFetch("get-global-state", { key });
      const assignments = current.value && typeof current.value === "object"
        ? current.value
        : {};
      assignments[${JSON.stringify(threadId)}] = {
        projectKind: "local",
        projectId: ${JSON.stringify(projectId)},
        cwd: ${JSON.stringify(cwd)},
        pendingCoreUpdate: false,
      };
      return hostFetch("set-global-state", { key, value: assignments });
    })();
  })()`;
  const result = await evaluateInCodex(port, expression);
  if (result?.success !== true) throw new Error("Codex rejected the project assignment");
}
