import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  attachmentContentUrl,
  createComment,
  deleteAttachment,
  deleteComment,
  listAttachments,
  listComments,
  listTaskActivities,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import { TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  Attachment,
  Comment,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationType,
  Recurrence,
  Task,
  TaskChangeActivity,
  TaskDraft,
  TaskPriority,
  TaskRelationSummary,
  TaskStatus,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { TaskboardIcon } from "./TaskboardIcon";
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
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { buildIssueUrl } from "../issueRoute";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";

const PRIORITY_DETAILS: Record<TaskPriority, { label: string; bars: number }> = {
  none: { label: "无优先级", bars: 0 },
  urgent: { label: "紧急", bars: 3 },
  high: { label: "高", bars: 3 },
  medium: { label: "中", bars: 2 },
  low: { label: "低", bars: 1 },
};

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
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
  onOpenInThread: (task: Task) => void;
  onCopy: (text: string, announcement: string) => void;
  openingThread: boolean;
  onError: (message: string | null) => void;
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

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  projectId: "项目",
  title: "标题",
  description: "描述",
  status: "状态",
  priority: "优先级",
  labels: "标签",
  assignee: "负责人",
  workflowId: "工作流",
  developmentContext: "开发上下文",
  startDate: "开始日期",
  dueDate: "截止日期",
  recurrence: "重复",
  archivedAt: "归档状态",
  relation: "关系",
};

const RELATION_LABELS: Record<IssueRelationType, string> = {
  parent: "父议题",
  blocks: "阻塞",
  blocked_by: "阻塞于",
  related: "相关议题",
};

function activityValue(field: string, value: unknown): string {
  if (field === "archivedAt") {
    return typeof value === "string" ? `已归档（${exactTime(value)}）` : "未归档";
  }
  if (value === null || value === "") return "未设置";
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return STATUS_DETAILS[value as TaskStatus].label;
  }
  if (field === "priority" && typeof value === "string" && value in PRIORITY_DETAILS) {
    return PRIORITY_DETAILS[value as TaskPriority].label;
  }
  if (field === "labels" && Array.isArray(value)) {
    return value.length > 0 ? value.join("、") : "无标签";
  }
  if (field === "assignee" && typeof value === "object") {
    const actor = value as ActorIdentity;
    return `${actor.name} @${actor.id}`;
  }
  if (field === "developmentContext" && typeof value === "object") {
    const context = value as { type: string; branch?: string | null; path?: string | null };
    if (context.type === "branch") return context.branch ?? "未设置";
    const folder = context.path?.split(/[\\/]/).filter(Boolean).at(-1);
    return `${context.branch ?? "detached"}${folder ? ` · ${folder}` : ""}`;
  }
  if (field === "recurrence" && typeof value === "object") {
    const recurrence = value as Recurrence;
    const units: Record<Recurrence["unit"], string> = {
      day: "天",
      week: "周",
      month: "月",
      year: "年",
    };
    return recurrence.interval === 1
      ? `每${units[recurrence.unit]}`
      : `每 ${recurrence.interval} ${units[recurrence.unit]}`;
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as { type: IssueRelationType; identifier: string; title: string };
    return `${RELATION_LABELS[relation.type]} ${relation.identifier} · ${relation.title}`;
  }
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ActivityChangeIcon({ field, before, after }: {
  field: string;
  before: unknown;
  after: unknown;
}) {
  const value = after ?? before;
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return <StatusIcon status={value as TaskStatus} />;
  }
  if (field === "priority" && typeof value === "string" && value in PRIORITY_DETAILS) {
    return <LinearPriorityIcon priority={value as TaskPriority} />;
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as { type?: IssueRelationType };
    if (relation.type === "blocked_by") return <TaskboardIcon name="relationBlockedBy" />;
    if (relation.type === "blocks") return <TaskboardIcon name="relationBlocks" />;
    return <LinearIcon name="link" />;
  }
  if (field === "projectId" || field === "workflowId") return <LinearIcon name="project" />;
  if (field === "labels") return <LinearIcon name="label" />;
  if (field === "assignee") return <LinearIcon name="myIssues" />;
  if (field === "developmentContext") return <LinearIcon name="branch" />;
  if (field === "startDate" || field === "dueDate") return <LinearIcon name="calendar" />;
  if (field === "recurrence") return <LinearIcon name="recurrence" />;
  if (field === "archivedAt") return <LinearIcon name="trash" />;
  return <LinearIcon name="write" />;
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
      <TaskboardIcon name="conversation" />
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
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  onUpdate,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenInThread,
  onCopy,
  openingThread,
  onError,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(task.description),
  );
  const [editingDescription, setEditingDescription] = useState(false);
  const [propertyMenu, setPropertyMenu] = useState<"status" | "priority" | "assignee" | "labels" | null>(null);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState<Attachment | null>(null);
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [taskActivities, setTaskActivities] = useState<TaskChangeActivity[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      window.localStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
    ),
  );
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);

  useEffect(() => {
    const taskChanged = currentTask.id !== task.id;
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (taskChanged || !editingDescription) {
      setDescription(task.description);
      setDescriptionSegments(createInlineMediaSegments(task.description));
    }
    if (taskChanged) setEditingDescription(false);
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
  }, [title]);

  useEffect(() => {
    if (!editingDescription) return;
    requestAnimationFrame(() => {
      descriptionComposerRef.current?.focus();
    });
  }, [editingDescription]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsLoading(true);
    setCommentsError(null);
    void Promise.all([
      listComments(task.id, controller.signal),
      listTaskActivities(task.id, controller.signal),
    ]).then(
      ([nextComments, nextActivities]) => {
        setComments(nextComments);
        setTaskActivities(nextActivities);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.activityKey, task.id]);

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
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
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

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
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
    if (savingProperty === "description") return;
    const draftDescription = serializeInlineMedia(descriptionSegments).trim();
    const inlineImages = inlineMediaImages(descriptionSegments);
    if (draftDescription === currentTask.description && inlineImages.length === 0) {
      setEditingDescription(false);
      return;
    }

    setSavingProperty("description");
    onError(null);
    try {
      const uploaded = await Promise.all(
        inlineImages.map((image) => uploadAttachment(currentTask.id, image.file)),
      );
      const resolvedDescription = resolveInlineMediaMarkdown(
        draftDescription,
        inlineImages,
        uploaded,
      ).trim();
      const saved = await onUpdate(currentTask, { description: resolvedDescription });
      setCurrentTask(saved);
      setDescription(saved.description);
      setDescriptionSegments(createInlineMediaSegments(saved.description));
      setAttachments((current) => [
        ...current,
        ...uploaded.filter((attachment) => !current.some((item) => item.id === attachment.id)),
      ]);
      setEditingDescription(false);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && pendingCommentFiles.length === 0 && commentInlineImages.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [results, inlineAttachments] = await Promise.all([
        Promise.allSettled(
          pendingCommentFiles.map((file) => uploadCommentAttachment(comment.id, file)),
        ),
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file)),
        ),
      ]);
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const nextComment = commentInlineImages.length > 0
        ? await updateComment(
            comment,
            resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
          )
        : { ...comment, attachments: [...comment.attachments, ...uploaded] };
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      setPendingCommentFiles([]);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      const failed = results.length - uploaded.length;
      if (failed > 0) setCommentsError(`评论已发布，但有 ${failed} 个附件上传失败。`);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function stageCommentFiles(files: FileList | File[]) {
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
      void submitComment();
    }
  }

  function beginEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditingBody(comment.body);
    setActiveMenuId(null);
  }

  async function saveComment(comment: Comment) {
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
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  async function uploadFiles(files: FileList) {
    const selected = Array.from(files);
    if (selected.length === 0 || uploadingAttachments) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }

    setUploadingAttachments(true);
    setAttachmentsError(null);
    try {
      for (const file of selected) {
        const attachment = await uploadAttachment(task.id, file);
        setAttachments((current) => current.some((item) => item.id === attachment.id)
          ? current
          : [...current, attachment]);
      }
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function confirmAttachmentDelete() {
    if (!pendingAttachmentDelete || deletingAttachment) return;
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
  const activityTimeline = [
    ...taskActivities.flatMap((activity) => activity.changes.map((change, index) => ({
      kind: "change" as const,
      id: `${activity.id}-${index}`,
      createdAt: activity.createdAt,
      activity,
      change,
    }))),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      id: comment.id,
      createdAt: comment.createdAt,
      comment,
    })),
  ].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));

  return (
    <section className="issue-detail" aria-label={`${task.identifier} 议题详情`}>
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label="议题内容">
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label="议题标题"
                  disabled={savingProperty === "title"}
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
                />
                {editingDescription ? (
                  <div
                    className="issue-description-composer"
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      void saveDescription();
                    }}
                  >
                    <InlineMediaComposer
                      ref={descriptionComposerRef}
                      segments={descriptionSegments}
                      placeholder="添加描述…"
                      ariaLabel="议题描述"
                      disabled={savingProperty === "description"}
                      onChange={setDescriptionSegments}
                      onError={onError}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setDescriptionSegments(createInlineMediaSegments(currentTask.description));
                          setEditingDescription(false);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label="编辑议题描述"
                    onClick={() => {
                      setDescriptionSegments(createInlineMediaSegments(description));
                      setEditingDescription(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setDescriptionSegments(createInlineMediaSegments(description));
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description ? <DescriptionDocument value={description} /> : "添加描述…"}
                  </div>
                )}
                {currentTask.threadId && (
                  <div className="issue-conversation-list" aria-label="处理此议题的对话">
                    <ConversationLink threadId={currentTask.threadId} onOpen={onOpenThread} />
                  </div>
                )}
              </div>
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
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
                  disabled={uploadingAttachments}
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
                <h2 id="activity-heading">活动</h2>
                <span>{activityTimeline.length}</span>
              </header>

              <div className="activity-stream">
                <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
                  <span className="activity-rail-icon activity-creator-icon" aria-hidden="true">
                    <ActorAvatar
                      className="comment-avatar"
                      actor={{
                        type: currentTask.creatorType,
                        id: currentTask.creatorId,
                        name: currentTask.creatorName,
                        avatarUrl: currentTask.creatorAvatarUrl,
                      }}
                    />
                  </span>
                  <p>
                    <strong>{currentTask.creatorName}</strong>
                    {" "}创建了此议题
                    <time title={exactTime(currentTask.createdAt)}>{relativeTime(currentTask.createdAt)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label="正在加载活动" aria-busy="true"><i /><i /></div>
                ) : activityTimeline.map((item) => {
                  if (item.kind === "change") {
                    const { activity, change } = item;
                    return (
                      <article
                        className={`activity-entry activity-change is-${activity.actorType}`}
                        key={item.id}
                      >
                        <span className="activity-rail-icon" aria-hidden="true">
                          <ActivityChangeIcon
                            field={change.field}
                            before={change.before}
                            after={change.after}
                          />
                        </span>
                        <p>
                          <strong>{activity.actorName}</strong>
                          {" "}
                          {change.field === "description" ? (
                            <>更新了描述</>
                          ) : change.field === "relation" && change.before === null ? (
                            <>添加了 <span className="activity-change-value">{activityValue(change.field, change.after)}</span></>
                          ) : change.field === "relation" && change.after === null ? (
                            <>移除了 <span className="activity-change-value">{activityValue(change.field, change.before)}</span></>
                          ) : (
                            <>
                              将{ACTIVITY_FIELD_LABELS[change.field] ?? change.field}从
                              <span className="activity-change-value">{activityValue(change.field, change.before)}</span>
                              改为
                              <span className="activity-change-value">{activityValue(change.field, change.after)}</span>
                            </>
                          )}
                          <time title={exactTime(activity.createdAt)}>{relativeTime(activity.createdAt)}</time>
                        </p>
                      </article>
                    );
                  }
                  const comment = item.comment;
                  return (
                  <article
                    className={`comment-entry is-${comment.authorType}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
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
                        <div className="comment-actions" data-comment-menu-root={comment.id}>
                          <button
                            type="button"
                            className="comment-menu-trigger"
                            aria-label="评论操作"
                            aria-haspopup="menu"
                            aria-expanded={activeMenuId === comment.id}
                            onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                          >
                            <LinearIcon name="more" />
                          </button>
                          {activeMenuId === comment.id && (
                            <div className="comment-action-menu" role="menu">
                              <button type="button" role="menuitem" onClick={() => beginEdit(comment)}>
                                <LinearIcon name="write" />
                                编辑评论
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
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
                          <div className="inline-media-composer comment-inline-media">
                            <textarea
                              ref={resizeTextarea}
                              autoFocus
                              value={editingBody}
                              rows={1}
                              aria-label="编辑评论"
                              onChange={(event) => {
                                setEditingBody(event.target.value);
                                resizeTextarea(event.currentTarget);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") setEditingId(null);
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                  event.preventDefault();
                                  void saveComment(comment);
                                }
                              }}
                            />
                          </div>
                          <div className="comment-edit-actions">
                            <button className="button secondary" type="button" onClick={() => setEditingId(null)}>取消</button>
                            <button
                              className="button primary"
                              type="button"
                              disabled={!editingBody.trim() || savingCommentId === comment.id}
                              onClick={() => void saveComment(comment)}
                            >
                              {savingCommentId === comment.id ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        comment.body && <div className="comment-body"><DescriptionDocument value={comment.body} /></div>
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
                    </div>
                  </article>
                  );
                })}
              </div>

              {commentsError && <div className="comments-error" role="alert">{commentsError}</div>}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
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
                />
                <PendingAttachments
                  files={pendingCommentFiles}
                  disabled={submitting}
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
                      disabled={submitting}
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
                  <div>
                    <kbd>⌘ Enter</kbd>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && pendingCommentFiles.length === 0
                        && commentInlineImages.length === 0
                      ) || submitting}
                    >
                      {submitting ? "发布中…" : "评论"}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label="议题属性">
            <div className="detail-primary-actions">
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                onClick={() => onOpenInThread(currentTask)}
              >
                <ActorAvatar actor={CODEX_AGENT_ACTOR} className="detail-thread-avatar" />
                <span>{openingThread ? "正在打开…" : "在对话中打开"}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                title={`复制议题 ID ${currentTask.identifier}`}
                onClick={() => onCopy(currentTask.identifier, `${currentTask.identifier} 已复制。`)}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">复制 ID</span>
                <span className="detail-copy-identifier">{currentTask.identifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(
                    window.location.href,
                    currentTask.projectId,
                    currentTask.identifier,
                  ).href,
                  "议题链接已复制。",
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">复制链接</span>
              </button>
            </div>
            <h2>属性</h2>
            <div className="detail-property-row">
              <span className="detail-property-label">状态</span>
              <TaskPropertyPicker
                value={currentTask.status}
                options={TASK_STATUSES.map((status) => ({
                  value: status,
                  label: STATUS_DETAILS[status].label,
                  icon: <StatusIcon status={status} />,
                  className: `status-icon-${STATUS_DETAILS[status].tone}`,
                }))}
                open={propertyMenu === "status"}
                disabled={savingProperty === "status"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel="状态"
                onOpenChange={(open) => setPropertyMenu(open ? "status" : null)}
                onChange={(status) => void saveTask({ status }, "status")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">优先级</span>
              <TaskPropertyPicker
                value={currentTask.priority}
                options={(Object.keys(PRIORITY_DETAILS) as TaskPriority[]).map((priority) => ({
                  value: priority,
                  label: PRIORITY_DETAILS[priority].label,
                  icon: <LinearPriorityIcon priority={priority} />,
                  className: `priority-${priority}`,
                }))}
                open={propertyMenu === "priority"}
                disabled={savingProperty === "priority"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel="优先级"
                onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <span className="detail-property-label">负责人</span>
              <TaskPropertyPicker
                value={actorKey(currentTask.assignee)}
                options={assigneeOptions.map((actor) => ({
                  value: actorKey(actor),
                  label: actor.id === currentUser.id ? `${actor.name}（我）` : actor.name,
                  icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
                }))}
                open={propertyMenu === "assignee"}
                disabled={savingProperty === "assignee"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel="负责人"
                onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
                onChange={(value) => {
                  const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget }, "assignee");
                }}
              />
            </div>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="label" />
              </span>
              <span className="detail-property-label">标签</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={propertyMenu === "labels"}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                showSelectedAsChips
                placeholder="添加标签…"
                onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
              />
            </div>
            <label className="detail-property-row development-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="branch" />
              </span>
              <span className="detail-property-label">开发上下文</span>
              <select
                value={contextValue(currentTask.developmentContext)}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
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
              <span className="detail-property-label">开始日期</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">截止日期</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
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
                disabled={!currentTask.dueDate || savingProperty === "recurrence"}
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
            />
            <div className="detail-timestamps">
              <span>创建于 {exactTime(currentTask.createdAt)}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>更新于 {exactTime(currentTask.updatedAt)}</span>}
            </div>
          </aside>
        </div>
      </div>

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">删除这条评论？</h2>
            <p>此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除评论"}</button>
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
              <button className="button danger" type="button" disabled={deletingAttachment} onClick={() => void confirmAttachmentDelete()}>{deletingAttachment ? "删除中…" : "删除附件"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
