import path from "node:path";

const DEFAULT_COMPANION_URL = "http://127.0.0.1:47823";
const DEFAULT_TIMEOUT_MS = 10_000;
const PUBLIC_PROJECT_FIELDS = ["id", "name", "createdAt", "updatedAt", "issueCount"];

const ERROR_GUIDANCE = new Map([
  ["INVALID_COMPANION_URL", ["invalid_configuration", "Set the companion URL to a loopback HTTP or HTTPS origin."]],
  ["INVALID_COMPANION_PATH", ["invalid_request", "Use a companion API path that starts with a single slash."]],
  ["INVALID_COMPANION_RESPONSE", ["invalid_response", "Restart or update the local taskboard companion and retry."]],
  ["PROJECT_MAPPING_NOT_FOUND", ["project_not_mapped", "Map the current workspace to a taskboard project and retry."]],
  ["UNAUTHORIZED", ["authentication_required", "Log in through the local companion and retry."]],
  ["VERSION_CONFLICT", ["version_conflict", "Reload the context entry, then retry with its current version."]],
  ["CONTEXT_VERSION_CONFLICT", ["version_conflict", "Reload the context entry, then retry with its current version."]],
  ["IDEMPOTENCY_CONFLICT", ["idempotency_conflict", "Reuse the original content or choose a new idempotency key."]],
  ["CONTEXT_IDEMPOTENCY_CONFLICT", ["idempotency_conflict", "Reuse the original content or choose a new idempotency key."]],
  ["CONTEXT_ALREADY_ARCHIVED", ["already_archived", "Reload the context entry; it is already archived."]],
  ["CONTEXT_NOT_ARCHIVED", ["not_archived", "Reload the context entry; only archived entries can be restored."]],
  ["CLOUD_NOT_CONFIGURED", ["cloud_not_configured", "Configure cloud collaboration in the local companion and retry."]],
  ["SERVER_MISCONFIGURED", ["server_misconfigured", "Ask the taskboard administrator to check the server configuration."]],
  ["REMOTE_UNAVAILABLE", ["cloud_unavailable", "Check the cloud taskboard connection and retry."]],
  ["COMPANION_UNAVAILABLE", ["companion_unavailable", "Start the local taskboard companion and retry."]],
]);

export class CompanionError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "CompanionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function publicCompanionError(error) {
  const normalized = error instanceof CompanionError
    ? error
    : new CompanionError(500, "INTERNAL_ERROR", "Unexpected companion client failure");
  const fallback = normalized.status === 400
    ? ["invalid_request", "Check the tool arguments and retry."]
    : normalized.status === 404
      ? ["not_found", "Refresh the project or context entry identifier and retry."]
      : normalized.status === 409
        ? ["conflict", "Reload the affected context and retry."]
        : ["request_failed", "Check the taskboard service status and retry."];
  const [category, action] = ERROR_GUIDANCE.get(normalized.code) ?? fallback;
  const details = {};
  for (const field of ["expectedVersion", "actualVersion"]) {
    if (Number.isSafeInteger(normalized.details?.[field])) {
      details[field] = normalized.details[field];
    }
  }
  return {
    status: normalized.status,
    code: normalized.code,
    category,
    action,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

export function resolveCompanionUrl(env = process.env) {
  const rawUrl = env.CODEX_TASKBOARD_COMPANION_URL
    ?? env.CODEX_TASKBOARD_URL
    ?? DEFAULT_COMPANION_URL;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidCompanionUrl();
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "[::1]"
    || isIpv4Loopback(url.hostname);
  if (
    !loopback
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw invalidCompanionUrl();
  }
  return url.origin;
}

function isIpv4Loopback(hostname) {
  if (!/^127(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  return hostname.split(".").every((part) => Number(part) <= 255);
}

function invalidCompanionUrl() {
  return new CompanionError(
    400,
    "INVALID_COMPANION_URL",
    "Local companion URL is invalid",
  );
}

export function workspaceContains(workspacePath, cwd) {
  if (!path.isAbsolute(workspacePath ?? "") || !path.isAbsolute(cwd ?? "")) return false;
  const relative = path.relative(path.resolve(workspacePath), path.resolve(cwd));
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveMappedProject(projects, cwd) {
  if (!Array.isArray(projects) || !path.isAbsolute(cwd ?? "")) return null;
  const matches = projects
    .filter((project) => workspaceContains(project?.workspacePath, cwd))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  return matches[0] ?? null;
}

export function publicProject(project) {
  if (!project || typeof project !== "object") return null;
  const result = {};
  for (const field of PUBLIC_PROJECT_FIELDS) {
    if (project[field] !== undefined) result[field] = project[field];
  }
  return typeof result.id === "string" && typeof result.name === "string" ? result : null;
}

function requestPath(pathOrSegments) {
  if (Array.isArray(pathOrSegments)) {
    if (pathOrSegments.length === 0 || pathOrSegments.some((part) => typeof part !== "string" || part.length === 0)) {
      throw invalidCompanionPath();
    }
    return `/${pathOrSegments.map((part) => encodeURIComponent(part)).join("/")}`;
  }
  if (
    typeof pathOrSegments !== "string"
    || !pathOrSegments.startsWith("/")
    || pathOrSegments.startsWith("//")
  ) {
    throw invalidCompanionPath();
  }
  return pathOrSegments;
}

function invalidCompanionPath() {
  return new CompanionError(
    400,
    "INVALID_COMPANION_PATH",
    "Companion API path is invalid",
  );
}

function appendQuery(url, query) {
  if (query === undefined) return;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw invalidCompanionPath();
  }
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.append(name, String(value));
  }
}

export function createCompanionClient({
  baseUrl,
  env = process.env,
  cwd = process.cwd(),
  fetch: fetchImplementation = globalThis.fetch,
  createTimeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const origin = baseUrl === undefined
    ? resolveCompanionUrl(env)
    : resolveCompanionUrl({ CODEX_TASKBOARD_COMPANION_URL: baseUrl });
  if (typeof fetchImplementation !== "function") {
    throw new Error("fetch is not available");
  }
  if (typeof createTimeoutSignal !== "function") {
    throw new Error("createTimeoutSignal must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }

  async function request(method, pathOrSegments, options = {}) {
    const pathname = requestPath(pathOrSegments);
    const url = new URL(pathname, `${origin}/`);
    appendQuery(url, options.query);
    const hasBody = Object.hasOwn(options, "body") && options.body !== undefined;
    let response;
    try {
      response = await fetchImplementation(url, {
        method,
        headers: {
          accept: "application/json",
          "x-taskboard-client": "taskctl",
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        signal: createTimeoutSignal(timeoutMs),
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      throw new CompanionError(
        503,
        "COMPANION_UNAVAILABLE",
        "Local taskboard companion is unavailable",
      );
    }

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new CompanionError(
          502,
          "INVALID_COMPANION_RESPONSE",
          "Local taskboard companion returned invalid JSON",
        );
      }
    }
    if (!response.ok) {
      throw new CompanionError(
        response.status,
        typeof payload?.error?.code === "string" ? payload.error.code : `HTTP_${response.status}`,
        "Taskboard companion request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  return {
    request,
    async currentProject(requestCwd = cwd) {
      const payload = await request("GET", "/api/projects");
      if (!Array.isArray(payload.projects)) {
        throw new CompanionError(
          502,
          "INVALID_COMPANION_RESPONSE",
          "Local taskboard companion returned an invalid project list",
        );
      }
      const project = publicProject(resolveMappedProject(payload.projects, requestCwd));
      if (!project) {
        throw new CompanionError(
          404,
          "PROJECT_MAPPING_NOT_FOUND",
          "Current workspace has no taskboard project mapping",
        );
      }
      return project;
    },
  };
}
