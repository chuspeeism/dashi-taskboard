export const TASK_INTERVENTION_VIEWS = Object.freeze([
  "resolve",
  "follow_up",
  "comment",
]);

export const TASK_INTERVENTION_VIEW_DETAILS = Object.freeze({
  resolve: Object.freeze({
    label: "待我解决",
    description: "需要你补充信息、确认方案或处理异常",
  }),
  follow_up: Object.freeze({
    label: "待我跟进",
    description: "需要你验收、查看异常或处理停滞",
  }),
  comment: Object.freeze({
    label: "待我评论",
    description: "明确等待你的回复",
  }),
});

export const TASK_INTERVENTION_STALLED_AFTER_MS = 24 * 60 * 60 * 1000;

const REASON_PRIORITY = Object.freeze({
  awaiting_confirmation: 10,
  readiness_failed: 20,
  execution_failed: 20,
  awaiting_acceptance: 30,
  stalled: 40,
  manual_include: 90,
});

const ACTIVE_RETRY_STATES = new Set(["pending", "claimed", "running"]);
const ACTIVE_HANDOFF_STATES = new Set(["pending", "processing", "attempt_pending"]);
const ACTIVE_DISPATCH_STATES = new Set(["claimed", "running"]);
const ACTIVE_RUN_STATES = new Set(["pending", "running"]);
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled"]);

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  return Date.parse(value);
}

function isoTimestamp(value) {
  const milliseconds = timestamp(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function newest(values) {
  const valid = values
    .map((value) => ({ value, milliseconds: timestamp(value) }))
    .filter((entry) => Number.isFinite(entry.milliseconds))
    .sort((left, right) => right.milliseconds - left.milliseconds);
  return valid[0]?.value ?? null;
}

function target(taskId, kind, extra = {}) {
  return { kind, taskId, ...extra };
}

function reason({
  view,
  code,
  label,
  action,
  evidenceAt,
  target: reasonTarget,
}) {
  return {
    view,
    code,
    label,
    action,
    evidenceAt: isoTimestamp(evidenceAt),
    target: reasonTarget,
  };
}

function sortReasons(reasons) {
  return reasons.sort((left, right) => (
    (REASON_PRIORITY[left.code] ?? 100) - (REASON_PRIORITY[right.code] ?? 100)
      || timestamp(right.evidenceAt) - timestamp(left.evidenceAt)
      || left.code.localeCompare(right.code)
  ));
}

function latestUserCommentAfter(comments, after) {
  const afterMilliseconds = timestamp(after);
  return [...comments]
    .filter((comment) => comment?.authorType === "user")
    .filter((comment) => timestamp(comment.createdAt) > afterMilliseconds)
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))[0] ?? null;
}

function activeManualOverrides(overrides, lastActivityAt) {
  const activityMilliseconds = timestamp(lastActivityAt);
  const result = new Map();
  for (const override of overrides ?? []) {
    if (!TASK_INTERVENTION_VIEWS.includes(override?.view)) continue;
    if (!override?.mode || override.mode === "auto") continue;
    const updatedMilliseconds = timestamp(override.updatedAt);
    if (
      Number.isFinite(activityMilliseconds)
      && Number.isFinite(updatedMilliseconds)
      && updatedMilliseconds < activityMilliseconds
    ) continue;
    result.set(override.view, override.mode);
  }
  return result;
}

export function computeTaskIntervention(input, options = {}) {
  const {
    task,
    comments = [],
    readinessReview = null,
    signals = [],
    handoffs = [],
    dispatches = [],
    aiRuns = [],
    retryJobs = [],
    orchestrationActivity = [],
    childActivities = [],
  } = input;
  if (!task?.id) throw new Error("Task intervention requires a task");

  const nowMilliseconds = timestamp(options.now ?? Date.now());
  const stalledAfterMs = options.stalledAfterMs ?? TASK_INTERVENTION_STALLED_AFTER_MS;
  const activityValues = [
    task.createdAt,
    task.updatedAt,
    readinessReview?.createdAt,
    readinessReview?.updatedAt,
    ...comments.flatMap((comment) => [comment.createdAt, comment.updatedAt]),
    ...signals.flatMap((signal) => [signal.createdAt, signal.updatedAt]),
    ...handoffs.flatMap((handoff) => [handoff.createdAt, handoff.updatedAt]),
    ...dispatches.flatMap((dispatch) => [dispatch.createdAt, dispatch.updatedAt]),
    ...aiRuns.flatMap((run) => [run.startedAt, run.finishedAt]),
    ...retryJobs.map((job) => job.updatedAt),
    ...orchestrationActivity,
    ...childActivities.map((activity) => activity.updatedAt),
  ];
  const lastActivityAt = newest(activityValues);
  const lastActivityMilliseconds = timestamp(lastActivityAt);
  const reasons = [];
  const seenReasons = new Set();
  const addReason = (value) => {
    const key = `${value.view}:${value.code}`;
    if (seenReasons.has(key)) return;
    seenReasons.add(key);
    reasons.push(reason(value));
  };

  const latestUserComment = readinessReview
    ? latestUserCommentAfter(comments, readinessReview.updatedAt)
    : null;
  const userReplied = Boolean(latestUserComment);
  const activeRetries = retryJobs.filter((job) => ACTIVE_RETRY_STATES.has(job.state));
  const activeHandoffs = handoffs.filter((handoff) => ACTIVE_HANDOFF_STATES.has(handoff.queueStatus ?? handoff.state));
  const activeDispatches = dispatches.filter((dispatch) => ACTIVE_DISPATCH_STATES.has(dispatch.status));
  const activeAiRuns = aiRuns.filter((run) => ACTIVE_RUN_STATES.has(run.status));
  const latestHandoff = [...handoffs]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const latestDispatch = [...dispatches]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const latestAiRun = [...aiRuns]
    .sort((left, right) => timestamp(right.finishedAt ?? right.startedAt) - timestamp(left.finishedAt ?? left.startedAt))[0] ?? null;
  const latestActiveRetry = [...activeRetries]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const latestActiveHandoff = [...activeHandoffs]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const latestActiveDispatch = [...activeDispatches]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const latestActiveAiRun = [...activeAiRuns]
    .sort((left, right) => (
      timestamp(right.finishedAt ?? right.startedAt) - timestamp(left.finishedAt ?? left.startedAt)
    ))[0] ?? null;
  const latestChildActivityAt = newest(childActivities.map((activity) => activity.updatedAt));
  const childActivityCount = new Set(childActivities.map((activity) => activity.taskId).filter(Boolean)).size;

  let progress = null;
  if (readinessReview?.status === "running") {
    progress = {
      code: "reviewing",
      label: "Agent 审核中",
      action: "当前无需你处理",
      evidenceAt: isoTimestamp(readinessReview.updatedAt),
    };
  } else if (latestActiveRetry) {
    progress = {
      code: "retrying",
      label: "Agent 重试中",
      action: "当前无需你处理",
      evidenceAt: isoTimestamp(latestActiveRetry.updatedAt),
    };
  } else if (latestActiveHandoff) {
    progress = {
      code: "coordinating",
      label: "Agent 协调中",
      action: "当前无需你处理",
      evidenceAt: isoTimestamp(latestActiveHandoff.updatedAt),
    };
  } else if (latestActiveDispatch) {
    const planning = latestActiveDispatch.kind === "planner";
    const coordinating = latestActiveDispatch.kind === "handoff";
    progress = {
      code: planning ? "planning" : coordinating ? "coordinating" : "executing",
      label: planning ? "Agent 规划中" : coordinating ? "Agent 协调中" : "Agent 执行中",
      action: "当前无需你处理",
      evidenceAt: isoTimestamp(latestActiveDispatch.updatedAt),
    };
  } else if (latestActiveAiRun) {
    const executing = latestActiveAiRun.threadRole === "worker";
    progress = {
      code: executing ? "executing" : "conversing",
      label: executing ? "Agent 执行中" : "Agent 对话处理中",
      action: "当前无需你处理",
      evidenceAt: isoTimestamp(latestActiveAiRun.finishedAt ?? latestActiveAiRun.startedAt),
    };
  } else if (childActivityCount > 0) {
    progress = {
      code: "coordinating",
      label: "子任务处理中",
      action: `${childActivityCount} 个子任务已由 Agent 接管`,
      evidenceAt: isoTimestamp(latestChildActivityAt),
    };
  }
  const progressSupersedes = (evidenceAt) => (
    progress
    && progress.code !== "conversing"
    && timestamp(progress.evidenceAt) >= timestamp(evidenceAt)
  );

  for (const signal of signals) {
    if (signal?.status && signal.status !== "active") continue;
    if (signal?.kind !== "awaiting_user" || latestUserCommentAfter(comments, signal.updatedAt ?? signal.createdAt)) continue;
    const signalTarget = signal.target ?? target(task.id, "task");
    const label = signal.summary || "等待你确认信息";
    const action = signal.action || "请查看任务并回复确认";
    addReason({
      view: "resolve",
      code: "awaiting_confirmation",
      label,
      action,
      evidenceAt: signal.updatedAt ?? signal.createdAt,
      target: signalTarget,
    });
    addReason({
      view: "comment",
      code: "awaiting_confirmation",
      label,
      action: "请在评论区回复",
      evidenceAt: signal.updatedAt ?? signal.createdAt,
      target: signalTarget,
    });
  }

  if (
    readinessReview?.status === "awaiting_input"
    && !userReplied
  ) {
    const reviewTarget = target(task.id, "readiness", {
      aiThreadId: readinessReview.aiThreadId ?? null,
    });
    addReason({
      view: "resolve",
      code: "awaiting_confirmation",
      label: "需求审核在等待你的确认",
      action: "请查看审核问题并补充信息",
      evidenceAt: readinessReview.updatedAt,
      target: reviewTarget,
    });
    addReason({
      view: "comment",
      code: "awaiting_confirmation",
      label: "需求审核明确等待你的回复",
      action: "请在评论区回复审核问题",
      evidenceAt: readinessReview.updatedAt,
      target: reviewTarget,
    });
  }

  if (readinessReview?.status === "failed" && !userReplied) {
    const reviewTarget = target(task.id, "readiness", {
      aiThreadId: readinessReview.aiThreadId ?? null,
    });
    addReason({
      view: "resolve",
      code: "readiness_failed",
      label: "需求审核未完成，需要你处理",
      action: "请查看失败信息并补充或重试",
      evidenceAt: readinessReview.updatedAt,
      target: reviewTarget,
    });
    addReason({
      view: "follow_up",
      code: "readiness_failed",
      label: "需求审核执行失败",
      action: "请查看审核失败信息",
      evidenceAt: readinessReview.updatedAt,
      target: reviewTarget,
    });
  }

  if (task.status === "in_review") {
    addReason({
      view: "follow_up",
      code: "awaiting_acceptance",
      label: "开发结果等待你验收",
      action: "请查看交付说明并确认结果",
      evidenceAt: task.updatedAt,
      target: target(task.id, "task"),
    });
  }

  const terminalHandoffFailureCandidate = [...handoffs]
    .filter((handoff) => (
      ["failed", "stopped"].includes(handoff.queueStatus ?? handoff.state)
      && (handoff.error || handoff.lastError || handoff.blocker || handoff.summary)
    ))
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
  const activeAgentWorkSupersedesHandoffFailure = terminalHandoffFailureCandidate
    && progressSupersedes(terminalHandoffFailureCandidate.updatedAt);
  const terminalHandoffFailure = activeAgentWorkSupersedesHandoffFailure
    ? null
    : terminalHandoffFailureCandidate;
  const failedDispatchNeedsUser = latestDispatch?.status === "failed"
    && activeHandoffs.length === 0
    && !activeRetries.length
    && !progressSupersedes(latestDispatch.updatedAt);
  const failedAiRunNeedsUser = latestAiRun?.status === "failed"
    && !activeRetries.length
    && activeHandoffs.length === 0
    && !progressSupersedes(latestAiRun.finishedAt ?? latestAiRun.startedAt);
  if (terminalHandoffFailure || failedDispatchNeedsUser || failedAiRunNeedsUser) {
    const failure = terminalHandoffFailure ?? latestDispatch ?? latestAiRun;
    const failureCommentId = failure?.commentId ?? failure?.failureCommentId ?? null;
    addReason({
      view: "follow_up",
      code: "execution_failed",
      label: "Agent 执行出现需要人工处理的失败",
      action: "请查看失败信息并决定下一步",
      evidenceAt: failure?.updatedAt ?? failure?.finishedAt ?? failure?.startedAt,
      target: failureCommentId
        ? target(task.id, "comment", { commentId: failureCommentId })
        : target(task.id, "execution"),
    });
    if (task.status === "blocked") {
      addReason({
        view: "resolve",
        code: "execution_failed",
        label: "任务因执行失败等待你处理",
        action: "请查看失败信息并解除阻塞",
        evidenceAt: failure?.updatedAt ?? failure?.finishedAt ?? failure?.startedAt,
        target: failureCommentId
          ? target(task.id, "comment", { commentId: failureCommentId })
          : target(task.id, "execution"),
      });
    }
  }

  if (
    task.status === "in_progress"
    && !activeRetries.length
    && Number.isFinite(nowMilliseconds)
    && Number.isFinite(lastActivityMilliseconds)
    && nowMilliseconds - lastActivityMilliseconds >= stalledAfterMs
  ) {
    addReason({
      view: "follow_up",
      code: "stalled",
      label: "任务已连续 24 小时没有有效进展",
      action: "请查看执行记录并决定是否继续",
      evidenceAt: lastActivityAt,
      target: target(task.id, "execution"),
    });
  }

  const manualOverrides = activeManualOverrides(input.manualOverrides, lastActivityAt);
  for (const [view, mode] of manualOverrides) {
    if (mode === "exclude") continue;
    addReason({
      view,
      code: "manual_include",
      label: "你已手动加入此介入视图",
      action: "请按需要查看或取消手动修正",
      evidenceAt: task.updatedAt,
      target: target(task.id, "task"),
    });
  }

  for (const [view, mode] of manualOverrides) {
    if (mode === "exclude") {
      for (let index = reasons.length - 1; index >= 0; index -= 1) {
        if (reasons[index].view === view) reasons.splice(index, 1);
      }
    }
  }

  sortReasons(reasons);
  const visibleReasons = TERMINAL_TASK_STATUSES.has(task.status) ? [] : reasons;
  const views = TASK_INTERVENTION_VIEWS.filter((view) => visibleReasons.some((item) => item.view === view));
  const manual = Object.fromEntries(manualOverrides);
  return {
    views,
    reasons: visibleReasons,
    primary: visibleReasons[0] ?? null,
    progress,
    lastActivityAt: isoTimestamp(lastActivityAt),
    manual,
  };
}
