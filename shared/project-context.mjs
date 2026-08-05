export const CONTEXT_KINDS = Object.freeze([
  "requirement",
  "decision",
  "constraint",
  "fact",
  "risk",
  "handoff",
  "summary",
]);

export const CONTEXT_SOURCE_TYPES = Object.freeze([
  "manual",
  "issue",
  "comment",
  "thread_summary",
  "agent",
]);

export const CONTEXT_BODY_MAX_BYTES = 65_536;
export const CONTEXT_LIST_DEFAULT_LIMIT = 50;
export const CONTEXT_LIST_MAX_LIMIT = 100;
export const CONTEXT_BRIEF_MAX_CHARS = 12_000;

const CONTEXT_CURSOR_VALUE_MAX_CHARS = 512;
const CONTEXT_CURSOR_MAX_CHARS = 8_192;
const BRIEF_PRIMARY_KINDS = new Set(["requirement", "constraint", "decision"]);
const BRIEF_SECONDARY_KINDS = new Set(["risk", "handoff"]);

export function contextEntryFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseRowTags(row.tags),
    sourceType: row.source_type,
    sourceId: row.source_id ?? null,
    sourceThreadId: row.source_thread_id ?? null,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    pinned: row.pinned === true || row.pinned === 1,
    archivedAt: row.archived_at ?? null,
    version: row.version,
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function contextRevisionFromRow(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    version: row.version,
    title: row.title,
    body: row.body,
    kind: row.kind,
    tags: parseRowTags(row.tags),
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}

export function encodeContextCursor(tuple) {
  validateCursorTuple(tuple);
  const bytes = new TextEncoder().encode(JSON.stringify(tuple));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeContextCursor(cursor) {
  if (
    typeof cursor !== "string"
    || cursor.length === 0
    || cursor.length > CONTEXT_CURSOR_MAX_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(cursor)
    || cursor.length % 4 === 1
  ) {
    throw invalidCursorError();
  }

  try {
    const base64 = cursor
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(cursor.length + ((4 - (cursor.length % 4)) % 4), "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateCursorTuple(value);
    if (encodeContextCursor(value) !== cursor) throw invalidCursorError();
    return Object.freeze(value);
  } catch {
    throw invalidCursorError();
  }
}

export function sameContextCreatePayload(entry, input) {
  return entry.kind === input.kind
    && entry.title === input.title
    && entry.body === input.body
    && sameStringArray(entry.tags ?? [], input.tags ?? [])
    && entry.sourceType === (input.sourceType ?? "manual")
    && (entry.sourceId ?? null) === (input.sourceId ?? null)
    && (entry.sourceThreadId ?? null) === (input.sourceThreadId ?? null)
    && entry.pinned === (input.pinned ?? false);
}

export function buildProjectContextBrief(entries) {
  const selected = entries
    .filter((entry) => entry.archivedAt == null)
    .map((entry) => ({ entry, priority: briefPriority(entry) }))
    .filter(({ priority }) => Number.isFinite(priority))
    .sort((left, right) => (
      left.priority - right.priority
      || compareDescending(left.entry.updatedAt, right.entry.updatedAt)
      || compareAscending(String(left.entry.id), String(right.entry.id))
    ));

  const includedEntryIds = [];
  const seenEntryIds = new Set();
  let brief = "";
  let truncated = false;

  for (const { entry } of selected) {
    if (seenEntryIds.has(entry.id)) continue;
    seenEntryIds.add(entry.id);

    const block = formatBriefEntry(entry);
    const separator = brief.length === 0 ? "" : "\n\n";
    const available = CONTEXT_BRIEF_MAX_CHARS - brief.length;
    if (separator.length + block.length <= available) {
      brief += separator + block;
      includedEntryIds.push(entry.id);
      continue;
    }

    truncated = true;
    const availableForBlock = available - separator.length;
    if (availableForBlock > 0) {
      brief += separator + block.slice(0, availableForBlock);
      includedEntryIds.push(entry.id);
    }
    break;
  }

  return { brief, includedEntryIds, truncated };
}

function parseRowTags(tags) {
  return typeof tags === "string" ? JSON.parse(tags) : tags;
}

function validateCursorTuple(tuple) {
  if (
    !Array.isArray(tuple)
    || tuple.length !== 2
    || tuple.some((value) => (
      typeof value !== "string"
      || value.length === 0
      || value.length > CONTEXT_CURSOR_VALUE_MAX_CHARS
    ))
  ) {
    throw invalidCursorError();
  }
}

function invalidCursorError() {
  return new Error("Invalid project context cursor");
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function briefPriority(entry) {
  if (entry.pinned) return 0;
  if (BRIEF_PRIMARY_KINDS.has(entry.kind)) return 1;
  if (BRIEF_SECONDARY_KINDS.has(entry.kind)) return 2;
  if (entry.kind === "summary") return 3;
  return Number.POSITIVE_INFINITY;
}

function compareDescending(left, right) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function compareAscending(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function formatBriefEntry(entry) {
  const lines = [`## [${entry.kind}] ${entry.title}`];
  if (entry.tags.length > 0) {
    lines.push(`- Tags: ${entry.tags.map((tag) => JSON.stringify(tag)).join(", ")}`);
  }
  const source = [entry.sourceType];
  if (entry.sourceId !== null) source.push(`id=${JSON.stringify(entry.sourceId)}`);
  if (entry.sourceThreadId !== null) {
    source.push(`thread=${JSON.stringify(entry.sourceThreadId)}`);
  }
  lines.push(`- Source: ${source.join("; ")}`);
  lines.push(`- Updated: ${entry.updatedAt}`);
  lines.push("", entry.body);
  return lines.join("\n");
}
