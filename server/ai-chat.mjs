import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";
import { discoverAiCatalog, resolveAiWorkspace } from "./ai-chat-catalog.mjs";
import {
  CODEX_THREAD_NOT_FOUND,
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  normalizeCodexErrorCode,
  spawnCodexTurn,
} from "./ai-chat-process.mjs";
import { TASK_PLAN_OUTPUT_SCHEMA } from "./task-coordinator.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ERROR_CONTENT_LIMIT = 65_536;
const execFileAsync = promisify(execFile);
const CODEX_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const TASK_AI_STRATEGIES = Object.freeze({
  planner: Object.freeze({
    role: "planner",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: null,
    sandbox: "read-only",
  }),
  worker: Object.freeze({
    role: "worker",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: "priority",
    sandbox: "workspace-write",
  }),
});

const TASK_AI_LOCKED_SETTINGS = Object.freeze({
  planner: Object.freeze(["role", "sandbox"]),
  worker: Object.freeze(["role", "sandbox"]),
});

function strategyForIssue(issue) {
  const isPlanner = Array.isArray(issue?.labels)
    && issue.labels.includes("主任务")
    && issue.relations?.parent == null;
  return isPlanner ? TASK_AI_STRATEGIES.planner : TASK_AI_STRATEGIES.worker;
}

function isDeliveryReviewThread(input) {
  return input.role === "planner"
    && typeof input.title === "string"
    && input.title.endsWith("· 交付重新审核");
}

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

async function isInsideGitWorkTree(workspacePath, env) {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", env, timeout: 2_000 },
    );
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.active = new Map();
    this.listeners = new Map();
    this.settledListeners = new Set();
    this.threadUpdatedListeners = new Set();
    this.completions = new Map();
  }

  listThreads(archived = "false") {
    return this.database.listAiChatThreads({ archived });
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

  subscribeRunSettled(listener) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  subscribeThreadUpdated(listener) {
    this.threadUpdatedListeners.add(listener);
    return () => this.threadUpdatedListeners.delete(listener);
  }

  notifyThreadChanged(threadId) {
    this.#emit(threadId, { type: "ai.retry", retryJob: this.getThread(threadId).retryJob ?? null });
  }

  async getCatalog(projectId) {
    return discoverAiCatalog({
      codexExecutable: this.codexExecutable,
      codexStatePath: this.codexStatePath,
      database: this.database,
      projectId,
      processEnv: this.processEnv,
    });
  }

  async createThread(input) {
    let issue;
    if (input.issueId !== undefined) {
      issue = this.database.getTask(input.issueId);
      if (!issue || issue.projectId !== input.projectId) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${input.issueId}' does not exist in project '${input.projectId}'`,
        );
      }
      if (issue.archivedAt !== null) {
        throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot create or reuse AI chat threads");
      }
    }
    if (issue && isDeliveryReviewThread(input)) issue = undefined;

    const taskStrategy = issue ? strategyForIssue(issue) : null;
    const role = taskStrategy?.role ?? input.role ?? "worker";
    this.#validateRole(role);
    if (taskStrategy) {
      for (const key of TASK_AI_LOCKED_SETTINGS[taskStrategy.role]) {
        if (input[key] !== undefined && input[key] !== taskStrategy[key]) {
          throw new ApiError(
            409,
            "TASK_STRATEGY_LOCKED",
            "Task-bound AI thread role and sandbox are fixed by task semantics",
          );
        }
      }
    }
    const existing = issue
      ? this.database.findReusableAiChatThread(issue.id, role)
      : null;
    if (existing) return existing;

    const workerUsesDefaults = taskStrategy?.role === "worker"
      && (input.model === undefined || input.model === taskStrategy.model)
      && (input.reasoningEffort === undefined || input.reasoningEffort === taskStrategy.reasoningEffort)
      && (input.serviceTier === undefined || input.serviceTier === taskStrategy.serviceTier);
    const [catalog, resolved] = await Promise.all([
      workerUsesDefaults ? Promise.resolve(null) : this.getCatalog(input.projectId),
      resolveAiWorkspace(input.projectId, this.codexStatePath, this.database),
    ]);
    const requestedModel = input.model ?? taskStrategy?.model;
    const model = catalog ? this.#resolveModel(catalog, requestedModel) : null;
    const reasoningEffort = input.reasoningEffort
      ?? taskStrategy?.reasoningEffort
      ?? model.defaultReasoningEffort;
    const serviceTier = Object.hasOwn(input, "serviceTier")
      ? input.serviceTier
      : taskStrategy?.serviceTier ?? null;
    if (model) {
      this.#validateReasoningEffort(model, reasoningEffort);
      this.#validateServiceTier(model, serviceTier);
    }
    const sandbox = taskStrategy?.sandbox
      ?? input.sandbox
      ?? (role === "planner" ? "read-only" : "workspace-write");
    this.#validateSandbox(sandbox);

    const threadInput = {
      title: input.title ?? issue?.identifier ?? "New conversation",
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      role,
      model: model?.slug ?? requestedModel,
      reasoningEffort,
      serviceTier,
      sandbox,
    };
    return issue
      ? this.database.createOrReuseTaskAiChatThread(threadInput)
      : this.database.createAiChatThread(threadInput);
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    this.#assertThreadWritable(thread);
    if (Object.hasOwn(changes, "role")) this.#validateRole(changes.role);
    const taskStrategy = this.#taskStrategyForThread(thread);
    if (taskStrategy) {
      for (const key of TASK_AI_LOCKED_SETTINGS[taskStrategy.role]) {
        if (Object.hasOwn(changes, key) && changes[key] !== taskStrategy[key]) {
          throw new ApiError(
            409,
            "TASK_STRATEGY_LOCKED",
            "Task-bound AI thread role and sandbox are fixed by task semantics",
          );
        }
      }
    }
    const changesSettings = ["role", "model", "reasoningEffort", "serviceTier", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const threadWasActive = this.#threadIsActive(thread);
    const wasActive = changesSettings && threadWasActive;

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (taskStrategy && !threadWasActive) {
      thread = this.#synchronizeTaskStrategy(thread, taskStrategy);
    }
    if (
      Object.hasOwn(changes, "model")
      || Object.hasOwn(changes, "reasoningEffort")
      || Object.hasOwn(changes, "serviceTier")
    ) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
      const serviceTier = Object.hasOwn(changes, "serviceTier")
        ? changes.serviceTier
        : thread.serviceTier;
      this.#validateServiceTier(model, serviceTier);
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
    return this.database.archiveAiChatThread(threadId, thread.version);
  }

  archiveThread(threadId, version) {
    const thread = this.getThread(threadId);
    if (thread.origin.issueId) {
      throw new ApiError(
        409,
        "TASK_BOUND_THREAD_LIFECYCLE",
        "Task-bound AI chat threads are archived and restored with their task",
      );
    }
    this.#assertThreadWritable(thread);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(409, "AI_CHAT_THREAD_BUSY", `AI chat thread '${threadId}' has a running turn`);
    }
    return this.database.archiveAiChatThread(threadId, version);
  }

  restoreThread(threadId, version) {
    const thread = this.getThread(threadId);
    if (thread.origin.issueId) {
      throw new ApiError(
        409,
        "TASK_BOUND_THREAD_LIFECYCLE",
        "Task-bound AI chat threads are archived and restored with their task",
      );
    }
    return this.database.restoreAiChatThread(threadId, version);
  }

  async startTurn(threadId, input, internalOptions = {}) {
    let dispatchKey = internalOptions.dispatchKey ?? null;
    if (dispatchKey !== null && (
      typeof dispatchKey !== "string"
      || dispatchKey.length === 0
      || dispatchKey.length > 256
      || dispatchKey.includes("\0")
    )) {
      throw new ApiError(400, "INVALID_DISPATCH_KEY", "Internal dispatchKey is invalid");
    }
    let thread = this.getThread(threadId);
    this.#assertThreadWritable(thread);
    this.#assertOriginTaskWritable(thread);
    if (!dispatchKey && thread.origin.issueId) {
      const managedDispatch = this.database.findTaskDispatchForTask(thread.origin.issueId, thread.role);
      if (managedDispatch) {
        const boundRun = managedDispatch.runId
          ? this.database.getAiChatRun(managedDispatch.runId)
          : null;
        if (boundRun && managedDispatch.threadId === thread.id) return boundRun;
        throw new ApiError(
          409,
          "TASK_DISPATCH_SERVER_MANAGED",
          "This task has a server-managed AI dispatch; the public turn cannot claim it",
        );
      }
    }
    if (this.#threadIsActive(thread)) {
      if (dispatchKey) {
        const dispatch = this.database.getTaskDispatch(dispatchKey);
        const existingRun = dispatch?.runId ? this.database.getAiChatRun(dispatch.runId) : null;
        if (existingRun) return existingRun;
      }
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    thread = this.#synchronizeTaskStrategy(thread);
    this.#assertNoDuplicateTaskRun(thread);
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const skillIds = input.skillIds ?? [];
    const lockedWorkerTurn = Boolean(
      thread.origin.issueId
      && thread.role === "worker"
      && skillIds.length === 0
    );
    const [catalog, resolved] = await Promise.all([
      lockedWorkerTurn ? Promise.resolve(null) : this.getCatalog(thread.origin.projectId),
      resolveAiWorkspace(thread.origin.projectId, this.codexStatePath, this.database),
    ]);

    thread = this.getThread(threadId);
    this.#assertThreadWritable(thread);
    this.#assertOriginTaskWritable(thread);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    thread = this.#synchronizeTaskStrategy(thread);
    this.#assertNoDuplicateTaskRun(thread);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    if (catalog) {
      const model = this.#resolveModel(catalog, thread.model);
      this.#validateReasoningEffort(model, thread.reasoningEffort);
      this.#validateServiceTier(model, thread.serviceTier);
    }
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const availableSkills = new Map(
      (catalog?.skills ?? [])
        .filter((skill) => skill.id !== "manage-taskboard")
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    let runTemporaryDirectory = temporaryDirectory;
    let outputSchemaPath = null;
    let outputSchemaOwned = false;
    const cleanupTemporaryResources = async () => {
      if (runTemporaryDirectory) {
        await rm(runTemporaryDirectory, { recursive: true, force: true });
      } else if (outputSchemaOwned && outputSchemaPath) {
        await rm(path.dirname(outputSchemaPath), { recursive: true, force: true });
      }
    };
    try {
      let dispatch = null;
      if (dispatchKey) {
        dispatch = this.database.getTaskDispatch(dispatchKey);
        if (!dispatch) {
          dispatch = this.database.claimTaskDispatch({
            dispatchKey,
            taskId: thread.origin.issueId ?? null,
            kind: internalOptions.kind ?? thread.role,
            role: thread.role,
          }).dispatch;
        }
        if (dispatch.runId) {
          const existingRun = this.database.getAiChatRun(dispatch.runId);
          if (existingRun) {
            await cleanupTemporaryResources();
            return existingRun;
          }
        }
        if (["completed", "failed", "unknown"].includes(dispatch.status)) {
          throw new ApiError(409, "DISPATCH_NOT_REUSABLE", `Dispatch '${dispatchKey}' is already terminal`);
        }
        if (!dispatch.threadId) {
          dispatch = this.database.bindTaskDispatch(dispatchKey, { threadId });
        }
      }
      const outputSchema = internalOptions.outputSchema
        ?? (dispatch?.role === "planner" ? TASK_PLAN_OUTPUT_SCHEMA : undefined);
      if (outputSchema !== undefined) {
        if (typeof outputSchema === "string") {
          if (!path.isAbsolute(outputSchema) || outputSchema.includes("\0")) {
            throw new ApiError(400, "INVALID_OUTPUT_SCHEMA", "Internal outputSchema path is invalid");
          }
          outputSchemaPath = outputSchema;
        } else if (outputSchema && typeof outputSchema === "object") {
          const schemaDirectory = temporaryDirectory ?? await mkdtemp(
            path.join(this.temporaryDirectory, "codex-taskboard-ai-schema-"),
          );
          runTemporaryDirectory = schemaDirectory;
          outputSchemaPath = path.join(schemaDirectory, "output-schema.json");
          await writeFile(outputSchemaPath, JSON.stringify(outputSchema), {
            flag: "wx",
            mode: 0o600,
          });
          outputSchemaOwned = temporaryDirectory === null;
        } else {
          throw new ApiError(400, "INVALID_OUTPUT_SCHEMA", "Internal outputSchema must be an object or absolute path");
        }
      }
      const codexArgsOptions = {
        outputSchemaPath,
        skipGitRepoCheck: !(await isInsideGitWorkTree(resolved.workspacePath, this.processEnv)),
      };
      const args = buildCodexArgs(thread, resolved.addDirectories, imagePaths, codexArgsOptions);
      const prompt = buildCodexPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
        },
        this.manageTaskboardSkillPath,
      );
      const runResult = this.database.createAiChatRunIdempotently({
        threadId,
        dispatchKey,
        retryJobId: internalOptions.retryJobId ?? null,
      });
      const run = runResult.run;
      if (!runResult.created) {
        await cleanupTemporaryResources();
        return run;
      }
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
      let attemptResumingThreadId = resumingThreadId;
      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      let terminalErrorCode = null;
      let recoverableRootError = "";
      let recoverableRootErrorCode = null;
      let recoverableItemErrorCode = null;
      let assistantText = "";
      const active = {
        child: null,
        threadId,
        interrupted: false,
        temporaryDirectory: runTemporaryDirectory,
      };
      const resetAttemptState = () => {
        startedThreadId = null;
        terminalOutcome = null;
        terminalError = "";
        terminalErrorCode = null;
        recoverableRootError = "";
        recoverableRootErrorCode = null;
        recoverableItemErrorCode = null;
        assistantText = "";
      };
      const onRawEvent = (raw) => {
        const normalized = normalizeCodexEvent(raw);
        if (!normalized) return;
        if (normalized.kind === "thread.started") {
          if (
            (attemptResumingThreadId && normalized.threadId !== attemptResumingThreadId)
            || (startedThreadId && normalized.threadId !== startedThreadId)
          ) {
            throw new Error("Codex returned an unexpected thread id");
          }
          startedThreadId = normalized.threadId;
          const previousThread = this.database.getAiChatThread(threadId);
          if (previousThread?.codexThreadId !== normalized.threadId) {
            const updatedThread = this.database.updateAiChatThread(threadId, {
              codexThreadId: normalized.threadId,
            });
            this.#notifyThreadUpdated({
              thread: updatedThread,
              previousThread,
              dispatchKey,
            });
          }
          return;
        }
        if (raw.item?.type === "agent_message" && typeof raw.item.text === "string") {
          assistantText = raw.item.text.slice(0, ERROR_CONTENT_LIMIT);
        }
        const event = this.database.insertAiChatEvent({
          threadId,
          runId: run.id,
          type: normalized.type,
          role: normalized.role,
          content: normalized.content,
          data: normalized.data,
        });
        if (raw.type === "turn.completed") {
          terminalOutcome = "completed";
        } else if (raw.type === "turn.failed") {
          terminalOutcome = "failed";
          terminalError ||= normalized.content;
          terminalErrorCode ||= normalized.data?.errorCode ?? null;
        } else if (raw.type === "error") {
          recoverableRootError ||= normalized.content;
          recoverableRootErrorCode ||= normalized.data?.errorCode ?? null;
        } else if (raw.item?.type === "error") {
          recoverableItemErrorCode ||= normalized.data?.errorCode ?? null;
        }
        this.#emit(threadId, { type: "ai.event", event });
      };
      const spawnAttempt = (attemptArgs, attemptThreadId, recoverMissingThread = null) => {
        attemptResumingThreadId = attemptThreadId;
        const { child, completion } = spawnCodexTurn({
          executable: this.codexExecutable,
          args: attemptArgs,
          prompt,
          env: this.processEnv,
          onRawEvent,
        });
        active.child = child;
        return completion.then(
          (result) => this.#finishRun({
            run,
            active,
            result,
            resumingThreadId: attemptThreadId,
            startedThreadId: () => startedThreadId,
            terminalOutcome: () => terminalOutcome,
            terminalError: () => terminalError,
            terminalErrorCode: () => terminalErrorCode,
            recoverableRootError: () => recoverableRootError,
            recoverableRootErrorCode: () => recoverableRootErrorCode,
            recoverableItemErrorCode: () => recoverableItemErrorCode,
            assistantText: () => assistantText,
            recoverMissingThread,
          }),
          (error) => this.#finishRun({
            run,
            active,
            error,
            resumingThreadId: attemptThreadId,
            startedThreadId: () => startedThreadId,
            terminalOutcome: () => terminalOutcome,
            terminalError: () => terminalError,
            terminalErrorCode: () => terminalErrorCode,
            recoverableRootError: () => recoverableRootError,
            recoverableRootErrorCode: () => recoverableRootErrorCode,
            recoverableItemErrorCode: () => recoverableItemErrorCode,
            assistantText: () => assistantText,
            recoverMissingThread,
          }),
        );
      };
      const recoverMissingThread = thread.origin.issueId && thread.role === "worker" && !dispatchKey
        ? () => {
            const previousThread = this.database.getAiChatThread(threadId);
            const updatedThread = this.database.updateAiChatThread(threadId, { codexThreadId: null });
            this.#notifyThreadUpdated({ thread: updatedThread, previousThread, dispatchKey });
            resetAttemptState();
            const freshArgs = buildCodexArgs(
              { ...updatedThread, codexThreadId: null },
              resolved.addDirectories,
              imagePaths,
              codexArgsOptions,
            );
            return spawnAttempt(freshArgs, null);
          }
        : null;
      const finalization = spawnAttempt(args, resumingThreadId, recoverMissingThread);
      this.active.set(run.id, active);
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      await cleanupTemporaryResources();
      throw error;
    }
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      const settled = this.database.settleAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
        assistantText: this.#latestAssistantText(run.threadId),
      });
      run = settled.run;
      this.#emit(run.threadId, { type: "ai.run", run });
      this.#notifyRunSettled({
        ...settled,
        run,
        thread: this.getThread(run.threadId),
        assistantText: this.#latestAssistantText(run.threadId),
      });
      return run;
    }

    active.interrupted = true;
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
      signalProcessGroup(active.child, "SIGTERM");
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
      }
      await settled;
    }
    this.listeners.clear();
    this.settledListeners.clear();
    this.threadUpdatedListeners.clear();
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

  #validateRole(role) {
    if (role !== "planner" && role !== "worker") {
      throw new ApiError(400, "INVALID_ROLE", "'role' must be planner or worker");
    }
  }

  #assertThreadWritable(thread) {
    if (thread.archivedAt !== null) {
      throw new ApiError(409, "AI_CHAT_THREAD_ARCHIVED", "Archived AI chat threads are read-only");
    }
  }

  #assertOriginTaskWritable(thread) {
    if (!thread.origin.issueId) return;
    const task = this.database.getTask(thread.origin.issueId);
    if (task?.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot create or start AI turns");
    }
  }

  #validateServiceTier(model, serviceTier) {
    if (serviceTier === null || serviceTier === undefined) return;
    if (
      typeof serviceTier !== "string"
      || serviceTier.length === 0
      || serviceTier.length > 64
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(serviceTier)
    ) {
      throw new ApiError(400, "INVALID_SERVICE_TIER", "'serviceTier' is invalid");
    }
    if (!Array.isArray(model.serviceTiers)
      || !model.serviceTiers.some((tier) => tier.id === serviceTier)) {
      throw new ApiError(
        400,
        "INVALID_SERVICE_TIER",
        `Service tier '${serviceTier}' is not supported by model '${model.slug}'`,
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

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(this.temporaryDirectory, "codex-taskboard-ai-turn-"),
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

  #taskStrategyForThread(thread) {
    const issue = thread.origin.issueId ? this.database.getTask(thread.origin.issueId) : null;
    return issue ? strategyForIssue(issue) : null;
  }

  #synchronizeTaskStrategy(thread, strategy = this.#taskStrategyForThread(thread)) {
    if (!strategy) return thread;
    const changes = {};
    for (const key of TASK_AI_LOCKED_SETTINGS[strategy.role]) {
      if (thread[key] !== strategy[key]) changes[key] = strategy[key];
    }
    return Object.keys(changes).length > 0
      ? this.database.updateAiChatThread(thread.id, changes)
      : thread;
  }

  #assertNoDuplicateTaskRun(thread) {
    if (!thread.origin.issueId) return;
    const duplicate = this.database.findRunningAiChatThread(
      thread.origin.issueId,
      thread.role,
      thread.id,
    );
    if (duplicate) {
      throw new ApiError(
        409,
        "TASK_THREAD_BUSY",
        "This task already has a running thread for the same role",
      );
    }
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
    terminalErrorCode,
    recoverableRootError,
    recoverableRootErrorCode,
    recoverableItemErrorCode,
    assistantText,
    recoverMissingThread,
  }) {
    let status;
    let publicError = null;
    let errorCode = result?.errorCode ?? normalizeCodexErrorCode(error?.code) ?? null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || "Codex turn failed";
      errorCode ||= recoverableItemErrorCode?.() ?? recoverableRootErrorCode?.() ?? null;
    } else if (terminalOutcome() === "failed") {
      status = "failed";
      publicError = terminalError() || "Codex reported a failed turn";
      errorCode ||= terminalErrorCode?.()
        ?? recoverableItemErrorCode?.()
        ?? recoverableRootErrorCode?.()
        ?? null;
    } else if (result.exitCode !== 0) {
      status = "failed";
      publicError = cappedError(result.stderr) || (result.exitCode === null
        ? `Codex exited due to signal ${result.signal ?? "unknown"}`
        : `Codex exited with code ${result.exitCode}`);
      errorCode ||= recoverableItemErrorCode?.() ?? recoverableRootErrorCode?.() ?? null;
    } else if (terminalOutcome() !== "completed") {
      status = "failed";
      publicError = recoverableRootError() || "Codex exited without reporting turn completion";
      errorCode ||= recoverableItemErrorCode?.() ?? recoverableRootErrorCode?.() ?? null;
    } else if (!resumingThreadId && !startedThreadId()) {
      status = "failed";
      publicError = "Codex did not provide a thread id";
    } else {
      status = "completed";
      publicError = recoverableRootError() || null;
    }
    errorCode ||= normalizeCodexErrorCode(publicError);
    if (!resumingThreadId && errorCode === CODEX_THREAD_NOT_FOUND) {
      errorCode = null;
    }
    if (
      status === "failed"
      && !active.interrupted
      && resumingThreadId
      && errorCode === CODEX_THREAD_NOT_FOUND
      && recoverMissingThread
    ) {
      return recoverMissingThread();
    }

    try {
      if (status === "failed" && terminalOutcome() !== "failed" && !recoverableRootError()) {
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
      const settled = this.database.settleAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        errorCode,
        finishedAt: new Date().toISOString(),
        assistantText: assistantText?.() ?? this.#latestAssistantText(run.threadId),
      });
      const updated = settled.run;
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      this.#notifyRunSettled({
        ...settled,
        run: updated,
        thread: this.getThread(run.threadId),
        assistantText: assistantText?.() ?? this.#latestAssistantText(run.threadId),
      });
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

  #latestAssistantText(threadId) {
    return this.database.listAiChatEvents(threadId)
      .filter((event) => event.role === "assistant")
      .at(-1)?.content ?? "";
  }

  #notifyRunSettled(payload) {
    for (const listener of this.settledListeners) {
      try {
        Promise.resolve(listener(payload)).catch(() => {});
      } catch {}
    }
  }

  #notifyThreadUpdated(payload) {
    for (const listener of this.threadUpdatedListeners) {
      try {
        Promise.resolve(listener(payload)).catch(() => {});
      } catch {}
    }
  }
}
