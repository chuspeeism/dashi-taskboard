import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-database-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  return {
    database,
    directory,
    filename,
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("AI chat persistence stores threads, runs, and visible events without hidden prompt fields", async () => {
  const fixture = await createFixture();
  try {
    const thread = fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
        issueId: "task-1",
        issueIdentifier: "LOCAL-1",
      },
      codexThreadId: null,
      role: "planner",
      model: "gpt-real",
      reasoningEffort: "high",
      serviceTier: "priority",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.issueIdentifier, "LOCAL-1");
    assert.equal(thread.role, "planner");
    assert.equal(thread.serviceTier, "priority");
    assert.equal(thread.currentRun, null);

    const run = fixture.database.createAiChatRun({
      id: "run-1",
      threadId: thread.id,
      status: "running",
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: thread.id,
      runId: run.id,
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
      data: { status: "completed" },
    });
    fixture.database.updateAiChatThread(thread.id, {
      status: "running",
      codexThreadId: "codex-thread-1",
    });

    assert.equal(fixture.database.getAiChatThread(thread.id).currentRun.id, run.id);
    assert.equal(fixture.database.listAiChatThreads()[0].codexThreadId, "codex-thread-1");
    assert.deepEqual(fixture.database.listAiChatEvents(thread.id).map((event) => event.content), [
      "Visible answer",
    ]);
    assert.equal(fixture.database.listAiChatRuns(thread.id)[0].status, "running");

    for (const table of ["ai_chat_threads", "ai_chat_runs", "ai_chat_events"]) {
      const columns = fixture.database.database.prepare(`PRAGMA table_info(${table})`).all();
      assert.equal(
        columns.some((column) => /prompt|raw/i.test(column.name)),
        false,
        `${table} must not persist hidden prompts or raw Codex JSONL`,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("opening an existing database migrates role and sandbox without overwriting runtime selections", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  fixture.database.createProject({ id: "project", name: "Project", workspacePath: "/tmp/project" });
  const task = fixture.database.createTask({
    projectId: "project",
    title: "Main task",
    description: "",
    status: "backlog",
    priority: "none",
    labels: ["主任务"],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
  const workerTask = fixture.database.createTask({
    projectId: "project",
    title: "Worker task",
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
  });
  fixture.database.createAiChatThread({
    id: "legacy-task-thread",
    title: task.identifier,
    origin: {
      projectId: "project",
      projectName: "Project",
      workspacePath: "/tmp/project",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    role: "worker",
    model: "legacy-model",
    reasoningEffort: "low",
    serviceTier: null,
    sandbox: "workspace-write",
  });
  fixture.database.createAiChatThread({
    id: "legacy-worker-thread",
    title: workerTask.identifier,
    origin: {
      projectId: "project",
      projectName: "Project",
      workspacePath: "/tmp/project",
      issueId: workerTask.id,
      issueIdentifier: workerTask.identifier,
    },
    role: "worker",
    model: "legacy-model",
    reasoningEffort: "low",
    serviceTier: null,
    sandbox: "read-only",
  });
  fixture.database.close();

  fixture.database = new TaskboardDatabase(fixture.filename);
  try {
    const migrated = fixture.database.getAiChatThread("legacy-task-thread");
    assert.equal(migrated.origin.issueTitle, "Main task");
    assert.deepEqual(
      {
      role: migrated.role,
      model: migrated.model,
      reasoningEffort: migrated.reasoningEffort,
        serviceTier: migrated.serviceTier,
        sandbox: migrated.sandbox,
      },
    {
      role: "planner",
      model: "legacy-model",
      reasoningEffort: "low",
      serviceTier: null,
      sandbox: "read-only",
    },
  );
    const migratedWorker = fixture.database.getAiChatThread("legacy-worker-thread");
    assert.deepEqual(
      {
        role: migratedWorker.role,
        model: migratedWorker.model,
        reasoningEffort: migratedWorker.reasoningEffort,
        serviceTier: migratedWorker.serviceTier,
        sandbox: migratedWorker.sandbox,
      },
      {
        role: "worker",
        model: "legacy-model",
        reasoningEffort: "low",
        serviceTier: null,
        sandbox: "workspace-write",
      },
    );
    fixture.database.updateAiChatThread(migrated.id, {
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    fixture.database.close();
    fixture.database = new TaskboardDatabase(fixture.filename);
    const reopened = fixture.database.getAiChatThread(migrated.id);
    assert.equal(reopened.reasoningEffort, "high");
    assert.equal(reopened.serviceTier, "priority");
  } finally {
    await fixture.close();
  }
});

test("AI archive columns migrate without losing history and remain idempotent across reopen", async () => {
  const fixture = await createFixture();
  try {
    const thread = fixture.database.createAiChatThread({
      id: "legacy-archive-thread",
      title: "Legacy archive thread",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    const run = fixture.database.createAiChatRun({
      id: "legacy-archive-run",
      threadId: thread.id,
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      id: "legacy-archive-event",
      threadId: thread.id,
      runId: run.id,
      type: "agent_message",
      role: "assistant",
      content: "preserved",
    });

    fixture.database.database.exec(`
      DROP INDEX IF EXISTS ai_chat_threads_archive_updated;
      ALTER TABLE ai_chat_threads DROP COLUMN archived_at;
      ALTER TABLE ai_chat_threads DROP COLUMN version;
      ALTER TABLE ai_chat_runs DROP COLUMN error_code;
    `);
    fixture.database.close();

    fixture.database = new TaskboardDatabase(fixture.filename);
    const assertMigrated = () => {
      assert.deepEqual(
        {
          threadIds: fixture.database.listAiChatThreads({ archived: "all" }).map((item) => item.id),
          runIds: fixture.database.listAiChatRuns(thread.id).map((item) => item.id),
          eventIds: fixture.database.listAiChatEvents(thread.id).map((item) => item.id),
          archivedAt: fixture.database.getAiChatThread(thread.id).archivedAt,
          version: fixture.database.getAiChatThread(thread.id).version,
          errorCode: fixture.database.getAiChatRun(run.id).errorCode,
        },
        {
          threadIds: [thread.id],
          runIds: [run.id],
          eventIds: ["legacy-archive-event"],
          archivedAt: null,
          version: 1,
          errorCode: null,
        },
      );
    };
    assertMigrated();
    fixture.database.close();
    fixture.database = new TaskboardDatabase(fixture.filename);
    assertMigrated();
  } finally {
    await fixture.close();
  }
});

test("ordinary database opens do not interrupt active runs; explicit server recovery does", async () => {
  const fixture = await createFixture();
  fixture.database.createAiChatThread({
    id: "thread-1",
    title: "New conversation",
    status: "running",
    origin: {
      projectId: "local",
      projectName: "Local",
      workspacePath: "/tmp/project",
    },
    codexThreadId: "codex-thread-1",
    model: "gpt-real",
    reasoningEffort: "medium",
    sandbox: "read-only",
  });
  fixture.database.createAiChatRun({
    id: "run-1",
    threadId: "thread-1",
    status: "running",
  });

  const ordinary = new TaskboardDatabase(fixture.filename);
  assert.equal(ordinary.getAiChatRun("run-1").status, "running");
  ordinary.close();

  fixture.database.close();
  const reopened = new TaskboardDatabase(fixture.filename);
  fixture.database = reopened;
  try {
    assert.equal(reopened.getAiChatRun("run-1").status, "running");
    assert.equal(reopened.recoverAbandonedAiChatRuns(), 1);
    assert.equal(reopened.getAiChatRun("run-1").status, "interrupted");
    assert.equal(reopened.getAiChatRun("run-1").finishedAt === null, false);
    assert.equal(reopened.getAiChatThread("thread-1").codexThreadId, "codex-thread-1");
    assert.equal(reopened.getAiChatThread("thread-1").status, "idle");
    assert.equal(reopened.getAiChatThread("thread-1").currentRun, null);
  } finally {
    await fixture.close();
  }
});

test("deleting an AI chat thread soft-archives it and preserves runs and visible events", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      codexThreadId: null,
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    fixture.database.createAiChatRun({
      id: "run-1",
      threadId: "thread-1",
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
    });

    const archived = fixture.database.deleteAiChatThread("thread-1");

    assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fixture.database.listAiChatThreads().length, 0);
    assert.equal(fixture.database.listAiChatThreads({ archived: "true" })[0].id, "thread-1");
    assert.equal(fixture.database.listAiChatThreads({ archived: "all" }).length, 1);
    assert.equal(fixture.database.getAiChatThread("thread-1").archivedAt, archived.archivedAt);
    assert.equal(fixture.database.getAiChatRun("run-1").status, "completed");
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM ai_chat_events").get().count,
      1,
    );
    assert.throws(
      () => fixture.database.archiveAiChatThread("thread-1", archived.version),
      (error) => error.code === "AI_CHAT_THREAD_ALREADY_ARCHIVED",
    );
    assert.throws(
      () => fixture.database.restoreAiChatThread("thread-1", archived.version - 1),
      (error) => error.code === "AI_CHAT_THREAD_VERSION_CONFLICT",
    );
    const restored = fixture.database.restoreAiChatThread("thread-1", archived.version);
    assert.equal(restored.archivedAt, null);
    assert.equal(fixture.database.listAiChatThreads({ archived: "false" })[0].id, "thread-1");
    assert.throws(
      () => fixture.database.restoreAiChatThread("thread-1", restored.version),
      (error) => error.code === "AI_CHAT_THREAD_NOT_ARCHIVED",
    );
  } finally {
    await fixture.close();
  }
});

test("task archive and restore preserve the task-bound thread, history, relations, comments, attachments, and ids", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  try {
    fixture.database.createProject({ id: "project", name: "Project", workspacePath: "/tmp/project" });
    let task = fixture.database.createTask({
      id: "task-archive",
      projectId: "project",
      title: "Archive me",
      description: "Keep this",
      status: "todo",
      priority: "high",
      labels: [],
      threadId: "task-thread",
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const related = fixture.database.createTask({
      id: "task-related",
      projectId: "project",
      title: "Related",
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
    });
    fixture.database.createAiChatThread({
      id: "task-thread",
      title: "Archive me",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/project",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      codexThreadId: "codex-task-thread",
    });
    fixture.database.createAiChatThread({
      id: "old-task-thread",
      title: "Older archived history",
      archivedAt: "2026-01-01T00:00:00.000Z",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/project",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      codexThreadId: "codex-old-task-thread",
    });
    const relation = fixture.database.addTaskRelation(task.id, task.version, "related", related.id);
    task = relation.task;
    const comment = fixture.database.createComment(task.id, {
      body: "Keep this comment",
      actor,
    });
    fixture.database.createAttachment(task.id, {
      id: "task-attachment",
      filename: "keep.txt",
      contentType: "text/plain",
      size: 4,
    });
    const run = fixture.database.createAiChatRun({
      id: "task-run",
      threadId: "task-thread",
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      id: "task-event",
      threadId: "task-thread",
      runId: run.id,
      type: "agent_message",
      role: "assistant",
      content: "Keep this event",
    });

    const before = {
      threadId: task.threadId,
      dashiThreadId: fixture.database.getAiChatThread("task-thread").id,
      codexThreadId: fixture.database.getAiChatThread("task-thread").codexThreadId,
      relationIds: fixture.database.getTask(task.id).relations.related.map((item) => item.id),
      commentId: comment.id,
      attachmentId: "task-attachment",
      runIds: fixture.database.listAiChatRuns("task-thread").map((item) => item.id),
      eventIds: fixture.database.listAiChatEvents("task-thread").map((item) => item.id),
    };
    const archived = fixture.database.archiveTask(task.id, task.version, "archive-attribution");
    const archivedThread = fixture.database.getAiChatThread("task-thread");
    assert.equal(archived.threadId, "archive-attribution");
    assert.equal(archivedThread.id, before.dashiThreadId);
    assert.equal(archivedThread.codexThreadId, before.codexThreadId);
    assert.equal(archivedThread.archivedAt, archived.archivedAt);
    assert.equal(fixture.database.findReusableAiChatThread(task.id, "worker"), null);
    assert.throws(
      () => fixture.database.createAiChatRunIdempotently({ threadId: "task-thread" }),
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED",
    );
    assert.equal(fixture.database.getAiChatThread("old-task-thread").archivedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(fixture.database.getTask(task.id).relations.related.map((item) => item.id), before.relationIds);
    assert.equal(fixture.database.getComment(before.commentId).id, before.commentId);
    assert.equal(fixture.database.getAttachment(before.attachmentId).id, before.attachmentId);
    assert.deepEqual(fixture.database.listAiChatRuns("task-thread").map((item) => item.id), before.runIds);
    assert.deepEqual(fixture.database.listAiChatEvents("task-thread").map((item) => item.id), before.eventIds);
    assert.throws(
      () => fixture.database.archiveTask(task.id, archived.version),
      (error) => error.code === "TASK_ALREADY_ARCHIVED",
    );
    assert.throws(
      () => fixture.database.restoreTask(task.id, archived.version - 1),
      (error) => error.code === "VERSION_CONFLICT",
    );

    const restored = fixture.database.restoreTask(task.id, archived.version, "restore-attribution");
    assert.equal(restored.threadId, "restore-attribution");
    assert.equal(fixture.database.getAiChatThread("task-thread").id, before.dashiThreadId);
    assert.equal(fixture.database.getAiChatThread("task-thread").codexThreadId, before.codexThreadId);
    assert.equal(fixture.database.getAiChatThread("task-thread").archivedAt, null);
    assert.equal(fixture.database.getAiChatThread("old-task-thread").archivedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(fixture.database.listAiChatRuns("task-thread").map((item) => item.id), before.runIds);
    assert.deepEqual(fixture.database.listAiChatEvents("task-thread").map((item) => item.id), before.eventIds);
    assert.throws(
      () => fixture.database.restoreTask(task.id, restored.version),
      (error) => error.code === "TASK_NOT_ARCHIVED",
    );
  } finally {
    await fixture.close();
  }
});

test("task archive blocks active child dispatches, runs, and handoffs without side effects", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  try {
    fixture.database.createProject({ id: "project", name: "Project", workspacePath: "/tmp/project" });
    const parent = fixture.database.createTask({
      id: "archive-block-parent",
      projectId: "project",
      title: "Parent",
      description: "",
      status: "todo",
      priority: "none",
      labels: ["主任务"],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    fixture.database.beginTaskOrchestration(parent.id, `task-orchestration:${parent.id}:planner`);
    const orchestration = fixture.database.applyTaskPlan(parent.id, {
      children: [{
        childKey: "child",
        title: "Child",
        description: "Child",
        acceptance: ["verified"],
        ownership: "team",
        files: ["src/child"],
        dependsOn: [],
      }],
    });
    const child = orchestration.children[0];
    const childTask = fixture.database.getTask(child.taskId);
    const thread = fixture.database.createAiChatThread({
      id: "archive-block-thread",
      title: childTask.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/project",
        issueId: childTask.id,
        issueIdentifier: childTask.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const dispatchKey = `task-orchestration:${parent.id}:child:worker`;
    const dispatch = fixture.database.claimReadyWorkerDispatch({
      parentId: parent.id,
      childKey: child.childKey,
      taskId: child.taskId,
      dispatchKey,
    }).dispatch;
    fixture.database.bindTaskDispatch(dispatchKey, { threadId: thread.id });
    const failedRun = fixture.database.createAiChatRunIdempotently({
      threadId: thread.id,
      dispatchKey,
    }).run;
    const settled = fixture.database.settleAiChatRun(failedRun.id, {
      status: "failed",
      error: "child failed",
    });
    assert.equal(settled.handoff.queueStatus, "pending");

    for (const state of ["pending", "processing", "attempt_pending"]) {
      fixture.database.database.prepare("UPDATE task_handoffs SET state = ? WHERE id = ?").run(
        state,
        settled.handoff.id,
      );
      assert.throws(
        () => fixture.database.archiveTask(parent.id, parent.version),
        (error) => error.code === "TASK_ARCHIVE_BLOCKED"
          && error.details.handoffs.some((handoff) => handoff.state === state),
      );
      assert.equal(fixture.database.getTask(parent.id).archivedAt, null);
    }

    fixture.database.database.prepare("UPDATE task_handoffs SET state = 'resolved' WHERE id = ?").run(
      settled.handoff.id,
    );
    const runningThread = fixture.database.createAiChatThread({
      id: "archive-running-thread",
      title: childTask.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/project",
        issueId: childTask.id,
        issueIdentifier: childTask.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const runningRun = fixture.database.createAiChatRun({
      id: "archive-running-run",
      threadId: runningThread.id,
      status: "running",
    });
    assert.throws(
      () => fixture.database.archiveTask(parent.id, parent.version),
      (error) => error.code === "TASK_ARCHIVE_BLOCKED"
        && error.details.runs.some((run) => run.id === runningRun.id),
    );
    assert.equal(fixture.database.getAiChatRun(runningRun.id).status, "running");

    fixture.database.updateAiChatRun(runningRun.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.database.prepare(
      "UPDATE task_orchestration_dispatches SET status = 'claimed' WHERE dispatch_key = ?",
    ).run(dispatch.dispatchKey);
    assert.throws(
      () => fixture.database.archiveTask(parent.id, parent.version),
      (error) => error.code === "TASK_ARCHIVE_BLOCKED"
        && error.details.dispatches.some((item) => item.dispatchKey === dispatch.dispatchKey),
    );
    assert.equal(fixture.database.getTaskDispatch(dispatch.dispatchKey).status, "claimed");

    fixture.database.database.prepare(
      "UPDATE task_orchestration_dispatches SET status = 'completed' WHERE dispatch_key = ?",
    ).run(dispatch.dispatchKey);
    const archived = fixture.database.archiveTask(parent.id, parent.version);
    assert.notEqual(archived.archivedAt, null);
    assert.equal(
      fixture.database.getTaskDispatch(`task-orchestration:${parent.id}:planner`).status,
      "claimed",
      "planned parent orchestration is not an archive blocker",
    );
  } finally {
    await fixture.close();
  }
});

test("task archive blocks every running task-bound thread, including ordinary and planner threads", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  const createTask = (input) => fixture.database.createTask({
    projectId: "project",
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
    ...input,
  });
  const createThread = (task, role, id) => fixture.database.createAiChatThread({
    id,
    title: task.identifier,
    origin: {
      projectId: "project",
      projectName: "Project",
      workspacePath: "/tmp/project",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    role,
    model: role === "planner" ? "gpt-5.6-sol" : "gpt-real",
    reasoningEffort: role === "planner" ? "max" : "medium",
    serviceTier: role === "planner" ? "priority" : null,
    sandbox: role === "planner" ? "read-only" : "workspace-write",
  });
  try {
    fixture.database.createProject({ id: "project", name: "Project", workspacePath: "/tmp/project" });

    const ordinaryTask = createTask({ id: "ordinary-running-task", title: "Ordinary task" });
    const ordinaryThread = createThread(ordinaryTask, "worker", "ordinary-running-thread");
    const ordinaryRun = fixture.database.createAiChatRun({
      id: "ordinary-running-run",
      threadId: ordinaryThread.id,
      status: "running",
    });
    assert.throws(
      () => fixture.database.archiveTask(ordinaryTask.id, ordinaryTask.version),
      (error) => error.code === "TASK_ARCHIVE_BLOCKED"
        && error.details.runs.some((run) => run.id === ordinaryRun.id),
    );
    assert.equal(fixture.database.getTask(ordinaryTask.id).archivedAt, null);
    assert.equal(fixture.database.getAiChatThread(ordinaryThread.id).archivedAt, null);
    assert.equal(fixture.database.getAiChatRun(ordinaryRun.id).status, "running");

    fixture.database.updateAiChatRun(ordinaryRun.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    const archivedOrdinary = fixture.database.archiveTask(
      ordinaryTask.id,
      fixture.database.getTask(ordinaryTask.id).version,
    );
    assert.notEqual(archivedOrdinary.archivedAt, null);

    const plannerTask = createTask({
      id: "planner-running-task",
      title: "Planner task",
      labels: ["主任务"],
    });
    fixture.database.beginTaskOrchestration(
      plannerTask.id,
      `task-orchestration:${plannerTask.id}:planner`,
    );
    const plannerThread = createThread(plannerTask, "planner", "planner-running-thread");
    const plannerRun = fixture.database.createAiChatRun({
      id: "planner-running-run",
      threadId: plannerThread.id,
      status: "running",
    });
    assert.throws(
      () => fixture.database.archiveTask(plannerTask.id, plannerTask.version),
      (error) => error.code === "TASK_ARCHIVE_BLOCKED"
        && error.details.runs.some((run) => run.id === plannerRun.id),
    );
    assert.equal(fixture.database.getTask(plannerTask.id).archivedAt, null);
    assert.equal(fixture.database.getTaskDispatch(`task-orchestration:${plannerTask.id}:planner`).status, "claimed");
    assert.equal(fixture.database.getAiChatRun(plannerRun.id).status, "running");

    fixture.database.updateAiChatRun(plannerRun.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    const archivedPlanner = fixture.database.archiveTask(
      plannerTask.id,
      fixture.database.getTask(plannerTask.id).version,
    );
    assert.notEqual(archivedPlanner.archivedAt, null);
  } finally {
    await fixture.close();
  }
});

test("AI chat events with the same timestamp retain SQLite insertion order", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    const createdAt = "2026-07-27T12:00:00.000Z";
    fixture.database.insertAiChatEvent({
      id: "z-first",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "first",
      createdAt,
    });
    fixture.database.insertAiChatEvent({
      id: "a-second",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "second",
      createdAt,
    });

    assert.deepEqual(
      fixture.database.listAiChatEvents("thread-1").map((event) => event.id),
      ["z-first", "a-second"],
    );
  } finally {
    await fixture.close();
  }
});
