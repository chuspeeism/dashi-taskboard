import { CODEX_JSONL_LINE_TOO_LARGE } from "./ai-chat-process.mjs";

const RETRYABLE_ERROR_CODES = new Set([CODEX_JSONL_LINE_TOO_LARGE]);
const ACTIVE_TASK_STATUSES = new Set(["in_progress"]);

const RECOVERY_MESSAGE = [
  "上次执行因 Codex 输出单行超过 1 MiB 而中断。继续当前任务，并先回读已有状态。",
  "不要读取或输出整份 JSONL、大型日志或大文件；使用 rg、head、字段筛选和行数限制，把每次输出控制在小范围内。",
  "不要重复已经完成的步骤；任何外部写入结果不确定时先回读，禁止盲目重放。",
  "从最后一个可确认的完成点继续，完成实现和验证后正常收尾。",
].join("\n");

function isoAfter(nowMs, delayMs) {
  return new Date(nowMs + delayMs).toISOString();
}

export class AiRetryCoordinator {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.now = options.now ?? (() => Date.now());
    this.firstDelayMs = options.firstDelayMs ?? 30_000;
    this.laterDelayMs = options.laterDelayMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.timer = null;
    this.closed = false;
    this.reconcileChain = Promise.resolve();
    this.unsubscribeRunSettled = this.aiChat.subscribeRunSettled(
      (payload) => this.handleRunSettled(payload),
    );
  }

  async start() {
    this.database.recoverAiChatRetryJobs();
    await this.reconcile();
  }

  async handleRunSettled(payload = {}) {
    if (this.closed || !payload.run) return;
    const { run } = payload;
    if (run.retryJobId) {
      const current = this.database.getAiChatRetryJob(run.retryJobId);
      const nextAttemptAt = isoAfter(this.now(), this.#delayAfterAttempt(current?.attemptCount ?? 1));
      const job = this.database.settleAiChatRetryJobForRun(run.id, {
        status: run.status,
        error: run.error,
        nextAttemptAt,
      });
      if (job) this.aiChat.notifyThreadChanged(job.threadId);
      await this.reconcile();
      return;
    }

    if (run.status === "completed") {
      if (this.database.resolveAiChatRetryJobsForThread(run.threadId) > 0) {
        this.aiChat.notifyThreadChanged(run.threadId);
      }
      return;
    }

    if (!this.#isRetryable(payload)) return;
    const { job } = this.database.enqueueAiChatRetryJob({
      threadId: run.threadId,
      sourceRunId: run.id,
      errorCode: run.errorCode,
      error: run.error,
      maxAttempts: this.maxAttempts,
      nextAttemptAt: isoAfter(this.now(), this.firstDelayMs),
    });
    this.aiChat.notifyThreadChanged(job.threadId);
    await this.reconcile();
  }

  async reconcile() {
    this.reconcileChain = this.reconcileChain.then(() => this.#reconcileNow());
    return this.reconcileChain;
  }

  async close() {
    this.closed = true;
    this.unsubscribeRunSettled?.();
    this.unsubscribeRunSettled = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.reconcileChain;
  }

  #isRetryable(payload) {
    const { run } = payload;
    if (
      run.status !== "failed"
      || run.dispatchKey
      || run.retryJobId
      || !RETRYABLE_ERROR_CODES.has(run.errorCode)
      || this.database.aiChatRunHasAttachments(run.id)
    ) return false;
    const thread = payload.thread ?? this.database.getAiChatThread(run.threadId);
    if (!thread || thread.archivedAt !== null || thread.sandbox === "danger-full-access") return false;
    if (!thread.origin.issueId) return false;
    const task = this.database.getTask(thread.origin.issueId);
    return Boolean(task && task.archivedAt === null && ACTIVE_TASK_STATUSES.has(task.status));
  }

  async #reconcileNow() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    let job;
    while (!this.closed && (job = this.database.claimDueAiChatRetryJob(new Date(this.now()).toISOString()))) {
      const thread = this.database.getAiChatThread(job.threadId);
      const task = thread?.origin.issueId ? this.database.getTask(thread.origin.issueId) : null;
      if (
        !thread
        || thread.archivedAt !== null
        || thread.sandbox === "danger-full-access"
        || !task
        || task.archivedAt !== null
        || !ACTIVE_TASK_STATUSES.has(task.status)
      ) {
        this.database.cancelAiChatRetryJob(job.id, "Task is no longer eligible for automatic retry");
        this.aiChat.notifyThreadChanged(job.threadId);
        continue;
      }
      if (thread.currentRun) {
        this.database.failClaimedAiChatRetryJob(job.id, {
          error: "The conversation already has a running turn",
          nextAttemptAt: isoAfter(this.now(), this.laterDelayMs),
        });
        this.aiChat.notifyThreadChanged(job.threadId);
        continue;
      }
      try {
        await this.aiChat.startTurn(
          job.threadId,
          { message: RECOVERY_MESSAGE },
          { retryJobId: job.id, kind: "automatic_retry" },
        );
        this.aiChat.notifyThreadChanged(job.threadId);
      } catch (error) {
        const next = this.database.failClaimedAiChatRetryJob(job.id, {
          error,
          nextAttemptAt: isoAfter(this.now(), this.#delayAfterAttempt(job.attemptCount + 1)),
        });
        this.aiChat.notifyThreadChanged(job.threadId);
        if (next?.state === "pending") continue;
      }
    }
    this.#scheduleNext();
  }

  #delayAfterAttempt(attemptCount) {
    return attemptCount <= 0 ? this.firstDelayMs : this.laterDelayMs;
  }

  #scheduleNext() {
    if (this.closed) return;
    const nextAttemptAt = this.database.nextAiChatRetryAt();
    if (!nextAttemptAt) return;
    const delay = Math.max(0, Date.parse(nextAttemptAt) - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile();
    }, Math.min(delay, 2_147_483_647));
    this.timer.unref?.();
  }
}

export { RECOVERY_MESSAGE };
