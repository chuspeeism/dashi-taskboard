import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 1;
export const DEFAULT_LINEAR_TEAM_KEY = "MM7";
export const LINEAR_CYCLE_SELECTIONS = ["current", "previous", "next", "all"];

export class LinearConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinearConfigError";
    this.code = code;
  }
}

function validateApiKey(apiKey) {
  if (
    typeof apiKey !== "string"
    || !apiKey.trim()
    || apiKey.length > 4096
    || /\s/.test(apiKey.trim())
  ) {
    throw new LinearConfigError(
      "INVALID_LINEAR_API_KEY",
      "Linear API Key 不能为空、不能包含空白字符，且不能超过 4096 个字符",
    );
  }
  return apiKey.trim();
}

function validateTeamKey(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LINEAR_TEAM_KEY;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value.trim())) {
    throw new LinearConfigError(
      "INVALID_LINEAR_TEAM",
      "Linear 团队 Key 只能包含字母、数字、下划线或连字符，且不能超过 32 个字符",
    );
  }
  return value.trim().toUpperCase();
}

export function validateSelectedCycle(value) {
  if (value === undefined || value === null) return "current";
  if (!LINEAR_CYCLE_SELECTIONS.includes(value)) {
    throw new LinearConfigError(
      "INVALID_LINEAR_CYCLE",
      "Linear 周期只能是 current、previous、next 或 all",
    );
  }
  return value;
}

function parseConfig(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== CONFIG_VERSION
  ) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置文件无效");
  }
  const allowedKeys = new Set([
    "version",
    "apiKey",
    "originId",
    "workspaceUrlKey",
    "displayName",
    "teamKey",
    "selectedCycle",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置文件包含未知字段");
  }
  if (typeof value.originId !== "string" || !/^[a-f0-9]{64}$/.test(value.originId)) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置缺少稳定工作区身份");
  }
  if (typeof value.displayName !== "string" || !value.displayName.trim()) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置缺少用户显示名称");
  }
  return {
    version: CONFIG_VERSION,
    apiKey: validateApiKey(value.apiKey),
    originId: value.originId,
    workspaceUrlKey: typeof value.workspaceUrlKey === "string" ? value.workspaceUrlKey : null,
    displayName: value.displayName.trim().slice(0, 254),
    teamKey: validateTeamKey(value.teamKey),
    selectedCycle: validateSelectedCycle(value.selectedCycle),
  };
}

export function createLinearConfigStore({ configPath }) {
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
    validate({ apiKey, teamKey, selectedCycle }) {
      return {
        apiKey: validateApiKey(apiKey),
        teamKey: validateTeamKey(teamKey),
        selectedCycle: validateSelectedCycle(selectedCycle),
      };
    },
  };
}
