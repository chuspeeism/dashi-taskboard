import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AiRetryCoordinator, RECOVERY_MESSAGE } from "../server/ai-retry-coordinator.mjs";
import { CODEX_JSONL_LINE_TOO_LARGE } from "../server/ai-chat-process.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-retry-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: "/tmp/retry-project" });
  const task = database.createTask({
    projectId: "project",
    title: "Retry task",
    description: "",
    status: "in_progress",
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
  const thread = database.createAiChatThread({
    id: "thread-1",
    title: task.identifier,
    origin: {
      projectId: "project",
      projectName: "Project",
      workspacePath: "/tmp/retry-project",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    role: "worker",
    model: "gpt-real",
    reasoningEffort: "high",
    serviceTier: "priority",
    sandbox: "workspace-write",
  });
  const sourceRun = database.createAiChatRun({ id: "source-run", threadId: thread.id });
  database.insertAiChatEvent({
    id: "source-user",
    threadId: thread.id,
    runId: sourceRun.id,
    type: "user_message",
    role: "user",
    content: "Do the work",
  });
  const settled = database.settleAiChatRun(sourceRun.id, {
    status: "failed",
    error: "Codex JSONL line exceeded 1048576 bytes",
    errorCode: CODEX_JSONL_LINE_TOO_LARGE,
  });

  const listeners = new Set();
  const starts = [];
  const aiChat = {
    subscribeRunSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyThreadChanged() {},
    async startTurn(threadId, input, options) {
      const run = database.createAiChatRun({
        threadId,
        retryJobId: options.retryJobId,
      });
      starts.push({ threadId, input, options, run });
      return run;
    },
  };
  const coordinator = new AiRetryCoordinator({
    database,
    aiChat,
    now: () => Date.now(),
    firstDelayMs: 0,
    laterDelayMs: 0,
    maxAttempts: 2,
  });
  return {
    database,
    directory,
    thread,
    source: { ...settled, thread: database.getAiChatThread(thread.id) },
    starts,
    aiChat,
    coordinator,
    async close() {
      await coordinator.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("retryable oversized JSONL failures reuse one thread and stop after two automatic attempts", async () => {
  const fixture = await createFixture();
  try {
    await fixture.coordinator.handleRunSettled(fixture.source);
    assert.equal(fixture.starts.length, 1);
    assert.equal(fixture.starts[0].threadId, fixture.thread.id);
    assert.equal(fixture.starts[0].input.message, RECOVERY_MESSAGE);

    let job = fixture.database.listAiChatRetryJobs()[0];
    assert.equal(job.state, "running");
    assert.equal(job.attemptCount, 1);
    assert.equal(fixture.database.getAiChatThread(fixture.thread.id).retryJob.id, job.id);

    const firstRetry = fixture.database.settleAiChatRun(fixture.starts[0].run.id, {
      status: "failed",
      error: "Codex JSONL line exceeded 1048576 bytes",
      errorCode: CODEX_JSONL_LINE_TOO_LARGE,
    });
    await fixture.coordinator.handleRunSettled({
      ...firstRetry,
      thread: fixture.database.getAiChatThread(fixture.thread.id),
    });
    assert.equal(fixture.starts.length, 2);
    assert.equal(fixture.starts[1].threadId, fixture.thread.id);

    const secondRetry = fixture.database.settleAiChatRun(fixture.starts[1].run.id, {
      status: "failed",
      error: "Codex JSONL line exceeded 1048576 bytes",
      errorCode: CODEX_JSONL_LINE_TOO_LARGE,
    });
    await fixture.coordinator.handleRunSettled({
      ...secondRetry,
      thread: fixture.database.getAiChatThread(fixture.thread.id),
    });

    job = fixture.database.listAiChatRetryJobs()[0];
    assert.equal(job.state, "exhausted");
    assert.equal(job.attemptCount, 2);
    assert.equal(fixture.starts.length, 2);

    await fixture.coordinator.handleRunSettled(fixture.source);
    assert.equal(fixture.database.listAiChatRetryJobs().length, 1);
    assert.equal(fixture.starts.length, 2);
  } finally {
    await fixture.close();
  }
});

test("pending automatic retry survives a Taskboard service restart", async () => {
  const fixture = await createFixture();
  let restarted = null;
  try {
    await fixture.coordinator.handleRunSettled(fixture.source);
    assert.equal(fixture.starts.length, 1);
    await fixture.coordinator.close();

    fixture.database.recoverAbandonedAiChatRuns();
    restarted = new AiRetryCoordinator({
      database: fixture.database,
      aiChat: fixture.aiChat,
      now: () => Date.now(),
      firstDelayMs: 0,
      laterDelayMs: 0,
      maxAttempts: 2,
    });
    await restarted.start();

    assert.equal(fixture.starts.length, 2);
    const job = fixture.database.listAiChatRetryJobs()[0];
    assert.equal(job.state, "running");
    assert.equal(job.attemptCount, 2);
    assert.equal(fixture.starts[1].threadId, fixture.thread.id);
  } finally {
    await restarted?.close();
    await fixture.close();
  }
});

test("runs with attachments never enter the automatic retry pool", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.insertAiChatEvent({
      id: "source-attachment",
      threadId: fixture.thread.id,
      runId: fixture.source.run.id,
      type: "user_message",
      role: "user",
      content: "Inspect this attachment",
      data: {
        attachments: [{ filename: "evidence.png", contentType: "image/png", size: 128 }],
      },
    });

    await fixture.coordinator.handleRunSettled(fixture.source);

    assert.equal(fixture.database.listAiChatRetryJobs().length, 0);
    assert.equal(fixture.starts.length, 0);
  } finally {
    await fixture.close();
  }
});
