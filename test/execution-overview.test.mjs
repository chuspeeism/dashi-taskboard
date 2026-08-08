import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { createExecutionOverviewLoader } from "../web/src/executionOverviewLoader.ts";

const { register } = await import("tsx/esm/api");
register({ tsconfig: new URL("../web/tsconfig.json", import.meta.url).pathname });
const React = await import("react");
const { act } = React;
const { create: createTestRenderer } = await import("react-test-renderer");
const { TaskDetail } = await import("../web/src/components/TaskDetail.tsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testLocalStorage = new Map();
const testWindow = {
  localStorage: {
    getItem: (key) => testLocalStorage.get(key) ?? null,
    setItem: (key, value) => testLocalStorage.set(key, String(value)),
    removeItem: (key) => testLocalStorage.delete(key),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
const testDocument = {
  activeElement: null,
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.window = testWindow;
globalThis.document = testDocument;
globalThis.requestAnimationFrame = (callback) => {
  queueMicrotask(() => callback(Date.now()));
  return 1;
};

const actor = { type: "user", id: "local-user", name: "Local User", avatarUrl: null };

function taskForMount(id, title = id) {
  const child = {
    id: `${id}-child`,
    identifier: `${id.toUpperCase()}-CHILD`,
    projectId: "project",
    title: "Child relation",
    status: "todo",
    priority: "none",
    assignee: actor,
    archivedAt: null,
  };
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: "project",
    title,
    description: "",
    status: "in_progress",
    priority: "none",
    labels: [],
    sortOrder: 1,
    threadId: null,
    creatorType: "user",
    creatorId: actor.id,
    creatorName: actor.name,
    creatorAvatarUrl: actor.avatarUrl,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    archivedAt: null,
    relations: {
      parent: null,
      subIssues: [child],
      blockedBy: [],
      blocks: [],
      related: [],
    },
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function overviewFor(taskId, childTitle = null) {
  const task = taskForMount(taskId);
  return {
    parent: {
      id: task.id,
      identifier: task.identifier,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      archivedAt: task.archivedAt,
    },
    orchestration: null,
    children: childTitle === null ? [] : [{
      id: `${taskId}-overview-child`,
      identifier: `${task.identifier}-OVERVIEW`,
      title: childTitle,
      status: "todo",
      priority: "none",
      archivedAt: null,
      version: 1,
      handoff: null,
      aiThreadId: null,
      codexThreadId: null,
    }],
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createMountFetch() {
  const overviewRequests = [];
  const fetch = (input, init = {}) => {
    const url = String(input);
    if (url.includes("/execution-overview")) {
      const taskId = decodeURIComponent(url.split("/tasks/")[1].split("/")[0]);
      const request = {
        taskId,
        signal: init.signal,
        aborted: false,
        settled: false,
        resolve: null,
        reject: null,
      };
      const promise = new Promise((resolve, reject) => {
        request.resolve = (overview = overviewFor(taskId)) => {
          if (request.settled) return;
          request.settled = true;
          resolve(jsonResponse({ overview }));
        };
        request.reject = (error) => {
          if (request.settled) return;
          request.settled = true;
          reject(error);
        };
      });
      const abort = () => {
        request.aborted = true;
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      overviewRequests.push(request);
      return promise;
    }
    if (url.includes("/comments")) return Promise.resolve(jsonResponse({ comments: [] }));
    if (url.includes("/attachments")) return Promise.resolve(jsonResponse({ attachments: [] }));
    throw new Error(`Unexpected mount request: ${url}`);
  };
  return { fetch, overviewRequests };
}

function taskDetailElement(task, overrides = {}) {
  const props = {
    task,
    tasks: [task],
    currentUser: actor,
    availableLabels: [],
    workflows: [],
    developmentScan: { workspacePath: null, contexts: [] },
    developmentScanLoading: false,
    commentsRevision: 0,
    attachmentsRevision: 0,
    executionOverviewRevision: 0,
    localAiChatAvailable: true,
    queueNavigation: { label: "当前项目", previousTask: null, nextTask: null },
    onNavigateQueue: () => {},
    onUpdate: async (currentTask) => currentTask,
    onReassign: () => {},
    onOpenTask: () => {},
    onAddRelation: async (currentTask) => ({ task: currentTask, relatedTask: currentTask }),
    onRemoveRelation: async (currentTask) => ({ task: currentTask, relatedTask: currentTask }),
    onOpenThread: () => {},
    onOpenAiThread: () => {},
    onOpenInThread: () => {},
    openingThread: false,
    onError: () => {},
    onAnnounce: () => {},
    ...overrides,
  };
  return React.createElement(
    React.StrictMode,
    null,
    React.createElement(TaskDetail, props),
  );
}

test("execution overview loader deduplicates stable task ids, revisions, and cancels stale requests", () => {
  const requests = [];
  const loader = createExecutionOverviewLoader({
    request: (taskId, signal) => new Promise(() => {
      requests.push({ taskId, signal });
    }),
    onLoading: () => {},
    onSuccess: () => {},
    onError: () => {},
    onDisabled: () => {},
  });

  loader.reconcile({ taskId: "task-1", revision: 0, localAiChatAvailable: true });
  loader.reconcile({ taskId: "task-1", revision: 0, localAiChatAvailable: true });
  assert.equal(requests.length, 1, "a new task object with the same id does not refetch");

  loader.reconcile({ taskId: "task-1", revision: 1, localAiChatAvailable: true });
  assert.equal(requests.length, 2, "one revision creates one refresh request");
  assert.equal(requests[0].signal.aborted, true);
  loader.reconcile({ taskId: "task-1", revision: 1, localAiChatAvailable: true });
  assert.equal(requests.length, 2);

  loader.reconcile({ taskId: "task-2", revision: 1, localAiChatAvailable: true });
  assert.equal(requests.length, 3, "a parent task id change creates one new request");
  assert.deepEqual(requests.map(({ taskId }) => taskId), ["task-1", "task-1", "task-2"]);
  assert.equal(requests[1].signal.aborted, true);
  loader.dispose();
  assert.equal(requests[2].signal.aborted, true, "unmount cancels the active request");
});

test("TaskDetail StrictMode lifecycle keeps one effective request and cancels stale task work", async () => {
  const originalFetch = globalThis.fetch;
  const mountFetch = createMountFetch();
  globalThis.fetch = mountFetch.fetch;
  let renderer;
  try {
    const taskA = taskForMount("parent-a");
    await act(async () => {
      renderer = createTestRenderer(taskDetailElement(taskA));
    });
    assert.equal(mountFetch.overviewRequests.length, 1, "StrictMode mount has one effective overview GET");
    assert.equal(mountFetch.overviewRequests[0].taskId, taskA.id);
    mountFetch.overviewRequests[0].resolve(overviewFor(taskA.id, "initial overview"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(
      renderer.root.findAll((node) => node.props.className === "execution-sub-issue-title")
        .map((node) => node.children.join("")),
      ["initial overview"],
    );

    await act(async () => {
      renderer.update(taskDetailElement({ ...taskA, title: "same id, fresh task object" }));
    });
    assert.equal(mountFetch.overviewRequests.length, 1, "same task id object replacement does not refetch");

    await act(async () => {
      renderer.update(taskDetailElement(
        { ...taskA, title: "revision refresh" },
        { executionOverviewRevision: 1 },
      ));
    });
    assert.equal(mountFetch.overviewRequests.length, 2, "revision +1 creates exactly one refresh");
    assert.equal(mountFetch.overviewRequests[1].taskId, taskA.id);
    await act(async () => {
      renderer.update(taskDetailElement(
        { ...taskA, title: "same revision, another object" },
        { executionOverviewRevision: 1 },
      ));
    });
    assert.equal(mountFetch.overviewRequests.length, 2, "the same revision does not duplicate a refresh");

    const taskB = taskForMount("parent-b");
    await act(async () => {
      renderer.update(taskDetailElement(taskB, { executionOverviewRevision: 1 }));
    });
    assert.equal(mountFetch.overviewRequests.length, 3, "task id change requests the new parent once");
    assert.equal(mountFetch.overviewRequests[2].taskId, taskB.id);
    assert.equal(mountFetch.overviewRequests[1].aborted, true);
    mountFetch.overviewRequests[1].resolve(overviewFor(taskA.id, "stale overview"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(
      renderer.root.findAll((node) => node.props.className === "execution-sub-issue-title")
        .map((node) => node.children.join("")),
      ["initial overview"],
      "an aborted stale response cannot overwrite the mounted task's evidence",
    );
    assert.equal(mountFetch.overviewRequests[2].aborted, false);

    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });
    assert.equal(mountFetch.overviewRequests[2].aborted, true, "unmount aborts the unfinished new-parent request");
  } finally {
    if (renderer) {
      await act(async () => {
        renderer.unmount();
      });
    }
    globalThis.fetch = originalFetch;
  }
});

test("TaskDetail local capability skips overview requests and failed overview preserves relation fallback", async () => {
  const originalFetch = globalThis.fetch;
  const disabledFetch = createMountFetch();
  globalThis.fetch = disabledFetch.fetch;
  let disabledRenderer;
  try {
    await act(async () => {
      disabledRenderer = createTestRenderer(taskDetailElement(
        taskForMount("disabled-parent"),
        { localAiChatAvailable: false },
      ));
    });
    assert.equal(disabledFetch.overviewRequests.length, 0, "disabled local AI does not issue an overview GET");
    await act(async () => {
      disabledRenderer.unmount();
    });
    disabledRenderer = null;
  } finally {
    if (disabledRenderer) {
      await act(async () => {
        disabledRenderer.unmount();
      });
    }
    globalThis.fetch = originalFetch;
  }

  const failingFetch = createMountFetch();
  globalThis.fetch = failingFetch.fetch;
  let failingRenderer;
  try {
    await act(async () => {
      failingRenderer = createTestRenderer(taskDetailElement(taskForMount("failed-parent")));
    });
    assert.equal(failingFetch.overviewRequests.length, 1);
    failingFetch.overviewRequests[0].reject(new Error("overview unavailable"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(
      failingRenderer.root.findAll((node) => node.props.role === "alert")
        .some((node) => node.children.join("").includes("执行概览暂不可用")),
      true,
    );
    assert.equal(
      failingRenderer.root.findAll((node) => node.props.className === "issue-relation-row").length,
      1,
      "overview failure keeps the ordinary relation row visible",
    );
  } finally {
    if (failingRenderer) {
      await act(async () => {
        failingRenderer.unmount();
      });
    }
    globalThis.fetch = originalFetch;
  }
});

function createTask(database, input = {}) {
  return database.createTask({
    projectId: input.projectId ?? "project",
    title: input.title ?? "Task",
    description: input.description ?? "",
    status: input.status ?? "backlog",
    priority: input.priority ?? "none",
    labels: input.labels ?? [],
    threadId: input.threadId,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
}

function addParentRelation(database, child, parent) {
  return database.addTaskRelation(child.id, child.version, "parent", parent.id).task;
}

function addOrchestrationChild(database, parent, child, childKey) {
  const timestamp = new Date().toISOString();
  database.database.prepare(`
    INSERT INTO task_orchestration_children (
      parent_task_id, child_key, task_id, title, description,
      acceptance_json, ownership_json, files_json, depends_on_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parent.id,
    childKey,
    child.id,
    child.title,
    child.description,
    "[]",
    JSON.stringify("worker"),
    "[]",
    "[]",
    timestamp,
    timestamp,
  );
}

function addDispatch(database, {
  key,
  parent,
  child,
  kind,
  role,
  threadId = null,
  createdAt,
}) {
  const timestamp = createdAt ?? new Date().toISOString();
  database.database.prepare(`
    INSERT INTO task_orchestration_dispatches (
      dispatch_key, parent_task_id, child_key, task_id, kind, role,
      status, thread_id, run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    key,
    parent.id,
    child ? child.identifier : null,
    child?.id ?? parent.id,
    kind,
    role,
    "running",
    threadId,
    timestamp,
    timestamp,
  );
}

function addWorkerThread(database, task, id, codexThreadId = null, role = "worker") {
  return database.createAiChatThread({
    id,
    title: task.identifier,
    origin: {
      projectId: task.projectId,
      projectName: "Project",
      workspacePath: "/tmp/execution-overview-workspace",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    role,
    codexThreadId,
    model: role === "planner" ? "gpt-5.6-sol" : "gpt-5.6-terra",
    reasoningEffort: "max",
    serviceTier: "priority",
    sandbox: role === "planner" ? "read-only" : "workspace-write",
  });
}

function addHandoff(database, {
  id,
  sourceKey,
  parent,
  child,
  queueSeq,
  sourceKind = "run",
  state = "resolved",
  delivery = null,
  blocker = null,
  commentBody = null,
  sourceTaskVersion = child.version,
}) {
  const timestamp = new Date(Date.now() + queueSeq).toISOString();
  database.database.prepare(`
    INSERT INTO task_handoffs (
      id, source_key, source_kind, parent_task_id, queue_seq, child_key,
      child_task_id, child_status, task_status, source_task_version,
      source_task_status, delivery_summary, blocker_summary, latest_comment_json,
      state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sourceKey,
    sourceKind,
    parent.id,
    queueSeq,
    child.identifier,
    child.id,
    child.status === "blocked" ? "failed" : "completed",
    child.status,
    sourceTaskVersion,
    child.status,
    delivery,
    blocker,
    commentBody === null ? null : JSON.stringify({ body: commentBody }),
    state,
    timestamp,
    timestamp,
  );
}

async function createDatabaseFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-execution-overview-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  return {
    database,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("execution overview unions relations and orchestration children with evidence and thread boundaries", async () => {
  const fixture = await createDatabaseFixture();
  try {
    const { database } = fixture;
    const parent = createTask(database, {
      title: "Parent",
      status: "in_progress",
      labels: ["主任务"],
    });
    const statusChildren = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]
      .map((status) => createTask(database, {
        title: `${status} child`,
        status,
        threadId: status === "in_progress" ? "task-thread-must-not-leak" : undefined,
      }));
    for (const child of statusChildren) addParentRelation(database, child, parent);
    const archived = database.archiveTask(
      statusChildren[0].id,
      database.getTask(statusChildren[0].id).version,
    );
    const orchestration = database.beginTaskOrchestration(parent.id, "planner-dispatch");
    database.database.prepare(`
      UPDATE task_orchestrations SET status = 'planned' WHERE parent_task_id = ?
    `).run(parent.id);
    addOrchestrationChild(database, parent, statusChildren[3], "review");
    const orchestrationOnly = createTask(database, { title: "Orchestration only", status: "todo" });
    addOrchestrationChild(database, parent, orchestrationOnly, "orchestration-only");

    const done = statusChildren[5];
    addWorkerThread(database, done, "dashi-done", "codex-done");
    addDispatch(database, {
      key: "worker-done",
      parent,
      child: done,
      kind: "worker",
      role: "worker",
      threadId: "dashi-done",
    });
    addHandoff(database, {
      id: "handoff-old",
      sourceKey: "handoff-old-source",
      parent,
      child: done,
      queueSeq: 2,
      delivery: "old delivery",
      commentBody: "old comment",
      sourceTaskVersion: 1,
    });
    addHandoff(database, {
      id: "handoff-latest",
      sourceKey: "handoff-latest-source",
      parent,
      child: done,
      queueSeq: 9,
      delivery: "latest delivery",
      commentBody: "latest comment",
      sourceTaskVersion: 2,
    });

    const running = statusChildren[2];
    addWorkerThread(database, running, "dashi-running", "codex-running");
    addDispatch(database, {
      key: "worker-running",
      parent,
      child: running,
      kind: "worker",
      role: "worker",
      threadId: "dashi-running",
    });

    const noCodex = statusChildren[6];
    addWorkerThread(database, noCodex, "dashi-no-codex", null);
    addDispatch(database, {
      key: "worker-no-codex",
      parent,
      child: noCodex,
      kind: "worker_attempt",
      role: "worker",
      threadId: "dashi-no-codex",
    });

    const plannerOnly = statusChildren[1];
    addWorkerThread(database, plannerOnly, "planner-only-thread", "planner-codex", "planner");
    addDispatch(database, {
      key: "planner-child-dispatch",
      parent,
      child: plannerOnly,
      kind: "planner",
      role: "planner",
      threadId: "planner-only-thread",
    });
    addWorkerThread(database, parent, "parent-planner-thread", "parent-planner-codex", "planner");
    addDispatch(database, {
      key: "planner-parent-dispatch",
      parent,
      child: null,
      kind: "planner",
      role: "planner",
      threadId: "parent-planner-thread",
    });

    const overview = database.getTaskExecutionOverview(parent.identifier);
    assert.equal(overview.parent.id, parent.id);
    assert.equal(overview.orchestration.status, "planned");
    assert.equal(orchestration.parentId, parent.id);
    assert.equal(overview.children.length, statusChildren.length + 1);
    assert.equal(new Set(overview.children.map((child) => child.id)).size, overview.children.length);
    assert.deepEqual(
      new Set(overview.children.map((child) => child.status)),
      new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]),
    );

    const latest = overview.children.find((child) => child.id === done.id);
    assert.equal(latest.version, database.getTask(done.id).version);
    assert.equal(latest.handoff.queueSeq, 9);
    assert.equal(latest.handoff.delivery, "latest delivery");
    assert.equal(latest.handoff.summary, "latest delivery");
    assert.equal(latest.handoff.latestComment.body, "latest comment");
    assert.equal(latest.handoff.sourceKind, "run");
    assert.equal(latest.handoff.state, "resolved");
    assert.equal(latest.aiThreadId, "dashi-done");
    assert.equal(latest.codexThreadId, "codex-done");
    assert.notEqual(latest.aiThreadId, latest.codexThreadId);

    const runningOverview = overview.children.find((child) => child.id === running.id);
    assert.equal(runningOverview.handoff, null);
    assert.equal(runningOverview.aiThreadId, "dashi-running");
    assert.equal(runningOverview.codexThreadId, "codex-running");
    assert.notEqual(runningOverview.aiThreadId, "task-thread-must-not-leak");

    const noCodexOverview = overview.children.find((child) => child.id === noCodex.id);
    assert.equal(noCodexOverview.aiThreadId, "dashi-no-codex");
    assert.equal(noCodexOverview.codexThreadId, null);

    const plannerOverview = overview.children.find((child) => child.id === plannerOnly.id);
    assert.equal(plannerOverview.aiThreadId, null);
    assert.equal(plannerOverview.codexThreadId, null);
    const archivedOverview = overview.children.find((child) => child.id === archived.id);
    assert.equal(archivedOverview.archivedAt !== null, true);
    assert.equal(archivedOverview.version, archived.version);
  } finally {
    await fixture.close();
  }
});

test("ordinary parent overview keeps relation children and returns null orchestration, handoff, and threads", async () => {
  const fixture = await createDatabaseFixture();
  try {
    const parent = createTask(fixture.database, { title: "Ordinary parent" });
    const child = createTask(fixture.database, { title: "Ordinary child", status: "todo" });
    addParentRelation(fixture.database, child, parent);
    const overview = fixture.database.getTaskExecutionOverview(parent.id);
    assert.equal(overview.orchestration, null);
    assert.deepEqual(overview.children.map((item) => item.id), [child.id]);
    assert.equal(overview.children[0].handoff, null);
    assert.equal(overview.children[0].aiThreadId, null);
    assert.equal(overview.children[0].codexThreadId, null);
  } finally {
    await fixture.close();
  }
});

test("local execution overview API aggregates once and returns 404 for an unknown parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-execution-api-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
  });
  try {
    const parent = createTask(app.database, {
      projectId: "local",
      title: "API parent",
      status: "in_progress",
      labels: ["主任务"],
    });
    const relationChild = createTask(app.database, { projectId: "local", title: "Relation child" });
    addParentRelation(app.database, relationChild, parent);
    const orchestrationChild = createTask(app.database, { projectId: "local", title: "Orchestration child" });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    app.database.beginTaskOrchestration(parent.id, "api-planner-dispatch");
    addOrchestrationChild(app.database, parent, orchestrationChild, "api-only");

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(
      `${baseUrl}/api/local/ai/tasks/${encodeURIComponent(parent.identifier)}/execution-overview`,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(new Set(body.overview.children.map((child) => child.id)), new Set([
      relationChild.id,
      orchestrationChild.id,
    ]));

    const missing = await fetch(`${baseUrl}/api/local/ai/tasks/missing-parent/execution-overview`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "TASK_NOT_FOUND");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution overview UI keeps one request, local failure fallback, accessible status evidence, and separate thread entries", async () => {
  const [typesSource, apiSource, appSource, detailSource, relationsSource, chatSource, styles] = await Promise.all([
    readFile(new URL("../web/src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/IssueRelations.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/AiChat.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(typesSource, /export interface TaskExecutionOverview \{/);
  assert.match(typesSource, /aiThreadId: string \| null/);
  assert.match(typesSource, /codexThreadId: string \| null/);
  assert.match(typesSource, /interface TaskExecutionOverviewChild[\s\S]*?version: number/);
  assert.match(apiSource, /getTaskExecutionOverview/);
  assert.match(apiSource, /\/api\/local\/ai\/tasks\/\$\{encodeURIComponent\(parentId\)\}\/execution-overview/);
  assert.equal((detailSource.match(/request: getTaskExecutionOverview/g) ?? []).length, 1);
  assert.match(detailSource, /createExecutionOverviewLoader/);
  assert.match(detailSource, /\}, \[executionOverviewRevision, localAiChatAvailable, task\.id, executionOverviewLoader\]\);/);
  assert.match(detailSource, /executionOverviewLoaderRef/);
  assert.doesNotMatch(detailSource, /\[executionOverviewRevision, localAiChatAvailable, task\]\)/);
  assert.match(appSource, /localExecutionOverviewAvailable = localAiChatAvailable && taskboardMetadata\?\.mode !== "cloud"/);
  assert.match(detailSource, /executionOverviewError/);
  assert.match(relationsSource, /已交付 \{delivered\}\/\{activeChildren\.length\}/);
  assert.match(relationsSource, /\["in_review", "pending_retrospective", "done"\]\.includes\(child\.status\)/);
  assert.doesNotMatch(relationsSource, /已验收/);
  assert.match(relationsSource, /child\.aiThreadId &&/);
  assert.match(relationsSource, /child\.codexThreadId &&/);
  assert.match(relationsSource, /onOpenAiThread\(child\.aiThreadId/);
  assert.match(relationsSource, /onOpenThread\(child\.codexThreadId/);
  assert.match(relationsSource, /onRestoreArchivedTask/);
  assert.match(relationsSource, /child\.version/);
  assert.match(relationsSource, /恢复中…/);
  assert.match(detailSource, /已保留现有子议题关系/);
  assert.match(appSource, /restoreTaskByVersion/);
  assert.match(appSource, /taskboard:ai-thread-open/);
  assert.match(chatSource, /taskboard:ai-thread-open/);
  assert.match(styles, /overflow-wrap: anywhere/);
  assert.match(styles, /execution-sub-issue-row\.is-blocked/);
  assert.match(relationsSource, /role="alert"/);
  assert.match(relationsSource, /execution-overview-hint/);
});
