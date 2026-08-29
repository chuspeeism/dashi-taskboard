import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { createTaskboardServer, resolveServerOptions } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(configure, listenOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-test-"));
  const options = configure ? await configure(directory) : {};
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0, ...listenOptions });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : undefined,
  };
}

async function requestWithHost(baseUrl, host, headers = {}) {
  const target = new URL("/health", baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(target, { headers: { host, ...headers } }, (response) => {
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

async function openEventStream(baseUrl, headers) {
  const target = new URL("/api/events", baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(target, { headers }, (response) => {
      resolve({ status: response.statusCode });
      response.resume();
      response.destroy();
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function openWebSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    client.once("open", () => {
      client.terminate();
      resolve(101);
    });
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    client.once("error", reject);
  });
}

test("health and the default local project are available", async () => {
  let skillPath;
  const baseUrl = await startServer(async (directory) => {
    skillPath = path.join(directory, "skills", "manage-taskboard", "SKILL.md");
    return { skillPath };
  });

  const health = await request(baseUrl, "/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const metadata = await request(baseUrl, "/api/meta");
  assert.equal(metadata.response.status, 200);
  assert.deepEqual(metadata.body, {
    manageTaskboardSkillPath: skillPath,
    capabilities: { localAiChat: true },
  });

  const result = await request(baseUrl, "/api/projects");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.projects.length, 1);
  assert.equal(result.body.projects[0].id, "local");
  assert.equal(result.body.projects[0].name, "全局");
  assert.equal(result.body.projects[0].workspacePath, null);
  assert.equal(result.body.projects[0].issueCount, 0);
});

test("launcher mode proves service identity and hides every route behind its instance token", async () => {
  const instanceToken = "7a6f8d37-78ce-46c9-87a8-08e10db88da2";
  const instanceSecret = "2e587946-96d6-47b5-930a-1ba70214fa88";
  const version = "0.2.0";
  const challenge = "8cbeea6e83e574def3f9d397cabddffc";
  const baseUrl = await startServer(() => ({ instanceToken, instanceSecret, version }));

  const unauthenticatedHealth = await request(baseUrl, "/health");
  assert.equal(unauthenticatedHealth.response.status, 401);

  const health = await request(baseUrl, "/health", {
    headers: { "x-codex-taskboard-challenge": challenge },
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.product, "codex-taskboard");
  assert.equal(health.body.version, version);
  assert.equal(
    health.body.proof,
    createHmac("sha256", instanceSecret).update(challenge).digest("hex"),
  );

  const publicApi = await request(baseUrl, "/api/projects");
  assert.equal(publicApi.response.status, 404);

  const launcherApi = await request(baseUrl, `/${instanceToken}/api/projects`, {
    headers: { origin: "null" },
  });
  assert.equal(launcherApi.response.status, 200);
  assert.equal(launcherApi.response.headers.get("access-control-allow-origin"), "null");
});

test("existing task and comment thread attribution remains content-specific", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'legacy-task', 'LOCAL-1', 'local', 'Legacy task', '', 'todo', 'none', '[]', 1000,
        'legacy-thread', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO comments VALUES (
        'legacy-comment', 'legacy-task', 'Legacy comment', 'legacy-comment-thread', 'local', '本地用户', 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO attachments VALUES (
        'legacy-attachment', 'legacy-task', 'legacy.txt', 'text/plain', 0,
        '2026-07-20T00:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const result = await request(baseUrl, "/api/tasks/legacy-task");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.threadId, "legacy-thread");
  assert.equal(result.body.task.threadBinding, null);
  assert.equal(result.body.task.legacyLocalThreadId, "legacy-thread");
  assert.deepEqual(result.body.task.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal,
  })), [
    { threadId: "legacy-thread", legacyLocal: true },
    { threadId: "legacy-comment-thread", legacyLocal: true },
  ]);
  assert.equal(result.body.task.creatorType, "agent");
  assert.equal(result.body.task.creatorId, "codex-agent");
  assert.equal(result.body.task.creatorName, "Codex Agent");
  assert.deepEqual(result.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });
  assert.equal(Object.hasOwn(result.body.task, "linkedThreadId"), false);
  const columns = runningApps.at(-1).app.database.database.prepare("PRAGMA table_info(tasks)").all();
  assert.equal(columns.some((column) => column.name === "thread_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_type"), true);
  assert.equal(columns.some((column) => column.name === "assignee_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_name"), true);
  assert.equal(columns.some((column) => column.name === "assignee_avatar_url"), true);
  assert.equal(columns.some((column) => column.name === "linked_thread_id"), false);
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads, undefined);
  const comments = await request(baseUrl, "/api/tasks/legacy-task/comments");
  assert.equal(comments.body.comments[0].threadId, "legacy-comment-thread");
  assert.equal(comments.body.comments[0].threadBinding, null);
  assert.equal(comments.body.comments[0].legacyLocalThreadId, "legacy-comment-thread");
  assert.equal(comments.body.comments[0].authorType, "agent");
  assert.equal(comments.body.comments[0].authorId, "codex-agent");
  assert.equal(comments.body.comments[0].authorName, "Codex Agent");
  assert.deepEqual(comments.body.comments[0].attachments, []);
  const attachments = await request(baseUrl, "/api/tasks/legacy-task/attachments");
  assert.equal(attachments.body.attachments[0].commentId, null);

  let version = result.body.task.version;
  for (const status of ["in_review", "blocked", "canceled"]) {
    const moveResult = await request(baseUrl, "/api/tasks/legacy-task/move", {
      method: "POST",
      body: { version, status },
    });
    assert.equal(moveResult.response.status, 200);
    assert.equal(moveResult.body.task.status, status);
    version = moveResult.body.task.version;
  }
  const tasksSql = runningApps.at(-1).app.database.database.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
  `).get().sql;
  assert.match(tasksSql, /'in_review'/);
  assert.match(tasksSql, /'blocked'/);
  assert.match(tasksSql, /'canceled'/);
  const commentForeignKeys = runningApps.at(-1).app.database.database
    .prepare("PRAGMA foreign_key_list(comments)")
    .all();
  assert.equal(commentForeignKeys.some((foreignKey) => foreignKey.table === "tasks"), true);
});

test("task thread migration excludes comment-only aggregate entries", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_threads (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, thread_id)
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'aggregate-task', 'LOCAL-1', 'local', 'Aggregate task', '', 'todo', 'none', '[]', 1000,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T03:00:00.000Z'
      );
      INSERT INTO task_threads VALUES ('aggregate-task', 'thread-subject', '2026-07-20T01:00:00.000Z');
      INSERT INTO task_threads VALUES ('aggregate-task', 'thread-comment-only', '2026-07-20T02:00:00.000Z');
      INSERT INTO comments VALUES (
        'aggregate-comment', 'aggregate-task', 'Comment', 'thread-comment-only', 'local', '本地用户', 1,
        '2026-07-20T02:00:00.000Z', '2026-07-20T02:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const task = await request(baseUrl, "/api/tasks/aggregate-task");
  assert.equal(task.body.task.threadId, "thread-subject");
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads, undefined);
  const comments = await request(baseUrl, "/api/tasks/aggregate-task/comments");
  assert.equal(comments.body.comments[0].threadId, "thread-comment-only");
});

test("development context scan resolves the current Codex conversation workspace", async () => {
  let expectedWorkspace;
  const baseUrl = await startServer(async (directory) => {
    expectedWorkspace = directory;
    const processesPath = path.join(directory, "chat_processes.json");
    await writeFile(processesPath, JSON.stringify({
      recent: [{
        conversationId: "019f7f96-287b-7da0-bc7f-ffe03af85cc8",
        cwd: directory,
        updatedAtMs: 20,
      }],
    }));
    return {
      codexStatePath: path.join(directory, "missing-state.json"),
      codexProcessesPath: processesPath,
    };
  });
  const result = await request(
    baseUrl,
    "/api/projects/local/development-contexts?codexThreadId=019f7f96-287b-7da0-bc7f-ffe03af85cc8",
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.workspacePath, expectedWorkspace);
  assert.deepEqual(result.body.contexts, []);

  const deviceWorkspace = path.join(expectedWorkspace, "another-device-workspace");
  const deviceResult = await request(
    baseUrl,
    `/api/projects/local/development-contexts?workspacePath=${encodeURIComponent(deviceWorkspace)}`,
  );
  assert.equal(deviceResult.response.status, 200);
  assert.equal(deviceResult.body.workspacePath, deviceWorkspace);
});

test("device workspaces come from this machine's Codex project roots", async () => {
  const baseUrl = await startServer(async (directory) => {
    const codexStatePath = path.join(directory, "codex-state.json");
    await writeFile(codexStatePath, JSON.stringify({
      "local-projects": {
        "local-project-a": { rootPaths: ["/Users/alice/project-a"] },
        "local-project-b": { rootPaths: ["/Users/alice/project-b"] },
      },
    }));
    return { codexStatePath };
  });
  const result = await request(baseUrl, "/api/device-workspaces");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.workspaces, {
    "local-project-a": "/Users/alice/project-a",
    "local-project-b": "/Users/alice/project-b",
  });
});

test("accepts private LAN requests and rejects public Host and Origin headers", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });

  const codexOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "app://-" },
  });
  assert.equal(codexOriginResult.response.status, 200);

  const lanHostResult = await requestWithHost(baseUrl, "192.168.1.24:47823");
  assert.equal(lanHostResult.status, 200);

  const lanOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "http://192.168.1.24:47823" },
  });
  assert.equal(lanOriginResult.response.status, 200);

  const localHostnameResult = await requestWithHost(baseUrl, "taskboard.local:47823");
  assert.equal(localHostnameResult.status, 200);

  const hostResult = await requestWithHost(baseUrl, "taskboard.example.com");
  assert.equal(hostResult.status, 403);
  assert.equal(hostResult.body.error.code, "INVALID_HOST");

  const originResult = await request(baseUrl, "/health", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(originResult.response.status, 403);
  assert.equal(originResult.body.error.code, "INVALID_ORIGIN");
});

test("trusted HTTPS origins allow a loopback reverse tunnel for HTTP and SSE only", async () => {
  const trustedOrigin = "https://board.example.test";
  const baseUrl = await startServer(() => ({
    processEnv: { ...process.env, CODEX_TASKBOARD_TRUSTED_ORIGINS: trustedOrigin },
  }));
  const host = "127.0.0.1";

  for (const [origin, expectedStatus] of [
    [trustedOrigin, 200],
    ["https://other.example.test", 403],
    [undefined, 200],
  ]) {
    const headers = origin ? { origin } : {};
    const health = await requestWithHost(baseUrl, host, headers);
    assert.equal(health.status, expectedStatus);

    const events = await openEventStream(baseUrl, { host, ...headers });
    assert.equal(events.status, expectedStatus);
  }

  const publicHost = await requestWithHost(baseUrl, "board.example.test", {
    origin: trustedOrigin,
  });
  assert.equal(publicHost.status, 403);
  assert.equal(publicHost.body.error.code, "INVALID_HOST");

  const forwardedHost = await requestWithHost(baseUrl, "untrusted.example.test", {
    origin: trustedOrigin,
    "x-forwarded-host": host,
    "x-forwarded-proto": "https",
  });
  assert.equal(forwardedHost.status, 403);
  assert.equal(forwardedHost.body.error.code, "INVALID_HOST");
});

test("trusted HTTPS origins do not inherit device-local capabilities from tunnel loopback", async () => {
  const trustedOrigin = "https://board.example.test";
  let skillPath;
  const baseUrl = await startServer(async (directory) => {
    skillPath = path.join(directory, "skills", "manage-taskboard", "SKILL.md");
    return {
      skillPath,
      processEnv: { ...process.env, CODEX_TASKBOARD_TRUSTED_ORIGINS: trustedOrigin },
      cloudConfigStore: {
        async read() {
          return {
            remoteUrl: "https://tasks.example.test",
            actorName: "Test actor",
            sharedKey: "test-shared-key",
            projectMappings: {},
          };
        },
      },
      remoteFetch: async () => new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    };
  });
  const trustedRequest = { headers: { origin: trustedOrigin } };

  const projects = await request(baseUrl, "/api/projects", trustedRequest);
  assert.equal(projects.response.status, 200);
  assert.deepEqual(projects.body, { projects: [] });

  const metadata = await request(baseUrl, "/api/meta", trustedRequest);
  assert.equal(metadata.response.status, 200);
  assert.deepEqual(metadata.body, {
    capabilities: { localAiChat: false },
    mode: "cloud",
    realtime: {
      transport: "websocket",
      endpoint: "/api/events",
    },
    localCapabilities: { available: false },
  });
  assert.equal(Object.hasOwn(metadata.body, "manageTaskboardSkillPath"), false);

  for (const pathname of [
    "/api/local/host-runtime",
    "/api/local/jira-connection",
    "/api/local/ai/catalog?projectId=local",
    "/api/device-workspaces",
    "/api/projects/local/development-contexts",
  ]) {
    const result = await request(baseUrl, pathname, trustedRequest);
    assert.equal(result.response.status, 409, pathname);
    assert.equal(result.body.error.code, "LOCAL_COMPANION_REQUIRED", pathname);
  }

  const localMetadata = await request(baseUrl, "/api/meta");
  assert.equal(localMetadata.response.status, 200);
  assert.deepEqual(localMetadata.body, {
    manageTaskboardSkillPath: skillPath,
    capabilities: { localAiChat: true },
    mode: "cloud",
    realtime: {
      transport: "websocket",
      endpoint: "/api/events",
    },
    localCapabilities: { available: true },
  });
  assert.equal((await request(baseUrl, "/api/local/host-runtime")).response.status, 200);
  assert.equal((await request(baseUrl, "/api/device-workspaces")).response.status, 200);
});

test("trusted HTTPS origins apply to cloud WebSocket upgrades without widening loopback routes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-trusted-origins-"));
  const trustedOrigin = "https://board.example.test";
  const upstreamServer = createServer();
  const upstreamWebSockets = new WebSocketServer({ noServer: true });
  upstreamServer.on("upgrade", (request, socket, head) => {
    upstreamWebSockets.handleUpgrade(request, socket, head, () => {});
  });
  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstreamServer.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    processEnv: { ...process.env, CODEX_TASKBOARD_TRUSTED_ORIGINS: trustedOrigin },
    cloudConfigStore: {
      async read() {
        return {
          remoteUrl: `http://127.0.0.1:${upstreamAddress.port}`,
          actorName: "Test actor",
          sharedKey: "test-shared-key",
        };
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const url = `ws://127.0.0.1:${address.port}/api/events`;
    for (const [origin, expectedStatus] of [
      [trustedOrigin, 101],
      ["https://other.example.test", 403],
      [undefined, 101],
    ]) {
      const headers = { host: "127.0.0.1", ...(origin ? { origin } : {}) };
      assert.equal(await openWebSocket(url, headers), expectedStatus);
    }
  } finally {
    await app.close();
    upstreamWebSockets.close();
    await new Promise((resolve) => upstreamServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted origin configuration rejects non-origin URLs", () => {
  const valid = resolveServerOptions({
    processEnv: {
      ...process.env,
      CODEX_TASKBOARD_TRUSTED_ORIGINS: "https://board.example.test, https://second.example.test/",
    },
  });
  assert.deepEqual(valid.trustedOrigins, new Set([
    "https://board.example.test",
    "https://second.example.test",
  ]));

  for (const value of [
    "",
    " \t ",
    "http://board.example.test",
    "https://board.example.test/path",
    "https://board.example.test?query=value",
    "https://user@board.example.test",
    "https://*.example.test",
    "https://board.example.test,,https://second.example.test",
    "https://board.example.test,https://board.example.test",
    "https://board.example.test,https://board.example.test/",
    "https://board.example.test,https://board.example.test:443",
  ]) {
    assert.throws(
      () => resolveServerOptions({
        processEnv: { ...process.env, CODEX_TASKBOARD_TRUSTED_ORIGINS: value },
      }),
      /CODEX_TASKBOARD_TRUSTED_ORIGINS/,
    );
  }
});

test("project and task CRUD flow", async () => {
  const baseUrl = await startServer();

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "website", name: "Website", workspacePath: "/work/website" },
  });
  assert.equal(projectResult.response.status, 201);
  assert.equal(projectResult.body.project.id, "website");
  assert.equal(projectResult.body.project.workspacePath, "/work/website");

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "website",
      title: "Build task board",
      description: "Create the first local board",
      status: "todo",
      priority: "high",
      labels: ["frontend", "mvp"],
      threadId: "thread-123",
      developmentContext: {
        type: "worktree",
        path: "/work/website/.worktrees/taskboard",
        branch: "worktree/taskboard",
      },
      dueDate: "2026-07-24",
      recurrence: { interval: 2, unit: "week" },
    },
  });
  assert.equal(createResult.response.status, 201);
  const created = createResult.body.task;
  assert.equal(created.identifier, "WEB-1");
  assert.equal(created.version, 1);
  assert.equal(created.sortOrder, 1000);
  assert.equal(created.archivedAt, null);
  assert.deepEqual(created.labels, ["frontend", "mvp"]);
  assert.equal(created.threadId, "thread-123");
  assert.equal(created.creatorType, "user");
  assert.equal(created.creatorId, "local-user");
  assert.equal(created.creatorName, "本地用户");
  assert.equal(created.creatorAvatarUrl, null);
  assert.deepEqual(created.developmentContext, {
    type: "worktree",
    path: "/work/website/.worktrees/taskboard",
    branch: "worktree/taskboard",
  });
  assert.equal(created.dueDate, "2026-07-24");
  assert.deepEqual(created.recurrence, { interval: 2, unit: "week" });

  const projectsAfterCreate = await request(baseUrl, "/api/projects");
  const websiteProject = projectsAfterCreate.body.projects.find((project) => project.id === "website");
  assert.equal(websiteProject.issueCount, 1);

  const getResult = await request(baseUrl, `/api/tasks/${created.id}`);
  assert.equal(getResult.response.status, 200);
  assert.deepEqual(getResult.body.task, created);
  const getByIdentifier = await request(baseUrl, `/api/tasks/${created.identifier}`);
  assert.equal(getByIdentifier.response.status, 200);
  assert.equal(getByIdentifier.body.task.id, created.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=website&status=todo");
  assert.equal(listResult.response.status, 200);
  assert.deepEqual(listResult.body.tasks.map((task) => task.id), [created.id]);

  const patchResult = await request(baseUrl, `/api/tasks/${created.identifier}`, {
    method: "PATCH",
    body: {
      version: created.version,
      title: "Build polished task board",
      priority: "urgent",
      threadId: "thread-456",
      developmentContext: { type: "branch", branch: "feature/polish" },
    },
  });
  assert.equal(patchResult.response.status, 200);
  const updated = patchResult.body.task;
  assert.equal(updated.title, "Build polished task board");
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.threadId, "thread-456");
  assert.deepEqual(updated.developmentContext, { type: "branch", branch: "feature/polish" });
  assert.equal(updated.version, 2);

  const archiveResult = await request(baseUrl, `/api/tasks/${created.id}/archive`, {
    method: "POST",
    body: { version: updated.version, threadId: "thread-archive" },
  });
  assert.equal(archiveResult.response.status, 200);
  assert.equal(archiveResult.body.task.version, 3);
  assert.equal(archiveResult.body.task.threadId, "thread-archive");
  assert.match(archiveResult.body.task.archivedAt, /^\d{4}-\d{2}-\d{2}T/);

  const activeList = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeList.body.tasks, []);
  const archivedList = await request(baseUrl, "/api/tasks?projectId=website&archived=true");
  assert.deepEqual(archivedList.body.tasks.map((task) => task.id), [created.id]);

  const projectsAfterArchive = await request(baseUrl, "/api/projects");
  const archivedWebsiteProject = projectsAfterArchive.body.projects.find((project) => project.id === "website");
  assert.equal(archivedWebsiteProject.issueCount, 0);

  const restoreResult = await request(baseUrl, `/api/tasks/${created.id}/restore`, {
    method: "POST",
    body: { version: archiveResult.body.task.version, threadId: "thread-restore" },
  });
  assert.equal(restoreResult.response.status, 200);
  assert.equal(restoreResult.body.task.archivedAt, null);
  assert.equal(restoreResult.body.task.version, 4);
  assert.equal(restoreResult.body.task.threadId, "thread-restore");

  const activeAfterRestore = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeAfterRestore.body.tasks.map((task) => task.id), [created.id]);
  const projectsAfterRestore = await request(baseUrl, "/api/projects");
  const restoredWebsiteProject = projectsAfterRestore.body.projects.find((project) => project.id === "website");
  assert.equal(restoredWebsiteProject.issueCount, 1);
});

test("moving a task updates its status and sort order", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Move me" },
  });
  const task = createResult.body.task;

  const moveResult = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress", sortOrder: 2500.5, threadId: "thread-move" },
  });
  assert.equal(moveResult.response.status, 200);
  assert.equal(moveResult.body.task.status, "in_progress");
  assert.equal(moveResult.body.task.sortOrder, 2500.5);
  assert.equal(moveResult.body.task.threadId, "thread-move");
  assert.equal(moveResult.body.task.version, 2);
});

test("remote task bindings keep their own identity and can be cleared independently", async () => {
  const baseUrl = await startServer();
  const legacy = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Legacy binding", threadId: "legacy-thread" },
  })).body.task;
  assert.equal(legacy.threadId, "legacy-thread");
  assert.equal(legacy.threadBinding, null);
  assert.equal(legacy.legacyLocalThreadId, "legacy-thread");
  assert.deepEqual(legacy.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal,
  })), [{ threadId: "legacy-thread", legacyLocal: true }]);
  const binding = {
    threadId: "remote-thread-a",
    codexProjectId: "remote-project-a",
    codexProjectKind: "remote",
    codexHostId: "ssh-a",
    workspacePath: "/same/remote/path",
  };
  const created = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Remote binding", threadId: binding.threadId, threadBinding: binding },
  })).body.task;
  assert.deepEqual(created.threadBinding, binding);
  assert.deepEqual(created.conversationRefs.map((ref) => ref.codexHostId), ["ssh-a"]);

  const continued = (await request(baseUrl, `/api/tasks/${created.id}/move`, {
    method: "POST",
    body: {
      version: created.version,
      status: "in_progress",
      threadId: binding.threadId,
    },
  })).body.task;
  assert.deepEqual(continued.threadBinding, binding);

  const controllerComment = (await request(baseUrl, `/api/tasks/${created.id}/comments`, {
    method: "POST",
    body: { body: "Controller note", threadId: "controller-thread" },
  })).body.comment;
  assert.equal(controllerComment.threadBinding, null);
  assert.equal(controllerComment.legacyLocalThreadId, "controller-thread");

  const blocked = (await request(baseUrl, `/api/tasks/${created.id}/move`, {
    method: "POST",
    body: {
      version: continued.version,
      status: "blocked",
      threadId: "controller-thread",
      threadBinding: binding,
    },
  })).body.task;
  assert.equal(blocked.threadId, binding.threadId);
  assert.deepEqual(blocked.threadBinding, binding);
  assert.deepEqual(blocked.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal ?? false,
  })), [
    { threadId: binding.threadId, legacyLocal: false },
    { threadId: "controller-thread", legacyLocal: true },
  ]);

  const restored = (await request(baseUrl, `/api/tasks/${created.id}/move`, {
    method: "POST",
    body: {
      version: blocked.version,
      status: "todo",
      threadId: "controller-thread",
      threadBinding: null,
    },
  })).body.task;
  assert.equal(restored.threadId, null);
  assert.equal(restored.threadBinding, null);
  assert.deepEqual(restored.conversationRefs.map((ref) => ref.threadId), ["controller-thread"]);
});

test("the active local Codex conversation supplies its exact task binding identity", async () => {
  const baseUrl = await startServer();
  const runtime = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    body: {
      threadId: "local-thread",
      threadRunning: true,
      threadTodoProgress: null,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/work/local-project",
    },
  });
  assert.equal(runtime.response.status, 200);
  const task = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Local binding", threadId: "local-thread" },
  })).body.task;
  assert.deepEqual(task.threadBinding, {
    threadId: "local-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/work/local-project",
  });
});

test("issues support parent, sub-issue, blocking, and related issue relationships", async () => {
  const baseUrl = await startServer();
  const createIssue = async (title, status = "todo", projectId = "local") => {
    const result = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId, title, status },
    });
    assert.equal(result.response.status, 201);
    return result.body.task;
  };
  const latest = async (id) => (await request(baseUrl, `/api/tasks/${id}`)).body.task;
  const mutateRelation = async (method, task, type, related, version = task.version) => (
    request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(related.id)}`,
      {
        method,
        body: { version, threadId: "thread-relations" },
      },
    )
  );

  const parent = await createIssue("Parent issue");
  const child = await createIssue("Child issue", "done");
  const grandchild = await createIssue("Grandchild issue", "canceled");
  const blocker = await createIssue("Blocking issue", "in_progress");
  const related = await createIssue("Related issue");

  const parentAdded = await mutateRelation("POST", child, "parent", parent);
  assert.equal(parentAdded.response.status, 200);
  assert.equal(parentAdded.body.task.version, child.version + 1);
  assert.equal(parentAdded.body.task.threadId, "thread-relations");
  assert.equal(parentAdded.body.task.relations.parent.id, parent.id);
  assert.equal(parentAdded.body.relatedTask.id, parent.id);

  const parentAfterAdd = await latest(parent.id);
  assert.deepEqual(parentAfterAdd.relations.subIssues.map((issue) => issue.id), [child.id]);
  assert.equal(parentAfterAdd.relations.subIssues[0].status, "done");

  const childWithGrandchild = await mutateRelation("POST", grandchild, "parent", await latest(child.id));
  assert.equal(childWithGrandchild.response.status, 200);
  const cycle = await mutateRelation("POST", await latest(parent.id), "parent", await latest(grandchild.id));
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.body.error.code, "RELATION_CYCLE");

  const self = await mutateRelation("POST", await latest(parent.id), "related", await latest(parent.id));
  assert.equal(self.response.status, 400);
  assert.equal(self.body.error.code, "SELF_RELATION");

  const blocksAdded = await mutateRelation("POST", await latest(parent.id), "blocks", blocker);
  assert.equal(blocksAdded.response.status, 200);
  assert.deepEqual(blocksAdded.body.task.relations.blocks.map((issue) => issue.id), [blocker.id]);
  assert.deepEqual((await latest(blocker.id)).relations.blockedBy.map((issue) => issue.id), [parent.id]);

  const duplicateBlocks = await mutateRelation(
    "POST",
    await latest(blocker.id),
    "blocked_by",
    await latest(parent.id),
  );
  assert.equal(duplicateBlocks.response.status, 409);
  assert.equal(duplicateBlocks.body.error.code, "RELATION_EXISTS");

  const relatedAdded = await mutateRelation("POST", await latest(parent.id), "related", related);
  assert.equal(relatedAdded.response.status, 200);
  assert.deepEqual(relatedAdded.body.task.relations.related.map((issue) => issue.id), [related.id]);
  assert.deepEqual((await latest(related.id)).relations.related.map((issue) => issue.id), [parent.id]);

  const stale = await mutateRelation(
    "DELETE",
    relatedAdded.body.task,
    "related",
    related,
    relatedAdded.body.task.version - 1,
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");

  const relatedRemoved = await mutateRelation("DELETE", relatedAdded.body.task, "related", related);
  assert.equal(relatedRemoved.response.status, 200);
  assert.deepEqual(relatedRemoved.body.task.relations.related, []);
  assert.deepEqual((await latest(related.id)).relations.related, []);

  const replacementParent = await createIssue("Replacement parent");
  const childBeforeReplace = await latest(child.id);
  const replaced = await mutateRelation("POST", childBeforeReplace, "parent", replacementParent);
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.task.relations.parent.id, replacementParent.id);
  assert.deepEqual((await latest(parent.id)).relations.subIssues, []);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues.map((issue) => issue.id), [child.id]);

  const parentRemoved = await mutateRelation("DELETE", replaced.body.task, "parent", replacementParent);
  assert.equal(parentRemoved.response.status, 200);
  assert.equal(parentRemoved.body.task.relations.parent, null);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues, []);

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "other", name: "Other" },
  });
  assert.equal(projectResult.response.status, 201);
  const crossProject = await createIssue("Other project issue", "todo", "other");
  const crossProjectRelation = await mutateRelation(
    "POST",
    await latest(parent.id),
    "related",
    crossProject,
  );
  assert.equal(crossProjectRelation.response.status, 400);
  assert.equal(crossProjectRelation.body.error.code, "CROSS_PROJECT_RELATION");
});

test("issue tree returns deterministic direct and nested parent paths without changing relation APIs", async () => {
  const baseUrl = await startServer();
  const createIssue = async (title, projectId = "local") => {
    const result = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId, title },
    });
    assert.equal(result.response.status, 201);
    return result.body.task;
  };
  const latest = async (id) => (await request(baseUrl, `/api/tasks/${id}`)).body.task;
  const addParent = async (child, parent) => request(
    baseUrl,
    `/api/tasks/${child.id}/relations/parent/${parent.id}`,
    { method: "POST", body: { version: child.version } },
  );

  const root = await createIssue("Tree root");
  const first = await createIssue("Tree first");
  const second = await createIssue("Tree second");
  const grandchild = await createIssue("Tree grandchild");
  const greatGrandchild = await createIssue("Tree great-grandchild");
  for (const [child, parent] of [
    [first, root],
    [second, root],
    [grandchild, first],
    [greatGrandchild, grandchild],
  ]) {
    assert.equal((await addParent(child, parent)).response.status, 200);
  }

  const direct = await request(
    baseUrl,
    `/api/tasks/${root.id}/tree?direction=descendants&depth=1`,
  );
  assert.equal(direct.response.status, 200);
  assert.equal(direct.body.tree.nodeCount, 3);
  const directChildIds = direct.body.tree.nodes.slice(1).map((node) => node.id);
  assert.deepEqual([...directChildIds].sort(), [first.id, second.id].sort());
  assert.ok(direct.body.tree.nodes.every((node) => (
    node.depth === 0 ? node.parentId === null : node.parentId === root.id
  )));
  const directRepeat = await request(
    baseUrl,
    `/api/tasks/${root.id}/tree?direction=descendants&depth=1`,
  );
  assert.deepEqual(directRepeat.body.tree.nodes, direct.body.tree.nodes);

  const descendants = await request(
    baseUrl,
    `/api/tasks/${root.id}/tree?direction=descendants&depth=3`,
  );
  assert.equal(descendants.response.status, 200);
  assert.deepEqual(descendants.body.tree.nodes.map((node) => node.id), [
    root.id,
    ...directChildIds,
    grandchild.id,
    greatGrandchild.id,
  ]);
  assert.deepEqual(descendants.body.tree.nodes.slice(-2).map((node) => [node.parentId, node.depth]), [
    [first.id, 2],
    [grandchild.id, 3],
  ]);
  assert.deepEqual(descendants.body.tree.nodes.at(-1).path, [
    root.id,
    first.id,
    grandchild.id,
    greatGrandchild.id,
  ]);
  assert.deepEqual(descendants.body.tree.nodes.at(-1).summary, {
    identifier: greatGrandchild.identifier,
    title: "Tree great-grandchild",
    status: "backlog",
    priority: "none",
    archivedAt: null,
  });

  const ancestors = await request(
    baseUrl,
    `/api/tasks/${greatGrandchild.id}/tree?direction=ancestors&depth=3`,
  );
  assert.equal(ancestors.response.status, 200);
  assert.deepEqual(ancestors.body.tree.nodes.map((node) => [node.id, node.parentId, node.depth]), [
    [greatGrandchild.id, null, 0],
    [grandchild.id, greatGrandchild.id, 1],
    [first.id, grandchild.id, 2],
    [root.id, first.id, 3],
  ]);

  const reparented = await addParent(await latest(grandchild.id), await latest(second.id));
  assert.equal(reparented.response.status, 200);
  const afterReparent = await request(
    baseUrl,
    `/api/tasks/${root.id}/tree?direction=descendants&depth=3`,
  );
  assert.deepEqual(afterReparent.body.tree.nodes.map((node) => node.id), [
    root.id,
    ...directChildIds,
    grandchild.id,
    greatGrandchild.id,
  ]);
  assert.deepEqual(afterReparent.body.tree.nodes.find((node) => node.id === grandchild.id).path, [
    root.id,
    second.id,
    grandchild.id,
  ]);

  const invalidDepth = await request(
    baseUrl,
    `/api/tasks/${root.id}/tree?direction=descendants&depth=26`,
  );
  assert.equal(invalidDepth.response.status, 400);
  assert.equal(invalidDepth.body.error.code, "INVALID_TREE_QUERY");

  const database = runningApps.at(-1).app.database.database;
  assert.throws(() => database.prepare(`
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
    VALUES ('parent', ?, ?, 'manual', ?)
  `).run(greatGrandchild.id, root.id, new Date().toISOString()), /RELATION_CYCLE/);

  const otherProject = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "tree-other", name: "Tree other" },
  });
  assert.equal(otherProject.response.status, 201);
  const external = await createIssue("Tree external", "tree-other");
  assert.throws(() => database.prepare(`
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
    VALUES ('blocks', ?, ?, 'manual', ?)
  `).run(root.id, external.id, new Date().toISOString()), /CROSS_PROJECT_RELATION/);
});

test("issue relationship changes are broadcast in realtime", async () => {
  const baseUrl = await startServer();
  const first = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime source" },
  })).body.task;
  const second = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime target" },
  })).body.task;

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const changed = await request(
    baseUrl,
    `/api/tasks/${first.id}/relations/related/${second.id}`,
    {
      method: "POST",
      body: { version: first.version, threadId: "thread-realtime-relation" },
    },
  );
  assert.equal(changed.response.status, 200);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.relation\.updated/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.relation.updated");
  assert.equal(event.task.id, first.id);
  assert.equal(event.relatedTask.id, second.id);
  await reader.cancel();
});

test("all task statuses are accepted, filtered, and listed in workflow order", async () => {
  const baseUrl = await startServer();
  const statuses = ["canceled", "done", "blocked", "in_review", "in_progress", "todo", "backlog"];

  for (const status of statuses) {
    const createResult = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { title: status, status },
    });
    assert.equal(createResult.response.status, 201);
    assert.equal(createResult.body.task.status, status);
  }

  const listResult = await request(baseUrl, "/api/tasks");
  assert.deepEqual(
    listResult.body.tasks.map((task) => task.status),
    ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"],
  );

  for (const status of ["in_review", "blocked", "canceled"]) {
    const filteredResult = await request(baseUrl, `/api/tasks?status=${status}`);
    assert.equal(filteredResult.response.status, 200);
    assert.deepEqual(filteredResult.body.tasks.map((task) => task.status), [status]);
  }
});

test("task and comment mutations keep content-specific conversation attribution", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Keep attribution", threadId: "thread-original" },
  });
  const task = createResult.body.task;
  const updateResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "Still attributed" },
  });
  assert.equal(updateResult.body.task.threadId, "thread-original");

  const repeatedUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: updateResult.body.task.version, title: "Still attributed again", threadId: "thread-original" },
  });
  assert.equal(repeatedUpdate.body.task.threadId, "thread-original");

  const commentCreate = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "Attributed comment", threadId: "thread-comment" },
  });
  const comment = commentCreate.body.comment;
  const commentUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited from the UI" },
  });
  assert.equal(commentUpdate.body.comment.threadId, "thread-comment");
  const taskAfterComment = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterComment.body.task.threadId, "thread-original");
});

test("stale updates receive a version conflict", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Concurrent edit" },
  });
  const task = createResult.body.task;

  const firstUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "First editor" },
  });
  assert.equal(firstUpdate.response.status, 200);

  const staleUpdate = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "done", sortOrder: 1 },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(staleUpdate.body.error.details, {
    expectedVersion: 1,
    actualVersion: 2,
  });
});

test("issue comments can be created, edited, listed, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Discuss me" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.comments, []);

  const createResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "First comment", threadId: "thread-comment-create" },
  });
  assert.equal(createResult.response.status, 201);
  const comment = createResult.body.comment;
  assert.equal(comment.taskId, task.id);
  assert.equal(comment.body, "First comment");
  assert.equal(comment.threadId, "thread-comment-create");
  assert.deepEqual(comment.attachments, []);
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "local-user");
  assert.equal(comment.authorName, "本地用户");
  assert.equal(comment.version, 1);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(listResult.body.comments.map((item) => item.id), [comment.id]);

  const updateResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited comment", threadId: "thread-comment-update" },
  });
  assert.equal(updateResult.response.status, 200);
  const updated = updateResult.body.comment;
  assert.equal(updated.body, "Edited comment");
  assert.equal(updated.threadId, "thread-comment-update");
  assert.equal(updated.version, 2);

  const taskAfterUpdate = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterUpdate.body.task.threadId, null);

  const staleUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Stale edit" },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");

  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: updated.version, threadId: "thread-comment-delete" },
  });
  assert.equal(deleteResult.response.status, 204);

  const finalList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(finalList.body.comments, []);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("taskctl issue creation and comments use the Codex Agent identity", async () => {
  const baseUrl = await startServer();
  const agentHeaders = {
    "x-taskboard-client": "taskctl",
    "x-taskboard-user-id": "spoofed-user",
    "x-taskboard-user-name": "Spoofed User",
    "x-taskboard-user-avatar": "https://example.com/spoofed.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: agentHeaders,
    body: { title: "Created by Codex", threadId: "thread-agent-create" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "agent");
  assert.equal(task.creatorId, "codex-agent");
  assert.equal(task.creatorName, "Codex Agent");
  assert.equal(task.creatorAvatarUrl, null);
  assert.deepEqual(task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: agentHeaders,
    body: { body: "Implemented by Codex", threadId: "thread-agent-comment" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "agent");
  assert.equal(comment.authorId, "codex-agent");
  assert.equal(comment.authorName, "Codex Agent");
  assert.equal(comment.authorAvatarUrl, null);
  assert.equal(comment.threadId, "thread-agent-comment");
});

test("Codex-hosted user mutations persist the current account identity and avatar", async () => {
  const baseUrl = await startServer();
  const userHeaders = {
    "x-taskboard-user-id": "test-user",
    "x-taskboard-user-name": "Test%20User",
    "x-taskboard-user-avatar": "https://example.com/test-user.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: userHeaders,
    body: { title: "Created in Codex UI" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "user");
  assert.equal(task.creatorId, "test-user");
  assert.equal(task.creatorName, "Test User");
  assert.equal(task.creatorAvatarUrl, "https://example.com/test-user.png");
  assert.deepEqual(task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const assignedToCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: task.version,
      assigneeTarget: "codex-agent",
    },
  });
  assert.equal(assignedToCodexResult.response.status, 200);
  assert.deepEqual(assignedToCodexResult.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const assignedToUserResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: assignedToCodexResult.body.task.version,
      assigneeTarget: "current-user",
    },
  });
  assert.equal(assignedToUserResult.response.status, 200);
  assert.deepEqual(assignedToUserResult.body.task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const updatedByCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      version: assignedToUserResult.body.task.version,
      title: "Updated through taskctl",
    },
  });
  assert.equal(updatedByCodexResult.response.status, 200);
  assert.deepEqual(updatedByCodexResult.body.task.assignee, assignedToUserResult.body.task.assignee);

  const invalidAssigneeResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: updatedByCodexResult.body.task.version,
      assigneeTarget: { type: "agent" },
    },
  });
  assert.equal(invalidAssigneeResult.response.status, 400);
  assert.equal(invalidAssigneeResult.body.error.code, "INVALID_FIELD");

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: userHeaders,
    body: { body: "Commented in Codex UI" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "test-user");
  assert.equal(comment.authorName, "Test User");
  assert.equal(comment.authorAvatarUrl, "https://example.com/test-user.png");
});

test("issue attachments can be uploaded, listed, opened, downloaded, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Attach files" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.attachments, []);

  const contents = "attachment contents\n";
  const uploadResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-taskboard-filename": encodeURIComponent("设计说明.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, null);
  assert.equal(attachment.filename, "设计说明.txt");
  assert.equal(attachment.contentType, "text/plain");
  assert.equal(attachment.size, Buffer.byteLength(contents));
  assert.match(attachment.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(listResult.body.attachments, [attachment]);

  const contentResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("content-type"), "text/plain");
  assert.match(contentResponse.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);
  assert.equal(await contentResponse.text(), contents);

  const headResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(Number(headResponse.headers.get("content-length")), Buffer.byteLength(contents));
  assert.equal(await headResponse.text(), "");

  const htmlUpload = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/html",
      "x-taskboard-filename": encodeURIComponent("page.html"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "<script>document.body.textContent = 'unsafe'</script>",
  });
  const htmlAttachment = htmlUpload.body.attachment;
  const htmlContent = await fetch(`${baseUrl}/api/attachments/${htmlAttachment.id}/content`);
  assert.equal(htmlContent.headers.get("content-type"), "application/octet-stream");
  assert.match(htmlContent.headers.get("content-disposition"), /^attachment;/);
  assert.equal(htmlContent.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const htmlDelete = await request(baseUrl, `/api/attachments/${htmlAttachment.id}`, { method: "DELETE" });
  assert.equal(htmlDelete.response.status, 204);

  const deleteResult = await request(baseUrl, `/api/attachments/${attachment.id}`, { method: "DELETE" });
  assert.equal(deleteResult.response.status, 204);
  const finalList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(finalList.body.attachments, []);
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  assert.equal(deletedContent.body.error.code, "ATTACHMENT_NOT_FOUND");
});

test("permanent task deletion requires archiving and removes attachment files", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-delete-project", name: "Delete project", workspacePath: null },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "temp-delete-project", title: "Delete permanently" },
  });
  const task = created.body.task;
  const uploaded = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "evidence.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment",
  });
  assert.equal(uploaded.response.status, 201);
  const comment = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "Comment with attachment" },
  });
  assert.equal(comment.response.status, 201);
  const commentUpload = await request(
    baseUrl,
    `/api/comments/${comment.body.comment.id}/attachments`,
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "comment-evidence.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "comment attachment",
    },
  );
  assert.equal(commentUpload.response.status, 201);
  const attachmentIds = [uploaded.body.attachment.id, commentUpload.body.attachment.id];
  const storagePaths = attachmentIds.map((attachmentId) => path.join(
    runningApps.at(-1).app.options.attachmentsDirectory,
    attachmentId,
  ));
  await Promise.all(storagePaths.map((storagePath) => access(storagePath)));

  const activeDelete = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: task.version },
  });
  assert.equal(activeDelete.response.status, 409);
  assert.equal(activeDelete.body.error.code, "TASK_NOT_ARCHIVED");

  const archived = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });
  const deleted = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: archived.body.task.version },
  });
  assert.equal(deleted.response.status, 204);
  await Promise.all(storagePaths.map((storagePath) => (
    assert.rejects(access(storagePath), { code: "ENOENT" })
  )));
  assert.equal((await request(baseUrl, `/api/tasks/${task.id}`)).response.status, 404);
  const database = runningApps.at(-1).app.database.database;
  assert.equal(database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id), undefined);
  assert.equal(
    database.prepare("SELECT 1 FROM comments WHERE id = ?").get(comment.body.comment.id),
    undefined,
  );
  const attachmentExists = database.prepare("SELECT 1 FROM attachments WHERE id = ?");
  for (const attachmentId of attachmentIds) {
    assert.equal(attachmentExists.get(attachmentId), undefined);
  }
  assert.equal((await request(baseUrl, "/api/projects/temp-delete-project", {
    method: "DELETE",
  })).response.status, 204);
});

test("comments support attachments and deleting a comment removes its files", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Comment files" },
  });
  const task = createTaskResult.body.task;
  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "", threadId: "thread-attachment" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.body, "");

  const contents = "comment attachment\n";
  const uploadResult = await request(baseUrl, `/api/comments/${comment.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("comment.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, comment.id);

  const attachmentList = await request(baseUrl, `/api/comments/${comment.id}/attachments`);
  assert.deepEqual(attachmentList.body.attachments, [attachment]);
  const commentList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(commentList.body.comments[0].attachments, [attachment]);
  const taskAttachmentList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(taskAttachmentList.body.attachments, []);

  const storagePath = path.join(runningApps.at(-1).app.options.attachmentsDirectory, attachment.id);
  await access(storagePath);
  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: comment.version, threadId: "thread-delete-comment" },
  });
  assert.equal(deleteResult.response.status, 204);
  await assert.rejects(access(storagePath), { code: "ENOENT" });
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("attachment uploads reject unsafe filenames", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Validate attachments" },
  });
  const task = createTaskResult.body.task;

  const result = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("../outside.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "unsafe",
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FILENAME");
});

test("request boundaries reject unknown fields and invalid values", async () => {
  const baseUrl = await startServer();

  const unknown = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", unexpected: true },
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

  const invalid = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", status: "started" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_FIELD");
  assert.match(invalid.body.error.message, /in_review/);
  assert.match(invalid.body.error.message, /blocked/);
  assert.match(invalid.body.error.message, /canceled/);

  const invalidWorktree = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      title: "Invalid",
      developmentContext: { type: "worktree", path: "/tmp/bad\0path", branch: null },
    },
  });
  assert.equal(invalidWorktree.response.status, 400);
  assert.equal(invalidWorktree.body.error.code, "INVALID_FIELD");
});

test("task changes from one LAN client are broadcast to another client", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });
  const lanHeaders = {
    host: "192.168.1.24:47823",
    origin: "http://192.168.1.24:47823",
  };
  const eventResponse = await fetch(`${baseUrl}/api/events`, { headers: lanHeaders });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: lanHeaders,
    body: { title: "Broadcast me" },
  });
  assert.equal(createResult.response.status, 201);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.created/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.created");
  assert.equal(event.task.id, createResult.body.task.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=local", {
    headers: lanHeaders,
  });
  assert.equal(listResult.response.status, 200);
  assert.equal(listResult.body.tasks.some((task) => task.id === createResult.body.task.id), true);
  await reader.cancel();
});
