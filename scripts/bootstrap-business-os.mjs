#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BOOTSTRAP_VERSION = "business-os-v0.1";
const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823";

function usage() {
  return `Usage: npm run bootstrap:business-os -- [options]

Options:
  --config FILE    私有项目清单 JSON（或读取 CODEX_BUSINESS_OS_CONFIG）
  --url URL        Taskboard 本地服务地址（默认读取 CODEX_TASKBOARD_URL，或 ${DEFAULT_TASKBOARD_URL}）
  --dry-run        只检查并输出计划，不写入
  --json           以 JSON 输出结果
  --help           显示帮助
`;
}

function parseArgs(argv) {
  const options = {
    config: process.env.CODEX_BUSINESS_OS_CONFIG || "",
    url: process.env.CODEX_TASKBOARD_URL || DEFAULT_TASKBOARD_URL,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      options.config = argv[++index];
      if (!options.config) throw new Error("--config requires a value");
    } else if (argument === "--url") {
      options.url = argv[++index];
      if (!options.url) throw new Error("--url requires a value");
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

async function loadProjectSpecs(filename) {
  if (!filename) {
    throw new Error("Project config is required; pass --config FILE or set CODEX_BUSINESS_OS_CONFIG");
  }
  let payload;
  try {
    payload = JSON.parse(await readFile(path.resolve(filename), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read project config '${filename}': ${error.message}`);
  }
  const projects = Array.isArray(payload) ? payload : payload?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("Project config must contain a non-empty 'projects' array");
  }
  const seenPaths = new Set();
  return projects.map((spec, index) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`Project config item ${index + 1} must be an object`);
    }
    const normalized = {};
    for (const field of ["name", "area", "workspacePath"]) {
      if (typeof spec[field] !== "string" || !spec[field].trim()) {
        throw new Error(`Project config item ${index + 1} requires a non-empty '${field}'`);
      }
      normalized[field] = spec[field].trim();
    }
    normalized.workspacePath = path.resolve(normalized.workspacePath);
    if (seenPaths.has(normalized.workspacePath)) {
      throw new Error(`Project config contains duplicate workspace '${normalized.workspacePath}'`);
    }
    seenPaths.add(normalized.workspacePath);
    return normalized;
  });
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Taskboard URL must use HTTP or HTTPS");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Business OS V0.1 bootstrap only writes to a loopback Taskboard service");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function apiUrl(baseUrl, route) {
  return new URL(route.replace(/^\/+/, ""), baseUrl);
}

async function requestJson(baseUrl, method, route, body) {
  let response;
  try {
    response = await fetch(apiUrl(baseUrl, route), {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`Cannot reach Taskboard at ${baseUrl.origin}: ${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${route} returned non-JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    const code = payload?.error?.code ? ` [${payload.error.code}]` : "";
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${route} failed${code}: ${message}`);
  }
  return payload;
}

function normalizedPath(value) {
  return path.resolve(String(value));
}

function markerForProject(projectId) {
  return `<!-- ${BOOTSTRAP_VERSION};project=${projectId} -->`;
}

function projectReadme(spec) {
  const inbox = spec.id === "local";
  const title = inbox ? "收件箱" : spec.name;
  const workspaceLine = inbox
    ? "- 工作区：不绑定单一目录；完成分流后移动到真实项目"
    : `- 本地工作区：\`${spec.workspacePath}\``;
  return `${markerForProject(spec.id)}
# ${title}

- 业务域：${spec.area}
${workspaceLine}
- 角色：${inbox ? "收集尚未归类的工作" : "承载该真实 Codex 项目的任务、对话和验收记录"}

## 状态约定

- \`backlog\`：尚未批准执行。
- \`todo\`：目标与验收标准明确，已允许 Codex 开始。
- \`in_progress\`：已有执行对话负责。
- \`in_review\`：交付物和验证证据齐全，等待人工验收。
- \`done\`：仅在用户明确验收后使用。

## 最小任务说明

每张可执行任务至少写明：目标、交付物、验收标准、事实来源、安全边界。业务系统状态与 Codex 工作状态分别记录。

## 数据边界

Taskboard 只保存推进工作所需的最小摘要和来源引用。账号凭证、完整合同、完整身份或账户资料、客户原始数据继续保存在各自权威系统中。最终发布、付款、签署和不可逆删除必须逐次人工确认。
`;
}

async function inspectWorkspaceSpecs(baseUrl, projectSpecs) {
  const missingDirectories = [];
  for (const spec of projectSpecs) {
    try {
      const info = await stat(spec.workspacePath);
      if (!info.isDirectory()) missingDirectories.push(`${spec.workspacePath} (not a directory)`);
    } catch {
      missingDirectories.push(`${spec.workspacePath} (missing)`);
    }
  }
  if (missingDirectories.length > 0) {
    throw new Error(`Required Codex workspaces are unavailable:\n- ${missingDirectories.join("\n- ")}`);
  }

  const payload = await requestJson(baseUrl, "GET", "api/device-workspaces");
  const workspaces = payload?.workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    throw new Error("Taskboard returned an invalid device workspace catalog");
  }

  return projectSpecs.map((spec) => {
    const matches = Object.entries(workspaces).filter(([, workspacePath]) => (
      typeof workspacePath === "string"
      && normalizedPath(workspacePath) === normalizedPath(spec.workspacePath)
    ));
    if (matches.length !== 1) {
      throw new Error(
        `${spec.name}: expected exactly one Codex project for ${spec.workspacePath}, found ${matches.length}`,
      );
    }
    return { ...spec, id: matches[0][0] };
  });
}

function inspectExistingProjects(projects, specs) {
  if (!projects.some((project) => project.id === "local")) {
    throw new Error("Taskboard default project 'local' is missing");
  }
  if (!projects.every((project) => Object.hasOwn(project, "area"))) {
    throw new Error("Taskboard backend does not expose projects.area yet; rebuild and restart the updated server first");
  }

  const existingById = new Map(projects.map((project) => [project.id, project]));
  const create = [];
  const reuse = [];
  const update = [];
  for (const spec of specs) {
    const samePath = projects.filter((project) => (
      project.workspacePath
      && normalizedPath(project.workspacePath) === normalizedPath(spec.workspacePath)
    ));
    const existing = existingById.get(spec.id);
    if (!existing && samePath.length > 0) {
      throw new Error(
        `${spec.name}: workspace is already mapped to Taskboard project '${samePath[0].id}', expected Codex project id '${spec.id}'`,
      );
    }
    if (!existing) {
      create.push(spec);
      continue;
    }
    const mismatches = [];
    if (existing.name !== spec.name) mismatches.push(`name=${JSON.stringify(existing.name)}`);
    const needsAreaBackfill = existing.area === null;
    if (!needsAreaBackfill && existing.area !== spec.area) {
      mismatches.push(`area=${JSON.stringify(existing.area)}`);
    }
    if (normalizedPath(existing.workspacePath ?? "") !== normalizedPath(spec.workspacePath)) {
      mismatches.push(`workspacePath=${JSON.stringify(existing.workspacePath)}`);
    }
    if (mismatches.length > 0) {
      throw new Error(
        `${spec.name}: existing project '${spec.id}' does not match the manifest (${mismatches.join(", ")})`,
      );
    }
    if (samePath.length !== 1 || samePath[0].id !== spec.id) {
      throw new Error(`${spec.name}: duplicate Taskboard workspace mappings detected`);
    }
    if (needsAreaBackfill) update.push(spec);
    else reuse.push(spec);
  }
  return { create, reuse, update };
}

async function ensureProjectReadme(baseUrl, spec, dryRun, result) {
  const marker = markerForProject(spec.id);
  const payload = await requestJson(baseUrl, "GET", `api/projects/${encodeURIComponent(spec.id)}/readme`);
  const readme = payload?.readme;
  if (!readme || typeof readme.content !== "string" || !Number.isInteger(readme.version)) {
    throw new Error(`${spec.name}: Taskboard returned an invalid project README`);
  }
  if (readme.content.includes(marker)) {
    result.readmes.reused.push(spec.id);
    return;
  }
  if (readme.content.trim()) {
    result.warnings.push(`${spec.name}: existing README was preserved because it is not managed by ${BOOTSTRAP_VERSION}`);
    result.readmes.preserved.push(spec.id);
    return;
  }
  if (!dryRun) {
    await requestJson(baseUrl, "PUT", `api/projects/${encodeURIComponent(spec.id)}/readme`, {
      content: projectReadme(spec),
      version: readme.version,
    });
  }
  result.readmes.created.push(spec.id);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const projectSpecs = await loadProjectSpecs(options.config);
  const baseUrl = normalizeBaseUrl(options.url);
  const metadata = await requestJson(baseUrl, "GET", "api/meta");
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Taskboard metadata check returned an invalid response");
  }
  const cloudSession = await requestJson(baseUrl, "GET", "api/local/cloud-session");
  if (cloudSession?.mode !== "local") {
    throw new Error("Business OS V0.1 bootstrap requires local mode; log out of cloud mode first");
  }

  const specs = await inspectWorkspaceSpecs(baseUrl, projectSpecs);
  const projectPayload = await requestJson(baseUrl, "GET", "api/projects");
  const projects = Array.isArray(projectPayload?.projects) ? projectPayload.projects : null;
  if (!projects) throw new Error("Taskboard returned an invalid project list");
  const projectPlan = inspectExistingProjects(projects, specs);

  const result = {
    bootstrapVersion: BOOTSTRAP_VERSION,
    dryRun: options.dryRun,
    taskboardUrl: baseUrl.origin,
    inboxProjectId: "local",
    workspacesMatched: specs.length,
    projects: {
      created: [],
      reused: projectPlan.reuse.map((spec) => spec.id),
      updated: [],
    },
    readmes: { created: [], reused: [], preserved: [] },
    warnings: [],
    imported: { historicalTasks: 0, conversations: 0, attachments: 0, businessFiles: 0 },
  };

  for (const spec of projectPlan.create) {
    if (!options.dryRun) {
      await requestJson(baseUrl, "POST", "api/projects", {
        id: spec.id,
        name: spec.name,
        area: spec.area,
        workspacePath: spec.workspacePath,
      });
    }
    result.projects.created.push(spec.id);
  }

  for (const spec of projectPlan.update) {
    if (!options.dryRun) {
      await requestJson(baseUrl, "PATCH", `api/projects/${encodeURIComponent(spec.id)}`, {
        area: spec.area,
      });
    }
    result.projects.updated.push(spec.id);
  }

  const inboxSpec = { id: "local", name: "收件箱", area: "收件箱", workspacePath: null };
  if (!options.dryRun || projects.some((project) => project.id === "local")) {
    await ensureProjectReadme(baseUrl, inboxSpec, options.dryRun, result);
  }
  for (const spec of specs) {
    if (options.dryRun && projectPlan.create.some((candidate) => candidate.id === spec.id)) {
      result.readmes.created.push(spec.id);
    } else {
      await ensureProjectReadme(baseUrl, spec, options.dryRun, result);
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const mode = options.dryRun ? "DRY RUN" : "COMPLETE";
  process.stdout.write([
    `Business OS V0.1 bootstrap ${mode}`,
    `Taskboard: ${baseUrl.origin}`,
    `Codex workspaces matched: ${result.workspacesMatched}`,
    `Projects: ${result.projects.created.length} create, ${result.projects.updated.length} update, ${result.projects.reused.length} reuse`,
    `Project READMEs: ${result.readmes.created.length} create, ${result.readmes.reused.length} reuse, ${result.readmes.preserved.length} preserve`,
    "Imported historical tasks/conversations/attachments/business files: 0/0/0/0",
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`Business OS bootstrap failed: ${error.message}\n`);
  process.exitCode = 1;
});
