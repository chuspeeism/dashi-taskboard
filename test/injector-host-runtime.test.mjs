import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
  restartResidentInjector,
} from "../scripts/codex-injector-runtime.mjs";

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  codexProjectKind: "local",
  codexHostId: "local",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a binding call from the wrong execution context cannot reach native actions", async () => {
  const calls = [];
  const result = await handleHostBindingPayload(
    {
      payload: JSON.stringify({ id: "host-request-2", action: "ensure" }),
      executionContextId: 44,
    },
    {
      isAuthorizedContext: (executionContextId) => executionContextId === 12,
      parseAutomationRequest: () => null,
      ensure: async () => calls.push("ensure"),
      runAutomation: async () => calls.push("automation"),
      prefill: async () => calls.push("prefill"),
      sendResponse: async () => calls.push("response"),
    },
  );

  assert.deepEqual(result, { responded: false, accepted: false });
  assert.deepEqual(calls, []);
});

test("frame loading and external links require bounded authenticated values", async () => {
  const calls = [];
  const handlers = {
    parseAutomationRequest: () => null,
    ensure: async () => assert.fail("ensure must not run"),
    loadFrame: async (request) => calls.push(["load", request.frameCapability]),
    openExternal: async (request) => calls.push(["open", request.url]),
    runAutomation: async () => assert.fail("automation must not run"),
    prefill: async () => assert.fail("prefill must not run"),
    sendResponse: async (_executionContextId, response) => calls.push(["response", response.ok]),
  };

  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "load-request-1",
      action: "load-frame",
      frameName: "codex-taskboard-8f99fbb3-12d4-48af-8938-89f993fab008",
      frameCapability: "30c3d0c4-aa0f-4169-93c0-bb3da20bc654",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-http",
      action: "open-external",
      url: "http://10.0.203.86:30842/projects",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-1",
      action: "open-external",
      url: "https://example.com/review",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-2",
      action: "open-external",
      url: "javascript:alert(1)",
    }),
    executionContextId: 12,
  }, handlers);

  assert.deepEqual(calls, [
    ["load", "30c3d0c4-aa0f-4169-93c0-bb3da20bc654"],
    ["response", true],
    ["open", "http://10.0.203.86:30842/projects"],
    ["response", true],
    ["open", "https://example.com/review"],
    ["response", true],
    ["response", false],
  ]);
});

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("resident discovery accepts this repository's absolute and relative launch forms only", () => {
  const projectRoot = "/workspace/codex-taskboard";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
  ].join("\n");
  const cwdByPid = new Map([
    [102, projectRoot],
    [103, projectRoot],
    [104, "/workspace/another-repository"],
  ]);

  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9231,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [101, 103]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9229,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [102, 105]);
});

test("refresh stops every stale resident before starting one token-verified replacement", async () => {
  const calls = [];
  const startupToken = "replacement-token";
  const replacement = await restartResidentInjector(9231, {
    findResidents: () => [4321, 5432],
    stopResident: async (pid) => calls.push(["stop", pid]),
    createStartupToken: () => startupToken,
    startResident: (port, token) => {
      calls.push(["start", port, token]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid, token) => calls.push(["ready", port, pid, token]),
  });

  assert.deepEqual(replacement, {
    previousPids: [4321, 5432],
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["stop", 5432],
    ["start", 9231, startupToken],
    ["ready", 9231, 9876, startupToken],
  ]);
});

test("review feedback reaches the exact bound Codex task", async () => {
  const calls = [];
  const responses = [];
  const request = {
    id: "continue-review-1",
    action: "continue-task-thread",
    identifier: "LOCAL-12",
    feedback: "Please keep the original layout and fix the empty state.",
    threadBinding: {
      threadId: "01a00000-0000-7000-8000-000000000012",
      codexProjectId: "project-12",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/workspace/project-12",
    },
  };

  const result = await handleHostBindingPayload({
    payload: JSON.stringify(request),
    executionContextId: 12,
  }, {
    parseAutomationRequest: () => null,
    continueTaskThread: async (value) => {
      calls.push(value);
      return { turnId: "turn-12" };
    },
    startConversation: async () => assert.fail("must not create a task"),
    sendResponse: async (_executionContextId, response) => responses.push(response),
  });

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].threadBinding, request.threadBinding);
  assert.deepEqual(responses, [{ id: request.id, ok: true, turnId: "turn-12" }]);

  const rejected = [];
  await handleHostBindingPayload({
    payload: JSON.stringify({
      ...request,
      id: "continue-review-invalid",
      threadBinding: { ...request.threadBinding, workspacePath: "" },
    }),
    executionContextId: 12,
  }, {
    parseAutomationRequest: () => null,
    continueTaskThread: async () => assert.fail("invalid binding must not reach Codex"),
    startConversation: async () => assert.fail("invalid binding must not create a task"),
    sendResponse: async (_executionContextId, response) => rejected.push(response),
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].ok, false);
});
