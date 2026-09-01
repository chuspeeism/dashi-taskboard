const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";

function parseHostRequest(payload, parseAutomationRequest) {
  if (typeof payload !== "string" || payload.length > 4_194_304) {
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
  if (request.action === "read-current-user") return { id, request, error: null };
  if (
    request.action === "load-frame"
    && typeof request.frameName === "string"
    && /^codex-taskboard-[a-f0-9-]{36,80}$/i.test(request.frameName)
    && typeof request.frameCapability === "string"
    && /^[a-f0-9-]{36,80}$/i.test(request.frameCapability)
  ) return { id, request, error: null };
  if (request.action === "open-external" && typeof request.url === "string") {
    try {
      const url = new URL(request.url);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.href.length <= 2_048) {
        return { id, request: { ...request, url: url.href }, error: null };
      }
    } catch {}
  }
  if (
    request.action === "open-attachment"
    && typeof request.attachmentId === "string"
    && /^[a-f0-9-]{36}$/i.test(request.attachmentId)
    && typeof request.filename === "string"
    && request.filename.length > 0
    && request.filename.length <= 240
    && request.filename !== "."
    && request.filename !== ".."
    && !/[\u0000-\u001f\u007f/\\]/.test(request.filename)
  ) return { id, request, error: null };
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
    request.action === "continue-task-thread"
    && typeof request.identifier === "string"
    && request.identifier.length > 0
    && request.identifier.length <= 128
    && typeof request.feedback === "string"
    && request.feedback.trim().length > 0
    && request.feedback.length <= 100_000
    && request.threadBinding
    && typeof request.threadBinding.threadId === "string"
    && request.threadBinding.threadId.length > 0
    && request.threadBinding.threadId.length <= 240
    && typeof request.threadBinding.codexProjectId === "string"
    && request.threadBinding.codexProjectId.length > 0
    && request.threadBinding.codexProjectId.length <= 240
    && (request.threadBinding.codexProjectKind === "local" || request.threadBinding.codexProjectKind === "remote")
    && typeof request.threadBinding.codexHostId === "string"
    && request.threadBinding.codexHostId.length > 0
    && request.threadBinding.codexHostId.length <= 240
    && typeof request.threadBinding.workspacePath === "string"
    && request.threadBinding.workspacePath.length > 0
    && request.threadBinding.workspacePath.length <= 4_096
    && !/[\u0000-\u001f\u007f]/.test([
      request.identifier,
      request.threadBinding.threadId,
      request.threadBinding.codexProjectId,
      request.threadBinding.codexHostId,
      request.threadBinding.workspacePath,
    ].join(""))
  ) return { id, request, error: null };
  if (
    request.action === "start-task-conversation"
    && typeof request.taskId === "string"
    && request.taskId.length > 0
    && request.taskId.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(request.taskId)
    && typeof request.previousThreadId === "string"
    && request.previousThreadId.length <= 240
    && typeof request.codexHostId === "string"
    && request.codexHostId.length > 0
    && request.codexHostId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.codexHostId)
    && typeof request.projectless === "boolean"
    && (
      request.projectless
      || (
        typeof request.targetRoot === "string"
        && request.targetRoot.length > 0
        && request.targetRoot.length <= 4_096
      )
    )
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 4_000_000
    && typeof request.title === "string"
    && request.title.length > 0
    && request.title.length <= 240
  ) {
    return { id, request, error: null };
  }
  return { id, request: null, error: HOST_REQUEST_ERROR };
}

export async function handleHostBindingPayload(params, handlers) {
  if (
    typeof handlers.isAuthorizedContext === "function"
    && !handlers.isAuthorizedContext(params.executionContextId)
  ) {
    return { responded: false, accepted: false };
  }

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
    } else if (parsed.request.action === "read-current-user") {
      result = await handlers.readCurrentUser();
    } else if (parsed.request.action === "load-frame") {
      result = await handlers.loadFrame(parsed.request);
    } else if (parsed.request.action === "open-external") {
      result = await handlers.openExternal(parsed.request);
    } else if (parsed.request.action === "open-attachment") {
      result = await handlers.openAttachment(parsed.request);
    } else if (parsed.request.action === "automation") {
      result = await handlers.runAutomation(parsed.request, params.executionContextId);
    } else if (parsed.request.action === "continue-task-thread") {
      result = await handlers.continueTaskThread(parsed.request, params.executionContextId);
    } else {
      result = await handlers.startConversation(parsed.request, params.executionContextId);
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
      ...(typeof error?.threadId === "string" ? { threadId: error.threadId } : {}),
      ...(error?.uncertain === true ? { uncertain: true } : {}),
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
  const shouldRemainOpen = currentStatus.pageVisible === true;
  if (replaced && shouldRemainOpen) await reopen();
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
