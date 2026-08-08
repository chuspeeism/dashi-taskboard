export const TASK_READINESS_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "confirmed", "assumptions", "questions"],
  properties: {
    decision: { type: "string", enum: ["ready", "needs_confirmation"] },
    summary: { type: "string", minLength: 1, maxLength: 65_536 },
    confirmed: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    assumptions: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    questions: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "why", "blocking"],
        properties: {
          id: { type: "string", pattern: "^Q[1-9][0-9]*$", maxLength: 16 },
          question: { type: "string", minLength: 1, maxLength: 2_000 },
          why: { type: "string", minLength: 1, maxLength: 2_000 },
          blocking: { type: "boolean" },
        },
      },
    },
  },
});

const REVIEW_MODEL = "gpt-5.6-sol";
const REVIEW_EFFORT = "xhigh";
const PARENT_DISPATCH_EFFORT = "max";
const REVIEW_HISTORY_LIMIT = 20;
const REVIEW_COMMENT_BODY_LIMIT = 2_000;
const REVIEW_REWORK_BODY_LIMIT = 8_000;
const REVIEW_DESCRIPTION_LIMIT = 12_000;
const REVIEW_ACTOR = Object.freeze({
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
});

function isAssignedToCodex(task) {
  return task?.assignee?.type === "agent" && task.assignee.id === REVIEW_ACTOR.id;
}

function cappedError(value) {
  return String(value instanceof Error ? value.message : value ?? "").slice(0, 65_536);
}

function reviewDescription(value) {
  return String(value || "（无）").slice(0, REVIEW_DESCRIPTION_LIMIT);
}

function reviewCommentSnapshot(comment, bodyLimit = REVIEW_COMMENT_BODY_LIMIT) {
  return {
    body: String(comment.body ?? "").slice(0, bodyLimit),
    ...(comment.reworkRound ? { reworkRound: comment.reworkRound } : {}),
  };
}

function parseDecision(value) {
  if (typeof value !== "string") throw new Error("需求审核没有返回结构化 JSON");
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("需求审核返回的 JSON 无法解析");
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("需求审核返回了无效结果");
  }
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  if (parsed.decision === "needs_confirmation" && !questions.some((question) => question?.blocking === true)) {
    throw new Error("需要确认的审核结果必须至少包含一个关键问题");
  }
  if (parsed.decision === "ready" && questions.some((question) => question?.blocking === true)) {
    throw new Error("仍有关键问题时不能通过需求审核");
  }
  return parsed;
}

function reviewComment(decision, round, profile) {
  const heading = profile.parent ? "父任务 planner 派发审核" : "需求审核";
  const readyStatus = profile.parent
    ? "已通过，父任务允许启动开发 worker"
    : "已通过，允许开始开发";
  const confirmed = decision.confirmed.length > 0
    ? decision.confirmed.map((item) => `- ${item}`).join("\n")
    : "- 暂无额外确认项";
  const assumptions = decision.assumptions.length > 0
    ? decision.assumptions.map((item) => `- ${item}`).join("\n")
    : "- 无";
  if (decision.decision === "ready") {
    return [
      `## ${heading} · 第 ${round} 轮`,
      "",
      `**状态：${readyStatus}**`,
      "",
      decision.summary,
      "",
      "### 已确认",
      confirmed,
      "",
      "### 开发时采用的假设",
      assumptions,
      "",
      `审核模型：${REVIEW_MODEL} · ${profile.effort} · 只读`,
    ].join("\n");
  }
  const questions = decision.questions.map((item) => (
    `- **${item.id}** ${item.question}\n  - 原因：${item.why}${item.blocking ? "\n  - 影响：未确认前不进入开发" : ""}`
  )).join("\n");
  return [
    `## ${heading} · 第 ${round} 轮`,
    "",
    "**状态：等待确认，任务已转到待解决**",
    "",
    decision.summary,
    "",
    "### 已确认",
    confirmed,
    "",
    "### 未确认问题",
    questions,
    "",
    "你可以直接在本任务评论区按问题编号回复，也可以打开任务详情里的“需求审核对话”继续沟通。补充后系统会自动复审，通过后自动开始开发。",
    "",
    `审核模型：${REVIEW_MODEL} · ${profile.effort} · 只读`,
  ].join("\n");
}

export class TaskReadinessCoordinator {
  constructor(options) {
    this.database = options.database;
    this.aiChat = options.aiChat;
    this.emit = options.emit ?? (() => {});
    this.onReady = options.onReady ?? (async () => {});
    this.chains = new Map();
    this.closed = false;
    this.unsubscribeRunSettled = this.aiChat.subscribeRunSettled((payload) => (
      this.#handleRunSettled(payload)
    ));
  }

  async reconcile({ startup = false } = {}) {
    if (!startup || this.closed) return;
    for (const review of this.database.listTaskReadinessReviews(["running"])) {
      await this.#enqueue(review.taskId, async () => {
        const current = this.database.getTaskReadinessReview(review.taskId);
        if (!current || current.status !== "running") return;
        const run = current.runId ? this.database.getAiChatRun(current.runId) : null;
        if (run?.status === "completed") {
          await this.#finishReview(current, {
            run,
            assistantText: this.#latestAssistantText(current.aiThreadId, run.id),
          });
          return;
        }
        await this.#failReview(current, run?.error ?? "服务重启后无法确认需求审核是否完成");
      });
    }
  }

  async handleEvent(type, payload = {}) {
    if (this.closed) return;
    const task = payload.task ?? null;
    if (
      ["task.created", "task.moved", "task.updated"].includes(type)
      && task?.status === "todo"
      && isAssignedToCodex(task)
      && payload.readinessApproved !== true
      && (
        type !== "task.moved"
        || payload.fromStatus !== "todo"
      )
      && (
        type !== "task.updated"
        || !Array.isArray(payload.changedFields)
        || payload.changedFields.includes("status")
      )
    ) {
      await this.#enqueue(task.id, () => this.#startReview(task.id));
      return;
    }
    if (
      type === "task.updated"
      && task?.status === "todo"
      && isAssignedToCodex(task)
      && Array.isArray(payload.changedFields)
      && payload.changedFields.some((field) => ["title", "description", "labels"].includes(field))
    ) {
      await this.#enqueue(task.id, () => this.#startReview(task.id));
      return;
    }
    if (
      type === "comment.created"
      && payload.comment?.authorType === "user"
      && payload.comment?.intent === "resume"
      && task
      && isAssignedToCodex(task)
    ) {
      const review = this.database.getTaskReadinessReview(task.id);
      if (review && ["awaiting_input", "failed"].includes(review.status)) {
        await this.#enqueue(task.id, () => this.#startReview(task.id));
      }
    }
  }

  async close() {
    this.closed = true;
    this.unsubscribeRunSettled?.();
    this.unsubscribeRunSettled = null;
    await Promise.allSettled([...this.chains.values()]);
  }

  isApproved(taskId) {
    return this.database.getTaskReadinessReview(taskId)?.status === "ready";
  }

  async #enqueue(taskId, operation) {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.chains.set(taskId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(taskId) === next) this.chains.delete(taskId);
    }
  }

  async #startReview(taskId) {
    const task = this.database.getTask(taskId);
    if (
      !task
      || task.archivedAt !== null
      || !["todo", "blocked"].includes(task.status)
      || !isAssignedToCodex(task)
    ) return;
    const profile = this.#reviewProfile(task);
    const current = this.database.getTaskReadinessReview(task.id);
    if (current?.status === "running") return;
    let thread = current?.aiThreadId ? this.aiChat.getThread(current.aiThreadId) : null;
    if (
      thread
      && thread.sandbox !== "read-only"
    ) thread = null;
    if (!thread || thread.archivedAt !== null) {
      thread = await this.aiChat.createThread({
        projectId: task.projectId,
        title: profile.parent
          ? `${profile.parent.identifier} → ${task.identifier} planner 派发审核`
          : `${task.identifier} 需求审核`,
        role: "planner",
        model: REVIEW_MODEL,
        reasoningEffort: profile.effort,
        serviceTier: null,
        sandbox: "read-only",
      });
    } else if (thread.currentRun) {
      return;
    }
    const review = this.database.beginTaskReadinessReview(task.id, { aiThreadId: thread.id });
    try {
      const run = await this.aiChat.startTurn(
        thread.id,
        { message: this.#reviewMessage(task.id, review.round) },
        { kind: "readiness_review", outputSchema: TASK_READINESS_REVIEW_OUTPUT_SCHEMA },
      );
      this.database.bindTaskReadinessRun(task.id, review.round, run.id);
      this.emit("task.updated", {
        task: this.database.getTask(task.id),
        changedFields: ["readinessReview"],
      });
      if (run.status !== "running") {
        await this.#finishReview(this.database.getTaskReadinessReview(task.id), {
          run,
          assistantText: this.#latestAssistantText(thread.id, run.id),
        });
      }
    } catch (error) {
      const latest = this.database.getTaskReadinessReview(task.id);
      if (latest?.round === review.round && latest.status === "running") {
        await this.#failReview(latest, cappedError(error));
      }
    }
  }

  async #handleRunSettled(payload) {
    const threadId = payload.thread?.id ?? payload.run?.threadId;
    if (!threadId || this.closed) return;
    const review = this.database.getTaskReadinessReviewByThread(threadId);
    if (!review) return;
    await this.#enqueue(review.taskId, async () => {
      const current = this.database.getTaskReadinessReview(review.taskId);
      if (!current || current.aiThreadId !== threadId) return;
      if (current.status === "running" && current.runId === payload.run?.id) {
        await this.#finishReview(current, payload);
        return;
      }
      if (["awaiting_input", "failed"].includes(current.status)) {
        await this.#startReview(current.taskId);
      }
    });
  }

  async #finishReview(review, payload) {
    if (!review || review.status !== "running") return;
    if (payload.run?.status !== "completed") {
      await this.#failReview(review, payload.run?.error ?? "需求审核执行失败");
      return;
    }
    const task = this.database.getTask(review.taskId);
    if (!task || task.archivedAt !== null) return;
    if (
      task.version !== review.sourceTaskVersion
      || this.database.countReadinessInputComments(task.id) !== review.sourceUserCommentCount
    ) {
      this.database.settleTaskReadinessReview(task.id, review.round, {
        status: "failed",
        error: "审核期间任务信息发生变化，正在基于最新信息重新审核",
      });
      await this.#startReview(task.id);
      return;
    }
    try {
      const profile = this.#reviewProfile(task);
      const decision = parseDecision(payload.assistantText);
      const status = decision.decision === "ready" ? "ready" : "awaiting_input";
      const settled = this.database.settleTaskReadinessReview(task.id, review.round, {
        status,
        decision,
      });
      const thread = settled.aiThreadId ? this.aiChat.getThread(settled.aiThreadId) : null;
      const comment = this.database.createComment(task.id, {
        body: reviewComment(decision, settled.round, profile),
        threadId: thread?.codexThreadId ?? undefined,
        actor: REVIEW_ACTOR,
      });
      this.emit("comment.created", { comment, task: this.database.getTask(task.id) });
      if (status === "awaiting_input") {
        const current = this.database.getTask(task.id);
        if (current?.status === "todo") {
          const blocked = this.database.moveTask(current.id, current.version, "blocked");
          this.emit("task.moved", { task: blocked, fromStatus: current.status, readinessReview: true });
        }
        return;
      }
      const current = this.database.getTask(task.id);
      if (!current || !["todo", "blocked"].includes(current.status)) return;
      const readyTask = current.status === "blocked"
        ? this.database.moveTask(current.id, current.version, "todo")
        : current;
      this.emit("task.moved", {
        task: readyTask,
        fromStatus: current.status,
        readinessApproved: true,
      });
      await this.onReady(readyTask);
    } catch (error) {
      await this.#failReview(review, cappedError(error));
    }
  }

  async #failReview(review, error) {
    const task = this.database.getTask(review.taskId);
    if (!task || task.archivedAt !== null) return;
    const profile = this.#reviewProfile(task);
    const message = cappedError(error) || "需求审核执行失败";
    const settled = this.database.settleTaskReadinessReview(task.id, review.round, {
      status: "failed",
      error: message,
    });
    if (settled?.round !== review.round) return;
    const thread = settled.aiThreadId ? this.aiChat.getThread(settled.aiThreadId) : null;
    const comment = this.database.createComment(task.id, {
      body: [
        `## ${profile.parent ? "父任务 planner 派发审核" : "需求审核"} · 第 ${review.round} 轮`,
        "",
        "**状态：审核未完成，任务已转到待解决**",
        "",
        message,
        "",
        "可以在本任务评论区补充信息或重试；系统会沿用当前 planner 对话的模型与推理强度重新发起只读审核。",
      ].join("\n"),
      threadId: thread?.codexThreadId ?? undefined,
      actor: REVIEW_ACTOR,
    });
    this.emit("comment.created", { comment, task: this.database.getTask(task.id) });
    const current = this.database.getTask(task.id);
    if (current?.status === "todo") {
      const blocked = this.database.moveTask(current.id, current.version, "blocked");
      this.emit("task.moved", { task: blocked, fromStatus: current.status, readinessReview: true });
    }
  }

  #reviewMessage(taskId, round) {
    const task = this.database.getTask(taskId);
    const profile = this.#reviewProfile(task);
    const userComments = this.database.listComments(taskId)
      .filter((comment) => comment.authorType === "user" && comment.intent !== "discussion");
    const currentReworkComment = task.reworkRound
      ? userComments.findLast((comment) => comment.reworkRound === task.reworkRound) ?? null
      : null;
    const currentRework = currentReworkComment
      ? reviewCommentSnapshot(currentReworkComment, REVIEW_REWORK_BODY_LIMIT)
      : null;
    const comments = userComments
      .filter((comment) => comment.id !== currentReworkComment?.id)
      .slice(-REVIEW_HISTORY_LIMIT)
      .map((comment) => reviewCommentSnapshot(comment));
    if (profile.parent) {
      const parentComments = this.database.listComments(profile.parent.id)
        .filter((comment) => comment.authorType === "user" && comment.intent !== "discussion")
        .slice(-REVIEW_HISTORY_LIMIT)
        .map((comment) => reviewCommentSnapshot(comment));
      const siblings = profile.parent.relations.subIssues.map((sibling) => ({
        identifier: sibling.identifier,
        title: sibling.title,
        status: sibling.status,
      }));
      return [
        `你是顶层主任务的 planner 派发协调员。这是当前子任务的第 ${round} 轮派发审核。`,
        `父任务：${profile.parent.identifier} ${profile.parent.title}`,
        `父任务描述：${reviewDescription(profile.parent.description)}`,
        `父任务用户评论：${JSON.stringify(parentComments)}`,
        `待派发子任务：${task.identifier} ${task.title}`,
        `子任务描述：${reviewDescription(task.description)}`,
        `子任务标签：${JSON.stringify(task.labels)}`,
        `子任务用户评论：${JSON.stringify(comments)}`,
        `当前返工单：${JSON.stringify(currentRework)}`,
        `同级子任务状态：${JSON.stringify(siblings)}`,
        `阻塞依赖：${JSON.stringify(task.relations.blockedBy)}`,
        "请先只读检查当前工作区中与父任务和本子任务直接相关的代码、文档和已有证据。",
        "判断本子任务是否符合父任务目标、责任边界是否清晰、依赖是否允许启动，以及是否会与同级任务重复或冲突。",
        "decision=ready 表示父任务 planner 正式授权服务器为本子任务启动开发 worker；新对话默认 Luna Max + Fast，但用户选择优先。这不是完成验收。",
        "存在会改变父任务目标、范围、责任边界、依赖顺序或验收标准的关键疑问时，decision 必须为 needs_confirmation。",
        "不要把能从代码、文档或既有约定中自行确认的实现细节抛给用户。",
        "问题必须按 Q1、Q2 编号，简洁、可直接回答，并说明不确认会造成什么偏差。",
        "只返回符合 output schema 的 JSON；不要修改文件、不要调用 taskctl、不要启动开发 worker 或其他开发会话。",
      ].join("\n");
    }
    return [
      `你是待开发前的需求完整性审核员。这是第 ${round} 轮审核。`,
      `任务：${task.identifier} ${task.title}`,
      `描述：${reviewDescription(task.description)}`,
      `标签：${JSON.stringify(task.labels)}`,
      `用户评论：${JSON.stringify(comments)}`,
      `当前返工单：${JSON.stringify(currentRework)}`,
      "请先只读检查当前工作区中与任务直接相关的代码和文档，再判断是否足以开始开发。",
      currentRework
        ? "本轮只审核返工单是否具体、无冲突且具有可验证的完成标准；不要因为已有旧交付就跳过返工范围审核。"
        : "当前不是返工轮次，按首次开发前需求完整性审核处理。",
      "不要把能从代码、文档或既有约定中自行确认的实现细节抛给用户。",
      "如果存在一个会明显改变产品目标、范围、交互、数据边界或验收标准的关键疑问，或者存在多个实质性未确认事项，decision 必须为 needs_confirmation。",
      "只有信息足以安全开始开发时才返回 ready；可由开发者自行决定且风险低的细节写入 assumptions。",
      "问题必须按 Q1、Q2 编号，简洁、可直接回答，并说明不确认会造成什么偏差。",
      "只返回符合 output schema 的 JSON；不要修改文件、不要调用 taskctl、不要启动开发。",
    ].join("\n");
  }

  #reviewProfile(task) {
    const parentId = task?.relations?.parent?.id;
    const parent = parentId ? this.database.getTask(parentId) : null;
    const parentCoordinates = Boolean(
      parent
      && parent.archivedAt === null
      && parent.labels.includes("主任务")
      && !parent.relations.parent,
    );
    return {
      parent: parentCoordinates ? parent : null,
      effort: parentCoordinates ? PARENT_DISPATCH_EFFORT : REVIEW_EFFORT,
    };
  }

  #latestAssistantText(threadId, runId) {
    return this.database.listAiChatEvents(threadId)
      .filter((event) => event.role === "assistant" && event.runId === runId)
      .at(-1)?.content ?? "";
  }
}
