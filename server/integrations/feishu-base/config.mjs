export const FEISHU_BASE_CONFIG_VERSION = 1;
const DEFAULT_TIMEZONE = "Asia/Shanghai";

export const FEISHU_BASE_MODES = Object.freeze([
  "disabled",
  "read_only",
  "dry_run",
  "apply",
]);

export const FEISHU_BASE_MODE_PERMISSIONS = Object.freeze({
  disabled: Object.freeze({ baseRead: false, taskboardWrite: false, hermesWrite: false }),
  // read_only means Feishu Base is read-only; the resulting inbound Taskboard write is allowed.
  read_only: Object.freeze({ baseRead: true, taskboardWrite: true, hermesWrite: false }),
  dry_run: Object.freeze({ baseRead: true, taskboardWrite: false, hermesWrite: false }),
  apply: Object.freeze({ baseRead: true, taskboardWrite: true, hermesWrite: true }),
});

export const FEISHU_BASE_TABLE_KEYS = Object.freeze([
  "productIdeas",
  "requirements",
]);

export const FEISHU_BASE_EXCLUDED_SCOPES = Object.freeze([
  "account_profiles",
  "payments_billing",
  "prompt_content_and_generation_parameters",
  "competitor_details_and_research",
]);

export const FEISHU_PERSONAL_LATEST_BOT = Object.freeze({
  name: "personal-latest-bot",
  appId: "cli_aacdaa258e785cd2",
});

export class FeishuBaseConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuBaseConfigError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry)));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneAndFreeze(entry);
    }
    return Object.freeze(result);
  }
  return value;
}

function fail(code, message) {
  throw new FeishuBaseConfigError(code, message);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("INVALID_CONFIG", `${label} must be an object`);
}

function assertAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("UNKNOWN_CONFIG_FIELD", `${label} contains unsupported fields`);
  }
}

function requiredString(value, label, { maxLength = 512 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail("INVALID_CONFIG_VALUE", `${label} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes("\0")) {
    fail("INVALID_CONFIG_VALUE", `${label} contains unsupported whitespace`);
  }
  return value;
}

function optionalString(value, label, options = {}) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, options);
}

function projectId(value, label) {
  const normalized = requiredString(value, label, { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    fail("INVALID_CONFIG_VALUE", `${label} contains unsupported characters`);
  }
  return normalized;
}

function exactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("INVALID_CONFIG_VALUE", `${label} must contain exactly the two whitelisted entries`);
  }
}

function parseTableIds(value) {
  exactKeys(value, FEISHU_BASE_TABLE_KEYS, "tableIds");
  const result = {};
  for (const key of FEISHU_BASE_TABLE_KEYS) {
    result[key] = requiredString(value[key], `tableIds.${key}`, { maxLength: 256 });
  }
  if (result.productIdeas === result.requirements) {
    fail("DUPLICATE_TABLE_ID", "The two whitelisted table IDs must be different");
  }
  return result;
}

function parseProjectMapping(value) {
  exactKeys(value, FEISHU_BASE_TABLE_KEYS, "projectMapping");
  const result = {};
  for (const key of FEISHU_BASE_TABLE_KEYS) {
    result[key] = projectId(value[key], `projectMapping.${key}`);
  }
  return result;
}

function parseTimezone(value) {
  const timezone = requiredString(value, "timezone", { maxLength: 128 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    fail("INVALID_TIMEZONE", "timezone must be a valid IANA timezone");
  }
  return timezone;
}

function parseHermesEndpoint(value) {
  if (value === null || value === undefined) return null;
  const endpoint = requiredString(value, "hermesEndpoint", { maxLength: 2048 });
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail("INVALID_HERMES_ENDPOINT", "hermesEndpoint must be a valid HTTPS URL");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username
    || url.password
    || url.search
    || url.hash) {
    fail("INVALID_HERMES_ENDPOINT", "hermesEndpoint must not contain credentials or query data");
  }
  return url.toString();
}

function parseExcludedScopes(value) {
  const actual = value === undefined ? [...FEISHU_BASE_EXCLUDED_SCOPES] : value;
  if (!Array.isArray(actual)
    || actual.length !== FEISHU_BASE_EXCLUDED_SCOPES.length
    || actual.some((scope, index) => scope !== FEISHU_BASE_EXCLUDED_SCOPES[index])) {
    fail("INVALID_SCOPE_POLICY", "The excluded Feishu scopes are fixed and cannot be broadened");
  }
  return [...FEISHU_BASE_EXCLUDED_SCOPES];
}

function defaultConfig() {
  return cloneAndFreeze({
    version: FEISHU_BASE_CONFIG_VERSION,
    mode: "disabled",
    appToken: null,
    tableIds: {
      productIdeas: null,
      requirements: null,
    },
    projectMapping: {
      productIdeas: null,
      requirements: null,
    },
    fallbackProjectId: null,
    threadId: null,
    timezone: DEFAULT_TIMEZONE,
    hermesEndpoint: null,
    excludedScopes: [...FEISHU_BASE_EXCLUDED_SCOPES],
  });
}

const DEFAULT_CONFIG = defaultConfig();

export function getDefaultFeishuBaseConfig() {
  return DEFAULT_CONFIG;
}

export const defaultFeishuBaseConfig = getDefaultFeishuBaseConfig;

export function parseFeishuBaseConfig(value = undefined) {
  if (value === undefined) return DEFAULT_CONFIG;
  if (value === DEFAULT_CONFIG) return DEFAULT_CONFIG;
  assertPlainObject(value, "Feishu Base configuration");
  assertAllowedKeys(value, new Set([
    "version",
    "mode",
    "appToken",
    "tableIds",
    "projectMapping",
    "fallbackProjectId",
    "threadId",
    "timezone",
    "hermesEndpoint",
    "excludedScopes",
  ]), "Feishu Base configuration");

  const version = value.version === undefined ? FEISHU_BASE_CONFIG_VERSION : value.version;
  if (version !== FEISHU_BASE_CONFIG_VERSION) {
    fail("UNSUPPORTED_CONFIG_VERSION", "Unsupported Feishu Base configuration version");
  }

  const mode = value.mode === undefined ? "disabled" : value.mode;
  if (!FEISHU_BASE_MODES.includes(mode)) {
    fail("INVALID_MODE", "mode must be disabled, read_only, dry_run, or apply");
  }

  const appToken = optionalString(value.appToken, "appToken", { maxLength: 512 });
  const tableIds = parseTableIds(value.tableIds);
  const projectMapping = parseProjectMapping(value.projectMapping);
  const fallbackProjectId = projectId(value.fallbackProjectId, "fallbackProjectId");
  const threadId = optionalString(value.threadId, "threadId", { maxLength: 256 });
  const timezone = parseTimezone(value.timezone ?? DEFAULT_TIMEZONE);
  const hermesEndpoint = parseHermesEndpoint(value.hermesEndpoint);
  const excludedScopes = parseExcludedScopes(value.excludedScopes);

  if (mode !== "disabled" && !appToken) {
    fail("MISSING_APP_TOKEN", "An explicit appToken is required when the plugin is enabled");
  }
  if (mode !== "disabled" && !threadId) {
    fail("MISSING_THREAD_ID", "An explicit threadId is required when the plugin is enabled");
  }

  return cloneAndFreeze({
    version,
    mode,
    appToken,
    tableIds,
    projectMapping,
    fallbackProjectId,
    threadId,
    timezone,
    hermesEndpoint,
    excludedScopes,
  });
}

export const normalizeFeishuBaseConfig = parseFeishuBaseConfig;
export const createFeishuBaseConfig = parseFeishuBaseConfig;
export const validateFeishuBaseConfig = parseFeishuBaseConfig;

export function redactFeishuBaseConfig(value) {
  const config = parseFeishuBaseConfig(value);
  return cloneAndFreeze({
    ...config,
    appToken: config.appToken === null ? null : "[REDACTED]",
  });
}

export function resolveFeishuThreadId({
  threadId = undefined,
  configuredThreadId = undefined,
  env = process.env,
} = {}) {
  const candidates = [
    [threadId, "explicit"],
    [env?.CODEX_THREAD_ID, "CODEX_THREAD_ID"],
    [configuredThreadId, "config.threadId"],
  ];
  for (const [candidate, source] of candidates) {
    if (candidate === undefined || candidate === null) continue;
    return Object.freeze({
      threadId: requiredString(candidate, "threadId", { maxLength: 256 }),
      source,
    });
  }
  fail("MISSING_THREAD_ID", "Taskboard writes require threadId or CODEX_THREAD_ID");
}

export function assertCurrentFeishuAppId(appId) {
  if (appId !== FEISHU_PERSONAL_LATEST_BOT.appId) {
    fail("UNSUPPORTED_FEISHU_APP", "Feishu access must use personal-latest-bot");
  }
  return FEISHU_PERSONAL_LATEST_BOT.appId;
}
