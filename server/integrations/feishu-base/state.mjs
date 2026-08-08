import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  createFeishuBaseIdempotencyKey,
  hashCanonicalJson,
  parseFeishuBaseExternalKey,
} from "./contracts.mjs";

export const FEISHU_BASE_STATE_SCHEMA_VERSION = 1;
export const FEISHU_BASE_STATE_DEFAULT_FILENAME = "feishu-base-sync.sqlite";

const SOURCE_TABLE_KEYS = new Set(["productIdeas", "requirements"]);
const RUN_STATUSES = new Set(["running", "completed", "failed", "blocked", "conflict"]);
const OUTBOX_STATUSES = new Set([
  "pending",
  "sent",
  "acked",
  "readback_pending",
  "readback_verified",
  "conflict",
  "blocked",
]);
const ATTEMPT_STATUSES = new Set([
  "started",
  "sent",
  "succeeded",
  "failed",
  "unknown",
  "pending",
]);

export class FeishuBaseStateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FeishuBaseStateError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new FeishuBaseStateError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function result(value) {
  return deepFreeze(value);
}

function requiredString(value, label, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_STATE_VALUE", `${label} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    fail("INVALID_STATE_VALUE", `${label} contains unsupported whitespace`);
  }
  return value;
}

function optionalString(value, label, maxLength = 4096) {
  if (value === undefined || value === null) return null;
  return requiredString(value, label, maxLength);
}

function normalizeExternalKey(value) {
  const externalKey = requiredString(value, "externalKey");
  try {
    parseFeishuBaseExternalKey(externalKey);
  } catch (error) {
    fail("INVALID_EXTERNAL_KEY", error?.message ?? "externalKey is not canonical", {
      cause: error?.code ?? "INVALID_EXTERNAL_KEY",
    });
  }
  return externalKey;
}

function normalizeTaskId(value) {
  return requiredString(value, "taskId", 256);
}

function normalizeRunId(value) {
  return requiredString(value, "runId", 256);
}

function normalizeHash(value, label = "payloadHash") {
  return optionalString(value, label, 512);
}

function normalizeTimestamp(value, label, fallback = new Date()) {
  const candidate = value === undefined || value === null ? fallback : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) fail("INVALID_STATE_VALUE", `${label} must be a valid timestamp`);
  return date.toISOString();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function encodeJson(value, label, { nullable = true } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    fail("INVALID_STATE_VALUE", `${label} is required`);
  }
  try {
    return canonicalJson(value);
  } catch (error) {
    fail("INVALID_STATE_JSON", `${label} must contain plain JSON`, {
      cause: error?.code ?? error?.message,
    });
  }
}

function decodeJson(value, label) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail("CORRUPT_STATE", `${label} contains invalid JSON`, { cause: error?.message });
  }
}

function versionJson(value, label) {
  if (value === undefined || value === null) return null;
  return encodeJson(value, label);
}

function versionFromJson(value, label) {
  return decodeJson(value, label);
}

function valueFrom(input, ...keys) {
  for (const key of keys) {
    if (hasOwn(input, key) && input[key] !== undefined && input[key] !== null) return input[key];
  }
  return null;
}

function valueProvided(input, ...keys) {
  return keys.some((key) => hasOwn(input, key) && input[key] !== undefined);
}

function normalizeBoolean(value, label, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") fail("INVALID_STATE_VALUE", `${label} must be boolean`);
  return value;
}

function normalizeRunStatus(value) {
  const status = requiredString(value, "status", 64);
  if (!RUN_STATUSES.has(status)) fail("INVALID_RUN_STATUS", `Unsupported sync run status: ${status}`);
  return status;
}

function normalizeOutboxStatus(value) {
  const status = requiredString(value, "status", 64);
  if (!OUTBOX_STATUSES.has(status)) fail("INVALID_OUTBOX_STATUS", `Unsupported outbox status: ${status}`);
  return status;
}

function normalizeAttemptStatus(value) {
  const status = requiredString(value, "status", 64);
  if (!ATTEMPT_STATUSES.has(status)) fail("INVALID_ATTEMPT_STATUS", `Unsupported attempt status: ${status}`);
  return status;
}

function normalizeTableKey(value) {
  if (value === undefined || value === null) return null;
  const tableKey = requiredString(value, "tableKey", 64);
  if (!SOURCE_TABLE_KEYS.has(tableKey)) fail("TABLE_NOT_WHITELISTED", `Unsupported Feishu Base table: ${tableKey}`);
  return tableKey;
}

function normalizePayloadHash({ payload, payloadHash, label = "payloadHash" }) {
  const calculated = payload === undefined || payload === null ? null : hashCanonicalJson(payload);
  const supplied = normalizeHash(payloadHash, label);
  if (supplied !== null && calculated !== null && supplied !== calculated) {
    fail("PAYLOAD_HASH_MISMATCH", `${label} does not match canonical payload`);
  }
  return supplied ?? calculated;
}

function firstNonNull(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function changedSide(baseline, current) {
  if (!current) return false;
  const currentHash = current.hash ?? current.payloadHash ?? null;
  const baselineHash = baseline?.hash ?? baseline?.payloadHash ?? null;
  if (currentHash !== null && baselineHash !== null) return currentHash !== baselineHash;
  const currentVersion = current.version ?? null;
  const baselineVersion = baseline?.version ?? null;
  if (currentVersion !== null && baselineVersion !== null) {
    return canonicalJson(currentVersion) !== canonicalJson(baselineVersion);
  }
  return currentHash !== null || currentVersion !== null;
}

function normalizeSideState(value, label) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail("INVALID_STATE_VALUE", `${label} must be an object`);
  const version = valueFrom(value, "version", "sourceVersion", "baseVersion", "taskboardVersion");
  const hash = valueFrom(value, "hash", "payloadHash", "sourceHash", "baseHash", "taskboardHash");
  const payload = hasOwn(value, "payload") ? value.payload : undefined;
  return {
    version: version === null ? null : cloneJson(version),
    hash: normalizePayloadHash({ payload, payloadHash: hash, label: `${label}.hash` }),
    payload: payload === undefined ? null : cloneJson(payload),
  };
}

function parseAckFields(input, fallback = {}) {
  const ack = input?.ack ?? input?.hermesAck ?? input ?? {};
  if (!isPlainObject(ack)) fail("INVALID_ACK", "Hermes ACK must be a JSON object");
  const idempotencyKey = valueFrom(ack, "idempotencyKey", "idempotency_key")
    ?? valueFrom(input, "idempotencyKey", "idempotency_key")
    ?? fallback.idempotencyKey
    ?? null;
  const externalKey = valueFrom(ack, "externalKey", "external_key")
    ?? valueFrom(input, "externalKey", "external_key")
    ?? fallback.externalKey
    ?? null;
  const payloadHash = valueFrom(ack, "payloadHash", "payload_hash")
    ?? valueFrom(input, "payloadHash", "payload_hash")
    ?? fallback.payloadHash
    ?? null;
  const messageId = valueFrom(ack, "messageId", "message_id") ?? null;
  const success = ack.success ?? ack.ok ?? ack.status === "success";
  const acknowledgedAt = normalizeTimestamp(
    valueFrom(ack, "acknowledgedAt", "acknowledged_at", "ackedAt", "acked_at"),
    "acknowledgedAt",
  );
  return {
    raw: cloneJson(ack),
    idempotencyKey: idempotencyKey === null ? null : requiredString(idempotencyKey, "ack.idempotencyKey", 512),
    externalKey: externalKey === null ? null : normalizeExternalKey(externalKey),
    payloadHash: payloadHash === null ? null : normalizeHash(payloadHash, "ack.payloadHash"),
    messageId: messageId === null ? null : requiredString(messageId, "ack.messageId", 512),
    success: Boolean(success),
    acknowledgedAt,
    sourceVersion: versionJson(valueFrom(ack, "sourceVersion", "baseVersion", "source_version", "base_version"), "ack.sourceVersion"),
    sourceHash: normalizeHash(valueFrom(ack, "sourceHash", "baseHash", "source_hash", "base_hash"), "ack.sourceHash"),
    taskboardVersion: versionJson(valueFrom(ack, "taskboardVersion", "taskboard_version"), "ack.taskboardVersion"),
    taskboardHash: normalizeHash(valueFrom(ack, "taskboardHash", "taskboard_hash"), "ack.taskboardHash"),
  };
}

function rowJson(row, key, label) {
  if (!row) return null;
  return decodeJson(row[key], label);
}

function rowToRun(row) {
  if (!row) return null;
  return result({
    runId: row.run_id,
    status: row.status,
    scope: rowJson(row, "scope_json", "sync run scope"),
    metadata: rowJson(row, "metadata_json", "sync run metadata"),
    summary: rowJson(row, "summary_json", "sync run summary"),
    error: rowJson(row, "error_json", "sync run error"),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
}

function rowToLink(row, latestReadback = null) {
  if (!row) return null;
  return result({
    externalKey: row.external_key,
    taskId: row.task_id,
    tableKey: row.source_table_key,
    recordId: row.source_record_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastSourceObservation: {
      version: versionFromJson(row.last_source_version_json, "source link source version"),
      hash: row.last_source_hash,
      payload: rowJson(row, "last_source_payload_json", "source link source payload"),
    },
    lastTaskboardObservation: {
      version: versionFromJson(row.last_taskboard_version_json, "source link Taskboard version"),
      hash: row.last_taskboard_hash,
      payload: rowJson(row, "last_taskboard_payload_json", "source link Taskboard payload"),
    },
    lastReadback: latestReadback,
  });
}

function rowToBaseline(row) {
  if (!row) return null;
  const sourceVersion = versionFromJson(row.source_version_json, "baseline source version");
  const taskboardVersion = versionFromJson(row.taskboard_version_json, "baseline Taskboard version");
  return result({
    externalKey: row.external_key,
    taskId: row.task_id,
    sourceVersion,
    baseVersion: sourceVersion,
    sourceHash: row.source_hash,
    baseHash: row.source_hash,
    sourcePayload: rowJson(row, "source_payload_json", "baseline source payload"),
    taskboardVersion,
    taskboardHash: row.taskboard_hash,
    taskboardPayload: rowJson(row, "taskboard_payload_json", "baseline Taskboard payload"),
    idempotencyKey: row.idempotency_key,
    committedAt: row.committed_at,
    hermesAck: rowJson(row, "hermes_ack_json", "baseline Hermes ACK"),
    taskboardReadback: rowJson(row, "taskboard_readback_json", "baseline Taskboard readback"),
    baseReadback: rowJson(row, "base_readback_json", "baseline Base readback"),
  });
}

function rowToOutbox(row) {
  if (!row) return null;
  return result({
    outboxId: row.outbox_id,
    idempotencyKey: row.idempotency_key,
    externalKey: row.external_key,
    taskId: row.task_id,
    mappingVersion: row.mapping_version,
    payloadHash: row.payload_hash,
    message: rowJson(row, "message_json", "outbox message"),
    sourceVersion: versionFromJson(row.source_version_json, "outbox source version"),
    sourceHash: row.source_hash,
    sourcePayload: rowJson(row, "source_payload_json", "outbox source payload"),
    taskboardVersion: versionFromJson(row.taskboard_version_json, "outbox Taskboard version"),
    taskboardHash: row.taskboard_hash,
    taskboardPayload: rowJson(row, "taskboard_payload_json", "outbox Taskboard payload"),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAttemptAt: row.last_attempt_at,
    verifiedAt: row.verified_at,
    lastError: rowJson(row, "last_error_json", "outbox last error"),
  });
}

function rowToAttempt(row) {
  if (!row) return null;
  return result({
    attemptId: row.attempt_id,
    outboxId: row.outbox_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
    result: rowJson(row, "result_json", "outbox attempt result"),
    error: rowJson(row, "error_json", "outbox attempt error"),
  });
}

function rowToAck(row) {
  if (!row) return null;
  return result({
    ackId: row.ack_id,
    outboxId: row.outbox_id,
    idempotencyKey: row.idempotency_key,
    externalKey: row.external_key,
    payloadHash: row.payload_hash,
    messageId: row.message_id,
    success: Boolean(row.success),
    matched: Boolean(row.matched),
    acknowledgedAt: row.acknowledged_at,
    sourceVersion: versionFromJson(row.source_version_json, "Hermes ACK source version"),
    sourceHash: row.source_hash,
    taskboardVersion: versionFromJson(row.taskboard_version_json, "Hermes ACK Taskboard version"),
    taskboardHash: row.taskboard_hash,
    raw: rowJson(row, "raw_json", "Hermes ACK"),
  });
}

function rowToReadback(row) {
  if (!row) return null;
  return result({
    readbackId: row.readback_id,
    outboxId: row.outbox_id,
    kind: row.kind,
    side: row.side,
    externalKey: row.external_key,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    success: Boolean(row.success),
    independent: Boolean(row.independent),
    matched: Boolean(row.matched),
    version: versionFromJson(row.version_json, "readback version"),
    payloadHash: row.payload_hash,
    payload: rowJson(row, "payload_json", "readback payload"),
    observedAt: row.observed_at,
    details: rowJson(row, "details_json", "readback details"),
    raw: rowJson(row, "raw_json", "readback response"),
  });
}

function rowToConflict(row) {
  if (!row) return null;
  return result({
    conflictId: row.conflict_id,
    externalKey: row.external_key,
    taskId: row.task_id,
    outboxId: row.outbox_id,
    reason: row.reason,
    status: row.status,
    baseline: rowJson(row, "baseline_json", "conflict baseline"),
    source: rowJson(row, "source_json", "conflict source state"),
    taskboard: rowJson(row, "taskboard_json", "conflict Taskboard state"),
    details: rowJson(row, "details_json", "conflict details"),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: rowJson(row, "resolution_json", "conflict resolution"),
  });
}

export class FeishuBaseStateStore {
  constructor(options = {}) {
    const normalized = typeof options === "string" ? { databasePath: options } : options;
    if (!isPlainObject(normalized)) fail("INVALID_STATE_OPTIONS", "State store options must be an object");

    const explicitPath = normalized.databasePath ?? normalized.dbPath ?? normalized.statePath ?? null;
    const dataDirectory = normalized.dataDirectory
      ?? normalized.dataDir
      ?? normalized.directory
      ?? null;
    if (explicitPath === null && dataDirectory === null) {
      fail("MISSING_DATA_DIRECTORY", "An independent plugin data directory or databasePath is required");
    }
    const databasePath = explicitPath === null
      ? resolve(dataDirectory, normalized.filename ?? FEISHU_BASE_STATE_DEFAULT_FILENAME)
      : explicitPath === ":memory:" ? explicitPath : resolve(explicitPath);
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
    this.closed = false;
    this.#initialize();
  }

  #initialize() {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'conflict')),
        scope_json TEXT NOT NULL,
        metadata_json TEXT,
        summary_json TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS source_links (
        external_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source_table_key TEXT,
        source_record_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_source_version_json TEXT,
        last_source_hash TEXT,
        last_source_payload_json TEXT,
        last_taskboard_version_json TEXT,
        last_taskboard_hash TEXT,
        last_taskboard_payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS source_links_task_id_idx ON source_links(task_id);

      CREATE TABLE IF NOT EXISTS sync_baselines (
        external_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        idempotency_key TEXT,
        source_version_json TEXT,
        source_hash TEXT,
        source_payload_json TEXT,
        taskboard_version_json TEXT,
        taskboard_hash TEXT,
        taskboard_payload_json TEXT,
        committed_at TEXT NOT NULL,
        hermes_ack_json TEXT NOT NULL,
        taskboard_readback_json TEXT,
        base_readback_json TEXT NOT NULL,
        FOREIGN KEY (external_key) REFERENCES source_links(external_key)
      );

      CREATE TABLE IF NOT EXISTS sync_readbacks (
        readback_id TEXT PRIMARY KEY,
        outbox_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('base', 'taskboard')),
        side TEXT NOT NULL CHECK (side IN ('source', 'taskboard')),
        external_key TEXT NOT NULL,
        task_id TEXT,
        idempotency_key TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        independent INTEGER NOT NULL CHECK (independent IN (0, 1)),
        matched INTEGER NOT NULL CHECK (matched IN (0, 1)),
        version_json TEXT,
        payload_hash TEXT,
        payload_json TEXT,
        observed_at TEXT NOT NULL,
        details_json TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_readbacks_latest_idx
        ON sync_readbacks(external_key, observed_at DESC, readback_id DESC);
      CREATE INDEX IF NOT EXISTS sync_readbacks_outbox_idx
        ON sync_readbacks(outbox_id, kind, matched, observed_at DESC);

      CREATE TABLE IF NOT EXISTS sync_conflicts (
        conflict_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        external_key TEXT NOT NULL,
        task_id TEXT,
        outbox_id TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved')),
        baseline_json TEXT,
        source_json TEXT,
        taskboard_json TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_json TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_conflicts_unresolved_idx
        ON sync_conflicts(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS sync_conflicts_external_idx
        ON sync_conflicts(external_key, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS sync_outbox (
        outbox_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        external_key TEXT NOT NULL,
        task_id TEXT,
        mapping_version TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        message_json TEXT NOT NULL,
        source_version_json TEXT,
        source_hash TEXT,
        source_payload_json TEXT,
        taskboard_version_json TEXT,
        taskboard_hash TEXT,
        taskboard_payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'acked', 'readback_pending', 'readback_verified', 'conflict', 'blocked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_attempt_at TEXT,
        verified_at TEXT,
        last_error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx ON sync_outbox(status, created_at);
      CREATE INDEX IF NOT EXISTS sync_outbox_external_idx ON sync_outbox(external_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS sync_outbox_attempts (
        attempt_id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'sent', 'succeeded', 'failed', 'unknown', 'pending')),
        attempted_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT,
        error_json TEXT,
        UNIQUE (outbox_id, attempt_number)
      );
      CREATE INDEX IF NOT EXISTS sync_outbox_attempts_outbox_idx
        ON sync_outbox_attempts(outbox_id, attempt_number DESC);

      CREATE TABLE IF NOT EXISTS sync_hermes_acks (
        ack_id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        external_key TEXT,
        payload_hash TEXT,
        message_id TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        matched INTEGER NOT NULL CHECK (matched IN (0, 1)),
        acknowledged_at TEXT NOT NULL,
        source_version_json TEXT,
        source_hash TEXT,
        taskboard_version_json TEXT,
        taskboard_hash TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sync_hermes_acks_outbox_idx
        ON sync_hermes_acks(outbox_id, matched, success, acknowledged_at DESC);
    `);
    const baselineColumns = new Set(this.database.prepare("PRAGMA table_info(sync_baselines)").all().map((column) => column.name));
    if (!baselineColumns.has("idempotency_key")) {
      this.database.exec("ALTER TABLE sync_baselines ADD COLUMN idempotency_key TEXT");
    }
    if (!baselineColumns.has("taskboard_readback_json")) {
      this.database.exec("ALTER TABLE sync_baselines ADD COLUMN taskboard_readback_json TEXT");
    }
    const version = this.database.prepare("PRAGMA user_version").get().user_version;
    if (version > FEISHU_BASE_STATE_SCHEMA_VERSION) {
      fail("UNSUPPORTED_STATE_SCHEMA", `Unsupported plugin state schema version: ${version}`);
    }
    if (version < FEISHU_BASE_STATE_SCHEMA_VERSION) {
      this.database.exec(`PRAGMA user_version = ${FEISHU_BASE_STATE_SCHEMA_VERSION}`);
    }
  }

  #assertOpen() {
    if (this.closed) fail("STATE_STORE_CLOSED", "Feishu Base state store is closed");
  }

  #transaction(callback) {
    this.#assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original state error.
      }
      throw error;
    }
  }

  #getOutboxRow(outboxId, idempotencyKey = null) {
    if (outboxId !== null) {
      return this.database.prepare("SELECT * FROM sync_outbox WHERE outbox_id = ?").get(outboxId);
    }
    return this.database.prepare("SELECT * FROM sync_outbox WHERE idempotency_key = ?").get(idempotencyKey);
  }

  #getLatestReadbackRow(externalKey) {
    return this.database.prepare(`
      SELECT * FROM sync_readbacks
      WHERE external_key = ?
      ORDER BY observed_at DESC, readback_id DESC
      LIMIT 1
    `).get(externalKey);
  }

  #getLinkRow(externalKey) {
    return this.database.prepare("SELECT * FROM source_links WHERE external_key = ?").get(externalKey);
  }

  #getBaselineRow(externalKey) {
    return this.database.prepare("SELECT * FROM sync_baselines WHERE external_key = ?").get(externalKey);
  }

  #insertConflictNoTx({
    externalKey,
    taskId = null,
    outboxId = null,
    reason,
    baseline = null,
    source = null,
    taskboard = null,
    details = null,
    createdAt = undefined,
  }) {
    const key = normalizeExternalKey(externalKey);
    const normalizedReason = requiredString(reason, "reason", 256);
    const link = this.#getLinkRow(key);
    const normalizedTaskId = taskId === null || taskId === undefined
      ? link?.task_id ?? null
      : normalizeTaskId(taskId);
    const normalizedBaseline = baseline === null || baseline === undefined ? null : cloneJson(baseline);
    const normalizedSource = source === null || source === undefined ? null : normalizeSideState(source, "source");
    const normalizedTaskboard = taskboard === null || taskboard === undefined
      ? null
      : normalizeSideState(taskboard, "taskboard");
    const normalizedDetails = details === null || details === undefined ? null : cloneJson(details);
    const fingerprint = hashCanonicalJson({
      externalKey: key,
      taskId: normalizedTaskId,
      outboxId,
      reason: normalizedReason,
      baseline: normalizedBaseline,
      source: normalizedSource,
      taskboard: normalizedTaskboard,
      details: normalizedDetails,
    });
    const conflictId = randomUUID();
    const created = normalizeTimestamp(createdAt, "createdAt");
    this.database.prepare(`
      INSERT INTO sync_conflicts (
        conflict_id, fingerprint, external_key, task_id, outbox_id, reason, status,
        baseline_json, source_json, taskboard_json, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO NOTHING
    `).run(
      conflictId,
      fingerprint,
      key,
      normalizedTaskId,
      outboxId,
      normalizedReason,
      encodeJson(normalizedBaseline, "baseline"),
      encodeJson(normalizedSource, "source"),
      encodeJson(normalizedTaskboard, "taskboard"),
      encodeJson(normalizedDetails, "details"),
      created,
    );
    const row = this.database.prepare("SELECT * FROM sync_conflicts WHERE fingerprint = ?").get(fingerprint);
    return rowToConflict(row);
  }

  #updateOutboxStatusNoTx(outboxId, status, {
    updatedAt = undefined,
    lastError = undefined,
    verifiedAt = undefined,
    lastAttemptAt = undefined,
  } = {}) {
    const normalizedStatus = normalizeOutboxStatus(status);
    const now = normalizeTimestamp(updatedAt, "updatedAt");
    const row = this.database.prepare("SELECT * FROM sync_outbox WHERE outbox_id = ?").get(outboxId);
    if (!row) fail("OUTBOX_NOT_FOUND", `Unknown outbox item: ${outboxId}`);
    const errorJson = lastError === undefined ? row.last_error_json : encodeJson(lastError, "lastError");
    const finalVerifiedAt = verifiedAt === undefined
      ? row.verified_at
      : verifiedAt === null ? null : normalizeTimestamp(verifiedAt, "verifiedAt");
    const finalAttemptAt = lastAttemptAt === undefined
      ? row.last_attempt_at
      : lastAttemptAt === null ? null : normalizeTimestamp(lastAttemptAt, "lastAttemptAt");
    this.database.prepare(`
      UPDATE sync_outbox
      SET status = ?, updated_at = ?, last_error_json = ?, verified_at = ?, last_attempt_at = ?
      WHERE outbox_id = ?
    `).run(normalizedStatus, now, errorJson, finalVerifiedAt, finalAttemptAt, outboxId);
    return this.database.prepare("SELECT * FROM sync_outbox WHERE outbox_id = ?").get(outboxId);
  }

  #baselineCandidateNoTx(outbox, ack, baseReadback, taskboardReadback) {
    return {
      externalKey: outbox.external_key,
      taskId: outbox.task_id ?? this.#getLinkRow(outbox.external_key)?.task_id ?? null,
      idempotencyKey: outbox.idempotency_key,
      sourceVersion: firstNonNull(
        versionFromJson(baseReadback?.version_json, "base readback version"),
        versionFromJson(ack?.source_version_json, "ACK source version"),
        versionFromJson(outbox.source_version_json, "outbox source version"),
      ),
      sourceHash: firstNonNull(
        baseReadback?.payload_hash,
        ack?.source_hash,
        outbox.source_hash,
      ),
      sourcePayload: firstNonNull(
        rowJson(baseReadback, "payload_json", "base readback payload"),
        rowJson(outbox, "source_payload_json", "outbox source payload"),
      ),
      taskboardVersion: firstNonNull(
        versionFromJson(taskboardReadback?.version_json, "Taskboard readback version"),
        versionFromJson(ack?.taskboard_version_json, "ACK Taskboard version"),
        versionFromJson(outbox.taskboard_version_json, "outbox Taskboard version"),
      ),
      taskboardHash: firstNonNull(
        taskboardReadback?.payload_hash,
        ack?.taskboard_hash,
        outbox.taskboard_hash,
      ),
      taskboardPayload: firstNonNull(
        rowJson(taskboardReadback, "payload_json", "Taskboard readback payload"),
        rowJson(outbox, "taskboard_payload_json", "outbox Taskboard payload"),
      ),
      taskboardReadback: taskboardReadback ? rowToReadback(taskboardReadback) : null,
    };
  }

  #upsertBaselineNoTx(candidate, ack, readback, committedAt) {
    const externalKey = normalizeExternalKey(candidate.externalKey);
    const taskId = candidate.taskId === null || candidate.taskId === undefined
      ? this.#getLinkRow(externalKey)?.task_id ?? null
      : normalizeTaskId(candidate.taskId);
    if (taskId === null) fail("MISSING_TASK_ID", "A successful baseline requires a linked Taskboard task");
    const link = this.#getLinkRow(externalKey);
    if (!link) {
      fail("SOURCE_LINK_NOT_FOUND", "A successful baseline requires an existing external-key link");
    }
    if (link.task_id !== taskId) {
      fail("SOURCE_LINK_CONFLICT", "The external key is already bound to another Taskboard task");
    }
    const existing = this.#getBaselineRow(externalKey);
    const sourceVersion = versionJson(
      candidate.sourceVersion ?? (existing ? versionFromJson(existing.source_version_json, "existing source version") : null),
      "baseline.sourceVersion",
    );
    const sourceHash = candidate.sourceHash ?? existing?.source_hash ?? null;
    const sourcePayload = encodeJson(
      candidate.sourcePayload ?? (existing ? rowJson(existing, "source_payload_json", "existing source payload") : null),
      "baseline.sourcePayload",
    );
    const taskboardVersion = versionJson(
      candidate.taskboardVersion ?? (existing ? versionFromJson(existing.taskboard_version_json, "existing Taskboard version") : null),
      "baseline.taskboardVersion",
    );
    const taskboardHash = candidate.taskboardHash ?? existing?.taskboard_hash ?? null;
    const taskboardPayload = encodeJson(
      candidate.taskboardPayload ?? (existing ? rowJson(existing, "taskboard_payload_json", "existing Taskboard payload") : null),
      "baseline.taskboardPayload",
    );
    const idempotencyKey = candidate.idempotencyKey ?? existing?.idempotency_key ?? null;
    const taskboardReadback = encodeJson(
      candidate.taskboardReadback ?? (existing ? rowJson(existing, "taskboard_readback_json", "existing Taskboard readback") : null),
      "baseline.taskboardReadback",
    );
    const committed = normalizeTimestamp(committedAt, "committedAt");
    this.database.prepare(`
      INSERT INTO sync_baselines (
        external_key, task_id, idempotency_key, source_version_json, source_hash, source_payload_json,
        taskboard_version_json, taskboard_hash, taskboard_payload_json,
        committed_at, hermes_ack_json, taskboard_readback_json, base_readback_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_key) DO UPDATE SET
        task_id = excluded.task_id,
        idempotency_key = excluded.idempotency_key,
        source_version_json = excluded.source_version_json,
        source_hash = excluded.source_hash,
        source_payload_json = excluded.source_payload_json,
        taskboard_version_json = excluded.taskboard_version_json,
        taskboard_hash = excluded.taskboard_hash,
        taskboard_payload_json = excluded.taskboard_payload_json,
        committed_at = excluded.committed_at,
        hermes_ack_json = excluded.hermes_ack_json,
        taskboard_readback_json = excluded.taskboard_readback_json,
        base_readback_json = excluded.base_readback_json
    `).run(
      externalKey,
      taskId,
      idempotencyKey,
      sourceVersion,
      sourceHash,
      sourcePayload,
      taskboardVersion,
      taskboardHash,
      taskboardPayload,
      committed,
      encodeJson(ack, "baseline.hermesAck", { nullable: false }),
      taskboardReadback,
      encodeJson(readback, "baseline.baseReadback", { nullable: false }),
    );
    return this.#getBaselineRow(externalKey);
  }

  #tryAdvanceBaselineNoTx(outboxId, committedAt = undefined) {
    const outbox = this.database.prepare("SELECT * FROM sync_outbox WHERE outbox_id = ?").get(outboxId);
    if (!outbox) fail("OUTBOX_NOT_FOUND", `Unknown outbox item: ${outboxId}`);
    const ack = this.database.prepare(`
      SELECT * FROM sync_hermes_acks
      WHERE outbox_id = ? AND success = 1 AND matched = 1
      ORDER BY acknowledged_at DESC, ack_id DESC
      LIMIT 1
    `).get(outboxId);
    const baseReadback = this.database.prepare(`
      SELECT * FROM sync_readbacks
      WHERE outbox_id = ? AND kind = 'base' AND side = 'source'
        AND success = 1 AND independent = 1 AND matched = 1
      ORDER BY observed_at DESC, readback_id DESC
      LIMIT 1
    `).get(outboxId);
    if (!ack || !baseReadback) return { advanced: false, outbox, baseline: this.#getBaselineRow(outbox.external_key) };

    const unresolved = this.database.prepare(`
      SELECT 1 FROM sync_conflicts
      WHERE external_key = ? AND status = 'unresolved'
        AND (outbox_id IS NULL OR outbox_id = ?)
      LIMIT 1
    `).get(outbox.external_key, outboxId);
    if (unresolved) {
      const blocked = this.#updateOutboxStatusNoTx(outboxId, "conflict");
      return { advanced: false, outbox: blocked, baseline: this.#getBaselineRow(outbox.external_key) };
    }

    const taskboardReadback = this.database.prepare(`
      SELECT * FROM sync_readbacks
      WHERE outbox_id = ? AND kind = 'taskboard' AND side = 'taskboard'
        AND success = 1 AND matched = 1
      ORDER BY observed_at DESC, readback_id DESC
      LIMIT 1
    `).get(outboxId);
    const candidate = this.#baselineCandidateNoTx(outbox, ack, baseReadback, taskboardReadback);
    const baseline = this.#upsertBaselineNoTx(
      candidate,
      rowToAck(ack),
      rowToReadback(baseReadback),
      committedAt,
    );
    const verified = this.#updateOutboxStatusNoTx(outboxId, "readback_verified", {
      verifiedAt: committedAt,
    });
    return { advanced: true, outbox: verified, baseline };
  }

  close() {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  dispose() {
    this.close();
  }

  startSyncRun({ runId = randomUUID(), scope = {}, metadata = null, startedAt = undefined } = {}) {
    const id = normalizeRunId(runId);
    const normalizedScope = cloneJson(scope);
    const scopeJson = encodeJson(normalizedScope, "scope", { nullable: false });
    const metadataJson = encodeJson(metadata, "metadata");
    const started = normalizeTimestamp(startedAt, "startedAt");
    return this.#transaction(() => {
      const existing = this.database.prepare("SELECT * FROM sync_runs WHERE run_id = ?").get(id);
      if (existing) {
        if (existing.scope_json !== scopeJson || existing.metadata_json !== metadataJson) {
          fail("SYNC_RUN_CONFLICT", "The same runId cannot be reused with different scope or metadata");
        }
        return rowToRun(existing);
      }
      this.database.prepare(`
        INSERT INTO sync_runs (
          run_id, status, scope_json, metadata_json, started_at, updated_at
        ) VALUES (?, 'running', ?, ?, ?, ?)
      `).run(id, scopeJson, metadataJson, started, started);
      return rowToRun(this.database.prepare("SELECT * FROM sync_runs WHERE run_id = ?").get(id));
    });
  }

  updateSyncRun(runId, {
    status = undefined,
    summary = undefined,
    error = undefined,
    completedAt = undefined,
    updatedAt = undefined,
  } = {}) {
    const id = normalizeRunId(runId);
    return this.#transaction(() => {
      const existing = this.database.prepare("SELECT * FROM sync_runs WHERE run_id = ?").get(id);
      if (!existing) fail("SYNC_RUN_NOT_FOUND", `Unknown sync run: ${id}`);
      const nextStatus = status === undefined ? existing.status : normalizeRunStatus(status);
      const nextSummary = summary === undefined ? existing.summary_json : encodeJson(summary, "summary");
      const nextError = error === undefined ? existing.error_json : encodeJson(error, "error");
      const nextCompleted = completedAt === undefined
        ? existing.completed_at
        : completedAt === null ? null : normalizeTimestamp(completedAt, "completedAt");
      this.database.prepare(`
        UPDATE sync_runs
        SET status = ?, summary_json = ?, error_json = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ?
      `).run(
        nextStatus,
        nextSummary,
        nextError,
        nextCompleted,
        normalizeTimestamp(updatedAt, "updatedAt"),
        id,
      );
      return rowToRun(this.database.prepare("SELECT * FROM sync_runs WHERE run_id = ?").get(id));
    });
  }

  finishSyncRun(runId, options = {}) {
    const next = options.status ?? (options.error ? "failed" : "completed");
    return this.updateSyncRun(runId, { ...options, status: next, completedAt: options.completedAt ?? new Date() });
  }

  startRun(input = {}) {
    return this.startSyncRun(input);
  }

  createSyncRun(input = {}) {
    return this.startSyncRun(input);
  }

  updateRun(runId, input = {}) {
    return this.updateSyncRun(runId, input);
  }

  finishRun(runId, input = {}) {
    return this.finishSyncRun(runId, input);
  }

  getSyncRun(runId) {
    const id = normalizeRunId(runId);
    this.#assertOpen();
    return rowToRun(this.database.prepare("SELECT * FROM sync_runs WHERE run_id = ?").get(id));
  }

  listSyncRuns({ status = undefined, limit = 100 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(1000, Number(limit) || 100));
    if (status === undefined) {
      return result(this.database.prepare(
        "SELECT * FROM sync_runs ORDER BY started_at DESC, run_id DESC LIMIT ?",
      ).all(count).map(rowToRun));
    }
    const normalizedStatus = normalizeRunStatus(status);
    return result(this.database.prepare(
      "SELECT * FROM sync_runs WHERE status = ? ORDER BY started_at DESC, run_id DESC LIMIT ?",
    ).all(normalizedStatus, count).map(rowToRun));
  }

  linkExternalRecord({
    externalKey,
    taskId,
    tableKey = undefined,
    recordId = undefined,
    sourceVersion = undefined,
    sourceHash = undefined,
    sourcePayload = undefined,
    seenAt = undefined,
  } = {}) {
    const key = normalizeExternalKey(externalKey);
    const task = normalizeTaskId(taskId);
    const identity = parseFeishuBaseExternalKey(key);
    const normalizedTableKey = normalizeTableKey(tableKey);
    const normalizedRecordId = optionalString(recordId, "recordId", 1024) ?? identity.recordId;
    if (normalizedRecordId !== identity.recordId) {
      fail("EXTERNAL_KEY_RECORD_MISMATCH", "recordId does not match externalKey");
    }
    const sourceVersionJson = versionJson(sourceVersion, "sourceVersion");
    const normalizedSourceHash = normalizePayloadHash({ payload: sourcePayload, payloadHash: sourceHash, label: "sourceHash" });
    const sourcePayloadJson = sourcePayload === undefined ? null : encodeJson(sourcePayload, "sourcePayload");
    const timestamp = normalizeTimestamp(seenAt, "seenAt");
    let linkConflict = null;
    const linked = this.#transaction(() => {
      const existing = this.#getLinkRow(key);
      if (existing && existing.task_id !== task) {
        linkConflict = this.#insertConflictNoTx({
          externalKey: key,
          taskId: task,
          reason: "SOURCE_LINK_TASK_MISMATCH",
          source: { version: sourceVersion, hash: normalizedSourceHash, payload: sourcePayload },
          details: { existingTaskId: existing.task_id },
          createdAt: timestamp,
        });
        return null;
      }
      if (!existing) {
        this.database.prepare(`
          INSERT INTO source_links (
            external_key, task_id, source_table_key, source_record_id,
            first_seen_at, last_seen_at,
            last_source_version_json, last_source_hash, last_source_payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          key,
          task,
          normalizedTableKey,
          normalizedRecordId,
          timestamp,
          timestamp,
          sourceVersionJson,
          normalizedSourceHash,
          sourcePayloadJson,
        );
      } else {
        this.database.prepare(`
          UPDATE source_links
          SET last_seen_at = ?, source_table_key = COALESCE(?, source_table_key),
              source_record_id = ?,
              last_source_version_json = COALESCE(?, last_source_version_json),
              last_source_hash = COALESCE(?, last_source_hash),
              last_source_payload_json = COALESCE(?, last_source_payload_json)
          WHERE external_key = ?
        `).run(
          timestamp,
          normalizedTableKey,
          normalizedRecordId,
          sourceVersionJson,
          normalizedSourceHash,
          sourcePayloadJson,
          key,
        );
      }
      return rowToLink(this.#getLinkRow(key), this.#getLatestReadbackRow(key));
    });
    if (linkConflict) {
      fail("SOURCE_LINK_CONFLICT", "The external key is already bound to another Taskboard task", {
        externalKey: key,
        existingTaskId: linkConflict.details?.existingTaskId,
        requestedTaskId: task,
        conflictId: linkConflict.conflictId,
      });
    }
    return linked;
  }

  upsertSourceLink(input = {}) {
    return this.linkExternalRecord(input);
  }

  upsertLink(input = {}) {
    return this.linkExternalRecord(input);
  }

  linkSourceRecord(input = {}) {
    return this.linkExternalRecord(input);
  }

  getLink(externalKey) {
    const key = normalizeExternalKey(externalKey);
    this.#assertOpen();
    return rowToLink(this.#getLinkRow(key), this.#getLatestReadbackRow(key));
  }

  getSourceLink(externalKey) {
    return this.getLink(externalKey);
  }

  getLinkByExternalKey(externalKey) {
    return this.getLink(externalKey);
  }

  listLinks({ taskId = undefined, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    if (taskId === undefined) {
      return result(this.database.prepare(
        "SELECT * FROM source_links ORDER BY first_seen_at, external_key LIMIT ?",
      ).all(count).map((row) => rowToLink(row, this.#getLatestReadbackRow(row.external_key))));
    }
    const task = normalizeTaskId(taskId);
    return result(this.database.prepare(
      "SELECT * FROM source_links WHERE task_id = ? ORDER BY first_seen_at, external_key LIMIT ?",
    ).all(task, count).map((row) => rowToLink(row, this.#getLatestReadbackRow(row.external_key))));
  }

  listSourceLinks(options = {}) {
    return this.listLinks(options);
  }

  getBaseline(externalKey) {
    const key = normalizeExternalKey(externalKey);
    this.#assertOpen();
    return rowToBaseline(this.#getBaselineRow(key));
  }

  getSuccessfulBaseline(externalKey) {
    return this.getBaseline(externalKey);
  }

  listBaselines({ taskId = undefined, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const rows = taskId === undefined
      ? this.database.prepare("SELECT * FROM sync_baselines ORDER BY committed_at, external_key LIMIT ?").all(count)
      : this.database.prepare(
        "SELECT * FROM sync_baselines WHERE task_id = ? ORDER BY committed_at, external_key LIMIT ?",
      ).all(normalizeTaskId(taskId), count);
    return result(rows.map(rowToBaseline));
  }

  enqueueOutbox({
    outboxId = randomUUID(),
    idempotencyKey = undefined,
    externalKey,
    taskId = null,
    mappingVersion = "v1",
    payload = undefined,
    payloadHash = undefined,
    message = undefined,
    sourceVersion = undefined,
    sourceHash = undefined,
    sourcePayload = undefined,
    taskboardVersion = undefined,
    taskboardHash = undefined,
    taskboardPayload = undefined,
    createdAt = undefined,
  } = {}) {
    const key = normalizeExternalKey(externalKey);
    const task = taskId === null || taskId === undefined ? null : normalizeTaskId(taskId);
    const version = requiredString(mappingVersion, "mappingVersion", 128);
    const immutablePayload = payload === undefined ? null : cloneJson(payload);
    const messageValue = message === undefined
      ? {
        externalKey: key,
        taskId: task,
        mappingVersion: version,
        payload: immutablePayload,
      }
      : cloneJson(message);
    if (!isPlainObject(messageValue)) fail("INVALID_OUTBOX_MESSAGE", "outbox message must be a JSON object");
    const normalizedPayloadHash = normalizePayloadHash({
      payload: immutablePayload,
      payloadHash: payloadHash ?? messageValue.payloadHash ?? messageValue.payload_hash,
    }) ?? hashCanonicalJson(messageValue);
    const normalizedSourceVersion = versionJson(sourceVersion, "sourceVersion");
    const normalizedSourceHash = normalizeHash(sourceHash, "sourceHash");
    const normalizedSourcePayload = sourcePayload === undefined ? null : encodeJson(sourcePayload, "sourcePayload");
    const normalizedTaskboardVersion = versionJson(taskboardVersion, "taskboardVersion");
    const normalizedTaskboardHash = normalizePayloadHash({
      payload: taskboardPayload,
      payloadHash: taskboardHash,
      label: "taskboardHash",
    });
    const normalizedTaskboardPayload = taskboardPayload === undefined ? null : encodeJson(taskboardPayload, "taskboardPayload");
    const keyValue = idempotencyKey === undefined || idempotencyKey === null
      ? createFeishuBaseIdempotencyKey({ externalKey: key, mappingVersion: version, payload: immutablePayload ?? messageValue })
      : requiredString(idempotencyKey, "idempotencyKey", 512);
    const messageJson = encodeJson(messageValue, "message", { nullable: false });
    const contentHash = hashCanonicalJson({
      idempotencyKey: keyValue,
      externalKey: key,
      taskId: task,
      mappingVersion: version,
      payloadHash: normalizedPayloadHash,
      message: messageValue,
      sourceVersion: normalizedSourceVersion === null ? null : JSON.parse(normalizedSourceVersion),
      sourceHash: normalizedSourceHash,
      sourcePayload: normalizedSourcePayload === null ? null : JSON.parse(normalizedSourcePayload),
      taskboardVersion: normalizedTaskboardVersion === null ? null : JSON.parse(normalizedTaskboardVersion),
      taskboardHash: normalizedTaskboardHash,
      taskboardPayload: normalizedTaskboardPayload === null ? null : JSON.parse(normalizedTaskboardPayload),
    });
    const created = normalizeTimestamp(createdAt, "createdAt");
    const id = requiredString(outboxId, "outboxId", 256);

    let linkConflict = null;
    const queued = this.#transaction(() => {
      const existing = this.database.prepare(
        "SELECT * FROM sync_outbox WHERE idempotency_key = ?",
      ).get(keyValue);
      if (existing) {
        if (existing.content_hash !== contentHash || existing.message_json !== messageJson) {
          fail("IDEMPOTENCY_CONFLICT", "The same idempotency key cannot carry different outbox content", {
            idempotencyKey: keyValue,
            existingOutboxId: existing.outbox_id,
          });
        }
        return result({ ...rowToOutbox(existing), created: false, reused: true });
      }
      const link = this.#getLinkRow(key);
      if (link && task !== null && link.task_id !== task) {
        linkConflict = this.#insertConflictNoTx({
          externalKey: key,
          taskId: task,
          reason: "SOURCE_LINK_TASK_MISMATCH",
          outboxId: id,
          details: { existingTaskId: link.task_id },
          createdAt: created,
        });
        return null;
      }
      this.database.prepare(`
        INSERT INTO sync_outbox (
          outbox_id, idempotency_key, external_key, task_id, mapping_version,
          payload_hash, content_hash, message_json,
          source_version_json, source_hash, source_payload_json,
          taskboard_version_json, taskboard_hash, taskboard_payload_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id,
        keyValue,
        key,
        task,
        version,
        normalizedPayloadHash,
        contentHash,
        messageJson,
        normalizedSourceVersion,
        normalizedSourceHash,
        normalizedSourcePayload,
        normalizedTaskboardVersion,
        normalizedTaskboardHash,
        normalizedTaskboardPayload,
        created,
        created,
      );
      return result({ ...rowToOutbox(this.database.prepare("SELECT * FROM sync_outbox WHERE outbox_id = ?").get(id)), created: true, reused: false });
    });
    if (linkConflict) {
      fail("SOURCE_LINK_CONFLICT", "The external key is already bound to another Taskboard task", {
        externalKey: key,
        existingTaskId: linkConflict.details?.existingTaskId,
        requestedTaskId: task,
        conflictId: linkConflict.conflictId,
      });
    }
    return queued;
  }

  queueOutbox(input = {}) {
    return this.enqueueOutbox(input);
  }

  getOutbox(outboxId) {
    const id = requiredString(outboxId, "outboxId", 256);
    this.#assertOpen();
    return rowToOutbox(this.#getOutboxRow(id));
  }

  getOutboxByIdempotencyKey(idempotencyKey) {
    const key = requiredString(idempotencyKey, "idempotencyKey", 512);
    this.#assertOpen();
    return rowToOutbox(this.#getOutboxRow(null, key));
  }

  listOutbox({ status = undefined, pendingOnly = false, externalKey = undefined, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const clauses = [];
    const values = [];
    if (pendingOnly) {
      clauses.push("status IN ('pending', 'sent', 'acked', 'readback_pending')");
    } else if (status !== undefined) {
      clauses.push("status = ?");
      values.push(normalizeOutboxStatus(status));
    }
    if (externalKey !== undefined) {
      clauses.push("external_key = ?");
      values.push(normalizeExternalKey(externalKey));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(
      `SELECT * FROM sync_outbox${where} ORDER BY created_at, outbox_id LIMIT ?`,
    ).all(...values, count);
    return result(rows.map(rowToOutbox));
  }

  listPendingOutbox(options = {}) {
    return this.listOutbox({ ...options, pendingOnly: true });
  }

  getOutboxItem(outboxId) {
    return this.getOutbox(outboxId);
  }

  startOutboxAttempt({ outboxId, attemptId = randomUUID(), attemptedAt = undefined, result: attemptResult = null } = {}) {
    const id = requiredString(outboxId, "outboxId", 256);
    const attempt = requiredString(attemptId, "attemptId", 256);
    const timestamp = normalizeTimestamp(attemptedAt, "attemptedAt");
    return this.#transaction(() => {
      const outbox = this.#getOutboxRow(id);
      if (!outbox) fail("OUTBOX_NOT_FOUND", `Unknown outbox item: ${id}`);
      const existingAttempt = this.database.prepare("SELECT * FROM sync_outbox_attempts WHERE attempt_id = ?").get(attempt);
      if (existingAttempt) return rowToAttempt(existingAttempt);
      const nextNumber = this.database.prepare(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number FROM sync_outbox_attempts WHERE outbox_id = ?",
      ).get(id).next_number;
      this.database.prepare(`
        INSERT INTO sync_outbox_attempts (
          attempt_id, outbox_id, attempt_number, status, attempted_at, result_json
        ) VALUES (?, ?, ?, 'started', ?, ?)
      `).run(attempt, id, nextNumber, timestamp, encodeJson(attemptResult, "attempt.result"));
      this.#updateOutboxStatusNoTx(id, "sent", { updatedAt: timestamp, lastAttemptAt: timestamp });
      return rowToAttempt(this.database.prepare("SELECT * FROM sync_outbox_attempts WHERE attempt_id = ?").get(attempt));
    });
  }

  recordOutboxAttempt({
    outboxId,
    attemptId = randomUUID(),
    status = "unknown",
    result: attemptResult = null,
    error = null,
    attemptedAt = undefined,
    completedAt = undefined,
  } = {}) {
    const id = requiredString(outboxId, "outboxId", 256);
    const attempt = requiredString(attemptId, "attemptId", 256);
    const normalizedStatus = normalizeAttemptStatus(status);
    const started = normalizeTimestamp(attemptedAt, "attemptedAt");
    const completed = completedAt === null ? null : normalizeTimestamp(completedAt, "completedAt", new Date(started));
    return this.#transaction(() => {
      const outbox = this.#getOutboxRow(id);
      if (!outbox) fail("OUTBOX_NOT_FOUND", `Unknown outbox item: ${id}`);
      let existing = this.database.prepare("SELECT * FROM sync_outbox_attempts WHERE attempt_id = ?").get(attempt);
      if (existing) {
        if (existing.outbox_id !== id) fail("ATTEMPT_CONFLICT", "attemptId belongs to another outbox item");
        this.database.prepare(`
          UPDATE sync_outbox_attempts
          SET status = ?, completed_at = ?, result_json = ?, error_json = ?
          WHERE attempt_id = ?
        `).run(
          normalizedStatus,
          completed,
          encodeJson(attemptResult, "attempt.result"),
          encodeJson(error, "attempt.error"),
          attempt,
        );
      } else {
        const nextNumber = this.database.prepare(
          "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number FROM sync_outbox_attempts WHERE outbox_id = ?",
        ).get(id).next_number;
        this.database.prepare(`
          INSERT INTO sync_outbox_attempts (
            attempt_id, outbox_id, attempt_number, status, attempted_at, completed_at, result_json, error_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attempt,
          id,
          nextNumber,
          normalizedStatus,
          started,
          completed,
          encodeJson(attemptResult, "attempt.result"),
          encodeJson(error, "attempt.error"),
        );
      }
      const nextOutboxStatus = outbox.status === "readback_verified" || outbox.status === "conflict"
        ? outbox.status
        : "pending";
      this.#updateOutboxStatusNoTx(id, nextOutboxStatus, {
        updatedAt: completed ?? started,
        lastAttemptAt: started,
        lastError: error,
      });
      existing = this.database.prepare("SELECT * FROM sync_outbox_attempts WHERE attempt_id = ?").get(attempt);
      return rowToAttempt(existing);
    });
  }

  finishOutboxAttempt(input = {}) {
    return this.recordOutboxAttempt(input);
  }

  recordAttempt(input = {}) {
    return this.recordOutboxAttempt(input);
  }

  listAttempts({ outboxId = undefined, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    if (outboxId === undefined) {
      return result(this.database.prepare(
        "SELECT * FROM sync_outbox_attempts ORDER BY attempted_at DESC, attempt_id DESC LIMIT ?",
      ).all(count).map(rowToAttempt));
    }
    const id = requiredString(outboxId, "outboxId", 256);
    return result(this.database.prepare(
      "SELECT * FROM sync_outbox_attempts WHERE outbox_id = ? ORDER BY attempt_number DESC LIMIT ?",
    ).all(id, count).map(rowToAttempt));
  }

  getOutboxAttempts(outboxId) {
    return this.listAttempts({ outboxId });
  }

  recordHermesAck({ outboxId = null, idempotencyKey = null, ack = undefined, ...input } = {}) {
    const requestedOutboxId = outboxId === null ? null : requiredString(outboxId, "outboxId", 256);
    const requestedKey = idempotencyKey === null ? null : requiredString(idempotencyKey, "idempotencyKey", 512);
    const fields = parseAckFields({ ...input, ack, idempotencyKey: requestedKey });
    const lookupKey = fields.idempotencyKey ?? requestedKey;
    if (requestedOutboxId === null && lookupKey === null) {
      fail("MISSING_OUTBOX_ID", "Hermes ACK requires outboxId or idempotencyKey");
    }
    return this.#transaction(() => {
      const outbox = this.#getOutboxRow(requestedOutboxId, lookupKey);
      if (!outbox) fail("OUTBOX_NOT_FOUND", "Hermes ACK refers to an unknown outbox item");
      const matches = Boolean(
        fields.success
        && fields.messageId
        && fields.idempotencyKey === outbox.idempotency_key
        && fields.externalKey === outbox.external_key
        && fields.payloadHash === outbox.payload_hash,
      );
      const storedIdempotencyKey = fields.idempotencyKey ?? "";
      const storedExternalKey = fields.externalKey ?? "";
      const ackId = randomUUID();
      this.database.prepare(`
        INSERT INTO sync_hermes_acks (
          ack_id, outbox_id, idempotency_key, external_key, payload_hash, message_id,
          success, matched, acknowledged_at, source_version_json, source_hash,
          taskboard_version_json, taskboard_hash, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ackId,
        outbox.outbox_id,
        storedIdempotencyKey,
        storedExternalKey,
        fields.payloadHash,
        fields.messageId,
        fields.success ? 1 : 0,
        matches ? 1 : 0,
        fields.acknowledgedAt,
        fields.sourceVersion,
        fields.sourceHash,
        fields.taskboardVersion,
        fields.taskboardHash,
        encodeJson(fields.raw, "ack", { nullable: false }),
      );
      if (!matches) {
        this.#insertConflictNoTx({
          externalKey: fields.externalKey ?? outbox.external_key,
          taskId: outbox.task_id,
          outboxId: outbox.outbox_id,
          reason: "HERMES_ACK_MISMATCH",
          baseline: rowToBaseline(this.#getBaselineRow(outbox.external_key)),
          details: {
            expected: {
              idempotencyKey: outbox.idempotency_key,
              externalKey: outbox.external_key,
              payloadHash: outbox.payload_hash,
            },
            received: fields.raw,
          },
          createdAt: fields.acknowledgedAt,
        });
        this.#updateOutboxStatusNoTx(outbox.outbox_id, "conflict", {
          updatedAt: fields.acknowledgedAt,
          lastError: { code: "HERMES_ACK_MISMATCH" },
        });
      } else {
        this.#updateOutboxStatusNoTx(outbox.outbox_id, "acked", { updatedAt: fields.acknowledgedAt });
      }
      const finalized = matches ? this.#tryAdvanceBaselineNoTx(outbox.outbox_id, fields.acknowledgedAt) : null;
      return result({
        ...rowToAck(this.database.prepare("SELECT * FROM sync_hermes_acks WHERE ack_id = ?").get(ackId)),
        baselineAdvanced: Boolean(finalized?.advanced),
        outbox: rowToOutbox(finalized?.outbox ?? this.#getOutboxRow(outbox.outbox_id)),
        baseline: rowToBaseline(finalized?.baseline ?? this.#getBaselineRow(outbox.external_key)),
      });
    });
  }

  recordAck(input = {}) {
    return this.recordHermesAck(input);
  }

  advanceSuccessfulBaseline({ outboxId = null, idempotencyKey = null, committedAt = undefined } = {}) {
    const requestedOutboxId = outboxId === null ? null : requiredString(outboxId, "outboxId", 256);
    const requestedKey = idempotencyKey === null ? null : requiredString(idempotencyKey, "idempotencyKey", 512);
    if (requestedOutboxId === null && requestedKey === null) {
      fail("MISSING_OUTBOX_ID", "Advancing a successful baseline requires outboxId or idempotencyKey");
    }
    return this.#transaction(() => {
      const outbox = this.#getOutboxRow(requestedOutboxId, requestedKey);
      if (!outbox) fail("OUTBOX_NOT_FOUND", "The successful baseline refers to an unknown outbox item");
      const finalized = this.#tryAdvanceBaselineNoTx(outbox.outbox_id, committedAt);
      return result({
        baselineAdvanced: Boolean(finalized.advanced),
        outbox: rowToOutbox(finalized.outbox ?? this.#getOutboxRow(outbox.outbox_id)),
        baseline: rowToBaseline(finalized.baseline ?? this.#getBaselineRow(outbox.external_key)),
      });
    });
  }

  recordSuccessfulBaseline(input = {}) {
    return this.advanceSuccessfulBaseline(input);
  }

  #recordReadback({
    kind,
    side,
    outboxId = null,
    externalKey = null,
    taskId = null,
    idempotencyKey = null,
    success = true,
    independent = true,
    version = null,
    sourceVersion = undefined,
    baseVersion = undefined,
    taskboardVersion = undefined,
    payload = undefined,
    payloadHash = undefined,
    sourceHash = undefined,
    baseHash = undefined,
    taskboardHash = undefined,
    details = null,
    raw = null,
    observedAt = undefined,
  }) {
    const normalizedKind = kind === "base" || kind === "taskboard" ? kind : fail("INVALID_READBACK_KIND", "Unsupported readback kind");
    const normalizedSide = side === "source" || side === "taskboard" ? side : fail("INVALID_READBACK_SIDE", "Unsupported readback side");
    const requestedOutboxId = outboxId === null ? null : requiredString(outboxId, "outboxId", 256);
    const requestedKey = idempotencyKey === null ? null : requiredString(idempotencyKey, "idempotencyKey", 512);
    const requestedExternal = externalKey === null ? null : normalizeExternalKey(externalKey);
    const requestedTask = taskId === null ? null : normalizeTaskId(taskId);
    const normalizedSuccess = normalizeBoolean(success, "success", true);
    const normalizedIndependent = normalizeBoolean(independent, "independent", true);
    const normalizedPayload = payload === undefined ? null : cloneJson(payload);
    const suppliedVersion = version ?? (side === "source" ? sourceVersion ?? baseVersion : taskboardVersion);
    const suppliedHash = payloadHash ?? (side === "source" ? sourceHash ?? baseHash : taskboardHash);
    const normalizedHash = normalizePayloadHash({ payload: normalizedPayload, payloadHash: suppliedHash });
    const normalizedVersion = suppliedVersion === null || suppliedVersion === undefined ? null : cloneJson(suppliedVersion);
    const timestamp = normalizeTimestamp(observedAt, "observedAt");
    const rawValue = raw === null || raw === undefined ? {
      success: normalizedSuccess,
      externalKey: requestedExternal,
      idempotencyKey: requestedKey,
      version: normalizedVersion,
      payloadHash: normalizedHash,
    } : cloneJson(raw);

    return this.#transaction(() => {
      const outbox = this.#getOutboxRow(requestedOutboxId, requestedKey);
      const resolvedExternal = requestedExternal ?? outbox?.external_key ?? null;
      if (resolvedExternal === null) fail("MISSING_EXTERNAL_KEY", "A readback requires externalKey or outboxId");
      const resolvedKey = requestedKey ?? outbox?.idempotency_key ?? null;
      const resolvedTask = requestedTask ?? outbox?.task_id ?? this.#getLinkRow(resolvedExternal)?.task_id ?? null;
      const expectedRecordId = parseFeishuBaseExternalKey(resolvedExternal).recordId;
      const receivedRecordId = rawValue?.recordId ?? rawValue?.record_id ?? null;
      const targetMatches = receivedRecordId === null || receivedRecordId === expectedRecordId;
      const expectedReadbackHash = normalizedKind === "taskboard"
        ? outbox?.taskboard_hash ?? outbox?.payload_hash
        : outbox?.payload_hash;
      const matches = Boolean(
        normalizedSuccess
        && normalizedIndependent
        && targetMatches
        && outbox
        && resolvedExternal === outbox.external_key
        && resolvedKey === outbox.idempotency_key
        && normalizedHash !== null
        && normalizedHash === expectedReadbackHash,
      );
      const readbackId = randomUUID();
      this.database.prepare(`
        INSERT INTO sync_readbacks (
          readback_id, outbox_id, kind, side, external_key, task_id, idempotency_key,
          success, independent, matched, version_json, payload_hash, payload_json,
          observed_at, details_json, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        readbackId,
        outbox?.outbox_id ?? requestedOutboxId,
        normalizedKind,
        normalizedSide,
        resolvedExternal,
        resolvedTask,
        resolvedKey,
        normalizedSuccess ? 1 : 0,
        normalizedIndependent ? 1 : 0,
        matches ? 1 : 0,
        versionJson(normalizedVersion, "readback.version"),
        normalizedHash,
        encodeJson(normalizedPayload, "readback.payload"),
        timestamp,
        encodeJson(details, "readback.details"),
        encodeJson(rawValue, "readback.raw", { nullable: false }),
      );
      const link = this.#getLinkRow(resolvedExternal);
      if (link) {
        if (normalizedKind === "base") {
          this.database.prepare(`
            UPDATE source_links
            SET last_seen_at = ?, last_source_version_json = COALESCE(?, last_source_version_json),
                last_source_hash = COALESCE(?, last_source_hash),
                last_source_payload_json = COALESCE(?, last_source_payload_json)
            WHERE external_key = ?
          `).run(
            timestamp,
            versionJson(normalizedVersion, "readback.version"),
            normalizedHash,
            encodeJson(normalizedPayload, "readback.payload"),
            resolvedExternal,
          );
        } else {
          this.database.prepare(`
            UPDATE source_links
            SET last_seen_at = ?, last_taskboard_version_json = COALESCE(?, last_taskboard_version_json),
                last_taskboard_hash = COALESCE(?, last_taskboard_hash),
                last_taskboard_payload_json = COALESCE(?, last_taskboard_payload_json)
            WHERE external_key = ?
          `).run(
            timestamp,
            versionJson(normalizedVersion, "readback.version"),
            normalizedHash,
            encodeJson(normalizedPayload, "readback.payload"),
            resolvedExternal,
          );
        }
      }
      if (!matches && outbox) {
        this.#insertConflictNoTx({
          externalKey: resolvedExternal,
          taskId: resolvedTask,
          outboxId: outbox.outbox_id,
          reason: normalizedKind === "base" ? "BASE_READBACK_MISMATCH" : "TASKBOARD_READBACK_MISMATCH",
          baseline: rowToBaseline(this.#getBaselineRow(resolvedExternal)),
          source: normalizedKind === "base" ? { version: normalizedVersion, hash: normalizedHash, payload: normalizedPayload } : null,
          taskboard: normalizedKind === "taskboard" ? { version: normalizedVersion, hash: normalizedHash, payload: normalizedPayload } : null,
          details: { expectedOutbox: rowToOutbox(outbox), received: rawValue },
          createdAt: timestamp,
        });
        this.#updateOutboxStatusNoTx(outbox.outbox_id, "conflict", {
          updatedAt: timestamp,
          lastError: { code: normalizedKind === "base" ? "BASE_READBACK_MISMATCH" : "TASKBOARD_READBACK_MISMATCH" },
        });
      } else if (outbox && normalizedKind === "base" && matches) {
        this.#updateOutboxStatusNoTx(outbox.outbox_id, "readback_pending", { updatedAt: timestamp });
      }
      const finalized = outbox && matches ? this.#tryAdvanceBaselineNoTx(outbox.outbox_id, timestamp) : null;
      const readbackRow = this.database.prepare("SELECT * FROM sync_readbacks WHERE readback_id = ?").get(readbackId);
      return result({
        ...rowToReadback(readbackRow),
        baselineAdvanced: Boolean(finalized?.advanced),
        outbox: rowToOutbox(finalized?.outbox ?? (outbox ? this.#getOutboxRow(outbox.outbox_id) : null)),
        baseline: rowToBaseline(finalized?.baseline ?? this.#getBaselineRow(resolvedExternal)),
      });
    });
  }

  recordBaseReadback(input = {}) {
    return this.#recordReadback({ ...input, kind: "base", side: "source", independent: input.independent ?? true });
  }

  recordTaskboardReadback(input = {}) {
    return this.#recordReadback({ ...input, kind: "taskboard", side: "taskboard", independent: input.independent ?? true });
  }

  recordReadback(input = {}) {
    const kind = input.kind ?? "base";
    return kind === "taskboard" ? this.recordTaskboardReadback(input) : this.recordBaseReadback(input);
  }

  getLastReadback(externalKey) {
    const key = normalizeExternalKey(externalKey);
    this.#assertOpen();
    return rowToReadback(this.#getLatestReadbackRow(key));
  }

  listReadbacks({ externalKey = undefined, outboxId = undefined, kind = undefined, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const clauses = [];
    const values = [];
    if (externalKey !== undefined) {
      clauses.push("external_key = ?");
      values.push(normalizeExternalKey(externalKey));
    }
    if (outboxId !== undefined) {
      clauses.push("outbox_id = ?");
      values.push(requiredString(outboxId, "outboxId", 256));
    }
    if (kind !== undefined) {
      if (kind !== "base" && kind !== "taskboard") fail("INVALID_READBACK_KIND", "Unsupported readback kind");
      clauses.push("kind = ?");
      values.push(kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return result(this.database.prepare(
      `SELECT * FROM sync_readbacks${where} ORDER BY observed_at DESC, readback_id DESC LIMIT ?`,
    ).all(...values, count).map(rowToReadback));
  }

  recordConflict(input = {}) {
    return this.#transaction(() => this.#insertConflictNoTx(input));
  }

  getUnresolvedConflicts(options = {}) {
    return this.listUnresolvedConflicts(options);
  }

  recordDualChangeConflict({
    externalKey,
    taskId = null,
    outboxId = null,
    baseline = undefined,
    source,
    taskboard,
    reason = "DUAL_SIDE_CHANGE",
    details = null,
    createdAt = undefined,
  } = {}) {
    const key = normalizeExternalKey(externalKey);
    return this.#transaction(() => {
      const baselineValue = baseline === undefined ? rowToBaseline(this.#getBaselineRow(key)) : cloneJson(baseline);
      const sourceValue = normalizeSideState(source, "source");
      const taskboardValue = normalizeSideState(taskboard, "taskboard");
      const sourceChanged = changedSide(baselineValue ? {
        version: baselineValue.sourceVersion,
        hash: baselineValue.sourceHash,
      } : null, sourceValue);
      const taskboardChanged = changedSide(baselineValue ? {
        version: baselineValue.taskboardVersion,
        hash: baselineValue.taskboardHash,
      } : null, taskboardValue);
      if (!sourceChanged || !taskboardChanged) {
        return result({ conflict: null, sourceChanged, taskboardChanged, baseline: baselineValue });
      }
      const conflict = this.#insertConflictNoTx({
        externalKey: key,
        taskId,
        outboxId,
        reason,
        baseline: baselineValue,
        source: sourceValue,
        taskboard: taskboardValue,
        details,
        createdAt,
      });
      return result({ conflict, sourceChanged, taskboardChanged, baseline: baselineValue });
    });
  }

  listConflicts({ externalKey = undefined, unresolvedOnly = false, limit = 1000 } = {}) {
    this.#assertOpen();
    const count = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const clauses = [];
    const values = [];
    if (externalKey !== undefined) {
      clauses.push("external_key = ?");
      values.push(normalizeExternalKey(externalKey));
    }
    if (unresolvedOnly) clauses.push("status = 'unresolved'");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return result(this.database.prepare(
      `SELECT * FROM sync_conflicts${where} ORDER BY created_at DESC, conflict_id DESC LIMIT ?`,
    ).all(...values, count).map(rowToConflict));
  }

  listUnresolvedConflicts(options = {}) {
    return this.listConflicts({ ...options, unresolvedOnly: true });
  }

  getConflict(conflictId) {
    const id = requiredString(conflictId, "conflictId", 256);
    this.#assertOpen();
    return rowToConflict(this.database.prepare("SELECT * FROM sync_conflicts WHERE conflict_id = ?").get(id));
  }

  resolveConflict(conflictId, { resolution = {}, resolvedAt = undefined } = {}) {
    const id = requiredString(conflictId, "conflictId", 256);
    const timestamp = normalizeTimestamp(resolvedAt, "resolvedAt");
    return this.#transaction(() => {
      const existing = this.database.prepare("SELECT * FROM sync_conflicts WHERE conflict_id = ?").get(id);
      if (!existing) fail("CONFLICT_NOT_FOUND", `Unknown sync conflict: ${id}`);
      this.database.prepare(`
        UPDATE sync_conflicts
        SET status = 'resolved', resolved_at = ?, resolution_json = ?
        WHERE conflict_id = ?
      `).run(timestamp, encodeJson(resolution, "resolution", { nullable: false }), id);
      return rowToConflict(this.database.prepare("SELECT * FROM sync_conflicts WHERE conflict_id = ?").get(id));
    });
  }

  snapshot({ includeResolvedConflicts = false } = {}) {
    this.#assertOpen();
    return result({
      schemaVersion: FEISHU_BASE_STATE_SCHEMA_VERSION,
      databasePath: this.databasePath,
      syncRuns: this.listSyncRuns({ limit: 10000 }),
      links: this.listLinks({ limit: 10000 }),
      baselines: this.listBaselines({ limit: 10000 }),
      outbox: this.listOutbox({ limit: 10000 }),
      attempts: result(this.database.prepare(
        "SELECT * FROM sync_outbox_attempts ORDER BY attempted_at DESC, attempt_id DESC LIMIT 10000",
      ).all().map(rowToAttempt)),
      acks: result(this.database.prepare(
        "SELECT * FROM sync_hermes_acks ORDER BY acknowledged_at DESC, ack_id DESC LIMIT 10000",
      ).all().map(rowToAck)),
      readbacks: this.listReadbacks({ limit: 10000 }),
      conflicts: this.listConflicts({ unresolvedOnly: !includeResolvedConflicts, limit: 10000 }),
    });
  }
}

export function createFeishuBaseStateStore(options = {}) {
  return new FeishuBaseStateStore(options);
}

export const openFeishuBaseStateStore = createFeishuBaseStateStore;
export const createFeishuBaseSyncStateStore = createFeishuBaseStateStore;
export const openFeishuBaseSyncStateStore = createFeishuBaseStateStore;
