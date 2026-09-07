import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createTaskboardServer } from "../server/index.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

async function runBootstrap(baseUrl, configPath) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(PROJECT_ROOT, "scripts/bootstrap-business-os.mjs"),
    "--config",
    configPath,
    "--url",
    baseUrl,
    "--json",
  ], {
    cwd: PROJECT_ROOT,
  });
  return JSON.parse(stdout);
}

test("bootstrap backfills a missing project area and is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "business-os-bootstrap-test-"));
  const workspacePath = path.join(directory, "workspace");
  const codexStatePath = path.join(directory, "codex-state.json");
  const configPath = path.join(directory, "projects.json");
  const projectId = "legacy-project";
  await mkdir(workspacePath);
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      [projectId]: { rootPaths: [workspacePath] },
    },
  }));
  await writeFile(configPath, JSON.stringify({
    projects: [{
      name: "Legacy project",
      area: "运营",
      workspacePath,
    }],
  }));

  const app = createTaskboardServer({ dataDirectory: directory, codexStatePath });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: projectId, name: "Legacy project", workspacePath },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.project.area, null);

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const first = await runBootstrap(baseUrl, configPath);
  assert.deepEqual(first.projects, {
    created: [],
    reused: [],
    updated: [projectId],
  });

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: project\.updated/);
  const event = JSON.parse(message.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.equal(event.project.id, projectId);
  assert.equal(event.project.area, "运营");
  await reader.cancel();

  const projects = await request(baseUrl, "/api/projects");
  assert.equal(
    projects.body.projects.find((project) => project.id === projectId).area,
    "运营",
  );

  const second = await runBootstrap(baseUrl, configPath);
  assert.deepEqual(second.projects, {
    created: [],
    reused: [projectId],
    updated: [],
  });

  const sameArea = await request(baseUrl, `/api/projects/${projectId}`, {
    method: "PATCH",
    body: { area: "运营" },
  });
  assert.equal(sameArea.response.status, 200);

  const conflictingPatch = await request(baseUrl, `/api/projects/${projectId}`, {
    method: "PATCH",
    body: { area: "财务" },
  });
  assert.equal(conflictingPatch.response.status, 409);
  assert.equal(conflictingPatch.body.error.code, "PROJECT_AREA_CONFLICT");
  assert.equal(
    (await request(baseUrl, "/api/projects")).body.projects
      .find((project) => project.id === projectId).area,
    "运营",
  );

  app.database.database.prepare("UPDATE projects SET area = ? WHERE id = ?")
    .run("财务", projectId);
  await assert.rejects(
    () => runBootstrap(baseUrl, configPath),
    (error) => /does not match the manifest \(area="财务"\)/.test(error.stderr),
  );
  const unchanged = await request(baseUrl, "/api/projects");
  assert.equal(
    unchanged.body.projects.find((project) => project.id === projectId).area,
    "财务",
  );
});
