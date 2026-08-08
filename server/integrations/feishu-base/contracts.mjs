import { createHash } from "node:crypto";

import {
  FEISHU_BASE_CONFIG_VERSION,
  FEISHU_BASE_MODE_PERMISSIONS,
  FEISHU_BASE_TABLE_KEYS,
  FEISHU_PERSONAL_LATEST_BOT,
  assertCurrentFeishuAppId,
  normalizeFeishuBaseConfig,
  resolveFeishuThreadId,
} from "./config.mjs";

export const FEISHU_BASE_MESSAGE_VERSION = FEISHU_BASE_CONFIG_VERSION;

export const FEISHU_BASE_MESSAGE_TYPES = Object.freeze({
  record: "feishu.base.record.v1",
  taskboardWrite: "feishu.base.taskboard-write.v1",
  hermesUpdate: "feishu.base.hermes-update.v1",
});

export const TASKBOARD_WRITE_OPERATIONS = Object.freeze([
  "create",
  "update",
  "move",
  "reassign",
  "archive",
  "restore",
]);

export class FeishuBaseContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuBaseContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FeishuBaseContractError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value, label, { maxLength = 2048 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_CONTRACT_VALUE", `${label} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    fail("INVALID_CONTRACT_VALUE", `${label} contains unsupported whitespace`);
  }
  return value;
}

function optionalString(value, label, options = {}) {
  if (value === undefined || value === null) return null;
  return requiredString(value, label, options);
}

function canonicalJsonValue(value, path = "$", seen = new Set()) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_JSON_VALUE", `${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("INVALID_JSON_VALUE", `${path} contains a value that is not JSON`);
  }
  if (seen.has(value)) fail("INVALID_JSON_VALUE", `${path} contains a cyclic value`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    if (!isPlainObject(value)) fail("INVALID_JSON_VALUE", `${path} must contain plain JSON objects`);
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(value[key], `${path}.${key}`, seen)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalJsonValue(value);
}

export const canonicalizeJson = canonicalJson;

export function hashCanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export const canonicalPayloadHash = hashCanonicalJson;

function immutableJson(value) {
  const copy = JSON.parse(canonicalJson(value));
  return deepFreeze(copy);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function immutableMessage(value) {
  return deepFreeze(value);
}

function encodeKeyPart(value, label) {
  const normalized = requiredString(value, label, { maxLength: 1024 });
  try {
    return encodeURIComponent(normalized);
  } catch {
    fail("INVALID_EXTERNAL_KEY", `${label} cannot be encoded`);
  }
}

export function createFeishuBaseExternalKey({ appToken, tableId, recordId } = {}) {
  return `feishu-base:${[
    encodeKeyPart(appToken, "appToken"),
    encodeKeyPart(tableId, "tableId"),
    encodeKeyPart(recordId, "recordId"),
  ].join(":")}`;
}

export const createStableExternalKey = createFeishuBaseExternalKey;

export function parseFeishuBaseExternalKey(value) {
  const key = requiredString(value, "externalKey", { maxLength: 4096 });
  const match = /^feishu-base:([^:]+):([^:]+):([^:]+)$/.exec(key);
  if (!match) fail("INVALID_EXTERNAL_KEY", "externalKey has an invalid shape");
  let parts;
  try {
    parts = match.slice(1).map((part) => decodeURIComponent(part));
  } catch {
    fail("INVALID_EXTERNAL_KEY", "externalKey contains invalid encoding");
  }
  const [appToken, tableId, recordId] = parts;
  if (createFeishuBaseExternalKey({ appToken, tableId, recordId }) !== key) {
    fail("INVALID_EXTERNAL_KEY", "externalKey is not canonical");
  }
  return Object.freeze({ appToken, tableId, recordId });
}

function normalizedExternalKey(value) {
  const key = requiredString(value, "externalKey", { maxLength: 4096 });
  parseFeishuBaseExternalKey(key);
  return key;
}

function assertMessageWithinConfig(message, config, tableField) {
  if (!config.appToken) fail("MISSING_APP_TOKEN", "An appToken is required for an enabled Feishu Base port");
  const identity = parseFeishuBaseExternalKey(message.externalKey);
  if (identity.appToken !== config.appToken) {
    fail("EXTERNAL_KEY_APP_MISMATCH", "externalKey does not belong to the configured Feishu app token");
  }
  const tableKey = message[tableField];
  if (!tableKey || !FEISHU_BASE_TABLE_KEYS.includes(tableKey)) {
    fail("TABLE_NOT_WHITELISTED", "A configured Feishu table key is required");
  }
  if (identity.tableId !== config.tableIds[tableKey]) {
    fail("EXTERNAL_KEY_TABLE_MISMATCH", "externalKey does not belong to a configured Feishu table");
  }
}

function normalizedMappingVersion(value) {
  const version = requiredString(value, "mappingVersion", { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    fail("INVALID_CONTRACT_VALUE", "mappingVersion contains unsupported characters");
  }
  return version;
}

export function createFeishuBaseIdempotencyKey({
  externalKey,
  mappingVersion = "v1",
  payload,
} = {}) {
  const sourceKey = normalizedExternalKey(externalKey);
  const version = normalizedMappingVersion(mappingVersion);
  const payloadHash = hashCanonicalJson(payload);
  const material = `${sourceKey}\n${version}\n${payloadHash}`;
  return `feishu-base-idempotency:v1:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export const createIdempotencyKey = createFeishuBaseIdempotencyKey;

function normalizeTableKey(value) {
  const tableKey = requiredString(value, "tableKey", { maxLength: 64 });
  if (!FEISHU_BASE_TABLE_KEYS.includes(tableKey)) {
    fail("TABLE_NOT_WHITELISTED", "Only the two configured Feishu Base tables are allowed");
  }
  return tableKey;
}

function normalizePayload(payload) {
  if (!isPlainObject(payload)) fail("INVALID_PAYLOAD", "Integration payload must be a plain JSON object");
  return immutableJson(payload);
}

function normalizePayloadIdentity({
  externalKey,
  mappingVersion,
  payload,
  idempotencyKey,
  payloadHash,
}) {
  const normalizedExternal = normalizedExternalKey(externalKey);
  const normalizedVersion = normalizedMappingVersion(mappingVersion);
  const immutablePayload = normalizePayload(payload);
  const calculatedHash = hashCanonicalJson(immutablePayload);
  if (payloadHash !== undefined && payloadHash !== calculatedHash) {
    fail("PAYLOAD_HASH_MISMATCH", "payloadHash does not match canonical payload");
  }
  const calculatedKey = createFeishuBaseIdempotencyKey({
    externalKey: normalizedExternal,
    mappingVersion: normalizedVersion,
    payload: immutablePayload,
  });
  if (idempotencyKey !== undefined && idempotencyKey !== calculatedKey) {
    fail("IDEMPOTENCY_KEY_MISMATCH", "idempotencyKey does not match the source and canonical payload");
  }
  return {
    externalKey: normalizedExternal,
    mappingVersion: normalizedVersion,
    payload: immutablePayload,
    payloadHash: calculatedHash,
    idempotencyKey: calculatedKey,
  };
}

export function createFeishuBaseRecordMessage({
  tableKey,
  tableId,
  recordId,
  appToken,
  mappingVersion = "v1",
  payload,
  sourceUpdatedAt = null,
  capturedAt = null,
} = {}) {
  const source = normalizePayloadIdentity({
    externalKey: createFeishuBaseExternalKey({ appToken, tableId, recordId }),
    mappingVersion,
    payload,
  });
  return immutableMessage({
    type: FEISHU_BASE_MESSAGE_TYPES.record,
    version: FEISHU_BASE_MESSAGE_VERSION,
    tableKey: normalizeTableKey(tableKey),
    tableId: requiredString(tableId, "tableId", { maxLength: 1024 }),
    recordId: requiredString(recordId, "recordId", { maxLength: 1024 }),
    externalKey: source.externalKey,
    mappingVersion: source.mappingVersion,
    idempotencyKey: source.idempotencyKey,
    payload: source.payload,
    payloadHash: source.payloadHash,
    sourceUpdatedAt: optionalString(sourceUpdatedAt, "sourceUpdatedAt", { maxLength: 128 }),
    capturedAt: optionalString(capturedAt, "capturedAt", { maxLength: 128 }),
  });
}

function normalizeOperation(value) {
  const operation = requiredString(value, "operation", { maxLength: 32 });
  if (!TASKBOARD_WRITE_OPERATIONS.includes(operation)) {
    fail("INVALID_TASKBOARD_OPERATION", "Unsupported Taskboard write operation");
  }
  return operation;
}

function normalizeVersion(value, operation) {
  if (operation === "create") {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 1)) {
      fail("INVALID_TASKBOARD_VERSION", "Taskboard create version must be omitted");
    }
    return null;
  }
  if (!Number.isInteger(value) || value < 1) {
    fail("INVALID_TASKBOARD_VERSION", "Taskboard writes require a positive expected version");
  }
  return value;
}

function normalizeTaskId(value, operation) {
  if (operation === "create") {
    if (value !== undefined && value !== null) requiredString(value, "taskId", { maxLength: 128 });
    return null;
  }
  return requiredString(value, "taskId", { maxLength: 128 });
}

export function createTaskboardWriteMessage({
  operation,
  taskId = null,
  version = null,
  externalKey,
  mappingVersion = "v1",
  payload,
  idempotencyKey = undefined,
  payloadHash = undefined,
  threadId = undefined,
  configuredThreadId = undefined,
  env = process.env,
  sourceTableKey = null,
} = {}) {
  const normalizedOperation = normalizeOperation(operation);
  const source = normalizePayloadIdentity({
    externalKey,
    mappingVersion,
    payload,
    idempotencyKey,
    payloadHash,
  });
  const resolvedThread = resolveFeishuThreadId({
    threadId,
    configuredThreadId,
    env,
  });
  return immutableMessage({
    type: FEISHU_BASE_MESSAGE_TYPES.taskboardWrite,
    version: FEISHU_BASE_MESSAGE_VERSION,
    operation: normalizedOperation,
    taskId: normalizeTaskId(taskId, normalizedOperation),
    expectedVersion: normalizeVersion(version, normalizedOperation),
    sourceTableKey: sourceTableKey === null ? null : normalizeTableKey(sourceTableKey),
    externalKey: source.externalKey,
    mappingVersion: source.mappingVersion,
    idempotencyKey: source.idempotencyKey,
    payload: source.payload,
    payloadHash: source.payloadHash,
    threadId: resolvedThread.threadId,
    threadIdSource: resolvedThread.source,
  });
}

export const createTaskboardMessage = createTaskboardWriteMessage;

export function createHermesUpdateMessage({
  externalKey,
  mappingVersion = "v1",
  payload,
  idempotencyKey = undefined,
  payloadHash = undefined,
  targetTableKey = null,
  targetRecordId = null,
} = {}) {
  const source = normalizePayloadIdentity({
    externalKey,
    mappingVersion,
    payload,
    idempotencyKey,
    payloadHash,
  });
  return immutableMessage({
    type: FEISHU_BASE_MESSAGE_TYPES.hermesUpdate,
    version: FEISHU_BASE_MESSAGE_VERSION,
    targetTableKey: targetTableKey === null ? null : normalizeTableKey(targetTableKey),
    targetRecordId: optionalString(targetRecordId, "targetRecordId", { maxLength: 1024 }),
    externalKey: source.externalKey,
    mappingVersion: source.mappingVersion,
    idempotencyKey: source.idempotencyKey,
    payload: source.payload,
    payloadHash: source.payloadHash,
  });
}

export const createHermesMessage = createHermesUpdateMessage;

function normalizeTaskboardMessage(message, { configuredThreadId, env } = {}) {
  if (!isPlainObject(message) || message.type !== FEISHU_BASE_MESSAGE_TYPES.taskboardWrite) {
    fail("INVALID_TASKBOARD_MESSAGE", "Taskboard store accepts only an immutable taskboard write message");
  }
  return createTaskboardWriteMessage({
    operation: message.operation,
    taskId: message.taskId,
    version: message.expectedVersion,
    sourceTableKey: message.sourceTableKey,
    externalKey: message.externalKey,
    mappingVersion: message.mappingVersion,
    payload: message.payload,
    idempotencyKey: message.idempotencyKey,
    payloadHash: message.payloadHash,
    threadId: message.threadId,
    configuredThreadId,
    env,
  });
}

function normalizeHermesMessage(message) {
  if (!isPlainObject(message) || message.type !== FEISHU_BASE_MESSAGE_TYPES.hermesUpdate) {
    fail("INVALID_HERMES_MESSAGE", "Hermes writer accepts only an immutable Hermes update message");
  }
  return createHermesUpdateMessage({
    targetTableKey: message.targetTableKey,
    targetRecordId: message.targetRecordId,
    externalKey: message.externalKey,
    mappingVersion: message.mappingVersion,
    payload: message.payload,
    idempotencyKey: message.idempotencyKey,
    payloadHash: message.payloadHash,
  });
}

export function createIdempotencyLedger() {
  const payloadHashes = new Map();
  return Object.freeze({
    assert(message) {
      const key = requiredString(message?.idempotencyKey, "idempotencyKey", { maxLength: 512 });
      const hash = requiredString(message?.payloadHash, "payloadHash", { maxLength: 128 });
      const previous = payloadHashes.get(key);
      if (previous !== undefined && previous !== hash) {
        fail("IDEMPOTENCY_CONFLICT", "The same idempotency key cannot carry different content");
      }
      payloadHashes.set(key, hash);
      return message;
    },
  });
}

function requirePortMethod(port, method, label) {
  if (!port || typeof port[method] !== "function") {
    fail("PORT_NOT_CONFIGURED", `${label}.${method} is required`);
  }
}

function normalizePortResult(value) {
  if (value === undefined) return undefined;
  return immutableJson(value);
}

function assertReadEnabled(config) {
  if (!FEISHU_BASE_MODE_PERMISSIONS[config.mode]?.baseRead) {
    fail(config.mode === "disabled" ? "PLUGIN_DISABLED" : "BASE_READ_DISABLED", "Feishu Base plugin reads are disabled");
  }
}

function assertTaskboardWriteMode(config) {
  if (config.mode === "disabled") fail("PLUGIN_DISABLED", "Feishu Base plugin is disabled");
  if (config.mode === "dry_run") return false;
  if (!FEISHU_BASE_MODE_PERMISSIONS[config.mode]?.taskboardWrite) {
    fail("TASKBOARD_WRITE_DISABLED", "Taskboard writes are disabled for this plugin mode");
  }
  return true;
}

function assertHermesWriteMode(config) {
  if (config.mode === "disabled") fail("PLUGIN_DISABLED", "Feishu Base plugin is disabled");
  if (config.mode === "dry_run") return false;
  if (!FEISHU_BASE_MODE_PERMISSIONS[config.mode]?.hermesWrite) {
    fail("HERMES_WRITE_DISABLED", "Hermes writes require mode apply");
  }
  return true;
}

export async function readBackFeishuAppId(reader) {
  requirePortMethod(reader, "readAppId", "baseReader");
  const response = await reader.readAppId();
  const appId = typeof response === "string" ? response : response?.appId;
  try {
    assertCurrentFeishuAppId(appId);
  } catch {
    fail("UNSUPPORTED_FEISHU_APP", "Feishu access must use personal-latest-bot");
  }
  return Object.freeze({
    appId: FEISHU_PERSONAL_LATEST_BOT.appId,
    appName: FEISHU_PERSONAL_LATEST_BOT.name,
  });
}

export function createFeishuBaseReaderPort({ config, reader } = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  const readAppId = () => {
    assertReadEnabled(normalizedConfig);
    return readBackFeishuAppId(reader);
  };
  const readSchema = async (tableKey) => {
    assertReadEnabled(normalizedConfig);
    requirePortMethod(reader, "readTableSchema", "baseReader");
    const key = normalizeTableKey(tableKey);
    const schema = await reader.readTableSchema(normalizedConfig.tableIds[key]);
    return immutableJson(schema);
  };
  const readRecords = async (tableKey) => {
    assertReadEnabled(normalizedConfig);
    requirePortMethod(reader, "readRecords", "baseReader");
    const key = normalizeTableKey(tableKey);
    const records = await reader.readRecords(normalizedConfig.tableIds[key]);
    if (!Array.isArray(records)) fail("INVALID_BASE_RESPONSE", "Base reader must return a record array");
    return immutableJson(records);
  };
  const readTable = async (tableKey) => {
    const key = normalizeTableKey(tableKey);
    return immutableMessage({
      type: "feishu.base.table-read.v1",
      version: FEISHU_BASE_MESSAGE_VERSION,
      tableKey: key,
      tableId: normalizedConfig.tableIds[key],
      schema: await readSchema(key),
      records: await readRecords(key),
    });
  };
  return Object.freeze({
    readBackAppId: readAppId,
    readSchema,
    readRecords,
    readTable,
  });
}

export function createTaskboardStorePort({ config, store, env = process.env, ledger = createIdempotencyLedger() } = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  const readTask = async (taskId) => {
    if (normalizedConfig.mode === "disabled") fail("PLUGIN_DISABLED", "Feishu Base plugin is disabled");
    requirePortMethod(store, "readTask", "taskboardStore");
    return normalizePortResult(await store.readTask(requiredString(taskId, "taskId", { maxLength: 128 })));
  };
  const writeTask = async (message) => {
    const normalizedMessage = normalizeTaskboardMessage(message, {
      configuredThreadId: normalizedConfig.threadId,
      env,
    });
    assertMessageWithinConfig(normalizedMessage, normalizedConfig, "sourceTableKey");
    ledger.assert(normalizedMessage);
    if (!assertTaskboardWriteMode(normalizedConfig)) {
      return immutableMessage({
        type: "feishu.base.taskboard-write.receipt.v1",
        version: FEISHU_BASE_MESSAGE_VERSION,
        status: "dry_run",
        operation: normalizedMessage.operation,
        idempotencyKey: normalizedMessage.idempotencyKey,
        payloadHash: normalizedMessage.payloadHash,
        threadId: normalizedMessage.threadId,
      });
    }
    requirePortMethod(store, "writeTask", "taskboardStore");
    return normalizePortResult(await store.writeTask(normalizedMessage));
  };
  return Object.freeze({ readTask, writeTask });
}

export function createHermesWriterPort({ config, writer, ledger = createIdempotencyLedger() } = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  const send = async (message) => {
    const normalizedMessage = normalizeHermesMessage(message);
    assertMessageWithinConfig(normalizedMessage, normalizedConfig, "targetTableKey");
    ledger.assert(normalizedMessage);
    if (!assertHermesWriteMode(normalizedConfig)) {
      return immutableMessage({
        type: "feishu.base.hermes-write.receipt.v1",
        version: FEISHU_BASE_MESSAGE_VERSION,
        status: "dry_run",
        idempotencyKey: normalizedMessage.idempotencyKey,
        payloadHash: normalizedMessage.payloadHash,
      });
    }
    requirePortMethod(writer, "send", "hermesWriter");
    return normalizePortResult(await writer.send(normalizedMessage));
  };
  return Object.freeze({ send });
}

export function createFeishuBasePorts({
  config,
  baseReader,
  taskboardStore,
  hermesWriter,
  env = process.env,
} = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  const ledger = createIdempotencyLedger();
  return Object.freeze({
    mode: normalizedConfig.mode,
    baseReader: createFeishuBaseReaderPort({ config: normalizedConfig, reader: baseReader }),
    taskboardStore: createTaskboardStorePort({
      config: normalizedConfig,
      store: taskboardStore,
      env,
      ledger,
    }),
    hermesWriter: createHermesWriterPort({
      config: normalizedConfig,
      writer: hermesWriter,
      ledger,
    }),
  });
}

export const createFeishuBasePluginPorts = createFeishuBasePorts;
