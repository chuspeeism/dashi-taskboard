import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import { ApiError } from "./database.mjs";
import {
  ComposerCatalog,
  discoverAppServerAiCatalog,
  discoverAiCatalog,
  loadSlashCommands,
  resolveAiWorkspace,
} from "./ai-chat-catalog.mjs";
import { CodexAppServer, CodexHostAppServer } from "./codex-app-server.mjs";
import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  spawnCodexTurn,
} from "./ai-chat-process.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ERROR_CONTENT_LIMIT = 65_536;
const AGENT_DISPATCH_PROTOCOL = "taskboard.agent.v1";
const SKILL_MARKER = "\uFFFC";
const CODEX_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

function agentDispatchText(agent) {
  return [
    `Taskboard private agent dispatch (${AGENT_DISPATCH_PROTOCOL}):`,
    `Use the configured Taskboard agent ${JSON.stringify(agent.name)} (id ${JSON.stringify(agent.id)}) for this request.`,
    "This is Taskboard product-private routing context, not a Codex App Server UserInput type.",
  ].join("\n");
}

function signalProcessGroup(child, signal) {
  signalProcessTree(child, signal);
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function appServerThreadSettings(thread, resolved) {
  const dangerous = thread.sandbox === "danger-full-access";
  return {
    model: thread.model,
    cwd: resolved.workspacePath,
    runtimeWorkspaceRoots: [resolved.workspacePath, ...resolved.addDirectories],
    approvalPolicy: dangerous ? "never" : "on-request",
    ...(dangerous
      ? {}
      : { approvalsReviewer: thread.sandbox === "read-only" ? "user" : "auto_review" }),
    sandbox: thread.sandbox,
  };
}

function codexTargetFromOrigin(origin) {
  if (
    origin?.codexProjectKind !== "remote"
    || !origin.codexProjectId
    || !origin.codexHostId
    || !origin.workspacePath
  ) return undefined;
  return {
    codexProjectId: origin.codexProjectId,
    codexProjectKind: "remote",
    codexHostId: origin.codexHostId,
    workspacePath: origin.workspacePath,
  };
}

function normalizedAppServerItem(item) {
  if (!item || typeof item !== "object") return null;
  const itemId = typeof item.id === "string" ? item.id.slice(0, ERROR_CONTENT_LIMIT) : "";
  const baseData = { status: item.status ?? "completed", ...(itemId ? { itemId } : {}) };
  if (item.type === "agentMessage") {
    return {
      type: "agent_message",
      role: "assistant",
      content: cappedError(item.text),
      data: baseData,
    };
  }
  if (item.type === "commandExecution") {
    return {
      type: "command_execution",
      role: "activity",
      content: cappedError(item.command),
      data: {
        ...baseData,
        command: cappedError(item.command),
        ...(typeof item.aggregatedOutput === "string"
          ? { output: cappedError(item.aggregatedOutput) }
          : {}),
        ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
      },
    };
  }
  if (item.type === "fileChange") {
    const files = Array.isArray(item.changes)
      ? item.changes.flatMap((change) => (
        typeof change?.path === "string" ? [change.path.slice(0, ERROR_CONTENT_LIMIT)] : []
      ))
      : [];
    return {
      type: "file_change",
      role: "activity",
      content: files.join("\n").slice(0, ERROR_CONTENT_LIMIT),
      data: { ...baseData, files },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      type: "mcp_tool_call",
      role: item.error ? "error" : "activity",
      content: `${item.server ?? ""}.${item.tool ?? ""}`.replace(/^\.|\.$/g, ""),
      data: {
        ...baseData,
        ...(typeof item.server === "string" ? { server: item.server } : {}),
        ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
      },
    };
  }
  return null;
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.appServer = options.appServer ?? new CodexAppServer({
      executable: this.codexExecutable,
      processEnv: this.processEnv,
    });
    this.composerCatalog = options.composerCatalog ?? new ComposerCatalog({
      appServer: this.appServer,
      issueSlashCommands: () => loadSlashCommands(),
    });
    this.remoteAppServerFactory = options.remoteAppServerFactory
      ?? ((hostId) => new CodexHostAppServer({ hostId }));
    this.remoteRuntimes = new Map();
    this.resolveContext = options.resolveContext ?? (async (projectId, issueId) => {
      const resolved = await resolveAiWorkspace(projectId, this.codexStatePath, this.database);
      let issue;
      if (issueId !== undefined) {
        issue = this.database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolved, issue };
    });
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
    this.unsubscribeAppServer = this.appServer.subscribe((notification) => {
      this.#handleAppServerNotification(this.appServer, notification);
    });
  }

  #runtimeForTarget(target) {
    if (target?.codexProjectKind !== "remote") {
      return { appServer: this.appServer, composerCatalog: this.composerCatalog };
    }
    let runtime = this.remoteRuntimes.get(target.codexHostId);
    if (runtime) return runtime;
    const appServer = this.remoteAppServerFactory(target.codexHostId);
    const composerCatalog = new ComposerCatalog({
      appServer,
      issueSlashCommands: () => loadSlashCommands(),
      configuredAgents: async () => ({ agents: [], available: false }),
    });
    const unsubscribe = appServer.subscribe((notification) => {
      this.#handleAppServerNotification(appServer, notification);
    });
    runtime = { appServer, composerCatalog, unsubscribe };
    this.remoteRuntimes.set(target.codexHostId, runtime);
    return runtime;
  }

  #runtimeForThread(thread) {
    return this.#runtimeForTarget(codexTargetFromOrigin(thread.origin));
  }

  listThreads() {
    return this.database.listAiChatThreads();
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  getThreadSnapshot(threadId) {
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
    };
  }

  composerCatalogForThread(thread) {
    return this.#runtimeForThread(thread).composerCatalog;
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async #catalogForWorkspace(workspacePath) {
    return discoverAiCatalog({
      codexExecutable: this.codexExecutable,
      workspacePath,
      processEnv: this.processEnv,
    });
  }

  async getCatalog(projectId, resolvedContext, codexTarget) {
    const resolved = resolvedContext ?? await this.resolveContext(projectId, undefined, codexTarget);
    if (resolved.codexProjectKind === "remote") {
      const { appServer } = this.#runtimeForTarget(resolved);
      return discoverAppServerAiCatalog({ appServer, workspacePath: resolved.workspacePath });
    }
    return this.#catalogForWorkspace(resolved.workspacePath);
  }

  async getComposerCandidates({
    projectId,
    threadId,
    trigger,
    query,
    codexProjectId,
    codexProjectKind,
    codexHostId,
    workspacePath,
  }) {
    let thread;
    let codexTarget = codexProjectKind === "remote"
      ? { codexProjectId, codexProjectKind, codexHostId, workspacePath }
      : undefined;
    if (threadId !== undefined) {
      try {
        thread = this.getThread(threadId);
      } catch (error) {
        if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
          throw new ApiError(
            400,
            "INVALID_COMPOSER_QUERY",
            "Composer thread does not exist",
          );
        }
        throw error;
      }
      if (projectId !== undefined && thread.origin.projectId !== projectId) {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_QUERY",
          "Composer thread does not belong to the selected project",
        );
      }
      projectId = thread.origin.projectId;
      codexTarget = codexTargetFromOrigin(thread.origin);
    }

    if (projectId === undefined) {
      const response = await this.composerCatalog.candidates({ workspacePath: null, trigger, query });
      return { ...response, candidates: response.candidates.filter((candidate) => (
        candidate.dispatch?.handlerId !== "compact-conversation"
      )) };
    }

    let resolved;
    try {
      resolved = await this.resolveContext(projectId, thread?.origin.issueId, codexTarget);
    } catch (error) {
      if (error instanceof ApiError && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)) {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
      }
      throw error;
    }
    if (thread && resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread workspace no longer matches the selected project",
      );
    }
    const { composerCatalog } = this.#runtimeForTarget(resolved);
    const response = await composerCatalog.candidates({
      workspacePath: resolved.workspacePath,
      trigger,
      query,
    });
    return {
      ...response,
      candidates: response.candidates.filter((candidate) => (
        candidate.dispatch?.handlerId !== "compact-conversation"
        || (thread?.codexThreadId && thread.status !== "running")
      )),
    };
  }

  async compactThread(threadId) {
    const thread = this.getThread(threadId);
    if (thread.status === "running") {
      throw new ApiError(409, "AI_CHAT_THREAD_RUNNING", "Cannot compact a running conversation");
    }
    if (!thread.codexThreadId) {
      throw new ApiError(409, "AI_CHAT_THREAD_NOT_STARTED", "Conversation has not started");
    }
    await this.#runtimeForThread(thread).appServer.compactThread(thread.codexThreadId);
    return this.getThread(threadId);
  }

  async createThread(input) {
    const codexTarget = input.codexProjectKind === "remote" ? input : undefined;
    const resolved = await this.resolveContext(input.projectId, input.issueId, codexTarget);
    const catalog = await this.getCatalog(input.projectId, resolved, codexTarget);
    const model = this.#resolveModel(catalog, input.model);
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = input.sandbox ?? "workspace-write";
    this.#validateSandbox(sandbox);

    const issue = resolved.issue;

    return this.database.createAiChatThread({
      title: input.title ?? issue?.identifier ?? "New conversation",
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(resolved.codexProjectKind === "remote" ? {
          codexProjectId: resolved.codexProjectId,
          codexProjectKind: resolved.codexProjectKind,
          codexHostId: resolved.codexHostId,
        } : {}),
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      model: model.slug,
      reasoningEffort,
      sandbox,
    });
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["model", "reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (Object.hasOwn(changes, "model") || Object.hasOwn(changes, "reasoningEffort")) {
      const catalog = await this.getCatalog(
        thread.origin.projectId,
        undefined,
        codexTargetFromOrigin(thread.origin),
      );
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, changes);
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  async startTurn(threadId, input) {
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (input?.contractVersion === "composer.v1") {
      return this.#startComposerTurn(thread, input);
    }
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const codexTarget = codexTargetFromOrigin(thread.origin);
    const resolved = await this.resolveContext(
      thread.origin.projectId,
      thread.origin.issueId,
      codexTarget,
    );
    const catalog = await this.getCatalog(thread.origin.projectId, resolved, codexTarget);

    thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    const model = this.#resolveModel(catalog, thread.model);
    this.#validateReasoningEffort(model, thread.reasoningEffort);
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const skillIds = input.skillIds ?? [];
    const availableSkills = new Map(
      catalog.skills
        .filter((skill) => skill.id !== "manage-taskboard")
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    if (resolved.codexProjectKind === "remote") {
      return this.#startRemoteTurn(thread, input, resolved, selectedSkills);
    }

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      const args = buildCodexArgs(thread, resolved.addDirectories, imagePaths);
      const prompt = buildCodexPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
        },
        this.manageTaskboardSkillPath,
      );
      const run = this.database.createAiChatRun({ threadId });
      this.#emit(threadId, { type: "ai.run", run });
      const userEventData = {};
      if (skillIds.length > 0) userEventData.skillIds = skillIds;
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = this.database.insertAiChatEvent({
        threadId,
        runId: run.id,
        type: "user_message",
        role: "user",
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      });
      this.#emit(threadId, { type: "ai.event", event: userEvent });

      const resumingThreadId = thread.codexThreadId;
      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      let pendingError = "";
      const { child, completion } = spawnCodexTurn({
        executable: this.codexExecutable,
        args,
        prompt,
        env: this.processEnv,
        onRawEvent: (raw) => {
          const normalized = normalizeCodexEvent(raw);
          if (!normalized) return;
          if (normalized.kind === "thread.started") {
            if (
              (resumingThreadId && normalized.threadId !== resumingThreadId)
              || (startedThreadId && normalized.threadId !== startedThreadId)
            ) {
              throw new Error("Codex returned an unexpected thread id");
            }
            startedThreadId = normalized.threadId;
            this.database.updateAiChatThread(threadId, { codexThreadId: normalized.threadId });
            return;
          }
          const event = this.database.insertAiChatEvent({
            threadId,
            runId: run.id,
            type: normalized.type,
            role: normalized.role,
            content: normalized.content,
            data: normalized.data,
          });
          if (raw.type === "turn.completed" && terminalOutcome === null) {
            terminalOutcome = "completed";
          } else if (raw.type === "turn.failed") {
            terminalOutcome = "failed";
            terminalError ||= normalized.content;
          } else if (raw.type === "error") {
            pendingError ||= normalized.content;
          }
          this.#emit(threadId, { type: "ai.event", event });
        },
      });

      const active = { child, threadId, interrupted: false, temporaryDirectory };
      this.active.set(run.id, active);
      const finalization = completion.then(
        (result) => this.#finishRun({
          run,
          active,
          result,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
          pendingError: () => pendingError,
        }),
        (error) => this.#finishRun({
          run,
          active,
          error,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
          pendingError: () => pendingError,
        }),
      );
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      run = this.database.updateAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run });
      return run;
    }

    active.interrupted = true;
    if (active.kind === "app-server") {
      if (active.turnId) {
        try {
          await active.appServer.interruptTurn({
            threadId: active.appServerThreadId,
            turnId: active.turnId,
          });
        } catch {}
      }
      const completion = this.completions.get(runId);
      if (completion) {
        await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
      }
      if (this.active.has(runId)) await this.#finishAppServerRun(active, "interrupted");
      return this.getRun(runId);
    }
    signalProcessGroup(active.child, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
    }, this.killGraceMs);
    timer.unref();

    const completion = this.completions.get(runId);
    if (completion) {
      await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
    }
    return this.getRun(runId);
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [, active] of entries) {
      active.interrupted = true;
      if (active.kind === "app-server") {
        if (active.turnId) {
          void active.appServer.interruptTurn({
            threadId: active.appServerThreadId,
            turnId: active.turnId,
          }).catch(() => {});
        }
      } else {
        signalProcessGroup(active.child, "SIGTERM");
      }
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (active.kind !== "app-server" && this.active.has(runId)) {
          signalProcessGroup(active.child, "SIGKILL");
        }
      }
      for (const [, active] of entries) {
        if (active.kind === "app-server" && this.active.has(active.run.id)) {
          await this.#finishAppServerRun(active, "interrupted");
        }
      }
      await settled;
    }
    for (const [, active] of entries) {
      if (active.kind === "app-server" && this.active.has(active.run.id)) {
        await this.#finishAppServerRun(active, "interrupted");
      }
    }
    this.unsubscribeAppServer();
    this.composerCatalog.close();
    await this.appServer.close();
    for (const runtime of this.remoteRuntimes.values()) {
      runtime.unsubscribe();
      runtime.composerCatalog.close();
      await runtime.appServer.close();
    }
    this.remoteRuntimes.clear();
    this.listeners.clear();
  }

  #resolveModel(catalog, requestedModel) {
    const model = requestedModel === undefined
      ? catalog.models[0]
      : catalog.models.find((candidate) => candidate.slug === requestedModel);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        requestedModel === undefined
          ? "Codex did not provide an available model"
          : `Unknown model '${requestedModel}'`,
      );
    }
    return model;
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (!model.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #startAppServerRun({
    thread,
    resolved,
    appServer,
    userInput,
    userEvent,
    temporaryDirectory = null,
  }) {
    const settings = appServerThreadSettings(thread, resolved);
    let appServerThreadId = thread.codexThreadId;
    if (appServerThreadId) {
      const resumed = await appServer.resumeThread({
        threadId: appServerThreadId,
        ...settings,
      });
      if (resumed?.thread?.id !== appServerThreadId) {
        throw new Error("Codex returned an unexpected resumed thread id");
      }
    } else {
      const started = await appServer.startThread(settings);
      appServerThreadId = started?.thread?.id;
      if (typeof appServerThreadId !== "string" || !appServerThreadId) {
        throw new Error("Codex did not provide a thread id");
      }
      this.database.updateAiChatThread(thread.id, { codexThreadId: appServerThreadId });
    }

    const run = this.database.createAiChatRun({ threadId: thread.id });
    this.#emit(thread.id, { type: "ai.run", run });
    const storedUserEvent = this.database.insertAiChatEvent({
      threadId: thread.id,
      runId: run.id,
      type: "user_message",
      role: "user",
      ...userEvent,
    });
    this.#emit(thread.id, { type: "ai.event", event: storedUserEvent });

    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const active = {
      kind: "app-server",
      run,
      threadId: thread.id,
      appServer,
      appServerThreadId,
      turnId: null,
      interrupted: false,
      temporaryDirectory,
      resolveCompletion,
    };
    this.active.set(run.id, active);
    const finalization = completion.finally(() => this.completions.delete(run.id));
    this.completions.set(run.id, finalization);
    try {
      const started = await appServer.startTurn({
        threadId: appServerThreadId,
        input: userInput,
        effort: thread.reasoningEffort,
      });
      const turnId = started?.turn?.id;
      if (typeof turnId !== "string" || !turnId) {
        throw new Error("Codex did not provide a turn id");
      }
      active.turnId = turnId;
    } catch (error) {
      await this.#finishAppServerRun(active, "failed", error);
      throw error;
    }
    return run;
  }

  #remoteAttachmentInput(attachment) {
    const url = `data:${attachment.contentType};base64,${attachment.data.toString("base64")}`;
    if (CODEX_IMAGE_TYPES.has(attachment.contentType)) return { type: "image", url };
    if (attachment.contentType.startsWith("audio/")) return { type: "audio", url };
    return {
      type: "text",
      text: `\n\nAttached file ${attachment.filename}: ${url}`,
    };
  }

  async #startRemoteTurn(thread, input, resolved, selectedSkills) {
    const userInput = [];
    const messageParts = input.message.split(SKILL_MARKER);
    for (const [index, text] of messageParts.entries()) {
      if (text) userInput.push({ type: "text", text });
      const skill = selectedSkills[index];
      if (skill) userInput.push({ type: "skill", name: skill.id, path: skill.path });
    }
    for (const attachment of input.attachments ?? []) {
      userInput.push(this.#remoteAttachmentInput(attachment));
    }
    const userEventData = {};
    if (selectedSkills.length > 0) userEventData.skillIds = selectedSkills.map((skill) => skill.id);
    if ((input.attachments ?? []).length > 0) {
      userEventData.attachments = input.attachments.map(({ filename, contentType, size }) => ({
        filename,
        contentType,
        size,
      }));
    }
    return this.#startAppServerRun({
      thread,
      resolved,
      appServer: this.#runtimeForTarget(resolved).appServer,
      userInput,
      userEvent: {
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      },
    });
  }

  async #startComposerTurn(thread, input) {
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const codexTarget = codexTargetFromOrigin(thread.origin);
    const resolved = await this.resolveContext(
      thread.origin.projectId,
      thread.origin.issueId,
      codexTarget,
    );
    const runtime = this.#runtimeForTarget(resolved);
    thread = this.getThread(thread.id);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(409, "THREAD_BUSY", `AI chat thread '${thread.id}' has a running turn`);
    }
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const nodes = input.document.nodes;
    const unsupportedIndex = nodes.findIndex((node) => !["text", "skill", "agent"].includes(node.type));
    if (unsupportedIndex >= 0) {
      throw new ApiError(
        422,
        "COMPOSER_NODE_UNSUPPORTED",
        `Unsupported composer node at index ${unsupportedIndex}`,
        { nodeIndex: unsupportedIndex },
      );
    }
    const resolvedReferences = nodes.some((node) => node.type === "skill" || node.type === "agent")
      ? await runtime.composerCatalog.resolveReferences({
          workspacePath: resolved.workspacePath,
          revision: input.revision,
          nodes,
        })
      : nodes.map(() => null);
    const attachments = input.attachments ?? [];
    if (
      nodes.every((node) => node.type !== "text" || node.text.trim() === "")
      && !nodes.some((node) => node.type === "skill" || node.type === "agent")
      && attachments.length === 0
    ) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        "A composer message or at least one attachment is required",
      );
    }

    const { temporaryDirectory, attachmentPaths } = resolved.codexProjectKind === "remote"
      ? { temporaryDirectory: null, attachmentPaths: [] }
      : await this.#writeTurnAttachments(attachments);
    try {
      const userInput = nodes.flatMap((node, nodeIndex) => {
        if (node.type === "text") return { type: "text", text: node.text };
        const reference = resolvedReferences[nodeIndex];
        if (node.type === "skill") {
          return [
            { type: "text", text: `$${reference.name}` },
            { type: "skill", name: reference.name, path: reference.path },
          ];
        }
        return { type: "text", text: agentDispatchText(reference) };
      });
      for (const [index, attachment] of attachments.entries()) {
        if (resolved.codexProjectKind === "remote") {
          userInput.push(this.#remoteAttachmentInput(attachment));
          continue;
        }
        const attachmentPath = attachmentPaths[index];
        if (CODEX_IMAGE_TYPES.has(attachment.contentType)) {
          userInput.push({ type: "localImage", path: attachmentPath });
        } else {
          userInput.push({ type: "text", text: `\n\nAttached file: ${attachmentPath}` });
        }
      }

      const agentDispatches = nodes.flatMap((node, nodeIndex) => {
        if (node.type !== "agent") return [];
        const reference = resolvedReferences[nodeIndex];
        return [{ nodeIndex, id: reference.id, name: reference.name }];
      });
      const run = await this.#startAppServerRun({
        thread,
        resolved,
        appServer: runtime.appServer,
        userInput,
        temporaryDirectory,
        userEvent: {
        content: nodes.map((node) => (
          node.type === "text" ? node.text : `@${node.label}`
        )).join(""),
        data: {
          contractVersion: "composer.v1",
          revision: input.revision,
          document: input.document,
          ...(agentDispatches.length > 0
            ? {
                dispatchProtocol: AGENT_DISPATCH_PROTOCOL,
                agentDispatches,
              }
            : {}),
          ...(attachments.length > 0
            ? {
                attachments: attachments.map(({ filename, contentType, size }) => ({
                  filename,
                  contentType,
                  size,
                })),
              }
            : {}),
          },
        },
      });
      return run;
    } catch (error) {
      if (temporaryDirectory && ![...this.active.values()].some(
        (active) => active.temporaryDirectory === temporaryDirectory,
      )) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  #handleAppServerNotification(appServer, notification) {
    const params = notification?.params;
    if (!params || typeof params !== "object") return;
    const active = [...this.active.values()].find((candidate) => (
      candidate.kind === "app-server"
      && candidate.appServer === appServer
      && candidate.appServerThreadId === params.threadId
      && (!candidate.turnId || !params.turnId || candidate.turnId === params.turnId)
    ));
    if (!active) return;

    if (notification.method === "turn/started") {
      if (typeof params.turn?.id === "string") active.turnId = params.turn.id;
      return;
    }
    if (notification.method === "item/completed") {
      const normalized = normalizedAppServerItem(params.item);
      if (!normalized) return;
      const event = this.database.insertAiChatEvent({
        threadId: active.threadId,
        runId: active.run.id,
        ...normalized,
      });
      this.#emit(active.threadId, { type: "ai.event", event });
      return;
    }
    if (notification.method !== "turn/completed") return;
    const status = params.turn?.status;
    if (active.interrupted || status === "interrupted") {
      void this.#finishAppServerRun(active, "interrupted");
    } else if (status === "completed") {
      void this.#finishAppServerRun(active, "completed");
    } else {
      void this.#finishAppServerRun(
        active,
        "failed",
        params.turn?.error?.message ?? "Codex reported a failed turn",
      );
    }
  }

  async #finishAppServerRun(active, status, error) {
    if (!this.active.has(active.run.id)) return this.getRun(active.run.id);
    let publicError = null;
    if (status === "interrupted") publicError = "Interrupted";
    if (status === "failed") publicError = cappedError(error) || "Codex turn failed";
    try {
      if (status === "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: active.threadId,
          runId: active.run.id,
          type: "error",
          role: "error",
          content: publicError,
          data: { status: "failed" },
        });
        this.#emit(active.threadId, { type: "ai.event", event: errorEvent });
      }
      const run = this.database.updateAiChatRun(active.run.id, {
        status,
        exitCode: null,
        error: publicError,
        finishedAt: new Date().toISOString(),
      });
      this.#emit(active.threadId, { type: "ai.run", run });
      return run;
    } finally {
      this.active.delete(active.run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
      active.resolveCompletion();
    }
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      const imagePaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
        if (CODEX_IMAGE_TYPES.has(attachment.contentType)) imagePaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths, imagePaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  async #finishRun({
    run,
    active,
    result,
    error,
    resumingThreadId,
    startedThreadId,
    terminalOutcome,
    terminalError,
    pendingError,
  }) {
    let status;
    let publicError = null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || "Codex turn failed";
    } else if (terminalOutcome() === "failed") {
      status = "failed";
      publicError = terminalError() || "Codex reported a failed turn";
    } else if (result.exitCode !== 0) {
      status = "failed";
      publicError = result.exitCode === null
        ? `Codex exited due to signal ${result.signal ?? "unknown"}`
        : `Codex exited with code ${result.exitCode}`;
    } else if (terminalOutcome() !== "completed") {
      status = "failed";
      publicError = pendingError() || "Codex exited without reporting turn completion";
    } else if (!resumingThreadId && !startedThreadId()) {
      status = "failed";
      publicError = "Codex did not provide a thread id";
    } else {
      status = "completed";
    }

    try {
      if (status === "failed" && terminalOutcome() !== "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: run.threadId,
          runId: run.id,
          type: "error",
          role: "error",
          content: cappedError(publicError),
          data: { status: "failed" },
        });
        this.#emit(run.threadId, { type: "ai.event", event: errorEvent });
      }
      const updated = this.database.updateAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      return updated;
    } finally {
      this.active.delete(run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
