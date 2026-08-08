import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "project-move-tester",
  name: "Project Move Tester",
  avatarUrl: null,
};

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-project-move-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  return {
    database,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createProject(database, id) {
  return database.createProject({
    id,
    name: id.toUpperCase(),
    workspacePath: `/tmp/${id}`,
  });
}

function createTask(database, projectId, title, overrides = {}) {
  return database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    ...overrides,
  });
}

test("local project moves reject related issues without mutating the task", async () => {
  const fixture = await createFixture();
  try {
    createProject(fixture.database, "move-related-source");
    createProject(fixture.database, "move-related-target");
    const task = createTask(fixture.database, "move-related-source", "Related source");
    const related = createTask(fixture.database, "move-related-source", "Related peer");
    const linked = fixture.database.addTaskRelation(
      task.id,
      task.version,
      "related",
      related.id,
      undefined,
      actor,
    ).task;

    assert.throws(
      () => fixture.database.updateTask(
        linked.id,
        linked.version,
        { projectId: "move-related-target" },
        undefined,
        actor,
      ),
      (error) => error?.status === 409 && error?.code === "CROSS_PROJECT_RELATION",
    );

    const unchanged = fixture.database.getTask(linked.id);
    assert.equal(unchanged.projectId, "move-related-source");
    assert.equal(unchanged.version, linked.version);
    assert.deepEqual(unchanged.relations.related.map((item) => item.id), [related.id]);
  } finally {
    await fixture.close();
  }
});

test("local project moves reject issue-linked AI chats and preserve their origin", async () => {
  const fixture = await createFixture();
  try {
    createProject(fixture.database, "move-chat-source");
    createProject(fixture.database, "move-chat-target");
    const task = createTask(fixture.database, "move-chat-source", "Chat-linked source");
    const thread = fixture.database.createAiChatThread({
      id: "move-chat-thread",
      title: "Issue conversation",
      origin: {
        projectId: "move-chat-source",
        projectName: "MOVE-CHAT-SOURCE",
        workspacePath: "/tmp/move-chat-source",
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });

    assert.throws(
      () => fixture.database.updateTask(
        task.id,
        task.version,
        { projectId: "move-chat-target" },
        undefined,
        actor,
      ),
      (error) => error?.status === 409 && error?.code === "AI_CHAT_PROJECT_MOVE_BLOCKED",
    );

    assert.equal(fixture.database.getTask(task.id).projectId, "move-chat-source");
    assert.deepEqual(fixture.database.getAiChatThread(thread.id).origin, thread.origin);
  } finally {
    await fixture.close();
  }
});

test("local combined project and status updates use the target status ordering", async () => {
  const fixture = await createFixture();
  try {
    createProject(fixture.database, "move-sort-source");
    createProject(fixture.database, "move-sort-target");
    createTask(fixture.database, "move-sort-target", "Target first", {
      status: "done",
      sortOrder: 5000,
    });
    createTask(fixture.database, "move-sort-target", "Target second", {
      status: "done",
      sortOrder: 7000,
    });
    const task = createTask(fixture.database, "move-sort-source", "Move and complete", {
      status: "todo",
      sortOrder: 9000,
    });

    const moved = fixture.database.updateTask(
      task.id,
      task.version,
      { projectId: "move-sort-target", status: "done" },
      undefined,
      actor,
    );

    assert.equal(moved.projectId, "move-sort-target");
    assert.equal(moved.status, "done");
    assert.equal(moved.sortOrder, 4000);
  } finally {
    await fixture.close();
  }
});
