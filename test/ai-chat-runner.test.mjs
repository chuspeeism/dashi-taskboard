import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService, TASK_AI_STRATEGIES } from "../server/ai-chat.mjs";
import { CODEX_THREAD_NOT_FOUND, normalizeCodexEvent } from "../server/ai-chat-process.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

test("normalized item events retain a bounded public item id", () => {
  const itemId = "x".repeat(70_000);
  const normalized = normalizeCodexEvent({
    type: "item.updated",
    item: {
      id: itemId,
      type: "command_execution",
      command: "npm test",
      status: "in_progress",
    },
  });

  assert.equal(normalized.data.itemId, itemId.slice(0, 65_536));
});

test("normalized item errors retain the stable Codex thread error code", () => {
  for (const type of ["item.started", "item.updated", "item.completed"]) {
    const normalized = normalizeCodexEvent({
      type,
      item: {
        id: `error-${type}`,
        type: "error",
        error: { code: "THREAD_NOT_FOUND", message: "native thread was removed" },
      },
    });
    assert.equal(normalized.data.errorCode, CODEX_THREAD_NOT_FOUND, type);
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-runner-"));
  const workspacePath = path.join(directory, "workspace");
  const otherWorkspacePath = path.join(directory, "other-workspace");
  const temporaryDirectory = path.join(directory, "temporary");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspacePath), mkdir(temporaryDirectory)]);
  const [workspace, otherWorkspace] = await Promise.all([
    realpath(workspacePath),
    realpath(otherWorkspacePath),
  ]);
  const capturePath = path.join(directory, "capture.jsonl");
  const descendantPath = path.join(directory, "descendant-alive");
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  if (args.length !== 2) process.exit(2);
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"Real fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}],
    service_tiers:[{id:"priority",name:"Fast",description:"fixture"}]
  }]}));
  process.exit(0);
}
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{"platformFamily":"unix"}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":{"displayName":"Real Skill"}},{"name":"disabled","enabled":false,"scope":"user"}]}]}}\\n');
    }
  });
} else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (prompt.includes("LATE_THREAD")) {
      emit({type:"turn.started"});
      const timer = setTimeout(() => {
        emit({type:"thread.started",thread_id:"codex-late"});
        emit({type:"item.completed",item:{type:"agent_message",text:"Visible answer"}});
        emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
      }, 250);
      process.on("SIGTERM", () => { clearTimeout(timer); process.exit(143); });
      return;
    }
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-thread-1"});
    emit({type:"turn.started"});
    if (prompt.includes("MISSING_NATIVE")) {
      emit({type:"error",error:{code:"THREAD_NOT_FOUND",message:"native thread was removed"}});
      process.exit(3);
      return;
    }
    if (prompt.includes("STDERR_SPLIT")) {
      const stderr = JSON.stringify({code:"THREAD_NOT_FOUND",message:"native thread was removed"});
      process.stderr.write(stderr.slice(0, 11));
      setTimeout(() => { process.stderr.write(stderr.slice(11) + "\\n"); process.exit(3); }, 5);
      return;
    }
    if (prompt.includes("MALFORMED_STUBBORN") || prompt.includes("CALLBACK_FATAL_STUBBORN")) {
      spawn(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.env.FAKE_DESCENDANT_PATH, "alive"), 300); setInterval(() => {}, 1000)',
      ], {env:process.env,stdio:"ignore"});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      if (prompt.includes("CALLBACK_FATAL_STUBBORN")) {
        emit({type:"thread.started",thread_id:"unexpected-thread"});
      } else {
        process.stdout.write("{not-json}\\n");
      }
      return;
    }
    if (prompt.includes("MALFORMED")) {
      process.stdout.write("{not-json}\\n");
      return;
    }
    if (prompt.includes("OVERSIZED_JSONL")) {
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"command_execution",aggregated_output:"x".repeat(1_100_000)}}) + "\\n");
      return;
    }
    emit({type:"item.completed",item:{type:"reasoning",text:"SECRET REASONING"}});
    emit({type:"item.completed",item:{type:"agent_message",text:prompt.includes("OUTPUT_SCHEMA_JSON") ? JSON.stringify({children:[{childKey:"schema-child",title:"Schema child",description:"Schema description",acceptance:["Schema accepted"],ownership:"schema-team",files:["schema.js"],dependsOn:[]}]}) : "Visible answer"}});
    emit({type:"item.completed",item:{type:"command_execution",command:"npm test",status:"completed",exit_code:0,aggregated_output:"ok"}});
    if (prompt.includes("TURN_FAILED_ZERO")) {
      emit({type:"turn.failed",error:{message:"Protocol turn failed"}});
      return;
    }
    if (prompt.includes("ROOT_ERROR_COMPLETED")) emit({type:"error",message:"Recoverable protocol warning"});
    if (prompt.includes("ROOT_ERROR_ZERO")) {
      emit({type:"error",message:"Protocol root error"});
      return;
    }
    if (prompt.includes("NO_TERMINAL")) return;
    if (prompt.includes("ITEM_ERROR")) {
      emit({type:"item.completed",item:{id:"item-error-1",type:"error",error:{code:"THREAD_NOT_FOUND",message:"Recoverable item error"}}});
    }
    if (prompt.includes("WAIT")) {
      const timer = setTimeout(() => { emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}); }, 800);
      process.on("SIGTERM", () => { clearTimeout(timer); process.exit(143); });
      return;
    }
    if (prompt.includes("STDERR_FAILURE")) {
      process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\\n");
      process.exit(1);
      return;
    }
    if (prompt.includes("FAIL")) process.exit(7);
    emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
  });
}
`);
  await chmod(executable, 0o755);

  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      project: { rootPaths: [workspace] },
      other: { rootPaths: [otherWorkspace] },
    },
  }));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  database.createProject({ id: "other", name: "Other", workspacePath: null });
  const service = new AiChatService({
    database,
    codexExecutable: executable,
    codexStatePath,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
    temporaryDirectory,
    processEnv: {
      ...process.env,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_DESCENDANT_PATH: descendantPath,
    },
    killGraceMs: 50,
  });
  return {
    capturePath,
    database,
    databasePath,
    descendantPath,
    directory,
    otherWorkspace,
    service,
    temporaryDirectory,
    workspace,
    async close() {
      await this.service.close();
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events", async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fixture.service.getCatalog("project");
    assert.deepEqual(catalog.models, [{
      slug: "gpt-real",
      displayName: "GPT Real",
      description: "Real fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
    }]);
    assert.deepEqual(catalog.skills, [{
      id: "real-skill",
      label: "Real Skill",
      description: "",
      path: "",
      scope: "repo",
    }]);

    const thread = await fixture.service.createThread({
      projectId: "project",
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.workspacePath, fixture.workspace);

    const first = await fixture.service.startTurn(thread.id, {
      message: "HIDDEN_SENTINEL first \uFFFC",
      skillIds: ["real-skill"],
    });
    await waitFor(() => fixture.service.getRun(first.id)?.status !== "running");
    const second = await fixture.service.startTurn(thread.id, { message: "second" });
    await waitFor(() => fixture.service.getRun(second.id)?.status !== "running");

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(captures[0].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "--skip-git-repo-check",
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "-",
    ]);
    assert.equal(captures[0].args.join(" ").includes("HIDDEN_SENTINEL"), false);
    assert.match(captures[0].prompt, /\[\$manage-taskboard\]\(\/fixture\/manage-taskboard\/SKILL\.md\) e-taskboard/);
    assert.match(captures[0].prompt, /\$real-skill/);
    assert.match(captures[0].prompt, /HIDDEN_SENTINEL first/);
    assert.deepEqual(captures[1].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "--skip-git-repo-check",
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "resume", "codex-thread-1", "-",
    ]);
    assert.equal(captures[1].args.includes("--last"), false);

    const snapshot = fixture.service.getThreadSnapshot(thread.id);
    assert.equal(snapshot.thread.codexThreadId, "codex-thread-1");
    assert.equal(snapshot.events.some((event) => event.content?.includes("SECRET REASONING")), false);
    assert.equal(snapshot.events.some((event) => event.content === "Visible answer"), true);
    assert.equal(snapshot.events.some((event) => event.type === "command_execution"), true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("HIDDEN_SENTINEL"), true);
    assert.equal(serialized.includes("<taskboard_context>"), false);
    const persisted = JSON.stringify(
      fixture.database.database.prepare("SELECT * FROM ai_chat_events").all(),
    );
    assert.equal(persisted.includes("<taskboard_context>"), false);
    assert.equal(persisted.includes("SECRET REASONING"), false);
  } finally {
    await fixture.close();
  }
});

test("native thread removal is a stable run error and never creates a replacement thread", async () => {
  const fixture = await createFixture();
  try {
    const normalized = normalizeCodexEvent({
      type: "error",
      error: { code: "THREAD_NOT_FOUND", message: "native thread was removed" },
    });
    assert.equal(normalized.data.errorCode, CODEX_THREAD_NOT_FOUND);

    const thread = fixture.database.createAiChatThread({
      id: "missing-native-thread",
      title: "Missing native thread",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
      },
      codexThreadId: "codex-preserved",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const run = await fixture.service.startTurn(thread.id, { message: "MISSING_NATIVE" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    const settled = fixture.service.getRun(run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, CODEX_THREAD_NOT_FOUND);
    assert.equal(fixture.service.getThread(thread.id).codexThreadId, "codex-preserved");
    assert.equal(fixture.service.getThreadSnapshot(thread.id).runs[0].errorCode, CODEX_THREAD_NOT_FOUND);
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(captures.at(-1).args.includes("resume"), true);
    assert.equal(captures.at(-1).args.includes("codex-preserved"), true);
  } finally {
    await fixture.close();
  }
});

test("a failing resume item error is promoted to the persisted run error code", async () => {
  const fixture = await createFixture();
  try {
    const thread = fixture.database.createAiChatThread({
      id: "item-error-resume-thread",
      title: "Item error resume",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
      },
      codexThreadId: "codex-item-error-preserved",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const run = await fixture.service.startTurn(thread.id, { message: "ITEM_ERROR FAIL resume" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    const settled = fixture.service.getRun(run.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorCode, CODEX_THREAD_NOT_FOUND);
    assert.equal(fixture.service.getThread(thread.id).codexThreadId, "codex-item-error-preserved");
    const capture = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(capture.args.slice(capture.args.indexOf("resume")), [
      "resume",
      "codex-item-error-preserved",
      "-",
    ]);
  } finally {
    await fixture.close();
  }
});

test("thread-not-found is structured across item errors, split stderr, fresh turns, and resumes", async () => {
  const fixture = await createFixture();
  try {
    const itemError = normalizeCodexEvent({
      type: "item.completed",
      item: {
        id: "item-error-contract",
        type: "error",
        error: { code: "THREAD_NOT_FOUND", message: "native thread was removed" },
      },
    });
    assert.equal(itemError.data.errorCode, CODEX_THREAD_NOT_FOUND);

    const fresh = await fixture.service.createThread({ projectId: "project" });
    const freshRun = await fixture.service.startTurn(fresh.id, { message: "MISSING_NATIVE fresh" });
    await waitFor(() => fixture.service.getRun(freshRun.id)?.status !== "running");
    assert.equal(fixture.service.getRun(freshRun.id).status, "failed");
    assert.equal(fixture.service.getRun(freshRun.id).errorCode, null);
    assert.equal(fixture.service.getThread(fresh.id).codexThreadId, "codex-thread-1");

    const split = fixture.database.createAiChatThread({
      id: "split-stderr-thread",
      title: "Split stderr",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
      },
      codexThreadId: "codex-split-preserved",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const splitRun = await fixture.service.startTurn(split.id, { message: "STDERR_SPLIT resume" });
    await waitFor(() => fixture.service.getRun(splitRun.id)?.status !== "running");
    assert.equal(fixture.service.getRun(splitRun.id).status, "failed");
    assert.equal(fixture.service.getRun(splitRun.id).errorCode, CODEX_THREAD_NOT_FOUND);
    assert.equal(fixture.service.getThread(split.id).codexThreadId, "codex-split-preserved");
    const splitCapture = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(splitCapture.args.slice(splitCapture.args.indexOf("resume")), ["resume", "codex-split-preserved", "-"]);
  } finally {
    await fixture.close();
  }
});

test("archived AI threads are read-only, standalone lifecycle uses CAS, and task threads follow task lifecycle", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  try {
    const standalone = await fixture.service.createThread({ projectId: "project" });
    const archived = fixture.service.archiveThread(standalone.id, standalone.version);
    assert.notEqual(archived.archivedAt, null);
    assert.throws(
      () => fixture.service.archiveThread(standalone.id, archived.version - 1),
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED",
    );
    await assert.rejects(
      fixture.service.updateThread(standalone.id, { title: "must not update" }),
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED",
    );
    await assert.rejects(
      fixture.service.startTurn(standalone.id, { message: "must not start" }),
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED",
    );
    const restored = fixture.service.restoreThread(standalone.id, archived.version);
    assert.equal(restored.archivedAt, null);
    assert.throws(
      () => fixture.service.restoreThread(standalone.id, restored.version),
      (error) => error.code === "AI_CHAT_THREAD_NOT_ARCHIVED",
    );

    const task = fixture.database.createTask({
      id: "archived-ai-task",
      projectId: "project",
      title: "Archived AI task",
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
      threadId: "archived-ai-task-thread",
    });
    const taskThread = fixture.database.createAiChatThread({
      id: "archived-ai-task-thread",
      title: task.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
        issueId: task.id,
        issueIdentifier: task.identifier,
      },
      codexThreadId: "codex-task-preserved",
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    assert.throws(
      () => fixture.service.archiveThread(taskThread.id, taskThread.version),
      (error) => error.code === "TASK_BOUND_THREAD_LIFECYCLE",
    );
    const archivedTask = fixture.database.archiveTask(task.id, task.version);
    const archivedTaskThread = fixture.database.getAiChatThread(taskThread.id);
    assert.throws(
      () => fixture.service.archiveThread(taskThread.id, archivedTaskThread.version),
      (error) => error.code === "TASK_BOUND_THREAD_LIFECYCLE",
    );
    await assert.rejects(
      fixture.service.createThread({ projectId: "project", issueId: task.id }),
      (error) => error.code === "TASK_ARCHIVED",
    );
    await assert.rejects(
      fixture.service.startTurn(taskThread.id, { message: "must not start archived task" }),
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED" || error.code === "TASK_ARCHIVED",
    );
    assert.throws(
      () => fixture.service.restoreThread(taskThread.id, archivedTaskThread.version),
      (error) => error.code === "TASK_BOUND_THREAD_LIFECYCLE",
    );
    const threadCountBeforeRestore = fixture.database.listAiChatThreads({ archived: "all" }).length;
    const restoredTask = fixture.database.restoreTask(task.id, archivedTask.version);
    assert.equal(restoredTask.archivedAt, null);
    assert.equal(restoredTask.threadId, task.threadId);
    assert.equal(fixture.database.getAiChatThread(taskThread.id).codexThreadId, "codex-task-preserved");
    fixture.service.getCatalog = async () => ({
      models: [{
        slug: "gpt-5.6-terra",
        displayName: "Terra",
        description: "Worker fixture",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["max"],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      }],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
    const resumed = await fixture.service.startTurn(taskThread.id, { message: "resume after restore" });
    await waitFor(() => fixture.service.getRun(resumed.id)?.status !== "running");
    assert.equal(fixture.service.getRun(resumed.id).status, "completed");
    const resumedCapture = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
    assert.deepEqual(resumedCapture.args.slice(resumedCapture.args.indexOf("resume")), [
      "resume",
      "codex-task-preserved",
      "-",
    ]);
    assert.equal(fixture.database.listAiChatThreads({ archived: "all" }).length, threadCountBeforeRestore);
    assert.equal(fixture.database.getAiChatThread(taskThread.id).codexThreadId, "codex-task-preserved");
  } finally {
    await fixture.close();
  }
});

test("archive and startTurn have one winner and archive never interrupts an existing run", async () => {
  const fixture = await createFixture();
  const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
  try {
    let interruptCalls = 0;
    const originalInterrupt = fixture.service.interrupt.bind(fixture.service);
    fixture.service.interrupt = async (...args) => {
      interruptCalls += 1;
      return originalInterrupt(...args);
    };
    const firstTask = fixture.database.createTask({
      id: "archive-race-first",
      projectId: "project",
      title: "Archive first",
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
    });
    const firstThread = fixture.database.createAiChatThread({
      id: "archive-race-first-thread",
      title: firstTask.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
        issueId: firstTask.id,
        issueIdentifier: firstTask.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
    let releaseFirstCatalog;
    let catalogEnteredResolve;
    const firstCatalogEntered = new Promise((resolve) => {
      catalogEnteredResolve = resolve;
    });
    const firstCatalogRelease = new Promise((resolve) => {
      releaseFirstCatalog = resolve;
    });
    fixture.service.getCatalog = async (projectId) => {
      catalogEnteredResolve();
      await firstCatalogRelease;
      return originalGetCatalog(projectId);
    };
    const startBeforeArchive = fixture.service.startTurn(firstThread.id, {
      message: "archive won",
      skillIds: ["real-skill"],
    });
    await firstCatalogEntered;
    const archived = fixture.database.archiveTask(firstTask.id, firstTask.version);
    releaseFirstCatalog();
    await assert.rejects(
      startBeforeArchive,
      (error) => error.code === "AI_CHAT_THREAD_ARCHIVED" || error.code === "TASK_ARCHIVED",
    );
    assert.equal(fixture.database.listAiChatRuns(firstThread.id).length, 0);
    assert.equal(interruptCalls, 0);
    fixture.service.getCatalog = originalGetCatalog;
    fixture.service.getCatalog = async () => ({
      models: [{
        slug: "gpt-5.6-terra",
        displayName: "Terra",
        description: "Worker fixture",
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["max"],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      }],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });

    const secondTask = fixture.database.createTask({
      id: "archive-race-second",
      projectId: "project",
      title: "Run first",
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
      threadId: "archive-race-second-thread",
    });
    const secondThread = fixture.database.createAiChatThread({
      id: "archive-race-second-thread",
      title: secondTask.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: fixture.workspace,
        issueId: secondTask.id,
        issueIdentifier: secondTask.identifier,
      },
      role: "worker",
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const realArchiveTask = fixture.database.archiveTask.bind(fixture.database);
    let releaseArchive;
    let archiveEnteredResolve;
    const archiveEntered = new Promise((resolve) => {
      archiveEnteredResolve = resolve;
    });
    const archiveRelease = new Promise((resolve) => {
      releaseArchive = resolve;
    });
    fixture.database.archiveTask = (...args) => {
      archiveEnteredResolve();
      return archiveRelease.then(() => realArchiveTask(...args));
    };
    const archiveBeforeRun = fixture.database.archiveTask(secondTask.id, secondTask.version);
    await archiveEntered;
    const run = await fixture.service.startTurn(secondThread.id, { message: "WAIT" });
    releaseArchive();
    await assert.rejects(
      archiveBeforeRun,
      (error) => error.code === "TASK_ARCHIVE_BLOCKED",
    );
    assert.equal(fixture.database.getAiChatRun(run.id).status, "running");
    assert.equal(fixture.database.getTask(secondTask.id).archivedAt, null);
    assert.equal(interruptCalls, 0);
    fixture.database.archiveTask = realArchiveTask;
    await fixture.service.interrupt(run.id);
    await waitFor(() => fixture.service.getRun(run.id)?.status === "interrupted");
    assert.equal(fixture.database.getAiChatThread(secondThread.id).archivedAt, null);
    assert.equal(archived.archivedAt !== null, true);
  } finally {
    await fixture.close();
  }
});

test("task threads use role defaults, preserve selected models, and keep duplicate-run protection", async () => {
  const fixture = await createFixture();
  try {
    fixture.service.getCatalog = async () => ({
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
        {
          slug: "gpt-5.6-luna",
          displayName: "Luna",
          description: "Default worker fixture",
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: ["max"],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
    const createTask = (input) => fixture.database.createTask({
      description: "",
      actor: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
      ...input,
    });
    const plannerTask = createTask({
      projectId: "project",
      title: "Main task",
      status: "backlog",
      priority: "none",
      labels: ["主任务"],
    });
    const childTask = createTask({
      projectId: "project",
      title: "Child task",
      status: "backlog",
      priority: "none",
      labels: [],
    });
    fixture.database.addTaskRelation(
      childTask.id,
      childTask.version,
      "parent",
      plannerTask.id,
    );
    const ordinaryTask = createTask({
      projectId: "project",
      title: "Ordinary development task",
      status: "backlog",
      priority: "none",
      labels: [],
    });

    await assert.rejects(
      fixture.service.createThread({
        projectId: "project",
        issueId: ordinaryTask.id,
        role: "planner",
      }),
      (error) => error.code === "TASK_STRATEGY_LOCKED",
    );

    const plannerThread = await fixture.service.createThread({
      projectId: "project",
      issueId: plannerTask.id,
    });
    const childThread = await fixture.service.createThread({
      projectId: "project",
      issueId: childTask.id,
    });
    const ordinaryThread = await fixture.service.createThread({
      projectId: "project",
      issueId: ordinaryTask.id,
    });
    assert.deepEqual(
      {
        role: plannerThread.role,
        model: plannerThread.model,
        reasoningEffort: plannerThread.reasoningEffort,
        serviceTier: plannerThread.serviceTier,
        sandbox: plannerThread.sandbox,
      },
      TASK_AI_STRATEGIES.planner,
    );
    assert.deepEqual(
      {
        role: childThread.role,
        model: childThread.model,
        reasoningEffort: childThread.reasoningEffort,
        serviceTier: childThread.serviceTier,
        sandbox: childThread.sandbox,
      },
      TASK_AI_STRATEGIES.worker,
    );
    assert.equal(ordinaryThread.role, "worker");

    const concurrentTask = createTask({
      projectId: "project",
      title: "Concurrent child task",
      status: "backlog",
      priority: "none",
      labels: [],
    });
    const [concurrentThreadA, concurrentThreadB] = await Promise.all([
      fixture.service.createThread({ projectId: "project", issueId: concurrentTask.id }),
      fixture.service.createThread({ projectId: "project", issueId: concurrentTask.id }),
    ]);
    assert.equal(concurrentThreadA.id, concurrentThreadB.id);

    const selectedPlanner = await fixture.service.updateThread(plannerThread.id, {
      model: "gpt-5.6-luna",
    });
    assert.equal(selectedPlanner.model, "gpt-5.6-luna");
    const plannerRun = await fixture.service.startTurn(plannerThread.id, { message: "planner" });
    await waitFor(() => fixture.service.getRun(plannerRun.id)?.status === "completed");
    assert.equal(fixture.service.getThread(plannerThread.id).model, "gpt-5.6-luna");
    const activePlannerThread = fixture.database.createAiChatThread({
      id: "planner-active",
      title: "Active planner",
      status: "running",
      origin: plannerThread.origin,
      role: "planner",
      model: TASK_AI_STRATEGIES.planner.model,
      reasoningEffort: TASK_AI_STRATEGIES.planner.reasoningEffort,
      serviceTier: TASK_AI_STRATEGIES.planner.serviceTier,
      sandbox: TASK_AI_STRATEGIES.planner.sandbox,
    });
    const activePlannerRun = fixture.database.createAiChatRun({
      id: "planner-active-run",
      threadId: activePlannerThread.id,
      status: "running",
    });
    const duplicate = await fixture.service.createThread({
      projectId: "project",
      issueId: plannerTask.id,
    });
    assert.equal(duplicate.id, activePlannerThread.id);

    const secondPlannerThread = fixture.database.createAiChatThread({
      id: "planner-duplicate",
      title: "Duplicate planner",
      origin: plannerThread.origin,
      role: "planner",
      model: TASK_AI_STRATEGIES.planner.model,
      reasoningEffort: TASK_AI_STRATEGIES.planner.reasoningEffort,
      serviceTier: TASK_AI_STRATEGIES.planner.serviceTier,
      sandbox: TASK_AI_STRATEGIES.planner.sandbox,
    });
    await assert.rejects(
      fixture.service.startTurn(secondPlannerThread.id, { message: "must not run" }),
      (error) => error.code === "TASK_THREAD_BUSY",
    );
    fixture.database.updateAiChatRun(activePlannerRun.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const promotedTask = fixture.database.updateTask(
      ordinaryTask.id,
      ordinaryTask.version,
      { labels: ["主任务"] },
    );
    assert.deepEqual(promotedTask.labels, ["主任务"]);
    const promotedRun = await fixture.service.startTurn(ordinaryThread.id, {
      message: "promoted planner",
    });
    await waitFor(() => fixture.service.getRun(promotedRun.id)?.status === "completed");
    assert.deepEqual(
      {
        role: fixture.service.getThread(ordinaryThread.id).role,
        model: fixture.service.getThread(ordinaryThread.id).model,
        reasoningEffort: fixture.service.getThread(ordinaryThread.id).reasoningEffort,
        serviceTier: fixture.service.getThread(ordinaryThread.id).serviceTier,
        sandbox: fixture.service.getThread(ordinaryThread.id).sandbox,
      },
      {
        role: TASK_AI_STRATEGIES.planner.role,
        model: TASK_AI_STRATEGIES.worker.model,
        reasoningEffort: TASK_AI_STRATEGIES.worker.reasoningEffort,
        serviceTier: TASK_AI_STRATEGIES.worker.serviceTier,
        sandbox: TASK_AI_STRATEGIES.planner.sandbox,
      },
    );

    const workerRun = await fixture.service.startTurn(childThread.id, { message: "worker" });
    await waitFor(() => fixture.service.getRun(workerRun.id)?.status === "completed");
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const plannerCapture = captures.find((capture) => capture.prompt.includes("planner"));
    const workerCapture = captures.find((capture) => capture.prompt.includes("worker"));
    assert.ok(plannerCapture, JSON.stringify(captures));
    assert.ok(workerCapture, JSON.stringify(captures));
    assert.equal(plannerCapture.args.includes('-c'), true);
    assert.equal(plannerCapture.args.includes("service_tier="), false);
    assert.equal(plannerCapture.args.includes("-s") && plannerCapture.args.includes("read-only"), true);
    assert.equal(plannerCapture.args.includes("--skip-git-repo-check"), true);
    assert.match(plannerCapture.prompt, /Only plan, decompose, coordinate/);
    assert.match(plannerCapture.prompt, /Do not modify product code/);
    assert.equal(workerCapture.args.includes('service_tier="priority"'), true);
    assert.equal(workerCapture.args.includes("--skip-git-repo-check"), true);
    assert.match(workerCapture.prompt, /normal development-task semantics/);

    await fixture.service.updateThread(plannerThread.id, { serviceTier: "priority" });
    const fastPlannerRun = await fixture.service.startTurn(plannerThread.id, {
      message: "planner-fast",
    });
    await waitFor(() => fixture.service.getRun(fastPlannerRun.id)?.status === "completed");
    const fastCaptures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const fastPlannerCapture = fastCaptures.find((capture) => capture.prompt.includes("planner-fast"));
    assert.ok(fastPlannerCapture, JSON.stringify(fastCaptures));
    assert.equal(fastPlannerCapture.args.includes('service_tier="priority"'), true);
  } finally {
    await fixture.close();
  }
});

test("delayed thread.started publishes worker thread changes once for worker and worker_attempt dispatches", async () => {
  const fixture = await createFixture();
  try {
    fixture.service.getCatalog = async () => ({
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
    const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };
    const createTask = (title, labels = []) => fixture.database.createTask({
      projectId: "project",
      title,
      description: "LATE_THREAD",
      status: "todo",
      priority: "none",
      labels,
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const parent = createTask("Delayed parent", ["主任务"]);
    const workerChild = createTask("Worker child");
    const attemptChild = createTask("Worker attempt child");
    fixture.database.addTaskRelation(workerChild.id, workerChild.version, "parent", parent.id);
    fixture.database.addTaskRelation(attemptChild.id, attemptChild.version, "parent", parent.id);
    fixture.database.beginTaskOrchestration(parent.id, "delayed-planner");
    fixture.database.updateTaskOrchestration(parent.id, { status: "planned" });
    const timestamp = new Date().toISOString();
    for (const [child, childKey] of [[workerChild, "worker"], [attemptChild, "attempt"]]) {
      fixture.database.database.prepare(`
        INSERT INTO task_orchestration_children (
          parent_task_id, child_key, task_id, title, description,
          acceptance_json, ownership_json, files_json, depends_on_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, '[]', '[]', ?, ?)
      `).run(
        parent.id,
        childKey,
        child.id,
        child.title,
        child.description,
        JSON.stringify("worker"),
        timestamp,
        timestamp,
      );
    }
    const createWorkerThread = (id, task) => fixture.database.createAiChatThread({
      id,
      title: task.identifier,
      origin: {
        projectId: "project",
        projectName: "Project",
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
    const workerThread = createWorkerThread("dashi-worker-late", workerChild);
    const attemptThread = createWorkerThread("dashi-attempt-late", attemptChild);
    const dispatches = [
      {
        key: "delayed-worker",
        child: workerChild,
        childKey: "worker",
        kind: "worker",
        thread: workerThread,
      },
      {
        key: "delayed-attempt",
        child: attemptChild,
        childKey: "attempt",
        kind: "worker_attempt",
        thread: attemptThread,
      },
    ];
    for (const dispatch of dispatches) {
      fixture.database.claimTaskDispatch({
        dispatchKey: dispatch.key,
        parentId: parent.id,
        childKey: dispatch.childKey,
        taskId: dispatch.child.id,
        kind: dispatch.kind,
        role: "worker",
      });
      fixture.database.bindTaskDispatch(dispatch.key, { threadId: dispatch.thread.id });
    }

    const updates = [];
    const unsubscribe = fixture.service.subscribeThreadUpdated((payload) => updates.push(payload));
    assert.equal(
      fixture.database.getTaskExecutionOverview(parent.id).children
        .find((child) => child.id === workerChild.id).codexThreadId,
      null,
    );
    const workerRun = await fixture.service.startTurn(
      workerThread.id,
      { message: "LATE_THREAD" },
      { dispatchKey: "delayed-worker", kind: "worker" },
    );
    assert.equal(
      fixture.database.getTaskExecutionOverview(parent.id).children
        .find((child) => child.id === workerChild.id).codexThreadId,
      null,
    );
    await waitFor(() => fixture.service.getRun(workerRun.id)?.status === "completed");
    await waitFor(() => updates.length === 1);
    assert.deepEqual(
      {
        dispatchKey: updates[0].dispatchKey,
        previous: updates[0].previousThread.codexThreadId,
        aiThreadId: updates[0].thread.id,
        codexThreadId: updates[0].thread.codexThreadId,
      },
      {
        dispatchKey: "delayed-worker",
        previous: null,
        aiThreadId: workerThread.id,
        codexThreadId: "codex-late",
      },
    );
    assert.equal(
      fixture.database.getTaskExecutionOverview(parent.id).children
        .find((child) => child.id === workerChild.id).codexThreadId,
      "codex-late",
    );

    fixture.database.claimTaskDispatch({
      dispatchKey: "delayed-worker-replay",
      parentId: parent.id,
      childKey: "worker",
      taskId: workerChild.id,
      kind: "worker",
      role: "worker",
    });
    fixture.database.bindTaskDispatch("delayed-worker-replay", { threadId: workerThread.id });
    const replayRun = await fixture.service.startTurn(
      workerThread.id,
      { message: "LATE_THREAD replay" },
      { dispatchKey: "delayed-worker-replay", kind: "worker" },
    );
    await waitFor(() => fixture.service.getRun(replayRun.id)?.status === "completed");
    assert.equal(updates.length, 1, "the same persisted Codex id does not emit again");

    const attemptRun = await fixture.service.startTurn(
      attemptThread.id,
      { message: "LATE_THREAD" },
      { dispatchKey: "delayed-attempt", kind: "worker_attempt" },
    );
    await waitFor(() => fixture.service.getRun(attemptRun.id)?.status === "completed");
    await waitFor(() => updates.length === 2);
    assert.equal(updates[1].dispatchKey, "delayed-attempt");
    assert.equal(updates[1].thread.id, attemptThread.id);
    assert.equal(
      fixture.database.getTaskExecutionOverview(parent.id).children
        .find((child) => child.id === attemptChild.id).codexThreadId,
      "codex-late",
    );
    unsubscribe();
    await fixture.service.close();
    assert.equal(fixture.service.threadUpdatedListeners.size, 0);
  } finally {
    await fixture.close();
  }
});

test("internal task turns use an output-schema file, parse the final assistant JSON, and reuse one dispatch", async () => {
  const fixture = await createFixture();
  try {
    fixture.service.getCatalog = async () => ({
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
    const main = fixture.database.createTask({
      projectId: "project",
      title: "Schema planner",
      description: "Plan this task",
      status: "todo",
      priority: "none",
      labels: ["主任务"],
      actor: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.service.createThread({ projectId: "project", issueId: main.id });
    const dispatchKey = `test-dispatch:${main.id}`;
    const schema = {
      type: "object",
      required: ["children"],
      properties: { children: { type: "array" } },
    };
    const run = await fixture.service.startTurn(
      thread.id,
      { message: "OUTPUT_SCHEMA_JSON" },
      { outputSchema: schema, dispatchKey, kind: "planner" },
    );
    await waitFor(() => fixture.service.getRun(run.id)?.status === "completed");
    const snapshot = fixture.service.getThreadSnapshot(thread.id);
    const finalAssistant = snapshot.events.findLast((event) => event.role === "assistant");
    assert.deepEqual(JSON.parse(finalAssistant.content).children[0].childKey, "schema-child");
    assert.equal(snapshot.runs[0].dispatchKey, dispatchKey);
    assert.equal(fixture.database.getTaskDispatch(dispatchKey).status, "completed");

    const duplicate = await fixture.service.startTurn(
      thread.id,
      { message: "OUTPUT_SCHEMA_JSON again" },
      { outputSchema: schema, dispatchKey, kind: "planner" },
    );
    assert.equal(duplicate.id, run.id);
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.equal(capture.args.includes("--output-schema"), true);
    assert.equal(capture.args[capture.args.indexOf("--output-schema") + 1].endsWith("output-schema.json"), true);
    assert.doesNotMatch(capture.prompt, /manage-taskboard|taskctl/);
  } finally {
    await fixture.close();
  }
});

test("public task turns cannot claim a server-managed dispatch but may replay its bound run", async () => {
  const fixture = await createFixture();
  try {
    fixture.service.getCatalog = async () => ({
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
    const main = fixture.database.createTask({
      projectId: "project",
      title: "Managed planner",
      description: "Planner",
      status: "todo",
      priority: "none",
      labels: ["主任务"],
      actor: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      assignee: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    });
    const dispatchKey = `task-orchestration:${main.id}:planner`;
    fixture.database.beginTaskOrchestration(main.id, dispatchKey);
    const thread = await fixture.service.createThread({ projectId: "project", issueId: main.id });

    await assert.rejects(
      fixture.service.startTurn(thread.id, { message: "public prompt" }),
      (error) => error.code === "TASK_DISPATCH_SERVER_MANAGED",
    );
    assert.equal(fixture.database.getTaskDispatch(dispatchKey).runId, null);

    const serverRun = await fixture.service.startTurn(
      thread.id,
      { message: "OUTPUT_SCHEMA_JSON" },
      { dispatchKey, kind: "planner" },
    );
    await waitFor(() => fixture.service.getRun(serverRun.id)?.status === "completed");
    const replay = await fixture.service.startTurn(thread.id, { message: "public replay" });
    assert.equal(replay.id, serverRun.id);
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(captures.length, 1);
  } finally {
    await fixture.close();
  }
});

test("same-thread turns are locked, different threads run concurrently, failures and interrupts settle", async () => {
  const fixture = await createFixture();
  try {
    const firstThread = await fixture.service.createThread({ projectId: "project" });
    const secondThread = await fixture.service.createThread({ projectId: "other" });
    const waiting = await fixture.service.startTurn(firstThread.id, { message: "WAIT" });
    await assert.rejects(
      fixture.service.startTurn(firstThread.id, { message: "must reject" }),
      (error) => error.code === "THREAD_BUSY",
    );
    const parallel = await fixture.service.startTurn(secondThread.id, { message: "normal" });
    await waitFor(() => fixture.service.getRun(parallel.id)?.status === "completed");
    const interrupted = await fixture.service.interrupt(waiting.id);
    assert.equal(interrupted.id, waiting.id);
    await waitFor(() => fixture.service.getRun(waiting.id)?.status === "interrupted");

    const failed = await fixture.service.startTurn(firstThread.id, { message: "FAIL" });
    await waitFor(() => fixture.service.getRun(failed.id)?.status === "failed");
    assert.equal(fixture.service.getRun(failed.id).exitCode, 7);
    assert.equal(
      fixture.service.getThreadSnapshot(firstThread.id).events.some(
        (event) => event.role === "error" && event.content.includes("code 7"),
      ),
      true,
    );

    const stderrFailure = await fixture.service.startTurn(firstThread.id, {
      message: "STDERR_FAILURE",
    });
    await waitFor(() => fixture.service.getRun(stderrFailure.id)?.status === "failed");
    const stderrSettled = fixture.service.getRun(stderrFailure.id);
    assert.equal(stderrSettled.exitCode, 1);
    assert.match(stderrSettled.error, /Not inside a trusted directory/);
    assert.equal(
      fixture.service.getThreadSnapshot(firstThread.id).events.some(
        (event) => event.role === "error" && event.content.includes("trusted directory"),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("concurrent same-thread turns atomically return busy and clean loser attachments", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const catalog = {
      models: [{
        slug: "gpt-real",
        displayName: "GPT Real",
        description: "Real fixture",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      }],
      skills: [],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    };
    let entered = 0;
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const bothEntered = new Promise((resolve) => {
      fixture.service.getCatalog = async () => {
        entered += 1;
        if (entered === 2) resolve();
        await released;
        return catalog;
      };
    });
    const before = new Set(
      (await readdir(fixture.temporaryDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-taskboard-ai-turn-"))
        .map((entry) => entry.name),
    );
    const attachment = {
      filename: "race.txt",
      contentType: "text/plain",
      data: Buffer.from("race attachment"),
      size: 15,
    };
    const first = fixture.service.startTurn(thread.id, {
      message: "WAIT concurrent winner",
      attachments: [attachment],
    });
    const second = fixture.service.startTurn(thread.id, {
      message: "WAIT concurrent loser",
      attachments: [attachment],
    });
    await bothEntered;
    release();
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code === "AI_CHAT_THREAD_BUSY" || rejected[0].reason.code === "THREAD_BUSY", true);
    assert.doesNotMatch(String(rejected[0].reason.code), /SQLITE|UNIQUE|ERR_/i);
    const winner = fulfilled[0].value;
    await waitFor(() => fixture.service.getRun(winner.id)?.status !== "running");
    assert.equal(fixture.database.listAiChatRuns(thread.id).length, 1);
    assert.equal(fixture.database.listAiChatRuns(thread.id)[0].id, winner.id);
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(captures.length, 1, "only one Codex process may be started");
    await waitFor(async () => {
      const current = await readdir(fixture.temporaryDirectory, { withFileTypes: true });
      return current.every((entry) => (
        !entry.isDirectory() || !entry.name.startsWith("codex-taskboard-ai-turn-")
      ));
    });
    const after = new Set(
      (await readdir(fixture.temporaryDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-taskboard-ai-turn-"))
        .map((entry) => entry.name),
    );
    assert.deepEqual(
      [...after].filter((name) => !before.has(name)),
      [],
      "loser and winner attachment directories must be cleaned after settlement",
    );
  } finally {
    await fixture.close();
  }
});

test("malformed Codex JSONL fails the run", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "MALFORMED" });
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");

    const failed = fixture.service.getRun(run.id);
    assert.equal(failed.error, "Codex emitted malformed JSONL");
    assert.equal(
      fixture.service.getThreadSnapshot(thread.id).events.some(
        (event) => event.role === "error"
          && event.content === "Codex emitted malformed JSONL",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("oversized Codex JSONL records a stable retryable error code", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "OVERSIZED_JSONL" });
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");

    const failed = fixture.service.getRun(run.id);
    assert.equal(failed.error, "Codex JSONL line exceeded 1048576 bytes");
    assert.equal(failed.errorCode, "CODEX_JSONL_LINE_TOO_LARGE");
  } finally {
    await fixture.close();
  }
});

test("parser and event callback failures kill a SIGTERM-resistant process group", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedError] of [
      ["MALFORMED_STUBBORN", "Codex emitted malformed JSONL"],
      ["CALLBACK_FATAL_STUBBORN", "Codex returned an unexpected thread id"],
    ]) {
      await rm(fixture.descendantPath, { force: true });
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status === "failed", 700);
      assert.equal(fixture.service.getRun(run.id).error, expectedError);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await assert.rejects(readFile(fixture.descendantPath), (error) => error.code === "ENOENT");
    }
  } finally {
    await fixture.close();
  }
});

test("protocol terminal events determine run success and item errors remain non-fatal", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedStatus] of [
      ["TURN_FAILED_ZERO", "failed"],
      ["ROOT_ERROR_ZERO", "failed"],
      ["NO_TERMINAL", "failed"],
      ["ITEM_ERROR", "completed"],
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status !== "running");
      const settled = fixture.service.getRun(run.id);
      assert.equal(settled.status, expectedStatus, message);
      if (message === "ITEM_ERROR") assert.equal(settled.errorCode, null);
    }
  } finally {
    await fixture.close();
  }
});

test("a recoverable root error does not override a later turn.completed", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "ROOT_ERROR_COMPLETED" });
    await waitFor(() => fixture.service.getRun(run.id).status !== "running");
    const settled = fixture.service.getRun(run.id);
    assert.equal(settled.status, "completed");
    assert.equal(settled.error, "Recoverable protocol warning");

    const failedThread = await fixture.service.createThread({ projectId: "project" });
    const failedRun = await fixture.service.startTurn(failedThread.id, { message: "ROOT_ERROR_ZERO" });
    await waitFor(() => fixture.service.getRun(failedRun.id).status !== "running");
    assert.equal(fixture.service.getRun(failedRun.id).status, "failed");
    assert.equal(fixture.service.getRun(failedRun.id).error, "Protocol root error");
  } finally {
    await fixture.close();
  }
});

test("startTurn revalidates the latest danger sandbox and persisted model settings", async () => {
  const fixture = await createFixture();
  try {
    for (const scenario of [
      {
        changes: { sandbox: "danger-full-access" },
        expectedCode: "DANGER_CONFIRMATION_REQUIRED",
      },
      {
        changes: { model: "retired-model" },
        expectedCode: "INVALID_MODEL",
      },
      {
        changes: { reasoningEffort: "ultra" },
        expectedCode: "INVALID_REASONING_EFFORT",
      },
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
      let releaseCatalog;
      let catalogRequested = false;
      const catalogGate = new Promise((resolve) => {
        releaseCatalog = resolve;
      });
      fixture.service.getCatalog = async (...args) => {
        catalogRequested = true;
        await catalogGate;
        return originalGetCatalog(...args);
      };

      const pending = fixture.service.startTurn(thread.id, { message: "must not spawn" });
      await waitFor(() => catalogRequested);
      fixture.database.updateAiChatThread(thread.id, scenario.changes);
      releaseCatalog();
      await assert.rejects(pending, (error) => error.code === scenario.expectedCode);
      assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
      fixture.service.getCatalog = originalGetCatalog;
    }
  } finally {
    await fixture.close();
  }
});

test("ordinary reopen leaves abandoned runs running until explicit startup recovery", async () => {
  const fixture = await createFixture();
  const thread = await fixture.service.createThread({ projectId: "project" });
  fixture.database.database.prepare(
    "UPDATE ai_chat_threads SET codex_thread_id = ?, status = 'running' WHERE id = ?",
  ).run("preserved-session", thread.id);
  fixture.database.database.prepare(`
    INSERT INTO ai_chat_runs (
      id, thread_id, status, exit_code, error, started_at, finished_at
    ) VALUES ('abandoned', ?, 'running', NULL, NULL, ?, NULL)
  `).run(thread.id, new Date().toISOString());
  const ordinary = new TaskboardDatabase(fixture.databasePath);
  assert.equal(ordinary.getAiChatRun("abandoned").status, "running");
  ordinary.close();
  await fixture.service.close();
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.databasePath);
  const restarted = new AiChatService({
    database: fixture.database,
    codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
    codexStatePath: path.join(fixture.directory, "codex-state.json"),
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  fixture.service = restarted;
  try {
    assert.equal(restarted.getRun("abandoned").status, "running");
    assert.equal(fixture.database.recoverAbandonedAiChatRuns(), 1);
    assert.equal(restarted.getRun("abandoned").status, "interrupted");
    assert.equal(restarted.getThread(thread.id).codexThreadId, "preserved-session");
  } finally {
    await fixture.close();
  }
});
