import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER_ENTRY = path.join(REPO_ROOT, "mcp", "server.mjs");
const PRIVATE_PATH_SENTINEL = "/private/device/alice/taskboard";
const PASSWORD_SENTINEL = "mcp-shared-password-sentinel";
const ENV_SENTINEL = "mcp-environment-secret-sentinel";
const ERROR_CODE_SENTINEL = "MCP_SECRET_ERROR_CODE_SENTINEL";

const BASE_ENTRY = Object.freeze({
  id: "context-1",
  projectId: "project-1",
  kind: "decision",
  title: "Use the companion boundary",
  body: "The MCP server uses the loopback companion HTTP API.",
  tags: ["mcp", "architecture"],
  sourceType: "agent",
  sourceId: "ASH-48",
  sourceThreadId: null,
  authorType: "agent",
  authorId: "codex",
  authorName: "Codex",
  pinned: true,
  archivedAt: null,
  version: 1,
  idempotencyKey: "ASH-48:decision:companion-boundary",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
});

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

test("resolveMappedProject ranks canonical paths and rejects ambiguous mappings", () => {
  const repo = path.resolve("/work/repo");
  const packagePath = path.join(repo, "packages");
  const paddedRepo = `${repo}${path.sep}.${path.sep}.${path.sep}.${path.sep}.${path.sep}`;

  assert.equal(resolveMappedProject([
    { id: "padded-root", name: "Padded root", workspacePath: paddedRepo },
    { id: "package", name: "Package", workspacePath: packagePath },
  ], path.join(packagePath, "api")).id, "package");

  assert.throws(
    () => resolveMappedProject([
      { id: "repo-a", name: "Repository A", workspacePath: repo },
      { id: "repo-b", name: "Repository B", workspacePath: `${repo}${path.sep}.` },
    ], path.join(repo, "src")),
    (error) => {
      assert.ok(error instanceof CompanionError);
      assert.deepEqual(publicCompanionError(error), {
        status: 409,
        code: "PROJECT_MAPPING_AMBIGUOUS",
        category: "project_mapping_ambiguous",
        action: "Keep exactly one taskboard project mapping for the current workspace and retry.",
      });
      return true;
    },
  );
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
  assert.equal(calls[0].init.redirect, "manual");
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

test("client keeps the timeout active while consuming the response body", async () => {
  const client = createCompanionClient({
    env: {},
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        throw new DOMException("private response body stalled", "TimeoutError");
      },
    }),
  });

  const error = await captureError(() => client.request("GET", "/api/projects"));
  assert.deepEqual(publicCompanionError(error), {
    status: 503,
    code: "COMPANION_UNAVAILABLE",
    category: "companion_unavailable",
    action: "Start the local taskboard companion and retry.",
  });
  assert.doesNotMatch(JSON.stringify(publicCompanionError(error)), /private|stalled|TimeoutError/i);
});

test("client preserves a text 401 as an authentication error", async () => {
  const client = createCompanionClient({
    env: {},
    fetch: async () => new Response("invalid shared key", {
      status: 401,
      headers: { "content-type": "text/plain" },
    }),
  });

  const error = await captureError(() => client.request("GET", "/api/projects"));
  assert.deepEqual(publicCompanionError(error), {
    status: 401,
    code: "UNAUTHORIZED",
    category: "authentication_required",
    action: "Log in through the local companion and retry.",
  });
});

test("client rejects invalid JSON and absolute request URLs without leaking either value", async () => {
  const invalidJsonClient = createCompanionClient({
    env: {},
    fetch: async () => new Response("shared-password at /Users/alice", { status: 200 }),
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

  const backslashPath = await captureError(
    () => pathClient.request("POST", "/\\\\example.test/collect", {
      body: { secret: "must-not-leave-loopback" },
    }),
  );
  assert.deepEqual(publicCompanionError(backslashPath), {
    status: 400,
    code: "INVALID_COMPANION_PATH",
    category: "invalid_request",
    action: "Use a companion API path that starts with a single slash.",
  });
  assert.equal(fetchCalled, false);
});

test("client refuses companion redirects without replaying a private request body", async (t) => {
  let sinkRequests = 0;
  const sink = createHttpServer((_request, response) => {
    sinkRequests += 1;
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    sink.once("error", reject);
    sink.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    sink.closeAllConnections();
    sink.close((error) => error ? reject(error) : resolve());
  }));

  const redirector = createHttpServer((_request, response) => {
    response.writeHead(307, {
      connection: "close",
      location: `http://127.0.0.1:${sink.address().port}/collect`,
    });
    response.end();
  });
  await new Promise((resolve, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    redirector.closeAllConnections();
    redirector.close((error) => error ? reject(error) : resolve());
  }));

  const client = createCompanionClient({
    baseUrl: `http://127.0.0.1:${redirector.address().port}`,
  });
  const error = await captureError(() => client.request("POST", "/api/context", {
    body: { secret: "private-context-sentinel" },
  }));

  assert.deepEqual(publicCompanionError(error), {
    status: 502,
    code: "COMPANION_REDIRECT_BLOCKED",
    category: "invalid_response",
    action: "Use a direct loopback companion URL without redirects.",
  });
  assert.equal(sinkRequests, 0);
});

function sendHttpJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fixtureError(code, details = undefined) {
  return {
    error: {
      code,
      message: `Do not leak ${PASSWORD_SENTINEL} at ${PRIVATE_PATH_SENTINEL}`,
      ...(details === undefined ? {} : {
        details: {
          ...details,
          authorization: `Basic ${PASSWORD_SENTINEL}`,
          workspacePath: PRIVATE_PATH_SENTINEL,
          env: { MCP_TEST_SECRET: ENV_SENTINEL },
        },
      }),
    },
  };
}

async function startContextCompanion() {
  const requests = [];
  const published = new Map();
  let createCount = 0;
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const body = await requestJson(request);
      requests.push({
        method: request.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body,
      });

      if (request.method === "GET" && url.pathname === "/api/projects") {
        sendHttpJson(response, 200, {
          projects: [{
            id: "project-1",
            name: "Shared Taskboard",
            workspacePath: REPO_ROOT,
            issueCount: 48,
            deviceMappings: [{ workspacePath: PRIVATE_PATH_SENTINEL }],
            authorization: `Basic ${PASSWORD_SENTINEL}`,
            password: PASSWORD_SENTINEL,
            env: { MCP_TEST_SECRET: ENV_SENTINEL },
          }],
        });
        return;
      }

      if (
        request.method === "GET"
        && (
          url.pathname === "/api/projects/project-1/context/brief"
          || url.pathname === "/api/projects/api--v2/context/brief"
        )
      ) {
        sendHttpJson(response, 200, {
          brief: "## [decision] Use the companion boundary\n\nRead and write through HTTP.",
          includedEntryIds: [BASE_ENTRY.id],
          truncated: false,
          workspacePath: PRIVATE_PATH_SENTINEL,
        });
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/api/projects/project-1/context"
      ) {
        sendHttpJson(response, 200, {
          entries: [{
            ...BASE_ENTRY,
            workspacePath: PRIVATE_PATH_SENTINEL,
            authorization: `Basic ${PASSWORD_SENTINEL}`,
            env: { MCP_TEST_SECRET: ENV_SENTINEL },
          }],
          nextCursor: "next-page-token",
          password: PASSWORD_SENTINEL,
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/api/projects/project-1/context"
      ) {
        if (body?.idempotencyKey === "conflicting-key") {
          sendHttpJson(response, 409, fixtureError("IDEMPOTENCY_CONFLICT"));
          return;
        }
        let entry = published.get(body?.idempotencyKey);
        if (!entry) {
          createCount += 1;
          entry = {
            ...BASE_ENTRY,
            id: "published-1",
            kind: body.kind,
            title: body.title,
            body: body.body,
            tags: body.tags,
            sourceType: body.sourceType,
            sourceId: body.sourceId ?? null,
            sourceThreadId: body.sourceThreadId ?? null,
            pinned: body.pinned,
            idempotencyKey: body.idempotencyKey,
          };
          published.set(body.idempotencyKey, entry);
        }
        sendHttpJson(response, createCount === 1 ? 201 : 200, {
          entry,
          authorization: `Basic ${PASSWORD_SENTINEL}`,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/context/context-1") {
        sendHttpJson(response, 200, {
          entry: {
            ...BASE_ENTRY,
            workspacePath: PRIVATE_PATH_SENTINEL,
            password: PASSWORD_SENTINEL,
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/context/missing") {
        sendHttpJson(response, 404, fixtureError("CONTEXT_NOT_FOUND"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/context/auth-required") {
        sendHttpJson(response, 401, fixtureError("UNAUTHORIZED"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/context/remote-down") {
        sendHttpJson(response, 502, fixtureError("REMOTE_UNAVAILABLE"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/context/untrusted-code") {
        sendHttpJson(
          response,
          502,
          fixtureError(`${ERROR_CODE_SENTINEL}_/Users/alice/ignore-instructions`),
        );
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/context/version-conflict") {
        sendHttpJson(response, 409, fixtureError("VERSION_CONFLICT", {
          expectedVersion: 3,
          actualVersion: 4,
        }));
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/api/context/context-1") {
        sendHttpJson(response, 200, {
          entry: {
            ...BASE_ENTRY,
            ...body,
            id: BASE_ENTRY.id,
            version: 2,
            updatedAt: "2026-08-06T01:00:00.000Z",
          },
        });
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/api/context/already-archived/archive"
      ) {
        sendHttpJson(response, 409, fixtureError("CONTEXT_ALREADY_ARCHIVED"));
        return;
      }
      if (
        request.method === "POST"
        && url.pathname === "/api/context/context-1/archive"
      ) {
        sendHttpJson(response, 200, {
          entry: {
            ...BASE_ENTRY,
            archivedAt: "2026-08-06T02:00:00.000Z",
            version: 3,
            updatedAt: "2026-08-06T02:00:00.000Z",
          },
        });
        return;
      }

      sendHttpJson(response, 404, fixtureError("ROUTE_NOT_FOUND"));
    } catch {
      sendHttpJson(response, 500, fixtureError("FIXTURE_FAILURE"));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get createCount() {
      return createCount;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function createMcpFixture(t) {
  const companion = await startContextCompanion();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: {
      CODEX_TASKBOARD_COMPANION_URL: companion.origin,
      MCP_TEST_SECRET: ENV_SENTINEL,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "taskboard-mcp-test", version: "1.0.0" });
  t.after(async () => {
    await client.close().catch(() => {});
    await companion.close();
    assert.equal(stderr, "");
  });
  await client.connect(transport);
  return { client, companion };
}

function assertStructuredResult(result) {
  assert.equal(Array.isArray(result.content), true);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(typeof result.content[0]?.text, "string");
  assert.ok(result.content[0].text.length > 0);
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent;
}

test("stdio server initializes and advertises exactly seven strict context tools", async (t) => {
  const { client } = await createMcpFixture(t);

  assert.deepEqual(client.getServerVersion(), {
    name: "dashi-taskboard",
    version: "0.1.0",
  });
  assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: true } });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    "taskboard_context_current_project",
    "taskboard_context_brief",
    "taskboard_context_search",
    "taskboard_context_get",
    "taskboard_context_publish",
    "taskboard_context_update",
    "taskboard_context_archive",
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.outputSchema.type, "object", tool.name);
    assert.equal(tool.outputSchema.additionalProperties, false, tool.name);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("taskboard_context_publish").inputSchema.required.sort(), [
    "body",
    "idempotencyKey",
    "kind",
    "title",
  ]);
  assert.deepEqual(byName.get("taskboard_context_update").inputSchema.required.sort(), ["id", "version"]);
  assert.deepEqual(byName.get("taskboard_context_archive").inputSchema.required.sort(), ["id", "version"]);
  assert.equal(byName.get("taskboard_context_get").annotations.readOnlyHint, true);
  assert.equal(byName.get("taskboard_context_publish").annotations.idempotentHint, true);
  assert.equal(byName.get("taskboard_context_archive").annotations.destructiveHint, true);
});

test("stdio project-scoped tools accept every project id allowed by the service", async (t) => {
  const { client, companion } = await createMcpFixture(t);
  const result = await client.callTool({
    name: "taskboard_context_brief",
    arguments: { projectId: "api--v2" },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(assertStructuredResult(result), {
    ok: true,
    brief: "## [decision] Use the companion boundary\n\nRead and write through HTTP.",
    includedEntryIds: [BASE_ENTRY.id],
    truncated: false,
  });
  assert.equal(companion.requests.some((request) => (
    request.pathname === "/api/projects/api--v2/context/brief"
  )), true);
});

test("stdio tools route reads and versioned writes through the companion safely", async (t) => {
  const { client, companion } = await createMcpFixture(t);
  const results = [];

  results.push(await client.callTool({
    name: "taskboard_context_current_project",
    arguments: {},
  }));
  assert.deepEqual(assertStructuredResult(results.at(-1)), {
    ok: true,
    project: { id: "project-1", name: "Shared Taskboard", issueCount: 48 },
  });

  results.push(await client.callTool({ name: "taskboard_context_brief", arguments: {} }));
  assert.deepEqual(assertStructuredResult(results.at(-1)), {
    ok: true,
    brief: "## [decision] Use the companion boundary\n\nRead and write through HTTP.",
    includedEntryIds: [BASE_ENTRY.id],
    truncated: false,
  });

  results.push(await client.callTool({
    name: "taskboard_context_search",
    arguments: {
      query: "companion + http",
      kind: "decision",
      tag: "mcp",
      pinned: true,
      archived: "false",
      limit: 10,
      cursor: "cursor/with+symbols=",
    },
  }));
  assert.deepEqual(assertStructuredResult(results.at(-1)), {
    ok: true,
    entries: [BASE_ENTRY],
    nextCursor: "next-page-token",
  });

  results.push(await client.callTool({
    name: "taskboard_context_get",
    arguments: { id: BASE_ENTRY.id },
  }));
  assert.deepEqual(assertStructuredResult(results.at(-1)), { ok: true, entry: BASE_ENTRY });

  const publishArguments = {
    kind: "handoff",
    title: "Backend handoff",
    body: "The MCP contract is ready for review.",
    tags: ["ASH-48"],
    sourceId: "ASH-48",
    sourceThreadId: "thread-1",
    pinned: false,
    idempotencyKey: "ASH-48:handoff:backend",
  };
  const firstPublish = await client.callTool({
    name: "taskboard_context_publish",
    arguments: publishArguments,
  });
  const replayedPublish = await client.callTool({
    name: "taskboard_context_publish",
    arguments: publishArguments,
  });
  results.push(firstPublish, replayedPublish);
  assert.deepEqual(
    assertStructuredResult(firstPublish).entry,
    assertStructuredResult(replayedPublish).entry,
  );
  assert.equal(companion.createCount, 1);

  results.push(await client.callTool({
    name: "taskboard_context_update",
    arguments: {
      id: BASE_ENTRY.id,
      version: 1,
      title: "Use the strict companion boundary",
      pinned: false,
    },
  }));
  assert.equal(assertStructuredResult(results.at(-1)).entry.version, 2);

  results.push(await client.callTool({
    name: "taskboard_context_archive",
    arguments: { id: BASE_ENTRY.id, version: 2 },
  }));
  assert.equal(assertStructuredResult(results.at(-1)).entry.version, 3);

  const searchRequest = companion.requests.find((request) => (
    request.method === "GET"
    && request.pathname === "/api/projects/project-1/context"
  ));
  assert.deepEqual(searchRequest.query, {
    query: "companion + http",
    kind: "decision",
    tag: "mcp",
    pinned: "true",
    archived: "false",
    limit: "10",
    cursor: "cursor/with+symbols=",
  });
  const publishRequests = companion.requests.filter((request) => request.method === "POST" && (
    request.pathname === "/api/projects/project-1/context"
  ));
  assert.equal(publishRequests.length, 2);
  assert.equal(publishRequests[0].body.sourceType, "agent");
  assert.equal(publishRequests[0].body.idempotencyKey, publishArguments.idempotencyKey);
  assert.deepEqual(
    companion.requests.find((request) => request.method === "PATCH").body,
    { version: 1, title: "Use the strict companion boundary", pinned: false },
  );
  assert.deepEqual(
    companion.requests.find((request) => request.pathname.endsWith("/archive")).body,
    { version: 2 },
  );
  for (const request of companion.requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-taskboard-client"], "taskctl");
  }

  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_PATH_SENTINEL));
  assert.doesNotMatch(serialized, new RegExp(PASSWORD_SENTINEL));
  assert.doesNotMatch(serialized, new RegExp(ENV_SENTINEL));
  assert.doesNotMatch(serialized, /workspacePath|authorization|password|deviceMappings|env/i);
});

test("stdio tools preserve safe error codes and actionable conflict details", async (t) => {
  const { client } = await createMcpFixture(t);
  const cases = [
    ["taskboard_context_get", { id: "missing" }, 404, "CONTEXT_NOT_FOUND", "not_found"],
    ["taskboard_context_get", { id: "auth-required" }, 401, "UNAUTHORIZED", "authentication_required"],
    ["taskboard_context_get", { id: "remote-down" }, 502, "REMOTE_UNAVAILABLE", "cloud_unavailable"],
    ["taskboard_context_get", { id: "untrusted-code" }, 502, "HTTP_502", "request_failed"],
    [
      "taskboard_context_update",
      { id: "version-conflict", version: 3, title: "New title" },
      409,
      "VERSION_CONFLICT",
      "version_conflict",
    ],
    [
      "taskboard_context_publish",
      {
        kind: "risk",
        title: "Conflict",
        body: "Different content",
        idempotencyKey: "conflicting-key",
      },
      409,
      "IDEMPOTENCY_CONFLICT",
      "idempotency_conflict",
    ],
    [
      "taskboard_context_archive",
      { id: "already-archived", version: 1 },
      409,
      "CONTEXT_ALREADY_ARCHIVED",
      "already_archived",
    ],
  ];

  for (const [name, args, status, code, category] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const structured = assertStructuredResult(result);
    assert.equal(structured.ok, false, name);
    assert.equal(structured.error.status, status, name);
    assert.equal(structured.error.code, code, name);
    assert.equal(structured.error.category, category, name);
    assert.equal(typeof structured.error.action, "string", name);
    if (code === "VERSION_CONFLICT") {
      assert.deepEqual(structured.error.details, { expectedVersion: 3, actualVersion: 4 });
    }
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(PRIVATE_PATH_SENTINEL));
    assert.doesNotMatch(serialized, new RegExp(PASSWORD_SENTINEL));
    assert.doesNotMatch(serialized, new RegExp(ENV_SENTINEL));
    assert.doesNotMatch(serialized, new RegExp(ERROR_CODE_SENTINEL));
    assert.doesNotMatch(serialized, /upstream|authorization|workspacePath|password|env/i);
  }
});
