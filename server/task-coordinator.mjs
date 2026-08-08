import { ApiError } from "./database.mjs";
import { TASK_STATUSES } from "../shared/domain.mjs";

const MAIN_TASK_LABEL = "主任务";
const DISPATCH_KEY_LIMIT = 256;
const HANDOFF_PROMPT_SUMMARY_LIMIT = 12_000;
const HANDOFF_PROMPT_COMMENT_LIMIT = 4_000;
const HANDOFF_PROMPT_ERROR_LIMIT = 2_000;
const MANUAL_RETRY_SUMMARY_LIMIT = 8_000;
const WORKER_DELIVERY_INSTRUCTION = "最终回复只需包含：交付结果、用户验收清单与步骤、已完成验证、未验证项和剩余风险。验收步骤逐项写清入口、操作、预期结果和通过标准。";

export const TASK_PLAN_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["children"],
  properties: {
    children: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "childKey",
          "title",
          "description",
          "acceptance",
          "ownership",
          "files",
          "dependsOn",
        ],
        properties: {
          childKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", maxLength: 128 },
          title: { type: "string", minLength: 1, maxLength: 240 },
          description: { type: "string", minLength: 1, maxLength: 100000 },
          acceptance: {
            type: "array",
            maxItems: 50,
            items: { type: "string", minLength: 1, maxLength: 2000 },
          },
          ownership: { type: "string", minLength: 1, maxLength: 256 },
          files: {
            type: "array",
            maxItems: 200,
            items: { type: "string", minLength: 1, maxLength: 1024 },
          },
          dependsOn: {
            type: "array",
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
  },
});

export const TASK_ORCHESTRATION_SCHEMA = TASK_PLAN_OUTPUT_SCHEMA;

function nullableSchema(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

export const TASK_HANDOFF_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "handoffId",
    "sourceTaskVersion",
    "sourceTaskStatus",
    "action",
    "summary",
    "instructions",
    "remediation",
  ],
  properties: {
    handoffId: { type: "string", minLength: 1, maxLength: 128 },
    sourceTaskVersion: { type: "integer", minimum: 1 },
    sourceTaskStatus: {
      type: "string",
      enum: [...TASK_STATUSES],
    },
    action: {
      type: "string",
      enum: [
        "acknowledge",
        "confirm_delivery",
        "request_evidence",
        "resume",
        "revise",
        "create_remediation",
        "stop",
      ],
    },
    summary: { type: "string", minLength: 1, maxLength: 65_536 },
    instructions: nullableSchema({ type: "string", maxLength: 65_536 }),
    remediation: nullableSchema({
      type: "object",
      additionalProperties: false,
      required: [
        "childKey",
        "title",
        "description",
        "acceptance",
        "ownership",
        "files",
        "scopeTransfer",
        "dependsOn",
      ],
      properties: {
        childKey: nullableSchema({
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          maxLength: 128,
        }),
        title: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: "string", minLength: 1, maxLength: 100_000 },
        acceptance: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        ownership: { type: "string", minLength: 1, maxLength: 256 },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        scopeTransfer: nullableSchema({
          type: "object",
          additionalProperties: false,
          required: ["fromChildKey", "ownership", "files"],
          properties: {
            fromChildKey: { type: "string", minLength: 1, maxLength: 128 },
            ownership: nullableSchema({ type: "string", minLength: 1, maxLength: 256 }),
            files: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              items: { type: "string", minLength: 1, maxLength: 1_024 },
            },
          },
        }),
        dependsOn: nullableSchema({
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 128 },
        }),
      },
    }),
  },
});

export const TASK_HANDOFF_SCHEMA = TASK_HANDOFF_OUTPUT_SCHEMA;

function cappedError(value) {
  return String(value instanceof Error ? value.message : value ?? "").slice(0, 65_536);
}

function parseAssistantJson(value, options = {}) {
  const code = options.code ?? "INVALID_TASK_PLAN";
  const label = options.label ?? "Planner";
  const invalid = () => {
    throw new ApiError(400, code, `${label} assistant output is not valid JSON`);
  };
  if (typeof value !== "string") {
    throw new ApiError(400, code, `${label} did not return assistant JSON`);
  }
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {}
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
  const start = starts[0];
  const ends = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((index) => index >= start).sort((a, b) => b - a);
  if (start === undefined || ends.length === 0) {
    invalid();
  }
  try {
    return JSON.parse(text.slice(start, ends[0] + 1));
  } catch {
    invalid();
  }
}

function normalizeHandoffSolution(solution) {
  if (!solution || typeof solution !== "object" || Array.isArray(solution)) return solution;
  if (!solution.remediation || typeof solution.remediation !== "object" || Array.isArray(solution.remediation)) {
    return solution;
  }
  const remediation = { ...solution.remediation };
  for (const key of ["childKey", "dependsOn", "scopeTransfer"]) {
    if (remediation[key] === null) delete remediation[key];
  }
  if (remediation.scopeTransfer && typeof remediation.scopeTransfer === "object") {
    const scopeTransfer = { ...remediation.scopeTransfer };
    if (scopeTransfer.ownership === null) delete scopeTransfer.ownership;
    remediation.scopeTransfer = scopeTransfer;
  }
  return { ...solution, remediation };
}

function plannerDispatchKey(parentId) {
  return `task-orchestration:${parentId}:planner`;
}

function plannerResumeDispatchKey(parentId, commentId) {
  return `${plannerDispatchKey(parentId)}:resume:${commentId}`;
}

function plannerReadinessDispatchKey(parentId, task) {
  return `${plannerDispatchKey(parentId)}:readiness:${task.readinessReview?.round ?? task.version}`;
}

function workerDispatchKey(parentId, childKey) {
  return `task-orchestration:${parentId}:${childKey}:worker`;
}

function readinessWorkerDispatchKey(parentId, childKey, round) {
  return `task-orchestration:${parentId}:${childKey}:readiness:${round}:worker`;
}

function taskEntry(task) {
  return task ? `${task.identifier}: ${task.title}` : "unknown task";
}

function promptText(value, limit) {
  return String(value ?? "").slice(0, limit);
}

function compactHandoffForPrompt(handoff) {
  const latestComment = handoff.latestComment
    ? {
        body: promptText(handoff.latestComment.body, HANDOFF_PROMPT_COMMENT_LIMIT),
        intent: handoff.latestComment.intent,
        action: handoff.latestComment.action,
        authorType: handoff.latestComment.authorType,
        authorName: handoff.latestComment.authorName,
        createdAt: handoff.latestComment.createdAt,
      }
    : null;
  return {
    handoffId: handoff.id,
    sourceKind: handoff.sourceKind,
    childKey: handoff.childKey,
    status: handoff.status,
    taskStatus: handoff.taskStatus,
    sourceTaskVersion: handoff.sourceTaskVersion,
    sourceTaskStatus: handoff.sourceTaskStatus,
    delivery: promptText(handoff.delivery, HANDOFF_PROMPT_SUMMARY_LIMIT) || null,
    blocker: promptText(handoff.blocker, HANDOFF_PROMPT_SUMMARY_LIMIT) || null,
    latestComment,
    error: promptText(handoff.error, HANDOFF_PROMPT_ERROR_LIMIT) || null,
  };
}

export class TaskCoordinator {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.emit = options.emit ?? (() => {});
    this.reportRecoveryError = options.reportRecoveryError ?? ((error, parentId) => {
      console.error(`Task orchestration startup recovery failed for '${parentId}'`, error);
    });
    this.reconcileChains = new Map();
    this.closed = false;
    this.unsubscribeRunSettled = typeof this.aiChat?.subscribeRunSettled === "function"
      ? this.aiChat.subscribeRunSettled((payload) => this.handleRunSettled(payload))
      : null;
  }

  async reconcile({ startup = false, task = null, parentId = null } = {}) {
    if (this.closed) return;
    if (startup) {
      this.database.requeueStaleTaskHandoffs();
      const orchestrations = this.database.listTaskOrchestrations();
      for (const orchestration of orchestrations) {
        try {
          await this.#enqueue(orchestration.parentId, { startup: true });
        } catch (error) {
          this.reportRecoveryError(error, orchestration.parentId);
        }
      }
      return;
    }
    const id = parentId ?? task?.id;
    if (id) await this.#enqueue(id, { trigger: Boolean(task) });
  }

  async handleEvent(type, payload = {}) {
    if (this.closed) return;
    const task = payload.task ?? null;
    const plannerEntry = this.#isPlannerEntry(task, type, payload);
    if (plannerEntry) {
      const ensured = this.#ensureOrchestration(task);
      const retryDispatchKey = type === "comment.created"
        ? plannerResumeDispatchKey(task.id, payload.comment.id)
        : payload.readinessApproved === true
          ? plannerReadinessDispatchKey(task.id, task)
          : null;
      const resumed = (
        !ensured.created
        && ensured.orchestration.status === "failed"
        && retryDispatchKey
      )
        ? this.database.retryTaskOrchestration(
            task.id,
            retryDispatchKey,
          )
        : { created: false };
      await this.#enqueue(task.id, {
        trigger: true,
        newlyEntered: ensured.created || resumed.created,
        readinessApproved: true,
      });
    }

    const candidateIds = new Set();
    for (const candidate of [task, payload.relatedTask]) {
      if (!candidate?.id) continue;
      candidateIds.add(candidate.id);
      const child = this.database.getTaskOrchestrationChildByTask(candidate.id);
      if (child) candidateIds.add(child.parentId);
      if (this.database.getTaskOrchestration(candidate.id)) candidateIds.add(candidate.id);
    }
    for (const candidateId of candidateIds) {
      const orchestration = this.database.getTaskOrchestration(candidateId);
      if (orchestration) await this.#enqueue(candidateId);
      const child = this.database.getTaskOrchestrationChildByTask(candidateId);
      if (child) await this.#enqueue(child.parentId);
    }
  }

  async handleRunSettled(payload = {}) {
    if (this.closed) return;
    const handoff = payload.handoff
      ?? (payload.run?.id ? this.database.getTaskHandoffByRun(payload.run.id) : null);
    if (handoff) {
      const shouldEmitHandoff = payload.handoffCreated === true
        || (payload.handoff && payload.handoffCreated !== false);
      if (shouldEmitHandoff && payload.run?.dispatchKey !== handoff.solDispatchKey) {
        const task = this.database.getTask(handoff.childTaskId);
        if (task) this.#emit("task.updated", { task, changedFields: ["status"] });
        if (handoff.commentId) {
          const comment = this.database.getComment(handoff.commentId);
          if (comment && task) this.#emit("comment.created", { comment, task });
        }
      }
      await this.#enqueue(handoff.parentId, { settled: payload });
      return;
    }
    const dispatchKey = payload.run?.dispatchKey;
    if (dispatchKey) {
      const dispatch = this.database.getTaskDispatch(dispatchKey);
      if (dispatch?.parentId) {
        await this.#enqueue(dispatch.parentId, { settled: payload });
        return;
      }
    }
    const thread = payload.thread
      ?? (payload.run?.threadId ? this.database.getAiChatThread(payload.run.threadId) : null);
    const taskId = thread?.origin?.issueId;
    if (!taskId) return;
    const orchestration = this.database.getTaskOrchestration(taskId);
    if (orchestration?.plannerThreadId === thread.id) {
      await this.#enqueue(taskId, { settled: payload });
    }
    const child = this.database.getTaskOrchestrationChildByTask(taskId);
    if (child) await this.#enqueue(child.parentId, { settled: payload });
  }

  async retryFailedThread(threadId, sourceRunId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${threadId}' does not exist`);
    }
    const taskId = thread.origin.issueId;
    const child = taskId ? this.database.getTaskOrchestrationChildByTask(taskId) : null;
    if (!child || thread.role !== "worker") return null;

    const sourceRun = this.database.getAiChatRun(sourceRunId);
    if (
      !sourceRun
      || sourceRun.threadId !== thread.id
      || !["failed", "interrupted"].includes(sourceRun.status)
    ) {
      throw new ApiError(
        409,
        "TASK_RETRY_SOURCE_INVALID",
        "Only a failed or interrupted run from this worker thread can be resumed",
      );
    }
    const dispatchKey = `task-orchestration:${child.parentId}:manual-retry:${sourceRun.id}`;
    const existingDispatch = this.database.getTaskDispatch(dispatchKey);
    if (existingDispatch?.runId) {
      const existingRun = this.database.getAiChatRun(existingDispatch.runId);
      if (existingRun) return existingRun;
    }
    const task = this.database.getTask(taskId);
    if (
      !task
      || task.archivedAt !== null
      || (
        task.status !== "blocked"
        && !(existingDispatch?.status === "claimed" && task.status === "in_progress")
      )
    ) {
      throw new ApiError(
        409,
        "TASK_RETRY_NOT_AVAILABLE",
        "The orchestration child must still be blocked before it can be resumed",
      );
    }
    const handoff = this.database.getTaskHandoffByRun(sourceRun.id);
    const latestHandoff = this.database.listTaskHandoffs(child.parentId)
      .filter((candidate) => candidate.childTaskId === task.id)
      .at(-1);
    if (
      !handoff
      || latestHandoff?.id !== handoff.id
      || !["failed", "interrupted"].includes(handoff.status)
      || !["resolved", "stopped", "failed"].includes(handoff.queueStatus)
    ) {
      throw new ApiError(
        409,
        "TASK_RETRY_COORDINATION_PENDING",
        "The latest failed handoff is still being coordinated and cannot be resumed manually yet",
      );
    }

    const beforeStatus = task.status;
    const claimed = this.database.claimManualWorkerAttempt({
      parentId: child.parentId,
      taskId: task.id,
      dispatchKey,
    });
    if (claimed.created && claimed.task.status !== beforeStatus) {
      this.#emit("task.moved", { task: claimed.task, fromStatus: beforeStatus });
    }
    if (claimed.dispatch.runId) {
      const existingRun = this.database.getAiChatRun(claimed.dispatch.runId);
      if (existingRun) return existingRun;
    }

    try {
      const run = await this.aiChat.startTurn(
        thread.id,
        { message: this.#manualRetryMessage(task, child.parentId, child, handoff, sourceRun) },
        { dispatchKey, kind: "worker_attempt" },
      );
      this.#emit("task.execution.updated", {
        projectId: task.projectId,
        taskId: task.id,
        parentId: child.parentId,
        aiThreadId: thread.id,
        codexThreadId: thread.codexThreadId ?? null,
      });
      return run;
    } catch (error) {
      const current = this.database.getTaskDispatch(dispatchKey);
      const run = current?.runId ? this.database.getAiChatRun(current.runId) : null;
      if (run) return run;
      this.#markDispatchFailed(dispatchKey, cappedError(error));
      throw error;
    }
  }

  async close() {
    this.closed = true;
    this.unsubscribeRunSettled?.();
    this.unsubscribeRunSettled = null;
    await Promise.allSettled([...this.reconcileChains.values()]);
  }

  #isPlannerEntry(task, type, payload) {
    if (!task || task.archivedAt !== null || !task.labels?.includes(MAIN_TASK_LABEL) || task.relations?.parent) {
      return false;
    }
    if (type === "comment.created") {
      return task.status === "todo"
        && task.readinessReview?.status === "ready"
        && payload.comment?.authorType === "user"
        && payload.comment.intent === "resume";
    }
    if (payload.readinessApproved !== true) return false;
    if (task.status !== "todo") return false;
    if (type === "task.created") return true;
    if (type === "task.moved") return true;
    return Array.isArray(payload.changedFields)
      && payload.changedFields.some((field) => field === "status" || field === "labels");
  }

  #isActiveTask(taskId) {
    const task = taskId ? this.database.getTask(taskId) : null;
    return Boolean(task && task.archivedAt === null);
  }

  #isArchivedError(error) {
    return error?.code === "TASK_ARCHIVED" || error?.code === "AI_CHAT_THREAD_ARCHIVED";
  }

  #ensureOrchestration(task) {
    const existing = this.database.getTaskOrchestration(task.id);
    if (existing) return { orchestration: existing, created: false };
    return {
      orchestration: this.database.beginTaskOrchestration(task.id, plannerDispatchKey(task.id)),
      created: true,
    };
  }

  async #enqueue(parentId, context = {}) {
    if (this.closed) return;
    const previous = this.reconcileChains.get(parentId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.#reconcileParent(parentId, context));
    this.reconcileChains.set(parentId, next);
    try {
      await next;
    } finally {
      if (this.reconcileChains.get(parentId) === next) this.reconcileChains.delete(parentId);
    }
  }

  async #reconcileParent(parentId, context) {
    if (!this.#isActiveTask(parentId)) return;
    let orchestration = this.database.getTaskOrchestration(parentId);
    let created = Boolean(context.newlyEntered);
    if (!orchestration && context.trigger) {
      const task = this.database.getTask(parentId);
      if (this.#isPlannerEntry(task, "task.moved", {
        fromStatus: "backlog",
        readinessApproved: context.readinessApproved === true,
      })) {
        orchestration = this.database.beginTaskOrchestration(parentId, plannerDispatchKey(parentId));
        created = true;
      }
    }
    if (!orchestration) return;
    if (!this.#isActiveTask(orchestration.parentId)) return;

    if (orchestration.status === "planning") {
      const dispatch = this.database.getTaskDispatch(orchestration.plannerDispatchKey);
      const settled = context.settled?.run;
      if (settled && settled.dispatchKey === orchestration.plannerDispatchKey) {
        await this.#finishPlanner(orchestration, context.settled);
        return;
      }
      if (dispatch?.status === "completed") {
        await this.#recoverCompletedPlanner(orchestration);
        return;
      }
      if (dispatch?.status === "failed" || dispatch?.status === "unknown") {
        this.#markOrchestrationFailed(
          parentId,
          dispatch.error ?? "Planner dispatch failed",
        );
        return;
      }
      if (context.startup && dispatch?.status === "claimed") {
        this.#markDispatchFailed(
          orchestration.plannerDispatchKey,
          "服务重启时无法确认 planner 是否已启动，服务器不会盲目重放",
        );
        this.#markOrchestrationFailed(
          parentId,
          "服务重启时无法确认 planner 是否已启动，服务器不会盲目重放",
        );
      } else if (
        created
        || (dispatch?.status === "claimed" && (context.settled || context.trigger))
      ) {
        await this.#startPlanner(orchestration);
      }
      return;
    }

    if (orchestration.status !== "planned") return;
    const handoffOutcome = await this.#reconcileHandoffs(orchestration, context);
    if (handoffOutcome?.waiting) return;
    await this.#scheduleWorkers(orchestration, { startup: context.startup });
  }

  async #reconcileHandoffs(orchestration, context = {}) {
    if (!this.#isActiveTask(orchestration.parentId)) return { waiting: true };
    for (;;) {
      const handoffs = this.database.listTaskHandoffs(
        orchestration.parentId,
        ["pending", "processing", "attempt_pending"],
      );
      const handoff = handoffs[0];
      if (!handoff) return { waiting: false };
      if (!this.#isActiveTask(handoff.childTaskId)) return { waiting: true };

      if (handoff.queueStatus === "attempt_pending") {
        const outcome = await this.#reconcileWorkerAttempt(orchestration, handoff);
        if (outcome?.waiting) return { waiting: true };
        continue;
      }

      if (handoff.queueStatus === "processing") {
        const dispatch = handoff.solDispatchKey
          ? this.database.getTaskDispatch(handoff.solDispatchKey)
          : null;
        if (dispatch?.status === "running") return { waiting: true };
        if (dispatch?.status === "completed") {
          const run = dispatch.runId ? this.database.getAiChatRun(dispatch.runId) : null;
          const persistedAssistantText = dispatch.threadId
            ? this.database.listAiChatEvents(dispatch.threadId)
              .filter((event) => event.role === "assistant" && event.runId === dispatch.runId)
              .at(-1)?.content ?? ""
            : "";
          await this.#finishHandoff(orchestration, handoff, {
            run: run ?? { id: dispatch.runId, status: "completed", dispatchKey: dispatch.dispatchKey },
            assistantText: persistedAssistantText || (
              context.settled?.run?.id === dispatch.runId
                ? context.settled.assistantText ?? ""
                : ""
            ),
          });
          continue;
        }
        if (
          dispatch?.status === "failed"
          && context.settled?.run?.dispatchKey === dispatch.dispatchKey
        ) {
          this.database.retryTaskHandoff(
            handoff.id,
            context.settled.run.error ?? "Planner handoff coordinator failed",
          );
          continue;
        }
        if (context.startup || dispatch?.status === "failed" || dispatch?.status === "unknown" || !dispatch) {
          this.database.requeueStaleTaskHandoffs(orchestration.parentId);
          continue;
        }
        return { waiting: true };
      }

      const thread = await this.#ensurePlannerThread(orchestration);
      if (!this.#isActiveTask(orchestration.parentId) || !this.#isActiveTask(handoff.childTaskId)) {
        return { waiting: true };
      }
      if (!thread) return { waiting: true };
      if (thread.currentRun) return { waiting: true };
      const claim = this.database.claimNextTaskHandoff(orchestration.parentId);
      if (claim.reason === "ARCHIVED") return { waiting: true };
      if (!claim.created) {
        if (["processing", "attempt_pending"].includes(claim.handoff?.queueStatus)) {
          return { waiting: true };
        }
        continue;
      }
      try {
        const run = await this.aiChat.startTurn(
          thread.id,
          { message: this.#handoffMessage(orchestration.parentId, claim.handoff) },
          {
            dispatchKey: claim.dispatch.dispatchKey,
            kind: "handoff",
            outputSchema: TASK_HANDOFF_OUTPUT_SCHEMA,
          },
        );
        if (run.status !== "running") {
          await this.#finishHandoff(orchestration, claim.handoff, {
            run,
            assistantText: this.#latestAssistantText(thread.id, run.id),
          });
          continue;
        }
        return { waiting: true };
      } catch (error) {
        const current = this.database.getTaskDispatch(claim.dispatch.dispatchKey);
        if (current?.runId) return { waiting: true };
        this.database.retryTaskHandoff(claim.handoff.id, cappedError(error));
        continue;
      }
    }
  }

  async #reconcileWorkerAttempt(orchestration, handoff) {
    if (!this.#isActiveTask(orchestration.parentId) || !this.#isActiveTask(handoff.childTaskId)) {
      return { waiting: true };
    }
    const dispatchKey = handoff.workerAttemptDispatchKey;
    const dispatch = dispatchKey ? this.database.getTaskDispatch(dispatchKey) : null;
    if (!dispatch) {
      this.database.requeueTaskHandoffAttempt(
        handoff.id,
        dispatchKey,
        "Worker attempt dispatch was missing during reconciliation",
      );
      return { waiting: false };
    }
    if (dispatch.runId) {
      const run = this.database.getAiChatRun(dispatch.runId);
      if (run?.status === "running") {
        this.database.completeTaskHandoffAttempt(handoff.id, dispatchKey, run.id);
        return { waiting: true };
      }
      if (run && ["completed", "failed", "interrupted"].includes(run.status)) {
        this.database.completeTaskHandoffAttempt(handoff.id, dispatchKey, run.id);
        return { waiting: false };
      }
    }
    if (!dispatch.status || ["completed", "unknown"].includes(dispatch.status)) {
      this.database.requeueTaskHandoffAttempt(
        handoff.id,
        dispatchKey,
        dispatch.error ?? "Worker attempt dispatch is not recoverable",
      );
      return { waiting: false };
    }
    const child = this.database.getTaskOrchestrationChildByTask(handoff.childTaskId);
    const task = this.database.getTask(handoff.childTaskId);
    if (!child || !task || task.archivedAt !== null || !this.#isActiveTask(orchestration.parentId)) {
      if (task?.archivedAt !== null || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      this.database.requeueTaskHandoffAttempt(
        handoff.id,
        dispatchKey,
        "The worker attempt child task no longer exists",
      );
      return { waiting: false };
    }
    const solution = handoff.solution;
    if (!solution) {
      this.database.requeueTaskHandoffAttempt(handoff.id, dispatchKey, "Worker attempt solution was not persisted");
      return { waiting: false };
    }
    try {
      const outcome = await this.#startWorkerAttempt(orchestration, child, dispatch, solution, handoff);
      if (outcome?.established) {
        this.database.completeTaskHandoffAttempt(handoff.id, dispatchKey, outcome.run.id);
        return outcome.run?.status === "running" ? { waiting: true } : { waiting: false };
      }
      if (outcome?.waiting) return { waiting: true };
      this.database.requeueTaskHandoffAttempt(
        handoff.id,
        dispatchKey,
        outcome?.error ?? "Worker attempt could not be started",
      );
      return { waiting: false };
    } catch (error) {
      this.database.requeueTaskHandoffAttempt(handoff.id, dispatchKey, cappedError(error));
      return { waiting: false };
    }
  }

  async #ensurePlannerThread(orchestration) {
    if (!this.#isActiveTask(orchestration.parentId)) return null;
    const current = this.database.getTaskOrchestration(orchestration.parentId);
    const persistedDispatch = current?.plannerDispatchKey
      ? this.database.getTaskDispatch(current.plannerDispatchKey)
      : null;
    const persistedThreadId = current?.plannerThreadId ?? persistedDispatch?.threadId ?? null;
    if (persistedThreadId) {
      const existing = this.database.getAiChatThread(persistedThreadId);
      if (!existing || existing.archivedAt !== null || existing.origin.issueId !== orchestration.parentId) {
        return null;
      }
      return existing;
    }
    const parent = this.database.getTask(orchestration.parentId);
    if (!parent) throw new ApiError(404, "TASK_NOT_FOUND", "The handoff parent task no longer exists");
    if (parent.archivedAt !== null) return null;
    const thread = await this.aiChat.createThread({
      projectId: parent.projectId,
      issueId: parent.id,
      title: `${parent.identifier} planner`,
    });
      this.database.updateTaskOrchestration(orchestration.parentId, { plannerThreadId: thread.id });
    return thread;
  }

  async #finishHandoff(orchestration, handoff, payload) {
    if (!this.#isActiveTask(orchestration.parentId) || !this.#isActiveTask(handoff.childTaskId)) return;
    if (handoff.queueStatus !== "processing") return;
    if (payload.run.status !== "completed") {
      this.database.retryTaskHandoff(
        handoff.id,
        payload.run.error ?? "Planner handoff coordinator failed",
      );
      return;
    }
    try {
      const solution = parseAssistantJson(payload.assistantText, {
        code: "INVALID_HANDOFF_SOLUTION",
        label: "planner handoff coordinator",
      });
      const result = this.database.applyTaskHandoffSolution(
        handoff.id,
        normalizeHandoffSolution(solution),
      );
      if (result.obsolete) return;
      if (result.remediation && result.remediationCreated) {
        this.#emit("task.created", { task: result.remediation });
      }
      if (result.workerDispatch) {
        const child = this.database.getTaskOrchestrationChildByTask(handoff.childTaskId);
        const task = this.database.getTask(handoff.childTaskId);
        if (!child || !task) throw new ApiError(409, "TASK_NOT_FOUND", "The handoff child task no longer exists");
        const outcome = await this.#startWorkerAttempt(
          orchestration,
          child,
          result.workerDispatch,
          solution,
          handoff,
        );
        if (outcome?.established) {
          if (outcome.run?.status === "running") {
            this.database.completeTaskHandoffAttempt(
              handoff.id,
              result.workerDispatch.dispatchKey,
              outcome.run.id,
            );
          }
          this.#emitWorkerStarted(task.id, "in_review");
        } else if (!outcome?.waiting) {
          this.database.requeueTaskHandoffAttempt(
            handoff.id,
            result.workerDispatch.dispatchKey,
            outcome?.error ?? "Worker attempt could not be started",
          );
        }
      }
    } catch (error) {
      this.database.retryTaskHandoff(handoff.id, cappedError(error));
    }
  }

  #handoffMessage(parentId, handoff) {
    const parent = this.database.getTask(parentId);
    return [
      "你是主任务的 planner handoff coordinator。只返回符合服务器 output schema 的 JSON，不要输出 Markdown，不要修改产品代码，不要调用 taskctl 或其他任务板工具。",
      `主任务：${taskEntry(parent)}`,
      `handoff：${JSON.stringify(compactHandoffForPrompt(handoff))}`,
      "必须原样返回 handoffId、sourceTaskVersion、sourceTaskStatus。completed handoff 只能选择 acknowledge/confirm_delivery 或 request_evidence；failed/interrupted handoff 只能选择 acknowledge、resume、revise、create_remediation 或 stop；canceled handoff 只能选择 acknowledge 或 stop。服务器会执行你返回的结构化方案，不要把子任务问题交给用户。",
      "resume/revise/request_evidence 会在同一子任务开发对话创建一次新的 worker attempt，并沿用该对话当前模型；create_remediation 必须给出唯一责任边界、相对文件路径和验收条件。",
    ].join("\n");
  }

  #latestAssistantText(threadId, runId = null) {
    return this.database.listAiChatEvents(threadId)
      .filter((event) => event.role === "assistant" && (runId === null || event.runId === runId))
      .at(-1)?.content ?? "";
  }

  async #startPlanner(orchestration) {
    const parent = this.database.getTask(orchestration.parentId);
    if (!parent || parent.archivedAt !== null) return { waiting: true };
    if (!this.#isPlannerEntry(parent, "task.moved", {
      fromStatus: "backlog",
      readinessApproved: true,
    })) {
      this.database.updateTaskOrchestration(orchestration.parentId, { status: "canceled" });
      return;
    }
    const dispatchKey = orchestration.plannerDispatchKey;
    let thread = null;
    try {
      if (!this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      const persistedDispatch = this.database.getTaskDispatch(dispatchKey);
      const persistedThreadId = orchestration.plannerThreadId ?? persistedDispatch?.threadId ?? null;
      if (persistedThreadId) {
        thread = this.database.getAiChatThread(persistedThreadId);
        if (!thread || thread.archivedAt !== null || thread.origin.issueId !== parent.id) {
          return { waiting: true };
        }
      } else {
        thread = await this.aiChat.createThread({
          projectId: parent.projectId,
          issueId: parent.id,
          title: `${parent.identifier} planner`,
        });
      }
      if (!this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      this.database.updateTaskOrchestration(orchestration.parentId, { plannerThreadId: thread.id });
      this.database.bindTaskDispatch(dispatchKey, { threadId: thread.id });
      const latestThread = this.database.getAiChatThread(thread.id);
      const currentRun = latestThread?.currentRun;
      if (currentRun) {
        if (currentRun.dispatchKey !== dispatchKey) return { waiting: true };
        this.database.bindTaskDispatch(dispatchKey, {
          threadId: thread.id,
          runId: currentRun.id,
          status: "running",
        });
        this.database.updateTaskOrchestration(orchestration.parentId, { plannerRunId: currentRun.id });
        return { established: true, run: currentRun };
      }
      const run = await this.aiChat.startTurn(
        thread.id,
        { message: this.#plannerMessage(parent) },
        {
          dispatchKey,
          kind: "planner",
          outputSchema: TASK_PLAN_OUTPUT_SCHEMA,
        },
      );
      this.database.updateTaskOrchestration(orchestration.parentId, {
        plannerThreadId: thread.id,
        plannerRunId: run.id,
      });
      if (run.status !== "running") await this.#recoverCompletedPlanner(orchestration);
      return { established: true, run };
    } catch (error) {
      if (this.#isArchivedError(error) || !this.#isActiveTask(orchestration.parentId)) {
        return { waiting: true };
      }
      const current = this.database.getTaskDispatch(dispatchKey);
      const run = current?.runId ? this.database.getAiChatRun(current.runId) : null;
      if (run) {
        this.database.updateTaskOrchestration(orchestration.parentId, {
          plannerThreadId: current.threadId,
          plannerRunId: run.id,
        });
        return { established: true, run };
      }
      const currentThread = thread?.id ? this.database.getAiChatThread(thread.id) : null;
      if (currentThread?.currentRun && !currentThread.currentRun.dispatchKey) {
        this.database.updateTaskOrchestration(orchestration.parentId, { plannerThreadId: thread.id });
        return { waiting: true };
      }
      this.#markOrchestrationFailed(orchestration.parentId, cappedError(error));
      return { failed: true };
    }
  }

  async #finishPlanner(orchestration, payload) {
    if (!this.#isActiveTask(orchestration.parentId)) return;
    if (payload.run.status !== "completed") {
      this.#markOrchestrationFailed(
        orchestration.parentId,
        payload.run.error ?? "Planner run failed",
      );
      return;
    }
    try {
      const plan = parseAssistantJson(payload.assistantText);
      const result = this.database.applyTaskPlan(orchestration.parentId, plan);
      for (const taskId of result.createdTaskIds ?? []) {
        const task = this.database.getTask(taskId);
        if (task) this.#emit("task.created", { task });
      }
      const planned = this.database.getTaskOrchestration(orchestration.parentId);
      if (planned) {
        const handoffOutcome = await this.#reconcileHandoffs(planned);
        if (!handoffOutcome?.waiting) await this.#scheduleWorkers(planned);
      }
    } catch (error) {
      this.#markOrchestrationFailed(orchestration.parentId, cappedError(error));
    }
  }

  async #recoverCompletedPlanner(orchestration) {
    if (!this.#isActiveTask(orchestration.parentId)) return;
    const dispatch = this.database.getTaskDispatch(orchestration.plannerDispatchKey);
    const threadId = dispatch?.threadId ?? orchestration.plannerThreadId;
    const text = threadId
      ? this.database.listAiChatEvents(threadId)
        .filter((event) => event.role === "assistant" && (!dispatch?.runId || event.runId === dispatch.runId))
        .at(-1)?.content
      : null;
    await this.#finishPlanner(orchestration, {
      run: {
        status: "completed",
        dispatchKey: orchestration.plannerDispatchKey,
        error: null,
      },
      assistantText: text ?? "",
    });
  }

  async #scheduleWorkers(orchestration, { startup = false } = {}) {
    if (!this.#isActiveTask(orchestration.parentId)) return;
    for (const child of orchestration.children) {
      const task = this.database.getTask(child.taskId);
      if (
        !task
        || task.archivedAt !== null
        || !["backlog", "todo", "in_progress"].includes(task.status)
      ) continue;
      const claim = this.database.claimReadyWorkerDispatch({
        parentId: orchestration.parentId,
        childKey: child.childKey,
        taskId: child.taskId,
        dispatchKey: workerDispatchKey(orchestration.parentId, child.childKey),
      });
      if (!claim.ready) continue;
      if (!claim.created) {
        if (
          claim.dispatch?.status === "failed"
          && task.readinessReview?.status === "ready"
        ) {
          const outcome = await this.#startReadinessWorkerAttempt(
            orchestration,
            child,
            task,
            claim.dispatch,
          );
          if (outcome?.started) this.#emitWorkerStarted(child.taskId, task.status);
          continue;
        }
        const settledHandoff = claim.dispatch?.runId
          ? this.database.getTaskHandoffByRun(claim.dispatch.runId)
          : null;
        if (settledHandoff) continue;
        if (claim.dispatch?.status === "claimed" && !startup) {
          const outcome = await this.#startWorker(orchestration, child, claim.dispatch);
          if (outcome?.established) this.#emitWorkerStarted(child.taskId);
        } else if (claim.dispatch && ["claimed", "failed", "unknown"].includes(claim.dispatch.status)) {
          this.#markDispatchFailed(
            claim.dispatch.dispatchKey,
            startup
              ? "服务重启后无法确认 worker 是否已启动，服务器不会盲目重放"
              : "无法确认 worker 是否已启动，服务器不会盲目重放",
          );
        }
        continue;
      }
      const outcome = await this.#startWorker(orchestration, child, claim.dispatch);
      if (outcome?.established) this.#emitWorkerStarted(child.taskId);
    }
  }

  async #startWorker(orchestration, child, dispatch) {
    const task = this.database.getTask(child.taskId);
    if (!task || task.archivedAt !== null || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
    let thread = null;
    try {
      if (!this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      if (dispatch.threadId) {
        thread = this.database.getAiChatThread(dispatch.threadId);
        if (!thread || thread.archivedAt !== null) return { waiting: true };
        if (thread.origin.issueId !== task.id) {
          throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The worker dispatch thread belongs to a different task");
        }
      } else {
        thread = await this.aiChat.createThread({
          projectId: task.projectId,
          issueId: task.id,
          title: task.identifier,
        });
      }
      if (!this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      this.database.bindTaskDispatch(dispatch.dispatchKey, { threadId: thread.id });
      this.#emit("task.execution.updated", {
        projectId: task.projectId,
        taskId: task.id,
        parentId: orchestration.parentId,
        aiThreadId: thread.id,
        codexThreadId: thread.codexThreadId ?? null,
      });
      const latestThread = this.database.getAiChatThread(thread.id);
      const currentRun = latestThread?.currentRun;
      if (currentRun) {
        if (currentRun.dispatchKey !== dispatch.dispatchKey) return { waiting: true };
        this.database.bindTaskDispatch(dispatch.dispatchKey, {
          threadId: thread.id,
          runId: currentRun.id,
          status: "running",
        });
        return { established: true, run: currentRun };
      }
      const run = await this.aiChat.startTurn(
        thread.id,
        { message: this.#workerMessage(task, orchestration.parentId, child) },
        { dispatchKey: dispatch.dispatchKey, kind: "worker" },
      );
      const bound = this.database.getTaskDispatch(dispatch.dispatchKey);
      if (bound?.runId === run.id) return { established: true, run };
      throw new ApiError(500, "DISPATCH_RUN_NOT_BOUND", "Server worker run was not bound to its dispatch");
    } catch (error) {
      if (this.#isArchivedError(error) || !this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) {
        return { waiting: true };
      }
      const current = this.database.getTaskDispatch(dispatch.dispatchKey);
      const run = current?.runId ? this.database.getAiChatRun(current.runId) : null;
      if (run) return { established: true, run };
      const currentThread = thread?.id ? this.database.getAiChatThread(thread.id) : null;
      if (currentThread?.currentRun && !currentThread.currentRun.dispatchKey) return { waiting: true };
      this.#markDispatchFailed(dispatch.dispatchKey, cappedError(error));
      return { failed: true, error: cappedError(error) };
    }
  }

  async #startReadinessWorkerAttempt(orchestration, child, task, previousDispatch) {
    const round = task.readinessReview?.round;
    if (!round || task.readinessReview?.status !== "ready") return { waiting: true };
    const dispatchKey = readinessWorkerDispatchKey(orchestration.parentId, child.childKey, round);
    let claim;
    try {
      claim = this.database.claimManualWorkerAttempt({
        parentId: orchestration.parentId,
        taskId: task.id,
        dispatchKey,
      });
    } catch (error) {
      if (["DEPENDENCY_NOT_SATISFIED", "WORKER_ATTEMPT_BUSY"].includes(error?.code)) {
        return { waiting: true };
      }
      throw error;
    }
    const dispatch = claim.dispatch;
    if (dispatch.runId) {
      const run = this.database.getAiChatRun(dispatch.runId);
      if (run) return { established: true, run, started: false };
    }

    let thread = null;
    try {
      const persistedThreadId = dispatch.threadId ?? previousDispatch.threadId ?? null;
      thread = persistedThreadId ? this.database.getAiChatThread(persistedThreadId) : null;
      if (persistedThreadId && (!thread || thread.archivedAt !== null)) return { waiting: true };
      if (!persistedThreadId) {
        thread = await this.aiChat.createThread({
          projectId: task.projectId,
          issueId: task.id,
          title: task.identifier,
        });
      }
      if (
        thread.archivedAt !== null
        || !this.#isActiveTask(child.taskId)
        || !this.#isActiveTask(orchestration.parentId)
      ) return { waiting: true };
      if (thread.origin.issueId !== task.id) {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The readiness worker thread belongs to a different task");
      }
      this.database.bindTaskDispatch(dispatch.dispatchKey, { threadId: thread.id });
      this.#emit("task.execution.updated", {
        projectId: task.projectId,
        taskId: task.id,
        parentId: orchestration.parentId,
        aiThreadId: thread.id,
        codexThreadId: thread.codexThreadId ?? null,
      });
      const latestThread = this.database.getAiChatThread(thread.id);
      const currentRun = latestThread?.currentRun;
      if (currentRun) {
        if (currentRun.dispatchKey !== dispatch.dispatchKey) return { waiting: true };
        this.database.bindTaskDispatch(dispatch.dispatchKey, {
          threadId: thread.id,
          runId: currentRun.id,
          status: "running",
        });
        return { established: true, run: currentRun, started: false };
      }
      const run = await this.aiChat.startTurn(
        thread.id,
        { message: this.#readinessWorkerMessage(task, orchestration.parentId, child, round) },
        { dispatchKey: dispatch.dispatchKey, kind: "worker_attempt" },
      );
      const bound = this.database.getTaskDispatch(dispatch.dispatchKey);
      if (bound?.runId === run.id) return { established: true, run, started: true };
      throw new ApiError(500, "DISPATCH_RUN_NOT_BOUND", "Readiness worker attempt was not bound to its dispatch");
    } catch (error) {
      if (
        this.#isArchivedError(error)
        || !this.#isActiveTask(child.taskId)
        || !this.#isActiveTask(orchestration.parentId)
      ) return { waiting: true };
      const current = this.database.getTaskDispatch(dispatch.dispatchKey);
      const run = current?.runId ? this.database.getAiChatRun(current.runId) : null;
      if (run) return { established: true, run, started: false };
      const currentThread = thread?.id ? this.database.getAiChatThread(thread.id) : null;
      if (currentThread?.currentRun && currentThread.currentRun.dispatchKey !== dispatch.dispatchKey) {
        return { waiting: true };
      }
      this.#markDispatchFailed(dispatch.dispatchKey, cappedError(error));
      return { failed: true, error: cappedError(error) };
    }
  }

  async #startWorkerAttempt(orchestration, child, dispatch, solution, handoff) {
    const task = this.database.getTask(child.taskId);
    if (!task || task.archivedAt !== null || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
    let thread = null;
    try {
      if (!this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
      const persistedThreadId = dispatch.threadId ?? handoff.aiThreadId ?? null;
      thread = persistedThreadId ? this.database.getAiChatThread(persistedThreadId) : null;
      if (persistedThreadId && (!thread || thread.archivedAt !== null)) return { waiting: true };
      if (!persistedThreadId) {
        if (!this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) return { waiting: true };
        thread = await this.aiChat.createThread({
          projectId: task.projectId,
          issueId: task.id,
          title: task.identifier,
        });
      }
      if (thread.archivedAt !== null || !this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) {
        return { waiting: true };
      }
      if (thread.origin.issueId !== task.id) {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The worker attempt thread belongs to a different task");
      }
      this.database.bindTaskDispatch(dispatch.dispatchKey, { threadId: thread.id });
      this.#emit("task.execution.updated", {
        projectId: task.projectId,
        taskId: task.id,
        parentId: orchestration.parentId,
        aiThreadId: thread.id,
        codexThreadId: thread.codexThreadId ?? null,
      });
      const latestThread = this.database.getAiChatThread(thread.id);
      const currentRun = latestThread?.currentRun;
      if (currentRun) {
        if (currentRun.dispatchKey !== dispatch.dispatchKey) return { waiting: true };
        this.database.bindTaskDispatch(dispatch.dispatchKey, {
          threadId: thread.id,
          runId: currentRun.id,
          status: "running",
        });
        return { established: true, run: currentRun };
      }
      const run = await this.aiChat.startTurn(
        thread.id,
        {
          message: this.#workerAttemptMessage(task, orchestration.parentId, child, solution, handoff),
        },
        { dispatchKey: dispatch.dispatchKey, kind: "worker_attempt" },
      );
      const bound = this.database.getTaskDispatch(dispatch.dispatchKey);
      if (bound?.runId === run.id) return { established: true, run };
      throw new ApiError(500, "DISPATCH_RUN_NOT_BOUND", "Server worker attempt was not bound to its dispatch");
    } catch (error) {
      if (this.#isArchivedError(error) || !this.#isActiveTask(child.taskId) || !this.#isActiveTask(orchestration.parentId)) {
        return { waiting: true };
      }
      const current = this.database.getTaskDispatch(dispatch.dispatchKey);
      const run = current?.runId ? this.database.getAiChatRun(current.runId) : null;
      if (run) return { established: true, run };
      const currentThread = thread?.id ? this.database.getAiChatThread(thread.id) : null;
      if (currentThread?.currentRun && currentThread.currentRun.dispatchKey !== dispatch.dispatchKey) {
        return { waiting: true };
      }
      return { failed: true, error: cappedError(error) };
    }
  }

  #plannerMessage(parent) {
    const comments = this.database.listComments(parent.id).map((comment) => ({
      body: comment.body,
      author: comment.authorName,
    }));
    return [
      "为下面的主任务生成结构化子任务计划。只返回符合服务器 output schema 的 JSON，不要输出 Markdown，不要修改产品代码，不要调用外部任务板或本地任务板工具。",
      `主任务：${taskEntry(parent)}`,
      `描述：${parent.description || "（无）"}`,
      `评论：${JSON.stringify(comments)}`,
      "要求：childKey 必须稳定；每个文件只能归属一个子任务；dependsOn 只能引用本计划中的 childKey；不要把主任务本身作为子任务。",
    ].join("\n");
  }

  #workerMessage(task, parentId, child) {
    return [
      `开始开发子任务 ${taskEntry(task)}。这是服务器调度的 task-bound worker。`,
      `主任务 ID：${parentId}`,
      `子任务稳定键：${child.childKey}`,
      `描述：${child.description}`,
      `验收标准：${JSON.stringify(child.acceptance)}`,
      `归属：${JSON.stringify(child.ownership)}`,
      `文件范围：${JSON.stringify(child.files)}`,
      WORKER_DELIVERY_INSTRUCTION,
      "完成实现和验证后停止当前 worker；Taskboard 服务端会根据进程终态写入交付 handoff 和 in_review/blocked 状态。不要调用 taskctl 或其他外部任务管理工具。",
    ].join("\n");
  }

  #readinessWorkerMessage(task, parentId, child, round) {
    return [
      `继续处理子任务 ${taskEntry(task)}。父任务派发审核第 ${round} 轮已通过，这是新的服务器托管 worker attempt。`,
      `主任务 ID：${parentId}`,
      `子任务稳定键：${child.childKey}`,
      `描述：${child.description}`,
      `验收标准：${JSON.stringify(child.acceptance)}`,
      `归属：${JSON.stringify(child.ownership)}`,
      `文件范围：${JSON.stringify(child.files)}`,
      "从同一开发对话最后可确认的完成点继续，不重做已经完成的步骤；先回读当前文件和外部状态，外部写入结果不确定时不得盲目重放。",
      WORKER_DELIVERY_INSTRUCTION,
      "完成实现和验证后停止当前 worker；Taskboard 服务端会根据本次新 run 的终态生成新的 handoff。不要调用 taskctl 或其他外部任务管理工具。",
    ].join("\n");
  }

  #workerAttemptMessage(task, parentId, child, solution, handoff) {
    return [
      `继续处理子任务 ${taskEntry(task)}。这是服务器调度的同一开发对话 worker attempt，沿用该对话当前模型。`,
      `主任务 ID：${parentId}`,
      `子任务稳定键：${child.childKey}`,
      `原 handoff：${JSON.stringify(compactHandoffForPrompt(handoff))}`,
      `planner 方案：${JSON.stringify(solution)}`,
      `任务描述：${child.description}`,
      `验收标准：${JSON.stringify(child.acceptance)}`,
      `责任归属：${JSON.stringify(child.ownership)}`,
      `文件范围：${JSON.stringify(child.files)}`,
      WORKER_DELIVERY_INSTRUCTION,
      "只处理本子任务责任边界内的实现和验证；完成后停止，让服务器生成新的 handoff。不要调用 taskctl 或其他外部任务管理工具。",
    ].join("\n");
  }

  #manualRetryMessage(task, parentId, child, handoff, sourceRun) {
    return [
      `继续处理子任务 ${taskEntry(task)}。用户已在 Taskboard 对话中明确选择恢复，这是新的服务器托管 worker attempt，并沿用该对话当前模型。`,
      `主任务 ID：${parentId}`,
      `子任务稳定键：${child.childKey}`,
      `上一轮终态：${sourceRun.status}`,
      `上一轮阻塞摘要：${promptText(handoff.blocker || handoff.summary || sourceRun.error || "（无）", MANUAL_RETRY_SUMMARY_LIMIT)}`,
      `任务描述：${child.description}`,
      `验收标准：${JSON.stringify(child.acceptance)}`,
      `责任归属：${JSON.stringify(child.ownership)}`,
      `文件范围：${JSON.stringify(child.files)}`,
      "从同一 Codex 对话最后可确认的完成点继续，不重做已经完成的步骤；先回读当前文件和外部状态，外部写入结果不确定时不得盲目重放。",
      "完成实现和验证后停止当前 worker；Taskboard 服务端会根据本次新 run 的终态生成新的 handoff。不要调用 taskctl 或其他外部任务管理工具。",
    ].join("\n");
  }

  #markDispatchFailed(dispatchKey, message) {
    const before = this.database.getTaskDispatch(dispatchKey);
    const after = this.database.markTaskDispatchFailed(dispatchKey, message);
    if (
      after?.status === "failed"
      && (before?.status !== "failed" || !before.failureCommentId)
    ) {
      this.#emitFailureEvents(after);
    }
    return after;
  }

  #markOrchestrationFailed(parentId, message) {
    const orchestration = this.database.getTaskOrchestration(parentId);
    const before = orchestration
      ? this.database.getTaskDispatch(orchestration.plannerDispatchKey)
      : null;
    const after = this.database.markTaskOrchestrationFailed(parentId, message);
    const dispatch = orchestration
      ? this.database.getTaskDispatch(orchestration.plannerDispatchKey)
      : null;
    if (
      dispatch?.failureCommentId
      && !before?.failureCommentId
    ) {
      this.#emitFailureEvents(dispatch);
    }
    return after;
  }

  #emitWorkerStarted(taskId, fromStatus = "backlog") {
    const task = this.database.getTask(taskId);
    if (task) this.#emit("task.moved", { task, fromStatus });
  }

  #emitFailureEvents(dispatch) {
    const task = dispatch.taskId ? this.database.getTask(dispatch.taskId) : null;
    if (!task) return;
    this.#emit("task.updated", { task, changedFields: ["status"] });
    if (dispatch.failureCommentId) {
      const comment = this.database.getComment(dispatch.failureCommentId);
      if (comment) this.#emit("comment.created", { comment, task });
    }
  }

  #emit(type, payload) {
    try {
      this.emit(type, payload);
    } catch {}
  }
}

export { parseAssistantJson, plannerDispatchKey, workerDispatchKey };
