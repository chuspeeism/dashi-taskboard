import { signalProcessTree } from "../shared/process-tree.mjs";
import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { ApiError } from "./database.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const STATUS_LABELS = {
  backlog: "積壓事項",
  todo: "待辦",
  in_progress: "處理中",
  in_review: "等你確認",
  blocked: "遇到阻礙",
  done: "完成",
  canceled: "取消",
};

function isDue(summary) {
  if (!summary.attemptedAt) return true;
  return Date.now() - new Date(summary.attemptedAt).getTime() >= DAY_MS;
}

function buildPrompt(project, tasks) {
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [
    STATUS_LABELS[status],
    tasks.filter((task) => task.status === status).length,
  ]));
  const recentCutoff = Date.now() - 7 * DAY_MS;
  const issues = tasks.filter((task) => (
    (task.status !== "done" && task.status !== "canceled")
    || new Date(task.activityUpdatedAt).getTime() >= recentCutoff
  )).map((task) => ({
    id: task.identifier,
    title: task.title,
    status: STATUS_LABELS[task.status],
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
    updatedAt: task.activityUpdatedAt,
  }));
  return [
    "你是 Codex。請根據下面的任務面板快照，為專案負責人寫一段專案總結。",
    "要求：只輸出一段 60 至 120 字的繁體中文；直接說明目前進展、主要風險或阻礙、下一步重點；不要使用標題、清單或 Markdown；不要呼叫工具。",
    JSON.stringify({
      project: project.name,
      generatedForDate: new Date().toISOString().slice(0, 10),
      counts,
      issues,
    }),
  ].join("\n\n");
}

export class ProjectSummaryService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.workspacePath = options.workspacePath;
    this.processEnv = options.processEnv ?? process.env;
    this.active = new Map();
    this.closed = false;
    this.timer = setInterval(() => void this.refreshDueProjects(), CHECK_INTERVAL_MS);
    this.timer.unref();
    void this.refreshDueProjects();
  }

  get(projectId) {
    if (!this.database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' was not found`);
    }
    const summary = this.database.getProjectSummary(projectId);
    if (isDue(summary)) void this.refresh(projectId);
    return {
      projectId,
      summary: summary.summary,
      updatedAt: summary.generatedAt,
      refreshing: this.active.has(projectId),
      error: summary.error,
    };
  }

  refresh(projectId) {
    const current = this.active.get(projectId);
    if (current) return current.promise;
    const active = { child: null, promise: null };
    active.promise = this.#generate(projectId, active)
      .finally(() => this.active.delete(projectId));
    this.active.set(projectId, active);
    return active.promise;
  }

  async refreshDueProjects() {
    for (const summary of this.database.listProjectSummaries()) {
      if (isDue(summary)) await this.refresh(summary.projectId);
    }
  }

  async #generate(projectId, active) {
    try {
      const project = this.database.getProject(projectId);
      if (!project) return;
      const tasks = this.database.listTasks({ projectId, archived: "false" });
      let generatedSummary = "";
      let terminalError = "";
      const { child, completion } = spawnCodexTurn({
        executable: this.codexExecutable,
        args: [
          "exec",
          "--ephemeral",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "-C",
          this.workspacePath,
          "-s",
          "read-only",
          "-c",
          'approval_policy="never"',
          "-",
        ],
        prompt: buildPrompt(project, tasks),
        env: this.processEnv,
        onRawEvent: (event) => {
          if (
            event.type === "item.completed"
            && event.item?.type === "agent_message"
            && typeof event.item.text === "string"
          ) {
            generatedSummary = event.item.text.replace(/\s+/g, " ").trim();
          }
          if (event.type === "turn.failed" || event.type === "error") {
            terminalError = String(event.error?.message ?? event.message ?? "Codex 生成失敗");
          }
        },
      });
      active.child = child;
      const result = await completion;
      if (result.exitCode !== 0 || terminalError) {
        throw new Error(terminalError || `Codex 退出碼 ${result.exitCode}`);
      }
      if (!generatedSummary) throw new Error("Codex 沒有返回專案總結");
      this.database.saveProjectSummary(projectId, generatedSummary);
    } catch (error) {
      if (!this.closed) {
        this.database.saveProjectSummaryError(
          projectId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const active = [...this.active.values()];
    for (const entry of active) signalProcessTree(entry.child, "SIGTERM");
    await Promise.allSettled(active.map((entry) => entry.promise));
  }
}
