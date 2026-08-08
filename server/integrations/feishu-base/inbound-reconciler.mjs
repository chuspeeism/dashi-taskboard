import { randomUUID } from "node:crypto";

import {
  FEISHU_BASE_TABLE_KEYS,
  FEISHU_BASE_EXCLUDED_SCOPES,
  assertCurrentFeishuAppId,
  normalizeFeishuBaseConfig,
} from "./config.mjs";
import {
  canonicalJson,
  createFeishuBaseExternalKey,
  createFeishuBaseReaderPort,
  createTaskboardStorePort,
  createTaskboardWriteMessage,
  hashCanonicalJson,
} from "./contracts.mjs";

export const FEISHU_BASE_INBOUND_VERSION = 1;
export const FEISHU_BASE_MAPPING_VERSION = "v1";
export const FEISHU_BASE_UNMAPPED_PROJECT_LABEL = "原项目未映射";
export const FEISHU_BASE_DEFAULT_STATUS = "backlog";

const TITLE_FIELDS = Object.freeze([
  "标题",
  "名称",
  "灵感名称",
  "需求名称",
  "需求标题",
  "需求",
  "灵感摘要",
  "title",
  "name",
]);
const DESCRIPTION_FIELDS = Object.freeze([
  "描述",
  "需求描述",
  "需求背景",
  "背景",
  "灵感描述",
  "待思考问题",
  "摘要",
  "summary",
  "description",
  "content",
]);
const PROJECT_FIELDS = Object.freeze([
  "项目",
  "所属项目",
  "项目名称",
  "projectId",
  "project_id",
  "project",
]);
const STATUS_FIELDS = Object.freeze(["当前状态", "状态", "status"]);
const PRIORITY_FIELDS = Object.freeze(["优先级", "priority"]);
const LABEL_FIELDS = Object.freeze(["标签", "labels", "label"]);
const NEXT_STEP_FIELDS = Object.freeze(["下一步", "下一步行动", "后续动作", "nextStep"]);

export class FeishuBaseInboundReconcileError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FeishuBaseInboundReconcileError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new FeishuBaseInboundReconcileError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label = "value") {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    fail("INVALID_INBOUND_VALUE", `${label} must contain plain JSON`, {
      cause: error?.code ?? error?.message ?? String(error),
    });
  }
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function requiredString(value, label, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_INBOUND_VALUE", `${label} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    fail("INVALID_INBOUND_VALUE", `${label} contains unsupported whitespace`);
  }
  return value;
}

function optionalString(value, label, maxLength = 4096) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
    fail("INVALID_INBOUND_VALUE", `${label} must be a valid string`);
  }
  return value.trim() || null;
}

function nowIso(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("INVALID_CLOCK", "clock must return a valid date");
  return date.toISOString();
}

function normalizeRecordId(raw, label) {
  const value = raw?.record_id ?? raw?.recordId ?? raw?.id;
  return requiredString(value, label, 256);
}

function normalizeSourceVersion(raw) {
  const value = raw?.last_modified_time
    ?? raw?.lastModifiedTime
    ?? raw?.updated_at
    ?? raw?.updatedAt
    ?? raw?.revision
    ?? raw?.version
    ?? null;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return cloneJson(value, "sourceVersion");
}

function textValue(value, label = "field") {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry, index) => textValue(entry, `${label}[${index}]`)).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (isPlainObject(value)) {
    for (const key of ["text", "name", "value", "display_name", "displayName", "title"]) {
      if (Object.hasOwn(value, key)) return textValue(value[key], `${label}.${key}`);
    }
    if (Object.hasOwn(value, "id")) return textValue(value.id, `${label}.id`);
  }
  fail("INVALID_INBOUND_FIELD", `${label} has an unsupported value type`);
}

function labelValues(value, label = "labels") {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const labels = value.flatMap((entry, index) => {
      const normalized = textValue(entry, `${label}[${index}]`);
      return normalized === null ? [] : [normalized];
    });
    return [...new Set(labels)];
  }
  const normalized = textValue(value, label);
  return normalized === null ? [] : [normalized];
}

function fieldContainer(raw, label) {
  if (!isPlainObject(raw)) fail("INVALID_BASE_RECORD", `${label} must be an object`);
  const fields = raw.fields ?? raw.fieldValues ?? raw.values;
  if (!isPlainObject(fields)) fail("INVALID_BASE_RECORD", `${label}.fields must be an object`);
  return fields;
}

function pickField(raw, aliases) {
  const fields = raw.fields ?? raw.fieldValues ?? raw.values;
  for (const key of aliases) {
    if (isPlainObject(fields) && Object.hasOwn(fields, key)) {
      return { present: true, raw: fields[key], value: textValue(fields[key], `fields.${key}`) };
    }
    if (Object.hasOwn(raw, key)) {
      return { present: true, raw: raw[key], value: textValue(raw[key], key) };
    }
  }
  return { present: false, raw: null, value: null };
}

function priorityValue(value) {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  const values = new Map([
    ["none", "none"],
    ["无", "none"],
    ["无优先级", "none"],
    ["urgent", "urgent"],
    ["紧急", "urgent"],
    ["p0", "urgent"],
    ["high", "high"],
    ["高", "high"],
    ["p1", "high"],
    ["medium", "medium"],
    ["中", "medium"],
    ["p2", "medium"],
    ["low", "low"],
    ["低", "low"],
    ["p3", "low"],
  ]);
  return values.get(normalized) ?? null;
}

function schemaFields(schema, label) {
  if (Array.isArray(schema)) return schema;
  if (!isPlainObject(schema)) fail("INVALID_BASE_SCHEMA", `${label} must be an object`);
  const fields = schema.fields ?? schema.items ?? schema.data?.items ?? schema.data?.fields;
  if (!Array.isArray(fields)) fail("INVALID_BASE_SCHEMA", `${label} must contain a fields array`);
  return fields;
}

function normalizeSchema(schema, tableKey, tableId) {
  const fields = schemaFields(schema, `${tableKey} schema`);
  const seen = new Set();
  const normalizedFields = fields.map((field, index) => {
    if (!isPlainObject(field)) fail("INVALID_BASE_SCHEMA", `${tableKey} schema field ${index} must be an object`);
    const id = field.field_id ?? field.fieldId ?? field.id ?? null;
    const name = field.field_name ?? field.fieldName ?? field.name ?? null;
    if ((id === null || id === undefined) && (name === null || name === undefined)) {
      fail("INVALID_BASE_SCHEMA", `${tableKey} schema field ${index} needs an id or name`);
    }
    const key = `${id ?? ""}\u0000${name ?? ""}`;
    if (seen.has(key)) fail("INVALID_BASE_SCHEMA", `${tableKey} schema contains duplicate fields`);
    seen.add(key);
    return cloneJson(field, `${tableKey} schema field ${index}`);
  });
  return freeze({ tableKey, tableId, fields: normalizedFields, complete: true });
}

function normalizeTable(table, tableKey, tableId, appToken, capturedAt) {
  if (!isPlainObject(table)) fail("INVALID_BASE_RESPONSE", `${tableKey} table response must be an object`);
  if (table.complete === false) fail("INCOMPLETE_BASE_READ", `${tableKey} table response is incomplete`);
  const schema = normalizeSchema(table.schema, tableKey, tableId);
  if (!Array.isArray(table.records)) fail("INVALID_BASE_RESPONSE", `${tableKey} table response must contain records`);
  const seen = new Set();
  const records = table.records.map((raw, index) => {
    const recordId = normalizeRecordId(raw, `${tableKey} record ${index}.recordId`);
    if (seen.has(recordId)) fail("DUPLICATE_BASE_RECORD", `${tableKey} contains duplicate record ${recordId}`);
    seen.add(recordId);
    return normalizeFeishuBaseRecord({
      tableKey,
      tableId,
      appToken,
      recordId,
      raw,
      capturedAt,
    });
  });
  return freeze({ tableKey, tableId, schema, records, complete: true });
}

export function normalizeFeishuBaseRecord({
  tableKey,
  tableId,
  recordId = undefined,
  appToken = undefined,
  raw,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!FEISHU_BASE_TABLE_KEYS.includes(tableKey)) fail("TABLE_NOT_WHITELISTED", `Unsupported table: ${tableKey}`);
  requiredString(appToken, "appToken", 512);
  requiredString(tableId, "tableId", 256);
  const sourceRecordId = requiredString(recordId ?? normalizeRecordId(raw, "recordId"), "recordId", 256);
  if (!isPlainObject(raw)) fail("INVALID_BASE_RECORD", "Base record must be an object");
  const fields = fieldContainer(raw, `record ${sourceRecordId}`);
  const title = pickField(raw, TITLE_FIELDS);
  if (!title.present || title.value === null) {
    fail("REQUIRED_BASE_FIELD_MISSING", `Base record ${sourceRecordId} has no title/name field`);
  }
  const description = pickField(raw, DESCRIPTION_FIELDS);
  const project = pickField(raw, PROJECT_FIELDS);
  const sourceStatus = pickField(raw, STATUS_FIELDS);
  const priority = pickField(raw, PRIORITY_FIELDS);
  const labels = pickField(raw, LABEL_FIELDS);
  const nextStep = pickField(raw, NEXT_STEP_FIELDS);
  const sourcePayload = {
    title: title.value,
    description: description.value ?? "",
    project: project.value,
    status: sourceStatus.value,
    priority: priority.value,
    labels: labelValues(labels.raw),
    nextStep: nextStep.value,
  };
  const sourceHash = hashCanonicalJson(sourcePayload);
  const externalKey = createFeishuBaseExternalKey({ appToken, tableId, recordId: sourceRecordId });
  return freeze({
    tableKey,
    tableId,
    recordId: sourceRecordId,
    externalKey,
    sourceVersion: normalizeSourceVersion(raw),
    sourceUpdatedAt: raw.last_modified_time ?? raw.lastModifiedTime ?? raw.updated_at ?? raw.updatedAt ?? null,
    capturedAt: optionalString(capturedAt, "capturedAt"),
    fields: cloneJson(fields, `record ${sourceRecordId}.fields`),
    sourcePayload: cloneJson(sourcePayload, `record ${sourceRecordId}.sourcePayload`),
    sourceHash,
    projection: {
      title: title.value,
      description: description.value ?? "",
      descriptionPresent: description.present,
      sourceProject: project.value,
      projectPresent: project.present,
      sourceStatus: sourceStatus.value,
      priority: priorityValue(priority.value),
      priorityPresent: priority.present,
      labels: labelValues(labels.raw),
      labelsPresent: labels.present,
      nextStep: nextStep.value,
      nextStepPresent: nextStep.present,
    },
    raw: cloneJson(raw, `record ${sourceRecordId}`),
  });
}

export function normalizeFeishuBaseSnapshot({
  config,
  app,
  tables,
  capturedAt = new Date().toISOString(),
} = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  if (!isPlainObject(app)) fail("INVALID_FEISHU_IDENTITY", "snapshot app identity is required");
  const appId = requiredString(app.appId ?? app.app_id, "app.appId", 256);
  try {
    assertCurrentFeishuAppId(appId);
  } catch (error) {
    fail("UNSUPPORTED_FEISHU_APP", "snapshot must come from personal-latest-bot", {
      cause: error?.code ?? error?.message,
    });
  }
  const normalizedTables = {};
  const allRecords = [];
  for (const tableKey of FEISHU_BASE_TABLE_KEYS) {
    const tableId = normalizedConfig.tableIds[tableKey];
    const table = tables?.[tableKey];
    const normalized = normalizeTable(table, tableKey, tableId, normalizedConfig.appToken, capturedAt);
    normalizedTables[tableKey] = normalized;
    allRecords.push(...normalized.records);
  }
  const snapshotBody = {
    version: FEISHU_BASE_INBOUND_VERSION,
    appId,
    capturedAt,
    tables: normalizedTables,
  };
  const snapshotHash = hashCanonicalJson(snapshotBody);
  return freeze({
    ...snapshotBody,
    snapshotHash,
    readScope: {
      tables: [...FEISHU_BASE_TABLE_KEYS],
      excludedScopes: [...FEISHU_BASE_EXCLUDED_SCOPES],
      excludedReads: 0,
      excludedWrites: 0,
      complete: true,
    },
    records: allRecords,
  });
}

function unwrapTask(value) {
  if (!value) return null;
  if (isPlainObject(value) && value.task && isPlainObject(value.task)) return value.task;
  return value;
}

function normalizeTask(task, label) {
  const value = unwrapTask(task);
  if (!isPlainObject(value)) fail("INVALID_TASKBOARD_RESPONSE", `${label} did not return a task`);
  const id = value.id ?? value.taskId ?? value.task_id;
  if (typeof id !== "string" || id.length === 0) fail("INVALID_TASKBOARD_RESPONSE", `${label} task has no id`);
  if (!Number.isInteger(value.version) || value.version < 1) {
    fail("INVALID_TASKBOARD_RESPONSE", `${label} task has no optimistic version`);
  }
  return {
    ...value,
    id,
    version: value.version,
    status: value.status ?? null,
    projectId: value.projectId ?? value.project_id ?? null,
    title: value.title ?? null,
    description: value.description ?? "",
    priority: value.priority ?? "none",
    labels: Array.isArray(value.labels) ? [...value.labels] : [],
  };
}

function taskProjection(task) {
  return {
    title: task.title,
    description: task.description ?? "",
    priority: task.priority ?? "none",
    labels: [...(task.labels ?? [])],
    status: task.status,
    projectId: task.projectId,
  };
}

function sideChanged(baseline, current) {
  if (!baseline) return false;
  if (baseline.hash !== null && baseline.hash !== undefined) return baseline.hash !== current.hash;
  if (baseline.version !== null && baseline.version !== undefined) {
    return canonicalJson(baseline.version) !== canonicalJson(current.version);
  }
  return false;
}

function addUnmappedDescription(description, sourceProject) {
  const original = sourceProject ?? "（空）";
  const marker = `${FEISHU_BASE_UNMAPPED_PROJECT_LABEL}：${original}`;
  if (description.includes(marker)) return description;
  return description ? `${description}\n\n${marker}` : marker;
}

function projectDecision(config, record) {
  const mappedProjectId = config.projectMapping[record.tableKey];
  const sourceProject = record.projection.sourceProject;
  if (sourceProject && sourceProject === mappedProjectId) {
    return { projectId: mappedProjectId, mapped: true, original: sourceProject };
  }
  return {
    projectId: config.fallbackProjectId,
    mapped: false,
    original: sourceProject,
  };
}

function preserveMainTaskLabel(currentLabels, sourceLabels) {
  const current = Array.isArray(currentLabels) ? [...currentLabels] : [];
  const source = Array.isArray(sourceLabels) ? [...sourceLabels] : [];
  const filtered = source.filter((label) => label !== "主任务");
  const mainIndex = current.indexOf("主任务");
  if (mainIndex < 0) return filtered;
  filtered.splice(Math.min(mainIndex, filtered.length), 0, "主任务");
  return filtered;
}

function createPayload(config, record) {
  const project = projectDecision(config, record);
  const description = project.mapped
    ? record.projection.description
    : addUnmappedDescription(record.projection.description, project.original);
  return {
    projectId: project.projectId,
    title: record.projection.title,
    description,
    status: FEISHU_BASE_DEFAULT_STATUS,
    priority: record.projection.priority ?? "none",
    labels: record.projection.labels ?? [],
    threadId: config.threadId,
  };
}

function updateChanges(config, record, currentTask) {
  const project = projectDecision(config, record);
  const changes = {};
  if (canonicalJson(currentTask.title) !== canonicalJson(record.projection.title)) {
    changes.title = record.projection.title;
  }
  if (record.projection.descriptionPresent) {
    const description = project.mapped
      ? record.projection.description
      : addUnmappedDescription(record.projection.description, project.original);
    if (canonicalJson(currentTask.description ?? "") !== canonicalJson(description)) {
      changes.description = description;
    }
  }
  if (record.projection.priorityPresent && record.projection.priority !== null) {
    if (canonicalJson(currentTask.priority ?? "none") !== canonicalJson(record.projection.priority)) {
      changes.priority = record.projection.priority;
    }
  }
  if (record.projection.labelsPresent) {
    const labels = preserveMainTaskLabel(currentTask.labels, record.projection.labels);
    if (canonicalJson(currentTask.labels ?? []) !== canonicalJson(labels)) {
      changes.labels = labels;
    }
  }
  return changes;
}

function readLink(state, externalKey) {
  if (typeof state?.getLink === "function") return state.getLink(externalKey);
  if (typeof state?.getSourceLink === "function") return state.getSourceLink(externalKey);
  fail("STATE_STORE_INVALID", "state store must provide getLink");
}

function stateError(error) {
  return {
    code: error?.code ?? "INBOUND_RECONCILE_FAILED",
    message: error?.message ?? String(error),
  };
}

function currentTaskIdFromWrite(value) {
  const task = unwrapTask(value);
  return task?.id ?? task?.taskId ?? task?.task_id ?? value?.taskId ?? value?.task_id ?? null;
}

function assertReadback({ expected, actual, operation }) {
  const task = normalizeTask(actual, `${operation} readback`);
  if (operation === "create" && task.status !== FEISHU_BASE_DEFAULT_STATUS) {
    fail("TASKBOARD_READBACK_MISMATCH", "create readback changed the Taskboard status");
  }
  if (operation !== "create" && task.id !== expected.id) {
    fail("TASKBOARD_READBACK_MISMATCH", "update readback returned another task");
  }
  if (operation !== "create" && task.version <= expected.version) {
    fail("TASKBOARD_READBACK_MISMATCH", "update readback did not advance Taskboard version");
  }
  const expectedFields = expected.fields ?? expected;
  for (const [key, value] of Object.entries(expectedFields)) {
    if (canonicalJson(task[key]) !== canonicalJson(value)) {
      fail("TASKBOARD_READBACK_MISMATCH", `Taskboard readback field '${key}' differs`);
    }
  }
  if (task.status !== expected.status) {
    fail("TASKBOARD_READBACK_MISMATCH", "Taskboard readback changed the existing status");
  }
  if (expected.projectId !== undefined && task.projectId !== expected.projectId) {
    fail("TASKBOARD_READBACK_MISMATCH", "Taskboard readback changed the existing project");
  }
  return task;
}

function linkObservation(state, record, task, taskProjectionValue) {
  if (typeof state?.linkExternalRecord !== "function") {
    fail("STATE_STORE_INVALID", "state store must provide linkExternalRecord");
  }
  const link = state.linkExternalRecord({
    externalKey: record.externalKey,
    taskId: task.id,
    tableKey: record.tableKey,
    recordId: record.recordId,
    sourceVersion: record.sourceVersion,
    sourceHash: record.sourceHash,
    sourcePayload: record.sourcePayload,
    seenAt: record.capturedAt,
  });
  if (typeof state.recordTaskboardReadback === "function") {
    state.recordTaskboardReadback({
      externalKey: record.externalKey,
      taskId: task.id,
      version: task.version,
      payload: taskProjectionValue,
      payloadHash: hashCanonicalJson(taskProjectionValue),
      raw: task,
      observedAt: record.capturedAt,
    });
  }
  return link;
}

function recordConflict(state, record, details) {
  if (typeof state.recordConflict !== "function") return null;
  return state.recordConflict({
    externalKey: record.externalKey,
    taskId: details.taskId ?? null,
    reason: details.reason,
    baseline: details.baseline ?? null,
    source: details.source ?? null,
    taskboard: details.taskboard ?? null,
    details: details.details ?? null,
    createdAt: record.capturedAt,
  });
}

function taskboardMessage({ config, record, operation, taskId, version, payload, threadId, env, mappingVersion }) {
  return createTaskboardWriteMessage({
    operation,
    taskId,
    version,
    externalKey: record.externalKey,
    mappingVersion: mappingVersion ?? FEISHU_BASE_MAPPING_VERSION,
    payload,
    threadId: threadId ?? config.threadId,
    configuredThreadId: config.threadId,
    env,
    sourceTableKey: record.tableKey,
  });
}

function makeSummary({ snapshot, writes, results, trigger }) {
  const counts = {
    records: snapshot.records.length,
    created: results.filter((entry) => entry.action === "created").length,
    updated: results.filter((entry) => entry.action === "updated").length,
    unchanged: results.filter((entry) => entry.action === "unchanged").length,
    outboundMirrorRequired: results.filter((entry) => entry.action === "outbound_mirror_required").length,
    conflicts: results.filter((entry) => entry.action === "conflict").length,
    blocked: results.filter((entry) => entry.action === "blocked").length,
    writes,
  };
  return {
    version: FEISHU_BASE_INBOUND_VERSION,
    trigger,
    snapshotHash: snapshot.snapshotHash,
    tableCounts: Object.fromEntries(FEISHU_BASE_TABLE_KEYS.map((key) => [key, snapshot.tables[key].records.length])),
    counts,
    readScope: snapshot.readScope,
    aiThreadsCreated: 0,
    aiRunsCreated: 0,
    timerStarted: false,
  };
}

export class FeishuBaseInboundReconciler {
  constructor({
    config,
    reader,
    baseReader = undefined,
    taskboardStore,
    taskboardStorePort = undefined,
    state,
    stateStore = undefined,
    env = process.env,
    clock = undefined,
    threadId = undefined,
    mappingVersion = FEISHU_BASE_MAPPING_VERSION,
  } = {}) {
    this.config = normalizeFeishuBaseConfig(config);
    const rawReader = baseReader ?? reader;
    if (!rawReader) fail("BASE_READER_REQUIRED", "baseReader is required");
    this.baseReader = rawReader.readBackAppId && rawReader.readTable
      ? rawReader
      : createFeishuBaseReaderPort({ config: this.config, reader: rawReader });
    this.taskboardStore = taskboardStorePort
      ?? (taskboardStore?.readTask && taskboardStore?.writeTask
        ? createTaskboardStorePort({ config: this.config, store: taskboardStore, env })
        : null);
    if (!this.taskboardStore) fail("TASKBOARD_STORE_REQUIRED", "taskboardStore is required");
    this.state = stateStore ?? state;
    if (!this.state) fail("STATE_STORE_REQUIRED", "state store is required");
    this.env = env;
    this.clock = clock;
    this.threadId = threadId ?? this.config.threadId ?? null;
    this.mappingVersion = mappingVersion;
  }

  async readSnapshot({ capturedAt = nowIso(this.clock) } = {}) {
    const app = await this.baseReader.readBackAppId();
    const tables = {};
    for (const tableKey of FEISHU_BASE_TABLE_KEYS) {
      tables[tableKey] = await this.baseReader.readTable(tableKey);
    }
    return normalizeFeishuBaseSnapshot({
      config: this.config,
      app,
      tables,
      capturedAt,
    });
  }

  async #prepare(snapshot) {
    const prepared = [];
    for (const record of snapshot.records) {
      const link = readLink(this.state, record.externalKey);
      let task = null;
      let current = null;
      if (link) {
        if (!link.taskId) fail("SOURCE_LINK_INVALID", `source link ${record.externalKey} has no task id`);
        current = await this.taskboardStore.readTask(link.taskId);
        task = normalizeTask(current, `Taskboard ${link.taskId}`);
        current = task;
      }
      const sourceBaseline = link?.lastSourceObservation ?? null;
      const taskboardBaseline = link?.lastTaskboardObservation ?? null;
      const currentProjection = task ? taskProjection(task) : null;
      const sourceCurrent = {
        version: record.sourceVersion,
        hash: record.sourceHash,
        payload: record.sourcePayload,
      };
      const taskboardCurrent = currentProjection
        ? { version: task.version, hash: hashCanonicalJson(currentProjection), payload: currentProjection }
        : null;
      const sourceChanged = !link || sideChanged(sourceBaseline, sourceCurrent);
      const taskboardChanged = Boolean(taskboardCurrent && sideChanged(taskboardBaseline, taskboardCurrent));
      prepared.push({
        record,
        link,
        task,
        currentProjection,
        sourceCurrent,
        taskboardCurrent,
        sourceChanged,
        taskboardChanged,
      });
    }
    return prepared;
  }

  async #writeAndRead({ prepared, operation, payload, changes = null }) {
    const { record, task } = prepared;
    const expected = operation === "create"
      ? {
        status: FEISHU_BASE_DEFAULT_STATUS,
        projectId: payload.projectId,
        fields: payload,
      }
      : {
        id: task.id,
        version: task.version,
        status: task.status,
        projectId: task.projectId,
        fields: changes,
      };
    const message = taskboardMessage({
      config: this.config,
      record,
      operation,
      taskId: operation === "create" ? null : task.id,
      version: operation === "create" ? null : task.version,
      payload,
      threadId: this.threadId,
      env: this.env,
      mappingVersion: this.mappingVersion,
    });
    let response;
    try {
      response = await this.taskboardStore.writeTask(message);
    } catch (error) {
      const possibleTaskId = operation === "create" ? currentTaskIdFromWrite(error?.details) : task.id;
      if (possibleTaskId) {
        const recovered = await this.taskboardStore.readTask(possibleTaskId);
        try {
          const readback = assertReadback({ expected, actual: recovered, operation });
          return { message, response: error, task: readback, recovered: true };
        } catch {
          // The write result is still unknown and the readback did not prove it.
        }
      }
      throw error;
    }
    const taskId = operation === "create" ? currentTaskIdFromWrite(response) : task.id;
    if (!taskId) fail("TASKBOARD_WRITE_UNCONFIRMED", "Taskboard write did not return a task id");
    const readback = await this.taskboardStore.readTask(taskId);
    const verified = assertReadback({ expected, actual: readback, operation });
    return { message, response, task: verified, recovered: false };
  }

  async #reconcileOne(prepared) {
    const { record, link, task, sourceChanged, taskboardChanged, sourceCurrent, taskboardCurrent } = prepared;
    if (!link) {
      const payload = createPayload(this.config, record);
      const write = await this.#writeAndRead({ prepared, operation: "create", payload });
      const observed = linkObservation(this.state, record, write.task, taskProjection(write.task));
      return {
        externalKey: record.externalKey,
        tableKey: record.tableKey,
        recordId: record.recordId,
        action: "created",
        taskId: write.task.id,
        idempotencyKey: write.message.idempotencyKey,
        expectedVersion: null,
        readback: write.task,
        link: observed,
      };
    }

    if (sourceChanged && taskboardChanged) {
      const conflict = typeof this.state.recordDualChangeConflict === "function"
        ? this.state.recordDualChangeConflict({
          externalKey: record.externalKey,
          taskId: task.id,
          baseline: {
            sourceVersion: link.lastSourceObservation?.version ?? null,
            sourceHash: link.lastSourceObservation?.hash ?? null,
            taskboardVersion: link.lastTaskboardObservation?.version ?? null,
            taskboardHash: link.lastTaskboardObservation?.hash ?? null,
          },
          source: sourceCurrent,
          taskboard: taskboardCurrent,
          details: { sourceTableKey: record.tableKey, recordId: record.recordId },
          createdAt: record.capturedAt,
        })
        : recordConflict(this.state, record, {
          taskId: task.id,
          reason: "DUAL_SIDE_CHANGE",
          source: sourceCurrent,
          taskboard: taskboardCurrent,
          details: { sourceTableKey: record.tableKey, recordId: record.recordId },
        });
      return {
        externalKey: record.externalKey,
        tableKey: record.tableKey,
        recordId: record.recordId,
        action: "conflict",
        taskId: task.id,
        conflict,
        writes: 0,
      };
    }

    if (taskboardChanged && !sourceChanged) {
      const observed = linkObservation(this.state, record, task, taskProjection(task));
      return {
        externalKey: record.externalKey,
        tableKey: record.tableKey,
        recordId: record.recordId,
        action: "outbound_mirror_required",
        taskId: task.id,
        taskboardVersion: task.version,
        link: observed,
        writes: 0,
      };
    }

    if (!sourceChanged && !taskboardChanged) {
      const observed = linkObservation(this.state, record, task, taskProjection(task));
      return {
        externalKey: record.externalKey,
        tableKey: record.tableKey,
        recordId: record.recordId,
        action: "unchanged",
        taskId: task.id,
        taskboardVersion: task.version,
        link: observed,
        writes: 0,
      };
    }

    const changes = updateChanges(this.config, record, task);
    if (Object.keys(changes).length === 0) {
      const observed = linkObservation(this.state, record, task, taskProjection(task));
      return {
        externalKey: record.externalKey,
        tableKey: record.tableKey,
        recordId: record.recordId,
        action: "unchanged",
        taskId: task.id,
        taskboardVersion: task.version,
        link: observed,
        writes: 0,
      };
    }
    const write = await this.#writeAndRead({
      prepared,
      operation: "update",
      payload: changes,
      changes,
    });
    const observed = linkObservation(this.state, record, write.task, taskProjection(write.task));
    return {
      externalKey: record.externalKey,
      tableKey: record.tableKey,
      recordId: record.recordId,
      action: "updated",
      taskId: write.task.id,
      idempotencyKey: write.message.idempotencyKey,
      expectedVersion: task.version,
      readback: write.task,
      changes,
      link: observed,
    };
  }

  async reconcile({ runId = randomUUID(), trigger = "manual", metadata = null } = {}) {
    requiredString(runId, "runId", 256);
    const startedAt = nowIso(this.clock);
    const existing = typeof this.state.getSyncRun === "function" ? this.state.getSyncRun(runId) : null;
    if (existing && existing.status !== "running") {
      return freeze({ runId, status: existing.status, replayed: true, summary: existing.summary, error: existing.error });
    }
    this.state.startSyncRun({
      runId,
      scope: {
        tables: [...FEISHU_BASE_TABLE_KEYS],
        mode: "read_only_inbound",
        excludedScopes: [...FEISHU_BASE_EXCLUDED_SCOPES],
      },
      metadata: { trigger, ...(metadata ?? {}) },
      startedAt,
    });

    let snapshot;
    try {
      snapshot = await this.readSnapshot({ capturedAt: startedAt });
    } catch (error) {
      const serialized = stateError(error);
      const summary = {
        version: FEISHU_BASE_INBOUND_VERSION,
        trigger,
        snapshotVerified: false,
        counts: { records: 0, created: 0, updated: 0, unchanged: 0, conflicts: 0, blocked: 0, writes: 0 },
        readScope: {
          tables: [...FEISHU_BASE_TABLE_KEYS],
          excludedScopes: [...FEISHU_BASE_EXCLUDED_SCOPES],
          excludedReads: 0,
          excludedWrites: 0,
          complete: false,
        },
        aiThreadsCreated: 0,
        aiRunsCreated: 0,
      };
      this.state.finishSyncRun(runId, { status: "failed", summary, error: serialized });
      return freeze({ runId, status: "failed", summary, error: serialized, writes: 0 });
    }

    let prepared;
    try {
      prepared = await this.#prepare(snapshot);
    } catch (error) {
      const serialized = stateError(error);
      const summary = {
        version: FEISHU_BASE_INBOUND_VERSION,
        trigger,
        snapshotVerified: true,
        counts: { records: snapshot.records.length, created: 0, updated: 0, unchanged: 0, conflicts: 0, blocked: 0, writes: 0 },
        readScope: snapshot.readScope,
        aiThreadsCreated: 0,
        aiRunsCreated: 0,
      };
      this.state.finishSyncRun(runId, { status: "failed", summary, error: serialized });
      return freeze({ runId, status: "failed", snapshot, summary, error: serialized, writes: 0 });
    }

    const results = [];
    let writes = 0;
    for (const item of prepared) {
      try {
        const result = await this.#reconcileOne(item);
        if (result.action === "created" || result.action === "updated") writes += 1;
        results.push(result);
      } catch (error) {
        const serialized = stateError(error);
        recordConflict(this.state, item.record, {
          taskId: item.task?.id ?? null,
          reason: serialized.code === "TASKBOARD_READBACK_MISMATCH"
            ? "TASKBOARD_READBACK_MISMATCH"
            : "TASKBOARD_WRITE_BLOCKED",
          source: item.sourceCurrent,
          taskboard: item.taskboardCurrent,
          details: serialized,
        });
        results.push({
          externalKey: item.record.externalKey,
          tableKey: item.record.tableKey,
          recordId: item.record.recordId,
          action: "blocked",
          taskId: item.task?.id ?? null,
          error: serialized,
        });
      }
    }

    const summary = makeSummary({ snapshot, writes, results, trigger });
    const status = summary.counts.conflicts > 0
      ? "conflict"
      : summary.counts.blocked > 0
        ? "blocked"
        : "completed";
    this.state.finishSyncRun(runId, { status, summary });
    return freeze({ runId, status, snapshot, summary, results, writes });
  }

  run(options = {}) {
    return this.reconcile(options);
  }

  runManual(options = {}) {
    return this.reconcile({ ...options, trigger: "manual" });
  }

  runOnce(options = {}) {
    return this.reconcile(options);
  }
}

export function createFeishuBaseInboundReconciler(options = {}) {
  return new FeishuBaseInboundReconciler(options);
}

export const createInboundReconciler = createFeishuBaseInboundReconciler;
export const reconcileFeishuBaseInbound = async (options = {}, runOptions = {}) => (
  createFeishuBaseInboundReconciler(options).reconcile(runOptions)
);
