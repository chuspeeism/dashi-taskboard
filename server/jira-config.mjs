import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 2;
const LEGACY_CONFIG_VERSION = 1;

export class JiraConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JiraConfigError";
    this.code = code;
  }
}

export function normalizeJiraUrl(value) {
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) {
    throw new JiraConfigError(
      "INVALID_JIRA_URL",
      "Jira 地址必須使用 http 或 https，且不能包含帳號、查詢參數或片段",
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new JiraConfigError("INVALID_JIRA_URL", "Jira 地址無效");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new JiraConfigError(
      "INVALID_JIRA_URL",
      "Jira 地址必須使用 http 或 https，且不能包含帳號、查詢參數或片段",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateCredentials(username, password) {
  if (
    typeof username !== "string"
    || !username.trim()
    || username.length > 254
    || username.includes(":")
  ) {
    throw new JiraConfigError(
      "INVALID_JIRA_USERNAME",
      "Jira 使用者名稱不能為空、不能包含冒號，且不能超過 254 個字元",
    );
  }
  if (typeof password !== "string" || !password || password.length > 4096) {
    throw new JiraConfigError(
      "INVALID_JIRA_PASSWORD",
      "Jira 密碼不能為空且不能超過 4096 個字元",
    );
  }
  return { username: username.trim(), password };
}

function validateProjects(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new JiraConfigError("INVALID_JIRA_PROJECTS", "Jira 專案必須是最多 20 項的陣列");
  }
  const projects = value.map((project) => {
    if (
      typeof project !== "string"
      || !project.trim()
      || project.length > 128
      || /[\u0000-\u001f\u007f]/.test(project)
    ) {
      throw new JiraConfigError(
        "INVALID_JIRA_PROJECTS",
        "Jira 專案名稱或 Key 不能為空、不能包含控制字元，且不能超過 128 個字元",
      );
    }
    return project.trim();
  });
  return [...new Set(projects)];
}

function parseConfig(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (value.version !== LEGACY_CONFIG_VERSION && value.version !== CONFIG_VERSION)
  ) {
    throw new JiraConfigError("INVALID_JIRA_CONFIG", "Jira 設定檔案無效");
  }
  const allowedKeys = new Set([
    "version",
    "baseUrl",
    "username",
    "password",
    "originId",
    "displayName",
    "projects",
  ]);
  if (value.version === LEGACY_CONFIG_VERSION) allowedKeys.delete("originId");
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new JiraConfigError("INVALID_JIRA_CONFIG", "Jira 設定檔案包含未知欄位");
  }
  const credentials = validateCredentials(value.username, value.password);
  if (
    value.version === CONFIG_VERSION
    && (typeof value.originId !== "string" || !/^[a-f0-9]{64}$/.test(value.originId))
  ) {
    throw new JiraConfigError("INVALID_JIRA_CONFIG", "Jira 設定缺少穩定執行個體身分");
  }
  if (typeof value.displayName !== "string" || !value.displayName.trim()) {
    throw new JiraConfigError("INVALID_JIRA_CONFIG", "Jira 設定缺少使用者顯示名稱");
  }
  return {
    version: value.version,
    baseUrl: normalizeJiraUrl(value.baseUrl),
    ...credentials,
    ...(value.version === CONFIG_VERSION ? { originId: value.originId } : {}),
    displayName: value.displayName.trim().slice(0, 254),
    projects: validateProjects(value.projects),
  };
}

export function createJiraConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    async save(input) {
      const config = parseConfig({ ...input, version: CONFIG_VERSION });
      const operation = pendingWrite.catch(() => {}).then(async () => {
        await writeAtomically(config);
        return config;
      });
      pendingWrite = operation.catch(() => {});
      return operation;
    },
    async clear() {
      await pendingWrite;
      try {
        await unlink(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    validate({ baseUrl, username, password, projects }) {
      return {
        baseUrl: normalizeJiraUrl(baseUrl),
        ...validateCredentials(username, password),
        projects: validateProjects(projects),
      };
    },
  };
}
