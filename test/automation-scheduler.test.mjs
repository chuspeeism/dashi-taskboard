import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AutomationScheduler } from "../server/automation.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

const ACTOR = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };

function automationConfig(overrides = {}) {
  return {
    taskboardProjectId: "project",
    codexProjectId: "codex-project",
    projectName: "Project",
    workspacePath: "/fixture/workspace",
    skillPath: "/fixture/skills/manage-taskboard/SKILL.md",
    enabledByUser: true,
    quotaAware: false,
    intervalSeconds: 300,
    model: "gpt-5.5",
    reasoningEffort: "high",
    ...overrides,
  };
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const resolvedWorkspace = await realpath(workspacePath);
  const capturePath = path.join(directory, "capture.jsonl");
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: resolvedWorkspace });
  return {
    directory,
    database,
    capturePath,
    workspacePath: resolvedWorkspace,
  };
}

async function capturedTurns(capturePath) {
  try {
    const content = await readFile(capturePath, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function createScheduler(fixture) {
  return new AutomationScheduler({
    database: fixture.database,
    processEnv: { ...process.env, CODEX_TASKBOARD_CODEX_DEBUG_PORT: "9231" },
    runTask: async (request) => {
      await request.onThreadStarted("codex-thread-1");
      await new Promise((resolve) => setTimeout(resolve, 120));
      await appendFile(fixture.capturePath, `${JSON.stringify({
        debugPort: request.debugPort,
        workspacePath: request.workspacePath,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        title: request.title,
        prompt: request.prompt,
      })}\n`);
      return { status: "completed", threadId: "codex-thread-1", turnId: "turn-1" };
    },
    assignThread: async () => {},
  });
}

async function withFixture(run) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("a tick with no todo never starts a Codex Desktop task", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
    const scheduler = createScheduler(fixture);
    try {
      await scheduler.runOnce("project");
      assert.deepEqual(await capturedTurns(fixture.capturePath), []);
    } finally {
      await scheduler.stop();
    }
  });
});

test("a tick with a todo dispatches one native Codex Desktop turn", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
    fixture.database.createTask({
      projectId: "project",
      title: "Todo task",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      workflowId: null,
      dueDate: null,
      actor: ACTOR,
      assignee: ACTOR,
    });
    const scheduler = createScheduler(fixture);
    try {
      await scheduler.runOnce("project");
      const turns = await waitFor(async () => {
        const current = await capturedTurns(fixture.capturePath);
        return current.length >= 1 ? current : null;
      });
      assert.equal(turns.length, 1);
      const { debugPort, workspacePath, model, reasoningEffort, prompt } = turns[0];
      assert.equal(debugPort, "9231");
      assert.equal(workspacePath, fixture.workspacePath);
      assert.equal(model, "gpt-5.5");
      assert.equal(reasoningEffort, "high");
      assert.match(prompt, /\[\$manage-taskboard\]/);
      assert.ok(prompt.includes("Project"));
      assert.ok(prompt.includes("project"));
      const [task] = fixture.database.listTasks({ projectId: "project" });
      assert.equal(task.status, "in_review");
      assert.equal(task.threadId, "codex-thread-1");
    } finally {
      await scheduler.stop();
    }
  });
});

test("an in-flight dispatch skips a concurrent tick", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
    fixture.database.createTask({
      projectId: "project",
      title: "Todo task",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      workflowId: null,
      dueDate: null,
      actor: ACTOR,
      assignee: ACTOR,
    });
    const scheduler = createScheduler(fixture);
    try {
      await Promise.all([scheduler.runOnce("project"), scheduler.runOnce("project")]);
      const turns = await waitFor(async () => {
        const current = await capturedTurns(fixture.capturePath);
        return current.length >= 1 ? current : null;
      });
      assert.equal(turns.length, 1, "only one dispatch should spawn");
    } finally {
      await scheduler.stop();
    }
  });
});

test("disabled and deleted configurations stop their timers", async () => {
  await withFixture(async (fixture) => {
    const scheduler = createScheduler(fixture);
    try {
      scheduler.setProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
      assert.ok(scheduler.timers.has("project"), "enabled config schedules a timer");

      scheduler.setProjectAutomation(automationConfig({
        workspacePath: fixture.workspacePath,
        enabledByUser: false,
      }));
      assert.equal(scheduler.timers.has("project"), false, "disabled config clears the timer");

      scheduler.setProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
      assert.ok(scheduler.timers.has("project"));

      scheduler.deleteProjectAutomation("project");
      assert.equal(scheduler.timers.has("project"), false, "deleting clears the timer");
    } finally {
      await scheduler.stop();
    }
  });
});

test("start reloads persisted configs and stop clears every timer", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig({ workspacePath: fixture.workspacePath }));
    const scheduler = createScheduler(fixture);
    scheduler.start();
    assert.ok(scheduler.timers.has("project"));
    await scheduler.stop();
    assert.equal(scheduler.timers.size, 0);
  });
});
