import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "project-context-local-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  running.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function request(baseUrl, pathname, { body, headers: inputHeaders, ...init } = {}) {
  const headers = new Headers(inputHeaders);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

const aliceHeaders = {
  "x-taskboard-user-id": "alice",
  "x-taskboard-user-name": encodeURIComponent("Alice"),
};

async function createEntry(baseUrl, input, headers = aliceHeaders) {
  return request(baseUrl, "/api/projects/local/context", {
    method: "POST",
    headers,
    body: {
      kind: "decision",
      title: "Default decision",
      body: "Default body",
      ...input,
    },
  });
}

test("local context migration is repeatable and preserves entries and revisions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "project-context-migration-"));
  running.push({ app: null, directory });
  const databasePath = path.join(directory, "taskboard.sqlite");
  const input = {
    kind: "decision",
    title: "Keep the schema",
    body: "Migration replay must preserve this entry.",
    tags: ["migration"],
    sourceType: "manual",
    sourceId: null,
    sourceThreadId: null,
    pinned: false,
    idempotencyKey: "migration-entry",
  };
  const actor = { type: "user", id: "alice", name: "Alice" };

  let database = new TaskboardDatabase(databasePath);
  const created = database.createContextEntry("local", input, actor).entry;
  database.close();
  database = new TaskboardDatabase(databasePath);
  assert.equal(database.getContextEntry(created.id).title, input.title);
  assert.deepEqual(database.listContextRevisions(created.id).map((revision) => revision.version), [1]);
  const schemaNames = database.database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name LIKE 'project_context_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(schemaNames, [
    "project_context_entries",
    "project_context_entries_project_idempotency",
    "project_context_entries_project_kind",
    "project_context_entries_project_page",
    "project_context_entries_project_pinned",
    "project_context_revisions",
    "project_context_revisions_entry_version_unique",
    "project_context_revisions_entry_versions",
  ]);
  database.close();
});

test("local context API covers identity, idempotency, filters and stable pagination", async () => {
  const { baseUrl } = await startServer();
  const created = await createEntry(baseUrl, {
    title: "Choose 100% D1",
    body: "Cloud decision body",
    tags: ["cloud", "launch"],
    sourceType: "issue",
    sourceId: "ASH-46",
    sourceThreadId: "thread-source-only",
    pinned: true,
    idempotencyKey: "decision-1",
    authorName: "Injected",
  });
  assert.equal(created.response.status, 400);
  assert.equal(created.body.error.code, "UNKNOWN_FIELD");
  const unexpectedQuery = await request(baseUrl, "/api/projects/local/context?unexpected=1", {
    method: "POST",
    headers: aliceHeaders,
    body: {
      kind: "decision",
      title: "Rejected query",
      body: "Should not be created",
    },
  });
  assert.equal(unexpectedQuery.response.status, 400);
  assert.equal(unexpectedQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");
  const unsupportedContentType = await fetch(`${baseUrl}/api/projects/local/context`, {
    method: "POST",
    headers: { ...aliceHeaders, "content-type": "application/jsonx" },
    body: JSON.stringify({ kind: "decision", title: "Bad media", body: "Rejected" }),
  });
  assert.equal(unsupportedContentType.status, 415);
  assert.equal((await unsupportedContentType.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");

  const first = await createEntry(baseUrl, {
    title: "Choose 100% D1",
    body: "Cloud decision body",
    tags: ["cloud", "launch"],
    sourceType: "issue",
    sourceId: "ASH-46",
    sourceThreadId: "thread-source-only",
    pinned: true,
    idempotencyKey: "decision-1",
  });
  assert.equal(first.response.status, 201);
  assert.deepEqual(Object.keys(first.body.entry), [
    "id", "projectId", "kind", "title", "body", "tags", "sourceType", "sourceId",
    "sourceThreadId", "authorType", "authorId", "authorName", "pinned", "archivedAt",
    "version", "idempotencyKey", "createdAt", "updatedAt",
  ]);
  assert.equal(first.body.entry.authorId, "alice");
  assert.equal(first.body.entry.authorName, "Alice");
  assert.equal(first.body.entry.version, 1);
  assert.equal(first.body.entry.archivedAt, null);

  const replay = await createEntry(baseUrl, {
    title: "Choose 100% D1",
    body: "Cloud decision body",
    tags: ["cloud", "launch"],
    sourceType: "issue",
    sourceId: "ASH-46",
    sourceThreadId: "thread-source-only",
    pinned: true,
    idempotencyKey: "decision-1",
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.entry.id, first.body.entry.id);
  const idempotencyConflict = await createEntry(baseUrl, {
    title: "Different content",
    idempotencyKey: "decision-1",
  });
  assert.equal(idempotencyConflict.response.status, 409);
  assert.equal(idempotencyConflict.body.error.code, "IDEMPOTENCY_CONFLICT");

  const risk = await createEntry(baseUrl, {
    kind: "risk",
    title: "Launch risk",
    body: "Monitor the rollout",
    tags: ["launch"],
  });
  const fact = await createEntry(baseUrl, {
    kind: "fact",
    title: "Unpinned fact",
    body: "Not selected by brief",
    tags: ["fact"],
  });
  for (const [query, expectedId] of [
    ["query=%25", first.body.entry.id],
    ["query=rollout", risk.body.entry.id],
    ["query=fact", fact.body.entry.id],
    ["kind=risk", risk.body.entry.id],
    ["tag=cloud", first.body.entry.id],
    ["pinned=true", first.body.entry.id],
  ]) {
    const listed = await request(baseUrl, `/api/projects/local/context?${query}`);
    assert.equal(listed.response.status, 200, query);
    assert.deepEqual(listed.body.entries.map((entry) => entry.id), [expectedId], query);
  }

  const pagedIds = [];
  let cursor = null;
  do {
    const page = await request(
      baseUrl,
      `/api/projects/local/context?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    assert.equal(page.response.status, 200);
    pagedIds.push(...page.body.entries.map((entry) => entry.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(pagedIds.length, 3);
  assert.equal(new Set(pagedIds).size, pagedIds.length);

  const invalidCursor = await request(baseUrl, "/api/projects/local/context?cursor=not+base64");
  assert.equal(invalidCursor.response.status, 400);
  assert.equal(invalidCursor.body.error.code, "INVALID_QUERY_PARAMETER");
});

test("local context lifecycle returns 409 without mutation and keeps deterministic revisions", async () => {
  const { baseUrl } = await startServer();
  const created = await createEntry(baseUrl, {
    title: "Original",
    tags: ["decision"],
    idempotencyKey: "lifecycle",
  });
  const id = created.body.entry.id;
  const updated = await request(baseUrl, `/api/context/${id}`, {
    method: "PATCH",
    headers: aliceHeaders,
    body: { version: 1, title: "Updated", pinned: true },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.entry.version, 2);

  const replayAfterUpdate = await createEntry(baseUrl, {
    title: "Original",
    tags: ["decision"],
    idempotencyKey: "lifecycle",
  });
  assert.equal(replayAfterUpdate.response.status, 200);
  assert.equal(replayAfterUpdate.body.entry.id, id);
  const changedReplay = await createEntry(baseUrl, {
    title: "Original",
    body: "Different original body",
    tags: ["decision"],
    idempotencyKey: "lifecycle",
  });
  assert.equal(changedReplay.response.status, 409);
  assert.equal(changedReplay.body.error.code, "IDEMPOTENCY_CONFLICT");

  const stale = await request(baseUrl, `/api/context/${id}`, {
    method: "PATCH",
    headers: aliceHeaders,
    body: { version: 1, title: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.body.error.details, { expectedVersion: 1, actualVersion: 2 });
  const afterStale = await request(baseUrl, `/api/context/${id}`);
  assert.equal(afterStale.body.entry.title, "Updated");

  const archived = await request(baseUrl, `/api/context/${id}/archive`, {
    method: "POST",
    headers: aliceHeaders,
    body: { version: 2 },
  });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.body.entry.version, 3);
  assert.ok(archived.body.entry.archivedAt);
  const defaultList = await request(baseUrl, "/api/projects/local/context");
  assert.deepEqual(defaultList.body.entries, []);
  const archivedList = await request(baseUrl, "/api/projects/local/context?archived=true");
  assert.deepEqual(archivedList.body.entries.map((entry) => entry.id), [id]);

  const restored = await request(baseUrl, `/api/context/${id}/restore`, {
    method: "POST",
    headers: aliceHeaders,
    body: { version: 3 },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.entry.version, 4);
  assert.equal(restored.body.entry.archivedAt, null);
  const revisions = await request(baseUrl, `/api/context/${id}/revisions`);
  assert.deepEqual(revisions.body.revisions.map((revision) => revision.version), [1, 2, 3, 4]);
  assert.deepEqual(revisions.body.revisions.map((revision) => revision.title), [
    "Original", "Updated", "Updated", "Updated",
  ]);
});

test("local context brief is deterministic and the Markdown body uses a 64 KiB UTF-8 limit", async () => {
  const { baseUrl } = await startServer();
  const pinned = await createEntry(baseUrl, {
    kind: "fact",
    title: "Pinned fact",
    body: "Pinned first",
    pinned: true,
  });
  const requirement = await createEntry(baseUrl, {
    kind: "requirement",
    title: "Requirement",
    body: "Required next",
  });
  const risk = await createEntry(baseUrl, {
    kind: "risk",
    title: "Risk",
    body: "Risk after primary",
  });
  const oldSummary = await createEntry(baseUrl, {
    kind: "summary",
    title: "Old summary",
    body: "Outdated summary",
  });
  const summary = await createEntry(baseUrl, {
    kind: "summary",
    title: "Summary",
    body: "Summary last",
  });
  await createEntry(baseUrl, { kind: "fact", title: "Excluded fact", body: "Not pinned" });

  const firstBrief = await request(baseUrl, "/api/projects/local/context/brief");
  const secondBrief = await request(baseUrl, "/api/projects/local/context/brief");
  assert.deepEqual(firstBrief.body, secondBrief.body);
  assert.deepEqual(firstBrief.body.includedEntryIds, [
    pinned.body.entry.id,
    requirement.body.entry.id,
    risk.body.entry.id,
    summary.body.entry.id,
  ]);
  assert.equal(firstBrief.body.includedEntryIds.includes(oldSummary.body.entry.id), false);

  const exact = await createEntry(baseUrl, {
    title: "Exact byte limit",
    body: "é".repeat(32_768),
    pinned: true,
  });
  assert.equal(exact.response.status, 201);
  const over = await createEntry(baseUrl, {
    title: "Over byte limit",
    body: "é".repeat(32_769),
  });
  assert.equal(over.response.status, 400);
  assert.equal(over.body.error.code, "INVALID_FIELD");
  const truncated = await request(baseUrl, "/api/projects/local/context/brief");
  assert.equal(truncated.body.truncated, true);
  assert.ok(truncated.body.brief.length <= 12_000);
});
