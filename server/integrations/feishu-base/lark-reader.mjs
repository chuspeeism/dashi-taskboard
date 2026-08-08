import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import {
  FEISHU_PERSONAL_LATEST_BOT,
  FEISHU_BASE_TABLE_KEYS,
  normalizeFeishuBaseConfig,
} from "./config.mjs";

const execFile = promisify(nodeExecFile);

export const FEISHU_BASE_READ_ONLY_COMMANDS = Object.freeze([
  "whoami",
  "base +field-list",
  "base +record-list",
]);

export const FEISHU_BASE_DEFAULT_PAGE_SIZE = 200;
export const FEISHU_BASE_MAX_PAGES = 10_000;

export class FeishuBaseReaderError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FeishuBaseReaderError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new FeishuBaseReaderError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label = "value") {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    fail("INVALID_READER_VALUE", `${label} must be JSON serializable`, {
      cause: error?.message ?? String(error),
    });
  }
}

function requiredString(value, label, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_READER_VALUE", `${label} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    fail("INVALID_READER_VALUE", `${label} contains unsupported whitespace`);
  }
  return value;
}

function normalizePageSize(value) {
  const pageSize = value === undefined ? FEISHU_BASE_DEFAULT_PAGE_SIZE : Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > FEISHU_BASE_DEFAULT_PAGE_SIZE) {
    fail("INVALID_PAGE_SIZE", "pageSize must be an integer between 1 and 200");
  }
  return pageSize;
}

function normalizeMaxPages(value) {
  const maxPages = value === undefined ? FEISHU_BASE_MAX_PAGES : Number(value);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > FEISHU_BASE_MAX_PAGES) {
    fail("INVALID_MAX_PAGES", "maxPages must be a positive integer no greater than 10000");
  }
  return maxPages;
}

function findBalancedJson(text, start) {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack = [opening === "{" ? "}" : "]"];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseJsonOutput(value, label) {
  if (value !== null && typeof value === "object") return cloneJson(value, label);
  if (typeof value !== "string") fail("INVALID_READER_RESPONSE", `${label} must contain JSON output`);
  const text = value.trim();
  if (!text) fail("EMPTY_READER_RESPONSE", `${label} returned empty output`);
  try {
    return JSON.parse(text);
  } catch {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "{" && text[index] !== "[") continue;
      const candidate = findBalancedJson(text, index);
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep looking. lark-cli may prefix a notice before the JSON envelope.
      }
    }
  }
  fail("INVALID_READER_RESPONSE", `${label} did not return a JSON envelope`);
}

function nestedValues(value) {
  const values = [value];
  if (isPlainObject(value)) {
    for (const key of ["data", "result", "response", "body"]) {
      if (value[key] !== undefined) values.push(value[key]);
    }
    if (isPlainObject(value.data)) {
      for (const key of ["data", "result"]) {
        if (value.data[key] !== undefined) values.push(value.data[key]);
      }
    }
  }
  return values;
}

function findArray(value, keys) {
  for (const candidate of nestedValues(value)) {
    if (Array.isArray(candidate)) return { items: candidate, envelope: value };
    if (!isPlainObject(candidate)) continue;
    for (const key of keys) {
      if (Array.isArray(candidate[key])) return { items: candidate[key], envelope: candidate };
    }
  }
  return null;
}

function findValue(value, keys) {
  for (const candidate of nestedValues(value)) {
    if (!isPlainObject(candidate)) continue;
    for (const key of keys) {
      if (candidate[key] !== undefined) return candidate[key];
    }
  }
  return undefined;
}

function paginationMeta(value) {
  const hasMore = findValue(value, ["has_more", "hasMore", "has_next", "hasNext"]);
  const total = findValue(value, ["total", "total_count", "totalCount"]);
  const nextOffset = findValue(value, ["next_offset", "nextOffset"]);
  const pageToken = findValue(value, ["page_token", "pageToken", "next_page_token", "nextPageToken"]);
  return {
    hasMore: hasMore === undefined ? undefined : Boolean(hasMore),
    total: total === undefined ? undefined : Number(total),
    nextOffset: nextOffset === undefined ? undefined : Number(nextOffset),
    pageToken: pageToken === undefined || pageToken === null ? undefined : String(pageToken),
  };
}

function normalizeCommandResult(result) {
  if (result === null || result === undefined) return { stdout: result };
  if (typeof result === "string" || Array.isArray(result)) return { stdout: result };
  if (isPlainObject(result) && ("stdout" in result || "stderr" in result)) return result;
  return { stdout: result };
}

function redactedArguments(args) {
  const copy = [...args];
  const index = copy.indexOf("--base-token");
  if (index >= 0 && index + 1 < copy.length) copy[index + 1] = "[REDACTED]";
  return copy;
}

function responseError(value, label) {
  if (!isPlainObject(value)) return;
  const error = value.error ?? value.err;
  if (error && (value.ok === false || value.success === false || value.code)) {
    const message = isPlainObject(error) ? error.message ?? error.msg : String(error);
    fail("BASE_READ_FAILED", `${label} failed: ${message}`, { response: cloneJson(value, label) });
  }
  if (value.ok === false && value.message) {
    fail("BASE_READ_FAILED", `${label} failed: ${value.message}`, { response: cloneJson(value, label) });
  }
}

function fieldsFromSchema(value, label) {
  if (Array.isArray(value)) return value;
  const found = findArray(value, ["fields", "items"]);
  if (!found) fail("INVALID_BASE_SCHEMA", `${label} must contain a fields array`);
  return found.items;
}

function recordsFromPage(value, label) {
  if (Array.isArray(value)) return value;
  const found = findArray(value, ["records", "items"]);
  if (!found) fail("INVALID_BASE_RESPONSE", `${label} must contain a records array`);
  return found.items;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function callTransportMethod(transport, method, args) {
  if (!transport || typeof transport[method] !== "function") return null;
  return transport[method](...args);
}

function commandArgumentsForRecords({ appToken, tableId, pageSize, offset, identity }) {
  return [
    "base",
    "+record-list",
    "--base-token",
    appToken,
    "--table-id",
    tableId,
    "--as",
    identity,
    "--format",
    "json",
    "--limit",
    String(pageSize),
    "--offset",
    String(offset),
  ];
}

function commandArgumentsForFields({ appToken, tableId, pageSize, offset, identity }) {
  return [
    "base",
    "+field-list",
    "--base-token",
    appToken,
    "--table-id",
    tableId,
    "--as",
    identity,
    "--format",
    "json",
    "--limit",
    String(pageSize),
    "--offset",
    String(offset),
  ];
}

export function createLarkReader({
  config,
  command = "lark-cli",
  identity = "bot",
  pageSize = FEISHU_BASE_DEFAULT_PAGE_SIZE,
  maxPages = FEISHU_BASE_MAX_PAGES,
  timeoutMs = 30_000,
  cwd = undefined,
  env = process.env,
  run = undefined,
  execFile: injectedExecFile = undefined,
  transport = undefined,
} = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  const normalizedPageSize = normalizePageSize(pageSize);
  const normalizedMaxPages = normalizeMaxPages(maxPages);
  requiredString(command, "command", 512);
  if (identity !== "bot") fail("INVALID_READER_IDENTITY", "Feishu Base reads must use the bot identity");

  const execute = async (args, label) => {
    let result;
    try {
      if (typeof run === "function") {
        result = await run({ command, args: [...args], label });
      } else {
        result = await (injectedExecFile ?? execFile)(command, args, {
          cwd,
          env,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        });
      }
    } catch (error) {
      fail("BASE_READ_FAILED", `${label} command failed`, {
        cause: error?.code ?? error?.message ?? String(error),
        command,
        args: redactedArguments(args),
      });
    }
    const normalized = normalizeCommandResult(result);
    const parsed = parseJsonOutput(normalized.stdout, label);
    responseError(parsed, label);
    return parsed;
  };

  const readAppId = async () => {
    const injected = await callTransportMethod(transport, "readAppId", []);
    const response = injected === null ? await execute(["whoami", "--as", identity], "whoami") : injected;
    const parsed = typeof response === "string"
      ? (/^[A-Za-z0-9._-]+$/.test(response) ? response : parseJsonOutput(response, "whoami"))
      : response;
    const appId = findValue(parsed, ["appId", "app_id", "applicationId", "application_id"])
      ?? (typeof parsed === "string" ? parsed : undefined);
    if (typeof appId !== "string" || appId.length === 0) {
      fail("INVALID_FEISHU_IDENTITY", "whoami did not return an app id", { response: cloneJson(parsed, "whoami") });
    }
    const appName = findValue(parsed, ["appName", "app_name", "name", "applicationName"])
      ?? FEISHU_PERSONAL_LATEST_BOT.name;
    return freeze({
      appId,
      appName: typeof appName === "string" && appName.length > 0
        ? appName
        : FEISHU_PERSONAL_LATEST_BOT.name,
    });
  };

  const readTableSchema = async (tableId) => {
    requiredString(tableId, "tableId", 256);
    const injected = await callTransportMethod(transport, "readTableSchema", [tableId]);
    if (injected !== null) {
      const fields = fieldsFromSchema(injected, `schema ${tableId}`);
      return freeze({ tableId, fields: cloneJson(fields, `schema ${tableId}`), complete: true });
    }

    const fields = [];
    let offset = 0;
    let page = 0;
    while (true) {
      page += 1;
      if (page > normalizedMaxPages) fail("PAGINATION_LIMIT", "Base field pagination exceeded the safety limit");
      const response = await execute(
        commandArgumentsForFields({
          appToken: normalizedConfig.appToken,
          tableId,
          pageSize: normalizedPageSize,
          offset,
          identity,
        }),
        `field-list ${tableId} page ${page}`,
      );
      const pageFields = fieldsFromSchema(response, `field-list ${tableId} page ${page}`);
      fields.push(...cloneJson(pageFields, `field-list ${tableId} page ${page}`));
      const meta = paginationMeta(response);
      const complete = meta.hasMore === false
        || (meta.hasMore === undefined && pageFields.length < normalizedPageSize)
        || (meta.total !== undefined && Number.isFinite(meta.total) && fields.length >= meta.total);
      if (complete) break;
      if (pageFields.length === 0) fail("INVALID_BASE_PAGINATION", `field-list ${tableId} returned an empty page before completion`);
      const nextOffset = meta.nextOffset ?? offset + pageFields.length;
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        fail("INVALID_BASE_PAGINATION", `field-list ${tableId} did not advance offset`);
      }
      offset = nextOffset;
    }
    return freeze({ tableId, fields, complete: true });
  };

  const readRecords = async (tableId) => {
    requiredString(tableId, "tableId", 256);
    const injected = await callTransportMethod(transport, "readRecords", [tableId]);
    if (injected !== null) {
      const records = recordsFromPage(injected, `records ${tableId}`);
      return freeze(cloneJson(records, `records ${tableId}`));
    }

    const records = [];
    let offset = 0;
    let page = 0;
    while (true) {
      page += 1;
      if (page > normalizedMaxPages) fail("PAGINATION_LIMIT", "Base record pagination exceeded the safety limit");
      const response = await execute(
        commandArgumentsForRecords({
          appToken: normalizedConfig.appToken,
          tableId,
          pageSize: normalizedPageSize,
          offset,
          identity,
        }),
        `record-list ${tableId} page ${page}`,
      );
      const pageRecords = recordsFromPage(response, `record-list ${tableId} page ${page}`);
      records.push(...cloneJson(pageRecords, `record-list ${tableId} page ${page}`));
      const meta = paginationMeta(response);
      const complete = meta.hasMore === false
        || (meta.hasMore === undefined && pageRecords.length < normalizedPageSize)
        || (meta.total !== undefined && Number.isFinite(meta.total) && records.length >= meta.total);
      if (complete) break;
      if (pageRecords.length === 0) fail("INVALID_BASE_PAGINATION", `record-list ${tableId} returned an empty page before completion`);
      const nextOffset = meta.nextOffset ?? offset + pageRecords.length;
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        fail("INVALID_BASE_PAGINATION", `record-list ${tableId} did not advance offset`);
      }
      offset = nextOffset;
    }
    return freeze(records);
  };

  const readTable = async (tableKey) => {
    if (!FEISHU_BASE_TABLE_KEYS.includes(tableKey)) {
      fail("TABLE_NOT_WHITELISTED", `Unsupported Feishu Base table: ${tableKey}`);
    }
    const tableId = normalizedConfig.tableIds[tableKey];
    const schema = await readTableSchema(tableId);
    const records = await readRecords(tableId);
    return freeze({
      type: "feishu.base.table-read.v1",
      version: 1,
      tableKey,
      tableId,
      schema,
      records,
      complete: true,
    });
  };

  return Object.freeze({
    readAppId,
    readTableSchema,
    readRecords,
    readTable,
    readOnlyCommands: FEISHU_BASE_READ_ONLY_COMMANDS,
  });
}

export const createFeishuBaseLarkReader = createLarkReader;
export const createLarkBaseReader = createLarkReader;
export const createFeishuBaseReader = createLarkReader;
