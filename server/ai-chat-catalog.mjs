import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { executableCommand } from "../shared/executable-command.mjs";
import { composerReferencePersistence } from "../shared/composer-reference.mjs";
import { ApiError } from "../shared/api-fields.mjs";

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER = 2 * 1024 * 1024;
const COMPOSER_CONTRACT_VERSION = "composer.v1";
const SLASH_COMMAND_CATALOG_URL = new URL("./codex-slash-commands-0.139.0.json", import.meta.url);
let slashCommandCatalogPromise;

const VERIFIED_SLASH_ACTIONS = [
  {
    command: "/new",
    label: "New conversation",
    description: "Start a new conversation",
    handlerId: "new-conversation",
  },
  {
    command: "/model",
    label: "Model",
    description: "Choose the model",
    handlerId: "open-model-menu",
  },
  {
    command: "/reasoning",
    label: "Reasoning",
    description: "Choose the reasoning effort",
    handlerId: "open-reasoning-menu",
  },
  {
    command: "/compact",
    label: "Compact",
    description: "Compact this conversation's context",
    handlerId: "compact-conversation",
  },
];

const UNSUPPORTED_COMPOSER_SOURCES = [
  { kind: "apps", state: "unsupported", reasonCode: "INVOCATION_NAME_UNAVAILABLE" },
  { kind: "files", state: "unsupported", reasonCode: "ENCODER_UNSUPPORTED" },
  { kind: "plugins", state: "unsupported", reasonCode: "EXPERIMENTAL_SOURCE_NOT_ALLOWED" },
  { kind: "customPrompts", state: "unsupported", reasonCode: "NO_STABLE_CATALOG" },
];

function nonEmptyTomlString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readConfiguredAgent(filePath, roleNameHint = null) {
  try {
    const source = await readFile(filePath, "utf8");
    const parsed = parseToml(source);
    const stableId = nonEmptyTomlString(parsed.name)
      ?? nonEmptyTomlString(parsed.role_name)
      ?? roleNameHint;
    const description = nonEmptyTomlString(parsed.description);
    const developerInstructions = nonEmptyTomlString(parsed.developer_instructions);
    if (!stableId || (roleNameHint === null && (!description || !developerInstructions))) return null;
    return {
      stableId,
      name: stableId,
      label: stableId,
      description,
      developerInstructions,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

async function collectTomlFiles(directory) {
  const files = [];
  const pendingDirectories = [directory];
  let available = false;
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
      available = true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".toml")) {
        files.push(entryPath);
      }
    }
  }
  return { files: files.sort(), available };
}

async function projectConfigFolders(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) return [];
  const folders = [];
  let current = path.resolve(workspacePath);
  while (true) {
    folders.push(path.join(current, ".codex"));
    try {
      await stat(path.join(current, ".git"));
      break;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return folders.reverse();
}

function mergeConfiguredAgent(high, low) {
  return {
    ...low,
    ...high,
    description: high.description ?? low.description,
    developerInstructions: high.developerInstructions ?? low.developerInstructions,
  };
}

function completeConfiguredAgent(agent) {
  return agent
    && agent.stableId
    && agent.description
    ? {
        ...agent,
        identity: ["agent", agent.stableId].join("\u0000"),
        id: agent.stableId,
      }
    : null;
}

async function loadAgentLayer({ configDirectory, configFile, agentsDirectory }) {
  const layerAgents = new Map();
  const declaredFiles = new Set();
  let available = false;
  let config = null;
  try {
    config = parseToml(await readFile(configFile, "utf8"));
    available = true;
  } catch {}
  for (const [declaredName, role] of Object.entries(config?.agents ?? {})) {
    if (!role || typeof role !== "object" || Array.isArray(role)) continue;
    const configFileValue = nonEmptyTomlString(role.config_file);
    let agent = {
      stableId: declaredName,
      name: declaredName,
      label: declaredName,
      description: nonEmptyTomlString(role.description),
      developerInstructions: nonEmptyTomlString(role.developer_instructions),
      sourcePath: configFile,
    };
    if (configFileValue) {
      const declaredFile = path.isAbsolute(configFileValue)
        ? configFileValue
        : path.resolve(configDirectory, configFileValue);
      const fileAgent = await readConfiguredAgent(declaredFile, declaredName);
      if (!fileAgent) continue;
      declaredFiles.add(path.resolve(declaredFile));
      agent = mergeConfiguredAgent(fileAgent, agent);
    }
    if (!layerAgents.has(agent.stableId)) layerAgents.set(agent.stableId, agent);
  }
  const discovered = await collectTomlFiles(agentsDirectory);
  available ||= discovered.available;
  for (const filePath of discovered.files) {
    if (declaredFiles.has(path.resolve(filePath))) continue;
    const agent = await readConfiguredAgent(filePath);
    if (agent && !layerAgents.has(agent.stableId)) layerAgents.set(agent.stableId, agent);
  }
  return { agents: [...layerAgents.values()], available };
}

async function listConfiguredAgents({ codexHome, agentsDirectory, workspacePath }) {
  const projectFolders = await projectConfigFolders(workspacePath);
  const layers = [{
    configDirectory: codexHome,
    configFile: path.join(codexHome, "config.toml"),
    agentsDirectory,
  }, ...projectFolders.map((configDirectory) => ({
    configDirectory,
    configFile: path.join(configDirectory, "config.toml"),
    agentsDirectory: path.join(configDirectory, "agents"),
  }))];
  const effective = new Map();
  let available = false;
  for (const layer of layers) {
    const loaded = await loadAgentLayer(layer);
    available ||= loaded.available;
    for (const agent of loaded.agents) {
      const previous = effective.get(agent.stableId);
      const merged = completeConfiguredAgent(
        previous ? mergeConfiguredAgent(agent, previous) : agent,
      );
      if (merged) effective.set(agent.stableId, merged);
    }
  }
  return {
    agents: [...effective.values()].sort((left, right) => left.label.localeCompare(right.label)),
    available,
  };
}
async function existingDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) return null;
  try {
    const resolved = await realpath(value.trim());
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export async function loadDeviceWorkspaces(codexStatePath, database) {
  const workspaces = new Map();
  let localProjects = {};
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    if (
      state?.["local-projects"]
      && typeof state["local-projects"] === "object"
      && !Array.isArray(state["local-projects"])
    ) {
      localProjects = state["local-projects"];
    }
  } catch {}

  for (const [projectId, project] of Object.entries(localProjects)) {
    if (!Array.isArray(project?.rootPaths)) continue;
    for (const rootPath of project.rootPaths) {
      const workspacePath = await existingDirectory(rootPath);
      if (!workspacePath) continue;
      workspaces.set(projectId, workspacePath);
      break;
    }
  }

  for (const project of await database.listProjects()) {
    if (workspaces.has(project.id)) continue;
    const workspacePath = await existingDirectory(project.workspacePath);
    if (workspacePath) workspaces.set(project.id, workspacePath);
  }
  return workspaces;
}

async function loadMappedWorkspaces(projectMappings) {
  const workspaces = new Map();
  for (const [projectId, mappedPath] of Object.entries(projectMappings)) {
    const workspacePath = await existingDirectory(mappedPath);
    if (workspacePath) workspaces.set(projectId, workspacePath);
  }
  return workspaces;
}

function resolvedWorkspace(projectId, project, workspaces) {
  if (!project || project.id !== projectId) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const workspacePath = workspaces.get(projectId);
  if (!workspacePath) {
    throw new ApiError(
      409,
      "PROJECT_WORKSPACE_UNAVAILABLE",
      `Project '${projectId}' has no available device workspace`,
    );
  }
  return {
    workspacePath,
    addDirectories: [...new Set(workspaces.values())].filter((candidate) => candidate !== workspacePath),
    project,
  };
}

export async function resolveAiWorkspace(projectId, codexStatePath, database) {
  const project = await database.getProject(projectId);
  const workspaces = await loadDeviceWorkspaces(codexStatePath, database);
  return resolvedWorkspace(projectId, project, workspaces);
}

export async function resolveMappedAiWorkspace(projectId, project, projectMappings = {}) {
  const workspaces = await loadMappedWorkspaces(projectMappings);
  return resolvedWorkspace(projectId, project, workspaces);
}

function sanitizeModels(value) {
  if (!Array.isArray(value)) throw new Error("Codex returned an invalid model catalog");
  return value.flatMap((model) => {
    if (
      !model
      || typeof model !== "object"
      || (model.visibility !== undefined && model.visibility !== "list")
      || typeof model.slug !== "string"
      || !model.slug.trim()
    ) {
      return [];
    }
    const slug = model.slug.trim();
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? [...new Set(model.supported_reasoning_levels.flatMap((level) => (
          typeof level?.effort === "string" && level.effort.trim() ? [level.effort.trim()] : []
        )))]
      : [];
    const serviceTiers = Array.isArray(model.service_tiers)
      ? model.service_tiers.flatMap((tier) => (
          typeof tier?.id === "string"
          && tier.id.trim()
          && typeof tier.name === "string"
          && tier.name.trim()
            ? [{ id: tier.id.trim(), name: tier.name.trim() }]
            : []
        ))
      : [];
    return [{
      slug,
      displayName: typeof model.display_name === "string" && model.display_name.trim()
        ? model.display_name.trim()
        : slug,
      description: typeof model.description === "string" ? model.description : "",
      defaultReasoningEffort: typeof model.default_reasoning_level === "string"
        ? model.default_reasoning_level.trim()
        : "",
      supportedReasoningEfforts: efforts,
      serviceTiers,
    }];
  });
}

function sanitizeAppServerModels(value) {
  if (!Array.isArray(value)) throw new Error("Codex returned an invalid model catalog");
  return value.flatMap((model) => {
    if (
      !model
      || typeof model !== "object"
      || model.hidden === true
      || typeof model.model !== "string"
      || !model.model.trim()
    ) return [];
    const slug = model.model.trim();
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? [...new Set(model.supportedReasoningEfforts.flatMap((entry) => (
          typeof entry?.reasoningEffort === "string" && entry.reasoningEffort.trim()
            ? [entry.reasoningEffort.trim()]
            : []
        )))]
      : [];
    const serviceTiers = Array.isArray(model.serviceTiers)
      ? model.serviceTiers.flatMap((tier) => (
          typeof tier?.id === "string"
          && tier.id.trim()
          && typeof tier.name === "string"
          && tier.name.trim()
            ? [{ id: tier.id.trim(), name: tier.name.trim() }]
            : []
        ))
      : [];
    return [{
      slug,
      displayName: typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : slug,
      description: typeof model.description === "string" ? model.description : "",
      defaultReasoningEffort: typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort.trim()
        : "",
      supportedReasoningEfforts: efforts,
      serviceTiers,
    }];
  });
}

function listSkills(codexExecutable, workspacePath, processEnv) {
  return new Promise((resolve, reject) => {
    const command = executableCommand(codexExecutable, ["app-server", "--stdio"]);
    const child = spawn(command.executable, command.args, {
      cwd: workspacePath,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Timed out while reading Codex skills")),
      CATALOG_TIMEOUT_MS,
    );

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) return finish(new Error("Codex app-server rejected initialization"));
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) return finish(new Error("Codex app-server could not list skills"));
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > CATALOG_MAX_BUFFER) {
        finish(new Error("Codex skills response exceeded the catalog size limit"));
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });
}

function sanitizeSkills(entries) {
  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope) ? skill.scope : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function sanitizeComposerSkills(entries) {
  const skills = [];
  const identities = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled !== true
        || typeof skill.name !== "string"
        || !skill.name.trim()
        || typeof skill.path !== "string"
        || !path.isAbsolute(skill.path.trim())
      ) {
        continue;
      }
      const name = skill.name.trim();
      const skillPath = skill.path.trim();
      const identity = `${name}\u0000${skillPath}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      skills.push({
        identity,
        stableId: name.normalize("NFC"),
        name,
        path: skillPath,
        label: displayName || name,
        description: typeof skill.description === "string" && skill.description.trim()
          ? skill.description.trim()
          : null,
      });
    }
  }
  return skills;
}

function composerCatalogSignature(skills, agents) {
  return JSON.stringify([...skills, ...agents].map(({
    identity,
    stableId,
    label,
    description,
    developerInstructions,
  }) => ({
    identity,
    stableId,
    label,
    description,
    developerInstructions,
  })));
}

function composerSources(skillsAvailable, agentsAvailable = true) {
  return [
    skillsAvailable
      ? { kind: "skills", state: "available", reasonCode: null }
      : { kind: "skills", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" },
    agentsAvailable
      ? { kind: "agents", state: "available", reasonCode: null }
      : { kind: "agents", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" },
    { kind: "slash", state: "available", reasonCode: null },
    ...UNSUPPORTED_COMPOSER_SOURCES,
  ];
}

export function composerCandidatesForSurface(
  response,
  surface = "ai-chat",
  issueSlashCommands = null,
  query = "",
) {
  if (surface === "ai-chat") return response;
  if (Array.isArray(issueSlashCommands)) {
    const unique = new Map();
    for (const command of issueSlashCommands) {
      if (
        !command
        || typeof command.id !== "string"
        || !/^[a-z][a-z0-9-]*$/.test(command.id)
        || typeof command.label !== "string"
        || !command.label.trim()
        || typeof command.description !== "string"
        || typeof command.insertText !== "string"
        || !command.insertText.startsWith(`/${command.id}`)
        || command.selectable === false
        || unique.has(command.id)
      ) continue;
      unique.set(command.id, command);
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const candidates = [...unique.values()].flatMap((command, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [command.id, command.label.replace(/^\//, "")],
        command.description,
      );
      if (matchScore < 0) return [];
      return [{
        kind: "slashAction",
        candidateRef: `slash:insert:${command.id}`,
        trigger: "/",
        label: command.label,
        description: command.description,
        group: "Commands",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        command: `/${command.id}`,
        insertionText: command.insertText,
        selection: { type: "insertText", text: command.insertText },
        matchScore,
      }];
    }).sort((left, right) => (
      right.matchScore - left.matchScore || left.itemOrder - right.itemOrder
    )).map(({ matchScore: _matchScore, ...candidate }) => candidate);
    return { ...response, candidates };
  }
  return {
    ...response,
    candidates: response.candidates.map((candidate) => {
      if (candidate.kind !== "slashAction") return candidate;
      const { dispatch: _dispatch, ...persistedCandidate } = candidate;
      return {
        ...persistedCandidate,
        selection: { type: "insertText", text: candidate.insertionText },
      };
    }),
  };
}

function composerMatchScore(query, primaryValues, description = "") {
  if (!query) return 0;
  const normalizedValues = primaryValues.map((value) => value.toLocaleLowerCase());
  const prefixLengths = normalizedValues
    .filter((value) => value.startsWith(query))
    .map((value) => value.length);
  if (prefixLengths.length > 0) return 1_000 - Math.min(...prefixLengths);
  if (normalizedValues.some((value) => value.includes(query))) return 500;
  return description.toLocaleLowerCase().includes(query) ? 100 : -1;
}

function referenceUnavailable(nodeIndex, reasonCode = "SOURCE_UNAVAILABLE") {
  return new ApiError(
    409,
    "COMPOSER_REFERENCE_UNAVAILABLE",
    "A selected composer reference is no longer available",
    { nodeIndex, reasonCode },
  );
}

export class ComposerCatalog {
  constructor({ appServer, agentsDirectory, codexHome, issueSlashCommands, configuredAgents } = {}) {
    this.appServer = appServer;
    this.codexHome = codexHome
      ?? (agentsDirectory ? path.dirname(agentsDirectory) : process.env.CODEX_HOME)
      ?? path.join(os.homedir(), ".codex");
    this.agentsDirectory = agentsDirectory ?? path.join(this.codexHome, "agents");
    this.issueSlashCommands = issueSlashCommands ?? null;
    this.configuredAgents = configuredAgents ?? listConfiguredAgents;
    this.workspaces = new Map();
    this.unsubscribe = appServer.subscribe((notification) => {
      if (notification?.method === "skills/changed") this.invalidate();
    });
  }

  async candidatesForSurface(response, { surface, trigger, query }) {
    if (surface === "ai-chat" || trigger !== "/") {
      return composerCandidatesForSurface(response, surface);
    }
    if (!this.issueSlashCommands) {
      return {
        ...response,
        candidates: [],
        sources: response.sources.map((source) => (
          source.kind === "slash"
            ? { kind: "slash", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" }
            : source
        )),
      };
    }
    try {
      const commands = await this.issueSlashCommands();
      return composerCandidatesForSurface(response, surface, commands, query);
    } catch {
      return {
        ...response,
        candidates: [],
        sources: response.sources.map((source) => (
          source.kind === "slash"
            ? { kind: "slash", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" }
            : source
        )),
      };
    }
  }

  invalidate() {
    this.workspaces.clear();
  }

  close() {
    this.unsubscribe();
    this.workspaces.clear();
  }

  async candidates({ workspacePath, trigger, query }) {
    let entries = [];
    let skillsAvailable = false;
    if (workspacePath) {
      try {
        entries = await this.appServer.listSkills(workspacePath, { forceReload: false });
        skillsAvailable = true;
      } catch {}
    }
    const { agents, available: agentsAvailable } = await this.configuredAgents({
      codexHome: this.codexHome,
      agentsDirectory: this.agentsDirectory,
      workspacePath,
    });
    const workspaceKey = workspacePath ?? "__global__";
    const state = this.#acceptCatalog(workspaceKey, sanitizeComposerSkills(entries), agents);
    const normalizedQuery = query.toLocaleLowerCase();
    const skillIdentityCounts = new Map();
    for (const skill of state.skills) {
      skillIdentityCounts.set(skill.stableId, (skillIdentityCounts.get(skill.stableId) ?? 0) + 1);
    }
    const skillCandidates = trigger === "@" ? state.skills.flatMap((skill, itemOrder) => {
      if (skillIdentityCounts.get(skill.stableId) !== 1) return [];
      const matchScore = composerMatchScore(
        normalizedQuery,
        [skill.label, skill.name],
        skill.description ?? "",
      );
      if (matchScore < 0) return [];
      return [{
        kind: "skill",
        candidateRef: state.refs.get(skill.identity),
        trigger,
        label: skill.label,
        description: skill.description,
        group: "Skills",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        persistence: composerReferencePersistence("skill", skill.stableId, skill.label),
        matchScore,
      }];
    }) : [];
    const agentCandidates = trigger === "@" ? state.agents.flatMap((agent, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [agent.label, agent.stableId],
        agent.description ?? "",
      );
      if (matchScore < 0) return [];
      return [{
        kind: "agent",
        candidateRef: state.refs.get(agent.identity),
        trigger,
        label: agent.label,
        description: agent.description,
        group: "Agents",
        groupOrder: 1,
        itemOrder,
        selectable: true,
        insertionText: `@${agent.name}`,
        persistence: composerReferencePersistence("agent", agent.stableId, agent.label),
        matchScore,
      }];
    }) : [];
    const slashCandidates = trigger === "/" ? VERIFIED_SLASH_ACTIONS.flatMap((action, itemOrder) => {
      const matchScore = composerMatchScore(
        normalizedQuery,
        [action.command.slice(1), action.label],
        action.description,
      );
      if (matchScore < 0) return [];
      return [{
        kind: "slashAction",
        candidateRef: `slash:${action.handlerId}`,
        trigger,
        label: action.label,
        description: action.description,
        group: "Commands",
        groupOrder: 0,
        itemOrder,
        selectable: true,
        command: action.command,
        insertionText: action.command,
        dispatch: { type: "client", handlerId: action.handlerId },
        matchScore,
      }];
    }) : [];
    const candidates = [...skillCandidates, ...agentCandidates, ...slashCandidates]
      .sort((left, right) => (
        right.matchScore - left.matchScore
        || left.groupOrder - right.groupOrder
        || left.itemOrder - right.itemOrder
      ))
      .map(({ matchScore: _matchScore, ...candidate }) => candidate);
    return {
      contractVersion: COMPOSER_CONTRACT_VERSION,
      revision: state.revision,
      candidates,
      sources: composerSources(skillsAvailable, agentsAvailable),
    };
  }

  async rebindPersistedReferences({ workspacePath, nodes }) {
    let entries = [];
    let skillsAvailable = false;
    try {
      entries = await this.appServer.listSkills(workspacePath, { forceReload: true });
      skillsAvailable = true;
    } catch {}
    const { agents, available: agentsAvailable } = await this.configuredAgents({
      codexHome: this.codexHome,
      agentsDirectory: this.agentsDirectory,
      workspacePath,
    });
    const state = this.#acceptCatalog(
      workspacePath,
      sanitizeComposerSkills(entries),
      agents,
    );
    const sources = composerSources(skillsAvailable, agentsAvailable);
    const byStableIdentity = new Map();
    for (const item of state.skills) {
      const key = `skill\u0000${item.stableId}`;
      const matches = byStableIdentity.get(key) ?? [];
      matches.push(item);
      byStableIdentity.set(key, matches);
    }
    for (const item of state.agents) {
      const key = `agent\u0000${item.stableId}`;
      const matches = byStableIdentity.get(key) ?? [];
      matches.push(item);
      byStableIdentity.set(key, matches);
    }

    const reboundNodes = [];
    const bindings = [];
    let ready = true;
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.type === "text") {
        reboundNodes.push(node);
        continue;
      }
      if (node.type === "unsupportedReference") {
        ready = false;
        bindings.push({
          nodeIndex,
          status: "unavailable",
          referenceKind: "unsupported",
          reasonCode: node.reasonCode,
        });
        continue;
      }
      const matches = byStableIdentity.get(`${node.referenceKind}\u0000${node.stableId}`) ?? [];
      let reasonCode = null;
      if (node.referenceKind === "skill" && !skillsAvailable) {
        reasonCode = "SOURCE_UNAVAILABLE";
      } else if (node.referenceKind === "agent" && !agentsAvailable) {
        reasonCode = "SOURCE_UNAVAILABLE";
      } else if (matches.length === 0) {
        reasonCode = "REFERENCE_NOT_FOUND";
      } else if (matches.length > 1) {
        reasonCode = "REFERENCE_AMBIGUOUS";
      }
      if (reasonCode) {
        ready = false;
        bindings.push({
          nodeIndex,
          status: "unavailable",
          referenceKind: node.referenceKind,
          reasonCode,
        });
        continue;
      }
      const reference = matches[0];
      bindings.push({
        nodeIndex,
        status: "resolved",
        referenceKind: node.referenceKind,
        label: reference.label,
      });
      reboundNodes.push({
        type: node.referenceKind,
        candidateRef: state.refs.get(reference.identity),
        label: reference.label,
      });
    }
    return {
      contractVersion: COMPOSER_CONTRACT_VERSION,
      ready,
      revision: state.revision,
      ...(ready ? { document: { version: 1, nodes: reboundNodes } } : {}),
      bindings,
      sources,
      diagnostics: [],
    };
  }

  async resolveReferences({ workspacePath, revision, nodes }) {
    const previous = this.workspaces.get(workspacePath);
    if (!previous || previous.revision !== revision) {
      const firstReferenceIndex = nodes.findIndex((node) => (
        node.type === "skill" || node.type === "agent"
      ));
      throw referenceUnavailable(Math.max(firstReferenceIndex, 0));
    }

    let entries;
    try {
      entries = await this.appServer.listSkills(workspacePath, { forceReload: true });
    } catch {
      const firstReferenceIndex = nodes.findIndex((node) => (
        node.type === "skill" || node.type === "agent"
      ));
      throw referenceUnavailable(Math.max(firstReferenceIndex, 0));
    }
    const { agents } = await this.configuredAgents({
      codexHome: this.codexHome,
      agentsDirectory: this.agentsDirectory,
      workspacePath,
    });
    const current = this.#acceptCatalog(workspacePath, sanitizeComposerSkills(entries), agents);
    if (current.revision !== revision) {
      const firstReferenceIndex = nodes.findIndex((node) => (
        node.type === "skill" || node.type === "agent"
      ));
      throw referenceUnavailable(Math.max(firstReferenceIndex, 0));
    }

    const byRef = new Map([...current.skills, ...current.agents].map((item) => (
      [current.refs.get(item.identity), item]
    )));
    return nodes.map((node, nodeIndex) => {
      if (node.type !== "skill" && node.type !== "agent") return null;
      const reference = byRef.get(node.candidateRef);
      if (!reference) throw referenceUnavailable(nodeIndex);
      return reference;
    });
  }

  async resolveSkills(options) {
    return this.resolveReferences(options);
  }

  #acceptCatalog(workspacePath, skills, agents) {
    const signature = composerCatalogSignature(skills, agents);
    const current = this.workspaces.get(workspacePath);
    if (current?.signature === signature) return current;
    const refs = new Map([...skills, ...agents].map((item) => [item.identity, randomUUID()]));
    const state = { revision: randomUUID(), signature, skills, agents, refs };
    this.workspaces.set(workspacePath, state);
    return state;
  }
}

export async function loadSlashCommands(platform = process.platform) {
  slashCommandCatalogPromise ??= readFile(SLASH_COMMAND_CATALOG_URL, "utf8")
    .then((source) => JSON.parse(source));
  const catalog = await slashCommandCatalogPromise;
  if (!Array.isArray(catalog?.commands)) {
    throw new Error("Codex slash command catalog is invalid");
  }
  return catalog.commands.flatMap((command) => {
    if (
      !command
      || typeof command.id !== "string"
      || !/^[a-z][a-z0-9-]*$/.test(command.id)
      || typeof command.description !== "string"
      || command.debugOnly === true
      || (Array.isArray(command.platforms) && !command.platforms.includes(platform))
      || (Array.isArray(command.excludedPlatforms) && command.excludedPlatforms.includes(platform))
    ) {
      return [];
    }
    return [{
      id: command.id,
      label: `/${command.id}`,
      description: command.description,
      insertText: `/${command.id}${command.supportsInlineArgs === true ? " " : ""}`,
    }];
  });
}

export async function discoverAiCatalog({
  codexExecutable,
  workspacePath,
  processEnv,
}) {
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  const modelCommand = executableCommand(codexExecutable, ["debug", "models"]);
  const [modelResult, skillEntries, commands] = await Promise.all([
    execFileAsync(modelCommand.executable, modelCommand.args, {
      cwd: workspacePath,
      env: environment,
      encoding: "utf8",
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: CATALOG_MAX_BUFFER,
      windowsHide: true,
    }),
    listSkills(codexExecutable, workspacePath, environment),
    loadSlashCommands(),
  ]);
  const modelCatalog = JSON.parse(modelResult.stdout);
  return {
    models: sanitizeModels(modelCatalog?.models),
    skills: sanitizeSkills(skillEntries),
    commands,
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  };
}

export async function discoverAppServerAiCatalog({ appServer, workspacePath }) {
  const [modelResult, skillEntries, commands] = await Promise.all([
    appServer.request("model/list", { cursor: null, limit: 100, includeHidden: false }),
    appServer.listSkills(workspacePath, { forceReload: false }),
    loadSlashCommands(),
  ]);
  return {
    models: sanitizeAppServerModels(modelResult?.data),
    skills: sanitizeSkills(skillEntries),
    commands,
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  };
}
