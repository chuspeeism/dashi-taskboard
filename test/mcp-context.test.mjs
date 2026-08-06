import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  CompanionError,
  createCompanionClient,
  publicCompanionError,
  publicProject,
  resolveCompanionUrl,
  resolveMappedProject,
  workspaceContains,
} from "../mcp/companion-client.mjs";

const DEFAULT_COMPANION_URL = "http://127.0.0.1:47823";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status, code, details = undefined) {
  return jsonResponse({
    error: {
      code,
      message: "upstream message must not reach the model",
      ...(details === undefined ? {} : { details }),
    },
  }, status);
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

test("resolveCompanionUrl uses the explicit, legacy, and default loopback origins in order", () => {
  assert.equal(resolveCompanionUrl({}), DEFAULT_COMPANION_URL);
  assert.equal(
    resolveCompanionUrl({ CODEX_TASKBOARD_URL: "http://localhost:49001/" }),
    "http://localhost:49001",
  );
  assert.equal(
    resolveCompanionUrl({
      CODEX_TASKBOARD_COMPANION_URL: "https://[::1]:49002/",
      CODEX_TASKBOARD_URL: "http://localhost:49001",
    }),
    "https://[::1]:49002",
  );
  assert.equal(
    resolveCompanionUrl({ CODEX_TASKBOARD_COMPANION_URL: "http://127.24.5.9:49003" }),
    "http://127.24.5.9:49003",
  );
});

test("resolveCompanionUrl rejects credentials, non-loopback hosts, paths, queries, and fragments", () => {
  const rejected = [
    "not a URL",
    "ftp://127.0.0.1:47823",
    "http://0.0.0.0:47823",
    "http://192.168.1.20:47823",
    "https://tasks.example.test",
    "http://localhost.example.test:47823",
    "http://127.example.test:47823",
    "http://alice:shared-password@127.0.0.1:47823",
    "http://127.0.0.1:47823/api",
    "http://127.0.0.1:47823/?token=secret",
    "http://127.0.0.1:47823/#secret",
  ];

  for (const rawUrl of rejected) {
    assert.throws(
      () => resolveCompanionUrl({ CODEX_TASKBOARD_COMPANION_URL: rawUrl }),
      (error) => {
        assert.ok(error instanceof CompanionError, rawUrl);
        assert.deepEqual(publicCompanionError(error), {
          status: 400,
          code: "INVALID_COMPANION_URL",
          category: "invalid_configuration",
          action: "Set the companion URL to a loopback HTTP or HTTPS origin.",
        });
        assert.equal(JSON.stringify(publicCompanionError(error)).includes(rawUrl), false);
        return true;
      },
    );
  }
});

test("workspaceContains requires absolute directory containment instead of a shared prefix", () => {
  const workspace = path.resolve("/work/projects/taskboard");
  assert.equal(workspaceContains(workspace, workspace), true);
  assert.equal(workspaceContains(workspace, path.join(workspace, "packages", "api")), true);
  assert.equal(workspaceContains(workspace, path.resolve("/work/projects/taskboard-copy")), false);
  assert.equal(workspaceContains(workspace, path.resolve("/work/projects")), false);
  assert.equal(workspaceContains("relative/project", path.resolve("/work/projects/taskboard")), false);
  assert.equal(workspaceContains(workspace, "relative/cwd"), false);
});

test("resolveMappedProject chooses the most-specific workspace and never falls back", () => {
  const projects = [
    { id: "root", name: "Root", workspacePath: path.resolve("/work") },
    { id: "repo", name: "Repo", workspacePath: path.resolve("/work/repo") },
    { id: "package", name: "Package", workspacePath: path.resolve("/work/repo/packages/api") },
    { id: "unmapped", name: "Unmapped", workspacePath: null },
  ];

  assert.equal(
    resolveMappedProject(projects, path.resolve("/work/repo/packages/api/src")).id,
    "package",
  );
  assert.equal(resolveMappedProject(projects, path.resolve("/work/repo/web")).id, "repo");
  assert.equal(resolveMappedProject(projects, path.resolve("/elsewhere")), null);
  assert.equal(resolveMappedProject([], path.resolve("/work/repo")), null);
});

test("publicProject exposes only stable project metadata", () => {
  const project = publicProject({
    id: "taskboard",
    name: "Taskboard",
    workspacePath: "/Users/alice/private/taskboard",
    cwd: "/Users/alice/private/taskboard/packages/api",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T01:00:00.000Z",
    issueCount: 4,
    authorization: "Basic secret",
    password: "shared-password",
    env: { SECRET: "environment-secret" },
    arbitrary: { path: "/private/arbitrary" },
  });

  assert.deepEqual(project, {
    id: "taskboard",
    name: "Taskboard",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T01:00:00.000Z",
    issueCount: 4,
  });
  assert.doesNotMatch(JSON.stringify(project), /Users|authorization|password|environment|arbitrary/i);
});

test("client sends timeout-bounded JSON requests without credentials", async () => {
  const calls = [];
  const timeoutController = new AbortController();
  let requestedTimeout;
  const client = createCompanionClient({
    env: {
      CODEX_TASKBOARD_COMPANION_URL: "http://127.0.0.1:49000",
      AUTHORIZATION: "Basic environment-secret",
      SHARED_PASSWORD: "shared-password",
    },
    createTimeoutSignal(timeoutMs) {
      requestedTimeout = timeoutMs;
      return timeoutController.signal;
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ entry: { id: "entry-1" } }, 201);
    },
  });

  const payload = await client.request(
    "POST",
    ["api", "projects", "team/alpha", "context"],
    {
      query: { query: "100% + /?", cursor: "a+b/c=", omitted: undefined },
      body: { title: "Decision", body: "Keep the public contract" },
    },
  );

  assert.deepEqual(payload, { entry: { id: "entry-1" } });
  assert.equal(requestedTimeout, 10_000);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.toString(),
    "http://127.0.0.1:49000/api/projects/team%2Falpha/context?query=100%25+%2B+%2F%3F&cursor=a%2Bb%2Fc%3D",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.signal, timeoutController.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "Decision",
    body: "Keep the public contract",
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-taskboard-client"), "taskctl");
  assert.equal(headers.has("authorization"), false);
  assert.doesNotMatch(JSON.stringify(calls), /environment-secret|shared-password/);
});

test("client keeps GET requests bodyless and parses JSON text", async () => {
  let requestInit;
  const client = createCompanionClient({
    env: {},
    fetch: async (_url, init) => {
      requestInit = init;
      return new Response('{"projects":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await client.request("GET", "/api/projects"), { projects: [] });
  assert.equal("body" in requestInit, false);
  assert.equal(new Headers(requestInit.headers).has("content-type"), false);
});

test("currentProject resolves through /api/projects and strips the workspace path", async () => {
  let requestedUrl;
  const client = createCompanionClient({
    cwd: path.resolve("/work/repo/packages/mcp"),
    env: {},
    fetch: async (url) => {
      requestedUrl = url.toString();
      return jsonResponse({
        projects: [
          {
            id: "repo",
            name: "Repository",
            workspacePath: path.resolve("/work/repo"),
            issueCount: 2,
          },
          { id: "other", name: "Other", workspacePath: path.resolve("/other") },
        ],
      });
    },
  });

  assert.deepEqual(await client.currentProject(), {
    id: "repo",
    name: "Repository",
    issueCount: 2,
  });
  assert.equal(requestedUrl, `${DEFAULT_COMPANION_URL}/api/projects`);
});

test("currentProject reports an actionable error instead of selecting an unrelated project", async () => {
  const client = createCompanionClient({
    cwd: path.resolve("/not/mapped"),
    env: {},
    fetch: async () => jsonResponse({
      projects: [{ id: "other", name: "Other", workspacePath: path.resolve("/other") }],
    }),
  });

  const error = await captureError(() => client.currentProject());
  assert.deepEqual(publicCompanionError(error), {
    status: 404,
    code: "PROJECT_MAPPING_NOT_FOUND",
    category: "project_not_mapped",
    action: "Map the current workspace to a taskboard project and retry.",
  });
});

test("client maps API failures to safe, distinct, actionable errors", async (t) => {
  const cases = [
    [400, "INVALID_FIELD", "invalid_request", "Check the tool arguments and retry."],
    [401, "UNAUTHORIZED", "authentication_required", "Log in through the local companion and retry."],
    [404, "CONTEXT_NOT_FOUND", "not_found", "Refresh the project or context entry identifier and retry."],
    [409, "VERSION_CONFLICT", "version_conflict", "Reload the context entry, then retry with its current version."],
    [409, "CONTEXT_VERSION_CONFLICT", "version_conflict", "Reload the context entry, then retry with its current version."],
    [409, "IDEMPOTENCY_CONFLICT", "idempotency_conflict", "Reuse the original content or choose a new idempotency key."],
    [409, "CONTEXT_IDEMPOTENCY_CONFLICT", "idempotency_conflict", "Reuse the original content or choose a new idempotency key."],
    [409, "CONTEXT_ALREADY_ARCHIVED", "already_archived", "Reload the context entry; it is already archived."],
    [409, "CONTEXT_NOT_ARCHIVED", "not_archived", "Reload the context entry; only archived entries can be restored."],
    [409, "CLOUD_NOT_CONFIGURED", "cloud_not_configured", "Configure cloud collaboration in the local companion and retry."],
    [500, "SERVER_MISCONFIGURED", "server_misconfigured", "Ask the taskboard administrator to check the server configuration."],
    [502, "REMOTE_UNAVAILABLE", "cloud_unavailable", "Check the cloud taskboard connection and retry."],
  ];

  for (const [status, code, category, action] of cases) {
    await t.test(`${status} ${code}`, async () => {
      const client = createCompanionClient({
        env: {},
        fetch: async () => errorResponse(status, code, {
          expectedVersion: 3,
          actualVersion: 4,
          workspacePath: "/Users/alice/private/project",
          authorization: "Basic secret",
          password: "shared-password",
          env: { SECRET: "environment-secret" },
          arbitrary: "must be removed",
        }),
      });

      const error = await captureError(() => client.request("GET", "/api/context/entry"));
      assert.ok(error instanceof CompanionError);
      assert.deepEqual(publicCompanionError(error), {
        status,
        code,
        category,
        action,
        details: { expectedVersion: 3, actualVersion: 4 },
      });
      assert.doesNotMatch(
        JSON.stringify(publicCompanionError(error)),
        /upstream message|Users|authorization|password|environment|arbitrary|127\.0\.0\.1/i,
      );
    });
  }
});

test("client drops non-numeric version details", async () => {
  const client = createCompanionClient({
    env: {},
    fetch: async () => errorResponse(409, "VERSION_CONFLICT", {
      expectedVersion: "3 /Users/alice",
      actualVersion: null,
    }),
  });

  const error = await captureError(() => client.request("PATCH", "/api/context/entry"));
  assert.deepEqual(publicCompanionError(error), {
    status: 409,
    code: "VERSION_CONFLICT",
    category: "version_conflict",
    action: "Reload the context entry, then retry with its current version.",
  });
});

test("client maps local network and timeout failures without leaking exception details", async (t) => {
  for (const failure of [
    new Error("connect ECONNREFUSED http://127.0.0.1:47823 /Users/alice shared-password"),
    new DOMException("environment-secret", "TimeoutError"),
  ]) {
    await t.test(failure.name, async () => {
      const client = createCompanionClient({
        env: {},
        fetch: async () => { throw failure; },
      });
      const error = await captureError(() => client.request("GET", "/api/projects"));
      assert.deepEqual(publicCompanionError(error), {
        status: 503,
        code: "COMPANION_UNAVAILABLE",
        category: "companion_unavailable",
        action: "Start the local taskboard companion and retry.",
      });
      assert.doesNotMatch(
        JSON.stringify(publicCompanionError(error)),
        /ECONNREFUSED|127\.0\.0\.1|Users|password|environment-secret/i,
      );
    });
  }
});

test("client rejects invalid JSON and absolute request URLs without leaking either value", async () => {
  const invalidJsonClient = createCompanionClient({
    env: {},
    fetch: async () => new Response("shared-password at /Users/alice", { status: 502 }),
  });
  const invalidJson = await captureError(
    () => invalidJsonClient.request("GET", "/api/projects"),
  );
  assert.deepEqual(publicCompanionError(invalidJson), {
    status: 502,
    code: "INVALID_COMPANION_RESPONSE",
    category: "invalid_response",
    action: "Restart or update the local taskboard companion and retry.",
  });

  let fetchCalled = false;
  const pathClient = createCompanionClient({
    env: {},
    fetch: async () => {
      fetchCalled = true;
      return jsonResponse({});
    },
  });
  const invalidPath = await captureError(
    () => pathClient.request("GET", "https://tasks.example.test/private?token=secret"),
  );
  assert.deepEqual(publicCompanionError(invalidPath), {
    status: 400,
    code: "INVALID_COMPANION_PATH",
    category: "invalid_request",
    action: "Use a companion API path that starts with a single slash.",
  });
  assert.equal(fetchCalled, false);
  assert.doesNotMatch(JSON.stringify(publicCompanionError(invalidPath)), /example|private|token|secret/i);
});
