import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { TaskReadinessCoordinator } from "../server/task-readiness-coordinator.mjs";

const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
const codexActor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };

function createTask(database, input) {
  return database.createTask({
    projectId: "project",
    description: "",
    status: "backlog",
    priority: "none",
    labels: [],
    actor,
    assignee: codexActor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    ...input,
  });
}

class FakeAiChat {
  constructor(database) {
    this.database = database;
    this.listeners = new Set();
    this.created = [];
    this.started = [];
  }

  subscribeRunSettled(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getThread(id) {
    return this.database.getAiChatThread(id);
  }

  async createThread(input) {
    this.created.push(input);
    return this.database.createAiChatThread({
      title: input.title,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/task-readiness-parent-dispatch",
        issueId: input.issueId,
      },
      role: input.role,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      sandbox: input.sandbox,
    });
  }

  async startTurn(threadId, input, internalOptions) {
    const thread = this.database.getAiChatThread(threadId);
    const managedDispatch = thread?.origin.issueId
      ? this.database.findTaskDispatchForTask(thread.origin.issueId, thread.role)
      : null;
    if (!internalOptions?.dispatchKey && managedDispatch) {
      throw new Error("This task has a server-managed AI dispatch; the public turn cannot claim it");
    }
    const run = this.database.createAiChatRun({ threadId });
    this.started.push({ threadId, input, internalOptions, run });
    return run;
  }

  async settleReady(run) {
    const assistantText = JSON.stringify({
      decision: "ready",
      summary: "Parent planner approved the child dispatch",
      confirmed: ["scope is bounded"],
      assumptions: [],
      questions: [],
    });
    const settled = this.database.settleAiChatRun(run.id, {
      status: "completed",
      assistantText,
      finishedAt: new Date().toISOString(),
    });
    const payload = {
      ...settled,
      run: settled.run,
      thread: this.database.getAiChatThread(run.threadId),
      assistantText,
    };
    await Promise.all([...this.listeners].map((listener) => listener(payload)));
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-readiness-parent-dispatch-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({
    id: "project",
    name: "Project",
    workspacePath: "/tmp/task-readiness-parent-dispatch",
  });
  const aiChat = new FakeAiChat(database);
  const ready = [];
  const coordinator = new TaskReadinessCoordinator({
    database,
    aiChat,
    onReady: async (task) => ready.push(task),
  });
  return {
    database,
    aiChat,
    ready,
    coordinator,
    async close() {
      await coordinator.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a child of a top-level main task waits for a parent-context Sol Max dispatch review", async () => {
  const fixture = await createFixture();
  try {
    const parent = createTask(fixture.database, {
      title: "Main delivery",
      description: "Coordinate every child before implementation",
      labels: ["主任务"],
    });
    let child = createTask(fixture.database, {
      title: "Implement bounded child",
      description: "Only change the child-owned module",
      status: "todo",
    });
    child = fixture.database.addTaskRelation(
      child.id,
      child.version,
      "parent",
      parent.id,
    ).task;

    await fixture.coordinator.handleEvent("task.moved", {
      task: child,
      fromStatus: "backlog",
    });

    assert.equal(fixture.aiChat.created.length, 1);
    assert.equal(fixture.aiChat.created[0].model, "gpt-5.6-sol");
    assert.equal(fixture.aiChat.created[0].reasoningEffort, "max");
    assert.equal(fixture.aiChat.created[0].sandbox, "read-only");
    assert.equal(fixture.aiChat.created[0].issueId, undefined);
    assert.match(fixture.aiChat.created[0].title, new RegExp(`${parent.identifier} → ${child.identifier}`));
    assert.match(fixture.aiChat.started[0].input.message, new RegExp(`父任务：${parent.identifier}`));
    assert.match(fixture.aiChat.started[0].input.message, /默认 Luna Max \+ Fast/);
    assert.match(fixture.aiChat.started[0].input.message, /用户选择优先/);
    assert.equal(fixture.ready.length, 0);

    const review = fixture.database.getTaskReadinessReview(child.id);
    assert.equal(review.status, "running");
    assert.equal(review.aiModel, "gpt-5.6-sol");
    assert.equal(review.aiReasoningEffort, "max");

    await fixture.aiChat.settleReady(fixture.aiChat.started[0].run);

    assert.equal(fixture.ready.length, 1);
    assert.equal(fixture.ready[0].id, child.id);
    assert.match(fixture.database.listComments(child.id).at(-1).body, /父任务 planner 派发审核/);
    assert.match(fixture.database.listComments(child.id).at(-1).body, /父任务允许启动开发 worker/);
  } finally {
    await fixture.close();
  }
});

test("an independent task keeps the existing Sol X-High readiness review", async () => {
  const fixture = await createFixture();
  try {
    const task = createTask(fixture.database, {
      title: "Independent task",
      status: "todo",
    });

    await fixture.coordinator.handleEvent("task.moved", {
      task,
      fromStatus: "backlog",
    });

    assert.equal(fixture.aiChat.created[0].model, "gpt-5.6-sol");
    assert.equal(fixture.aiChat.created[0].reasoningEffort, "xhigh");
    assert.equal(fixture.aiChat.created[0].issueId, undefined);
    assert.match(fixture.aiChat.created[0].title, /需求审核/);
    assert.doesNotMatch(fixture.aiChat.started[0].input.message, /默认 Luna Max \+ Fast/);
  } finally {
    await fixture.close();
  }
});

test("a main task with a failed planner dispatch starts readiness in a dedicated thread", async () => {
  const fixture = await createFixture();
  try {
    let task = createTask(fixture.database, {
      title: "Retry readiness after planner startup failed",
      description: "The readiness review must run before planner orchestration retries",
      labels: ["主任务"],
      status: "todo",
    });
    const dispatchKey = `task-orchestration:${task.id}:planner`;
    fixture.database.beginTaskOrchestration(task.id, dispatchKey);
    fixture.database.markTaskDispatchFailed(dispatchKey, "Timed out while reading Codex skills");
    task = fixture.database.getTask(task.id);
    task = fixture.database.moveTask(task.id, task.version, "todo");

    await fixture.coordinator.handleEvent("task.moved", {
      task,
      fromStatus: "blocked",
    });

    const review = fixture.database.getTaskReadinessReview(task.id);
    assert.equal(review.status, "running");
    assert.equal(review.runId, fixture.aiChat.started[0].run.id);
    assert.equal(fixture.aiChat.created[0].issueId, undefined);
    assert.equal(fixture.database.getAiChatThread(review.aiThreadId).origin.issueId, undefined);
    assert.equal(fixture.database.getTaskDispatch(dispatchKey).status, "failed");
  } finally {
    await fixture.close();
  }
});

test("a user-assigned todo task does not start an AI readiness review", async () => {
  const fixture = await createFixture();
  try {
    const task = createTask(fixture.database, {
      title: "Explore a new workflow manually",
      status: "todo",
      assignee: actor,
    });

    await fixture.coordinator.handleEvent("task.moved", {
      task,
      fromStatus: "backlog",
    });

    assert.equal(fixture.aiChat.created.length, 0);
    assert.equal(fixture.aiChat.started.length, 0);
    assert.equal(fixture.database.getTaskReadinessReview(task.id), null);
    assert.equal(fixture.ready.length, 0);
  } finally {
    await fixture.close();
  }
});
