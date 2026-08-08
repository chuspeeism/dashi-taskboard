import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskboardServer } from "../server/index.mjs";

async function startFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-intervention-test-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("intervention filters are returned and manual overrides do not change task status", async (t) => {
  const baseUrl = await startFixture(t);
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Need human attention", status: "in_review" },
  });
  assert.equal(created.response.status, 201);
  const task = created.body.task;
  assert.deepEqual(task.intervention.views, ["follow_up"]);

  const excluded = await request(baseUrl, `/api/tasks/${task.id}/intervention`, {
    method: "POST",
    body: { version: task.version, view: "follow_up", mode: "exclude" },
  });
  assert.equal(excluded.response.status, 200);
  assert.equal(excluded.body.task.status, "in_review");
  assert.deepEqual(excluded.body.task.intervention.views, []);
  assert.equal(excluded.body.task.intervention.manual.follow_up, "exclude");

  const included = await request(baseUrl, `/api/tasks/${task.id}/intervention`, {
    method: "POST",
    body: { version: excluded.body.task.version, view: "resolve", mode: "include" },
  });
  assert.equal(included.response.status, 200);
  assert.equal(included.body.task.status, "in_review");
  assert.deepEqual(included.body.task.intervention.views, ["resolve"]);
  assert.equal(included.body.task.intervention.manual.resolve, "include");

  const auto = await request(baseUrl, `/api/tasks/${task.id}/intervention`, {
    method: "POST",
    body: { version: included.body.task.version, view: "resolve", mode: "auto" },
  });
  assert.equal(auto.response.status, 200);
  assert.equal(auto.body.task.status, "in_review");
  assert.deepEqual(auto.body.task.intervention.views, []);

  const restored = await request(baseUrl, `/api/tasks/${task.id}/intervention`, {
    method: "POST",
    body: { version: auto.body.task.version, view: "follow_up", mode: "auto" },
  });
  assert.equal(restored.response.status, 200);
  assert.deepEqual(restored.body.task.intervention.views, ["follow_up"]);
});
