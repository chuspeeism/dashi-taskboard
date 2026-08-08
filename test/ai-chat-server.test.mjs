import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function createServerFixture(host = "127.0.0.1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-server-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-real","display_name":"GPT Real","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer="";
  process.stdin.on("data", chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf("\\n"))>=0) { const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
      if (!line.trim()) continue; const message=JSON.parse(line);
      if (message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id===2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":null}]}]}}\\n');
    }
  });
} else {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", chunk => { prompt += chunk; });
  process.stdin.on("end", () => {
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (prompt.includes("LATE_THREAD")) {
      emit({type:"turn.started"});
      setTimeout(() => {
        emit({type:"thread.started",thread_id:"codex-late"});
        emit({type:"item.completed",item:{type:"agent_message",text:"ok"}});
        emit({type:"turn.completed"});
      }, 250);
      return;
    }
    emit({type:"thread.started",thread_id:"session-1"});
    emit({type:"item.completed",item:{type:"agent_message",text:"ok"}});
    emit({type:"turn.completed"});
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    skillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  const address = await app.listen({ host, port: 0 });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    workspace,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function privateLanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => {
      if (entry?.family !== "IPv4" || entry.internal) return false;
      const [first, second] = entry.address.split(".").map(Number);
      return first === 10
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254);
    })?.address;
}

async function requestFrom(address, port, pathname) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: address,
      port,
      path: pathname,
      headers: { host: `${address}:${port}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

function createSseReader(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async nextEvent(timeout = 5_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const separator = buffer.indexOf("\n\n");
        if (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = block.match(/^event: (.+)$/m)?.[1] ?? null;
          const data = block.match(/^data: (.+)$/m)?.[1] ?? null;
          if (event) return { event, data: data ? JSON.parse(data) : null };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for SSE event");
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE chunk")), remaining)),
        ]);
        if (result.done) throw new Error("SSE stream ended before the expected event");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
  };
}

async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for server state");
}

test("loopback AI API freezes server-owned origin and rejects injected execution fields", async () => {
  const fixture = await createServerFixture();
  try {
    const meta = await request(fixture.baseUrl, "/api/meta");
    assert.equal(meta.body.capabilities.localAiChat, true);
    const catalog = await request(fixture.baseUrl, "/api/local/ai/catalog?projectId=local");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.models[0].slug, "gpt-real");
    assert.equal(catalog.body.skills[0].id, "real-skill");

    const injected = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", workspacePath: "/tmp/evil", argv: ["--dangerously-bypass-approvals-and-sandbox"] },
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "high",
        sandbox: "read-only",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.workspace);
    const threadId = created.body.thread.id;

    const invalidSkill = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["invented-skill"] },
    });
    assert.equal(invalidSkill.response.status, 400);
    assert.equal(invalidSkill.body.error.code, "INVALID_SKILL");

    const injectedExecutionFields = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${threadId}/turns`,
      {
        method: "POST",
        body: {
          message: "hello",
          outputSchema: { type: "object" },
          dispatchKey: "client-controlled",
        },
      },
    );
    assert.equal(injectedExecutionFields.response.status, 400);
    assert.equal(injectedExecutionFields.body.error.code, "UNKNOWN_FIELD");

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["real-skill"] },
    });
    assert.equal(turn.response.status, 202);
    assert.equal(turn.body.run.threadId, threadId);

    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.thread.codexThreadId, "session-1");
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
  } finally {
    await fixture.close();
  }
});

test("creating a todo top-level main task enters readiness before planner dispatch", async () => {
  const fixture = await createServerFixture();
  fixture.app.aiChat.getCatalog = async () => ({
    models: [
      {
        slug: "gpt-5.6-sol",
        displayName: "Sol",
        description: "",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["xhigh", "max"],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      },
      {
        slug: "gpt-5.6-terra",
        displayName: "Terra",
        description: "",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["max"],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      },
    ],
    skills: [],
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  });
  const originalStartTurn = fixture.app.aiChat.startTurn.bind(fixture.app.aiChat);
  let releaseStart;
  const startEntered = new Promise((resolve) => {
    fixture.app.aiChat.startTurn = async (...args) => {
      resolve();
      await new Promise((release) => {
        releaseStart = release;
      });
      return originalStartTurn(...args);
    };
  });
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Todo main created by API",
        status: "todo",
        labels: ["主任务"],
        assigneeTarget: "codex-agent",
      },
    });
    assert.equal(created.response.status, 201);
    await startEntered;
    const readiness = fixture.app.database.getTaskReadinessReview(created.body.task.id);
    assert.ok(readiness);
    const thread = fixture.app.aiChat.getThread(readiness.aiThreadId);
    assert.equal(thread.role, "planner");
    assert.equal(thread.model, "gpt-5.6-sol");
    assert.equal(thread.sandbox, "read-only");
    assert.equal(fixture.app.database.getTaskOrchestration(created.body.task.id), null);
  } finally {
    releaseStart?.();
    await fixture.close();
  }
});

test("task threads keep role and sandbox fixed while runtime settings remain user-selectable", async () => {
  const fixture = await createServerFixture();
  try {
    fixture.app.aiChat.getCatalog = async () => ({
      models: [
        {
          slug: "gpt-5.6-sol",
          displayName: "Sol",
          description: "",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: ["low", "max"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        {
          slug: "gpt-5.6-terra",
          displayName: "Terra",
          description: "",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: ["max"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        {
          slug: "gpt-real",
          displayName: "Real",
          description: "",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low"],
          serviceTiers: [],
        },
      ],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
    const main = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId: "local", title: "Main", labels: ["主任务"] },
    });
    const child = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId: "local", title: "Child" },
    });
    const related = await request(
      fixture.baseUrl,
      `/api/tasks/${child.body.task.id}/relations/parent/${main.body.task.id}`,
      {
        method: "POST",
        body: { version: child.body.task.version },
      },
    );
    assert.equal(related.response.status, 200);

    const mismatchedPlanner = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        issueId: main.body.task.id,
        role: "worker",
        model: "gpt-real",
        reasoningEffort: "low",
        serviceTier: "standard",
        sandbox: "workspace-write",
      },
    });
    assert.equal(mismatchedPlanner.response.status, 409);
    assert.equal(mismatchedPlanner.body.error.code, "TASK_STRATEGY_LOCKED");

    const planner = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", issueId: main.body.task.id },
    });
    assert.equal(planner.response.status, 201);
    assert.deepEqual(
      {
        role: planner.body.thread.role,
        model: planner.body.thread.model,
        reasoningEffort: planner.body.thread.reasoningEffort,
        serviceTier: planner.body.thread.serviceTier,
        sandbox: planner.body.thread.sandbox,
      },
      {
        role: "planner",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        serviceTier: null,
        sandbox: "read-only",
      },
    );

    const worker = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", issueId: child.body.task.id },
    });
    assert.equal(worker.response.status, 201);
    assert.equal(worker.body.thread.role, "worker");
    assert.equal(worker.body.thread.model, "gpt-5.6-luna");

    const updated = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${planner.body.thread.id}`,
      {
        method: "PATCH",
        body: { reasoningEffort: "low" },
      },
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.reasoningEffort, "low");

    const fast = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${planner.body.thread.id}`,
      {
        method: "PATCH",
        body: { serviceTier: "priority" },
      },
    );
    assert.equal(fast.response.status, 200);
    assert.equal(fast.body.thread.serviceTier, "priority");

    const standard = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${planner.body.thread.id}`,
      {
        method: "PATCH",
        body: { serviceTier: null },
      },
    );
    assert.equal(standard.response.status, 200);
    assert.equal(standard.body.thread.serviceTier, null);

    const selectedPlannerModel = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${planner.body.thread.id}`,
      {
        method: "PATCH",
        body: { model: "gpt-real" },
      },
    );
    assert.equal(selectedPlannerModel.response.status, 200);
    assert.equal(selectedPlannerModel.body.thread.model, "gpt-real");

    const rejectedSandbox = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${planner.body.thread.id}`,
      {
        method: "PATCH",
        body: { sandbox: "workspace-write" },
      },
    );
    assert.equal(rejectedSandbox.response.status, 409);
    assert.equal(rejectedSandbox.body.error.code, "TASK_STRATEGY_LOCKED");

    const selectedWorkerRuntime = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${worker.body.thread.id}`,
      {
        method: "PATCH",
        body: { model: "gpt-real", reasoningEffort: "low", serviceTier: null },
      },
    );
    assert.equal(selectedWorkerRuntime.response.status, 200);
    assert.equal(selectedWorkerRuntime.body.thread.model, "gpt-real");
    assert.equal(selectedWorkerRuntime.body.thread.reasoningEffort, "low");
    assert.equal(selectedWorkerRuntime.body.thread.serviceTier, null);

    for (const body of [
      { role: "planner" },
      { sandbox: "read-only" },
    ]) {
      const workerUpdate = await request(
        fixture.baseUrl,
        `/api/local/ai/threads/${worker.body.thread.id}`,
        { method: "PATCH", body },
      );
      assert.equal(workerUpdate.response.status, 409, JSON.stringify(body));
      assert.equal(workerUpdate.body.error.code, "TASK_STRATEGY_LOCKED", JSON.stringify(body));
    }

    const unsupportedTier = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "low",
        serviceTier: "priority",
      },
    });
    assert.equal(unsupportedTier.response.status, 400);
    assert.equal(unsupportedTier.body.error.code, "INVALID_SERVICE_TIER");
  } finally {
    await fixture.close();
  }
});

test("delivery re-review uses an unbound Sol thread and writes the result back without leaving review", async () => {
  const fixture = await createServerFixture();
  try {
    fixture.app.aiChat.getCatalog = async () => ({
      models: [{
        slug: "gpt-5.6-sol",
        displayName: "Sol",
        description: "Review fixture",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["xhigh"],
        serviceTiers: [],
      }],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
    const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
    const task = fixture.app.database.createTask({
      projectId: "local",
      title: "Review delivery",
      description: "",
      status: "in_review",
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const requestComment = fixture.app.database.createComment(task.id, {
      body: "Tell me what to accept",
      intent: "discussion",
      action: "review",
      actor,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: "local",
      issueId: task.id,
      title: `${task.identifier} · 交付重新审核`,
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: null,
      sandbox: "read-only",
    });
    assert.equal(thread.origin.issueId, undefined);
    fixture.app.database.updateComment(
      requestComment.id,
      requestComment.version,
      requestComment.body,
      null,
      thread.id,
    );

    await fixture.app.aiChat.startTurn(thread.id, { message: "Review the delivery" });
    await waitFor(() => fixture.app.database.listComments(task.id).length === 2);

    const comments = fixture.app.database.listComments(task.id);
    assert.equal(fixture.app.database.getTask(task.id).status, "in_review");
    assert.equal(comments[1].authorType, "agent");
    assert.equal(comments[1].aiThreadId, thread.id);
    assert.match(comments[1].body, /## 交付重新审核\n\nok/);
  } finally {
    await fixture.close();
  }
});

test("readiness completion does not start a public worker turn for an orchestrated child", async () => {
  const fixture = await createServerFixture();
  try {
    const database = fixture.app.database;
    const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
    const codexActor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const parent = database.createTask({
      projectId: "local",
      title: "Orchestrated parent",
      description: "Parent owns worker dispatch",
      status: "todo",
      priority: "none",
      labels: ["主任务"],
      actor,
      assignee: codexActor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    database.beginTaskOrchestration(parent.id, "orchestrated-parent-planner");
    const child = database.applyTaskPlan(parent.id, {
      children: [{
        childKey: "owned-child",
        title: "Owned child",
        description: "Only TaskCoordinator may start this worker",
        acceptance: ["no public turn is created"],
        ownership: "owned-team",
        files: ["src/owned-child"],
        dependsOn: [],
      }],
    }).children[0];
    const task = database.getTask(child.taskId);
    const threadCount = database.listAiChatThreads({ archived: "all" }).length;
    const commentCount = database.listComments(task.id).length;

    await fixture.app.taskReadinessCoordinator.onReady(task);

    assert.equal(database.listAiChatThreads({ archived: "all" }).length, threadCount);
    assert.equal(database.listComments(task.id).length, commentCount);
    assert.equal(database.getTask(task.id).status, task.status);
  } finally {
    await fixture.close();
  }
});

test("late worker thread ids refresh the global execution event and overview without planner leakage", async () => {
  const fixture = await createServerFixture();
  const controller = new AbortController();
  try {
    fixture.app.aiChat.getCatalog = async () => ({
      models: [
        {
          slug: "gpt-5.6-sol",
          displayName: "Sol",
          description: "Planner fixture",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: ["max"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        {
          slug: "gpt-5.6-terra",
          displayName: "Terra",
          description: "Worker fixture",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: ["max"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
    const database = fixture.app.database;
    const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
    const createTask = (title, status, labels = []) => database.createTask({
      projectId: "local",
      title,
      description: "LATE_THREAD",
      status,
      priority: "none",
      labels,
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const parent = createTask("Delayed parent", "backlog", ["主任务"]);
    const child = createTask("Delayed worker", "todo");
    database.addTaskRelation(child.id, child.version, "parent", parent.id);
    database.beginTaskOrchestration(parent.id, "late-planner");
    database.updateTaskOrchestration(parent.id, { status: "planned" });
    const timestamp = new Date().toISOString();
    database.database.prepare(`
      INSERT INTO task_orchestration_children (
        parent_task_id, child_key, task_id, title, description,
        acceptance_json, ownership_json, files_json, depends_on_json, created_at, updated_at
      ) VALUES (?, 'late-worker', ?, ?, ?, '[]', ?, '[]', '[]', ?, ?)
    `).run(
      parent.id,
      child.id,
      child.title,
      child.description,
      JSON.stringify("worker"),
      timestamp,
      timestamp,
    );

    const response = await fetch(`${fixture.baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const sse = createSseReader(response.body.getReader());
    const initialEventPromise = sse.nextEvent();
    const reconcilePromise = fixture.app.taskCoordinator.reconcile({ parentId: parent.id });
    const initialEvent = await initialEventPromise;
    assert.equal(initialEvent.event, "task.execution.updated");
    assert.equal(initialEvent.data.projectId, "local");
    assert.equal(initialEvent.data.taskId, child.id);
    assert.equal(initialEvent.data.parentId, parent.id);
    assert.equal(typeof initialEvent.data.aiThreadId, "string");
    assert.notEqual(initialEvent.data.aiThreadId.length, 0);
    assert.equal(initialEvent.data.codexThreadId, null);
    await reconcilePromise;

    const whileRunning = await request(
      fixture.baseUrl,
      `/api/local/ai/tasks/${parent.id}/execution-overview`,
    );
    assert.equal(whileRunning.response.status, 200);
    assert.equal(whileRunning.body.overview.children[0].codexThreadId, null);

    let refreshedEvent;
    do {
      refreshedEvent = await sse.nextEvent();
    } while (refreshedEvent.event !== "task.execution.updated");
    assert.equal(refreshedEvent.event, "task.execution.updated");
    assert.equal(refreshedEvent.data.projectId, "local");
    assert.equal(refreshedEvent.data.taskId, child.id);
    assert.equal(refreshedEvent.data.parentId, parent.id);
    assert.equal(refreshedEvent.data.aiThreadId, initialEvent.data.aiThreadId);
    assert.equal(refreshedEvent.data.codexThreadId, "codex-late");

    const refreshedOverview = await request(
      fixture.baseUrl,
      `/api/local/ai/tasks/${parent.id}/execution-overview`,
    );
    assert.equal(refreshedOverview.body.overview.children[0].aiThreadId, initialEvent.data.aiThreadId);
    assert.equal(refreshedOverview.body.overview.children[0].codexThreadId, "codex-late");

    const workerDispatch = database.getTaskDispatch(
      `task-orchestration:${parent.id}:late-worker:worker`,
    );
    await waitFor(() => {
      const currentDispatch = database.getTaskDispatch(workerDispatch.dispatchKey);
      return currentDispatch?.runId !== null
        && database.getAiChatRun(currentDispatch.runId)?.status !== "running";
    });
    await waitFor(() => {
      const handoffs = database.listTaskHandoffs(parent.id);
      const activeThread = database.listAiChatThreads({ archived: "all" })
        .some((thread) => thread.currentRun?.status === "running");
      return handoffs.length > 0
        && handoffs.every((handoff) => !["pending", "processing", "attempt_pending"].includes(handoff.queueStatus))
        && fixture.app.taskCoordinator.reconcileChains.size === 0
        && !activeThread;
    });

    const plannerThread = database.createAiChatThread({
      id: "planner-no-worker-event",
      title: `${parent.identifier} planner`,
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: fixture.workspace,
        issueId: parent.id,
        issueIdentifier: parent.identifier,
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "read-only",
    });
    database.bindTaskDispatch("late-planner", { threadId: plannerThread.id });
    const plannerRun = await fixture.app.aiChat.startTurn(
      plannerThread.id,
      { message: "LATE_THREAD planner" },
      { dispatchKey: "late-planner", kind: "planner" },
    );
    await waitFor(() => fixture.app.aiChat.getRun(plannerRun.id).status !== "running");
    await waitFor(() => {
      const handoffs = database.listTaskHandoffs(parent.id);
      const activeThread = database.listAiChatThreads({ archived: "all" })
        .some((thread) => thread.currentRun?.status === "running");
      return handoffs.length > 0
        && handoffs.every((handoff) => !["pending", "processing", "attempt_pending"].includes(handoff.queueStatus))
        && fixture.app.taskCoordinator.reconcileChains.size === 0
        && !activeThread;
    });
    const plannerEvents = [];
    for (;;) {
      try {
        plannerEvents.push(await sse.nextEvent(75));
      } catch {
        break;
      }
    }
    assert.equal(
      plannerEvents.some((event) => event.event === "task.execution.updated"),
      false,
      "planner dispatch must not publish a worker execution update",
    );

    const ordinaryThread = database.createAiChatThread({
      id: "ordinary-no-issue-event",
      title: "Ordinary conversation",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: fixture.workspace,
      },
      role: "worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    database.claimTaskDispatch({
      dispatchKey: "ordinary-no-issue",
      kind: "worker",
      role: "worker",
    });
    const ordinaryRun = await fixture.app.aiChat.startTurn(
      ordinaryThread.id,
      { message: "LATE_THREAD ordinary" },
      { dispatchKey: "ordinary-no-issue", kind: "worker" },
    );
    await waitFor(() => fixture.app.aiChat.getRun(ordinaryRun.id).status !== "running");
    const ordinaryEvents = [];
    for (;;) {
      try {
        ordinaryEvents.push(await sse.nextEvent(75));
      } catch {
        break;
      }
    }
    assert.equal(
      ordinaryEvents.some((event) => event.event === "task.execution.updated"),
      false,
      "an ordinary no-issue thread must not publish an execution update",
    );
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("task archive API blocks any active task-bound run without changing DB or files", async () => {
  const fixture = await createServerFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  try {
    const database = fixture.app.database;
    const task = database.createTask({
      id: "archive-api-running-task",
      projectId: "local",
      title: "Archive API running task",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
      threadId: "archive-api-running-thread",
    });
    const thread = database.createAiChatThread({
      id: "archive-api-running-thread",
      title: task.identifier,
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: fixture.workspace,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      role: "worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    const run = database.createAiChatRunIdempotently({ threadId: thread.id }).run;
    const attachmentId = "archive-api-running-attachment";
    await mkdir(fixture.app.options.attachmentsDirectory, { recursive: true });
    const attachmentPath = path.join(fixture.app.options.attachmentsDirectory, attachmentId);
    await writeFile(attachmentPath, "must survive");
    const attachment = database.createAttachment(task.id, {
      id: attachmentId,
      filename: "must-survive.txt",
      contentType: "text/plain",
      size: 12,
    });
    const beforeTask = database.getTask(task.id);
    const beforeThread = database.getAiChatThread(thread.id);
    let interruptCalls = 0;
    const originalInterrupt = fixture.app.aiChat.interrupt.bind(fixture.app.aiChat);
    fixture.app.aiChat.interrupt = async (...args) => {
      interruptCalls += 1;
      return originalInterrupt(...args);
    };

    const archived = await request(fixture.baseUrl, `/api/tasks/${task.id}/archive`, {
      method: "POST",
      body: { version: task.version },
    });
    assert.equal(archived.response.status, 409);
    assert.equal(archived.body.error.code, "TASK_ARCHIVE_BLOCKED");
    assert.deepEqual(database.getTask(task.id), beforeTask);
    assert.deepEqual(database.getAiChatThread(thread.id), beforeThread);
    assert.deepEqual(database.getAiChatRun(run.id), run);
    assert.deepEqual(database.getAttachment(attachment.id), attachment);
    assert.equal(await readFile(attachmentPath, "utf8"), "must survive");
    assert.equal(interruptCalls, 0);

    database.settleAiChatRun(run.id, {
      status: "failed",
      error: "fixture cleanup",
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await fixture.close();
  }
});

test("danger-full-access requires confirmation on every turn and thread settings are validated", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "low",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const denied = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error.code, "DANGER_CONFIRMATION_REQUIRED");
    const allowed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello", dangerFullAccessConfirmed: true },
    });
    assert.equal(allowed.response.status, 202);

    const invalidModel = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { model: "invented-model", reasoningEffort: "high" },
    });
    assert.equal(invalidModel.response.status, 400);
    assert.equal(invalidModel.body.error.code, "INVALID_MODEL");
  } finally {
    await fixture.close();
  }
});

test("thread management, soft archive/restore, interrupt and query contracts stay narrow", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", title: "Original" },
    });
    const threadId = created.body.thread.id;

    const list = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.threads.some((thread) => thread.id === threadId), true);

    const unknownQuery = await request(fixture.baseUrl, "/api/local/ai/threads?projectId=local");
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const updated = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { title: "Renamed", sandbox: "workspace-write" },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.title, "Renamed");

    const interruptedMissing = await request(fixture.baseUrl, "/api/local/ai/runs/missing/interrupt", {
      method: "POST",
    });
    assert.equal(interruptedMissing.response.status, 404);

    const removed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 204);
    const archivedSnapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(archivedSnapshot.response.status, 200);
    assert.notEqual(archivedSnapshot.body.thread.archivedAt, null);
    const activeAfterArchive = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(activeAfterArchive.body.threads.some((thread) => thread.id === threadId), false);
    const archivedList = await request(fixture.baseUrl, "/api/local/ai/threads?archived=true");
    assert.equal(archivedList.body.threads.some((thread) => thread.id === threadId), true);
    const restored = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/restore`, {
      method: "POST",
      body: { version: archivedSnapshot.body.thread.version },
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.thread.archivedAt, null);
  } finally {
    await fixture.close();
  }
});

test("local AI routes reject private-LAN clients while ordinary API routes remain available", async (context) => {
  const address = privateLanAddress();
  if (!address) {
    context.skip("No private LAN interface is available");
    return;
  }
  const fixture = await createServerFixture("0.0.0.0");
  const port = fixture.app.server.address().port;
  try {
    const projects = await requestFrom(address, port, "/api/projects");
    assert.equal(projects.status, 200);
    const metadata = await requestFrom(address, port, "/api/meta");
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.capabilities.localAiChat, false);
    const ai = await requestFrom(address, port, "/api/local/ai/threads");
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("AI SSE is live-only and thread snapshots remain the durable source", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    const threadId = created.body.thread.id;
    const controller = new AbortController();
    const response = await fetch(`${fixture.baseUrl}/api/local/ai/threads/${threadId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let connected = "";
    while (!connected.includes("event: ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      connected += new TextDecoder().decode(chunk.value);
    }
    assert.match(connected, /connected/);
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 202);
    let streamed = "";
    while (!streamed.includes("ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, /event: ai\.(event|run)/);
    controller.abort();
  } finally {
    await fixture.close();
  }
});

test("server close stops accepting requests before AI shutdown completes", async () => {
  const fixture = await createServerFixture();
  const threadUpdatedListeners = fixture.app.aiChat.threadUpdatedListeners;
  let appClosed = false;
  try {
    let releaseAiClose;
    const aiCloseGate = new Promise((resolve) => {
      releaseAiClose = resolve;
    });
    fixture.app.aiChat.close = () => aiCloseGate;

    const closing = fixture.app.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const acceptedDuringClose = await fetch(`${fixture.baseUrl}/health`)
      .then(() => true, () => false);
    releaseAiClose();
    await closing;
    appClosed = true;

    assert.equal(acceptedDuringClose, false);
    assert.equal(threadUpdatedListeners.size, 0);
  } finally {
    if (appClosed) {
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      await fixture.close();
    }
  }
});
