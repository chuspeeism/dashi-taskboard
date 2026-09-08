import { DEFAULT_PROJECT_ID, isTaskStatus } from "./domain.mjs";
import {
  ApiError, assertPlainObject, assertAllowedKeys, stringField,
  parseVersion, validateProjectId, parseThreadId, parseAssigneeTarget,
  parseRelationOrigin, parseStatus, parsePriority, parseLabels,
  parseSortOrder, parseDueDate, parseRecurrence,
} from "./api-fields.mjs";

export function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.codexProjectKind must be local or remote");
  }
  if (
    (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

export function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

export function parseVersionMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

export function parseRelationMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding", "origin"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    origin: parseRelationOrigin(body.origin),
  };
}

export function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

export function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

export function parseTaskCreate(body, parseDevelopmentContext) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

// Local and cloud entry points retain their existing validation order and errors.
function assertTaskPatchBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "projectId", "title", "description", "status", "priority", "labels", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
}

function parseTaskPatchChanges(body, parseDevelopmentContext) {
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  return changes;
}

function assertTaskPatchFields(changes, assigneeTarget) {
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
}

export function parseTaskPatch(body, parseDevelopmentContext) {
  assertTaskPatchBody(body);
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const threadBinding = parseThreadBinding(body.threadBinding);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = parseTaskPatchChanges(body, parseDevelopmentContext);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  assertTaskPatchFields(changes, assigneeTarget);
  return { version, changes, threadId, threadBinding, assigneeTarget };
}

export function parseCloudTaskPatch(body, parseDevelopmentContext) {
  assertTaskPatchBody(body);
  const changes = parseTaskPatchChanges(body, parseDevelopmentContext);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  assertTaskPatchFields(changes, assigneeTarget);
  return {
    version: parseVersion(body.version),
    changes,
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget,
  };
}

function assertTaskQueryParameters(searchParams, allowed, repeatedCode, cloud = false) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", cloud
        ? `Unknown query parameter: ${key}`
        : `Unknown query parameter '${key}'`);
    }
    const count = searchParams.getAll(key).length;
    if (cloud ? count > 1 : count !== 1) {
      throw new ApiError(400, repeatedCode, cloud
        ? `'${key}' cannot be repeated`
        : `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function taskFilterValues(searchParams) {
  return {
    projectId: searchParams.get("projectId"),
    status: searchParams.get("status"),
    archived: searchParams.get("archived") ?? "false",
  };
}

export function parseTaskFilters(searchParams) {
  assertTaskQueryParameters(
    searchParams, new Set(["projectId", "status", "archived"]), "INVALID_QUERY_PARAMETER",
  );

  const { projectId: projectIdValue, status: statusValue, archived } = taskFilterValues(searchParams);
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

export function parseCloudTaskFilters(searchParams) {
  assertTaskQueryParameters(
    searchParams, new Set(["projectId", "status", "archived"]), "INVALID_QUERY_PARAMETER", true,
  );
  const { projectId, status, archived } = taskFilterValues(searchParams);
  if (projectId !== null) validateProjectId(projectId);
  if (status !== null) parseStatus(status);
  if (!["false", "true", "all"].includes(archived)) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETER",
      "'archived' must be false, true, or all",
    );
  }
  return { projectId, status, archived };
}

function taskTreeQueryValues(searchParams) {
  const direction = searchParams.get("direction");
  if (direction !== "descendants" && direction !== "ancestors") {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'direction' must be descendants or ancestors");
  }
  const rawDepth = searchParams.get("depth");
  const depth = Number(rawDepth);
  if (!/^\d+$/.test(rawDepth ?? "") || !Number.isSafeInteger(depth) || depth < 1 || depth > 25) {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'depth' must be an integer from 1 to 25");
  }
  return { direction, depth };
}

export function parseTaskTreeQuery(searchParams) {
  assertTaskQueryParameters(searchParams, new Set(["direction", "depth"]), "INVALID_TREE_QUERY");
  return taskTreeQueryValues(searchParams);
}

export function parseCloudTaskTreeQuery(searchParams) {
  assertTaskQueryParameters(searchParams, new Set(["direction", "depth"]), "INVALID_TREE_QUERY", true);
  return taskTreeQueryValues(searchParams);
}

function projectReadmeContent(value) {
  const content = value ?? "";
  if (typeof content !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "'content' must be a string");
  }
  if (content.length > 500_000) {
    throw new ApiError(400, "INVALID_FIELD", "'content' cannot exceed 500000 characters");
  }
  return content;
}

export function parseProjectReadmeSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["content", "version"]));
  const content = projectReadmeContent(body.content);
  const version = body.version === undefined ? undefined : parseVersion(body.version, { allowZero: true });
  return { content, version };
}

export function parseCloudProjectReadmeSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "content"]));
  const version = body.version === undefined ? undefined : parseVersion(body.version, { allowZero: true });
  const content = projectReadmeContent(body.content);
  return { content, version };
}
