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
    json: { id, name: id.toUpperCase(), workspacePath: `/Users/${actorName}/${id}` },
  });
}

async function createEntry(projectId, input, actorName = alice) {
  return cloud.request(`/api/projects/${projectId}/context`, {
    method: "POST",
    actorName,
    json: {
      kind: "decision",
      title: "Default decision",
      body: "Default body",
      ...input,
    },
  });
}

async function currentRevision(actorName = alice) {
  const result = await cloud.request("/api/revisions?since=0", { actorName });
  assert.equal(result.response.status, 200);
  return result.body.revision;
}

test("D1 migration and Basic Auth expose the same trusted context entry contract", async () => {
  const unauthenticated = await cloud.request("/api/projects/cloud-context/context");
  assert.equal(unauthenticated.response.status, 401);

  const schema = await cloud.db.prepare(`
    SELECT name, type FROM sqlite_schema
    WHERE name LIKE 'project_context_%'
    ORDER BY name
  `).all();
  assert.deepEqual(schema.results.map((row) => row.name), [
    "project_context_entries",
    "project_context_entries_global_revision_delete",
    "project_context_entries_global_revision_insert",
    "project_context_entries_global_revision_update",
    "project_context_entries_project_idempotency",
    "project_context_entries_project_kind",
    "project_context_entries_project_page",
    "project_context_entries_project_pinned",
    "project_context_revisions",
    "project_context_revisions_entry_version_unique",
    "project_context_revisions_entry_versions",
  ]);

  await createProject("cloud-context");
  const unexpectedQuery = await cloud.request("/api/projects/cloud-context/context?unexpected=1", {
    method: "POST",
    actorName: alice,
    json: {
      kind: "decision",
      title: "Rejected query",
      body: "Should not be created",
    },
  });
  assert.equal(unexpectedQuery.response.status, 400);
  assert.equal(unexpectedQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");
  const unsupportedContentType = await cloud.request("/api/projects/cloud-context/context", {
    method: "POST",
    actorName: alice,
    headers: { "content-type": "application/jsonx" },
    body: JSON.stringify({ kind: "decision", title: "Bad media", body: "Rejected" }),
  });
  assert.equal(unsupportedContentType.response.status, 415);
  assert.equal(unsupportedContentType.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  const injected = await createEntry("cloud-context", {
    title: "Injected author",
    authorId: "attacker",
  });
  assert.equal(injected.response.status, 400);
  assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

  const before = await currentRevision();
  const created = await createEntry("cloud-context", {
    title: "Choose D1",
    body: "Shared through the Worker",
    tags: ["cloud", "decision"],
    sourceType: "issue",
    sourceId: "ASH-46",
    sourceThreadId: "source-only",
    pinned: true,
    idempotencyKey: "cloud-decision",
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(Object.keys(created.body.entry), [
    "id", "projectId", "kind", "title", "body", "tags", "sourceType", "sourceId",
    "sourceThreadId", "authorType", "authorId", "authorName", "pinned", "archivedAt",
    "version", "idempotencyKey", "createdAt", "updatedAt",
  ]);
  assert.equal(created.body.entry.authorType, "user");
  assert.equal(created.body.entry.authorName, alice);
  assert.match(created.body.entry.authorId, /^basic:/);
  assert.equal(created.body.entry.pinned, true);
  assert.doesNotMatch(JSON.stringify(created.body), /\/Users\//);
  const stored = await cloud.db.prepare(`
    SELECT * FROM project_context_entries WHERE id = ?
  `).bind(created.body.entry.id).first();
  assert.equal(Object.keys(stored).some((key) => /path|workspace|worktree/i.test(key)), false);
  assert.ok(await currentRevision() > before);

  const replayRevision = await currentRevision();
  const replay = await createEntry("cloud-context", {
    title: "Choose D1",
    body: "Shared through the Worker",
    tags: ["cloud", "decision"],
    sourceType: "issue",
    sourceId: "ASH-46",
    sourceThreadId: "source-only",
    pinned: true,
    idempotencyKey: "cloud-decision",
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.entry.id, created.body.entry.id);
  assert.equal(await currentRevision(), replayRevision);
  const conflict = await createEntry("cloud-context", {
    title: "Different",
    idempotencyKey: "cloud-decision",
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("Worker context search, cursor, brief, lifecycle and UTF-8 limits match local behavior", async () => {
  const projectId = "cloud-lifecycle";
  await createProject(projectId);
  const pinned = await createEntry(projectId, {
    kind: "fact",
    title: "Pinned fact 100%",
    body: "Pinned first",
    tags: ["cloud"],
    pinned: true,
  });
  const requirement = await createEntry(projectId, {
    kind: "requirement",
    title: "Requirement",
    body: "Required body",
    tags: ["launch"],
    idempotencyKey: "requirement-key",
  });
  const risk = await createEntry(projectId, {
    kind: "risk",
    title: "Risk",
    body: "Monitor rollout",
    tags: ["launch"],
  });
  const oldSummary = await createEntry(projectId, {
    kind: "summary",
    title: "Old summary",
    body: "Outdated summary",
  });
  const summary = await createEntry(projectId, {
    kind: "summary",
    title: "Summary",
    body: "Summary body",
  });
  await createEntry(projectId, { kind: "fact", title: "Excluded", body: "No pin" });

  for (const [query, expected] of [
    ["query=%25", pinned.body.entry.id],
    ["query=rollout", risk.body.entry.id],
    ["kind=requirement", requirement.body.entry.id],
    ["tag=cloud", pinned.body.entry.id],
    ["pinned=true", pinned.body.entry.id],
  ]) {
    const result = await cloud.request(`/api/projects/${projectId}/context?${query}`, { actorName: alice });
    assert.equal(result.response.status, 200, query);
    assert.deepEqual(result.body.entries.map((entry) => entry.id), [expected], query);
  }

  const paged = [];
  let cursor = null;
  do {
    const page = await cloud.request(
      `/api/projects/${projectId}/context?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { actorName: alice },
    );
    assert.equal(page.response.status, 200);
    paged.push(...page.body.entries.map((entry) => entry.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(paged.length, 6);
  assert.equal(new Set(paged).size, paged.length);

  const brief1 = await cloud.request(`/api/projects/${projectId}/context/brief`, { actorName: alice });
  const brief2 = await cloud.request(`/api/projects/${projectId}/context/brief`, { actorName: bob });
  assert.deepEqual(brief1.body, brief2.body);
  assert.deepEqual(brief1.body.includedEntryIds, [
    pinned.body.entry.id,
    requirement.body.entry.id,
    risk.body.entry.id,
    summary.body.entry.id,
  ]);
  assert.equal(brief1.body.includedEntryIds.includes(oldSummary.body.entry.id), false);

  const updated = await cloud.request(`/api/context/${requirement.body.entry.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: 1, title: "Updated requirement", pinned: true },
  });
  assert.equal(updated.response.status, 200);
  const replayAfterUpdate = await createEntry(projectId, {
    kind: "requirement",
    title: "Requirement",
    body: "Required body",
    tags: ["launch"],
    idempotencyKey: requirement.body.entry.idempotencyKey,
  }, alice);
  assert.equal(replayAfterUpdate.response.status, 200);
  assert.equal(replayAfterUpdate.body.entry.id, requirement.body.entry.id);
  const changedReplay = await createEntry(projectId, {
    kind: "requirement",
    title: "Requirement",
    body: "Different original body",
    tags: ["launch"],
    idempotencyKey: requirement.body.entry.idempotencyKey,
  }, alice);
  assert.equal(changedReplay.response.status, 409);
  assert.equal(changedReplay.body.error.code, "IDEMPOTENCY_CONFLICT");
  const revisionBeforeStale = await currentRevision();
  const stale = await cloud.request(`/api/context/${requirement.body.entry.id}`, {
    method: "PATCH",
    actorName: alice,
    json: { version: 1, title: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.body.error.details, { expectedVersion: 1, actualVersion: 2 });
  assert.equal(await currentRevision(), revisionBeforeStale);

  const archived = await cloud.request(`/api/context/${requirement.body.entry.id}/archive`, {
    method: "POST",
    actorName: bob,
    json: { version: 2 },
  });
  assert.equal(archived.response.status, 200);
  const defaultList = await cloud.request(
    `/api/projects/${projectId}/context?query=Updated`,
    { actorName: alice },
  );
  assert.deepEqual(defaultList.body.entries, []);
  const archivedList = await cloud.request(
    `/api/projects/${projectId}/context?archived=true&query=Updated`,
    { actorName: alice },
  );
  assert.deepEqual(archivedList.body.entries.map((entry) => entry.id), [requirement.body.entry.id]);
  const restored = await cloud.request(`/api/context/${requirement.body.entry.id}/restore`, {
    method: "POST",
    actorName: alice,
    json: { version: 3 },
  });
  assert.equal(restored.body.entry.version, 4);
  assert.equal(restored.body.entry.archivedAt, null);
  const revisions = await cloud.request(`/api/context/${requirement.body.entry.id}/revisions`, {
    actorName: alice,
  });
  assert.deepEqual(revisions.body.revisions.map((revision) => revision.version), [1, 2, 3, 4]);
  assert.equal(revisions.body.revisions[1].authorName, bob);

  const exact = await createEntry(projectId, {
    title: "Exact bytes",
    body: "é".repeat(32_768),
    pinned: true,
  });
  assert.equal(exact.response.status, 201);
  const over = await createEntry(projectId, {
    title: "Too many bytes",
    body: "é".repeat(32_769),
  });
  assert.equal(over.response.status, 400);
  const truncated = await cloud.request(`/api/projects/${projectId}/context/brief`, { actorName: alice });
  assert.equal(truncated.body.truncated, true);
  assert.ok(truncated.body.brief.length <= 12_000);
});

test("D1 concurrency permits one idempotent create and one optimistic update winner", async () => {
  const projectId = "cloud-races";
  await createProject(projectId);
  const creates = await Promise.all(Array.from({ length: 8 }, () => createEntry(projectId, {
    title: "Only once",
    body: "Idempotent content",
    tags: ["race"],
    idempotencyKey: "race-key",
  })));
  assert.equal(creates.filter((result) => result.response.status === 201).length, 1);
  assert.equal(creates.filter((result) => result.response.status === 200).length, 7);
  assert.equal(new Set(creates.map((result) => result.body.entry.id)).size, 1);
  const entry = creates[0].body.entry;
  assert.equal(await cloud.db.prepare(`
    SELECT COUNT(*) AS count FROM project_context_entries WHERE project_id = ?
  `).bind(projectId).first("count"), 1);
  assert.equal(await cloud.db.prepare(`
    SELECT COUNT(*) AS count FROM project_context_revisions WHERE entry_id = ?
  `).bind(entry.id).first("count"), 1);

  const updates = await Promise.all([
    cloud.request(`/api/context/${entry.id}`, {
      method: "PATCH",
      actorName: alice,
      json: { version: 1, title: "Alice wins" },
    }),
    cloud.request(`/api/context/${entry.id}`, {
      method: "PATCH",
      actorName: bob,
      json: { version: 1, title: "Bob wins" },
    }),
  ]);
  assert.deepEqual(updates.map((result) => result.response.status).sort(), [200, 409]);
  const latest = await cloud.request(`/api/context/${entry.id}`, { actorName: alice });
  assert.equal(latest.body.entry.version, 2);
  const revisions = await cloud.request(`/api/context/${entry.id}/revisions`, { actorName: alice });
  assert.deepEqual(revisions.body.revisions.map((revision) => revision.version), [1, 2]);
});
