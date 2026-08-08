import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  attachmentContentUrl,
  createAiChatThread,
  createComment,
  deleteAttachment,
  deleteComment,
  getTaskExecutionOverview,
  listAttachments,
  listComments,
  startTaskRework,
  startAiChatTurn,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import type {
  ActorIdentity,
  Attachment,
  Comment,
  CommentAction,
  CommentIntent,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationType,
  Recurrence,
  Task,
  TaskDraft,
  TaskExecutionOverview,
  TaskInterventionReason,
  TaskInterventionView,
  TaskPriority,
  TaskRelationSummary,
  TaskStatus,
  WorkflowOption,
} from "../types";
import {
  TASK_INTERVENTION_VIEW_DETAILS,
  taskIntervention,
} from "../taskIntervention";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS } from "./BoardColumn";
import { createExecutionOverviewLoader } from "../executionOverviewLoader";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon, LinearStatusIcon } from "./LinearIcon";
import {
  fileKey,
  MAX_ATTACHMENT_SIZE,
  PendingAttachments,
} from "./PendingAttachments";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import {
  IssueParentLink,
  IssueRelationSidebar,
  IssueSubIssues,
  type RelationMutationResult,
} from "./IssueRelations";

const DETAIL_SEARCH_HIGHLIGHT = "task-detail-search-match";
const DETAIL_SEARCH_CURRENT_HIGHLIGHT = "task-detail-search-current";

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function detailHighlightApi(): {
  registry: HighlightRegistry;
  HighlightClass: HighlightConstructor;
} | null {
  const registry = (globalThis as typeof globalThis & {
    CSS?: { highlights?: HighlightRegistry };
  }).CSS?.highlights;
  const HighlightClass = (globalThis as typeof globalThis & {
    Highlight?: HighlightConstructor;
  }).Highlight;
  return registry && HighlightClass ? { registry, HighlightClass } : null;
}

function clearDetailSearchHighlights() {
  const api = detailHighlightApi();
  api?.registry.delete(DETAIL_SEARCH_HIGHLIGHT);
  api?.registry.delete(DETAIL_SEARCH_CURRENT_HIGHLIGHT);
}

function detailSearchRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.nodeValue?.trim()
        || parent?.closest(
          "button, input, textarea, select, script, style, [aria-hidden='true'], .comment-composer, .comment-edit-form",
        )
      ) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue ?? "";
    const normalized = value.toLocaleLowerCase();
    let start = 0;
    while (start < normalized.length) {
      const index = normalized.indexOf(needle, start);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
      start = index + Math.max(needle.length, 1);
    }
    node = walker.nextNode();
  }
  return ranges;
}

const PRIORITY_DETAILS: Record<TaskPriority, { label: string; bars: number }> = {
  none: { label: "无优先级", bars: 0 },
  urgent: { label: "紧急", bars: 3 },
  high: { label: "高", bars: 3 },
  medium: { label: "中", bars: 2 },
  low: { label: "低", bars: 1 },
};

const MAIN_STATUS_FLOW: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "pending_retrospective",
  "done",
];

const EXCEPTION_STATUS_FLOW: TaskStatus[] = ["blocked", "canceled"];

const STATUS_FLOW_DETAILS: Record<
  TaskStatus,
  { title: string; description: string; impact: string }
> = {
  backlog: {
    title: "积压事项",
    description: "暂不进入执行流程",
    impact: "任务会回到需求池，不会启动需求审核或开发。",
  },
  todo: {
    title: "待开发",
    description: "进入后检查需求完整性",
    impact: "任务会进入待开发。",
  },
  in_progress: {
    title: "开发执行",
    description: "表示 Agent 正在实现",
    impact: "任务会标记为开发执行中；不会自动创建新的交付结果。",
  },
  in_review: {
    title: "交付验收",
    description: "等待用户确认开发结果",
    impact: "任务会进入交付验收，等待接受交付或提交修改意见。",
  },
  pending_retrospective: {
    title: "待复盘",
    description: "交付已接受，等待复盘",
    impact: "任务会记录为已交付待复盘，仍未进入最终完成。",
  },
  done: {
    title: "完成",
    description: "任务正式结束",
    impact: "任务会直接标记完成；之后仍可通过流程重新打开。",
  },
  blocked: {
    title: "待解决",
    description: "标记当前存在阻塞",
    impact: "任务会进入待解决；系统不会推断它之后应返回哪个阶段。",
  },
  canceled: {
    title: "已取消",
    description: "终止当前任务",
    impact: "任务会终止，但不会归档；之后仍可跨阶段重新打开。",
  },
};

function statusFlowImpact(task: Task, status: TaskStatus): string {
  if (status !== "todo") return STATUS_FLOW_DETAILS[status].impact;
  return task.assignee.type === "agent" && task.assignee.id === CODEX_AGENT_ACTOR.id
    ? "任务会进入待开发，并触发 planner 对需求完整性进行只读审核；新对话默认使用 Sol。"
    : "任务会进入待开发；当前负责人不是 Codex Agent，不会自动启动需求审核。";
}

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  workflows: WorkflowOption[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  executionOverviewRevision: number;
  localAiChatAvailable: boolean;
  queueNavigation: {
    label: string;
    previousTask: Task | null;
    nextTask: Task | null;
  };
  onNavigateQueue: (task: TaskRelationSummary) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onReassign: (task: Task) => void;
  onRestoreArchivedTask?: (taskId: string, version: number) => Promise<void>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (threadId: string) => void;
  onOpenAiThread: (threadId: string) => void;
  onOpenInThread: (task: Task) => void;
  openingThread: boolean;
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentCanPreview(attachment: Attachment): boolean {
  return attachment.contentType === "application/json"
    || attachment.contentType === "application/pdf"
    || attachment.contentType.startsWith("text/")
    || [
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ].includes(attachment.contentType);
}

function DeliveryFiles({
  attachments,
  onPreview,
}: {
  attachments: Attachment[];
  onPreview: (attachment: Attachment) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <section className="delivery-files" aria-label="交付文件">
      <header>
        <strong>交付文件</strong>
        <span>{attachments.length} 个</span>
      </header>
      <ul>
        {attachments.map((attachment) => (
          <li key={attachment.id}>
            <button type="button" onClick={() => onPreview(attachment)}>
              <span className="attachment-file-icon" aria-hidden="true"><LinearIcon name="file" /></span>
              <span className="attachment-copy">
                <strong>{attachment.filename}</strong>
                <span>{fileSize(attachment.size)} · 点击预览</span>
              </span>
              <LinearIcon name="chevronRight" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MarkdownAttachmentPreview({ attachment }: { attachment: Attachment }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError(null);
    void fetch(attachmentContentUrl(attachment), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setValue)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("Markdown 文件读取失败，可以下载后打开。");
      });
    return () => controller.abort();
  }, [attachment]);

  if (error) return <div className="attachment-preview-message">{error}</div>;
  if (value === null) return <div className="attachment-preview-message">正在读取 Markdown…</div>;
  return <div className="attachment-markdown-preview"><DescriptionDocument value={value} /></div>;
}

function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const contentUrl = attachmentContentUrl(attachment);
  const canPreview = attachmentCanPreview(attachment);
  const isImage = attachment.contentType.startsWith("image/");
  const isMarkdown = attachment.contentType === "text/markdown";

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <>
      <button className="attachment-preview-backdrop" type="button" aria-label="关闭文件预览" onClick={onClose} />
      <aside className="attachment-preview-panel" role="dialog" aria-modal="true" aria-label={`预览 ${attachment.filename}`}>
        <header>
          <div className="attachment-preview-title">
            <span className="attachment-file-icon" aria-hidden="true"><LinearIcon name="file" /></span>
            <span>
              <strong>{attachment.filename}</strong>
              <small>{fileSize(attachment.size)} · {attachment.contentType}</small>
            </span>
          </div>
          <div className="attachment-preview-actions">
            <a href={contentUrl} target="_blank" rel="noreferrer" title="在新窗口打开">
              <LinearIcon name="openExternal" />
            </a>
            <a href={contentUrl} download={attachment.filename}>下载</a>
            <button type="button" aria-label="关闭文件预览" onClick={onClose}>
              <LinearIcon name="close" />
            </button>
          </div>
        </header>
        <div className="attachment-preview-content">
          {canPreview ? (
            isMarkdown ? (
              <MarkdownAttachmentPreview attachment={attachment} />
            ) : isImage ? (
              <img src={contentUrl} alt={attachment.filename} />
            ) : (
              <iframe
                src={contentUrl}
                title={attachment.filename}
                sandbox={attachment.contentType === "text/html" ? "allow-scripts" : undefined}
              />
            )
          ) : (
            <div className="attachment-preview-unavailable">
              <LinearIcon name="file" />
              <strong>这个文件暂不支持直接预览</strong>
              <span>可以下载后使用本机应用打开。</span>
              <a href={contentUrl} download={attachment.filename}>下载文件</a>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

function currentExperienceStage(task: Task): { label: string; owner: string; action: string } {
  const readiness = task.readinessReview;
  if (readiness?.status === "running") {
    const owner = readiness.aiModel?.replace(/^gpt-/i, "").replaceAll("-", " ") ?? "Planner";
    return task.reworkRound
      ? { label: `返工审核 · 第 ${task.reworkRound} 轮`, owner, action: "Planner 正在只读审核本轮返工范围。" }
      : { label: `需求审核 · 第 ${readiness.round} 轮`, owner, action: "正在复审，可打开需求审核对话查看进度。" };
  }
  if (readiness?.status === "awaiting_input") {
    return task.reworkRound
      ? { label: `返工范围 · 第 ${task.reworkRound} 轮待补充`, owner: "你", action: "补充返工范围后继续同一轮审核。" }
      : { label: "需求审核 · 等待补充", owner: "你", action: "补充信息后点击“发布并重新审核”。" };
  }
  if (readiness?.status === "failed") {
    return task.reworkRound
      ? { label: `返工审核 · 第 ${task.reworkRound} 轮待重试`, owner: "你", action: "补充说明后重新启动本轮返工审核。" }
      : { label: "需求审核 · 待重试", owner: "你", action: "补充说明后点击“发布并重新审核”。" };
  }
  if (task.status === "in_review") {
    return task.reworkRound
      ? { label: `第 ${task.reworkRound} 轮返工待验收`, owner: "你", action: "接受本轮交付，或发起下一轮返工审核。" }
      : { label: "交付验收", owner: "你", action: "通过验收，或提交修改意见让 Agent 继续开发。" };
  }
  if (task.status === "in_progress") {
    return task.reworkRound
      ? { label: `返工开发 · 第 ${task.reworkRound} 轮`, owner: "Codex Agent", action: "Agent 正按已审核的返工范围实现。" }
      : { label: "开发执行", owner: "Codex Agent", action: "Agent 正在实现；普通评论不会打断执行。" };
  }
  if (task.status === "todo" && readiness?.status === "ready") {
    return { label: "待开发", owner: "Codex Agent", action: "审核已通过；点击“发布并开始开发”可启动或恢复开发对话。" };
  }
  if (task.status === "pending_retrospective") {
    return { label: "已完成待验收", owner: "你", action: "查看交付结果并决定是否归档。" };
  }
  return {
    label: STATUS_DETAILS[task.status].label,
    owner: task.assignee.name,
    action: "普通评论只记录；需要 AI 处理时请选择明确动作。",
  };
}

function commentActionLabel(comment: Comment): string {
  if (comment.reworkRound) return `第 ${comment.reworkRound} 轮返工`;
  const action = comment.action ?? (
    comment.intent === "discussion"
      ? "discussion"
      : comment.intent === "resume"
        ? comment.aiThreadId ? "development" : "review"
        : "comment"
  );
  if (action === "comment") return "仅发布";
  if (action === "review") return "发布并重新审核";
  if (action === "development") return "发布并开始开发";
  return "新开 Sol 对话";
}

function isDeliveryReviewComment(comment: Comment): boolean {
  return comment.authorType === "agent"
    && comment.body.trimStart().startsWith("## 交付重新审核");
}

function commentPayload(value: string): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(value) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function interventionReasonGroupKey(reason: TaskInterventionReason): string {
  return [
    reason.code,
    reason.target.kind,
    reason.target.commentId ?? "",
    reason.target.aiThreadId ?? "",
  ].join(":");
}

function interventionReasonViews(
  reason: TaskInterventionReason,
  reasons: TaskInterventionReason[],
): TaskInterventionView[] {
  const key = interventionReasonGroupKey(reason);
  return [...new Set(
    reasons
      .filter((candidate) => interventionReasonGroupKey(candidate) === key)
      .map((candidate) => candidate.view),
  )];
}

function normalizedLoadedCommentBody(value: string): string {
  const type = commentPayload(value)?.type;
  return type === "task_handoff" || type === "task_handoff_retry_exhausted"
    ? value
    : normalizeCommentMarkdown(value);
}

function solDiscussionPrompt(task: Task, body: string): string {
  return [
    "你正在参与一个与任务关联、但独立于任务主流程的只读讨论。",
    "",
    `任务：${task.identifier} ${task.title}`,
    "任务描述：",
    task.description || "（无描述）",
    "",
    "用户希望讨论的问题：",
    body,
    "",
    "请分析问题、指出关键判断与可选方案。这个讨论不得修改文件、不得改变任务状态、不得启动开发；最终是否采用结论由用户决定。",
  ].join("\n").slice(0, 100_000);
}

function deliveryReviewPrompt(task: Task, body: string): string {
  return [
    "你正在对一个已经完成开发、当前处于审核中的任务做只读交付审核。",
    "保持任务状态不变，不修改文件、不启动开发、不调用 taskctl 或其他任务管理工具。",
    "请读取任务描述和全部评论，复核现有交付结果，并重新输出一份用户可直接执行的验收说明。",
    "验收说明必须使用 Markdown，详细包含：交付结论、需要验收的内容、验收前准备、逐项编号的验收步骤、每一步的操作入口/具体操作/预期结果/通过标准、已有证据、未验证项、剩余风险，以及失败时需要用户反馈的信息。",
    "如果现有证据不足，只能明确标为未验证或要求补充，不得假设已经通过。",
    "",
    `任务：${task.identifier} ${task.title}`,
    "用户本次审核说明：",
    body,
  ].join("\n").slice(0, 100_000);
}

function resumeDevelopmentPrompt(task: Task, body: string): string {
  return [
    "用户已在任务卡中明确要求开始或继续开发。",
    "",
    `任务：${task.identifier} ${task.title}`,
    "用户评论：",
    body,
    "",
    "请读取最新任务内容和全部评论，认领后继续开发；完成实现与验证后，先记录交付结果、需要我验收的内容、验收前准备和逐项编号的验收步骤。每一步都要写清操作入口、具体操作、预期结果和通过标准，并标明自动验证、未验证项、风险以及失败时需要我反馈的信息；然后再移到审核中，不要直接标记完成。",
  ].join("\n").slice(0, 100_000);
}

function deliveryReviewBody(comment: Comment): string {
  const payload = commentPayload(comment.body);
  if (payload?.type !== "task_handoff") return normalizeCommentMarkdown(comment.body);

  const acceptance = Array.isArray(payload.acceptance)
    ? payload.acceptance.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const latestComment = payload.latestComment && typeof payload.latestComment === "object"
    ? payload.latestComment as { body?: unknown }
    : null;
  const handoffDelivery = typeof payload.delivery === "string" ? payload.delivery.trim() : "";
  const latestDelivery = typeof latestComment?.body === "string" ? latestComment.body.trim() : "";
  const delivery = payload.sourceKind === "task_status" && latestDelivery
    ? latestDelivery
    : handoffDelivery || latestDelivery || "Agent 未提供交付说明，请先要求补充后再验收。";
  const acceptanceItems = acceptance.length > 0
    ? acceptance
    : ["对照任务描述和下方交付说明，确认要求的主流程能够完整完成。"];

  return [
    "## 验收清单",
    "",
    ...acceptanceItems.map((item) => `- [ ] ${item}`),
    "",
    "> 具体入口、操作、预期结果和通过标准以 Agent 交付说明为准；信息缺失时请要求补充，不要猜测。",
    "",
    "## Agent 交付说明",
    "",
    normalizeCommentMarkdown(delivery),
  ].join("\n");
}

function activityCommentBody(comment: Comment, compactDelivery = false): string {
  if (compactDelivery) {
    return [
      "**交付说明已汇总到上方“开发结果待验收”区域。**",
      "",
      "> 此处只保留提交时间和来源，避免重复展示同一份内容。",
    ].join("\n");
  }
  const fallback = normalizeCommentMarkdown(comment.body);
  const payload = commentPayload(comment.body);
  if (!payload) return fallback;

  if (payload.type === "task_handoff") {
    const child = typeof payload.childIdentifier === "string" && payload.childIdentifier.trim()
      ? payload.childIdentifier.trim()
      : "当前子任务";
    const status = typeof payload.status === "string" ? payload.status : "";
    const statusCopy: Record<string, { label: string; explanation: string; action: string }> = {
      completed: {
        label: "已提交结果，等待审核",
        explanation: "子任务已经把交付结果报告给父任务，父任务会继续协调后续依赖。",
        action: "无需回复或编辑这条系统记录；需要验收时，请使用上方验收区。",
      },
      failed: {
        label: "执行失败，当前待解决",
        explanation: "子任务已经把阻塞报告给父任务，任务会保持待解决，直到阻塞被解除。",
        action: "无需回复或编辑这条系统记录；请以任务顶部状态和最新可读评论为准。",
      },
      interrupted: {
        label: "执行中断，当前待解决",
        explanation: "子任务已经把中断报告给父任务，任务会保持待解决，直到重新恢复。",
        action: "无需回复或编辑这条系统记录；请以任务顶部状态和最新可读评论为准。",
      },
      canceled: {
        label: "任务已取消",
        explanation: "子任务已经把取消结果报告给父任务，父任务会保留这条历史记录。",
        action: "无需回复或编辑这条系统记录。",
      },
    };
    const copy = statusCopy[status] ?? {
      label: "状态已同步",
      explanation: "子任务已经把最新状态报告给父任务。",
      action: "无需回复或编辑这条系统记录；请以任务顶部状态为准。",
    };
    const runSummary = payload.sourceKind === "run"
      ? status === "completed" ? payload.delivery : payload.blocker
      : null;
    const summary = typeof runSummary === "string" && runSummary.trim()
      ? normalizeCommentMarkdown(runSummary.trim())
      : "";

    return [
      "**系统协调记录**",
      "",
      `- **子任务**：${child}`,
      `- **结果**：${copy.label}`,
      `- **说明**：${copy.explanation}`,
      ...(summary ? ["", "**Agent 摘要**", "", summary] : []),
      "",
      `> ${copy.action}`,
    ].join("\n");
  }

  if (payload.type === "task_handoff_retry_exhausted") {
    const retryCount = typeof payload.retryCount === "number" ? payload.retryCount : null;
    const error = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : "未提供失败原因";
    return [
      "**系统协调异常**",
      "",
      "- **结果**：父任务协调重试仍未成功",
      ...(retryCount === null ? [] : [`- **已重试**：${retryCount} 次`]),
      `- **失败原因**：${error}`,
      "",
      "> 无需处理原始系统数据；请以任务顶部的待解决状态和最新可读失败说明为准。",
    ].join("\n");
  }

  return fallback;
}

function DescriptionDocument({ value }: { value: string }) {
  return (
    <div className="issue-description-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function deliveryReviewSections(value: string): Array<{ title: string | null; body: string }> {
  const sections: Array<{ title: string | null; body: string[] }> = [];
  let current = { title: null as string | null, body: [] as string[] };

  for (const line of value.split("\n")) {
    const heading = line.match(/^##\s+(需要你验收的内容|验收步骤|Agent 交付说明与证据)\s*$/);
    if (!heading) {
      current.body.push(line);
      continue;
    }
    if (current.title || current.body.some((item) => item.trim())) sections.push(current);
    current = { title: heading[1].trim(), body: [] };
  }
  if (current.title || current.body.some((item) => item.trim())) sections.push(current);

  return sections.map((section) => ({
    title: section.title,
    body: section.body.join("\n").trim(),
  }));
}

function acceptanceItemCount(value: string): number {
  const checklist = deliveryReviewSections(value).find((section) => section.title === "需要你验收的内容");
  return checklist?.body.match(/^-\s+\[[ xX]\]\s+/gm)?.length ?? 0;
}

function hasStructuredDeliveryReview(value: string): boolean {
  return deliveryReviewSections(value).some((section) => section.title !== null);
}

function DeliveryReviewDocument({ value }: { value: string }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const sections = deliveryReviewSections(value);

  return (
    <div className="delivery-review-sections">
      {sections.map((section, index) => {
        const evidence = section.title?.startsWith("Agent 交付说明") ?? false;
        if (evidence) {
          return (
            <section className="delivery-review-section is-evidence" key={`${section.title}-${index}`}>
              <button
                type="button"
                aria-expanded={evidenceOpen}
                onClick={() => setEvidenceOpen((current) => !current)}
              >
                <span>
                  <strong>{section.title}</strong>
                  <small>查看实现说明、自动验证和剩余风险</small>
                </span>
                <span className="delivery-review-section-action">
                  {evidenceOpen ? "收起" : "展开"}
                  <LinearIcon name="chevronDown" />
                </span>
              </button>
              {evidenceOpen && section.body && <DescriptionDocument value={section.body} />}
            </section>
          );
        }

        return (
          <section className="delivery-review-section" key={`${section.title ?? "intro"}-${index}`}>
            {section.title && <h2>{section.title}</h2>}
            {section.body && <DescriptionDocument value={section.body} />}
          </section>
        );
      })}
    </div>
  );
}

function normalizeCommentMarkdown(value: string): string {
  return value.includes("\n") ? value : value.replaceAll("\\n", "\n");
}

function ConversationLink({
  threadId,
  onOpen,
}: {
  threadId: string;
  onOpen: (threadId: string) => void;
}) {
  return (
    <button
      className="issue-conversation-link"
      type="button"
      title={`查看对话 ${threadId}`}
      onClick={() => onOpen(threadId)}
    >
      <LinearIcon name="conversation" />
      <strong>查看对话</strong>
      <span className="conversation-divider" aria-hidden="true" />
      <span className="conversation-thread-id">{threadId}</span>
    </button>
  );
}

export function TaskDetail({
  task,
  tasks,
  currentUser,
  availableLabels,
  workflows,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  executionOverviewRevision,
  localAiChatAvailable,
  queueNavigation,
  onNavigateQueue,
  onUpdate,
  onReassign,
  onRestoreArchivedTask,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenAiThread,
  onOpenInThread,
  openingThread,
  onError,
  onAnnounce,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [editingDescription, setEditingDescription] = useState(false);
  const [deliveryReviewOpen, setDeliveryReviewOpen] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [statusFlowOpen, setStatusFlowOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<TaskStatus | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState<Attachment | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [executionOverview, setExecutionOverview] = useState<TaskExecutionOverview | null>(null);
  const [executionOverviewLoading, setExecutionOverviewLoading] = useState(false);
  const [executionOverviewError, setExecutionOverviewError] = useState<string | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      window.localStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
    ),
  );
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [submittingIntent, setSubmittingIntent] = useState<CommentIntent | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailSearchMatches, setDetailSearchMatches] = useState<Range[]>([]);
  const [activeDetailSearchIndex, setActiveDetailSearchIndex] = useState(0);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const statusFlowRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const executionOverviewLoaderRef = useRef<ReturnType<typeof createExecutionOverviewLoader> | null>(null);
  const executionOverviewMountedRef = useRef(false);
  const detailSearchRootRef = useRef<HTMLDivElement>(null);
  let executionOverviewLoader = executionOverviewLoaderRef.current;
  if (!executionOverviewLoader) {
    executionOverviewLoader = createExecutionOverviewLoader({
      request: getTaskExecutionOverview,
      onLoading: () => {
        setExecutionOverviewLoading(true);
        setExecutionOverviewError(null);
      },
      onSuccess: (nextOverview) => {
        setExecutionOverview(nextOverview);
        setExecutionOverviewLoading(false);
      },
      onError: (error) => {
        if ((error as Error).name === "AbortError") return;
        setExecutionOverview(null);
        setExecutionOverviewError("执行概览暂不可用，已保留现有子议题关系。");
        setExecutionOverviewLoading(false);
      },
      onDisabled: () => {
        setExecutionOverview(null);
        setExecutionOverviewLoading(false);
        setExecutionOverviewError(null);
      },
    });
    executionOverviewLoaderRef.current = executionOverviewLoader;
  }
  const workflowAvailable = !currentTask.workflowId
    || workflows.some((workflow) => workflow.id === currentTask.workflowId);
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);
  const submitting = submittingIntent !== null;
  const canStartDevelopment = (
    currentTask.status === "todo"
    && currentTask.readinessReview?.status === "ready"
  );
  const serverManagedMainTask = (
    currentTask.labels.includes("主任务")
    && !currentTask.relations.parent
  );
  const canStartRework = currentTask.status === "in_review" && localAiChatAvailable;
  const canContinueStage = (
    ["awaiting_input", "failed"].includes(currentTask.readinessReview?.status ?? "")
    || canStartRework
    || canStartDevelopment
  );
  const continueActionLabel = canStartDevelopment
    ? "发布并开始开发"
    : canStartRework
      ? "提交返工并重新审核"
      : "发布并重新审核";
  const experienceStage = currentExperienceStage(currentTask);
  const pendingStage = pendingStatus ? STATUS_FLOW_DETAILS[pendingStatus] : null;

  useEffect(() => {
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (document.activeElement !== descriptionRef.current) setDescription(task.description);
  }, [task]);

  useEffect(() => {
    setDetailSearch("");
    setDetailSearchMatches([]);
    setActiveDetailSearchIndex(0);
    setStatusFlowOpen(false);
    setPendingStatus(null);
    setDeliveryReviewOpen(false);
    setPreviewAttachment(null);
    clearDetailSearchHighlights();
  }, [task.id]);

  useEffect(() => {
    if (!statusFlowOpen) return;
    function closeStatusFlowOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !statusFlowRef.current?.contains(event.target)) {
        setStatusFlowOpen(false);
        setPendingStatus(null);
      }
    }
    function closeStatusFlowOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setStatusFlowOpen(false);
      setPendingStatus(null);
    }
    document.addEventListener("pointerdown", closeStatusFlowOnOutsidePointer);
    window.addEventListener("keydown", closeStatusFlowOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeStatusFlowOnOutsidePointer);
      window.removeEventListener("keydown", closeStatusFlowOnEscape);
    };
  }, [statusFlowOpen]);

  useEffect(() => {
    const root = detailSearchRootRef.current;
    if (!root || !detailSearch.trim()) {
      setDetailSearchMatches([]);
      setActiveDetailSearchIndex(0);
      clearDetailSearchHighlights();
      return;
    }
    const matches = detailSearchRanges(root, detailSearch);
    setDetailSearchMatches(matches);
    setActiveDetailSearchIndex(0);
  }, [
    comments,
    commentsLoading,
    currentTask.id,
    currentTask.status,
    description,
    detailSearch,
    editingDescription,
    executionOverview,
  ]);

  useEffect(() => {
    clearDetailSearchHighlights();
    const api = detailHighlightApi();
    if (!api || detailSearchMatches.length === 0) return;
    const currentRange = detailSearchMatches[activeDetailSearchIndex] ?? detailSearchMatches[0];
    api.registry.set(
      DETAIL_SEARCH_HIGHLIGHT,
      new api.HighlightClass(...detailSearchMatches),
    );
    api.registry.set(
      DETAIL_SEARCH_CURRENT_HIGHLIGHT,
      new api.HighlightClass(currentRange),
    );
    currentRange.startContainer.parentElement?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    return clearDetailSearchHighlights;
  }, [activeDetailSearchIndex, detailSearchMatches]);

  useEffect(() => {
    executionOverviewLoader.reconcile({
      taskId: task.id,
      revision: executionOverviewRevision,
      localAiChatAvailable,
    });
  }, [executionOverviewRevision, localAiChatAvailable, task.id, executionOverviewLoader]);

  useEffect(() => {
    executionOverviewMountedRef.current = true;
    return () => {
      executionOverviewMountedRef.current = false;
      queueMicrotask(() => {
        if (!executionOverviewMountedRef.current) executionOverviewLoader.dispose();
      });
    };
  }, [executionOverviewLoader]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
    resizeTextarea(descriptionRef.current);
  }, [title, description, editingDescription]);

  useEffect(() => {
    if (!editingDescription) return;
    requestAnimationFrame(() => {
      descriptionRef.current?.focus();
      resizeTextarea(descriptionRef.current);
    });
  }, [editingDescription]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsError(null);
    void listComments(task.id, controller.signal).then(
      (nextComments) => {
        setComments(nextComments.map((comment) => ({
          ...comment,
          body: normalizedLoadedCommentBody(comment.body),
        })));
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsLoading(true);
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
        setAttachmentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
        setAttachmentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  }, [commentSegments, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  async function saveTask(changes: Partial<TaskDraft>, property: string) {
    if (currentTask.archivedAt !== null) {
      onError("已归档议题为只读状态，请先恢复议题。");
      return null;
    }
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      onAnnounce(`${saved.identifier} 已更新。`);
      return saved;
    } catch (error) {
      onError(messageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  function closeStatusFlow() {
    setStatusFlowOpen(false);
    setPendingStatus(null);
  }

  function toggleStatusFlow() {
    if (currentTask.archivedAt !== null || savingProperty === "status") return;
    if (statusFlowOpen) {
      closeStatusFlow();
      return;
    }
    setPendingStatus(null);
    setStatusFlowOpen(true);
  }

  async function confirmStatusChange() {
    if (!pendingStatus) return;
    if (pendingStatus === currentTask.status) {
      closeStatusFlow();
      return;
    }
    const saved = await saveTask({ status: pendingStatus }, "status");
    if (saved) closeStatusFlow();
  }

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
    if (currentTask.archivedAt !== null) {
      onError("已归档议题为只读状态，请先恢复议题。");
      throw new Error("Archived task is read-only");
    }
    onError(null);
    try {
      const result = await mutation();
      const nextCurrent = result.task.id === currentTask.id
        ? result.task
        : result.relatedTask.id === currentTask.id
          ? result.relatedTask
          : null;
      if (nextCurrent) setCurrentTask(nextCurrent);
      return result;
    } catch (error) {
      onError(messageFor(error));
      throw error;
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    if (currentTask.archivedAt !== null) {
      setTitle(currentTask.title);
      return;
    }
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError("议题标题不能为空。");
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    if (currentTask.archivedAt !== null) {
      setDescription(currentTask.description);
      return;
    }
    const normalized = description.trim();
    if (normalized === currentTask.description) return;
    await saveTask({ description: normalized }, "description");
  }

  async function submitComment(
    intent: CommentIntent = "comment",
    options: { body?: string; sourceAiThreadId?: string; preserveComposer?: boolean } = {},
  ) {
    const body = (options.body ?? draft).trim();
    const reworkRequested = intent === "resume" && canStartRework;
    const usesComposer = options.body === undefined;
    if (
      currentTask.archivedAt !== null
      || (!body && (!usesComposer || (pendingCommentFiles.length === 0 && commentInlineImages.length === 0)))
      || submitting
    ) return;
    if (intent === "resume" && !canContinueStage) return;
    if (intent === "discussion" && !localAiChatAvailable) return;
    setSubmittingIntent(intent);
    setCommentsError(null);
    try {
      let discussionStartError: string | null = null;
      let developmentStartError: string | null = null;
      const action: CommentAction = intent === "resume"
        ? canStartDevelopment ? "development" : "review"
        : intent === "discussion" && currentTask.status === "in_review"
          ? "review"
          : intent;
      const comment = await createComment(task.id, body, {
        intent: reworkRequested ? "comment" : intent,
        action: reworkRequested ? "comment" : action,
      });
      const [results, inlineAttachments] = await Promise.all([
        Promise.allSettled(
          (usesComposer ? pendingCommentFiles : []).map((file) => uploadCommentAttachment(comment.id, file)),
        ),
        Promise.all(
          (usesComposer ? commentInlineImages : []).map((image) => uploadCommentAttachment(comment.id, image.file)),
        ),
      ]);
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      let nextComment = usesComposer && commentInlineImages.length > 0
        ? await updateComment(
            comment,
            resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
          )
        : { ...comment, attachments: [...comment.attachments, ...uploaded] };
      let developmentReady = canStartDevelopment;
      if (reworkRequested) {
        try {
          const result = await startTaskRework(
            currentTask,
            nextComment,
            options.sourceAiThreadId,
          );
          nextComment = result.comment;
          setCurrentTask(result.task);
          developmentReady = false;
        } catch (error) {
          throw new Error(`修改意见已保存，但返工未发起：${messageFor(error)}`);
        }
      }
      if (intent === "discussion") {
        const reviewingDelivery = currentTask.status === "in_review";
        const thread = await createAiChatThread({
          projectId: currentTask.projectId,
          title: reviewingDelivery
            ? `${currentTask.identifier} · 交付重新审核`
            : `${currentTask.identifier} · Sol 独立讨论`,
          role: "planner",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier: null,
          sandbox: "read-only",
        });
        nextComment = await updateComment(nextComment, nextComment.body, { aiThreadId: thread.id });
        setComments((current) => [...current, nextComment]);
        onOpenAiThread(thread.id);
        try {
          await startAiChatTurn(thread.id, {
            message: reviewingDelivery
              ? deliveryReviewPrompt(currentTask, nextComment.body)
              : solDiscussionPrompt(currentTask, nextComment.body),
          });
        } catch (error) {
          discussionStartError = messageFor(error);
        }
      } else if (
        intent === "resume"
        && developmentReady
        && !reworkRequested
        && !(canStartDevelopment && serverManagedMainTask)
      ) {
        const thread = await createAiChatThread({
          projectId: currentTask.projectId,
          issueId: currentTask.id,
          title: currentTask.identifier,
        });
        nextComment = await updateComment(nextComment, nextComment.body, { aiThreadId: thread.id });
        setComments((current) => [...current, nextComment]);
        onOpenAiThread(thread.id);
        try {
          await startAiChatTurn(thread.id, {
            message: resumeDevelopmentPrompt(currentTask, nextComment.body),
          });
        } catch (error) {
          developmentStartError = messageFor(error);
        }
      } else {
        setComments((current) => [...current, nextComment]);
      }
      if (!options.preserveComposer) {
        setCommentSegments(createInlineMediaSegments());
        setPendingCommentFiles([]);
        if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      }
      const failed = results.length - uploaded.length;
      if (discussionStartError) {
        setCommentsError(currentTask.status === "in_review"
          ? `交付重新审核已创建并绑定，但首轮消息启动失败：${discussionStartError}`
          : `Sol 独立讨论已创建并绑定，但首轮消息启动失败：${discussionStartError}`);
      } else if (developmentStartError) {
        setCommentsError(`评论已发布并绑定开发对话，但开发启动失败：${developmentStartError}`);
      } else if (failed > 0) {
        setCommentsError(`评论已发布，但有 ${failed} 个附件上传失败。`);
      } else if (intent === "discussion") {
        onAnnounce(currentTask.status === "in_review"
          ? "已启动 Sol 只读交付审核；任务保持在审核中。"
          : "已创建并打开 Sol 独立讨论；任务状态保持不变。");
      } else if (intent === "resume") {
        onAnnounce(reworkRequested
          ? `第 ${nextComment.reworkRound} 轮返工已提交，任务已回到待开发，planner 正在审核。`
          : canStartDevelopment
            ? serverManagedMainTask
              ? "继续指令已发布，服务端正在恢复主任务 planner 编排。"
              : "指令已发布，开发对话已启动。"
            : "补充已发布，planner 将继续当前需求审核。");
      } else {
        onAnnounce(uploaded.length + inlineAttachments.length > 0
          ? "评论和附件已发布，没有触发 AI。"
          : "评论已发布，没有触发 AI。");
      }
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmittingIntent(null);
    }
  }

  function stageCommentFiles(files: FileList | File[]) {
    if (currentTask.archivedAt !== null) return;
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setCommentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      return;
    }
    setCommentsError(null);
    setPendingCommentFiles((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment("comment");
    }
  }

  function moveDetailSearch(direction: 1 | -1) {
    if (detailSearchMatches.length === 0) return;
    setActiveDetailSearchIndex((current) => (
      (current + direction + detailSearchMatches.length) % detailSearchMatches.length
    ));
  }

  function beginEdit(comment: Comment) {
    if (currentTask.archivedAt !== null) return;
    setEditingId(comment.id);
    setEditingBody(comment.body);
    setActiveMenuId(null);
  }

  async function saveComment(comment: Comment) {
    if (currentTask.archivedAt !== null) return;
    const body = editingBody.trim();
    if (!body || body === comment.body) {
      if (body === comment.body) setEditingId(null);
      return;
    }
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const updated = await updateComment(comment, body);
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
      onAnnounce("评论已更新。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting || currentTask.archivedAt !== null) return;
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      onAnnounce("评论已删除。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  async function uploadFiles(files: FileList) {
    const selected = Array.from(files);
    if (currentTask.archivedAt !== null || selected.length === 0 || uploadingAttachments) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }

    setUploadingAttachments(true);
    setAttachmentsError(null);
    let uploaded = 0;
    try {
      for (const file of selected) {
        const attachment = await uploadAttachment(task.id, file);
        setAttachments((current) => current.some((item) => item.id === attachment.id)
          ? current
          : [...current, attachment]);
        uploaded += 1;
      }
      onAnnounce(uploaded === 1 ? "附件已上传。" : `${uploaded} 个附件已上传。`);
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function confirmAttachmentDelete() {
    if (!pendingAttachmentDelete || deletingAttachment || currentTask.archivedAt !== null) return;
    setDeletingAttachment(true);
    setAttachmentsError(null);
    try {
      await deleteAttachment(pendingAttachmentDelete);
      setAttachments((current) => current.filter((attachment) => attachment.id !== pendingAttachmentDelete.id));
      setComments((current) => current.map((comment) => ({
        ...comment,
        attachments: comment.attachments.filter((attachment) => attachment.id !== pendingAttachmentDelete.id),
      })));
      setPendingAttachmentDelete(null);
      onAnnounce("附件已删除。");
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setDeletingAttachment(false);
    }
  }

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }
  const assigneeOptions = [currentTask.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  const visibleTaskAttachments = attachments.filter(
    (attachment) => !description.includes(attachmentContentUrl(attachment)),
  );
  const archived = currentTask.archivedAt !== null;
  const rawDeliveryComment = currentTask.status === "in_review"
    ? [...comments].reverse().find((comment) => (
        comment.authorType === "agent"
        && !comment.body.includes("需求审核 · 第")
        && !comment.body.includes("父任务 Sol 派发审核 · 第")
        && !comment.body.includes("父任务 planner 派发审核 · 第")
        && commentPayload(comment.body)?.type !== "task_handoff_retry_exhausted"
      )) ?? null
    : null;
  const deliveryComment = rawDeliveryComment
    ? { ...rawDeliveryComment, body: deliveryReviewBody(rawDeliveryComment) }
    : null;
  const deliveryAcceptanceCount = deliveryComment
    ? acceptanceItemCount(deliveryComment.body)
    : 0;
  const intervention = taskIntervention(currentTask);
  const interventionReasons = intervention.reasons.filter((reason, index, reasons) => (
    reasons.findIndex((candidate) => (
      interventionReasonGroupKey(candidate) === interventionReasonGroupKey(reason)
    )) === index
  ));

  return (
    <section className="issue-detail" aria-label={`${task.identifier} 议题详情`}>
      {archived && (
        <div className="task-archived-banner" role="status">
          <LinearIcon name="file" />
          <span>此议题已归档，内容、关系、评论和附件均为只读。恢复后可继续编辑。</span>
        </div>
      )}
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main" ref={detailSearchRootRef}>
            <article className="issue-editor" aria-label="议题内容">
              <div className="issue-editor-content">
                <div className="issue-task-identifier">{currentTask.identifier}</div>
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label="议题标题"
                  disabled={archived || savingProperty === "title"}
                  onChange={(event) => {
                    setTitle(event.target.value.replace(/\n/g, ""));
                    resizeTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={() => void saveTitle()}
                />
                <IssueParentLink
                  task={currentTask}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onAddRelation(anchor, type, relatedTaskId),
                  )}
                  onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onRemoveRelation(anchor, type, relatedTaskId),
                  )}
                  disabled={archived}
                />
                {interventionReasons.length > 0 && (
                  <section
                    className="issue-intervention-details"
                    id="task-intervention-details"
                    aria-label="需要用户介入的原因"
                  >
                    <header>
                      <div>
                        <strong><LinearIcon name="hand" /> 为什么需要你介入</strong>
                        <span>状态、评论和执行事件变化后会自动更新</span>
                      </div>
                    </header>
                    <ul>
                      {interventionReasons.map((item) => (
                        <li key={interventionReasonGroupKey(item)}>
                          <span className={`intervention-reason-view intervention-reason-${item.view}`}>
                            {interventionReasonViews(item, intervention.reasons)
                              .map((view) => TASK_INTERVENTION_VIEW_DETAILS[view].label)
                              .join(" · ")}
                          </span>
                          <div>
                            <strong>{item.label}</strong>
                            <span>{item.action}</span>
                          </div>
                          {item.target.aiThreadId && (
                            <button type="button" onClick={() => onOpenAiThread(item.target.aiThreadId!)}>
                              查看审核对话
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {currentTask.status === "in_review" && (
                  <section
                    className="issue-review-result"
                    data-expanded={deliveryReviewOpen}
                    id="task-delivery-review"
                    aria-label="开发结果待验收"
                  >
                    <header>
                      <div className="issue-review-summary">
                        <strong>开发结果待验收</strong>
                        <span>{deliveryComment
                          ? `由 ${deliveryComment.authorName} 提交于 ${relativeTime(deliveryComment.createdAt)}`
                          : "尚未找到交付说明"}</span>
                        {deliveryAcceptanceCount > 0 && (
                          <span className="issue-review-count">{deliveryAcceptanceCount} 个验收项</span>
                        )}
                      </div>
                      <div className="issue-review-actions">
                        {deliveryComment?.threadId && (
                          <button type="button" onClick={() => onOpenThread(deliveryComment.threadId!)}>
                            打开交付对话
                          </button>
                        )}
                        <button
                          className="issue-review-toggle"
                          type="button"
                          aria-expanded={deliveryReviewOpen}
                          aria-controls="task-delivery-review-content"
                          onClick={() => setDeliveryReviewOpen((current) => !current)}
                        >
                          {deliveryReviewOpen ? "收起" : "展开"}
                          <LinearIcon name="chevronDown" />
                        </button>
                      </div>
                    </header>
                    {deliveryReviewOpen && (
                      <div className="issue-review-content" id="task-delivery-review-content">
                        {commentsLoading ? (
                          <p>正在读取交付结果…</p>
                        ) : deliveryComment ? (
                          <>
                            {hasStructuredDeliveryReview(deliveryComment.body)
                              ? <DeliveryReviewDocument key={deliveryComment.id} value={deliveryComment.body} />
                              : <DescriptionDocument value={deliveryComment.body} />}
                            <DeliveryFiles
                              attachments={deliveryComment.attachments}
                              onPreview={setPreviewAttachment}
                            />
                          </>
                        ) : (
                          <p>此任务处于“审核中”，但没有 Agent 交付评论，需要先核对状态。</p>
                        )}
                      </div>
                    )}
                  </section>
                )}
                <section className="issue-requirement-card" aria-labelledby="task-requirement-heading">
                  <header>
                    <div>
                      <strong id="task-requirement-heading">需求说明</strong>
                      <span>需求背景、目标、范围与验收口径</span>
                    </div>
                    {!archived && (
                      <button
                        type="button"
                        disabled={savingProperty === "description"}
                        onClick={() => {
                          if (editingDescription) descriptionRef.current?.blur();
                          else setEditingDescription(true);
                        }}
                      >
                        {savingProperty === "description" ? "保存中…" : editingDescription ? "完成" : "编辑"}
                      </button>
                    )}
                  </header>
                  <div className="issue-requirement-content">
                    {editingDescription ? (
                      <textarea
                        ref={descriptionRef}
                        className="issue-description-input"
                        rows={1}
                        value={description}
                        aria-label="需求说明"
                        placeholder="补充需求背景、目标、范围与验收标准…"
                        disabled={archived || savingProperty === "description"}
                        onChange={(event) => {
                          setDescription(event.target.value);
                          resizeTextarea(event.currentTarget);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setDescription(currentTask.description);
                            setEditingDescription(false);
                          }
                        }}
                        onBlur={() => {
                          setEditingDescription(false);
                          void saveDescription();
                        }}
                      />
                    ) : (
                      <div
                        className={`issue-description-read${description ? "" : " empty"}`}
                        role="button"
                        tabIndex={0}
                        aria-label="编辑需求说明"
                        onClick={() => { if (!archived) setEditingDescription(true); }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (!archived) setEditingDescription(true);
                          }
                        }}
                      >
                        {description ? <DescriptionDocument value={description} /> : "添加描述…"}
                      </div>
                    )}
                  </div>
                </section>
                {(currentTask.threadId || currentTask.readinessReview?.aiThreadId) && (
                  <div className="issue-conversation-list" id="task-readiness-review" aria-label="处理此议题的对话">
                    {currentTask.readinessReview?.aiThreadId && (
                      <button
                        className={`issue-conversation-link${currentTask.readinessReview.status === "running"
                          ? " is-review-running"
                          : ""}`}
                        type="button"
                        title={`打开${currentTask.readinessReview.aiReasoningEffort === "max"
                          ? "父任务 planner 派发审核"
                          : "需求审核"}对话`}
                        onClick={() => onOpenAiThread(currentTask.readinessReview!.aiThreadId!)}
                      >
                        {currentTask.readinessReview.status === "running" ? (
                          <>
                            <span className="issue-review-running-icon" aria-hidden="true">
                              <LinearIcon name="conversation" />
                            </span>
                            <span className="issue-review-running-copy">
                              <strong>{currentTask.reworkRound
                                ? `返工审核进行中 · 第 ${currentTask.reworkRound} 轮`
                                : currentTask.readinessReview.aiReasoningEffort === "max"
                                  ? `父任务 planner 派发审核中 · 第 ${currentTask.readinessReview.round} 轮`
                                  : `需求审核进行中 · 第 ${currentTask.readinessReview.round} 轮`}</strong>
                              <span>Planner 正在审核，审核结论尚未生成。当前无需向下查找结论。</span>
                            </span>
                            <span className="issue-review-running-action">
                              打开审核对话
                              <LinearIcon name="chevronRight" />
                            </span>
                          </>
                        ) : (
                          <>
                            <LinearIcon name="conversation" />
                            <strong>{currentTask.readinessReview.aiReasoningEffort === "max"
                              ? "父任务 planner 派发审核"
                              : "需求审核对话"}</strong>
                            <span className="conversation-divider" aria-hidden="true" />
                            <span className="conversation-thread-id">
                              {(currentTask.readinessReview.aiModel ?? "planner").replace(/^gpt-/, "")} · {currentTask.readinessReview.aiReasoningEffort === "max"
                                ? "Max"
                                : "X-High"} · {{
                                awaiting_input: "等待确认",
                                ready: "已通过",
                                failed: "待重试",
                              }[currentTask.readinessReview.status]}
                            </span>
                          </>
                        )}
                      </button>
                    )}
                    {currentTask.threadId && (
                      <ConversationLink threadId={currentTask.threadId} onOpen={onOpenThread} />
                    )}
                  </div>
                )}
              </div>
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              executionOverview={executionOverview}
              executionOverviewLoading={executionOverviewLoading}
              executionOverviewError={executionOverviewError}
              onOpenTask={onOpenTask}
              onOpenAiThread={onOpenAiThread}
              onOpenThread={onOpenThread}
              onRestoreArchivedTask={onRestoreArchivedTask}
              disabled={archived}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />

            <section className="issue-attachments" aria-labelledby="attachments-heading">
              <header className="attachments-heading">
                <div>
                  <h2 id="attachments-heading">附件</h2>
                  <span>{visibleTaskAttachments.length}</span>
                </div>
                <button
                  className="attachment-add-button"
                  type="button"
                  disabled={archived || uploadingAttachments}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <LinearIcon name="attachment" />
                  {uploadingAttachments ? "上传中…" : "添加附件"}
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
                  }}
                />
              </header>

              {attachmentsLoading ? (
                <div className="attachments-loading" aria-label="正在加载附件" aria-busy="true"><i /><i /></div>
              ) : visibleTaskAttachments.length > 0 ? (
                <ul className="attachment-list">
                  {visibleTaskAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="attachment-link"
                        href={attachmentContentUrl(attachment)}
                        target="_blank"
                        rel="noreferrer"
                        title={`打开 ${attachment.filename}`}
                        onClick={(event) => {
                          event.preventDefault();
                          setPreviewAttachment(attachment);
                        }}
                      >
                        <span className="attachment-file-icon" aria-hidden="true">
                          <LinearIcon name="file" />
                        </span>
                        <span className="attachment-copy">
                          <strong>{attachment.filename}</strong>
                          <span>{fileSize(attachment.size)} · {relativeTime(attachment.createdAt)}</span>
                        </span>
                      </a>
                      <div className="attachment-actions">
                        <a
                          href={attachmentContentUrl(attachment)}
                          download={attachment.filename}
                          aria-label={`下载 ${attachment.filename}`}
                          title="下载附件"
                        >
                          <LinearIcon name="openExternal" />
                        </a>
                        <button
                          type="button"
                          aria-label={`删除 ${attachment.filename}`}
                          title="删除附件"
                          disabled={archived}
                          onClick={() => setPendingAttachmentDelete(attachment)}
                        >
                          <LinearIcon name="trash" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="attachments-empty">添加图片、文档或其他文件，单个文件不超过 25 MB。</p>
              )}
              {attachmentsError && <div className="attachments-error" role="alert">{attachmentsError}</div>}
            </section>

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">经历日志</h2>
                <span>{comments.length + 1}</span>
              </header>

              <div className="experience-current-stage">
                <span className="experience-stage-kicker">
                  当前阶段
                  {currentTask.reworkRound && <b className="rework-round-chip">↩ 返工 #{currentTask.reworkRound}</b>}
                </span>
                <div>
                  <strong>{experienceStage.label}</strong>
                  <span>当前负责人：{experienceStage.owner}</span>
                </div>
                <p>{experienceStage.action}</p>
                {currentTask.readinessReview?.aiThreadId && (
                  <button
                    type="button"
                    onClick={() => onOpenAiThread(currentTask.readinessReview!.aiThreadId!)}
                  >
                    <LinearIcon name="conversation" />
                    打开需求审核对话
                  </button>
                )}
              </div>

              <div className="activity-stream experience-timeline">
                <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
                  <ActorAvatar
                    className="comment-avatar"
                    actor={{
                      type: currentTask.creatorType,
                      id: currentTask.creatorId,
                      name: currentTask.creatorName,
                      avatarUrl: currentTask.creatorAvatarUrl,
                    }}
                  />
                  <p>
                    <strong>{currentTask.creatorName}</strong>
                    <span className="actor-id">@{currentTask.creatorId}</span>
                    创建了此议题
                    <time title={exactTime(currentTask.createdAt)}>{relativeTime(currentTask.createdAt)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label="正在加载评论" aria-busy="true"><i /><i /></div>
                ) : comments.map((comment) => (
                  <article
                    className={`comment-entry is-${comment.authorType} intent-${comment.intent}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
                    <span className="experience-marker" aria-hidden="true">
                      <LinearIcon name={comment.reworkRound
                        ? "refresh"
                        : comment.intent === "discussion"
                        ? "conversation"
                        : comment.intent === "resume"
                          ? "play"
                          : "write"} />
                    </span>
                    <div className="comment-card">
                      <header className="comment-header">
                        <ActorAvatar
                          className="comment-avatar"
                          actor={{
                            type: comment.authorType,
                            id: comment.authorId,
                            name: comment.authorName,
                            avatarUrl: comment.authorAvatarUrl,
                          }}
                        />
                        <strong>{comment.authorName}</strong>
                        <span className="actor-id">@{comment.authorId}</span>
                        <time title={exactTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>
                        {comment.version > 1 && (
                          <span className="comment-edited" title={`编辑于 ${exactTime(comment.updatedAt)}`}>已编辑</span>
                        )}
                        {comment.authorType === "user" && (
                          <span className={`comment-intent-badge${comment.reworkRound ? " is-rework" : ` is-${comment.intent}`}`}>
                            {commentActionLabel(comment)}
                          </span>
                        )}
                        <div className="comment-actions" data-comment-menu-root={comment.id}>
                          <button
                            type="button"
                            className="comment-menu-trigger"
                            aria-label="评论操作"
                            aria-haspopup="menu"
                            aria-expanded={activeMenuId === comment.id}
                            disabled={archived}
                            onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                          >
                            <LinearIcon name="more" />
                          </button>
                          {activeMenuId === comment.id && (
                            <div className="comment-action-menu" role="menu">
                              <button type="button" role="menuitem" disabled={archived} onClick={() => beginEdit(comment)}>
                                <LinearIcon name="write" />
                                编辑评论
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                disabled={archived}
                                onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                              >
                                <LinearIcon name="trash" />
                                删除评论
                              </button>
                            </div>
                          )}
                        </div>
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <textarea
                            className="comment-input"
                            autoFocus
                            value={editingBody}
                            rows={3}
                            aria-label="编辑评论"
                            disabled={archived}
                            onChange={(event) => setEditingBody(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setEditingId(null);
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div>
                            <button className="button secondary" type="button" onClick={() => setEditingId(null)}>取消</button>
                            <button
                              className="button primary"
                              type="button"
                              disabled={archived || !editingBody.trim() || savingCommentId === comment.id}
                              onClick={() => void saveComment(comment)}
                            >
                              {savingCommentId === comment.id ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        comment.body && (
                          <div className="comment-body">
                            <DescriptionDocument value={activityCommentBody(
                              comment,
                              rawDeliveryComment?.id === comment.id,
                            )} />
                          </div>
                        )
                      )}
                      {isDeliveryReviewComment(comment) && currentTask.status === "in_review" && (
                        <div className="comment-rework-action">
                          <button
                            className="button secondary"
                            type="button"
                            disabled={archived || submitting || !localAiChatAvailable}
                            title={localAiChatAvailable
                              ? "采纳这份 Sol 复核结论，回到待开发并启动返工审核"
                              : "本地 AI 审核不可用"}
                            onClick={() => void submitComment("resume", {
                              body: [
                                "采纳以下 AI 交付复核结论并发起返工：",
                                "",
                                comment.body.replace(/^## 交付重新审核\s*/u, "").trim(),
                              ].join("\n"),
                              sourceAiThreadId: comment.aiThreadId ?? undefined,
                              preserveComposer: true,
                            })}
                          >
                            {submittingIntent === "resume" ? "处理中…" : "采纳意见并发起返工"}
                          </button>
                        </div>
                      )}
                      {comment.attachments.some(
                        (attachment) => !comment.body.includes(attachmentContentUrl(attachment)),
                      ) && (
                        <ul className="comment-attachment-list" aria-label="评论附件">
                          {comment.attachments
                            .filter((attachment) => !comment.body.includes(attachmentContentUrl(attachment)))
                            .map((attachment) => (
                              <li key={attachment.id}>
                                <a
                                  href={attachmentContentUrl(attachment)}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={`打开 ${attachment.filename}`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    setPreviewAttachment(attachment);
                                  }}
                                >
                                  <span className="attachment-file-icon" aria-hidden="true">
                                    <LinearIcon name="file" />
                                  </span>
                                  <span><strong>{attachment.filename}</strong><small>{fileSize(attachment.size)}</small></span>
                                </a>
                                <button
                                  type="button"
                                  aria-label={`删除 ${attachment.filename}`}
                                  title="删除附件"
                                  disabled={archived}
                                  onClick={() => setPendingAttachmentDelete(attachment)}
                                >
                                  <LinearIcon name="trash" />
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                      {comment.threadId && (
                        <div className="comment-conversation-link">
                          <ConversationLink threadId={comment.threadId} onOpen={onOpenThread} />
                        </div>
                      )}
                      {comment.intent === "discussion" && (
                        <div className="comment-conversation-link">
                          {comment.aiThreadId ? (
                            <button
                              className="issue-conversation-link"
                              type="button"
                              title="打开这条评论创建的 Sol 独立讨论"
                              onClick={() => onOpenAiThread(comment.aiThreadId!)}
                            >
                              <LinearIcon name="conversation" />
                              <strong>打开 Sol 独立讨论</strong>
                              <span className="conversation-divider" aria-hidden="true" />
                              <span className="conversation-thread-id">Sol · X-High · 只读</span>
                            </button>
                          ) : (
                            <span className="discussion-binding-pending">Sol 讨论尚未成功创建</span>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {commentsError && <div className="comments-error" role="alert">{commentsError}</div>}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment("comment"); }}>
                <div className="composer-author">
                  <ActorAvatar
                    className="comment-avatar"
                    actor={currentUser}
                  />
                  <strong>{currentUser.name}</strong>
                  <span className="actor-id">@{currentUser.id}</span>
                </div>
                <InlineMediaComposer
                  ref={composerRef}
                  className="comment-inline-media"
                  segments={commentSegments}
                  placeholder="留下评论…"
                  ariaLabel="留下评论"
                  onChange={setCommentSegments}
                  onError={setCommentsError}
                  onKeyDown={handleSubmitShortcut}
                  disabled={archived}
                />
                <PendingAttachments
                  files={pendingCommentFiles}
                  disabled={archived || submitting}
                  uploadLabel="发布后上传"
                  ariaLabel="待上传评论附件"
                  className="comment-composer-files"
                  onRemove={(index) => setPendingCommentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                />
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={archived || submitting}
                      aria-label="添加评论附件"
                      title="添加附件"
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <LinearIcon name="attachment" />
                    </button>
                    <span>草稿会自动保存</span>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) stageCommentFiles(event.currentTarget.files);
                      }}
                    />
                  </div>
                  <div className="comment-action-buttons">
                    <kbd>⌘ Enter</kbd>
                    <button
                      className="button secondary comment-action-plain"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && pendingCommentFiles.length === 0
                        && commentInlineImages.length === 0
                      ) || archived || submitting}
                    >
                      {submittingIntent === "comment" ? "发布中…" : "仅发布"}
                    </button>
                    <button
                      className="button secondary comment-action-resume"
                      type="button"
                      title={canContinueStage ? continueActionLabel : "当前阶段不需要手动继续"}
                      disabled={(
                        !draft.trim()
                        && pendingCommentFiles.length === 0
                        && commentInlineImages.length === 0
                      ) || archived || submitting || !canContinueStage}
                      onClick={() => void submitComment("resume")}
                    >
                      {submittingIntent === "resume" ? "处理中…" : continueActionLabel}
                    </button>
                    <button
                      className="button primary comment-action-discussion"
                      type="button"
                      title={localAiChatAvailable
                        ? currentTask.status === "in_review"
                          ? "使用 Sol X-High 只读复核交付并更新验收说明，任务保持审核中"
                          : "创建独立的 Sol X-High 只读对话，不改变任务状态"
                        : "本地 AI 对话不可用"}
                      disabled={(
                        !draft.trim()
                        && pendingCommentFiles.length === 0
                        && commentInlineImages.length === 0
                      ) || archived || submitting || !localAiChatAvailable}
                      onClick={() => void submitComment("discussion")}
                    >
                      {submittingIntent === "discussion"
                        ? "创建中…"
                        : currentTask.status === "in_review"
                          ? "发布并重新审核"
                          : "新开 Sol 对话"}
                    </button>
                  </div>
                </footer>
                <p className="comment-action-note">
                  {currentTask.status === "in_review"
                    ? localAiChatAvailable
                      ? "重新审核只读复核现有交付并保持交付验收；提交返工会先回到待开发，审核通过后才启动开发 worker。"
                      : "当前环境没有本地 AI 审核能力，只能发布普通评论。"
                    : "仅发布只记录评论；继续当前阶段会推进当前审核或开发；新开 Sol 对话不改变任务状态。"}
                </p>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label="议题属性">
            <nav
              className="detail-queue-navigation"
              aria-label={`${queueNavigation.label}详情导航`}
            >
              <button
                type="button"
                disabled={!queueNavigation.previousTask}
                title={queueNavigation.previousTask
                  ? `打开上一条${queueNavigation.label}：${queueNavigation.previousTask.identifier}`
                  : `已是第一条${queueNavigation.label}`}
                onClick={() => {
                  if (queueNavigation.previousTask) onNavigateQueue(queueNavigation.previousTask);
                }}
              >
                <LinearIcon name="chevronLeft" />
                <span>{queueNavigation.previousTask
                  ? `上一条${queueNavigation.label}`
                  : "已是第一条"}</span>
              </button>
              <button
                type="button"
                disabled={!queueNavigation.nextTask}
                title={queueNavigation.nextTask
                  ? `打开下一条${queueNavigation.label}：${queueNavigation.nextTask.identifier}`
                  : `已是最后一条${queueNavigation.label}`}
                onClick={() => {
                  if (queueNavigation.nextTask) onNavigateQueue(queueNavigation.nextTask);
                }}
              >
                <span>{queueNavigation.nextTask
                  ? `下一条${queueNavigation.label}`
                  : "已是最后一条"}</span>
                <LinearIcon name="chevronRight" />
              </button>
            </nav>
            <button
              className="detail-open-thread-action"
              type="button"
              disabled={archived || openingThread}
              onClick={() => onOpenInThread(currentTask)}
            >
              <LinearIcon name="conversation" />
              <span>{openingThread ? "正在打开…" : "在对话中打开"}</span>
            </button>
            <div className="detail-search" role="search" aria-label="搜索当前任务详情">
              <LinearIcon name="search" />
              <input
                type="search"
                value={detailSearch}
                placeholder="搜索当前详情…"
                aria-label="搜索当前详情"
                title="Enter 下一个，Shift + Enter 上一个"
                onChange={(event) => setDetailSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    moveDetailSearch(event.shiftKey ? -1 : 1);
                  }
                  if (event.key === "Escape") {
                    setDetailSearch("");
                    event.currentTarget.focus();
                  }
                }}
              />
              {detailSearch && (
                <>
                  <span className="detail-search-count" role="status">
                    {detailSearchMatches.length > 0
                      ? `${activeDetailSearchIndex + 1}/${detailSearchMatches.length}`
                      : "无结果"}
                  </span>
                  <button
                    className="detail-search-previous"
                    type="button"
                    aria-label="上一个搜索结果"
                    title="上一个结果（Shift + Enter）"
                    disabled={detailSearchMatches.length === 0}
                    onClick={() => moveDetailSearch(-1)}
                  >
                    <LinearIcon name="chevronDown" />
                  </button>
                  <button
                    type="button"
                    aria-label="下一个搜索结果"
                    title="下一个结果（Enter）"
                    disabled={detailSearchMatches.length === 0}
                    onClick={() => moveDetailSearch(1)}
                  >
                    <LinearIcon name="chevronDown" />
                  </button>
                  <button
                    type="button"
                    aria-label="清除详情搜索"
                    title="清除搜索"
                    onClick={() => setDetailSearch("")}
                  >
                    <LinearIcon name="close" />
                  </button>
                </>
              )}
            </div>
            <h2>属性</h2>
            <button
              className="detail-property-row detail-property-action"
              type="button"
              disabled={archived}
              onClick={() => onReassign(currentTask)}
            >
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="project" />
              </span>
              <span className="detail-property-label">项目</span>
              <span>切换项目…</span>
            </button>
            <div
              className={`detail-status-flow${statusFlowOpen ? " is-open" : ""}`}
              ref={statusFlowRef}
            >
              <button
                className="detail-status-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={statusFlowOpen}
                disabled={archived || savingProperty === "status"}
                onClick={toggleStatusFlow}
              >
                <span className={`detail-property-icon status-icon-${STATUS_DETAILS[currentTask.status].tone}`}>
                  <LinearStatusIcon status={currentTask.status} />
                </span>
                <span className="detail-property-label">状态</span>
                <strong className="detail-status-current">{experienceStage.label}</strong>
                <LinearIcon className="detail-status-chevron" name="chevronDown" />
                <span className="detail-status-meta">
                  <b>当前负责人：{experienceStage.owner}</b>
                  <small>{savingProperty === "status" ? "正在保存阶段变更…" : experienceStage.action}</small>
                </span>
              </button>

              {statusFlowOpen && (
                <>
                  <button
                    className="detail-status-backdrop"
                    type="button"
                    aria-label="关闭阶段选择"
                    onClick={closeStatusFlow}
                  />
                  <section className="detail-status-popover" role="dialog" aria-label="切换任务阶段">
                    <header className="detail-status-popover-header">
                      <span>
                        <strong>切换阶段</strong>
                        <small>允许跨阶段</small>
                      </span>
                      <button type="button" aria-label="关闭阶段选择" onClick={closeStatusFlow}>
                        <LinearIcon name="close" />
                      </button>
                    </header>

                    {[
                      { key: "main", label: "主流程", statuses: MAIN_STATUS_FLOW },
                      { key: "exception", label: "异常与终止", statuses: EXCEPTION_STATUS_FLOW },
                    ].map((group) => (
                      <div className={`detail-status-group is-${group.key}`} key={group.key}>
                        <span className="detail-status-group-label">{group.label}</span>
                        <div className="detail-status-options">
                          {group.statuses.map((status) => {
                            const details = STATUS_FLOW_DETAILS[status];
                            const selected = pendingStatus === status;
                            const current = currentTask.status === status;
                            return (
                              <button
                                className={`detail-status-option${selected ? " is-selected" : ""}${current ? " is-current" : ""}`}
                                type="button"
                                key={status}
                                data-status={status}
                                aria-current={current ? "step" : undefined}
                                aria-pressed={selected}
                                disabled={savingProperty === "status"}
                                onClick={() => setPendingStatus(status)}
                              >
                                <span className={`detail-status-node status-icon-${STATUS_DETAILS[status].tone}`} aria-hidden="true">
                                  <LinearStatusIcon status={status} />
                                </span>
                                <span className="detail-status-option-copy">
                                  <strong>{details.title}</strong>
                                  <small>{details.description}</small>
                                </span>
                                <span className="detail-status-option-marker">
                                  {selected ? <LinearIcon name="check" /> : current ? "当前" : null}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {pendingStage && pendingStatus && (
                      <footer className="detail-status-impact">
                        <strong>
                          {pendingStatus === currentTask.status
                            ? `保持“${pendingStage.title}”`
                            : `从“${STATUS_FLOW_DETAILS[currentTask.status].title}”切换到“${pendingStage.title}”`}
                        </strong>
                        <span>
                          {pendingStatus === currentTask.status
                            ? "当前已经处于该阶段，不会产生数据变更。"
                            : statusFlowImpact(currentTask, pendingStatus)}
                        </span>
                        <div>
                          <button
                            type="button"
                            disabled={savingProperty === "status"}
                            onClick={() => setPendingStatus(null)}
                          >
                            取消
                          </button>
                          <button
                            className="primary"
                            type="button"
                            disabled={savingProperty === "status"}
                            onClick={() => void confirmStatusChange()}
                          >
                            {savingProperty === "status"
                              ? "保存中…"
                              : pendingStatus === currentTask.status
                                ? "保持当前阶段"
                                : "确认切换"}
                          </button>
                        </div>
                      </footer>
                    )}
                  </section>
                </>
              )}
            </div>
            <label className="detail-property-row">
              <span className="detail-property-icon"><LinearPriorityIcon priority={currentTask.priority} /></span>
              <span className="detail-property-label">优先级</span>
              <select
                value={currentTask.priority}
                disabled={archived || savingProperty === "priority"}
                onChange={(event) => void saveTask({ priority: event.target.value as TaskPriority }, "priority")}
              >
                {(Object.keys(PRIORITY_DETAILS) as TaskPriority[]).map((priority) => (
                  <option value={priority} key={priority}>{PRIORITY_DETAILS[priority].label}</option>
                ))}
              </select>
            </label>
            <label className="detail-property-row assignee-property">
              <ActorAvatar actor={currentTask.assignee} className="detail-assignee-avatar" />
              <span className="detail-property-label">负责人</span>
              <select
                aria-label="负责人"
                value={actorKey(currentTask.assignee)}
                disabled={archived || savingProperty === "assignee"}
                onChange={(event) => {
                  const selected = assigneeOptions.find((actor) => actorKey(actor) === event.target.value);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget: assigneeTarget }, "assignee");
                }}
              >
                {assigneeOptions.map((actor) => (
                  <option value={actorKey(actor)} key={actorKey(actor)}>
                    {actor.id === currentUser.id ? `${actor.name}（我）` : actor.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="label" />
              </span>
              <span className="detail-property-label">标签</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={labelMenuOpen}
                disabled={archived || savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                placeholder="添加标签…"
                onOpenChange={setLabelMenuOpen}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
              />
            </div>
            <label className="detail-property-row workflow-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="dashboard" />
              </span>
              <span className="detail-property-label">工作流</span>
              <select
                value={currentTask.workflowId ?? ""}
                disabled={archived || savingProperty === "workflowId"}
                onChange={(event) => void saveTask({
                  workflowId: event.target.value || null,
                }, "workflowId")}
              >
                <option value="">未绑定</option>
                {!workflowAvailable && currentTask.workflowId && (
                  <option value={currentTask.workflowId}>当前设备未找到此流程</option>
                )}
                {workflows.map((workflow) => (
                  <option value={workflow.id} key={workflow.id}>{workflow.name}</option>
                ))}
              </select>
            </label>
            <label className="detail-property-row development-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="branch" />
              </span>
              <span className="detail-property-label">开发上下文</span>
              <select
                value={contextValue(currentTask.developmentContext)}
                disabled={archived || developmentScanLoading || savingProperty === "developmentContext"}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onChange={(event) => void saveTask({
                  developmentContext: event.target.value ? JSON.parse(event.target.value) as DevelopmentContext : null,
                }, "developmentContext")}
              >
                <option value="">{developmentScanLoading ? "正在扫描 Git…" : "未绑定"}</option>
                <optgroup label="代码分支">
                  {developmentOptions.filter((context) => context.type === "branch").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>
                  ))}
                </optgroup>
                <optgroup label="Worktree">
                  {developmentOptions.filter((context) => context.type === "worktree").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">截止日期</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={archived || savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value ? {} : { recurrence: null }),
                }, "dueDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="recurrence" /></span>
              <span className="detail-property-label">重复</span>
              <select
                value={currentTask.recurrence?.unit ?? ""}
                disabled={archived || !currentTask.dueDate || savingProperty === "recurrence"}
                onChange={(event) => void saveTask({
                  recurrence: event.target.value
                    ? { interval: 1, unit: event.target.value as Recurrence["unit"] }
                    : null,
                }, "recurrence")}
              >
                <option value="">不重复</option>
                <option value="day">每天</option>
                <option value="week">每周</option>
                <option value="month">每月</option>
                <option value="year">每年</option>
              </select>
            </label>
            <IssueRelationSidebar
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
              disabled={archived}
            />
            <div className="detail-timestamps">
              <span>创建于 {exactTime(currentTask.createdAt)}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>更新于 {exactTime(currentTask.updatedAt)}</span>}
            </div>
          </aside>
        </div>
      </div>

      {previewAttachment && (
        <AttachmentPreview
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">删除这条评论？</h2>
            <p>此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={archived || deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除评论"}</button>
            </div>
          </div>
        </div>
      )}

      {pendingAttachmentDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deletingAttachment) setPendingAttachmentDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-attachment-title">
            <h2 id="delete-attachment-title">删除这个附件？</h2>
            <p>“{pendingAttachmentDelete.filename}” 将被永久删除，此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deletingAttachment} onClick={() => setPendingAttachmentDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={archived || deletingAttachment} onClick={() => void confirmAttachmentDelete()}>{deletingAttachment ? "删除中…" : "删除附件"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
