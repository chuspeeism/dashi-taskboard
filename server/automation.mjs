import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";
import { buildTaskboardAutomationPrompt } from "../shared/taskboard-automation.mjs";
import {
  assignThreadToCodexProject,
  resumeCodexDesktopTask,
  runCodexDesktopTask,
} from "./codex-app-task.mjs";

const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

export class AutomationScheduler {
  constructor({
    database,
    processEnv,
    runTask = runCodexDesktopTask,
    resumeTask = resumeCodexDesktopTask,
    assignThread = assignThreadToCodexProject,
    readQuota = readCodexQuotaStatus,
  }) {
    this.database = database;
    this.processEnv = processEnv ?? process.env;
    this.runTask = runTask;
    this.resumeTask = resumeTask;
    this.assignThread = assignThread;
    this.readQuota = readQuota;
    this.codexDebugPort = this.processEnv.CODEX_TASKBOARD_CODEX_DEBUG_PORT ?? "9229";
    this.timers = new Map();
    this.inFlight = new Map();
    this.controllers = new Map();
    this.quotaStatuses = new Map();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const record of this.database.listProjectAutomations()) {
      this.#schedule(record);
      this.#resumeInProgress(record);
    }
  }

  async stop() {
    this.started = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Taskboard automation stopped"));
    }
    const inFlight = [...this.inFlight.values()];
    if (inFlight.length > 0) {
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref();
        }),
      ]);
    }
    this.inFlight.clear();
    this.controllers.clear();
  }

  list() {
    return this.database.listProjectAutomations().map((record) => this.#withQuota(record));
  }

  get(taskboardProjectId) {
    return this.#withQuota(this.database.getProjectAutomation(taskboardProjectId));
  }

  setProjectAutomation(input) {
    const record = this.database.upsertProjectAutomation(input);
    this.quotaStatuses.delete(input.taskboardProjectId);
    this.#schedule(record);
    return this.#withQuota(record);
  }

  deleteProjectAutomation(taskboardProjectId) {
    const timer = this.timers.get(taskboardProjectId);
    if (timer) clearInterval(timer);
    this.timers.delete(taskboardProjectId);
    this.quotaStatuses.delete(taskboardProjectId);
    return this.database.deleteProjectAutomation(taskboardProjectId);
  }

  async runOnce(taskboardProjectId) {
    const record = this.database.getProjectAutomation(taskboardProjectId);
    if (!record) return null;
    return this.#tick(record);
  }

  #schedule(record) {
    const key = record.taskboardProjectId;
    const previous = this.timers.get(key);
    if (previous) clearInterval(previous);
    this.timers.delete(key);
    if (!record.enabledByUser) return;
    const timer = setInterval(
      () => void this.#tick(record),
      record.intervalSeconds * 1_000,
    );
    timer.unref();
    this.timers.set(key, timer);
  }

  async #tick(record) {
    const key = record.taskboardProjectId;
    if (this.inFlight.has(key)) return;
    try {
      if (record.quotaAware) {
        const quota = await this.readQuota(record.model);
        this.quotaStatuses.set(key, quota);
        if (quota?.state !== "available") return;
      }
      const candidate = this.database.listTasks({
        projectId: key,
        status: "todo",
        archived: "false",
      })[0];
      if (!candidate) return;
      const claimed = this.database.moveTask(
        candidate.id,
        candidate.version,
        "in_progress",
        undefined,
        candidate.threadId,
      );
      const dispatch = this.#dispatch(record, claimed).finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, dispatch);
      await dispatch;
    } catch (error) {
      console.error(`Taskboard automation tick failed for ${key}: ${error.message}`);
    }
  }

  async #dispatch(record, candidate) {
    const request = {
      taskboardProjectId: record.taskboardProjectId,
      codexProjectId: record.codexProjectId,
      projectName: record.projectName,
      workspacePath: record.workspacePath,
      skillPath: record.skillPath,
      taskId: candidate.id,
      taskIdentifier: candidate.identifier,
      intervalSeconds: record.intervalSeconds,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
    };
    const prompt = buildTaskboardAutomationPrompt(request);
    const controller = new AbortController();
    this.controllers.set(record.taskboardProjectId, controller);
    try {
      const result = await this.runTask({
        debugPort: this.codexDebugPort,
        workspacePath: record.workspacePath,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        title: `${candidate.identifier} · ${candidate.title}`,
        prompt,
        signal: controller.signal,
        onThreadStarted: async (threadId) => {
          const current = this.database.getTask(candidate.id);
          if (current?.status !== "in_progress") {
            throw new Error(`Task ${candidate.identifier} is no longer in progress`);
          }
          this.database.updateTask(current.id, current.version, {}, threadId);
          await this.assignThread({
            debugPort: this.codexDebugPort,
            threadId,
            projectId: record.codexProjectId,
            cwd: record.workspacePath,
          });
        },
      });
      if (result.status !== "completed") {
        console.error(
          `Taskboard automation dispatch failed for ${record.taskboardProjectId} `
          + `(${result.status ?? "unknown"})${result.error ? `: ${JSON.stringify(result.error)}` : ""}`,
        );
        this.#settleFailure(candidate, result.status ?? "unknown", result.error);
        return;
      }
      this.#settleCompleted(candidate);
    } catch (error) {
      if (controller.signal.aborted && !this.started) return;
      this.#settleFailure(candidate, "desktop_unavailable", error);
      throw error;
    } finally {
      this.controllers.delete(record.taskboardProjectId);
    }
  }

  #resumeInProgress(record) {
    const candidate = this.database.listTasks({
      projectId: record.taskboardProjectId,
      status: "in_progress",
      archived: "false",
    })[0];
    if (!candidate || this.inFlight.has(record.taskboardProjectId)) return;
    if (!candidate.threadId) {
      this.#settleFailure(candidate, "missing_thread", new Error("The original Codex thread is missing"));
      return;
    }

    const key = record.taskboardProjectId;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const recovery = this.#monitorExisting(record, candidate, controller).finally(() => {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, recovery);
  }

  async #monitorExisting(record, candidate, controller) {
    try {
      const result = await this.resumeTask({
        debugPort: this.codexDebugPort,
        threadId: candidate.threadId,
        signal: controller.signal,
      });
      if (result.status === "completed") {
        this.#settleCompleted(candidate);
      } else {
        this.#settleFailure(candidate, result.status ?? "unknown", result.error);
      }
    } catch (error) {
      if (!(controller.signal.aborted && !this.started)) {
        this.#settleFailure(candidate, "desktop_unavailable", error);
        console.error(
          `Taskboard automation recovery failed for ${record.taskboardProjectId}: ${error.message}`,
        );
      }
    }
  }

  #settleCompleted(candidate) {
    const current = this.database.getTask(candidate.id);
    if (current?.status === "in_progress") {
      this.database.moveTask(current.id, current.version, "in_review", undefined, current.threadId);
    }
  }

  #settleFailure(candidate, status, error) {
    const current = this.database.getTask(candidate.id);
    if (current?.status !== "in_progress") return;
    const reason = this.#failureReason(error);
    this.database.createComment(current.id, {
      body: [
        "自动化执行未完成。",
        `- 状态：${status}`,
        `- 原因：${reason}`,
        "- 重新执行：确认 Codex Desktop 可用后，将任务移回“待办事项”。",
      ].join("\n"),
      threadId: current.threadId,
      actor: CODEX_AGENT_ACTOR,
    });
    const latest = this.database.getTask(current.id);
    if (latest?.status === "in_progress") {
      this.database.moveTask(latest.id, latest.version, "blocked", undefined, latest.threadId);
    }
  }

  #failureReason(error) {
    const value = error instanceof Error
      ? error.message
      : error && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : "Codex Desktop did not return a successful result";
    return value.replaceAll("\0", "").slice(0, 500);
  }

  #withQuota(record) {
    if (!record) return null;
    const quota = this.quotaStatuses.get(record.taskboardProjectId);
    return quota ? { ...record, quota } : record;
  }
}
