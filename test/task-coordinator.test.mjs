import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import {
  TASK_HANDOFF_OUTPUT_SCHEMA,
  TASK_PLAN_OUTPUT_SCHEMA,
  TaskCoordinator,
} from "../server/task-coordinator.mjs";

const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for coordinator state");
}

function createTask(database, input) {
  return database.createTask({
    projectId: "project",
    description: "",
    status: "backlog",
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    ...input,
  });
}

function createWorkerThread(database, task, id = undefined) {
  const project = database.getProject(task.projectId);
  return database.createAiChatThread({
    id,
    title: task.identifier,
    origin: {
      projectId: project.id,
      projectName: project.name,
      workspacePath: "/tmp/task-coordinator-workspace",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    role: "worker",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    serviceTier: "priority",
    sandbox: "workspace-write",
  });
}

function plan(children) {
  return { children };
}

function handoffSolution(handoff, action, extra = {}) {
  return {
    handoffId: handoff.id,
    sourceTaskVersion: handoff.sourceTaskVersion,
    sourceTaskStatus: handoff.sourceTaskStatus,
    action,
    summary: extra.summary ?? action,
    ...extra,
  };
}

function assertStrictResponseSchema(schema, path = "$") {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" || schema.properties) {
    assert.equal(schema.additionalProperties, false, `${path} must reject additional properties`);
    const propertyNames = Object.keys(schema.properties ?? {}).sort();
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      propertyNames,
      `${path}.required must contain every property exactly once`,
    );
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assertStrictResponseSchema(property, `${path}.properties.${name}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        assertStrictResponseSchema(item, `${path}.${key}[${index}]`);
      }
    } else {
      assertStrictResponseSchema(value, `${path}.${key}`);
    }
  }
}

test("handoff planner output schema is recursively strict for Codex response_format", () => {
  assertStrictResponseSchema(TASK_HANDOFF_OUTPUT_SCHEMA);
});

test("strict nullable remediation fields preserve the existing no-transfer semantics", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Nullable remediation parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-nullable-remediation");
    const child = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "nullable-source",
      title: "Nullable source",
      description: "Nullable source",
      acceptance: ["blocked is handed off"],
      ownership: "source-team",
      files: ["src/nullable-source"],
      dependsOn: [],
    }])).children[0];
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    aiChat.settleServer(aiChat.started[0].run.id, "failed", "worker blocked", {
      error: "worker blocked",
    });
    await waitFor(() => aiChat.started.length === 2);
    const handoff = fixture.database.listTaskHandoffs(parent.id)[0];
    const solution = handoffSolution(handoff, "create_remediation", {
      instructions: null,
      remediation: {
        childKey: null,
        title: "Nullable remediation",
        description: "Continue the bounded work",
        acceptance: ["the bounded work is verified"],
        ownership: "remediation-team",
        files: ["src/nullable-remediation"],
        scopeTransfer: null,
        dependsOn: null,
      },
    });
    aiChat.settle(aiChat.started[1].run.id, JSON.stringify(solution));
    await waitFor(() => fixture.database.getTaskHandoff(handoff.id).queueStatus === "resolved");
    const children = fixture.database.getTaskOrchestration(parent.id).children;
    const remediation = children.find((entry) => entry.title === "Nullable remediation");
    assert.ok(remediation);
    assert.deepEqual(remediation.files, ["src/nullable-remediation"]);
    assert.equal(fixture.database.getTask(child.taskId).status, "blocked");
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

class FakeAiChat {
  constructor(database, options = {}) {
    this.database = database;
    this.listeners = new Set();
    this.started = [];
    this.failNextStart = options.failNextStart === true;
    this.beforeCreateThreadResolve = options.beforeCreateThreadResolve ?? null;
    this.afterCreateThread = options.afterCreateThread ?? null;
  }

  subscribeRunSettled(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createThread(input) {
    const task = this.database.getTask(input.issueId);
    const role = task?.labels.includes("主任务") && !task.relations.parent ? "planner" : "worker";
    const existing = this.database.findReusableAiChatThread(input.issueId, role);
    if (existing) {
      this.beforeCreateThreadResolve?.({ input, thread: existing });
      return existing;
    }
    const project = this.database.getProject(input.projectId);
    const created = this.database.createAiChatThread({
      title: input.title ?? task.identifier,
      origin: {
        projectId: project.id,
        projectName: project.name,
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      role,
      model: role === "planner" ? "gpt-5.6-sol" : "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: role === "planner" ? "read-only" : "workspace-write",
    });
    await this.afterCreateThread?.({ input, thread: created });
    return created;
  }

  async startTurn(threadId, input, internalOptions) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("fake worker executable unavailable");
    }
    const result = this.database.createAiChatRunIdempotently({
      threadId,
      dispatchKey: internalOptions.dispatchKey,
    });
    if (!result.created) return result.run;
    this.started.push({ threadId, input, internalOptions, run: result.run });
    return result.run;
  }

  settle(runId, assistantText = "", { notify = true } = {}) {
    const current = this.database.getAiChatRun(runId);
    const run = this.database.updateAiChatRun(runId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    if (assistantText) {
      this.database.insertAiChatEvent({
        threadId: current.threadId,
        runId,
        type: "agent_message",
        role: "assistant",
        content: assistantText,
      });
    }
    const payload = {
      run,
      thread: this.database.getAiChatThread(run.threadId),
      assistantText,
    };
    if (notify) {
      queueMicrotask(() => {
        for (const listener of this.listeners) void listener(payload);
      });
    }
    return run;
  }

  settleServer(runId, status = "completed", assistantText = "", { notify = true, error = null } = {}) {
    const settled = this.database.settleAiChatRun(runId, {
      status,
      error,
      assistantText,
      finishedAt: new Date().toISOString(),
    });
    const payload = {
      ...settled,
      run: settled.run,
      thread: this.database.getAiChatThread(settled.run.threadId),
      assistantText,
    };
    if (notify) {
      queueMicrotask(() => {
        for (const listener of this.listeners) void listener(payload);
      });
    }
    return settled.run;
  }
}

class SolStartFailAiChat extends FakeAiChat {
  constructor(database) {
    super(database);
    this.solStarts = 0;
  }

  async startTurn(threadId, input, internalOptions) {
    if (internalOptions.kind === "handoff") {
      this.solStarts += 1;
      throw new Error("Sol executable unavailable");
    }
    return super.startTurn(threadId, input, internalOptions);
  }
}

class WorkerAttemptStartFailOnceAiChat extends FakeAiChat {
  constructor(database) {
    super(database);
    this.workerAttemptStarts = 0;
    this.failWorkerAttempt = true;
  }

  async startTurn(threadId, input, internalOptions) {
    if (internalOptions.kind === "worker_attempt") {
      this.workerAttemptStarts += 1;
      if (this.failWorkerAttempt) {
        this.failWorkerAttempt = false;
        throw new Error("worker attempt executable unavailable");
      }
    }
    return super.startTurn(threadId, input, internalOptions);
  }
}

async function createDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-coordinator-test-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  return {
    database,
    databasePath,
    directory,
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("TaskCoordinator applies a planner JSON plan, schedules a DAG, and deduplicates replayed events", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Main task",
      labels: ["主任务"],
    });
    const moved = fixture.database.moveTask(parent.id, parent.version, "todo");
    const aiChat = new FakeAiChat(fixture.database);
    const emitted = [];
    const coordinator = new TaskCoordinator({
      database: fixture.database,
      aiChat,
      emit: (type, payload) => emitted.push({ type, payload, started: aiChat.started.length }),
    });

    await coordinator.handleEvent("task.moved", {
      task: moved,
      fromStatus: "todo",
      readinessApproved: true,
    });
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, `task-orchestration:${parent.id}:planner`);
    assert.deepEqual(aiChat.started[0].internalOptions.outputSchema, TASK_PLAN_OUTPUT_SCHEMA);
    assert.equal(fixture.database.listTaskOrchestrations()[0].status, "planning");

    const plannerRun = aiChat.started[0].run;
    aiChat.settle(plannerRun.id, JSON.stringify(plan([
      {
        childKey: "a",
        title: "A",
        description: "A work",
        acceptance: ["A is verified"],
        ownership: "team-a",
        files: ["src/a"],
        dependsOn: [],
      },
      {
        childKey: "b",
        title: "B",
        description: "B work",
        acceptance: ["B is verified"],
        ownership: "team-b",
        files: ["src/b"],
        dependsOn: ["a"],
      },
      {
        childKey: "c",
        title: "C",
        description: "C work",
        acceptance: ["C is verified"],
        ownership: "team-c",
        files: ["src/c"],
        dependsOn: ["b"],
      },
    ])));
    await waitFor(() => fixture.database.getTaskOrchestration(parent.id)?.status === "planned");
    assert.equal(aiChat.started.length, 2);
    assert.equal(aiChat.started[1].internalOptions.dispatchKey.endsWith(":a:worker"), true);
    assert.equal(fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:b:worker`), null);

    const children = fixture.database.getTaskOrchestration(parent.id).children;
    const childA = fixture.database.getTask(children.find((child) => child.childKey === "a").taskId);
    const childB = fixture.database.getTask(children.find((child) => child.childKey === "b").taskId);
    const childC = fixture.database.getTask(children.find((child) => child.childKey === "c").taskId);
    assert.equal(childA.status, "in_progress");
    assert.equal(childB.status, "backlog");
    assert.equal(childC.status, "backlog");
    const workerStartedEvent = emitted.find((event) => (
      event.type === "task.moved" && event.payload.task?.id === childA.id
    ));
    assert.equal(workerStartedEvent.started, 2);
    assert.equal(
      fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:a:worker`).status,
      "running",
    );

    await coordinator.handleEvent("task.moved", {
      task: moved,
      fromStatus: "backlog",
      readinessApproved: true,
    });
    await coordinator.reconcile({ parentId: parent.id });
    assert.equal(aiChat.started.length, 2);

    const workerA = aiChat.started[1].run;
    aiChat.settleServer(workerA.id, "completed", "worker A delivered");
    const reviewedA = fixture.database.getTask(childA.id);
    await coordinator.handleEvent("task.moved", { task: reviewedA, fromStatus: "in_progress" });
    await waitFor(() => aiChat.started.length === 3);
    assert.deepEqual(aiChat.started[2].internalOptions.outputSchema, TASK_HANDOFF_OUTPUT_SCHEMA);
    const firstSolHandoff = fixture.database.listTaskHandoffs(parent.id)[0];
    aiChat.settle(aiChat.started[2].run.id, JSON.stringify(handoffSolution(firstSolHandoff, "acknowledge", {
      summary: "worker A delivery confirmed",
    })));
    await waitFor(() => aiChat.started.length === 4);
    assert.equal(aiChat.started[3].internalOptions.dispatchKey.endsWith(":b:worker"), true);

    const workerB = aiChat.started[3].run;
    aiChat.settleServer(workerB.id, "completed", "worker B delivered");
    await waitFor(() => aiChat.started.length === 5);
    const secondSolHandoff = fixture.database.listTaskHandoffs(parent.id)
      .find((handoff) => handoff.queueStatus === "processing");
    aiChat.settle(aiChat.started[4].run.id, JSON.stringify(handoffSolution(secondSolHandoff, "acknowledge", {
      summary: "worker B delivery confirmed",
    })));
    await waitFor(() => fixture.database.listTaskHandoffs(parent.id)
      .find((handoff) => handoff.id === secondSolHandoff.id)?.queueStatus === "resolved");
    const reviewedB = fixture.database.moveTask(childB.id, fixture.database.getTask(childB.id).version, "done");
    await coordinator.handleEvent("task.moved", { task: reviewedB, fromStatus: "in_progress" });
    await waitFor(() => aiChat.started.length === 6);
    assert.equal(aiChat.started[5].internalOptions.dispatchKey.endsWith(":c:worker"), true);
    assert.equal(fixture.database.getTask(childC.id).status, "in_progress");
    coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("task.created todo main tasks enter orchestration synchronously before event consumers return", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Created todo main task",
      status: "todo",
      labels: ["主任务"],
    });
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    const pending = coordinator.handleEvent("task.created", {
      task: parent,
      readinessApproved: true,
    });
    assert.equal(
      fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:planner`).status,
      "claimed",
    );
    await pending;
    assert.equal(aiChat.started.length, 1);
    assert.deepEqual(aiChat.started[0].internalOptions.outputSchema, TASK_PLAN_OUTPUT_SCHEMA);
    coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a resume comment retries a failed main-task planner through a new server dispatch", async () => {
  const fixture = await createDatabase();
  try {
    let parent = createTask(fixture.database, {
      title: "Resume failed main task",
      status: "todo",
      labels: ["主任务"],
    });
    const originalDispatchKey = `task-orchestration:${parent.id}:planner`;
    fixture.database.beginTaskOrchestration(parent.id, originalDispatchKey);
    const aiChat = new FakeAiChat(fixture.database);
    const plannerThread = await aiChat.createThread({
      projectId: parent.projectId,
      issueId: parent.id,
      title: `${parent.identifier} planner`,
    });
    fixture.database.updateTaskOrchestration(parent.id, { plannerThreadId: plannerThread.id });
    fixture.database.bindTaskDispatch(originalDispatchKey, { threadId: plannerThread.id });
    fixture.database.markTaskOrchestrationFailed(parent.id, "Timed out while reading Codex skills");

    parent = fixture.database.getTask(parent.id);
    parent = fixture.database.moveTask(parent.id, parent.version, "todo");
    const reviewThread = fixture.database.createAiChatThread({
      title: `${parent.identifier} readiness`,
      origin: {
        projectId: parent.projectId,
        projectName: "Project",
        workspacePath: "/tmp/task-coordinator-workspace",
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: null,
      sandbox: "read-only",
    });
    const review = fixture.database.beginTaskReadinessReview(parent.id, {
      aiThreadId: reviewThread.id,
    });
    fixture.database.settleTaskReadinessReview(parent.id, review.round, {
      status: "ready",
      decision: {
        decision: "ready",
        summary: "Ready to resume",
        confirmed: [],
        assumptions: [],
        questions: [],
      },
    });
    const comment = fixture.database.createComment(parent.id, {
      body: "继续开发",
      intent: "resume",
      actor,
    });
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.handleEvent("comment.created", {
      comment,
      task: fixture.database.getTask(parent.id),
    });

    const retryDispatchKey = `${originalDispatchKey}:resume:${comment.id}`;
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].threadId, plannerThread.id);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, retryDispatchKey);
    assert.deepEqual(aiChat.started[0].internalOptions.outputSchema, TASK_PLAN_OUTPUT_SCHEMA);
    assert.equal(fixture.database.getTaskDispatch(originalDispatchKey).status, "failed");
    assert.equal(fixture.database.getTaskDispatch(retryDispatchKey).status, "running");
    assert.equal(fixture.database.getTaskOrchestration(parent.id).status, "planning");

    await coordinator.handleEvent("comment.created", {
      comment,
      task: fixture.database.getTask(parent.id),
    });
    assert.equal(aiChat.started.length, 1);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a readiness-approved event retries a failed main-task planner once", async () => {
  const fixture = await createDatabase();
  try {
    let parent = createTask(fixture.database, {
      title: "Resume failed main task after readiness",
      status: "todo",
      labels: ["主任务"],
    });
    const originalDispatchKey = `task-orchestration:${parent.id}:planner`;
    fixture.database.beginTaskOrchestration(parent.id, originalDispatchKey);
    const aiChat = new FakeAiChat(fixture.database);
    const plannerThread = await aiChat.createThread({
      projectId: parent.projectId,
      issueId: parent.id,
      title: `${parent.identifier} planner`,
    });
    fixture.database.updateTaskOrchestration(parent.id, { plannerThreadId: plannerThread.id });
    fixture.database.bindTaskDispatch(originalDispatchKey, { threadId: plannerThread.id });
    fixture.database.markTaskOrchestrationFailed(parent.id, "Interrupted");

    const reviewThread = fixture.database.createAiChatThread({
      title: `${parent.identifier} readiness`,
      origin: {
        projectId: parent.projectId,
        projectName: "Project",
        workspacePath: "/tmp/task-coordinator-workspace",
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: null,
      sandbox: "read-only",
    });
    const review = fixture.database.beginTaskReadinessReview(parent.id, {
      aiThreadId: reviewThread.id,
    });
    fixture.database.settleTaskReadinessReview(parent.id, review.round, {
      status: "ready",
      decision: {
        decision: "ready",
        summary: "Ready to resume",
        confirmed: [],
        assumptions: [],
        questions: [],
      },
    });
    parent = fixture.database.getTask(parent.id);
    parent = fixture.database.moveTask(parent.id, parent.version, "todo");
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    const event = {
      task: parent,
      fromStatus: "todo",
      readinessApproved: true,
    };

    await coordinator.handleEvent("task.moved", event);

    const retryDispatchKey = `${originalDispatchKey}:readiness:${review.round}`;
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].threadId, plannerThread.id);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, retryDispatchKey);
    assert.deepEqual(aiChat.started[0].internalOptions.outputSchema, TASK_PLAN_OUTPUT_SCHEMA);
    assert.equal(fixture.database.getTaskDispatch(originalDispatchKey).status, "failed");
    assert.equal(fixture.database.getTaskDispatch(retryDispatchKey).status, "running");
    assert.equal(fixture.database.getTaskOrchestration(parent.id).status, "planning");

    await coordinator.handleEvent("task.moved", event);
    assert.equal(aiChat.started.length, 1);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("an existing public task run is never bound as planner output and is followed by a structured server run", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Competing public run",
      status: "todo",
      labels: ["主任务"],
    });
    const project = fixture.database.getProject(parent.projectId);
    const thread = fixture.database.createAiChatThread({
      id: "public-planner-thread",
      title: "Public planner thread",
      origin: {
        projectId: project.id,
        projectName: project.name,
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: parent.id,
        issueIdentifier: parent.identifier,
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "read-only",
    });
    const publicRun = fixture.database.createAiChatRun({
      id: "public-planner-run",
      threadId: thread.id,
      status: "running",
    });
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.handleEvent("task.moved", {
      task: parent,
      fromStatus: "backlog",
      readinessApproved: true,
    });
    const plannerDispatch = fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:planner`);
    assert.equal(plannerDispatch.runId, null);
    assert.equal(aiChat.started.length, 0);

    aiChat.settle(publicRun.id, "This is not a server planner plan");
    await waitFor(() => aiChat.started.length === 1);
    assert.notEqual(aiChat.started[0].run.id, publicRun.id);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, plannerDispatch.dispatchKey);
    assert.deepEqual(aiChat.started[0].internalOptions.outputSchema, TASK_PLAN_OUTPUT_SCHEMA);
    assert.equal(
      fixture.database.getTaskDispatch(plannerDispatch.dispatchKey).runId,
      aiChat.started[0].run.id,
    );
    coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("planner starts from the latest idle snapshot when a public run settles before thread binding", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Planner stale snapshot",
      status: "todo",
      labels: ["主任务"],
    });
    const project = fixture.database.getProject(parent.projectId);
    const thread = fixture.database.createAiChatThread({
      id: "stale-planner-thread",
      title: "Stale planner thread",
      origin: {
        projectId: project.id,
        projectName: project.name,
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: parent.id,
        issueIdentifier: parent.identifier,
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "read-only",
    });
    const publicRun = fixture.database.createAiChatRun({
      id: "stale-planner-public-run",
      threadId: thread.id,
      status: "running",
    });
    const aiChat = new FakeAiChat(fixture.database);
    aiChat.beforeCreateThreadResolve = ({ thread: candidate }) => {
      if (candidate.id !== thread.id) return;
      aiChat.beforeCreateThreadResolve = null;
      aiChat.settle(publicRun.id, "public run settled before planner binding", { notify: false });
    };
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.handleEvent("task.moved", {
      task: parent,
      fromStatus: "backlog",
      readinessApproved: true,
    });

    const plannerDispatch = fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:planner`);
    assert.equal(aiChat.started.length, 1);
    assert.notEqual(aiChat.started[0].run.id, publicRun.id);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, plannerDispatch.dispatchKey);
    assert.equal(plannerDispatch.runId, aiChat.started[0].run.id);
    assert.equal(fixture.database.getTaskOrchestration(parent.id).plannerThreadId, thread.id);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("worker starts from the latest idle snapshot when a public run settles before thread binding", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Worker stale snapshot parent",
      labels: ["主任务"],
    });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "stale-worker",
        title: "Stale worker",
        description: "Worker with a stale thread snapshot",
        acceptance: ["worker starts"],
        ownership: "stale-worker-team",
        files: ["src/stale-worker"],
        dependsOn: [],
      },
    ]));
    const child = orchestration.children[0];
    const childTask = fixture.database.getTask(child.taskId);
    const project = fixture.database.getProject(childTask.projectId);
    const thread = fixture.database.createAiChatThread({
      id: "stale-worker-thread",
      title: "Stale worker thread",
      origin: {
        projectId: project.id,
        projectName: project.name,
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: childTask.id,
        issueIdentifier: childTask.identifier,
      },
      role: "worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    const publicRun = fixture.database.createAiChatRun({
      id: "stale-worker-public-run",
      threadId: thread.id,
      status: "running",
    });
    const aiChat = new FakeAiChat(fixture.database);
    aiChat.beforeCreateThreadResolve = ({ thread: candidate }) => {
      if (candidate.id !== thread.id) return;
      aiChat.beforeCreateThreadResolve = null;
      aiChat.settle(publicRun.id, "public worker run settled before worker binding", { notify: false });
    };
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.reconcile({ parentId: parent.id });

    const workerDispatch = fixture.database.getTaskDispatch(
      `task-orchestration:${parent.id}:stale-worker:worker`,
    );
    assert.equal(aiChat.started.length, 1);
    assert.notEqual(aiChat.started[0].run.id, publicRun.id);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, workerDispatch.dispatchKey);
    assert.equal(workerDispatch.runId, aiChat.started[0].run.id);
    assert.equal(fixture.database.getTask(childTask.id).status, "in_progress");
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("plan application is idempotent and invalid plans roll back as one batch", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Plan parent", labels: ["主任务"] });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const validPlan = plan([
      {
        childKey: "one",
        title: "One",
        description: "One work",
        acceptance: ["one"],
        ownership: "team-one",
        files: ["src/one"],
        dependsOn: [],
      },
      {
        childKey: "two",
        title: "Two",
        description: "Two work",
        acceptance: ["two"],
        ownership: "team-two",
        files: ["src/two"],
        dependsOn: ["one"],
      },
    ]);
    const [first, second] = await Promise.all([
      Promise.resolve(fixture.database.applyTaskPlan(parent.id, validPlan)),
      Promise.resolve(fixture.database.applyTaskPlan(parent.id, validPlan)),
    ]);
    assert.equal(first.children.length, 2);
    assert.equal(second.children.length, 2);
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM task_orchestration_children").get().count,
      2,
    );
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM task_orchestration_dispatches").get().count,
      1,
    );

    const invalidCases = [
      plan([{ ...validPlan.children[0], childKey: "unknown", dependsOn: ["missing"] }]),
      plan([
        { ...validPlan.children[0], childKey: "cycle-a", dependsOn: ["cycle-b"] },
        { ...validPlan.children[1], childKey: "cycle-b", dependsOn: ["cycle-a"] },
      ]),
      plan([
        { ...validPlan.children[0], childKey: "file-a", files: ["src/conflict"] },
        { ...validPlan.children[1], childKey: "file-b", files: ["src/conflict"] },
      ]),
      plan([
        { ...validPlan.children[0], childKey: "owner-a", ownership: "same-owner", files: ["src/a"] },
        { ...validPlan.children[1], childKey: "owner-b", ownership: "same-owner", files: ["src/b"], dependsOn: [] },
      ]),
      plan([
        { ...validPlan.children[0], childKey: "normalized-a", files: ["./src/a.js"] },
        { ...validPlan.children[1], childKey: "normalized-b", files: [String.raw`src\a.js`], dependsOn: [] },
      ]),
      plan([
        { ...validPlan.children[0], childKey: "parent-a", files: ["src/a"] },
        { ...validPlan.children[1], childKey: "parent-b", files: ["src/a/child.js"], dependsOn: [] },
      ]),
      plan([{ ...validPlan.children[0], childKey: "absolute", files: ["/src/a.js"] }]),
      plan([{ ...validPlan.children[0], childKey: "escape", files: ["../src/a.js"] }]),
    ];
    for (const invalid of invalidCases) {
      assert.throws(() => fixture.database.applyTaskPlan(parent.id, invalid));
    }
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'project'").get().count,
      3,
    );
  } finally {
    await fixture.close();
  }
});

test("a plan adopts an exact existing child without creating a duplicate", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Adoption parent", labels: ["主任务"] });
    const existing = createTask(fixture.database, { title: "Existing child", status: "blocked" });
    fixture.database.addTaskRelation(existing.id, existing.version, "parent", parent.id);
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const taskCount = fixture.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;

    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: existing.identifier,
      title: "Adopt existing child",
      description: "Continue the existing task",
      acceptance: ["existing task is retained"],
      ownership: "existing-team",
      files: ["src/existing-child"],
      dependsOn: [],
    }]));

    assert.equal(orchestration.createdTaskIds.length, 0);
    assert.deepEqual(orchestration.adoptedTaskIds, [existing.id]);
    assert.equal(orchestration.children[0].taskId, existing.id);
    assert.equal(fixture.database.getTask(existing.id).status, "blocked");
    assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, taskCount);
    const handoff = fixture.database.listTaskHandoffs(parent.id)[0];
    assert.equal(handoff.childTaskId, existing.id);
    assert.equal(handoff.sourceKind, "task_status");
  } finally {
    await fixture.close();
  }
});

test("an exact identifier without the existing parent relation is not adopted", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Strict adoption parent", labels: ["主任务"] });
    const unrelated = createTask(fixture.database, { title: "Unrelated task" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);

    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: unrelated.identifier,
      title: "Create a new child",
      description: "The matching identifier is not a child",
      acceptance: ["new task is created"],
      ownership: "new-team",
      files: ["src/new-child"],
      dependsOn: [],
    }]));

    assert.equal(orchestration.createdTaskIds.length, 1);
    assert.equal(orchestration.adoptedTaskIds.length, 0);
    assert.notEqual(orchestration.children[0].taskId, unrelated.id);
  } finally {
    await fixture.close();
  }
});

test("plan file paths are persisted in one stable relative form", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Path normalization parent", labels: ["主任务"] });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "normalized",
        title: "Normalized",
        description: "Normalized path",
        acceptance: ["normalized"],
        ownership: "path-team",
        files: [String.raw`./src\nested/../file.js`],
        dependsOn: [],
      },
    ]));
    assert.deepEqual(orchestration.children[0].files, ["src/file.js"]);
  } finally {
    await fixture.close();
  }
});

test("dependency readiness accepts only in_review/done and failed dispatches are visible without replay", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Dependency parent", labels: ["主任务"] });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "dependency",
        title: "Dependency",
        description: "Dependency",
        acceptance: ["reviewed"],
        ownership: "team-a",
        files: ["src/dep"],
        dependsOn: [],
      },
      {
        childKey: "target",
        title: "Target",
        description: "Target",
        acceptance: ["done"],
        ownership: "team-b",
        files: ["src/target"],
        dependsOn: ["dependency"],
      },
      {
        childKey: "done-target",
        title: "Done target",
        description: "Done target",
        acceptance: ["done"],
        ownership: "team-c",
        files: ["src/done-target"],
        dependsOn: ["dependency"],
      },
    ]));
    const dependency = orchestration.children.find((child) => child.childKey === "dependency");
    const target = orchestration.children.find((child) => child.childKey === "target");
    const doneTarget = orchestration.children.find((child) => child.childKey === "done-target");
    const initial = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: target.childKey,
      taskId: target.taskId,
      dispatchKey: `task-orchestration:${parent.id}:target:worker`,
    });
    assert.equal(initial.ready, false);
    for (const status of ["blocked", "canceled"]) {
      const current = fixture.database.getTask(dependency.taskId);
      fixture.database.moveTask(dependency.taskId, current.version, status);
      const result = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: target.childKey,
        taskId: target.taskId,
        dispatchKey: `task-orchestration:${parent.id}:target:${status}`,
      });
      assert.equal(result.ready, false);
      assert.equal(result.reason, "DEPENDENCY_NOT_SATISFIED");
      const reset = fixture.database.getTask(dependency.taskId);
      fixture.database.moveTask(dependency.taskId, reset.version, "backlog");
    }
    const reviewed = fixture.database.getTask(dependency.taskId);
    fixture.database.moveTask(dependency.taskId, reviewed.version, "in_review");
    const targetClaim = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: target.childKey,
      taskId: target.taskId,
      dispatchKey: `task-orchestration:${parent.id}:target:worker`,
    });
    assert.equal(targetClaim.task.status, "in_progress");

    const dependencyAgain = fixture.database.getTask(dependency.taskId);
    // This dependency-readiness test is not exercising handoff coordination. Close the
    // status handoffs it created so archive semantics can be tested independently.
    fixture.database.database.prepare(
      "UPDATE task_handoffs SET state = 'resolved' WHERE child_task_id = ?",
    ).run(dependency.taskId);
    fixture.database.archiveTask(dependency.taskId, dependencyAgain.version);
    const archivedResult = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: doneTarget.childKey,
      taskId: doneTarget.taskId,
      dispatchKey: `task-orchestration:${parent.id}:done-target:worker`,
    });
    assert.equal(archivedResult.ready, false);
    assert.equal(archivedResult.reason, "DEPENDENCY_NOT_SATISFIED");
    const archivedDependency = fixture.database.getTask(dependency.taskId);
    fixture.database.restoreTask(dependency.taskId, archivedDependency.version);
    const doneDependency = fixture.database.getTask(dependency.taskId);
    fixture.database.moveTask(dependency.taskId, doneDependency.version, "done");
    const doneTargetClaim = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: doneTarget.childKey,
      taskId: doneTarget.taskId,
      dispatchKey: `task-orchestration:${parent.id}:done-target:worker`,
    });
    assert.equal(doneTargetClaim.task.status, "in_progress");

    const failed = fixture.database.markTaskDispatchFailed(
      targetClaim.dispatch.dispatchKey,
      "worker executable unavailable",
    );
    assert.equal(failed.status, "failed");
    assert.equal(fixture.database.getTask(target.taskId).status, "blocked");
    fixture.database.markTaskDispatchFailed(targetClaim.dispatch.dispatchKey, "same failure");
    assert.equal(fixture.database.listComments(target.taskId).length, 2);
  } finally {
    await fixture.close();
  }
});

test("coordinator startup and persisted worker replay skip archived parents and children", async () => {
  const fixture = await createDatabase();
  try {
    const archivedParent = createTask(fixture.database, {
      title: "Archived parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(
      archivedParent.id,
      `task-orchestration:${archivedParent.id}:planner`,
    );
    fixture.database.applyTaskPlan(archivedParent.id, plan([{
      childKey: "child",
      title: "Child",
      description: "Child",
      acceptance: ["done"],
      ownership: "team",
      files: ["src/child"],
      dependsOn: [],
    }]));
    fixture.database.archiveTask(archivedParent.id, archivedParent.version);

    const activeParent = createTask(fixture.database, {
      title: "Active parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(
      activeParent.id,
      `task-orchestration:${activeParent.id}:planner`,
    );
    const orchestration = fixture.database.applyTaskPlan(activeParent.id, plan([{
      childKey: "archived-worker",
      title: "Archived worker",
      description: "Archived worker",
      acceptance: ["done"],
      ownership: "team",
      files: ["src/archived-worker"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const dispatchKey = `task-orchestration:${activeParent.id}:archived-worker:worker`;
    const claim = fixture.database.claimReadyWorkerDispatch({
      parentId: activeParent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey,
    });
    fixture.database.database.prepare(
      "UPDATE task_orchestration_dispatches SET status = 'completed' WHERE dispatch_key = ?",
    ).run(dispatchKey);
    fixture.database.archiveTask(child.taskId, claim.task.version);
    const replay = fixture.database.claimReadyWorkerDispatch({
      parentId: activeParent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey,
    });
    assert.equal(replay.ready, false);
    assert.equal(replay.reason, "ARCHIVED");

    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });
    assert.equal(aiChat.started.length, 0);
    assert.equal(fixture.database.getTask(archivedParent.id).archivedAt !== null, true);
    assert.equal(fixture.database.getTask(child.taskId).archivedAt !== null, true);
    assert.equal(fixture.database.getTaskDispatch(dispatchKey).status, "completed");
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("coordinator startup skips terminal children before validating historical worker dispatches", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Terminal child parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "terminal-child-planner");
    const originalChild = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "terminal-child",
      title: "Original child",
      description: "Original child",
      acceptance: ["historical dispatch remains untouched"],
      ownership: "original-team",
      files: ["src/original-child"],
      dependsOn: [],
    }])).children[0];
    const dispatchKey = `task-orchestration:${parent.id}:terminal-child:worker`;
    fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: originalChild.childKey,
      taskId: originalChild.taskId,
      dispatchKey,
    });
    const terminalTask = createTask(fixture.database, {
      title: "Adopted terminal child",
      status: "done",
    });
    fixture.database.database.prepare(`
      UPDATE task_orchestration_children SET task_id = ?
      WHERE parent_task_id = ? AND child_key = ?
    `).run(terminalTask.id, parent.id, originalChild.childKey);

    const recoveryErrors = [];
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({
      database: fixture.database,
      aiChat,
      reportRecoveryError: (error, parentId) => recoveryErrors.push({ error, parentId }),
    });
    await coordinator.reconcile({ startup: true });

    assert.equal(recoveryErrors.length, 0);
    assert.equal(aiChat.started.length, 0);
    assert.equal(fixture.database.getTask(terminalTask.id).status, "done");
    assert.equal(fixture.database.getTaskDispatch(dispatchKey).taskId, originalChild.taskId);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("one startup dispatch conflict does not block recovery of later orchestrations", async () => {
  const fixture = await createDatabase();
  try {
    const conflictedParent = createTask(fixture.database, {
      title: "Conflicted parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(conflictedParent.id, "conflicted-parent-planner");
    const conflictedChild = fixture.database.applyTaskPlan(conflictedParent.id, plan([{
      childKey: "conflicted-child",
      title: "Conflicted child",
      description: "Conflicted child",
      acceptance: ["conflict is isolated"],
      ownership: "conflicted-team",
      files: ["src/conflicted-child"],
      dependsOn: [],
    }])).children[0];
    const conflictedDispatchKey = `task-orchestration:${conflictedParent.id}:conflicted-child:worker`;
    fixture.database.claimReadyWorkerDispatch({
      parentId: conflictedParent.id,
      childKey: conflictedChild.childKey,
      taskId: conflictedChild.taskId,
      dispatchKey: conflictedDispatchKey,
    });
    const replacementTask = createTask(fixture.database, {
      title: "Replacement active child",
      status: "backlog",
    });
    fixture.database.database.prepare(`
      UPDATE task_orchestration_children SET task_id = ?
      WHERE parent_task_id = ? AND child_key = ?
    `).run(replacementTask.id, conflictedParent.id, conflictedChild.childKey);

    const recoverableParent = createTask(fixture.database, {
      title: "Recoverable parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(recoverableParent.id, "recoverable-parent-planner");
    const recoverableChild = fixture.database.applyTaskPlan(recoverableParent.id, plan([{
      childKey: "recoverable-child",
      title: "Recoverable child",
      description: "Recoverable child",
      acceptance: ["worker starts after an earlier conflict"],
      ownership: "recoverable-team",
      files: ["src/recoverable-child"],
      dependsOn: [],
    }])).children[0];

    const recoveryErrors = [];
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({
      database: fixture.database,
      aiChat,
      reportRecoveryError: (error, parentId) => recoveryErrors.push({ error, parentId }),
    });
    await coordinator.reconcile({ startup: true });

    assert.equal(recoveryErrors.length, 1);
    assert.equal(recoveryErrors[0].parentId, conflictedParent.id);
    assert.equal(recoveryErrors[0].error.code, "DISPATCH_KEY_CONFLICT");
    assert.equal(aiChat.started.length, 1);
    assert.equal(
      aiChat.started[0].internalOptions.dispatchKey,
      `task-orchestration:${recoverableParent.id}:recoverable-child:worker`,
    );
    assert.equal(fixture.database.getTask(recoverableChild.taskId).status, "in_progress");
    assert.equal(fixture.database.getTaskDispatch(conflictedDispatchKey).taskId, conflictedChild.taskId);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a new readiness round resumes a child through an idempotent worker attempt", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Readiness retry parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "readiness-retry-planner");
    const child = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "readiness-retry",
      title: "Readiness retry child",
      description: "Resume only after a new readiness approval",
      acceptance: ["a new attempt starts without rewriting the old dispatch"],
      ownership: "readiness-team",
      files: ["src/readiness-retry"],
      dependsOn: [],
    }])).children[0];
    const originalDispatchKey = `task-orchestration:${parent.id}:readiness-retry:worker`;
    fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: originalDispatchKey,
    });
    fixture.database.markTaskDispatchFailed(originalDispatchKey, "Taskboard service restarted");
    let task = fixture.database.getTask(child.taskId);
    assert.equal(task.status, "blocked");
    task = fixture.database.moveTask(task.id, task.version, "todo");
    const reviewThread = fixture.database.createAiChatThread({
      title: `${task.identifier} readiness`,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/task-coordinator-workspace",
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "read-only",
    });
    const review = fixture.database.beginTaskReadinessReview(task.id, {
      aiThreadId: reviewThread.id,
    });
    fixture.database.settleTaskReadinessReview(task.id, review.round, {
      status: "ready",
      decision: {
        decision: "ready",
        summary: "The child is ready to resume",
        confirmed: ["the previous dispatch is terminal"],
        assumptions: [],
        questions: [],
      },
    });
    fixture.database.database.prepare(`
      UPDATE task_handoffs SET state = 'obsolete'
      WHERE child_task_id = ? AND state = 'pending'
    `).run(task.id);

    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });
    await coordinator.reconcile({ startup: true });

    const attemptKey = `task-orchestration:${parent.id}:readiness-retry:readiness:${review.round}:worker`;
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, attemptKey);
    assert.equal(aiChat.started[0].internalOptions.kind, "worker_attempt");
    assert.match(aiChat.started[0].input.message, new RegExp(`第 ${review.round} 轮已通过`));
    assert.equal(fixture.database.getTask(child.taskId).status, "in_progress");
    assert.equal(fixture.database.getTaskDispatch(originalDispatchKey).status, "failed");
    assert.equal(fixture.database.getTaskDispatch(attemptKey).status, "running");
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("persisted planner, worker, and worker_attempt bindings never replace missing or archived threads", async () => {
  const fixture = await createDatabase();
  const archiveThreadInPlace = (threadId) => {
    const archivedAt = new Date().toISOString();
    fixture.database.database.prepare(`
      UPDATE ai_chat_threads
      SET archived_at = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(archivedAt, archivedAt, threadId);
  };
  try {
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    for (const bindingState of ["missing", "archived"]) {
      const parent = createTask(fixture.database, {
        title: `Persisted planner ${bindingState}`,
        labels: ["主任务"],
        status: "todo",
      });
      const dispatchKey = `persisted-planner-${bindingState}-${parent.id}`;
      fixture.database.beginTaskOrchestration(parent.id, dispatchKey);
      const thread = createWorkerThread(fixture.database, parent, `persisted-planner-thread-${bindingState}`);
      if (bindingState === "archived") archiveThreadInPlace(thread.id);
      const persistedThreadId = bindingState === "missing" ? "missing-planner-thread" : thread.id;
      fixture.database.database.prepare(`
        UPDATE task_orchestrations
        SET planner_thread_id = ?
        WHERE parent_task_id = ?
      `).run(persistedThreadId, parent.id);
      fixture.database.database.prepare(`
        UPDATE task_orchestration_dispatches
        SET thread_id = ?
        WHERE dispatch_key = ?
      `).run(persistedThreadId, dispatchKey);

      const startedBefore = aiChat.started.length;
      await coordinator.reconcile({ parentId: parent.id, task: fixture.database.getTask(parent.id) });
      assert.equal(aiChat.started.length, startedBefore, bindingState);
      assert.equal(fixture.database.getTaskDispatch(dispatchKey).threadId, persistedThreadId);
      assert.equal(
        fixture.database.listAiChatThreads({ archived: "all" }).filter((item) => item.origin.issueId === parent.id).length,
        1,
      );
    }

    for (const bindingState of ["missing", "archived"]) {
      const parent = createTask(fixture.database, {
        title: `Persisted worker ${bindingState}`,
        labels: ["主任务"],
        status: "todo",
      });
      fixture.database.beginTaskOrchestration(parent.id, `persisted-worker-planner-${bindingState}`);
      const child = fixture.database.applyTaskPlan(parent.id, plan([{
        childKey: `worker-${bindingState}`,
        title: "Persisted worker",
        description: "Persisted worker",
        acceptance: ["worker remains bound"],
        ownership: "worker-team",
        files: ["src/worker"],
        dependsOn: [],
      }])).children[0];
      const thread = createWorkerThread(
        fixture.database,
        fixture.database.getTask(child.taskId),
        `persisted-worker-thread-${bindingState}`,
      );
      if (bindingState === "archived") archiveThreadInPlace(thread.id);
      const dispatchKey = `task-orchestration:${parent.id}:${child.childKey}:worker`;
      const claim = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey,
      });
      const persistedThreadId = bindingState === "missing" ? "missing-worker-thread" : thread.id;
      fixture.database.database.prepare(`
        UPDATE task_orchestration_dispatches SET thread_id = ? WHERE dispatch_key = ?
      `).run(persistedThreadId, dispatchKey);

      const startedBefore = aiChat.started.length;
      await coordinator.reconcile({ parentId: parent.id });
      assert.equal(aiChat.started.length, startedBefore, bindingState);
      assert.equal(fixture.database.getTaskDispatch(claim.dispatch.dispatchKey).threadId, persistedThreadId);
    }

    for (const bindingState of ["missing", "archived"]) {
      const parent = createTask(fixture.database, {
        title: `Persisted attempt ${bindingState}`,
        labels: ["主任务"],
        status: "todo",
      });
      fixture.database.beginTaskOrchestration(parent.id, `persisted-attempt-planner-${bindingState}`);
      const child = fixture.database.applyTaskPlan(parent.id, plan([{
        childKey: `attempt-${bindingState}`,
        title: "Attempt child",
        description: "Attempt child",
        acceptance: ["attempt remains bound"],
        ownership: "attempt-team",
        files: ["src/attempt"],
        dependsOn: [],
      }])).children[0];
      const originalThread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId));
      const originalDispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: `persisted-attempt-original-${bindingState}`,
      }).dispatch;
      const originalRun = fixture.database.createAiChatRunIdempotently({
        threadId: originalThread.id,
        dispatchKey: originalDispatch.dispatchKey,
      }).run;
      const settled = fixture.database.settleAiChatRun(originalRun.id, {
        status: "failed",
        error: "needs retry",
        assistantText: "needs retry",
      });
      const claim = fixture.database.claimNextTaskHandoff(parent.id);
      const applied = fixture.database.applyTaskHandoffSolution(
        claim.handoff.id,
        handoffSolution(claim.handoff, "resume", { summary: "persisted attempt" }),
      );
      assert.equal(applied.handoff.queueStatus, "attempt_pending");
      const attemptThread = bindingState === "archived"
        ? createWorkerThread(fixture.database, fixture.database.getTask(child.taskId), `persisted-attempt-thread-${bindingState}`)
        : null;
      if (attemptThread) archiveThreadInPlace(attemptThread.id);
      const persistedThreadId = bindingState === "missing"
        ? "missing-worker-attempt-thread"
        : attemptThread.id;
      fixture.database.database.prepare(`
        UPDATE task_orchestration_dispatches SET thread_id = ? WHERE dispatch_key = ?
      `).run(persistedThreadId, applied.workerDispatch.dispatchKey);

      const startedBefore = aiChat.started.length;
      await coordinator.reconcile({ parentId: parent.id });
      assert.equal(aiChat.started.length, startedBefore, bindingState);
      assert.equal(
        fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey).threadId,
        persistedThreadId,
      );
      assert.equal(fixture.database.getTaskHandoff(settled.handoff.id).queueStatus, "attempt_pending");
    }

    let raced = false;
    const raceParent = createTask(fixture.database, {
      title: "Thread creation archive race",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(raceParent.id, `race-planner-${raceParent.id}`);
    const raceAiChat = new FakeAiChat(fixture.database, {
      afterCreateThread: async ({ thread }) => {
        if (raced) return;
        raced = true;
        const archivedAt = new Date().toISOString();
        fixture.database.database.exec("BEGIN IMMEDIATE");
        try {
          fixture.database.database.prepare(
            "UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
          ).run(archivedAt, archivedAt, raceParent.id);
          fixture.database.database.prepare(
            "UPDATE ai_chat_threads SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
          ).run(archivedAt, archivedAt, thread.id);
          fixture.database.database.exec("COMMIT");
        } catch (error) {
          fixture.database.database.exec("ROLLBACK");
          throw error;
        }
      },
    });
    const raceCoordinator = new TaskCoordinator({ database: fixture.database, aiChat: raceAiChat });
    await raceCoordinator.reconcile({ parentId: raceParent.id, task: fixture.database.getTask(raceParent.id) });
    assert.equal(raced, true);
    assert.equal(raceAiChat.started.length, 0);
    assert.equal(
      fixture.database.listAiChatThreads({ archived: "all" }).filter((item) => item.origin.issueId === raceParent.id).length,
      1,
    );
    assert.equal(fixture.database.getTaskOrchestration(raceParent.id).plannerRunId, null);
    await raceCoordinator.close();
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("worker startup failure emits the blocked task and failure comment after persistence", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Worker failure parent", labels: ["主任务"] });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "failing-worker",
        title: "Failing worker",
        description: "Failing worker",
        acceptance: ["worker starts"],
        ownership: "failure-team",
        files: ["src/failing-worker"],
        dependsOn: [],
      },
    ]));
    const child = orchestration.children[0];
    const emitted = [];
    const aiChat = new FakeAiChat(fixture.database, { failNextStart: true });
    const coordinator = new TaskCoordinator({
      database: fixture.database,
      aiChat,
      emit: (type, payload) => emitted.push({ type, payload }),
    });

    await coordinator.reconcile({ parentId: parent.id });
    const latestTask = fixture.database.getTask(child.taskId);
    assert.equal(latestTask.status, "blocked");
    assert.equal(
      fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:failing-worker:worker`).status,
      "failed",
    );
    assert.equal(
      emitted.some((event) => event.type === "task.updated" && event.payload.task.id === child.taskId && event.payload.task.status === "blocked"),
      true,
    );
    assert.equal(
      emitted.some((event) => event.type === "comment.created" && event.payload.task.id === child.taskId),
      true,
    );
    coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("startup only reconciles persisted orchestration records and never replays uncertain dispatches", async () => {
  const fixture = await createDatabase();
  try {
    const historical = createTask(fixture.database, {
      title: "Historical main task",
      labels: ["主任务"],
      status: "in_progress",
    });
    const planning = createTask(fixture.database, {
      title: "Persisted planner",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(
      planning.id,
      `task-orchestration:${planning.id}:planner`,
    );

    const planned = createTask(fixture.database, {
      title: "Persisted worker",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(
      planned.id,
      `task-orchestration:${planned.id}:planner`,
    );
    const orchestration = fixture.database.applyTaskPlan(planned.id, plan([
      {
        childKey: "worker",
        title: "Worker",
        description: "Worker",
        acceptance: ["reviewed"],
        ownership: "team",
        files: ["src/worker"],
        dependsOn: [],
      },
    ]));
    const child = orchestration.children[0];
    const workerDispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: planned.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: `task-orchestration:${planned.id}:worker:worker`,
    });
    assert.equal(workerDispatch.created, true);

    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });

    assert.equal(aiChat.started.length, 0);
    assert.equal(fixture.database.getTaskOrchestration(historical.id), null);
    assert.equal(fixture.database.getTaskOrchestration(planning.id).status, "failed");
    assert.equal(fixture.database.getTaskDispatch(`task-orchestration:${planning.id}:planner`).status, "failed");
    assert.equal(fixture.database.getTask(planning.id).status, "blocked");
    assert.equal(fixture.database.listComments(planning.id).length, 1);
    assert.equal(fixture.database.getTaskDispatch(workerDispatch.dispatch.dispatchKey).status, "failed");
    assert.equal(fixture.database.getTask(child.taskId).status, "blocked");
    assert.equal(fixture.database.listComments(child.taskId).length, 2);

    await coordinator.reconcile({ startup: true });
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].internalOptions.outputSchema, TASK_HANDOFF_OUTPUT_SCHEMA);
    assert.equal(fixture.database.listTaskDispatches(planned.id).length, 3);
    coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("startup requeues a persisted handoff and wakes Sol exactly once", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Persisted handoff parent", labels: ["主任务"], status: "todo" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "persisted",
        title: "Persisted worker",
        description: "Persisted worker",
        acceptance: ["blocked is handed off"],
        ownership: "persisted-team",
        files: ["src/persisted"],
        dependsOn: [],
      },
    ]));
    const child = orchestration.children[0];
    const thread = fixture.database.createAiChatThread({
      title: "Persisted worker",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: child.taskId,
        issueIdentifier: fixture.database.getTask(child.taskId).identifier,
      },
      role: "worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: `task-orchestration:${parent.id}:persisted:worker`,
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: thread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "persisted blocker",
      assistantText: "persisted blocker",
    });
    assert.equal(settled.handoff.queueStatus, "pending");

    fixture.database.close();
    fixture.database = new TaskboardDatabase(fixture.databasePath);
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });

    const handoff = fixture.database.getTaskHandoff(settled.handoff.id);
    assert.equal(aiChat.started.length, 1);
    assert.equal(handoff.queueStatus, "processing");
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, handoff.solDispatchKey);
    await coordinator.reconcile({ startup: true });
    assert.equal(aiChat.started.length, 1);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("server settlement writes one structured handoff, status transition, and read-back comment", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Handoff parent", labels: ["主任务"], status: "todo" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "success",
        title: "Success",
        description: "Success worker",
        acceptance: ["reviewed"],
        ownership: "success-team",
        files: ["src/success"],
        dependsOn: [],
      },
      {
        childKey: "failure",
        title: "Failure",
        description: "Failure worker",
        acceptance: ["blocked is reported"],
        ownership: "failure-team",
        files: ["src/failure"],
        dependsOn: [],
      },
      {
        childKey: "cancel",
        title: "Cancel",
        description: "Cancel worker",
        acceptance: ["cancel is reported"],
        ownership: "cancel-team",
        files: ["src/cancel"],
        dependsOn: [],
      },
    ]));
    const outcomes = [
      ["success", "completed", "delivery evidence"],
      ["failure", "failed", "blocked by validation"],
      ["cancel", "interrupted", "worker canceled"],
    ];
    for (const [childKey, status, summary] of outcomes) {
      const child = orchestration.children.find((entry) => entry.childKey === childKey);
      const thread = fixture.database.createAiChatThread({
        title: childKey,
        origin: {
          projectId: "project",
          projectName: "Project",
          workspacePath: "/tmp/task-coordinator-workspace",
          issueId: child.taskId,
          issueIdentifier: fixture.database.getTask(child.taskId).identifier,
        },
        role: "worker",
        model: "gpt-5.6-terra",
        reasoningEffort: "max",
        serviceTier: "priority",
        sandbox: "workspace-write",
      });
      fixture.database.updateAiChatThread(thread.id, { codexThreadId: `codex-${childKey}` });
      const dispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey,
        taskId: child.taskId,
        dispatchKey: `worker-${childKey}`,
      }).dispatch;
      const run = fixture.database.createAiChatRunIdempotently({
        threadId: thread.id,
        dispatchKey: dispatch.dispatchKey,
      }).run;
      fixture.database.createComment(child.taskId, { body: `latest ${childKey}`, actor });
      const settled = fixture.database.settleAiChatRun(run.id, {
        status,
        error: status === "completed" ? null : summary,
        assistantText: summary,
      });
      assert.equal(settled.handoffCreated, true);
      assert.equal(settled.handoff.status, status);
      assert.equal(settled.handoff.taskStatus, status === "completed" ? "in_review" : "blocked");
      assert.equal(settled.handoff.aiThreadId, thread.id);
      assert.equal(settled.handoff.codexThreadId, `codex-${childKey}`);
      assert.equal(settled.comment.threadId, `codex-${childKey}`);
      assert.notEqual(settled.handoff.aiThreadId, settled.handoff.codexThreadId);
      assert.equal(settled.handoff.latestComment.body, `latest ${childKey}`);
      assert.deepEqual(settled.comment, fixture.database.getComment(settled.comment.id));
      assert.deepEqual(settled.handoff, fixture.database.getTaskHandoffByRun(run.id));
      const repeated = fixture.database.settleAiChatRun(run.id, {
        status: "failed",
        error: "must not replace terminal result",
        assistantText: "duplicate",
      });
      assert.equal(repeated.handoffCreated, false);
      assert.equal(repeated.run.status, status);
      assert.equal(fixture.database.getTaskHandoffByRun(run.id).id, settled.handoff.id);
      assert.equal(fixture.database.listComments(child.taskId).length, 2);
    }
  } finally {
    await fixture.close();
  }
});

test("handoff prompts skip recursive handoff comments and compact legacy oversized snapshots", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Bounded handoff parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "bounded-handoff-planner");
    const child = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "bounded-child",
      title: "Bounded child",
      description: "Bounded child",
      acceptance: ["handoff input stays below the turn limit"],
      ownership: "bounded-team",
      files: ["src/bounded"],
      dependsOn: [],
    }])).children[0];
    fixture.database.createComment(child.taskId, { body: "latest user evidence", actor });
    fixture.database.createComment(child.taskId, {
      body: JSON.stringify({
        type: "task_handoff",
        latestComment: { body: "nested".repeat(20_000) },
      }),
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    const childTask = fixture.database.getTask(child.taskId);
    const thread = createWorkerThread(fixture.database, childTask);
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "bounded-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: thread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "completed",
      assistantText: "delivery evidence",
      finishedAt: new Date().toISOString(),
    });
    assert.equal(settled.handoff.latestComment.body, "latest user evidence");

    fixture.database.database.prepare(`
      UPDATE task_handoffs SET latest_comment_json = ? WHERE id = ?
    `).run(JSON.stringify({ body: "legacy".repeat(20_000) }), settled.handoff.id);
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    const handoffStart = aiChat.started.find((entry) => entry.internalOptions.kind === "handoff");
    assert.ok(handoffStart);
    assert.ok(handoffStart.input.message.length < 100_000);
    assert.match(handoffStart.input.message, /legacylegacy/);
    const processing = fixture.database.getTaskHandoff(settled.handoff.id);
    aiChat.settle(handoffStart.run.id, JSON.stringify(handoffSolution(
      processing,
      "request_evidence",
      { instructions: "continue with bounded evidence", remediation: null },
    )));
    await waitFor(() => aiChat.started.some((entry) => entry.internalOptions.kind === "worker_attempt"));
    const workerAttempt = aiChat.started.find((entry) => entry.internalOptions.kind === "worker_attempt");
    assert.ok(workerAttempt.input.message.length < 100_000);
    assert.match(workerAttempt.input.message, /continue with bounded evidence/);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("handoffs stay FIFO while Sol is busy and wake the next item after settlement", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "FIFO parent", labels: ["主任务"], status: "todo" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "first",
        title: "First",
        description: "First worker",
        acceptance: ["first"],
        ownership: "first-team",
        files: ["src/first"],
        dependsOn: [],
      },
      {
        childKey: "second",
        title: "Second",
        description: "Second worker",
        acceptance: ["second"],
        ownership: "second-team",
        files: ["src/second"],
        dependsOn: [],
      },
    ]));
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    assert.equal(aiChat.started.length, 2);
    assert.deepEqual(aiChat.started.map((entry) => entry.internalOptions.outputSchema), [undefined, undefined]);

    const first = orchestration.children.find((child) => child.childKey === "first");
    const second = orchestration.children.find((child) => child.childKey === "second");
    aiChat.settleServer(aiChat.started[0].run.id, "completed", "first delivered");
    await waitFor(() => aiChat.started.length === 3);
    assert.deepEqual(aiChat.started[2].internalOptions.outputSchema, TASK_HANDOFF_OUTPUT_SCHEMA);
    const firstSol = aiChat.started[2].run;

    aiChat.settleServer(aiChat.started[1].run.id, "failed", "second blocked", { error: "second blocked" });
    await waitFor(() => fixture.database.listTaskHandoffs(parent.id).length === 2);
    assert.equal(aiChat.started.length, 3);
    const queued = fixture.database.listTaskHandoffs(parent.id);
    assert.equal(queued[0].queueStatus, "processing");
    assert.equal(queued[1].queueStatus, "pending");
    assert.equal(fixture.database.getTask(first.taskId).status, "in_review");
    assert.equal(fixture.database.getTask(second.taskId).status, "blocked");

    const firstHandoff = fixture.database.listTaskHandoffs(parent.id)[0];
    aiChat.settle(firstSol.id, JSON.stringify(handoffSolution(firstHandoff, "acknowledge", {
      summary: "delivery confirmed",
    })));
    await waitFor(() => aiChat.started.length === 4);
    assert.notEqual(aiChat.started[2].internalOptions.dispatchKey, aiChat.started[3].internalOptions.dispatchKey);
    assert.equal(fixture.database.listTaskHandoffs(parent.id)[0].queueStatus, "resolved");
    assert.equal(fixture.database.listTaskHandoffs(parent.id)[1].queueStatus, "processing");

    const secondSol = aiChat.started[3].run;
    const secondHandoff = fixture.database.listTaskHandoffs(parent.id)[1];
    aiChat.settle(secondSol.id, JSON.stringify(handoffSolution(secondHandoff, "stop", {
      summary: "stop blocked child",
    })));
    await waitFor(() => fixture.database.listTaskHandoffs(parent.id)[1].queueStatus === "stopped");
    await coordinator.handleEvent("task.updated", {
      task: fixture.database.getTask(second.taskId),
      changedFields: ["status"],
    });
    assert.equal(aiChat.started.length, 4);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

for (const action of ["request_evidence", "resume", "revise"]) {
test(`${action} creates exactly one new worker attempt on the same Terra thread`, async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Resume parent", labels: ["主任务"], status: "todo" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "retry",
        title: "Retry",
        description: "Retry worker",
        acceptance: ["retry"],
        ownership: "retry-team",
        files: ["src/retry"],
        dependsOn: [],
      },
    ]));
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    const firstRun = aiChat.started[0].run;
    const originalThreadId = aiChat.started[0].threadId;
    const initialStatus = action === "request_evidence" ? "completed" : "failed";
    aiChat.settleServer(firstRun.id, initialStatus, "needs another attempt", {
      error: initialStatus === "completed" ? null : "needs another attempt",
    });
    await waitFor(() => aiChat.started.length === 2);
    const solRun = aiChat.started[1].run;
    const solHandoff = fixture.database.listTaskHandoffs(parent.id)[0];
    aiChat.settle(solRun.id, JSON.stringify({
      handoffId: solHandoff.id,
      sourceTaskVersion: solHandoff.sourceTaskVersion,
      sourceTaskStatus: solHandoff.sourceTaskStatus,
      action,
      summary: `${action} within the existing boundary`,
      instructions: "continue after fixing the failing check",
    }));
    await waitFor(() => aiChat.started.length === 3);
    const attempt = aiChat.started[2];
    assert.equal(attempt.threadId, originalThreadId);
    assert.match(attempt.internalOptions.dispatchKey, new RegExp(`:worker:${action}$`));
    assert.equal(fixture.database.getTask(orchestration.children[0].taskId).status, "in_progress");
    assert.equal(fixture.database.listTaskDispatches(parent.id).filter((dispatch) => dispatch.kind === "worker_attempt").length, 1);

    aiChat.settle(solRun.id, JSON.stringify(handoffSolution(solHandoff, action, {
      summary: "duplicate solution",
    })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aiChat.started.length, 3);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});
}

test("remediation is idempotent and conflicting responsibility boundaries roll back the batch", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, { title: "Remediation parent", labels: ["主任务"], status: "todo" });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([
      {
        childKey: "blocked",
        title: "Blocked",
        description: "Blocked worker",
        acceptance: ["blocked"],
        ownership: "blocked-team",
        files: ["src/existing"],
        dependsOn: [],
      },
    ]));
    const child = orchestration.children[0];
    const thread = fixture.database.createAiChatThread({
      title: "Blocked",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: child.taskId,
        issueIdentifier: fixture.database.getTask(child.taskId).identifier,
      },
      role: "worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "blocked-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({ threadId: thread.id, dispatchKey: dispatch.dispatchKey }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "blocked",
      assistantText: "blocked",
    });
    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const taskCount = fixture.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
    const childCount = fixture.database.database.prepare("SELECT COUNT(*) AS count FROM task_orchestration_children").get().count;
    assert.throws(
      () => fixture.database.applyTaskHandoffSolution(settled.handoff.id, {
        handoffId: claim.handoff.id,
        sourceTaskVersion: claim.handoff.sourceTaskVersion,
        sourceTaskStatus: claim.handoff.sourceTaskStatus,
        action: "request_evidence",
        summary: "not valid for a blocked handoff",
      }),
      /not valid for a failed handoff/i,
    );
    assert.throws(
      () => fixture.database.applyTaskHandoffSolution(settled.handoff.id, {
        handoffId: claim.handoff.id,
        sourceTaskVersion: claim.handoff.sourceTaskVersion,
        sourceTaskStatus: claim.handoff.sourceTaskStatus,
        action: "create_remediation",
        summary: "conflict",
        remediation: {
          childKey: "bad-remediation",
          title: "Bad remediation",
          description: "Should roll back",
          acceptance: ["never"],
          ownership: "new-team",
          files: ["src/existing/child"],
        },
      }),
      /overlaps|OWNERSHIP|conflict/i,
    );
    assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, taskCount);
    assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM task_orchestration_children").get().count, childCount);
    assert.equal(fixture.database.getTaskHandoff(claim.handoff.id).queueStatus, "processing");

    const valid = fixture.database.applyTaskHandoffSolution(settled.handoff.id, {
      handoffId: claim.handoff.id,
      sourceTaskVersion: claim.handoff.sourceTaskVersion,
      sourceTaskStatus: claim.handoff.sourceTaskStatus,
      action: "create_remediation",
      summary: "create a bounded fix",
      remediation: {
        childKey: "good-remediation",
        title: "Good remediation",
        description: "Fix the blocked path",
        acceptance: ["fix is verified"],
        ownership: "new-team",
        files: ["src/remediation"],
      },
    });
    const repeated = fixture.database.applyTaskHandoffSolution(settled.handoff.id, {
      handoffId: claim.handoff.id,
      sourceTaskVersion: claim.handoff.sourceTaskVersion,
      sourceTaskStatus: claim.handoff.sourceTaskStatus,
      action: "create_remediation",
      summary: "duplicate",
      remediation: {
        childKey: "good-remediation",
        title: "Good remediation",
        description: "Fix the blocked path",
        acceptance: ["fix is verified"],
        ownership: "new-team",
        files: ["src/remediation"],
      },
    });
    assert.equal(valid.remediationCreated, true);
    assert.equal(repeated.created, false);
    assert.equal(fixture.database.getTaskOrchestration(parent.id).children.length, 2);
    assert.equal(fixture.database.getTaskHandoff(settled.handoff.id).solutionAction, "create_remediation");
  } finally {
    await fixture.close();
  }
});

test("real canceled status creates a canceled handoff and never becomes interrupted", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Canceled parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-canceled");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "canceled",
      title: "Canceled child",
      description: "Canceled child",
      acceptance: ["canceled is visible"],
      ownership: "canceled-team",
      files: ["src/canceled"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const canceled = fixture.database.moveTask(
      child.taskId,
      fixture.database.getTask(child.taskId).version,
      "canceled",
    );
    const pending = fixture.database.listTaskHandoffs(parent.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "canceled");
    assert.equal(pending[0].sourceKind, "task_status");
    assert.equal(pending[0].sourceTaskStatus, "canceled");

    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const applied = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      handoffSolution(claim.handoff, "acknowledge", { summary: "cancellation recorded" }),
    );
    assert.equal(applied.handoff.queueStatus, "resolved");
    assert.equal(fixture.database.getTask(child.taskId).status, "canceled");
    assert.equal(fixture.database.listTaskHandoffs(parent.id).some((handoff) => handoff.status === "interrupted"), false);
    assert.equal(canceled.status, "canceled");
  } finally {
    await fixture.close();
  }
});

test("settling a worker never overwrites an already manual terminal or review state", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Manual state parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-manual-state");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan(
      ["in_review", "blocked", "canceled", "done"].map((status) => ({
        childKey: status,
        title: "Manual " + status,
        description: "Manual " + status,
        acceptance: ["manual state remains"],
        ownership: "manual-" + status,
        files: ["src/manual-" + status],
        dependsOn: [],
      })),
    ));
    for (const child of orchestration.children) {
      const task = fixture.database.getTask(child.taskId);
      const thread = createWorkerThread(fixture.database, task);
      const dispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: "manual-" + child.childKey + "-worker",
      }).dispatch;
      const run = fixture.database.createAiChatRunIdempotently({
        threadId: thread.id,
        dispatchKey: dispatch.dispatchKey,
      }).run;
      fixture.database.moveTask(
        child.taskId,
        fixture.database.getTask(child.taskId).version,
        child.childKey,
      );
      fixture.database.settleAiChatRun(run.id, {
        status: "failed",
        error: "late worker result",
        assistantText: "late worker result",
      });
      assert.equal(fixture.database.getTask(child.taskId).status, child.childKey);
    }
    const handoffs = fixture.database.listTaskHandoffs(parent.id);
    assert.deepEqual(
      handoffs.map((handoff) => handoff.sourceKind),
      ["task_status", "task_status", "task_status"],
    );
    assert.equal(handoffs.some((handoff) => handoff.sourceKind === "run"), false);
  } finally {
    await fixture.close();
  }
});

test("manual review and cancel during Sol processing keep status handoffs on the Terra worker thread", async () => {
  const fixture = await createDatabase();
  const aiChat = new FakeAiChat(fixture.database);
  const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
  try {
    for (const status of ["in_review", "canceled"]) {
      const parent = createTask(fixture.database, {
        title: "Manual " + status + " during Sol",
        labels: ["主任务"],
        status: "todo",
      });
      fixture.database.beginTaskOrchestration(parent.id, "planner-manual-race-" + status);
      const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
        childKey: "manual-race",
        title: "Manual race child",
        description: "Manual race child",
        acceptance: ["manual status keeps the worker thread"],
        ownership: "manual-race-" + status,
        files: ["src/manual-race-" + status],
        dependsOn: [],
      }]));
      const child = orchestration.children[0];
      const workerThread = createWorkerThread(
        fixture.database,
        fixture.database.getTask(child.taskId),
        "manual-race-worker-" + status,
      );
      const codexThreadId = "codex-manual-race-" + status;
      fixture.database.updateAiChatThread(workerThread.id, { codexThreadId });
      const dispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: "manual-race-worker-" + status,
      }).dispatch;
      const run = fixture.database.createAiChatRunIdempotently({
        threadId: workerThread.id,
        dispatchKey: dispatch.dispatchKey,
      }).run;
      fixture.database.settleAiChatRun(run.id, {
        status: "failed",
        error: "worker failed before manual adjustment",
        assistantText: "worker failed before manual adjustment",
      });

      await coordinator.reconcile({ parentId: parent.id });
      const sol = aiChat.started
        .filter((entry) => entry.internalOptions.kind === "handoff")
        .at(-1).run;
      const moved = fixture.database.moveTask(
        child.taskId,
        fixture.database.getTask(child.taskId).version,
        status,
      );
      const statusHandoff = fixture.database.listTaskHandoffs(parent.id)
        .find((handoff) => handoff.sourceKind === "task_status");
      assert.ok(statusHandoff);
      assert.equal(moved.status, status);
      assert.equal(statusHandoff.status, status === "in_review" ? "completed" : "canceled");
      assert.equal(statusHandoff.aiThreadId, workerThread.id);
      assert.equal(statusHandoff.codexThreadId, codexThreadId);
      assert.equal(statusHandoff.sourceDispatchKey, dispatch.dispatchKey);
      assert.notEqual(statusHandoff.aiThreadId, sol.threadId);
      assert.equal(fixture.database.getComment(statusHandoff.commentId).threadId, codexThreadId);
    }
  } finally {
    await coordinator.close();
    await fixture.close();
  }
});

test("handoff queue_seq is strict FIFO and concurrent claims cannot skip or double-process", async () => {
  const fixture = await createDatabase();
  let secondDatabase = null;
  try {
    const parent = createTask(fixture.database, {
      title: "FIFO claim parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-fifo-claim");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan(["one", "two"].map((childKey) => ({
      childKey,
      title: childKey,
      description: childKey,
      acceptance: ["handoff"],
      ownership: childKey + "-team",
      files: ["src/" + childKey],
      dependsOn: [],
    }))));
    for (const child of orchestration.children) {
      const task = fixture.database.getTask(child.taskId);
      const thread = createWorkerThread(fixture.database, task);
      const dispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: "fifo-claim-" + child.childKey,
      }).dispatch;
      const run = fixture.database.createAiChatRunIdempotently({
        threadId: thread.id,
        dispatchKey: dispatch.dispatchKey,
      }).run;
      fixture.database.settleAiChatRun(run.id, {
        status: "failed",
        error: child.childKey + " failed",
        assistantText: child.childKey + " failed",
      });
    }
    assert.deepEqual(
      fixture.database.listTaskHandoffs(parent.id).map((handoff) => handoff.queueSeq),
      [1, 2],
    );

    secondDatabase = new TaskboardDatabase(fixture.databasePath);
    const [firstClaim, secondClaim] = await Promise.all([
      Promise.resolve().then(() => fixture.database.claimNextTaskHandoff(parent.id)),
      Promise.resolve().then(() => secondDatabase.claimNextTaskHandoff(parent.id)),
    ]);
    const claims = [firstClaim, secondClaim];
    assert.equal(claims.filter((claim) => claim.created).length, 1);
    assert.equal(claims.filter((claim) => !claim.created)[0].handoff.id, claims.find((claim) => claim.created).handoff.id);
    assert.equal(fixture.database.listTaskHandoffs(parent.id)[0].queueStatus, "processing");
    assert.equal(fixture.database.listTaskHandoffs(parent.id)[1].queueStatus, "pending");

    const first = fixture.database.listTaskHandoffs(parent.id)[0];
    const blockedClaim = fixture.database.claimNextTaskHandoff(parent.id);
    assert.equal(blockedClaim.created, false);
    assert.equal(blockedClaim.handoff.id, first.id);
    fixture.database.applyTaskHandoffSolution(first.id, handoffSolution(first, "acknowledge"));
    const next = fixture.database.claimNextTaskHandoff(parent.id);
    assert.equal(next.created, true);
    assert.equal(next.handoff.queueSeq, 2);
  } finally {
    secondDatabase?.close();
    await fixture.close();
  }
});

test("a stale Sol solution becomes obsolete after the source task version changes", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Stale solution parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-stale-solution");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "stale",
      title: "Stale child",
      description: "Stale child",
      acceptance: ["stale solution is ignored"],
      ownership: "stale-team",
      files: ["src/stale"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const task = fixture.database.getTask(child.taskId);
    const thread = createWorkerThread(fixture.database, task);
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "stale-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: thread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "stale source",
      assistantText: "stale source",
    });
    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const before = fixture.database.getTask(child.taskId);
    fixture.database.updateTask(child.taskId, before.version, { title: "Changed manually" });
    const result = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      handoffSolution(claim.handoff, "acknowledge", { summary: "old solution" }),
    );
    assert.equal(result.obsolete, true);
    assert.equal(result.handoff.queueStatus, "obsolete");
    assert.equal(fixture.database.getTask(child.taskId).title, "Changed manually");
    assert.equal(fixture.database.getTaskHandoffByRun(run.id).id, settled.handoff.id);
  } finally {
    await fixture.close();
  }
});

test("dispatch key collisions and wrong-thread binds fail without overwriting a claim", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Dispatch fingerprint parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-dispatch-fingerprint");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "dispatch",
      title: "Dispatch child",
      description: "Dispatch child",
      acceptance: ["dispatch is safe"],
      ownership: "dispatch-team",
      files: ["src/dispatch"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const key = "dispatch-fingerprint";
    fixture.database.claimTaskDispatch({
      dispatchKey: key,
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      kind: "worker",
      role: "worker",
    });
    assert.throws(
      () => fixture.database.claimTaskDispatch({
        dispatchKey: key,
        parentId: parent.id,
        childKey: "other-child",
        taskId: child.taskId,
        kind: "worker",
        role: "worker",
      }),
      (error) => error.status === 409 && error.code === "DISPATCH_KEY_CONFLICT",
    );

    const firstThread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId), "dispatch-thread-1");
    const secondThread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId), "dispatch-thread-2");
    const wrongRun = fixture.database.createAiChatRun({
      id: "wrong-thread-run",
      threadId: secondThread.id,
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    assert.throws(
      () => fixture.database.bindTaskDispatch(key, {
        threadId: firstThread.id,
        runId: wrongRun.id,
      }),
      (error) => error.status === 409 && error.code === "DISPATCH_BIND_CONFLICT",
    );
    const unchanged = fixture.database.getTaskDispatch(key);
    assert.equal(unchanged.status, "claimed");
    assert.equal(unchanged.threadId, null);
    assert.equal(unchanged.runId, null);
    assert.equal(wrongRun.dispatchKey, null);
  } finally {
    await fixture.close();
  }
});

test("Sol recovery reads only the completed dispatch run assistant event", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Run scoped assistant parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-run-scoped");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "run-scoped",
      title: "Run scoped child",
      description: "Run scoped child",
      acceptance: ["the correct run is used"],
      ownership: "run-scoped-team",
      files: ["src/run-scoped"],
      dependsOn: [],
    }]));
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    const worker = aiChat.started[0].run;
    const settledWorker = aiChat.settleServer(worker.id, "failed", "worker failed", {
      error: "worker failed",
      notify: false,
    });
    await coordinator.handleRunSettled({
      run: settledWorker,
      thread: fixture.database.getAiChatThread(settledWorker.threadId),
      assistantText: "worker failed",
    });
    const sol = aiChat.started[1].run;
    const handoff = fixture.database.listTaskHandoffs(parent.id)[0];
    const solutionText = JSON.stringify(handoffSolution(handoff, "acknowledge", {
      summary: "correct solution",
    }));
    const settledSol = aiChat.settle(sol.id, solutionText, { notify: false });
    const otherRun = fixture.database.createAiChatRun({
      id: "different-run",
      threadId: sol.threadId,
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      threadId: sol.threadId,
      runId: otherRun.id,
      type: "agent_message",
      role: "assistant",
      content: "not JSON and not this run",
    });
    await coordinator.handleRunSettled({
      run: settledSol,
      thread: fixture.database.getAiChatThread(settledSol.threadId),
      assistantText: solutionText,
    });
    assert.equal(fixture.database.getTaskHandoff(handoff.id).queueStatus, "resolved");
    assert.equal(fixture.database.getTaskHandoff(handoff.id).lastError, null);
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a claimed worker attempt survives a crash before launch and starts once after restart", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Attempt restart parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-attempt-restart");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "attempt-restart",
      title: "Attempt restart child",
      description: "Attempt restart child",
      acceptance: ["attempt starts once"],
      ownership: "attempt-restart-team",
      files: ["src/attempt-restart"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const originalThread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId), "attempt-original-thread");
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "attempt-original-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: originalThread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "needs retry",
      assistantText: "needs retry",
    });
    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const applied = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      handoffSolution(claim.handoff, "resume", { summary: "resume after crash" }),
    );
    assert.equal(applied.handoff.queueStatus, "attempt_pending");
    assert.equal(fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey).status, "claimed");

    fixture.database.close();
    fixture.database = new TaskboardDatabase(fixture.databasePath);
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });
    const recovered = fixture.database.getTaskHandoff(claim.handoff.id);
    assert.equal(recovered.queueStatus, "resolved");
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].internalOptions.dispatchKey, applied.workerDispatch.dispatchKey);
    assert.equal(fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey).runId, aiChat.started[0].run.id);
    await coordinator.reconcile({ startup: true });
    assert.equal(aiChat.started.length, 1);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a real worker attempt start failure restores source CAS after a title edit and recovers with one dispatch", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Attempt start failure parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-attempt-start-failure");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "attempt-start-failure",
      title: "Attempt start failure child",
      description: "Attempt start failure child",
      acceptance: ["a failed start is recoverable"],
      ownership: "attempt-start-failure-team",
      files: ["src/attempt-start-failure"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const workerThread = createWorkerThread(
      fixture.database,
      fixture.database.getTask(child.taskId),
      "attempt-start-failure-thread",
    );
    fixture.database.updateAiChatThread(workerThread.id, { codexThreadId: "codex-attempt-start-failure" });
    const workerDispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "attempt-start-failure-worker",
    }).dispatch;
    const workerRun = fixture.database.createAiChatRunIdempotently({
      threadId: workerThread.id,
      dispatchKey: workerDispatch.dispatchKey,
    }).run;
    fixture.database.settleAiChatRun(workerRun.id, {
      status: "failed",
      error: "the first worker run failed",
      assistantText: "the first worker run failed",
    });

    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const applied = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      handoffSolution(claim.handoff, "resume", { summary: "retry the failed worker" }),
    );
    const appliedTask = fixture.database.getTask(child.taskId);
    const editedTask = fixture.database.updateTask(
      child.taskId,
      appliedTask.version,
      { title: "Human title preserved after failed retry" },
    );
    const parentTask = fixture.database.getTask(parent.id);
    const project = fixture.database.getProject(parentTask.projectId);
    const plannerThread = fixture.database.createAiChatThread({
      id: "attempt-start-failure-planner",
      title: parentTask.identifier + " planner",
      origin: {
        projectId: project.id,
        projectName: project.name,
        workspacePath: "/tmp/task-coordinator-workspace",
        issueId: parent.id,
        issueIdentifier: parentTask.identifier,
      },
      role: "planner",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
      sandbox: "read-only",
    });
    fixture.database.updateTaskOrchestration(parent.id, { plannerThreadId: plannerThread.id });
    const busyPlannerRun = fixture.database.createAiChatRun({
      id: "attempt-start-failure-busy-planner",
      threadId: plannerThread.id,
      status: "running",
    });
    const aiChat = new WorkerAttemptStartFailOnceAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.reconcile({ parentId: parent.id });

    const afterFailure = fixture.database.getTaskHandoff(claim.handoff.id);
    const restoredTask = fixture.database.getTask(child.taskId);
    const failedAttempt = fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey);
    assert.equal(aiChat.workerAttemptStarts, 1);
    assert.equal(restoredTask.status, "blocked");
    assert.equal(restoredTask.title, editedTask.title);
    assert.equal(afterFailure.sourceTaskVersion, restoredTask.version);
    assert.equal(afterFailure.sourceTaskStatus, restoredTask.status);
    assert.equal(afterFailure.taskStatus, restoredTask.status);
    assert.equal(afterFailure.queueStatus, "pending");
    assert.notEqual(afterFailure.queueStatus, "obsolete");
    assert.equal(failedAttempt.status, "failed");
    assert.equal(fixture.database.listTaskDispatches(parent.id).filter((dispatch) => (
      dispatch.kind === "worker_attempt" && ["claimed", "running"].includes(dispatch.status)
    )).length, 0);

    fixture.database.settleAiChatRun(busyPlannerRun.id, {
      status: "completed",
      assistantText: "planner became available",
    });
    await coordinator.reconcile({ parentId: parent.id });
    const sol = aiChat.started.find((entry) => entry.internalOptions.kind === "handoff").run;
    const solutionText = JSON.stringify(handoffSolution(afterFailure, "resume", {
      summary: "retry with the restored source version",
    }));
    const settledSol = aiChat.settle(sol.id, solutionText, { notify: false });
    await coordinator.handleRunSettled({
      run: settledSol,
      thread: fixture.database.getAiChatThread(settledSol.threadId),
      assistantText: solutionText,
    });

    const recovered = fixture.database.getTaskHandoff(claim.handoff.id);
    const recoveredTask = fixture.database.getTask(child.taskId);
    const recoveredAttempt = fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey);
    assert.equal(aiChat.workerAttemptStarts, 2);
    assert.equal(recovered.queueStatus, "resolved");
    assert.equal(recoveredTask.status, "in_progress");
    assert.equal(recoveredTask.title, editedTask.title);
    assert.equal(recoveredAttempt.runId, aiChat.started.find((entry) => (
      entry.internalOptions.kind === "worker_attempt"
    )).run.id);
    assert.equal(fixture.database.listTaskDispatches(parent.id).filter((dispatch) => dispatch.kind === "worker_attempt").length, 1);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("a failed worker attempt never overwrites a manually changed review or canceled status", async () => {
  const fixture = await createDatabase();
  try {
    for (const status of ["in_review", "canceled"]) {
      const parent = createTask(fixture.database, {
        title: "Manual status after failed attempt " + status,
        labels: ["主任务"],
        status: "todo",
      });
      fixture.database.beginTaskOrchestration(parent.id, "planner-manual-failed-attempt-" + status);
      const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
        childKey: "manual-failed-attempt",
        title: "Manual failed attempt child",
        description: "Manual failed attempt child",
        acceptance: ["manual status is not overwritten"],
        ownership: "manual-failed-attempt-" + status,
        files: ["src/manual-failed-attempt-" + status],
        dependsOn: [],
      }]));
      const child = orchestration.children[0];
      const workerThread = createWorkerThread(
        fixture.database,
        fixture.database.getTask(child.taskId),
        "manual-failed-attempt-thread-" + status,
      );
      const codexThreadId = "codex-manual-failed-attempt-" + status;
      fixture.database.updateAiChatThread(workerThread.id, { codexThreadId });
      const workerDispatch = fixture.database.claimReadyWorkerDispatch({
        parentId: parent.id,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: "manual-failed-attempt-worker-" + status,
      }).dispatch;
      const workerRun = fixture.database.createAiChatRunIdempotently({
        threadId: workerThread.id,
        dispatchKey: workerDispatch.dispatchKey,
      }).run;
      fixture.database.settleAiChatRun(workerRun.id, {
        status: "failed",
        error: "worker failed before manual status change",
        assistantText: "worker failed before manual status change",
      });
      const claim = fixture.database.claimNextTaskHandoff(parent.id);
      fixture.database.applyTaskHandoffSolution(
        claim.handoff.id,
        handoffSolution(claim.handoff, "resume", { summary: "resume after failure" }),
      );
      const manualTask = fixture.database.moveTask(
        child.taskId,
        fixture.database.getTask(child.taskId).version,
        status,
      );

      const aiChat = new WorkerAttemptStartFailOnceAiChat(fixture.database);
      const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
      await coordinator.reconcile({ parentId: parent.id });

      const originalHandoff = fixture.database.getTaskHandoff(claim.handoff.id);
      const statusHandoff = fixture.database.listTaskHandoffs(parent.id)
        .find((handoff) => handoff.sourceKind === "task_status");
      assert.equal(aiChat.workerAttemptStarts, 1);
      assert.equal(originalHandoff.queueStatus, "obsolete");
      assert.equal(fixture.database.getTask(child.taskId).status, status);
      assert.equal(manualTask.status, status);
      assert.ok(statusHandoff);
      assert.equal(statusHandoff.sourceTaskStatus, status);
      assert.equal(statusHandoff.aiThreadId, workerThread.id);
      assert.equal(statusHandoff.codexThreadId, codexThreadId);
      assert.equal(fixture.database.getComment(statusHandoff.commentId).threadId, codexThreadId);
      assert.equal(fixture.database.listTaskDispatches(parent.id).filter((dispatch) => (
        dispatch.kind === "worker_attempt" && ["claimed", "running"].includes(dispatch.status)
      )).length, 0);
      await coordinator.close();
    }
  } finally {
    await fixture.close();
  }
});

test("a busy Terra thread leaves the attempt pending and wakes it after the busy run settles", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Busy attempt parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-busy-attempt");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "busy-attempt",
      title: "Busy attempt child",
      description: "Busy attempt child",
      acceptance: ["busy recovers"],
      ownership: "busy-attempt-team",
      files: ["src/busy-attempt"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const originalThread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId), "busy-original-thread");
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "busy-original-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: originalThread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "busy retry",
      assistantText: "busy retry",
    });
    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const applied = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      handoffSolution(claim.handoff, "resume", { summary: "resume while busy" }),
    );
    const busyRun = fixture.database.createAiChatRun({
      id: "busy-external-run",
      threadId: originalThread.id,
      status: "running",
    });
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ startup: true });
    assert.equal(aiChat.started.length, 0);
    assert.equal(fixture.database.getTaskHandoff(claim.handoff.id).queueStatus, "attempt_pending");
    fixture.database.settleAiChatRun(busyRun.id, {
      status: "completed",
      assistantText: "busy run completed",
    });
    await coordinator.reconcile({ parentId: parent.id });
    assert.equal(aiChat.started.length, 1);
    assert.equal(aiChat.started[0].threadId, originalThread.id);
    assert.equal(fixture.database.getTaskHandoff(claim.handoff.id).queueStatus, "resolved");
    assert.equal(fixture.database.getTaskDispatch(applied.workerDispatch.dispatchKey).runId, aiChat.started[0].run.id);
    assert.equal(fixture.database.getTaskHandoffByRun(settled.run.id).id, settled.handoff.id);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("Sol failures retry on one planner thread and leave visible evidence at the cap", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Sol retry parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-sol-retry");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "sol-retry",
      title: "Sol retry child",
      description: "Sol retry child",
      acceptance: ["retry evidence remains"],
      ownership: "sol-retry-team",
      files: ["src/sol-retry"],
      dependsOn: [],
    }]));
    const aiChat = new SolStartFailAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });
    await coordinator.reconcile({ parentId: parent.id });
    const worker = aiChat.started[0].run;
    aiChat.settleServer(worker.id, "failed", "worker failed", { error: "worker failed" });
    await waitFor(() => fixture.database.listTaskHandoffs(parent.id)[0]?.queueStatus === "failed");
    const handoff = fixture.database.listTaskHandoffs(parent.id)[0];
    assert.equal(aiChat.solStarts, 4);
    assert.equal(handoff.retryCount, 4);
    assert.match(handoff.lastError, /Sol executable unavailable/);
    assert.equal(fixture.database.listAiChatThreads().filter((thread) => thread.role === "planner").length, 1);
    const evidence = fixture.database.listComments(handoff.childTaskId)
      .map((comment) => JSON.parse(comment.body))
      .find((body) => body.type === "task_handoff_retry_exhausted");
    assert.equal(evidence.retryCount, 4);
    const exhaustionComment = fixture.database.listComments(handoff.childTaskId)
      .find((comment) => JSON.parse(comment.body).type === "task_handoff_retry_exhausted");
    assert.equal(exhaustionComment.threadId, null);
    assert.equal(fixture.database.listTaskHandoffs(parent.id).some((item) => (
      ["pending", "processing", "attempt_pending"].includes(item.queueStatus)
    )), false);
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});

test("remediation scope transfer is explicit and keeps the original child blocked", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Scope transfer parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-scope-transfer");
    const orchestration = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "blocked-scope",
      title: "Blocked scope",
      description: "Blocked scope",
      acceptance: ["scope is transferred"],
      ownership: "old-team",
      files: ["src/transferred/fix.js", "src/transferred/other.js"],
      dependsOn: [],
    }]));
    const child = orchestration.children[0];
    const thread = createWorkerThread(fixture.database, fixture.database.getTask(child.taskId));
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey: "scope-transfer-worker",
    }).dispatch;
    const run = fixture.database.createAiChatRunIdempotently({
      threadId: thread.id,
      dispatchKey: dispatch.dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(run.id, {
      status: "failed",
      error: "scope blocked",
      assistantText: "scope blocked",
    });
    const claim = fixture.database.claimNextTaskHandoff(parent.id);
    const remediationSolution = (files, transferFiles) => handoffSolution(
      claim.handoff,
      "create_remediation",
      {
        summary: "transfer the blocked scope",
        remediation: {
          childKey: "scope-remediation",
          title: "Scope remediation",
          description: "Take over the explicitly transferred scope",
          acceptance: ["transferred scope is verified"],
          ownership: "new-team",
          files,
          scopeTransfer: {
            fromChildKey: "blocked-scope",
            files: transferFiles,
          },
        },
      },
    );
    assert.throws(
      () => fixture.database.applyTaskHandoffSolution(
        claim.handoff.id,
        remediationSolution(["src/transferred/fix.js"], ["src/transferred"]),
      ),
      (error) => error.status === 409 && error.code === "SCOPE_TRANSFER_CONFLICT",
    );
    assert.deepEqual(
      fixture.database.getTaskOrchestration(parent.id).children[0].files,
      ["src/transferred/fix.js", "src/transferred/other.js"],
    );
    assert.throws(
      () => fixture.database.applyTaskHandoffSolution(
        claim.handoff.id,
        remediationSolution(["src/transferred"], ["src/transferred/fix.js"]),
      ),
      (error) => error.status === 409 && error.code === "SCOPE_TRANSFER_CONFLICT",
    );
    const result = fixture.database.applyTaskHandoffSolution(
      claim.handoff.id,
      remediationSolution(["src/transferred/fix.js"], ["src/transferred/fix.js"]),
    );
    assert.equal(result.remediationCreated, true);
    assert.equal(fixture.database.getTask(child.taskId).status, "blocked");
    assert.equal(fixture.database.getTaskHandoff(settled.handoff.id).queueStatus, "resolved");
    const remediation = fixture.database.getTaskOrchestration(parent.id).children
      .find((entry) => entry.childKey === "scope-remediation");
    assert.ok(remediation);
    assert.deepEqual(
      fixture.database.getTaskOrchestration(parent.id).children
        .find((entry) => entry.childKey === "blocked-scope").files,
      ["src/transferred/other.js"],
    );
    assert.deepEqual(remediation.files, ["src/transferred/fix.js"]);
    const relations = fixture.database.database.prepare(`
      SELECT relation_type, source_task_id, target_task_id
      FROM task_relations
      WHERE source_task_id = ? OR target_task_id = ?
      ORDER BY relation_type
    `).all(parent.id, child.taskId);
    assert.equal(relations.some((relation) => relation.relation_type === "blocks" && relation.source_task_id === remediation.taskId && relation.target_task_id === child.taskId), true);
    assert.equal(relations.some((relation) => relation.relation_type === "parent" && relation.source_task_id === parent.id && relation.target_task_id === remediation.taskId), true);
  } finally {
    await fixture.close();
  }
});

test("a user retry preserves the stopped handoff and starts one fresh worker attempt", async () => {
  const fixture = await createDatabase();
  try {
    const parent = createTask(fixture.database, {
      title: "Manual retry parent",
      labels: ["主任务"],
      status: "todo",
    });
    fixture.database.beginTaskOrchestration(parent.id, "planner-manual-retry");
    const child = fixture.database.applyTaskPlan(parent.id, plan([{
      childKey: "manual-retry-child",
      title: "Manual retry child",
      description: "Continue after an infrastructure failure",
      acceptance: ["the same worker thread resumes"],
      ownership: "retry-team",
      files: ["src/manual-retry"],
      dependsOn: [],
    }])).children[0];
    const aiChat = new FakeAiChat(fixture.database);
    const coordinator = new TaskCoordinator({ database: fixture.database, aiChat });

    await coordinator.reconcile({ parentId: parent.id });
    const failedWorker = aiChat.started[0];
    aiChat.settleServer(failedWorker.run.id, "failed", "provider rejected the old model", {
      error: "provider rejected the old model",
    });
    await waitFor(() => aiChat.started.length === 2);
    const stoppedHandoff = fixture.database.listTaskHandoffs(parent.id)[0];
    aiChat.settle(
      aiChat.started[1].run.id,
      JSON.stringify(handoffSolution(stoppedHandoff, "stop", {
        summary: "wait until the provider route is repaired",
      })),
    );
    await waitFor(() => (
      fixture.database.getTaskHandoff(stoppedHandoff.id).queueStatus === "stopped"
    ));
    assert.equal(fixture.database.getTask(child.taskId).status, "blocked");

    const resumed = await coordinator.retryFailedThread(
      failedWorker.threadId,
      failedWorker.run.id,
    );
    assert.equal(aiChat.started.length, 3);
    assert.equal(resumed.id, aiChat.started[2].run.id);
    assert.equal(aiChat.started[2].threadId, failedWorker.threadId);
    assert.equal(aiChat.started[2].internalOptions.kind, "worker_attempt");
    assert.match(aiChat.started[2].input.message, /用户已在 Taskboard 对话中明确选择恢复/);
    assert.equal(fixture.database.getTask(child.taskId).status, "in_progress");
    assert.equal(fixture.database.getTaskHandoff(stoppedHandoff.id).queueStatus, "stopped");

    const replay = await coordinator.retryFailedThread(
      failedWorker.threadId,
      failedWorker.run.id,
    );
    assert.equal(replay.id, resumed.id);
    assert.equal(aiChat.started.length, 3);

    aiChat.settleServer(resumed.id, "completed", "manual retry delivered");
    await waitFor(() => fixture.database.listTaskHandoffs(parent.id).length === 2);
    const handoffs = fixture.database.listTaskHandoffs(parent.id);
    assert.equal(handoffs[0].id, stoppedHandoff.id);
    assert.equal(handoffs[0].queueStatus, "stopped");
    assert.equal(handoffs[1].runId, resumed.id);
    assert.equal(fixture.database.getTask(child.taskId).status, "in_review");
    await coordinator.close();
  } finally {
    await fixture.close();
  }
});
