import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { ApiError } from "../shared/api-fields.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TASK_ID = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z0-9]{1,16}-[0-9]{1,12})$/i;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const contexts = new WeakMap();
const STATIC_ROUTES = new Set([
  "/health", "/api/tasks", "/api/projects", "/api/meta", "/api/events",
  "/api/device-workspaces", "/api/client-storage", "/api/local/cloud-session",
  "/api/local/host-runtime", "/api/local/codex-thread-progress", "/api/local/jira-connection",
  "/api/local/request-logs",
]);

function uuid(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

// Only known route literals and validated task identifiers survive. Never store raw URLs.
function routeInfo(requestUrl, prefix) {
  let pathname;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return { route: "unmatched", taskId: null };
  }
  if (prefix) {
    if (!pathname.startsWith(`${prefix}/`)) {
      return { route: pathname === "/health" ? "/health" : "unmatched", taskId: null };
    }
    pathname = pathname.slice(prefix.length);
  }
  if (STATIC_ROUTES.has(pathname)) return { route: pathname, taskId: null };
  const task = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(move|archive|restore|activities|comments|attachments|tree))?$/);
  const relation = pathname.match(/^\/api\/tasks\/([^/]+)\/relations\/[^/]+\/[^/]+$/);
  if (task || relation) {
    let id;
    try { id = decodeURIComponent((task ?? relation)[1]); } catch {}
    return {
      route: relation ? "/api/tasks/:taskId/relations/:type/:otherId"
        : `/api/tasks/:taskId${task[2] ? `/${task[2]}` : ""}`,
      taskId: typeof id === "string" && TASK_ID.test(id) ? id : null,
    };
  }
  if (/^\/api\/comments\/[^/]+(?:\/attachments)?$/.test(pathname)) {
    return { route: `/api/comments/:commentId${pathname.endsWith("/attachments") ? "/attachments" : ""}`, taskId: null };
  }
  const attachment = pathname.match(/^\/api\/attachments\/[^/]+\/(content|download)$/);
  if (attachment) return { route: `/api/attachments/:attachmentId/${attachment[1]}`, taskId: null };
  const project = pathname.match(/^\/api\/projects\/[^/]+(?:\/(readme|development-contexts|summary))?$/);
  if (project) return { route: `/api/projects/:projectId${project[1] ? `/${project[1]}` : ""}`, taskId: null };
  return { route: "unmatched", taskId: null };
}

export function markRequestLogResponse(response, value) {
  const context = contexts.get(response);
  if (!context) return;
  const code = value?.error?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) context.errorCode = code;
  const taskId = value?.task?.id ?? value?.comment?.taskId;
  if (!context.taskId && typeof taskId === "string" && TASK_ID.test(taskId)) context.taskId = taskId;
}

export function createRequestLog(dataDirectory) {
  const directory = path.join(dataDirectory, "logs");
  const file = path.join(directory, "api-requests.jsonl");
  let pending = Promise.resolve();
  let ready = false;
  let writeFailures = 0;

  function append(record) {
    const line = `${JSON.stringify(record)}\n`;
    pending = pending.then(async () => {
      if (!ready) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        ready = true;
      }
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    }).catch(() => {
      writeFailures += 1;
      // Do not send request data or the original error (which can contain paths) to stderr.
      if (writeFailures === 1) console.error("Taskboard request log write failed; log coverage is incomplete.");
    });
  }

  return {
    begin(request, response, prefix) {
      const started = performance.now();
      const context = {
        requestId: randomUUID(),
        clientRequestId: uuid(request.headers["x-taskboard-request-id"]),
        method: METHODS.has(request.method) ? request.method : "OTHER",
        ...routeInfo(request.url, prefix),
        source: {
          attribution: "self_reported",
          client: request.headers["x-taskboard-client"] === "taskctl" ? "taskctl" : "other",
          threadId: uuid(request.headers["x-taskboard-source-thread"]),
        },
      };
      contexts.set(response, context);
      response.setHeader("x-taskboard-request-id", context.requestId);
      append({ ...context, event: "received", time: new Date().toISOString() });
      let ended = false;
      const finish = (event) => {
        if (ended) return;
        ended = true;
        const status = response.headersSent ? response.statusCode : null;
        append({
          ...context,
          event,
          time: new Date().toISOString(),
          status,
          result: event === "aborted" ? "aborted" : status >= 400 ? "rejected" : "success",
          errorCode: context.errorCode ?? null,
          durationMs: Number((performance.now() - started).toFixed(3)),
        });
      };
      response.once("finish", () => finish("completed"));
      response.once("close", () => finish("aborted"));
    },
    async flush() { await pending; },
    async read(searchParams) {
      const allowed = new Set(["limit", "sourceThreadId", "taskId", "requestId", "view"]);
      if ([...searchParams.keys()].some((key) => !allowed.has(key))) {
        throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Unsupported request log filter");
      }
      const limit = Number(searchParams.get("limit") ?? 200);
      const sourceThreadId = searchParams.get("sourceThreadId");
      const taskId = searchParams.get("taskId");
      const requestId = searchParams.get("requestId");
      const view = searchParams.get("view") ?? "list";
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000
        || (sourceThreadId !== null && !uuid(sourceThreadId))
        || (requestId !== null && !uuid(requestId))
        || (taskId !== null && !TASK_ID.test(taskId))
        || !["list", "analysis"].includes(view)) {
        throw new ApiError(400, "INVALID_FIELD", "Invalid request log filter");
      }
      await pending;
      const records = [];
      let truncated = false;
      let unreadableRecords = 0;
      try {
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
          let record;
          try { record = JSON.parse(line); } catch { unreadableRecords += 1; continue; }
          if (sourceThreadId && record.source?.threadId !== uuid(sourceThreadId)) continue;
          if (taskId && record.taskId !== taskId) continue;
          if (requestId && record.requestId !== uuid(requestId) && record.clientRequestId !== uuid(requestId)) continue;
          records.push(record);
          if (records.length > limit) { records.shift(); truncated = true; }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw new ApiError(503, "REQUEST_LOG_UNAVAILABLE", "Request log cannot be read");
      }
      const coverage = {
        scope: "this_local_http_service",
        attribution: "self_reported_not_authenticated",
        truncated, writeFailures, unreadableRecords,
        readAt: new Date().toISOString(),
        absenceIsNotProofOfNoRequest: true,
      };
      if (view === "list") return { records, coverage };
      const requests = new Map();
      for (const record of records) {
        const entry = requests.get(record.requestId) ?? { received: false, terminal: null };
        if (record.event === "received") entry.received = true;
        else entry.terminal = record;
        entry.source = record.source;
        requests.set(record.requestId, entry);
      }
      const sources = new Map();
      for (const entry of requests.values()) {
        const key = `${entry.source.client}:${entry.source.threadId ?? "unattributed"}`;
        const group = sources.get(key) ?? {
          source: entry.source, requests: 0, success: 0, rejected: 0, aborted: 0, noTerminalRecord: 0,
        };
        group.requests += 1;
        if (entry.terminal) group[entry.terminal.result] += 1;
        else group.noTerminalRecord += 1;
        sources.set(key, group);
      }
      return {
        sources: [...sources.values()], coverage,
        interpretation: "A matching server record proves arrival here. Success/rejected describe HTTP results, not correct business fields or user acceptance. No matching record does not prove no attempt or no arrival; correlate the CLI clientRequestId and delivery report. A received-only record has no terminal result in this window.",
      };
    },
  };
}
