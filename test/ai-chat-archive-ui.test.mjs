import assert from "node:assert/strict";
import { test } from "node:test";

const { register } = await import("tsx/esm/api");
register({ tsconfig: new URL("../web/tsconfig.json", import.meta.url).pathname });
const React = await import("react");
const { act } = React;
const { create: createTestRenderer } = await import("react-test-renderer");
const { AiChat } = await import("../web/src/components/AiChat.tsx");
const { IssueSubIssues } = await import("../web/src/components/IssueRelations.tsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map();
const testWindow = {
  innerWidth: 1280,
  innerHeight: 900,
  parent: null,
  location: { origin: "http://127.0.0.1:47823", search: "" },
  history: {
    state: null,
    pushState() {},
    replaceState() {},
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  crypto: globalThis.crypto,
  postMessage() {},
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  clearTimeout,
  setTimeout,
  confirm: () => true,
};
testWindow.parent = testWindow;
globalThis.window = testWindow;
globalThis.document = {
  activeElement: null,
  documentElement: { dataset: {}, style: {} },
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.requestAnimationFrame = (callback) => {
  queueMicrotask(() => callback(Date.now()));
  return 1;
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.EventSource = class {
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const { App } = await import("../web/src/App.tsx");

const timestamp = "2026-08-04T00:00:00.000Z";

function threadFor(id, { archivedAt = null, issueId, status = "idle", version = 1 } = {}) {
  return {
    id,
    title: id,
    status,
    origin: {
      projectId: "project-1",
      projectName: "Project 1",
      workspacePath: "/workspace/project-1",
      ...(issueId ? {
        issueId,
        issueIdentifier: issueId.toUpperCase(),
        issueTitle: `${issueId} title`,
      } : {}),
    },
    codexThreadId: `codex-${id}`,
    role: "planner",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    sandbox: "workspace-write",
    archivedAt,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRun: null,
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

function createAiChatFixture() {
  const activeStandalone = threadFor("standalone-active");
  const archivedStandalone = threadFor("standalone-archived", {
    archivedAt: "2026-08-03T00:00:00.000Z",
    version: 4,
  });
  const activeTaskBound = threadFor("task-bound-active", { issueId: "task-1" });
  const archivedTaskBound = threadFor("task-bound-archived", {
    issueId: "task-2",
    archivedAt: "2026-08-02T00:00:00.000Z",
    version: 8,
  });
  const threads = new Map([
    [activeStandalone.id, activeStandalone],
    [archivedStandalone.id, archivedStandalone],
    [activeTaskBound.id, activeTaskBound],
    [archivedTaskBound.id, archivedTaskBound],
  ]);
  const calls = [];

  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/api/local/ai/catalog")) {
      return jsonResponse({
        models: [{
          slug: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "test",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"],
          serviceTiers: [{ id: "priority", name: "Priority" }],
        }],
        skills: [],
        sandboxes: ["workspace-write", "read-only"],
      });
    }
    if (url === "/api/local/ai/threads?archived=all") {
      return jsonResponse({ threads: [...threads.values()] });
    }
    const threadMatch = url.match(/^\/api\/local\/ai\/threads\/([^/]+)(?:\/(archive|restore))?$/);
    if (!threadMatch) throw new Error(`Unexpected UI test request: ${url}`);
    const id = decodeURIComponent(threadMatch[1]);
    const action = threadMatch[2];
    const thread = threads.get(id);
    if (!thread) return jsonResponse({ error: { message: "not found" } }, 404);
    if (!action) return jsonResponse({ thread, events: [], runs: [] });
    const body = JSON.parse(init.body);
    if (action === "archive") {
      assert.equal(body.version, thread.version, `archive must use ${id} CAS version`);
      const next = {
        ...thread,
        archivedAt: "2026-08-04T01:00:00.000Z",
        version: thread.version + 1,
      };
      threads.set(id, next);
      return jsonResponse({ thread: next });
    }
    assert.equal(body.version, thread.version, `restore must use ${id} CAS version`);
    const next = { ...thread, archivedAt: null, version: thread.version + 1 };
    threads.set(id, next);
    return jsonResponse({ thread: next });
  };

  return { calls, fetch, threads };
}

function textContent(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node.children) return "";
  return node.children.map(textContent).join("");
}

function nodes(root, predicate) {
  return root.findAll((node) => predicate(node));
}

function buttonByLabel(root, label) {
  return nodes(root, (node) => node.type === "button" && node.props["aria-label"] === label)[0] ?? null;
}

function historyRows(root) {
  return nodes(root, (node) => (
    typeof node.props.className === "string"
    && node.props.className.includes("ai-chat-history-row")
  ));
}

function historyTab(root, labelPrefix) {
  return nodes(root, (node) => (
    node.type === "button"
    && node.props.role === "tab"
    && textContent(node).startsWith(labelPrefix)
  ))[0] ?? null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mountChat(
  fixture,
  allowLocalArchiveRestore,
  onOpenTask = () => {},
  issueId = null,
  preferredThreadId = null,
) {
  storage.clear();
  globalThis.fetch = fixture.fetch;
  let renderer;
  await act(async () => {
    renderer = createTestRenderer(React.createElement(AiChat, {
      available: true,
      projectId: "project-1",
      issueId,
      preferredThreadId,
      allowLocalArchiveRestore,
      onOpenTask,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
  await settle();
  await act(async () => {
    buttonByLabel(renderer.root, "打开 AI 对话").props.onClick();
  });
  await settle();
  await act(async () => {
    buttonByLabel(renderer.root, "对话历史").props.onClick();
  });
  return renderer;
}

function taskForRelations() {
  const child = {
    id: "child-1",
    identifier: "CHILD-1",
    title: "Archived child",
    status: "done",
    priority: "none",
    archivedAt: "2026-08-04T00:00:00.000Z",
    version: 12,
    handoff: null,
    aiThreadId: "dashi-child-1",
    codexThreadId: "codex-child-1",
  };
  const task = {
    id: "parent-1",
    identifier: "PARENT-1",
    projectId: "project-1",
    title: "Parent",
    status: "in_progress",
    priority: "none",
    labels: [],
    sortOrder: 1,
    threadId: null,
    creatorType: "user",
    creatorId: "local-user",
    creatorName: "Local User",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    archivedAt: null,
    version: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    relations: {
      parent: null,
      subIssues: [],
      blockedBy: [],
      blocks: [],
      related: [],
    },
  };
  return { task, child };
}

function createAppRestoreFixture() {
  const { task, child } = taskForRelations();
  const project = {
    id: "project-1",
    name: "Project 1",
    workspacePath: null,
    issueCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const overview = {
    parent: {
      id: task.id,
      identifier: task.identifier,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      archivedAt: null,
    },
    orchestration: null,
    children: [child],
  };
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/projects") return jsonResponse({ projects: [project] });
    if (url === "/api/meta") {
      return jsonResponse({
        mode: "local",
        capabilities: { localAiChat: true },
        localCapabilities: { available: true },
        realtime: { transport: "poll", intervalMs: 60000 },
      });
    }
    if (url === "/api/device-workspaces") return jsonResponse({ workspaces: {} });
    if (url.startsWith("/api/tasks?")) return jsonResponse({ tasks: [task] });
    if (url.startsWith("/api/projects/project-1/workflow-workspace")) {
      return jsonResponse({ workflow: { projectId: "project-1", workspace: {}, version: 1, updatedAt: timestamp } });
    }
    if (url.startsWith("/api/projects/project-1/development-contexts")) {
      return jsonResponse({ workspacePath: null, contexts: [] });
    }
    if (url === "/api/tasks/parent-1/comments") return jsonResponse({ comments: [] });
    if (url === "/api/tasks/parent-1/attachments") return jsonResponse({ attachments: [] });
    if (url.startsWith("/api/local/ai/tasks/parent-1/execution-overview")) {
      return jsonResponse({ overview });
    }
    if (url === "/api/local/ai/threads?archived=all") return jsonResponse({ threads: [] });
    if (url.startsWith("/api/local/ai/catalog")) {
      return jsonResponse({ models: [], skills: [], sandboxes: ["workspace-write"] });
    }
    if (url === "/api/tasks/child-1/restore") {
      assert.deepEqual(JSON.parse(init.body), { version: child.version });
      return jsonResponse({ error: { code: "VERSION_CONFLICT", message: "version conflict" } }, 409);
    }
    throw new Error(`Unexpected App restore request: ${url}`);
  };
  return { calls, fetch, task, child };
}

async function settleMany(count = 5) {
  for (let index = 0; index < count; index += 1) await settle();
}

test("AiChat real history actions enforce filters, task ownership, CAS, and archived read-only mode", async () => {
  const fixture = createAiChatFixture();
  const renderer = await mountChat(fixture, true);
  try {
    assert.equal(historyRows(renderer.root).length, 0, "running filter excludes completed idle conversations");
    await act(async () => historyTab(renderer.root, "已完成待验收").props.onClick());
    await settle();
    assert.deepEqual(
      historyRows(renderer.root).map(textContent).sort(),
      [
        "standalone-activeProject 1 · 8月4日 08:00",
        "task-1 titleTASK-1 · Project 1 · 8月4日 08:00查看原任务",
      ].sort(),
      "completed filter shows idle unarchived rows",
    );
    const activeTaskRow = historyRows(renderer.root).find((row) => textContent(row).includes("TASK-1"));
    assert.ok(activeTaskRow);
    assert.match(textContent(activeTaskRow), /查看原任务/);
    assert.equal(
      nodes(activeTaskRow, (node) => (
        node.type === "button"
        && (node.props["aria-label"]?.includes("归档") || node.props["aria-label"]?.includes("删除"))
      )).length,
      0,
      "active task-bound threads have no archive action",
    );

    const archiveButton = buttonByLabel(renderer.root, "归档对话 standalone-active");
    assert.ok(archiveButton);
    await act(async () => archiveButton.props.onClick());
    await settle();
    const archiveCall = fixture.calls.find((call) => call.url.endsWith("/standalone-active/archive"));
    assert.ok(archiveCall);
    assert.deepEqual(JSON.parse(archiveCall.init.body), { version: 1 });

    const archivedTaskRow = historyRows(renderer.root).find((row) => textContent(row).includes("TASK-2"));
    assert.ok(archivedTaskRow);
    assert.match(textContent(archivedTaskRow), /查看原任务/);
    assert.equal(
      nodes(archivedTaskRow, (node) => node.type === "button" && node.props["aria-label"]?.includes("恢复")).length,
      0,
      "archived task-bound threads have no restore action",
    );

    const standaloneRestore = buttonByLabel(renderer.root, "恢复对话 standalone-active");
    assert.ok(standaloneRestore);
    await act(async () => standaloneRestore.props.onClick());
    await settle();
    const restoreCall = fixture.calls.find((call) => call.url.endsWith("/standalone-active/restore"));
    assert.ok(restoreCall);
    assert.deepEqual(JSON.parse(restoreCall.init.body), { version: 2 });

    const archivedFilter = nodes(renderer.root, (node) => (
      node.type === "button"
      && node.props.role === "tab"
      && textContent(node) === "已归档"
    ))[0];
    assert.ok(archivedFilter);
    await act(async () => archivedFilter.props.onClick());
    await settle();
    const archivedRow = historyRows(renderer.root).find((row) => textContent(row).includes("standalone-archived"));
    assert.ok(archivedRow);
    await act(async () => archivedRow.findAll((node) => node.type === "button")[0].props.onClick());
    await settle();
    assert.equal(
      nodes(renderer.root, (node) => node.props.className === "ai-chat-composer-editor")[0]?.props.contentEditable,
      false,
      "archived composer is read-only",
    );
    for (const className of ["ai-chat-attachment-button", "ai-chat-permission-trigger", "ai-chat-model-trigger"]) {
      const control = nodes(renderer.root, (node) => node.props.className === className)[0];
      assert.equal(control?.props.disabled, true, `${className} is disabled for archived history`);
    }
    const writesBeforeReadonlyAttempts = fixture.calls.filter((call) => call.init.method && call.init.method !== "GET").length;
    const attachmentInput = nodes(renderer.root, (node) => node.type === "input" && node.props.type === "file")[0];
    const blockedFile = {
      name: "blocked.txt",
      type: "text/plain",
      size: 1,
      lastModified: 1,
    };
    await act(async () => {
      attachmentInput.props.onChange({ target: { files: [blockedFile], value: "" } });
      renderer.root.find((node) => node.props.className === "ai-chat-composer").props.onDrop({
        dataTransfer: { files: [blockedFile], items: [{ kind: "file" }] },
        preventDefault() {},
      });
      nodes(renderer.root, (node) => node.props.className === "ai-chat-attachment-button")[0].props.onClick();
      nodes(renderer.root, (node) => node.props.className === "ai-chat-permission-trigger")[0].props.onClick();
      nodes(renderer.root, (node) => node.props.className === "ai-chat-model-trigger")[0].props.onClick();
    });
    const writesAfterReadonlyAttempts = fixture.calls.filter((call) => call.init.method && call.init.method !== "GET").length;
    assert.equal(writesAfterReadonlyAttempts, writesBeforeReadonlyAttempts, "archived composer attempts issue no write request");
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("task-bound history shows task context and opens the original task detail", async () => {
  const fixture = createAiChatFixture();
  const openedTasks = [];
  const renderer = await mountChat(fixture, true, (task) => openedTasks.push(task));
  try {
    await act(async () => historyTab(renderer.root, "已完成待验收").props.onClick());
    await settle();
    const taskLink = buttonByLabel(renderer.root, "查看原任务 TASK-1");
    assert.ok(taskLink);
    assert.match(textContent(historyRows(renderer.root).find((row) => textContent(row).includes("TASK-1"))), /task-1 title/);
    await act(async () => taskLink.props.onClick());
    assert.deepEqual(openedTasks, [{ projectId: "project-1", identifier: "TASK-1" }]);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("task detail launcher opens the conversation bound to the current task", async () => {
  const fixture = createAiChatFixture();
  const renderer = await mountChat(fixture, true, () => {}, "task-1");
  try {
    await act(async () => historyTab(renderer.root, "已完成待验收").props.onClick());
    await settle();
    const activeRow = historyRows(renderer.root).find((row) => (
      typeof row.props.className === "string" && row.props.className.includes("is-active")
    ));
    assert.ok(activeRow);
    assert.match(textContent(activeRow), /TASK-1/);
    const panelTitle = nodes(renderer.root, (node) => node.props.className === "ai-chat-panel-title")[0];
    assert.match(textContent(panelTitle), /task-1 title/);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("task detail launcher falls back to the task review thread when its legacy origin is missing", async () => {
  const fixture = createAiChatFixture();
  const renderer = await mountChat(
    fixture,
    true,
    () => {},
    "task-with-missing-origin",
    "standalone-active",
  );
  try {
    const panelTitle = nodes(renderer.root, (node) => node.props.className === "ai-chat-panel-title")[0];
    assert.match(textContent(panelTitle), /standalone-active/);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("Cloud AiChat keeps history readable but has zero local archive or restore requests", async () => {
  const fixture = createAiChatFixture();
  const renderer = await mountChat(fixture, false);
  try {
    await act(async () => historyTab(renderer.root, "已完成待验收").props.onClick());
    await settle();
    assert.equal(buttonByLabel(renderer.root, "归档对话 standalone-active"), null);
    assert.equal(buttonByLabel(renderer.root, "恢复对话 standalone-archived"), null);
    assert.equal(
      fixture.calls.some((call) => /\/archive|\/restore/.test(call.url)),
      false,
      "Cloud mode does not call local lifecycle endpoints",
    );
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("parent archived child restore passes CAS version and exposes real loading", async () => {
  const { task, child } = taskForRelations();
  let resolveRestore;
  const restoreCalls = [];
  const restore = () => {
    restoreCalls.push([child.id, child.version]);
    return new Promise((resolve) => { resolveRestore = resolve; });
  };
  let renderer;
  await act(async () => {
    renderer = createTestRenderer(React.createElement(IssueSubIssues, {
      task,
      tasks: [task],
      executionOverview: {
        parent: {
          id: task.id,
          identifier: task.identifier,
          projectId: task.projectId,
          title: task.title,
          status: task.status,
          priority: task.priority,
          archivedAt: null,
        },
        orchestration: null,
        children: [child],
      },
      executionOverviewLoading: false,
      executionOverviewError: null,
      onOpenTask: () => {},
      onOpenAiThread: () => {},
      onOpenThread: () => {},
      onRestoreArchivedTask: restore,
      onAddRelation: async () => ({ task, relatedTask: task }),
      onRemoveRelation: async () => ({ task, relatedTask: task }),
    }));
  });
  try {
    const restoreButton = buttonByLabel(renderer.root, "恢复 CHILD-1");
    assert.ok(restoreButton);
    await act(async () => restoreButton.props.onClick());
    assert.deepEqual(restoreCalls, [["child-1", 12]]);
    assert.equal(textContent(restoreButton), "恢复中…");
    await act(async () => resolveRestore());
    await settle();
    assert.equal(textContent(buttonByLabel(renderer.root, "恢复 CHILD-1")), "恢复");
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("App child restore handles 409 with reloads and keeps the CAS restore entry usable", async () => {
  const fixture = createAppRestoreFixture();
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location;
  storage.clear();
  window.location = {
    origin: "http://127.0.0.1:47823",
    href: "http://127.0.0.1:47823/?project=project-1&issue=PARENT-1",
    search: "?project=project-1&issue=PARENT-1",
    assign() {},
  };
  globalThis.fetch = fixture.fetch;
  let renderer;
  try {
    await act(async () => {
      renderer = createTestRenderer(React.createElement(App));
    });
    await settleMany(8);
    const restoreButton = buttonByLabel(renderer.root, "恢复 CHILD-1");
    assert.ok(restoreButton, "the archived child is visible in the parent overview");
    const requestsBeforeRestore = fixture.calls.length;
    const tasksBeforeRestore = fixture.calls.filter((call) => call.url.startsWith("/api/tasks?")).length;
    const projectsBeforeRestore = fixture.calls.filter((call) => call.url === "/api/projects").length;
    const overviewBeforeRestore = fixture.calls.filter((call) => call.url.includes("execution-overview")).length;

    await act(async () => restoreButton.props.onClick());
    await settleMany(8);

    const restoreCall = fixture.calls.find((call) => call.url === "/api/tasks/child-1/restore");
    assert.ok(restoreCall);
    assert.deepEqual(JSON.parse(restoreCall.init.body), { version: 12 });
    assert.ok(fixture.calls.length > requestsBeforeRestore);
    assert.ok(fixture.calls.filter((call) => call.url.startsWith("/api/tasks?")).length > tasksBeforeRestore);
    assert.ok(fixture.calls.filter((call) => call.url === "/api/projects").length > projectsBeforeRestore);
    assert.ok(fixture.calls.filter((call) => call.url.includes("execution-overview")).length > overviewBeforeRestore);
    assert.equal(
      nodes(renderer.root, (node) => node.props.role === "alert")
        .some((node) => textContent(node).includes("其他位置更新")),
      true,
      "409 shows an understandable conflict message",
    );
    const restoredEntry = buttonByLabel(renderer.root, "恢复 CHILD-1");
    assert.ok(restoredEntry);
    assert.equal(restoredEntry.props.disabled, false, "refresh clears restore loading");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
    window.location = originalLocation;
  }
});
