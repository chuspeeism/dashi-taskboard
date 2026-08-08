import {
  canonicalJson,
  hashCanonicalJson,
  parseFeishuBaseExternalKey,
} from "./contracts.mjs";

export const MIRROR_SCHEMA_VERSION = "taskboard-feishu-write.v1";
export const MIRROR_MAPPING_VERSION = "v1";
export const MIRROR_OPERATIONS = Object.freeze(["mirror_task", "promote_idea"]);

export const TASKBOARD_TO_FEISHU_STATUS = Object.freeze({
  backlog: "待评估",
  todo: "方案设计中",
  in_progress: "开发交付中",
  in_review: "验收中",
  pending_retrospective: "已完成",
  done: "已完成",
  blocked: "进行中",
  canceled: "待评估",
});

export const TASKBOARD_TO_FEISHU_PRIORITY = Object.freeze({
  urgent: "高 - P0",
  high: "高 - P0",
  medium: "中 - P1",
  low: "低 - P2",
  none: "低 - P2",
});

const DEFAULT_TASKBOARD_BASE_URL = "http://127.0.0.1:47823";

export class TaskboardMirrorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TaskboardMirrorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class InvalidPromotionTransitionError extends TaskboardMirrorError {
  constructor(message = "Product-idea promotion requires a backlog to todo transition", details = undefined) {
    super("INVALID_PROMOTION_TRANSITION", message, details);
    this.name = "InvalidPromotionTransitionError";
  }
}

export const InvalidPromotionTransition = InvalidPromotionTransitionError;

export class AlreadyPromotedError extends TaskboardMirrorError {
  constructor(message = "The Taskboard task is already linked to a formal requirement", details = undefined) {
    super("ALREADY_PROMOTED", message, details);
    this.name = "AlreadyPromotedError";
  }
}

export class NoOutboundChangeError extends TaskboardMirrorError {
  constructor(message = "The Taskboard version already has an immutable outbound package", details = undefined) {
    super("NO_OUTBOUND_CHANGE", message, details);
    this.name = "NoOutboundChangeError";
  }
}

export const NoOutboundChange = NoOutboundChangeError;

export class FeishuChangePendingError extends TaskboardMirrorError {
  constructor(message = "The Base side changed and must be reconciled before mirroring", details = undefined) {
    super("BASE_CHANGE_PENDING", message, details);
    this.name = "FeishuChangePendingError";
  }
}

export const FeishuChangePending = FeishuChangePendingError;

export class MirrorConflictError extends TaskboardMirrorError {
  constructor(conflict, message = undefined) {
    const externalKey = conflict?.externalKey ?? "unknown external key";
    super(
      "MIRROR_CONFLICT",
      message ?? `Outbound mirroring is blocked by an unresolved conflict for ${externalKey}`,
      { conflict },
    );
    this.name = "MirrorConflictError";
    this.conflict = conflict;
  }
}

export class InvalidMirrorPackageError extends TaskboardMirrorError {
  constructor(message, details = undefined) {
    super("INVALID_MIRROR_PACKAGE", message, details);
    this.name = "InvalidMirrorPackageError";
  }
}

function fail(code, message, details = undefined) {
  throw new TaskboardMirrorError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSafe(value, seen = new Set()) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return null;
  if (seen.has(value)) fail("INVALID_JSON_VALUE", "Mirror data contains a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
    if (!isPlainObject(value)) fail("INVALID_JSON_VALUE", "Mirror data must contain plain JSON objects");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, seen)]));
  } finally {
    seen.delete(value);
  }
}

export function cloneMirrorJson(value) {
  return JSON.parse(canonicalJson(jsonSafe(value)));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function immutableMirrorJson(value) {
  return deepFreeze(cloneMirrorJson(value));
}

function requiredString(value, label, { allowTrim = false, maxLength = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_MIRROR_VALUE", `${label} must be a non-empty string`);
  }
  if (value.includes("\0")) fail("INVALID_MIRROR_VALUE", `${label} contains an invalid character`);
  if (!allowTrim && value !== value.trim()) {
    fail("INVALID_MIRROR_VALUE", `${label} contains unsupported surrounding whitespace`);
  }
  return allowTrim ? value.trim() : value;
}

function optionalString(value, label, { maxLength = 4096 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, { maxLength });
}

function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail("INVALID_MIRROR_VALUE", `${label} must be a positive integer`);
  }
  return value;
}

function normalizeTimestamp(value, label = "generatedAt") {
  const timestampValue = value instanceof Date ? value.toISOString() : value;
  const timestamp = requiredString(timestampValue ?? new Date().toISOString(), label, { maxLength: 128 });
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp)) {
    fail("INVALID_TIMESTAMP", `${label} must be a timezone-aware ISO-8601 timestamp`);
  }
  return timestamp;
}

function milliseconds(timestamp) {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) fail("INVALID_TIMESTAMP", "generatedAt cannot be converted to milliseconds");
  return Math.trunc(value);
}

function validatedUrl(value, label) {
  const normalized = requiredString(value, label, { maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail("INVALID_MIRROR_URL", `${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    fail("INVALID_MIRROR_URL", `${label} must be an absolute HTTP(S) URL`);
  }
  return normalized;
}

function optionalUrl(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return validatedUrl(value, label);
}

function recordTargetFromLink(link, { allowMissingRecord = false } = {}) {
  const externalKey = requiredString(link?.externalKey ?? link?.external_key, "externalKey", { maxLength: 4096 });
  let identity;
  try {
    identity = parseFeishuBaseExternalKey(externalKey);
  } catch (error) {
    fail("INVALID_EXTERNAL_KEY", error?.message ?? "externalKey is not canonical", {
      cause: error?.code ?? "INVALID_EXTERNAL_KEY",
    });
  }
  const recordId = link?.recordId ?? link?.record_id ?? identity.recordId;
  if (!allowMissingRecord && recordId !== identity.recordId) {
    fail("EXTERNAL_KEY_RECORD_MISMATCH", "recordId does not match externalKey");
  }
  if (allowMissingRecord && recordId !== null && recordId !== undefined && recordId !== identity.recordId) {
    fail("EXTERNAL_KEY_RECORD_MISMATCH", "recordId does not match externalKey");
  }
  return {
    appToken: identity.appToken,
    tableId: identity.tableId,
    recordId: allowMissingRecord ? (recordId ?? null) : identity.recordId,
  };
}

export function normalizeTask(task) {
  if (!isPlainObject(task)) fail("INVALID_TASK", "task must be a plain object");
  const id = requiredString(task.id ?? task.taskId, "task.id", { maxLength: 256 });
  const projectId = requiredString(task.projectId ?? task.project_id, "task.projectId", { maxLength: 256 });
  const title = requiredString(task.title, "task.title", { maxLength: 65_536 });
  const description = task.description === null || task.description === undefined ? "" : task.description;
  if (typeof description !== "string") fail("INVALID_TASK", "task.description must be a string or null");
  const priority = requiredString(task.priority, "task.priority", { maxLength: 64 });
  const status = requiredString(task.status, "task.status", { maxLength: 64 });
  const version = positiveInteger(task.version, "task.version");
  const labels = task.labels === undefined || task.labels === null ? [] : task.labels;
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    fail("INVALID_TASK", "task.labels must be an array of strings");
  }
  const threadId = optionalString(task.threadId ?? task.thread_id, "task.threadId", { maxLength: 512 });
  const codexThreadId = optionalString(
    task.codexThreadId ?? task.codex_thread_id,
    "task.codexThreadId",
    { maxLength: 512 },
  );
  const aiThreadId = optionalString(task.aiThreadId ?? task.ai_thread_id, "task.aiThreadId", { maxLength: 512 });
  const developmentContext = task.developmentContext === undefined || task.developmentContext === null
    ? null
    : cloneMirrorJson(task.developmentContext);
  const prUrl = optionalUrl(
    task.prUrl ?? task.prURL ?? task.pullRequestUrl ?? task.pull_request_url,
    "task.prUrl",
  );
  const comments = task.comments === undefined || task.comments === null ? [] : cloneMirrorJson(task.comments);
  const attachments = task.attachments === undefined || task.attachments === null
    ? []
    : cloneMirrorJson(task.attachments);
  const relations = task.relations === undefined || task.relations === null
    ? { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] }
    : cloneMirrorJson(task.relations);
  const previousIdentifiers = task.previousIdentifiers === undefined || task.previousIdentifiers === null
    ? []
    : cloneMirrorJson(task.previousIdentifiers);
  if (!Array.isArray(previousIdentifiers) || previousIdentifiers.some((entry) => typeof entry !== "string")) {
    fail("INVALID_TASK", "task.previousIdentifiers must be an array of strings");
  }
  const assignee = task.assignee === undefined || task.assignee === null ? null : cloneMirrorJson(task.assignee);
  const projectName = optionalString(
    task.projectName ?? task.project?.name ?? task.project_name,
    "task.projectName",
    { maxLength: 512 },
  );
  const updatedAt = optionalString(task.updatedAt ?? task.updated_at, "task.updatedAt", { maxLength: 128 });
  const createdAt = optionalString(task.createdAt ?? task.created_at, "task.createdAt", { maxLength: 128 });
  const reconciliationError = optionalString(
    task.reconciliationError ?? task.reconciliation?.error ?? task.reconciliation_error,
    "task.reconciliationError",
    { maxLength: 65_536 },
  );

  return {
    id,
    identifier: optionalString(task.identifier, "task.identifier", { maxLength: 256 }),
    previousIdentifiers,
    projectId,
    projectName,
    title,
    description,
    status,
    priority,
    labels: cloneMirrorJson(labels),
    assignee,
    version,
    updatedAt,
    createdAt,
    developmentContext,
    prUrl,
    threadId,
    codexThreadId,
    aiThreadId,
    comments,
    attachments,
    relations,
    reconciliationError,
  };
}

function developmentBranch(context) {
  if (!isPlainObject(context)) return null;
  return optionalString(context.branch, "developmentContext.branch", { maxLength: 1024 });
}

function resolveProjectName(task, projectName) {
  const value = projectName
    ?? task.projectName
    ?? (typeof task.project?.name === "string" ? task.project.name : null)
    ?? task.projectId;
  return requiredString(value, "projectName", { maxLength: 512 });
}

function resolveTaskboardUrl(task, taskboardUrl, taskboardBaseUrl = DEFAULT_TASKBOARD_BASE_URL) {
  const explicit = taskboardUrl ?? task.taskboardUrl ?? task.taskboard_url;
  if (explicit !== undefined && explicit !== null) return validatedUrl(explicit, "taskboardUrl");
  const base = validatedUrl(taskboardBaseUrl, "taskboardBaseUrl").replace(/\/+$/, "");
  return validatedUrl(`${base}/tasks/${encodeURIComponent(task.id)}`, "taskboardUrl");
}

function threadMetadata(task, extra = undefined) {
  const extraValue = isPlainObject(extra) ? extra : {};
  return {
    taskThreadId: task.threadId,
    codexThreadId: optionalString(
      extraValue.codexThreadId ?? extraValue.codex_thread_id ?? task.codexThreadId,
      "threadMetadata.codexThreadId",
      { maxLength: 512 },
    ),
    aiThreadId: optionalString(
      extraValue.aiThreadId ?? extraValue.ai_thread_id ?? task.aiThreadId,
      "threadMetadata.aiThreadId",
      { maxLength: 512 },
    ),
  };
}

function mirrorFields(task, {
  projectName,
  taskboardUrl,
  taskboardBaseUrl,
  generatedAt,
  threadMetadata: extraThreadMetadata,
  reconciliationError,
} = {}) {
  const status = TASKBOARD_TO_FEISHU_STATUS[task.status];
  if (!status) fail("UNSUPPORTED_TASK_STATUS", `Unsupported Taskboard status: ${task.status}`);
  const priority = TASKBOARD_TO_FEISHU_PRIORITY[task.priority];
  if (!priority) fail("UNSUPPORTED_TASK_PRIORITY", `Unsupported Taskboard priority: ${task.priority}`);
  const resolvedProjectName = resolveProjectName(task, projectName);
  const resolvedUrl = resolveTaskboardUrl(task, taskboardUrl, taskboardBaseUrl);
  const thread = threadMetadata(task, extraThreadMetadata);
  const error = reconciliationError
    ?? task.reconciliationError
    ?? null;
  return {
    "需求描述": task.title,
    "需求详细描述（可附文档）": task.description,
    "项目": resolvedProjectName,
    "优先级": priority,
    "需求状态": status,
    "Taskboard 权威状态": task.status,
    "Taskboard 权威优先级": task.priority,
    "Taskboard Task ID": task.id,
    "Taskboard 短标识": task.identifier,
    "Taskboard 链接": resolvedUrl,
    "Taskboard 版本": task.version,
    "Taskboard 更新时间": task.updatedAt,
    "标签": task.labels,
    "负责人": task.assignee,
    "开发上下文": task.developmentContext,
    "开发分支": developmentBranch(task.developmentContext),
    "PR链接": task.prUrl,
    "Codex thread_id": thread.taskThreadId,
    "Codex 线程元数据": thread,
    "最后对账时间": milliseconds(generatedAt),
    "对账异常": error,
  };
}

function stableTaskboardSnapshot(task, fields, preserved) {
  const stableFields = { ...fields };
  delete stableFields["最后对账时间"];
  return {
    task: {
      id: task.id,
      identifier: task.identifier,
      previousIdentifiers: task.previousIdentifiers,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      version: task.version,
      updatedAt: task.updatedAt,
    },
    fields: stableFields,
    preserved,
  };
}

function preservedTaskState(task, extraPreserved = undefined) {
  const extra = isPlainObject(extraPreserved) ? extraPreserved : {};
  const comments = extra.comments ?? task.comments;
  const attachments = extra.attachments ?? task.attachments;
  const relations = extra.relations ?? task.relations;
  const thread = threadMetadata(task, extra.threads ?? extra.threadMetadata);
  return {
    taskUuid: task.id,
    identifier: task.identifier,
    previousIdentifiers: task.previousIdentifiers,
    comments: cloneMirrorJson(comments),
    attachments: cloneMirrorJson(attachments),
    relations: cloneMirrorJson(relations),
    threads: thread,
  };
}

export function buildTaskboardProjection({
  task,
  projectName = undefined,
  taskboardUrl = undefined,
  taskboardBaseUrl = DEFAULT_TASKBOARD_BASE_URL,
  generatedAt = undefined,
  threadMetadata: extraThreadMetadata = undefined,
  preserved = undefined,
  reconciliationError = undefined,
} = {}) {
  const normalizedTask = normalizeTask(task);
  const timestamp = normalizeTimestamp(generatedAt, "generatedAt");
  const fields = mirrorFields(normalizedTask, {
    projectName,
    taskboardUrl,
    taskboardBaseUrl,
    generatedAt: timestamp,
    threadMetadata: extraThreadMetadata,
    reconciliationError,
  });
  const preservedState = preservedTaskState(normalizedTask, preserved);
  const taskboardSnapshot = stableTaskboardSnapshot(normalizedTask, fields, preservedState);
  const taskboardHash = hashCanonicalJson(taskboardSnapshot);
  return deepFreeze({
    generatedAt: timestamp,
    task: {
      id: normalizedTask.id,
      identifier: normalizedTask.identifier,
      previousIdentifiers: normalizedTask.previousIdentifiers,
      projectId: normalizedTask.projectId,
      version: normalizedTask.version,
    },
    fields,
    preserved: preservedState,
    taskboardSnapshot,
    taskboardHash,
  });
}

export const createTaskboardProjection = buildTaskboardProjection;
export const projectAuthoritativeFields = buildTaskboardProjection;

function sourceTarget(link) {
  const target = recordTargetFromLink(link);
  return deepFreeze({ ...target });
}

function taskReference(projection) {
  return {
    id: projection.task.id,
    identifier: projection.task.identifier,
    previousIdentifiers: projection.task.previousIdentifiers,
    projectId: projection.task.projectId,
    version: projection.task.version,
  };
}

function addSnakeCaseAliases(object, aliases) {
  if (!object || typeof object !== "object") return object;
  for (const [key, value] of Object.entries(aliases)) {
    if (Object.hasOwn(object, key)) continue;
    Object.defineProperty(object, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return object;
}

function addTargetAliases(target) {
  return addSnakeCaseAliases(target, {
    app_token: target.appToken,
    table_id: target.tableId,
    record_id: target.recordId,
  });
}

export function createMirrorIdempotencyKey({
  operation,
  externalKey,
  taskId,
  taskboardVersion,
  stableTarget,
} = {}) {
  if (!MIRROR_OPERATIONS.includes(operation)) fail("INVALID_MIRROR_OPERATION", `Unsupported mirror operation: ${operation}`);
  const external = requiredString(externalKey, "externalKey", { maxLength: 4096 });
  try {
    parseFeishuBaseExternalKey(external);
  } catch (error) {
    fail("INVALID_EXTERNAL_KEY", error?.message ?? "externalKey is not canonical");
  }
  const id = requiredString(taskId, "taskId", { maxLength: 256 });
  const version = positiveInteger(taskboardVersion, "taskboardVersion");
  const material = {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    operation,
    externalKey: external,
    taskId: id,
    taskboardVersion: version,
    stableTarget: cloneMirrorJson(stableTarget ?? null),
  };
  return `taskboard-feishu:${operation}:${hashCanonicalJson(material)}`;
}

function normalizeOperation(operation) {
  if (!MIRROR_OPERATIONS.includes(operation)) fail("INVALID_MIRROR_OPERATION", `Unsupported mirror operation: ${operation}`);
  return operation;
}

export function createMirrorEnvelope({
  operation,
  externalKey,
  taskId,
  taskboardVersion,
  taskboardHash,
  generatedAt,
  payload,
  stableTarget = undefined,
  idempotencyKey = undefined,
  eventId = null,
  runId = null,
  expectedBaseVersion = null,
} = {}) {
  const normalizedOperation = normalizeOperation(operation);
  const external = requiredString(externalKey, "externalKey", { maxLength: 4096 });
  try {
    parseFeishuBaseExternalKey(external);
  } catch (error) {
    fail("INVALID_EXTERNAL_KEY", error?.message ?? "externalKey is not canonical");
  }
  const id = requiredString(taskId, "taskId", { maxLength: 256 });
  const version = positiveInteger(taskboardVersion, "taskboardVersion");
  const hash = requiredString(taskboardHash, "taskboardHash", { maxLength: 128 });
  const timestamp = normalizeTimestamp(generatedAt, "generatedAt");
  const immutablePayload = cloneMirrorJson(payload);
  if (!isPlainObject(immutablePayload)) fail("INVALID_MIRROR_PAYLOAD", "Mirror payload must be a JSON object");
  const target = cloneMirrorJson(stableTarget ?? immutablePayload.target ?? immutablePayload.formalRequirement ?? null);
  const calculatedKey = createMirrorIdempotencyKey({
    operation: normalizedOperation,
    externalKey: external,
    taskId: id,
    taskboardVersion: version,
    stableTarget: target,
  });
  if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== calculatedKey) {
    fail("IDEMPOTENCY_KEY_MISMATCH", "idempotencyKey does not match the stable mirror target");
  }
  const event = eventId === null || eventId === undefined ? null : requiredString(eventId, "eventId", { maxLength: 512 });
  const run = runId === null || runId === undefined ? null : requiredString(runId, "runId", { maxLength: 512 });
  const envelope = {
    schemaVersion: MIRROR_SCHEMA_VERSION,
    mappingVersion: MIRROR_MAPPING_VERSION,
    mode: "dry_run",
    operation: normalizedOperation,
    idempotencyKey: calculatedKey,
    externalKey: external,
    taskId: id,
    taskboardVersion: version,
    taskboardHash: hash,
    generatedAt: timestamp,
    eventId: event,
    runId: run,
    expectedBaseVersion: expectedBaseVersion === undefined ? null : cloneMirrorJson(expectedBaseVersion),
    payload: immutablePayload,
  };
  addSnakeCaseAliases(envelope, {
    schema_version: envelope.schemaVersion,
    idempotency_key: envelope.idempotencyKey,
    external_key: envelope.externalKey,
    task_id: envelope.taskId,
    taskboard_version: envelope.taskboardVersion,
    taskboard_hash: envelope.taskboardHash,
    generated_at: envelope.generatedAt,
    event_id: envelope.eventId,
    run_id: envelope.runId,
    expected_base_version: envelope.expectedBaseVersion,
  });
  return deepFreeze(envelope);
}

export function prepareTaskboardMirror(stateOrOptions, maybeOptions = {}) {
  const options = stateOrOptions && typeof stateOrOptions.getLink === "function"
    ? { ...maybeOptions, state: stateOrOptions }
    : (stateOrOptions ?? {});
  const link = options.link ?? {
    externalKey: options.externalKey,
    recordId: options.recordId,
  };
  const projection = buildTaskboardProjection(options);
  const target = sourceTarget(link);
  const payload = {
    task: taskReference(projection),
    target: addTargetAliases({ ...target }),
    fields: projection.fields,
    preserved: projection.preserved,
    taskboardSnapshot: projection.taskboardSnapshot,
  };
  return createMirrorEnvelope({
    operation: "mirror_task",
    externalKey: link.externalKey ?? link.external_key,
    taskId: projection.task.id,
    taskboardVersion: projection.task.version,
    taskboardHash: projection.taskboardHash,
    generatedAt: projection.generatedAt,
    payload,
    stableTarget: target,
    idempotencyKey: options.idempotencyKey,
    eventId: options.eventId,
    runId: options.runId,
    expectedBaseVersion: options.expectedBaseVersion ?? null,
  });
}

export const createTaskboardMirrorPackage = prepareTaskboardMirror;

export function prepareIdeaPromotion(stateOrOptions, maybeOptions = {}) {
  const options = stateOrOptions && typeof stateOrOptions.getLink === "function"
    ? { ...maybeOptions, state: stateOrOptions }
    : (stateOrOptions ?? {});
  const task = normalizeTask(options.task);
  const previousStatus = requiredString(
    options.previousStatus ?? options.previous_status,
    "previousStatus",
    { maxLength: 64 },
  );
  if (previousStatus !== "backlog" || task.status !== "todo") {
    throw new InvalidPromotionTransitionError(undefined, {
      previousStatus,
      currentStatus: task.status,
    });
  }
  const ideaLink = options.ideaLink ?? options.link;
  const source = sourceTarget(ideaLink);
  const formalAppToken = requiredString(
    options.formalAppToken ?? options.formal_app_token ?? source.appToken,
    "formalAppToken",
    { maxLength: 1024 },
  );
  const formalTableId = requiredString(
    options.formalTableId ?? options.formal_table_id,
    "formalTableId",
    { maxLength: 1024 },
  );
  if (formalAppToken === source.appToken && formalTableId === source.tableId) {
    fail("INVALID_PROMOTION_TARGET", "formal requirement target must differ from the idea table");
  }
  const projection = buildTaskboardProjection(options);
  const formalTarget = { appToken: formalAppToken, tableId: formalTableId, recordId: null };
  const sourceUpdateFields = {
    currentStatus: "已升级",
    taskboardTaskId: projection.task.id,
    taskboardLink: projection.fields["Taskboard 链接"],
    formalRecordId: null,
  };
  const payload = {
    task: taskReference(projection),
    transition: { from: "backlog", to: "todo" },
    sourceIdea: addTargetAliases({ ...source }),
    sourceUpdateFields,
    formalRequirement: {
      ...addTargetAliases({ ...formalTarget }),
      fields: projection.fields,
    },
    preserved: projection.preserved,
    taskboardSnapshot: projection.taskboardSnapshot,
  };
  const stableTarget = {
    sourceExternalKey: ideaLink.externalKey ?? ideaLink.external_key,
    formalAppToken,
    formalTableId,
    transition: { from: "backlog", to: "todo" },
  };
  return createMirrorEnvelope({
    operation: "promote_idea",
    externalKey: ideaLink.externalKey ?? ideaLink.external_key,
    taskId: projection.task.id,
    taskboardVersion: projection.task.version,
    taskboardHash: projection.taskboardHash,
    generatedAt: projection.generatedAt,
    payload,
    stableTarget,
    idempotencyKey: options.idempotencyKey,
    eventId: options.eventId,
    runId: options.runId,
    expectedBaseVersion: options.expectedBaseVersion ?? null,
  });
}

export const createIdeaPromotionPackage = prepareIdeaPromotion;

export function packageFromOutbox(outbox) {
  if (!outbox || typeof outbox !== "object") {
    throw new InvalidMirrorPackageError("outbox must be an object");
  }
  const message = outbox.message ?? outbox.payload;
  if (!isPlainObject(message)) throw new InvalidMirrorPackageError("outbox message is missing");
  if (message.schemaVersion !== MIRROR_SCHEMA_VERSION || !MIRROR_OPERATIONS.includes(message.operation)) {
    throw new InvalidMirrorPackageError("outbox message is not a Taskboard mirror package");
  }
  if (message.externalKey !== outbox.externalKey || message.taskId !== outbox.taskId) {
    throw new InvalidMirrorPackageError("outbox message target does not match the stored outbox row");
  }
  if (message.idempotencyKey !== outbox.idempotencyKey) {
    throw new InvalidMirrorPackageError("outbox message idempotency key does not match the stored outbox row");
  }
  const copy = cloneMirrorJson(message);
  copy.outboxId = outbox.outboxId ?? outbox.id ?? null;
  copy.outboxStatus = outbox.status ?? "pending";
  addSnakeCaseAliases(copy, {
    schema_version: copy.schemaVersion,
    idempotency_key: copy.idempotencyKey,
    external_key: copy.externalKey,
    task_id: copy.taskId,
    taskboard_version: copy.taskboardVersion,
    taskboard_hash: copy.taskboardHash,
    generated_at: copy.generatedAt,
    event_id: copy.eventId,
    run_id: copy.runId,
    expected_base_version: copy.expectedBaseVersion,
  });
  return deepFreeze(copy);
}

export { DEFAULT_TASKBOARD_BASE_URL };
