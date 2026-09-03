import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { main } from "../cli/taskctl.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-library-test-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
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
  return { response, body: text ? JSON.parse(text) : undefined };
}

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    json() { return JSON.parse(value); },
  };
}

async function runCli(argv, baseUrl, overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      CODEX_TASKBOARD_URL: baseUrl,
      CODEX_THREAD_ID: "atlas-library-test-thread",
    },
    ...overrides,
  });
  return {
    exitCode,
    stdout: exitCode === 0 ? stdout.json() : null,
    stderr: exitCode === 0 ? null : stderr.json(),
  };
}

test("database migrates Project Docs into one project overview document", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-library-db-"));
  const filename = path.join(directory, "taskboard.sqlite");
  let database;
  try {
    database = new TaskboardDatabase(filename);
    database.createProject({ id: "legacy", name: "Legacy", workspacePath: null });
    database.database.prepare(`
      INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("legacy", "# 旧项目\n\n原始内容", 3, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    database.database.close();

    database = new TaskboardDatabase(filename);
    const documents = database.listDocuments("legacy");
    assert.equal(documents.length, 1);
    assert.equal(documents[0].title, "项目说明");
    assert.equal(documents[0].content, "# 旧项目\n\n原始内容");
    assert.equal(documents[0].version, 3);
    assert.deepEqual(database.listDocumentRevisions(documents[0].id).map((revision) => revision.version), [3]);

    const readme = database.getProjectReadme("legacy");
    assert.equal(readme.content, documents[0].content);
    assert.equal(readme.version, documents[0].version);
  } finally {
    database?.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local API provides Chinese folders, Markdown history, search, export, and conflicts", async () => {
  const { baseUrl } = await startServer();
  await jsonRequest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "atlas-demo", name: "Atlas Demo" },
  });

  const folderResult = await jsonRequest(baseUrl, "/api/projects/atlas-demo/document-folders", {
    method: "POST",
    body: { name: "项目资料", parentId: null },
  });
  assert.equal(folderResult.response.status, 201);
  assert.equal(folderResult.body.folder.name, "项目资料");

  const createResult = await jsonRequest(baseUrl, "/api/projects/atlas-demo/documents", {
    method: "POST",
    headers: {
      "x-taskboard-user-id": "owner",
      "x-taskboard-user-name": encodeURIComponent("老板"),
    },
    body: {
      folderId: folderResult.body.folder.id,
      title: "服务器连接信息",
      type: "general",
      content: "# 服务器\n\nhost: 10.0.0.8",
    },
  });
  assert.equal(createResult.response.status, 201);
  assert.equal(createResult.body.document.version, 1);
  assert.equal(createResult.body.document.updatedBy.name, "老板");
  const documentId = createResult.body.document.id;

  const updateResult = await jsonRequest(baseUrl, `/api/documents/${documentId}`, {
    method: "PUT",
    body: { content: "# 服务器\n\nhost: 10.0.0.9", version: 1 },
  });
  assert.equal(updateResult.response.status, 200);
  assert.equal(updateResult.body.document.version, 2);

  const conflict = await jsonRequest(baseUrl, `/api/documents/${documentId}`, {
    method: "PUT",
    body: { content: "# 被覆盖", version: 1 },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "VERSION_CONFLICT");
  assert.equal(conflict.body.error.details.actualVersion, 2);

  const search = await jsonRequest(baseUrl, "/api/projects/atlas-demo/documents?q=10.0.0.9");
  assert.equal(search.response.status, 200);
  assert.deepEqual(search.body.documents.map((document) => document.id), [documentId]);

  const revisions = await jsonRequest(baseUrl, `/api/documents/${documentId}/revisions`);
  assert.deepEqual(revisions.body.revisions.map((revision) => revision.version), [2, 1]);

  const exported = await fetch(`${baseUrl}/api/documents/${documentId}/export`);
  assert.equal(exported.status, 200);
  assert.equal(await exported.text(), "# 服务器\n\nhost: 10.0.0.9");
  assert.match(exported.headers.get("content-disposition"), /filename\*=UTF-8''/);
});

test("document attachment uploads and downloads from the library", async () => {
  const { baseUrl } = await startServer();
  await jsonRequest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "files", name: "Files" },
  });
  const created = await jsonRequest(baseUrl, "/api/projects/files/documents", {
    method: "POST",
    body: { title: "交付资料", type: "general", content: "" },
  });
  const documentId = created.body.document.id;
  const upload = await fetch(`${baseUrl}/api/documents/${documentId}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-taskboard-filename": encodeURIComponent("验收资料.pdf"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: Buffer.from("pdf-test"),
  });
  assert.equal(upload.status, 201);
  const { attachment } = await upload.json();
  assert.equal(attachment.documentId, documentId);
  assert.equal(attachment.filename, "验收资料.pdf");

  const download = await fetch(`${baseUrl}/api/document-attachments/${attachment.id}/content`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "pdf-test");
});

test("atlasctl document commands complete the AI Markdown round trip", async () => {
  const { baseUrl, directory } = await startServer();
  await jsonRequest(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "cli-docs", name: "CLI Docs" },
  });

  const created = await runCli([
    "document", "create",
    "--project", "cli-docs",
    "--title", "登录改造 SPEC",
    "--type", "spec",
    "--content", "# 登录改造\n\n验收标准",
  ], baseUrl);
  assert.equal(created.exitCode, 0);
  assert.equal(created.stdout.document.version, 1);
  const documentId = created.stdout.document.id;

  const updated = await runCli([
    "document", "update", documentId,
    "--content", "# 登录改造\n\n已确认",
    "--if-version", "1",
  ], baseUrl);
  assert.equal(updated.exitCode, 0);
  assert.equal(updated.stdout.document.version, 2);

  const searched = await runCli([
    "document", "search", "--project", "cli-docs", "--query", "已确认",
  ], baseUrl);
  assert.deepEqual(searched.stdout.documents.map((document) => document.id), [documentId]);

  const output = path.join(directory, "登录改造 SPEC.md");
  const exported = await runCli([
    "document", "export", documentId, "--output", output,
  ], baseUrl);
  assert.equal(exported.exitCode, 0);
  assert.equal(exported.stdout.output, output);
  assert.equal(await readFile(output, "utf8"), "# 登录改造\n\n已确认");

  const stale = await runCli([
    "document", "update", documentId,
    "--content", "# 旧内容",
    "--if-version", "1",
  ], baseUrl);
  assert.equal(stale.exitCode, 5);
  assert.equal(stale.stderr.error.code, "VERSION_CONFLICT");
});
