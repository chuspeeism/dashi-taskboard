const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";

export function waitForWebSocketOpen(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onOpen = () => finish(resolve);
    const onError = () => finish(reject, new Error("CDP WebSocket connection failed"));
    const onClose = () => finish(reject, new Error("CDP WebSocket closed before opening"));

    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      finish(reject, new Error("Timed out opening CDP WebSocket"));
    }, timeoutMs);
  });
}

async function waitForStableCodexDocument(cdp, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    const evaluation = await cdp.send("Runtime.evaluate", {
      expression: "({ protocol: window.location.protocol, readyState: document.readyState })",
      returnByValue: true,
    });
    lastState = evaluation.result?.value || null;
    if (lastState?.protocol === "app:" && lastState.readyState === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const detail = `${lastState?.protocol || "unknown"}/${lastState?.readyState || "unknown"}`;
  throw new Error(`Timed out waiting for the stable Codex document: ${detail}`);
}

export async function reloadPageAndWait(cdp, timeoutMs = 15_000, pollIntervalMs = 50) {
  await waitForStableCodexDocument(cdp, timeoutMs, pollIntervalMs);
  const loaded = cdp.waitFor("Page.loadEventFired", timeoutMs);
  const reload = cdp.send("Page.reload");
  await Promise.all([loaded, reload]);
}

export async function removeRegisteredPageScript(removeScript, identifier) {
  if (!identifier) return false;
  try {
    await removeScript(identifier);
    return true;
  } catch (error) {
    if (error.message === "Script not found") return false;
    throw error;
  }
}

export function shouldStopWatchingForMissingRenderer({
  missingSince,
  now = Date.now(),
  graceMs = 10_000,
  codexProcessExited = false,
}) {
  if (codexProcessExited) return true;
  return Number.isFinite(missingSince) && now - missingSince >= graceMs;
}

function parseHostRequest(payload, parseAutomationRequest) {
  if (typeof payload !== "string" || payload.length > 4_096) {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  const id = (
    request
    && typeof request.id === "string"
    && /^[a-z0-9-]{1,80}$/i.test(request.id)
  ) ? request.id : null;
  if (!id) return { id: null, request: null, error: HOST_REQUEST_ERROR };
  if (request.action === "ensure") return { id, request, error: null };
  if (request.action === "automation") {
    const parsed = parseAutomationRequest(request);
    return parsed
      ? { id, request: parsed, error: null }
      : {
          id,
          request: null,
          error: HOST_REQUEST_ERROR,
          diagnosticCode: AUTOMATION_SCHEMA_DIAGNOSTIC,
        };
  }
  if (
    request.action === "prefill-task-composer"
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 1_024
    && typeof request.skillName === "string"
    && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(request.skillName)
    && typeof request.skillDisplayName === "string"
    && request.skillDisplayName.length > 0
    && request.skillDisplayName.length <= 120
    && typeof request.skillPath === "string"
    && request.skillPath.length > 0
    && request.skillPath.length <= 1_024
  ) {
    return { id, request, error: null };
  }
  return { id, request: null, error: HOST_REQUEST_ERROR };
}

export async function handleHostBindingPayload(params, handlers) {
  const parsed = parseHostRequest(params.payload, handlers.parseAutomationRequest);
  if (!parsed.request) {
    if (!parsed.id) return { responded: false, accepted: false };
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.id,
      ok: false,
      error: parsed.error,
      ...(parsed.diagnosticCode ? { diagnosticCode: parsed.diagnosticCode } : {}),
    });
    return { responded: true, accepted: false };
  }

  try {
    let result;
    if (parsed.request.action === "ensure") {
      result = await handlers.ensure();
    } else if (parsed.request.action === "automation") {
      result = await handlers.runAutomation(parsed.request, params.executionContextId);
    } else {
      result = await handlers.prefill(parsed.request, params.executionContextId);
    }
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: true,
      ...result,
    });
  } catch (error) {
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: false,
      error: error.message,
    });
  }
  return { responded: true, accepted: true };
}

export async function reconcileInjectionRuntime({
  currentStatus,
  source,
  sourceHash,
  removeRegisteredSource,
  registerCurrentSource,
  evaluateCurrentSource,
  publishRegistration,
  reopen,
  forceOpen = false,
}) {
  if (currentStatus.scriptIdentifier) {
    try {
      await removeRegisteredSource(currentStatus.scriptIdentifier);
    } catch {}
  }
  const scriptIdentifier = await registerCurrentSource(source);
  await evaluateCurrentSource(source);
  await publishRegistration(scriptIdentifier);
  const replaced = currentStatus.sourceHash !== sourceHash;
  const shouldRemainOpen = forceOpen || currentStatus.pageVisible === true;
  if ((replaced && shouldRemainOpen) || (forceOpen && currentStatus.pageVisible !== true)) {
    await reopen();
  }
  return { replaced, scriptIdentifier, shouldRemainOpen };
}

export function findResidentInjectorPids({
  processList,
  currentPid,
  injectorPath,
  projectRoot,
  port,
  defaultPort,
  cwdForPid,
}) {
  const absoluteScript = new RegExp(
    `(?:^|\\s)${escapeRegExp(injectorPath)}(?=\\s|$)`,
  );
  const relativeScript = /(?:^|\s)(?:\.\/)?scripts\/codex-injector\.mjs(?=\s|$)/;
  const residents = [];

  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === currentPid || !/(?:^|\s)--watch(?=\s|$)/.test(command)) continue;
    const scriptMatches = absoluteScript.test(command)
      || (relativeScript.test(command) && cwdForPid(pid) === projectRoot);
    if (!scriptMatches || commandPort(command, defaultPort) !== port) continue;
    residents.push(pid);
  }
  return residents;
}

export async function restartResidentInjector(port, handlers) {
  const previousPids = handlers.findResidents(port);
  if (previousPids.length === 0) return { previousPids: [], pid: null, restarted: false };

  for (const pid of previousPids) await handlers.stopResident(pid);
  const startupToken = handlers.createStartupToken();
  const started = handlers.startResident(port, startupToken);
  await handlers.waitUntilReady(port, started.pid, startupToken);
  return {
    previousPids,
    pid: started.pid,
    restarted: true,
  };
}

function commandPort(command, defaultPort) {
  const match = command.match(/(?:^|\s)--port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
  return match ? Number(match[1] ?? match[2]) : defaultPort;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
