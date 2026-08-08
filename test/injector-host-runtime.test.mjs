import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  reconcileInjectionRuntime,
  reloadPageAndWait,
  removeRegisteredPageScript,
  restartResidentInjector,
  waitForWebSocketOpen,
} from "../scripts/codex-injector-runtime.mjs";

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a CDP WebSocket that never opens times out instead of hanging the injector", async () => {
  const socket = new EventTarget();
  let closed = false;
  socket.close = () => {
    closed = true;
  };

  await assert.rejects(waitForWebSocketOpen(socket, 5), /Timed out opening CDP WebSocket/);
  assert.equal(closed, true);
});

test("an opened CDP WebSocket clears the connection timeout", async () => {
  const socket = new EventTarget();
  socket.close = () => assert.fail("an open socket must not be closed");
  const opened = waitForWebSocketOpen(socket, 50);
  socket.dispatchEvent(new Event("open"));
  await opened;
});

test("renderer replacement observes both reload command and load event failures", async () => {
  const cdp = {
    waitFor: () => Promise.reject(new Error("renderer closed")),
    send: () => Promise.reject(new Error("reload command failed")),
  };

  await assert.rejects(reloadPageAndWait(cdp), /renderer closed|reload command failed/);
  await new Promise((resolve) => setImmediate(resolve));
});

test("cold launch reload waits for the stable Codex app document", async () => {
  const calls = [];
  const documentStates = [
    { protocol: "data:", readyState: "complete" },
    { protocol: "app:", readyState: "loading" },
    { protocol: "app:", readyState: "complete" },
  ];
  const cdp = {
    waitFor: async (method) => {
      calls.push(method);
    },
    send: async (method) => {
      calls.push(method);
      if (method === "Runtime.evaluate") {
        return { result: { value: documentStates.shift() } };
      }
      return {};
    },
  };

  await reloadPageAndWait(cdp, 1_000, 0);

  assert.deepEqual(calls, [
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Page.loadEventFired",
    "Page.reload",
  ]);
});

test("a stale page-script identifier does not block a fresh injector", async () => {
  assert.equal(await removeRegisteredPageScript(
    async () => {
      throw new Error("Script not found");
    },
    "stale-registration",
  ), false);
  await assert.rejects(
    removeRegisteredPageScript(
      async () => {
        throw new Error("CDP WebSocket closed");
      },
      "live-registration",
    ),
    /CDP WebSocket closed/,
  );
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

test("attach honors an explicit open request for an existing closed runtime", async () => {
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
    registerCurrentSource: async () => "current-registration",
    evaluateCurrentSource: async () => {},
    publishRegistration: async () => {},
    reopen: async () => calls.push(["open"]),
    forceOpen: true,
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["open"],
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
