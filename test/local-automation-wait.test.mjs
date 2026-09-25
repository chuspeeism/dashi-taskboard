import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import {
  buildTaskboardAutomationSpec,
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";

// Never import the injector entrypoint: it starts the native app/supervisor.
const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const functions = source.slice(
  source.indexOf("async function requestCodexAutomationViaCdp"),
  source.indexOf("async function startTaskConversationViaCdp"),
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const request = {
  id: "local-448", action: "automation", requestId: "local-448",
  operation: "apply-policy", taskboardProjectId: "local",
  codexProjectId: "windows-project", codexProjectKind: "local", codexHostId: "local",
  projectName: "LOCAL-448", workspacePath: String.raw`C:\work\project`,
  skillPath: String.raw`C:\work\taskboard\skills\manage-taskboard\SKILL.md`,
  enabledByUser: true, quotaAware: false, intervalMinutes: 5,
  model: "test-model", reasoningEffort: "high",
};
const todo = (id, extra = {}) => ({
  id, identifier: `LOCAL-${id}`, projectId: "local", version: 1,
  title: `Task ${id}`, description: "Only planning is authorized; wait for further information.",
  status: "todo", archivedAt: null, threadId: null, threadBinding: null,
  relations: { blockedBy: [] }, ...extra,
});
const comment = (body) => ({
  id: "comment-1", version: 1, body, authorName: "Owner",
  createdAt: "2026-09-23T08:45:00Z", updatedAt: "2026-09-23T08:45:00Z",
});

async function host(t, { tasks = [todo("448")], existing = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "local-448-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const automationPoliciesPath = path.join(directory, "policies.json");
  let now = Date.UTC(2026, 8, 23, 8, 45);
  class Clock extends Date { static now() { return now; } }
  const timers = new Set();
  const setTimeout = (callback, delay) => {
    const timer = { callback, at: now + delay, unref() { return this; } };
    timers.add(timer);
    return timer;
  };
  const clearTimeout = (timer) => timers.delete(timer);
  const records = new Map();
  const comments = new Map(tasks.map((task) => [task.id, [comment("Do not implement yet.")]]));
  const decisions = new Map(tasks.map((task) => [task.identifier, "wait"]));
  const apiCalls = [];
  const codexCalls = [];
  const models = [];
  const errors = [];
  let persistentConversations = 0;
  let item = existing ? {
    ...buildTaskboardAutomationSpec(request), id: "native-cron", status: "ACTIVE",
    nextRunAt: now + 5 * 60_000,
  } : null;
  let onDecision = async () => {};
  let quotaState = "available";
  let api;
  const listeners = new Set();
  const emit = (data) => {
    for (const listener of [...listeners]) listener({ data, stopImmediatePropagation() {} });
  };
  const renderer = {
    Date: Clock,
    window: {
      setTimeout, clearTimeout,
      addEventListener: (_name, listener) => listeners.add(listener),
      removeEventListener: (_name, listener) => listeners.delete(listener),
      electronBridge: {
        async sendMessageFromView(message) {
          if (message.type === "fetch") {
            const method = message.url.split("/").at(-1);
            const params = JSON.parse(message.body);
            codexCalls.push({ method, params: clone(params) });
            let body;
            if (method === "list-automations") body = { items: item ? [item] : [] };
            else if (method === "automation-create" || method === "automation-update") {
              const status = params.status ?? "ACTIVE";
              item = {
                ...params, id: params.id ?? "native-cron", status,
                nextRunAt: status === "ACTIVE" ? now + request.intervalMinutes * 60_000 : null,
              };
              body = { item };
            } else throw new Error(`Unexpected cron RPC: ${method}`);
            emit({ type: "fetch-response", requestId: message.requestId, status: 200,
              bodyJsonString: JSON.stringify(body) });
            return;
          }
          assert.equal(message.type, "mcp-request");
          const { method, params, id } = message.request;
          codexCalls.push({ method, hostId: message.hostId, params: clone(params) });
          let result;
          if (method === "thread/start" || method === "thread/resume") {
            if (params.ephemeral) {
              assert.equal(params.ephemeral, true);
              assert.equal(params.sandbox, "read-only");
              assert.equal(params.approvalPolicy, "never");
            } else persistentConversations += method === "thread/start" ? 1 : 0;
            result = { thread: { id: params.threadId ?? `thread-${codexCalls.length}`,
              ephemeral: params.ephemeral === true, cwd: params.cwd } };
          } else if (method === "turn/start") {
            const turnId = `turn-${codexCalls.length}`;
            let text = "Implemented and verified in the synthetic remote worker.";
            if (params.outputSchema) {
              const input = JSON.parse(params.input[0].text.split("\n\n").at(-1));
              models.push({ hostId: message.hostId, input: clone(input) });
              await onDecision(input);
              text = JSON.stringify({ decision: decisions.get(input.identifier) ?? "wait" });
            }
            const turn = { id: turnId, status: "completed", items: [{ type: "agentMessage", text }] };
            // Exercise the real early-completion notification/waiter path.
            api.handleRemoteAutomationTurnNotification({
              hostId: message.hostId, method: "turn/completed",
              params: { threadId: params.threadId, turn },
            });
            result = { turn: { id: turnId } };
          } else throw new Error(`Unexpected app-server RPC: ${method}`);
          emit({ type: "mcp-response", hostId: message.hostId, message: { id, result } });
        },
      },
    },
  };
  const cdp = {
    closed: false,
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: await vm.runInNewContext(params.expression, renderer) } };
    },
  };
  const fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith("http://taskboard.test/isolated/api/tasks"));
    const pathname = String(url).slice("http://taskboard.test/isolated".length);
    const method = options.method ?? "GET";
    apiCalls.push({ pathname, method });
    let payload;
    if (pathname.startsWith("/api/tasks?")) {
      assert.equal(method, "GET");
      assert.ok(pathname.endsWith("&status=todo"));
      payload = { tasks: tasks.filter((task) => task.status === "todo") };
    } else {
      const [, , , id, action] = pathname.split("/");
      const task = tasks.find((candidate) => candidate.id === decodeURIComponent(id));
      assert.ok(task, pathname);
      if (action === "comments") {
        if (method === "POST") comments.get(task.id).push(JSON.parse(options.body));
        payload = { comments: comments.get(task.id) ?? [] };
      } else if (action === "attachments") payload = { attachments: [] };
      else if (action === "move") {
        const body = JSON.parse(options.body);
        assert.equal(body.version, task.version);
        Object.assign(task, body, { version: task.version + 1 });
        payload = { task };
      } else payload = { task };
    }
    const body = JSON.stringify(payload);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  api = vm.runInNewContext(`(() => {
    ${functions}
    return {
      updateAndApplyQuotaPolicy, enqueueCurrentQuotaPolicy, runRemoteTaskboardAutomation,
      requestCodexAutomationViaCdp, handleRemoteAutomationTurnNotification,
      registerQuotaPolicyCdp,
      async reload(cdp) {
        for (const timer of quotaPolicyTimers.values()) clearTimeout(timer);
        quotaPolicyTimers.clear();
        quotaPolicyRecords.clear();
        quotaPoliciesLoadPromise = null;
        await restoreQuotaPolicies(cdp);
      },
    };
  })()`, {
    createHash, path, mkdir, readFile, writeFile, fetch, Date: Clock, setTimeout, clearTimeout,
    console: { error: (message) => errors.push(message) }, process: { pid: 448 },
    automationPoliciesPath, taskboardBaseUrl: "http://taskboard.test/isolated",
    taskConversationAppServerTimeoutMs: 30_000, remoteAutomationTurnTimeoutMs: 30 * 60_000,
    codexAutomationRequestSequence: 0, codexAppServerRequestSequence: 0,
    codexAutomationMethods: new Set(["list-automations", "automation-create", "automation-update"]),
    quotaPolicyRecords: records, quotaPolicyQueues: new Map(), quotaPolicyTimers: new Map(),
    quotaPolicyCdps: new Set(), restoredQuotaPolicyCdps: new WeakSet(),
    quotaPolicyRestorePromises: new WeakMap(), remoteAutomationTurnWaiters: new Map(),
    quotaPoliciesLoadPromise: null, quotaPoliciesWritePromise: Promise.resolve(),
    readCodexQuotaStatus: async () => ({ state: quotaState, checkedAt: now }),
    parseTaskboardAutomationHostRequest, reconcileTaskboardAutomation, taskboardAutomationPolicyOperation,
  });
  api.registerQuotaPolicyCdp(cdp);
  return {
    tasks, comments, decisions, apiCalls, codexCalls, models, records, errors,
    get item() { return item; },
    get persistentConversations() { return persistentConversations; },
    onDecision(callback) { onDecision = callback; },
    setQuota(state) { quotaState = state; },
    save: (options = {}) => api.updateAndApplyQuotaPolicy({ ...request, ...options },
      (method, body) => api.requestCodexAutomationViaCdp(cdp, undefined, method, body)),
    check: () => api.enqueueCurrentQuotaPolicy("local"),
    readPolicy: async () => JSON.parse(await readFile(automationPoliciesPath, "utf8")).local,
    reload: () => api.reload(cdp),
    runRemote: () => api.runRemoteTaskboardAutomation(records.get("local")),
    async advance(milliseconds) {
      const end = now + milliseconds;
      let iterations = 0;
      while (true) {
        assert.ok(++iterations < 5000, "synthetic timer did not settle");
        const timer = [...timers].sort((a, b) => a.at - b.at)[0];
        const cronAt = item?.status === "ACTIVE" ? item.nextRunAt : Infinity;
        if (cronAt <= end && cronAt <= (timer?.at ?? Infinity)) {
          now = cronAt;
          persistentConversations += 1;
          item.nextRunAt += request.intervalMinutes * 60_000;
        } else if (timer && timer.at <= end) {
          now = timer.at;
          timers.delete(timer);
          await timer.callback();
        } else break;
      }
      now = end;
    },
  };
}

test("local wait rounds pause cron before semantic work, retain intent and survive restore", async (t) => {
  const binding = { threadId: "old-thread", codexProjectId: "old-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: String.raw`C:\old` };
  const h = await host(t, { tasks: [todo("448"), todo("449", {
    threadId: binding.threadId, threadBinding: binding,
  })] });
  const before = clone(h.tasks);
  h.onDecision(() => {
    assert.equal(h.item.status, "PAUSED", "cron must be paused before model work");
    assert.equal(h.persistentConversations, 0);
  });
  const response = await h.save();
  assert.equal(response.item.status, "PAUSED");
  assert.equal(response.idleReason, "checking-todos");
  assert.equal(h.models.length, 0, "the UI save must not wait for a semantic turn");
  await h.advance(1_000);
  assert.equal(h.models.length, 2);
  assert.equal((await h.check()).idleReason, "waiting-todos");
  await h.advance(15 * 60_000); // Three reported five-minute cron rounds.
  assert.equal(h.persistentConversations, 0);
  assert.equal(h.models.length, 2, "unchanged waiting snapshots should reuse the decision");
  assert.equal(h.records.get("local").request.enabledByUser, true);
  assert.equal((await h.readPolicy()).todoGate.state, "wait");
  await h.reload();
  await h.advance(5 * 60_000);
  assert.equal(h.records.get("local").request.enabledByUser, true);
  assert.equal((await h.check()).idleReason, "waiting-todos");
  assert.equal(h.persistentConversations, 0);
  assert.equal(h.models.length, 2);
  assert.deepEqual(h.tasks, before);
  assert.ok(h.apiCalls.every((call) => call.method === "GET"));
  assert.ok(h.models.every((call) => call.hostId === "local"));
  assert.equal(h.models[0].input.description, before[0].description);
  assert.equal(h.models[0].input.latestComment.body, "Do not implement yet.");
  assert.deepEqual(h.errors, []);
});

test("new executable legacy-bound todo resumes the same cron without touching waiting or in-progress work", async (t) => {
  const worker = todo("worker", { status: "in_progress", threadId: "working-thread" });
  const h = await host(t, { tasks: [todo("448"), worker] });
  await h.save();
  await h.advance(1_000);
  h.tasks.push(todo("450", { threadId: "legacy-thread", description: "Continue the existing work." }));
  h.comments.set("450", [comment("Continue in the original conversation.")]);
  h.decisions.set("LOCAL-450", "start");
  const before = clone(h.tasks);
  await h.advance(60_000);
  assert.equal(h.item.status, "PAUSED");
  await h.advance(1_000);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.item.id, "native-cron");
  assert.equal((await h.check()).idleReason, undefined);
  await h.advance(5 * 60_000);
  assert.equal(h.persistentConversations, 1);
  assert.ok(h.models.some((entry) => entry.input.identifier === "LOCAL-450"));
  assert.ok(h.models.every((entry) => entry.input.identifier !== "LOCAL-worker"));
  assert.deepEqual(h.tasks, before);
  assert.ok(h.apiCalls.every((call) => call.method === "GET"));
  assert.match(h.item.prompt, /legacy local 原位升级为完整 binding/);
  assert.match(h.item.prompt, /只能使用保存的 threadId 和 codexHostId/);
});

test("description and latest-comment edits invalidate waiting decisions, including edits during preflight", async (t) => {
  const h = await host(t, { existing: false });
  await h.save();
  await h.advance(1_000);
  assert.equal(h.item, null, "all-wait enable must not even create a cron");
  h.tasks[0].description = "Implementation is authorized.";
  h.comments.set("448", [comment("Proceed.")]);
  h.decisions.set("LOCAL-448", "start");
  await h.check();
  let changed = false;
  h.onDecision(() => {
    if (changed) return;
    changed = true;
    h.comments.get("448")[0].body = "Wait for the revised specification.";
    // Change only comment body: task version and comment identity stay unchanged.
  });
  await h.advance(1_000);
  assert.equal(h.item, null, "a stale start result must not activate cron");
  assert.equal(h.records.get("local").todoGate.state, "checking");
  h.decisions.set("LOCAL-448", "wait");
  await h.advance(1_000);
  assert.equal((await h.check()).idleReason, "waiting-todos");
  h.comments.get("448")[0].body = "Revised specification approved. Proceed.";
  h.decisions.set("LOCAL-448", "start");
  await h.check();
  await h.advance(1_000);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.codexCalls.filter((call) => call.method === "automation-create").length, 1);
  assert.equal((await h.check()).idleReason, undefined);
  assert.ok(h.apiCalls.every((call) => call.method === "GET"));
});

test("manual pause and empty-queue protection are not converted into recoverable waits", async (t) => {
  const h = await host(t);
  await h.save();
  await h.advance(1_000);
  await h.save({ enabledByUser: false });
  h.tasks[0].description = "Start now.";
  h.decisions.set("LOCAL-448", "start");
  await h.advance(10 * 60_000);
  assert.equal(h.item.status, "PAUSED");
  assert.equal(h.records.get("local").request.enabledByUser, false);
  assert.equal(h.records.get("local").todoGate, undefined);
  assert.equal(h.models.length, 1);
  await h.save();
  await h.advance(1_000);
  assert.equal(h.item.status, "ACTIVE");
  h.item.status = "PAUSED"; // Existing native pause detection still applies.
  await h.check();
  assert.equal(h.records.get("local").request.enabledByUser, false);
  await h.save();
  await h.advance(1_000);
  h.tasks.length = 0;
  await h.check();
  assert.equal(h.item.status, "PAUSED");
  assert.equal(h.records.get("local").request.enabledByUser, false);
  assert.equal(h.records.get("local").todoGate, undefined);
});

test("quota recovery does not disable a waiting policy or bypass its semantic gate", async (t) => {
  const h = await host(t);
  await h.save({ quotaAware: true });
  h.setQuota("blocked");
  await h.check();
  const readsBefore = h.apiCalls.length;
  await h.advance(60_000);
  assert.equal(h.models.length, 0, "quota pause must not run a pending semantic check");
  assert.ok(h.apiCalls.length - readsBefore <= 2, "quota pause must not become a one-second poll");
  h.setQuota("available");
  await h.check();
  await h.advance(1_000);
  h.setQuota("blocked");
  await h.check();
  assert.equal(h.records.get("local").request.enabledByUser, true);
  h.tasks[0].description = "Implementation now authorized.";
  h.decisions.set("LOCAL-448", "start");
  h.setQuota("available");
  await h.check();
  assert.equal(h.item.status, "PAUSED");
  await h.advance(1_000);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.records.get("local").request.enabledByUser, true);
});

test("a project identity update during a semantic turn cannot activate the old cron target", async (t) => {
  const h = await host(t);
  h.decisions.set("LOCAL-448", "start");
  await h.save();
  let changed;
  h.onDecision(() => {
    if (!changed) changed = h.save({ codexProjectId: "replacement", workspacePath: String.raw`C:\new` });
  });
  await h.advance(1_000);
  await changed;
  assert.equal(h.item.status, "PAUSED");
  assert.equal(h.records.get("local").request.codexProjectId, "replacement");
  assert.equal(h.codexCalls.filter((call) => (
    call.method === "automation-update" && call.params.status === "ACTIVE"
  )).length, 0);
  await h.advance(1_000);
  assert.equal(h.item.status, "ACTIVE");
  assert.equal(h.item.projectId, "replacement");
});

test("remote ephemeral selection and bound worker execution retain their existing host and binding", async (t) => {
  const binding = { threadId: "remote-worker", codexProjectId: "saved-project",
    codexProjectKind: "remote", codexHostId: "saved-ssh-host", workspacePath: "/saved/worktree" };
  const h = await host(t, { existing: false, tasks: [todo("448", {
    threadId: binding.threadId, threadBinding: binding,
  })] });
  await h.save({ codexProjectKind: "remote", codexProjectId: "remote-project",
    codexHostId: "ssh-controller", workspacePath: "/remote/base" });
  await h.runRemote();
  assert.equal(h.tasks[0].status, "todo");
  assert.equal(h.persistentConversations, 0);
  assert.equal(h.models[0].hostId, "ssh-controller");
  h.decisions.set("LOCAL-448", "start");
  await h.runRemote();
  assert.equal(h.tasks[0].status, "in_review");
  assert.deepEqual(h.tasks[0].threadBinding, binding);
  assert.equal(h.codexCalls.find((call) => call.method === "thread/resume").hostId, binding.codexHostId);
  assert.equal(h.codexCalls.filter((call) => call.method.startsWith("automation-")).length, 0);
});


test("slow semantic turns leave status reads and manual pause responsive", async (t) => {
  const h = await host(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  h.onDecision(() => { started(); return held; });
  await h.save();
  const ticking = h.advance(1_000);
  await didStart;
  try {
    const status = await Promise.race([h.check(), delay(500).then(() => null)]);
    assert.ok(status, "a model turn must not hold the policy queue used by UI reads");
    assert.equal(status.idleReason, "checking-todos");
    const paused = await Promise.race([
      h.save({ enabledByUser: false }), delay(500).then(() => null),
    ]);
    assert.ok(paused, "manual pause must not wait for model completion");
    assert.equal(paused.policy.enabledByUser, false);
  } finally {
    release();
    await ticking;
  }
  assert.equal(h.item.status, "PAUSED");
  assert.equal(h.persistentConversations, 0);
});
