import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { main } from "../cli/taskctl.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-readme-test-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    app,
    directory,
  };
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
      CODEX_THREAD_ID: "test-thread",
    },
    ...overrides,
  });
  return {
    exitCode,
    stdout: exitCode === 0 ? stdout.json() : null,
    stderr: exitCode === 0 ? null : stderr.json(),
  };
}

test("Database: getProjectReadme returns empty record for fresh project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "db-readme-test-"));
  let db;
  try {
    db = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    db.createProject({ id: "demo-project", name: "Demo Project", workspacePath: null });

    const readme = db.getProjectReadme("demo-project");
    assert.equal(readme.projectId, "demo-project");
    assert.equal(readme.content, "");
    assert.equal(readme.version, 0);
    assert.equal(readme.createdAt, null);
    assert.equal(readme.updatedAt, null);
  } finally {
    db?.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Database: saveProjectReadme creates version 1 and subsequent updates increment version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "db-readme-test-"));
  let db;
  try {
    db = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    db.createProject({ id: "proj-1", name: "Project 1", workspacePath: null });

    const saved1 = db.saveProjectReadme("proj-1", "# Hello World");
    assert.equal(saved1.projectId, "proj-1");
    assert.equal(saved1.content, "# Hello World");
    assert.equal(saved1.version, 1);
    assert.ok(saved1.createdAt);
    assert.ok(saved1.updatedAt);

    const saved2 = db.saveProjectReadme("proj-1", "# Hello World 2", 1);
    assert.equal(saved2.version, 2);
    assert.equal(saved2.content, "# Hello World 2");

    // Optimistic locking conflict
    assert.throws(
      () => db.saveProjectReadme("proj-1", "# Conflict", 1),
      (err) => err.code === "VERSION_CONFLICT",
    );
  } finally {
    db?.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("API: GET and PUT /api/projects/:id/readme", async () => {
  const { baseUrl } = await startServer();

  // Create project
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "p-test", name: "P Test" },
  });

  // Initial GET
  const get1 = await request(baseUrl, "/api/projects/p-test/readme");
  assert.equal(get1.response.status, 200);
  assert.equal(get1.body.readme.content, "");
  assert.equal(get1.body.readme.version, 0);

  // PUT initial content
  const put1 = await request(baseUrl, "/api/projects/p-test/readme", {
    method: "PUT",
    body: { content: "# Project Overview\n\nWelcome." },
  });
  assert.equal(put1.response.status, 200);
  assert.equal(put1.body.readme.content, "# Project Overview\n\nWelcome.");
  assert.equal(put1.body.readme.version, 1);

  // PUT update with version match
  const put2 = await request(baseUrl, "/api/projects/p-test/readme", {
    method: "PUT",
    body: { content: "# Updated Overview", version: 1 },
  });
  assert.equal(put2.response.status, 200);
  assert.equal(put2.body.readme.content, "# Updated Overview");
  assert.equal(put2.body.readme.version, 2);

  // Stale version returns 409
  const putConflict = await request(baseUrl, "/api/projects/p-test/readme", {
    method: "PUT",
    body: { content: "# Stale", version: 1 },
  });
  assert.equal(putConflict.response.status, 409);
  assert.equal(putConflict.body.error.code, "VERSION_CONFLICT");

  // Non-existent project returns 404
  const getMissing = await request(baseUrl, "/api/projects/non-existent/readme");
  assert.equal(getMissing.response.status, 404);
  assert.equal(getMissing.body.error.code, "PROJECT_NOT_FOUND");
});

test("CLI: taskctl project readme get and set", async () => {
  const { baseUrl, directory } = await startServer();

  // Create project
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "cli-proj", name: "CLI Project" },
  });

  // Get initially empty README
  const cliGet1 = await runCli(["project", "readme", "get", "cli-proj"], baseUrl);
  assert.equal(cliGet1.exitCode, 0);
  assert.equal(cliGet1.stdout.readme.content, "");
  assert.equal(cliGet1.stdout.readme.version, 0);

  // Set README via --content
  const cliSet1 = await runCli(
    ["project", "readme", "set", "cli-proj", "--content=# Architecture\n\n- microservices"],
    baseUrl,
  );
  assert.equal(cliSet1.exitCode, 0);
  assert.equal(cliSet1.stdout.readme.content, "# Architecture\n\n- microservices");
  assert.equal(cliSet1.stdout.readme.version, 1);

  // Set README via --file
  const testFilePath = path.join(directory, "README.md");
  await writeFile(testFilePath, "# From File\n\nCreated by taskctl test.", "utf8");

  const cliSet2 = await runCli(
    ["project", "readme", "set", "cli-proj", `--file=${testFilePath}`, "--if-version=1"],
    baseUrl,
  );
  assert.equal(cliSet2.exitCode, 0);
  assert.equal(cliSet2.stdout.readme.content, "# From File\n\nCreated by taskctl test.");
  assert.equal(cliSet2.stdout.readme.version, 2);

  // Verify get returns the updated content
  const cliGet2 = await runCli(["project", "readme", "cli-proj"], baseUrl);
  assert.equal(cliGet2.exitCode, 0);
  assert.equal(cliGet2.stdout.readme.content, "# From File\n\nCreated by taskctl test.");
  assert.equal(cliGet2.stdout.readme.version, 2);

  // Error when both --content and --file provided
  const cliErrBoth = await runCli(
    ["project", "readme", "set", "cli-proj", "--content=foo", `--file=${testFilePath}`],
    baseUrl,
  );
  assert.equal(cliErrBoth.exitCode, 2);
  assert.equal(cliErrBoth.stderr.error.code, "USAGE_ERROR");
});
