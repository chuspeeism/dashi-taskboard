import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

let cloud;
const alice = "Alice";
const bob = "Bob";

before(async () => {
  cloud = await createCloudWorkerHarness();
});

after(async () => {
  await cloud?.dispose();
});

async function createProject(id, actorName = alice) {
  return cloud.request("/api/projects", {
    method: "POST",
    actorName,
    json: {
      id,
      name: id.toUpperCase(),
      workspacePath: `/Users/${actorName.toLowerCase()}/${id}`,
    },
  });
}

async function createTask(projectId, title, actorName = alice, extra = {}) {
  return cloud.request("/api/tasks", {
    method: "POST",
    actorName,
    json: {
      projectId,
      title,
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
      ...extra,
    },
  });
}

test("Basic authentication protects static assets, APIs, and attachment content", async () => {
  for (const pathname of ["/", "/api/projects", "/api/attachments/missing/content"]) {
    const missing = await cloud.request(pathname);
    assert.equal(missing.response.status, 401);
    assert.match(missing.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);

    const invalid = await cloud.request(pathname, {
      actorName: alice,
      password: "wrong",
    });
    assert.equal(invalid.response.status, 401);
    assert.match(invalid.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);
  }
});

test("Basic authentication requires an exact shared-secret match", async () => {
  const accepted = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(accepted.response.status, 200);

  const lastCharacter = cloud.sharedSecret.at(-1);
  const sameLengthWrongSecret = `${cloud.sharedSecret.slice(0, -1)}${
    lastCharacter === "x" ? "y" : "x"
  }`;
  assert.equal(sameLengthWrongSecret.length, cloud.sharedSecret.length);
  const rejected = await cloud.request("/api/projects", {
    actorName: alice,
    password: sameLengthWrongSecret,
  });
  assert.equal(rejected.response.status, 401);
  assert.match(rejected.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);
});

test("the Basic username becomes the trusted actor while the shared password grants access", async () => {
  const project = await createProject("alpha");
  assert.equal(project.response.status, 201);
  assert.equal(project.body.project.workspacePath, null);

  const userTask = await createTask("alpha", "Created in browser", alice);
  assert.equal(userTask.response.status, 201);
  assert.equal(userTask.body.task.creatorType, "user");
  assert.equal(userTask.body.task.creatorName, alice);
  assert.match(userTask.body.task.creatorId, /^basic:/);

  const agentTask = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      projectId: "alpha",
      title: "Created through taskctl",
      status: "backlog",
      priority: "none",
      labels: [],
    },
  });
  assert.equal(agentTask.response.status, 201);
  assert.equal(agentTask.body.task.creatorType, "agent");
  assert.match(agentTask.body.task.creatorName, /Codex Agent/);
  assert.match(agentTask.body.task.creatorName, /Bob/);
});

test("projects, tasks, comments, and relations preserve the current API contract", async () => {
  const parent = await createTask("alpha", "Parent");
  const child = await createTask("alpha", "Child");
  const relation = await cloud.request(
    `/api/tasks/${child.body.task.id}/relations/parent/${parent.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: child.body.task.version },
    },
  );
  assert.equal(relation.response.status, 200);
  assert.equal(relation.body.task.relations.parent.id, parent.body.task.id);

  const comment = await cloud.request(`/api/tasks/${child.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "Review note" },
  });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.body.comment.authorName, bob);

  const listed = await cloud.request("/api/tasks?projectId=alpha&archived=false", {
    actorName: alice,
  });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.body.tasks.some((task) => task.id === child.body.task.id));
});

test("concurrent issue creation has unique identifiers and stale writes return 409", async () => {
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, index) => createTask("alpha", `Concurrent ${index}`)),
  );
  for (const result of created) assert.equal(result.response.status, 201);
  const identifiers = created.map((result) => result.body.task.identifier);
  assert.equal(new Set(identifiers).size, identifiers.length);
  const numbers = identifiers
    .map((identifier) => Number(identifier.slice(identifier.lastIndexOf("-") + 1)))
    .sort((left, right) => left - right);
  numbers.forEach((number, index) => {
    assert.equal(number, numbers[0] + index);
  });

  const task = created[0].body.task;
  const winner = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: { version: task.version, title: "Winner" },
  });
  assert.equal(winner.response.status, 200);

  const stale = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: task.version, title: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.body.error.details, {
    expectedVersion: task.version,
    actualVersion: winner.body.task.version,
  });
});

test("PATCH moves an issue to an existing project and records the change", async () => {
  await createProject("move-source");
  await createProject("move-target");
  const targetTask = await createTask("move-target", "Target issue", alice, {
    status: "todo",
    sortOrder: 5000,
  });
  assert.equal(targetTask.response.status, 201);
  const sourceTask = await createTask("move-source", "Issue to move", alice, {
    status: "todo",
    sortOrder: 5000,
    threadId: "thread-to-preserve",
  });
  assert.equal(sourceTask.response.status, 201);
  await cloud.db.prepare(`
    UPDATE projects SET updated_at = '2000-01-01T00:00:00.000Z'
    WHERE id IN ('move-source', 'move-target')
  `).run();

  const moved = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-target",
      threadId: "thread-from-move",
    },
  });

  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.projectId, "move-target");
  assert.equal(moved.body.task.status, "todo");
  assert.equal(moved.body.task.sortOrder, sourceTask.body.task.sortOrder);
  assert.equal(moved.body.task.threadId, "thread-to-preserve");
  assert.equal(moved.body.task.version, sourceTask.body.task.version + 1);
  const projects = await cloud.db.prepare(`
    SELECT id, updated_at FROM projects
    WHERE id IN ('move-source', 'move-target')
    ORDER BY id
  `).all();
  assert.deepEqual(
    projects.results.map((project) => project.updated_at),
    [moved.body.task.updatedAt, moved.body.task.updatedAt],
  );

  const activity = await cloud.request(
    `/api/tasks/${sourceTask.body.task.id}/activities`,
    { actorName: alice },
  );
  assert.equal(activity.response.status, 200);
  assert.equal(activity.body.activities.at(-1).actorType, "agent");
  assert.match(activity.body.activities.at(-1).actorName, /Bob/);
  assert.deepEqual(activity.body.activities.at(-1).changes, [{
    field: "projectId",
    before: "move-source",
    after: "move-target",
  }]);

  const stale = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-source",
      threadId: "stale-thread",
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
});

test("remote thread identity survives controller moves and clears after create failure", async () => {
  await createProject("remote-binding");
  const legacy = await createTask("remote-binding", "Legacy local binding", alice, {
    threadId: "legacy-local-thread",
  });
  assert.equal(legacy.body.task.threadBinding, null);
  assert.equal(legacy.body.task.legacyLocalThreadId, "legacy-local-thread");
  assert.equal(legacy.body.task.conversationRefs[0].legacyLocal, true);
  const binding = {
    threadId: "remote-thread-a",
    codexProjectId: "remote-project-a",
    codexProjectKind: "remote",
    codexHostId: "ssh-a",
    workspacePath: "/same/remote/path",
  };
  const created = await createTask("remote-binding", "Remote binding", alice, {
    status: "todo",
    threadId: binding.threadId,
    threadBinding: binding,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.task.threadBinding, binding);

  const comment = await cloud.request(`/api/tasks/${created.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: { body: "Controller note", threadId: "controller-thread" },
  });
  assert.equal(comment.body.comment.threadBinding, null);
  assert.equal(comment.body.comment.legacyLocalThreadId, "controller-thread");

  const blocked = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: created.body.task.version,
      status: "blocked",
      threadId: "controller-thread",
      threadBinding: binding,
    },
  });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.body));
  assert.deepEqual(blocked.body.task.threadBinding, binding);
  assert.deepEqual(blocked.body.task.conversationRefs.map((ref) => ref.threadId), [
    binding.threadId,
    "controller-thread",
  ]);

  const todo = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: blocked.body.task.version,
      status: "todo",
      threadId: "controller-thread",
      threadBinding: null,
    },
  });
  assert.equal(todo.response.status, 200, JSON.stringify(todo.body));
  assert.equal(todo.body.task.threadId, null);
  assert.equal(todo.body.task.threadBinding, null);
  assert.deepEqual(todo.body.task.conversationRefs.map((ref) => ref.threadId), ["controller-thread"]);
});

test("PATCH rejects moving an issue that still has relations", async () => {
  await createProject("move-related-cloud-source");
  await createProject("move-related-cloud-target");
  const sourceTask = await createTask(
    "move-related-cloud-source",
    "Cloud related source",
  );
  const relatedTask = await createTask(
    "move-related-cloud-source",
    "Cloud related peer",
  );
  const linked = await cloud.request(
    `/api/tasks/${sourceTask.body.task.id}/relations/related/${relatedTask.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: sourceTask.body.task.version },
    },
  );
  assert.equal(linked.response.status, 200);

  const rejected = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: linked.body.task.version,
      projectId: "move-related-cloud-target",
    },
  });

  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "CROSS_PROJECT_RELATION");
  const unchanged = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.task.projectId, "move-related-cloud-source");
  assert.equal(unchanged.body.task.version, linked.body.task.version);
  assert.deepEqual(
    unchanged.body.task.relations.related.map((task) => task.id),
    [relatedTask.body.task.id],
  );
});

test("PATCH project and status updates use the target status ordering", async () => {
  await createProject("move-sort-source-cloud");
  await createProject("move-sort-target-cloud");
  await createTask("move-sort-target-cloud", "Cloud target first", alice, {
    status: "done",
    sortOrder: 5000,
  });
  await createTask("move-sort-target-cloud", "Cloud target second", alice, {
    status: "done",
    sortOrder: 7000,
  });
  const sourceTask = await createTask(
    "move-sort-source-cloud",
    "Cloud move and complete",
    alice,
    { status: "todo", sortOrder: 9000 },
  );

  const moved = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-sort-target-cloud",
      status: "done",
    },
  });

  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.projectId, "move-sort-target-cloud");
  assert.equal(moved.body.task.status, "done");
  assert.equal(moved.body.task.sortOrder, 4000);
});

test("PATCH rejects moving an issue to a project that does not exist", async () => {
  await createProject("missing-target-source");
  const sourceTask = await createTask(
    "missing-target-source",
    "Issue that stays in source",
    alice,
    { threadId: "unchanged-thread" },
  );
  assert.equal(sourceTask.response.status, 201);

  const rejected = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "missing-target",
      threadId: "rejected-thread",
    },
  });

  assert.equal(rejected.response.status, 404);
  assert.equal(rejected.body.error.code, "PROJECT_NOT_FOUND");
  const unchanged = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.task.projectId, "missing-target-source");
  assert.equal(unchanged.body.task.threadId, "unchanged-thread");
  assert.equal(unchanged.body.task.version, sourceTask.body.task.version);
});

test("a failed task insert rolls back its reserved project identifier", async () => {
  await createProject("atomic-counter");
  await cloud.db.exec(
    "CREATE TRIGGER fail_task_insert BEFORE INSERT ON tasks WHEN NEW.title = 'Fail counter' BEGIN SELECT RAISE(ABORT, 'intentional task insert failure'); END;",
  );
  const failed = await createTask("atomic-counter", "Fail counter");
  assert.equal(failed.response.status, 500);

  const counter = await cloud.db.prepare(
    "SELECT next_task_number FROM projects WHERE id = 'atomic-counter'",
  ).first("next_task_number");
  assert.equal(counter, 1);

  const succeeded = await createTask("atomic-counter", "First real issue");
  assert.equal(succeeded.response.status, 201);
  assert.equal(succeeded.body.task.identifier, "ATO-1");
});

test("archived tasks are excluded from project issue counts", async () => {
  const project = await createProject("archive-count");
  assert.equal(project.response.status, 201);
  const task = await createTask("archive-count", "Archive me");
  const before = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    before.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    1,
  );

  const archived = await cloud.request(`/api/tasks/${task.body.task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: task.body.task.version },
  });
  assert.equal(archived.response.status, 200);
  const after = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    after.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    0,
  );
});

test("R2 attachment upload, download, delete, and D1 failure compensation form one closed lifecycle", async () => {
  const task = await createTask("alpha", "Attachment owner");
  const uploaded = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("evidence.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment body",
  });
  assert.equal(uploaded.response.status, 201);
  const attachment = uploaded.body.attachment;
  const downloaded = await cloud.request(`/api/attachments/${attachment.id}/content`, {
    actorName: bob,
  });
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.body, "attachment body");

  const deleted = await cloud.request(`/api/attachments/${attachment.id}`, {
    method: "DELETE",
    actorName: alice,
  });
  assert.equal(deleted.response.status, 204);
  assert.equal((await cloud.listAttachmentKeys()).length, 0);

  await cloud.db.exec(
    "CREATE TRIGGER fail_attachment_insert BEFORE INSERT ON attachments WHEN NEW.filename = 'fail.txt' BEGIN SELECT RAISE(ABORT, 'intentional attachment metadata failure'); END;",
  );
  const beforeKeys = await cloud.listAttachmentKeys();
  const failed = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("fail.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "must be compensated",
  });
  assert.equal(failed.response.status, 500);
  assert.deepEqual(await cloud.listAttachmentKeys(), beforeKeys);
});

test("permanent task deletion requires archiving and cleans D1 and R2", async () => {
  await createProject("temp-cloud-delete");
  const created = await createTask("temp-cloud-delete", "Delete permanently");
  const task = created.body.task;
  const keysBefore = await cloud.listAttachmentKeys();
  const uploaded = await cloud.request(`/api/tasks/${task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "evidence.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment",
  });
  assert.equal(uploaded.response.status, 201);
  const comment = await cloud.request(`/api/tasks/${task.id}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Comment with attachment" },
  });
  assert.equal(comment.response.status, 201);
  const commentUpload = await cloud.request(
    `/api/comments/${comment.body.comment.id}/attachments`,
    {
      method: "POST",
      actorName: alice,
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
  const keysAfterUpload = await cloud.listAttachmentKeys();
  for (const attachmentId of attachmentIds) {
    assert.ok(keysAfterUpload.includes(attachmentId));
  }

  const activeDelete = await cloud.request(`/api/tasks/${task.id}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: task.version },
  });
  assert.equal(activeDelete.response.status, 409);
  assert.equal(activeDelete.body.error.code, "TASK_NOT_ARCHIVED");

  const archived = await cloud.request(`/api/tasks/${task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: task.version },
  });
  const deleted = await cloud.request(`/api/tasks/${task.id}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: archived.body.task.version },
  });
  assert.equal(deleted.response.status, 204);
  assert.deepEqual(await cloud.listAttachmentKeys(), keysBefore);
  assert.equal((await cloud.request(`/api/tasks/${task.id}`, { actorName: alice })).response.status, 404);
  assert.equal(
    await cloud.db.prepare("SELECT 1 FROM tasks WHERE id = ?").bind(task.id).first(),
    null,
  );
  assert.equal(
    await cloud.db.prepare("SELECT 1 FROM comments WHERE id = ?")
      .bind(comment.body.comment.id).first(),
    null,
  );
  const remainingAttachments = await cloud.db.prepare(`
    SELECT id FROM attachments WHERE id IN (?, ?)
  `).bind(...attachmentIds).all();
  assert.deepEqual(remainingAttachments.results, []);
  assert.equal((await cloud.request("/api/projects/temp-cloud-delete", {
    method: "DELETE",
    actorName: alice,
  })).response.status, 204);
});

test("the global revision is monotonic and lets clients poll only when data changed", async () => {
  const initial = await cloud.request("/api/revisions?since=0", { actorName: alice });
  assert.equal(initial.response.status, 200);
  const baseline = initial.body.revision;

  const unchanged = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.changed, false);

  await createTask("alpha", "Revision mutation");
  const changed = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: bob,
  });
  assert.equal(changed.body.changed, true);
  assert.ok(changed.body.revision > baseline);

  const current = await cloud.request(`/api/revisions?since=${changed.body.revision}`, {
    actorName: alice,
  });
  assert.equal(current.body.changed, false);
});

test("authenticated WebSockets receive a revision only after business data changes", async () => {
  const unauthorized = await cloud.connectWebSocket();
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.socket, null);

  const { response, socket } = await cloud.connectWebSocket("/api/events", {
    actorName: alice,
  });
  assert.equal(response.status, 101);
  assert.ok(socket);

  const message = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for revision push")), 1_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  const created = await createTask("alpha", "WebSocket revision mutation", bob);
  assert.equal(created.response.status, 201);
  const payload = await message;
  assert.equal(payload.type, "revision");
  assert.ok(Number.isSafeInteger(payload.revision));
  socket.close(1000, "test complete");
});

test("browser session cookie authenticates API reads and WebSocket reconnects", async () => {
  const login = await cloud.request("/api/meta", { actorName: alice });
  assert.equal(login.response.status, 200);
  const setCookie = login.response.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-taskboard_session=/);
  assert.match(setCookie, /; HttpOnly; Secure; SameSite=Strict$/);
  const cookie = setCookie.split(";", 1)[0];

  const projects = await cloud.request("/api/projects", {
    headers: { cookie },
  });
  assert.equal(projects.response.status, 200);

  const { response, socket } = await cloud.connectWebSocket("/api/events", { cookie });
  assert.equal(response.status, 101);
  assert.ok(socket);
  socket.close(1000, "cookie authentication test complete");
});

test("cloud-only local capability routes return an explicit companion requirement", async () => {
  const meta = await cloud.request("/api/meta", { actorName: alice });
  assert.equal(meta.response.status, 200);
  assert.equal(meta.body.mode, "cloud");
  assert.deepEqual(meta.body.realtime, {
    transport: "websocket",
    endpoint: "/api/events",
  });
  assert.equal(meta.body.localCapabilities.available, false);

  for (const pathname of [
    "/api/device-workspaces",
    "/api/projects/alpha/development-contexts",
  ]) {
    const result = await cloud.request(pathname, { actorName: alice });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "LOCAL_COMPANION_REQUIRED");
  }
});

test("task lifecycle keeps optimistic versions and never persists a worktree path", async () => {
  await createProject("task-lifecycle");
  const created = await createTask("task-lifecycle", "Lifecycle", alice, {
    developmentContext: { type: "worktree", branch: "feature/shared" },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.task.developmentContext, {
    type: "worktree",
    path: null,
    branch: "feature/shared",
  });

  const moved = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: alice,
    json: {
      version: created.body.task.version,
      status: "in_progress",
    },
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.task.status, "in_progress");

  const archived = await cloud.request(`/api/tasks/${created.body.task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: moved.body.task.version },
  });
  assert.equal(archived.response.status, 200);
  assert.ok(archived.body.task.archivedAt);

  const restored = await cloud.request(`/api/tasks/${created.body.task.id}/restore`, {
    method: "POST",
    actorName: alice,
    json: { version: archived.body.task.version },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.task.archivedAt, null);
});

test("relation direction, deletion, and parent-cycle checks match the local contract", async () => {
  await createProject("relation-parity");
  const blocker = await createTask("relation-parity", "Blocker");
  const blocked = await createTask("relation-parity", "Blocked");
  const blockedBy = await cloud.request(
    `/api/tasks/${blocked.body.task.id}/relations/blocked_by/${blocker.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: blocked.body.task.version },
    },
  );
  assert.equal(blockedBy.response.status, 200);
  assert.equal(blockedBy.body.task.relations.blockedBy[0].id, blocker.body.task.id);
  assert.equal(blockedBy.body.relatedTask.relations.blocks[0].id, blocked.body.task.id);

  const removed = await cloud.request(
    `/api/tasks/${blocked.body.task.id}/relations/blocked_by/${blocker.body.task.id}`,
    {
      method: "DELETE",
      actorName: alice,
      json: { version: blockedBy.body.task.version },
    },
  );
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.task.relations.blockedBy, []);

  const child = await createTask("relation-parity", "Child");
  const parent = await cloud.request(
    `/api/tasks/${child.body.task.id}/relations/parent/${blocker.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: child.body.task.version },
    },
  );
  assert.equal(parent.response.status, 200);
  const cycle = await cloud.request(
    `/api/tasks/${blocker.body.task.id}/relations/parent/${child.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: blocker.body.task.version },
    },
  );
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.body.error.code, "RELATION_CYCLE");
});

test("tree queries keep direct and nested ancestor/descendant traversal in cloud parity", async () => {
  const projectId = "tree-cloud-parity";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree root");
  const child = await createTask(projectId, "Tree child");
  const sibling = await createTask(projectId, "Tree sibling");
  const grandchild = await createTask(projectId, "Tree grandchild");
  const addParent = async (childTask, parentTask) => cloud.request(
    `/api/tasks/${childTask.id}/relations/parent/${parentTask.id}`,
    { method: "POST", actorName: alice, json: { version: childTask.version } },
  );
  for (const [childTask, parentTask] of [
    [child.body.task, root.body.task],
    [sibling.body.task, root.body.task],
    [grandchild.body.task, child.body.task],
  ]) {
    assert.equal((await addParent(childTask, parentTask)).response.status, 200);
  }

  const direct = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=1`,
    { actorName: alice },
  );
  assert.equal(direct.response.status, 200);
  assert.deepEqual(direct.body.tree.nodes.map((node) => [node.id, node.parentId, node.depth]), [
    [root.body.task.id, null, 0],
    [child.body.task.id, root.body.task.id, 1],
    [sibling.body.task.id, root.body.task.id, 1],
  ]);

  const descendants = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=2`,
    { actorName: alice },
  );
  assert.equal(descendants.body.tree.nodeCount, 4);
  assert.deepEqual(descendants.body.tree.nodes.at(-1).path, [
    root.body.task.id,
    child.body.task.id,
    grandchild.body.task.id,
  ]);

  const ancestors = await cloud.request(
    `/api/tasks/${grandchild.body.task.id}/tree?direction=ancestors&depth=2`,
    { actorName: alice },
  );
  assert.equal(ancestors.response.status, 200);
  assert.deepEqual(ancestors.body.tree.nodes.map((node) => [node.id, node.parentId, node.depth]), [
    [grandchild.body.task.id, null, 0],
    [child.body.task.id, grandchild.body.task.id, 1],
    [root.body.task.id, child.body.task.id, 2],
  ]);

  const invalid = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=0`,
    { actorName: alice },
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_TREE_QUERY");
});

test("cloud tree handles a 101-node frontier at depth 2", async () => {
  const projectId = "tree-cloud-frontier";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree frontier root");
  const timestamp = new Date().toISOString();

  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 101
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'tree-frontier-child-' || value,
      'TREEFRONTIER-' || value,
      ?,
      'Tree frontier child',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'tree-frontier-fixture',
      'Tree frontier fixture',
      'user',
      'tree-frontier-fixture',
      'Tree frontier fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 101
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'parent', ?, 'tree-frontier-child-' || value, ?
    FROM sequence
  `).bind(root.body.task.id, timestamp).run();

  const result = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=2`,
    { actorName: alice },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tree.nodeCount, 102);
});

test("cloud tree rejects a breadth that exceeds the 1,000-node cap", async () => {
  const projectId = "tree-cloud-cap";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree cap root");
  const timestamp = new Date().toISOString();

  // A recursive CTE keeps this cap fixture to two D1 writes instead of 1,000 API mutations.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'tree-cap-child-' || value,
      'TREECAP-' || value,
      ?,
      'Tree cap child',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'tree-cap-fixture',
      'Tree cap fixture',
      'user',
      'tree-cap-fixture',
      'Tree cap fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'parent', ?, 'tree-cap-child-' || value, ?
    FROM sequence
  `).bind(root.body.task.id, timestamp).run();

  const result = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=1`,
    { actorName: alice },
  );
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "TREE_TOO_LARGE");
});

test("concurrent inverse parent writes cannot create a cycle", async () => {
  await createProject("concurrent-parent-cycle");
  const first = await createTask("concurrent-parent-cycle", "First");
  const second = await createTask("concurrent-parent-cycle", "Second");

  const [firstResult, secondResult] = await Promise.all([
    cloud.request(
      `/api/tasks/${first.body.task.id}/relations/parent/${second.body.task.id}`,
      {
        method: "POST",
        actorName: alice,
        json: { version: first.body.task.version },
      },
    ),
    cloud.request(
      `/api/tasks/${second.body.task.id}/relations/parent/${first.body.task.id}`,
      {
        method: "POST",
        actorName: bob,
        json: { version: second.body.task.version },
      },
    ),
  ]);

  assert.deepEqual(
    [firstResult.response.status, secondResult.response.status].sort(),
    [200, 409],
  );
  const conflict = firstResult.response.status === 409 ? firstResult : secondResult;
  assert.equal(conflict.body.error.code, "RELATION_CYCLE");

  const rows = await cloud.db.prepare(`
    SELECT source_task_id, target_task_id
    FROM task_relations
    WHERE relation_type = 'parent'
      AND source_task_id IN (?, ?)
      AND target_task_id IN (?, ?)
  `).bind(
    first.body.task.id,
    second.body.task.id,
    first.body.task.id,
    second.body.task.id,
  ).all();
  assert.equal(rows.results.length, 1);

  const third = await createTask("concurrent-parent-cycle", "Third");
  const fourth = await createTask("concurrent-parent-cycle", "Fourth");
  const inserted = await Promise.allSettled([
    cloud.db.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('parent', ?, ?, ?)
    `).bind(fourth.body.task.id, third.body.task.id, new Date().toISOString()).run(),
    cloud.db.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('parent', ?, ?, ?)
    `).bind(third.body.task.id, fourth.body.task.id, new Date().toISOString()).run(),
  ]);
  assert.equal(inserted.filter((result) => result.status === "fulfilled").length, 1);
});

test("comment attachment cleanup preserves shared-state boundaries", async () => {
  await createProject("shared-boundaries");
  const task = await createTask("shared-boundaries", "Comment owner");
  const created = await cloud.request(`/api/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "Initial" },
  });
  const attachment = await cloud.request(
    `/api/comments/${created.body.comment.id}/attachments`,
    {
      method: "POST",
      actorName: bob,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": encodeURIComponent("comment.txt"),
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "comment attachment",
    },
  );
  assert.equal(attachment.response.status, 201);

  const updated = await cloud.request(`/api/comments/${created.body.comment.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: created.body.comment.version, body: "Updated" },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.comment.attachments.length, 1);

  const deleted = await cloud.request(`/api/comments/${created.body.comment.id}`, {
    method: "DELETE",
    actorName: bob,
    json: { version: updated.body.comment.version },
  });
  assert.equal(deleted.response.status, 204);
  assert.deepEqual(await cloud.listAttachmentKeys(), []);
});
