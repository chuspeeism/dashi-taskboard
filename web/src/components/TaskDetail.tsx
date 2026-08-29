import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { taskboardStorage } from "../storage";
import {
  ApiError,
  attachmentDownloadUrl,
  createComment,
  deleteComment,
  getTask,
  listAttachments,
  listComments,
  listTaskActivities,
  resolveTaskboardUrl,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import { TASK_PRIORITIES, TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  Attachment,
  Comment,
  CodexThreadBinding,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationOrigin,
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
import { STATUS_DETAILS } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon } from "./LinearIcon";
import {
  AttachmentIcon,
  BlockingRelationIcon,
  BranchIcon,
  CodexResumeIcon,
  ConversationIcon,
  DeleteIcon,
  DueDateIcon,
  EditIcon,
  LabelIcon,
  MoreIcon,
  NewConversationIcon,
  PriorityIcon,
  ProjectIcon,
  RecurrenceIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaFiles,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineAttachmentMarkdown,
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
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";
import { DescriptionDocument } from "./DescriptionDocument";

type TaskDetailError = string | readonly [string, string];

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  referenceTasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  onCreateLabel: (label: string) => Promise<void>;
  onDeleteLabel: (label: string) => Promise<void>;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (binding: CodexThreadBinding) => void;
  onOpenLegacyLocalThread: (threadId: string) => void;
  onOpenInThread: (task: Task) => void;
  onCopy: (text: string, announcement: string) => void;
  openingThread: boolean;
  onError: (message: TaskDetailError | null) => void;
}

function messageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return ["操作未完成，请重试。", "The action could not be completed. Try again."];
}

function issueMessageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
    return [
      "该议题已在其他位置更新，请刷新后重试。",
      "This issue changed elsewhere. Refresh and try again.",
    ];
  }
  return messageFor(error);
}

function exactTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string, locale: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

async function downloadAttachmentFile(attachment: Attachment) {
  const host = new URL(document.baseURI).searchParams.get("host");
  if (host === "codex" && window.parent !== window) {
    postEmbeddedHostMessage({
      type: "taskboard:open-attachment",
      payload: {
        attachmentId: attachment.id,
        filename: attachment.filename,
      },
    });
    return;
  }

  const response = await fetch(resolveTaskboardUrl(attachmentDownloadUrl(attachment)));
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => ({})));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(
  context: DevelopmentContext,
  text: (chinese: string, english: string) => string,
): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? text("分离 HEAD", "detached")} · ${folder}`;
}

const ACTIVITY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  projectId: ["项目", "project"],
  title: ["标题", "title"],
  description: ["描述", "description"],
  status: ["状态", "status"],
  priority: ["优先级", "priority"],
  labels: ["标签", "labels"],
  assignee: ["负责人", "assignee"],
  developmentContext: ["开发上下文", "development context"],
  startDate: ["开始日期", "start date"],
  dueDate: ["截止日期", "due date"],
  recurrence: ["重复", "recurrence"],
  archivedAt: ["归档状态", "archive status"],
  relation: ["关系", "relation"],
};

const RELATION_LABELS: Record<IssueRelationType, readonly [string, string]> = {
  parent: ["父议题", "Parent issue"],
  blocks: ["阻塞", "Blocks"],
  blocked_by: ["阻塞于", "Blocked by"],
  related: ["相关议题", "Related issue"],
};

function activityValue(
  field: string,
  value: unknown,
  language: TaskboardLanguage,
  locale: string,
  text: (chinese: string, english: string) => string,
): string {
  if (field === "archivedAt") {
    return typeof value === "string"
      ? text(`已归档（${exactTime(value, locale)}）`, `Archived (${exactTime(value, locale)})`)
      : text("未归档", "Not archived");
  }
  if (value === null || value === "") return text("未设置", "Not set");
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return taskStatusLabel(language, value as TaskStatus);
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return taskPriorityLabel(language, value as TaskPriority);
  }
  if (field === "labels" && Array.isArray(value)) {
    return value.length > 0
      ? value.join(language === "zh" ? "、" : ", ")
      : text("无标签", "No labels");
  }
  if (field === "assignee" && typeof value === "object") {
    const actor = value as ActorIdentity;
    return `${actor.name} @${actor.id}`;
  }
  if (field === "developmentContext" && typeof value === "object") {
    const context = value as { type: string; branch?: string | null; path?: string | null };
    if (context.type === "branch") return context.branch ?? text("未设置", "Not set");
    const folder = context.path?.split(/[\\/]/).filter(Boolean).at(-1);
    return `${context.branch ?? text("分离 HEAD", "detached")}${folder ? ` · ${folder}` : ""}`;
  }
  if (field === "recurrence" && typeof value === "object") {
    const recurrence = value as Recurrence;
    const units: Record<Recurrence["unit"], readonly [string, string]> = {
      day: ["天", "day"],
      week: ["周", "week"],
      month: ["月", "month"],
      year: ["年", "year"],
    };
    const [chineseUnit, englishUnit] = units[recurrence.unit];
    return text(
      recurrence.interval === 1 ? `每${chineseUnit}` : `每 ${recurrence.interval} ${chineseUnit}`,
      `Every ${recurrence.interval === 1 ? "" : `${recurrence.interval} `}${englishUnit}${recurrence.interval === 1 ? "" : "s"}`,
    );
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as {
      type: IssueRelationType;
      identifier: string;
      externalKey?: string | null;
      title: string;
    };
    const [chineseLabel, englishLabel] = RELATION_LABELS[relation.type];
    return `${text(chineseLabel, englishLabel)} ${relation.externalKey ?? relation.identifier} · ${relation.title}`;
  }
  if (Array.isArray(value)) return value.join(language === "zh" ? "、" : ", ");
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
    return <StatusIcon status={value as TaskStatus} color="currentColor" size={14} />;
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return <PriorityIcon priority={value as TaskPriority} color="currentColor" size={14} />;
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as { type?: IssueRelationType };
    if (relation.type === "blocked_by" || relation.type === "blocks") {
      return <BlockingRelationIcon type={relation.type} color="currentColor" size={14} />;
    }
    return <RelationIcon color="currentColor" size={14} />;
  }
  if (field === "projectId") return <ProjectIcon color="currentColor" size={14} />;
  if (field === "labels") return <LabelIcon color="currentColor" size={14} />;
  if (field === "assignee") return <LinearIcon name="myIssues" />;
  if (field === "developmentContext") return <BranchIcon color="currentColor" size={14} />;
  if (field === "startDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "dueDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "recurrence") return <RecurrenceIcon color="currentColor" size={14} />;
  if (field === "archivedAt") return <DeleteIcon color="currentColor" size={14} />;
  return <EditIcon color="currentColor" size={14} />;
}

function ConversationLink({
  threadId,
  onOpen,
  onCopy,
}: {
  threadId: string;
  onOpen: () => void;
  onCopy: (text: string, announcement: string) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-conversation-actions">
      <button
        className="issue-conversation-link"
        type="button"
        title={text("查看对话", "View conversation")}
        onClick={onOpen}
      >
        <ConversationIcon color="currentColor" size={16} />
        <strong>{text("查看对话", "View conversation")}</strong>
      </button>
      <button
        className="issue-conversation-copy"
        type="button"
        title={text("复制终端命令", "Copy terminal command")}
        onClick={() => onCopy(
          `codex resume ${threadId}`,
          text("Codex 恢复命令已复制。", "Codex resume command copied."),
        )}
      >
        <CodexResumeIcon />
        <span>{text("复制终端命令", "Copy terminal command")}</span>
      </button>
    </div>
  );
}

export function TaskDetail({
  task,
  tasks,
  referenceTasks,
  currentUser,
  availableLabels,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  onCreateLabel,
  onDeleteLabel,
  onUpdate,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenLegacyLocalThread,
  onOpenInThread,
  onCopy,
  openingThread,
  onError,
}: TaskDetailProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(task.description, referenceTasks),
  );
  const [editingDescription, setEditingDescription] = useState(false);
  const [propertyMenu, setPropertyMenu] = useState<
    "status" | "priority" | "assignee" | "labels" | "development" | "recurrence" | null
  >(null);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsError, setAttachmentsError] = useState<TaskDetailError | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [taskActivities, setTaskActivities] = useState<TaskChangeActivity[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<TaskDetailError | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      taskboardStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
      referenceTasks,
    ),
  );
  const [changeStatusToTodo, setChangeStatusToTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSegments, setEditingSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(),
  );
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const descriptionScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const descriptionCaretRef = useRef<{ text: string; offset: number; occurrence: number } | null>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const editingComposerRef = useRef<InlineMediaComposerHandle>(null);
  const editingCommentScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editCommentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editingUploadedAttachmentsRef = useRef<Map<string, Attachment>>(new Map());
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);
  const commentInlineFiles = inlineMediaFiles(commentSegments);
  const editingDraft = serializeInlineMedia(editingSegments);
  const displayIdentifier = currentTask.externalKey ?? currentTask.identifier;
  const editingInlineImages = inlineMediaImages(editingSegments);
  const editingInlineFiles = inlineMediaFiles(editingSegments);

  useEffect(() => {
    const taskChanged = currentTask.id !== task.id;
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (taskChanged || !editingDescription) {
      setDescription(task.description);
      setDescriptionSegments(createInlineMediaSegments(task.description, referenceTasks));
    }
    if (taskChanged) {
      setEditingDescription(false);
      setChangeStatusToTodo(false);
    }
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
  }, [title]);

  useLayoutEffect(() => {
    if (!editingDescription) return;
    const position = descriptionScrollPositionRef.current;
    descriptionScrollPositionRef.current = null;
    const caret = descriptionCaretRef.current;
    descriptionCaretRef.current = null;
    if (caret) {
      descriptionComposerRef.current?.focusAtText(caret.text, caret.offset, caret.occurrence);
    } else {
      descriptionComposerRef.current?.focus();
    }
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingDescription]);

  useLayoutEffect(() => {
    if (!editingId) return;
    const position = editingCommentScrollPositionRef.current;
    editingCommentScrollPositionRef.current = null;
    editingComposerRef.current?.focus();
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingId]);

  useEffect(() => {
    const controller = new AbortController();
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
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    function receiveAttachmentOpenError(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      if (event.data.type !== "taskboard:attachment-open-error") return;
      setAttachmentsError(typeof event.data.payload?.error === "string"
        ? event.data.payload.error
        : ["无法打开附件，请重试。", "Could not open the attachment. Try again."]);
    }
    window.addEventListener("message", receiveAttachmentOpenError);
    return () => window.removeEventListener("message", receiveAttachmentOpenError);
  }, []);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) taskboardStorage.setItem(key, text);
    else taskboardStorage.removeItem(key);
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
      onError(issueMessageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  function openDatePicker(
    field: "startDate" | "dueDate",
    event: MouseEvent<HTMLLabelElement>,
  ) {
    const input = event.currentTarget.querySelector("input");
    if (!input || input.disabled) return;
    event.preventDefault();
    if (new URL(document.baseURI).searchParams.get("host") !== "codex" || window.parent === window) {
      input.showPicker();
      return;
    }

    const requestId = crypto.randomUUID();
    const rect = input.getBoundingClientRect();
    function receiveDate(event: MessageEvent) {
      if (event.source !== window.parent || event.data?.type !== "taskboard:date-picker-response") return;
      const payload = event.data.payload;
      if (payload?.requestId !== requestId || typeof payload.value !== "string") return;
      window.removeEventListener("message", receiveDate);
      const value = payload.value || null;
      void saveTask(
        field === "startDate"
          ? { startDate: value }
          : { dueDate: value, ...(value ? {} : { recurrence: null }) },
        field,
      );
    }
    window.addEventListener("message", receiveDate);
    postEmbeddedHostMessage({
      type: "taskboard:date-picker-request",
      payload: {
        requestId,
        value: input.value,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
    });
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
      onError(issueMessageFor(error));
      throw error;
    }
  }

  async function addMentionRelations(
    anchor: Task,
    segments: InlineMediaSegment[],
  ): Promise<Task> {
    let current = anchor;
    const relatedIds = new Set(current.relations.related.map((relation) => relation.id));
    for (const segment of segments) {
      if (segment.type !== "issue-reference" || !segment.taskId) continue;
      const relatedTaskId = segment.taskId;
      if (
        relatedTaskId === current.id
        || segment.projectId !== current.projectId
        || relatedIds.has(relatedTaskId)
      ) continue;
      const result = await applyRelationMutation(
        () => onAddRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
      relatedIds.add(relatedTaskId);
    }
    return current;
  }

  function mentionTaskIds(segments: InlineMediaSegment[]): Set<string> {
    return new Set(segments.flatMap((segment) => (
      segment.type === "issue-reference" && segment.taskId ? [segment.taskId] : []
    )));
  }

  function removedMentionTaskIds(
    previous: InlineMediaSegment[],
    next: InlineMediaSegment[],
  ): Set<string> {
    const nextIds = mentionTaskIds(next);
    return new Set([...mentionTaskIds(previous)].filter((taskId) => !nextIds.has(taskId)));
  }

  async function removeUnreferencedMentionRelations(
    anchor: Task,
    candidates: Set<string>,
  ): Promise<Task> {
    if (candidates.size === 0) return anchor;
    const savedComments = await listComments(anchor.id);
    const referencedIds = mentionTaskIds(createInlineMediaSegments(anchor.description, referenceTasks));
    for (const comment of savedComments) {
      for (const taskId of mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks))) {
        referencedIds.add(taskId);
      }
    }

    let current = anchor;
    for (const relatedTaskId of candidates) {
      if (
        referencedIds.has(relatedTaskId)
        || !current.relations.related.some((relation) => relation.id === relatedTaskId)
      ) continue;
      const relatedTask = await getTask(relatedTaskId);
      if (
        mentionTaskIds(createInlineMediaSegments(relatedTask.description, referenceTasks))
          .has(anchor.id)
      ) continue;
      const relatedComments = await listComments(relatedTaskId);
      if (relatedComments.some((comment) => (
        mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks)).has(anchor.id)
      ))) continue;
      const result = await applyRelationMutation(
        () => onRemoveRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
    }
    return current;
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
      onError(["议题标题不能为空。", "Issue title cannot be empty."]);
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
    const inlineFiles = inlineMediaFiles(descriptionSegments);
    if (
      draftDescription === currentTask.description
      && inlineImages.length === 0
      && inlineFiles.length === 0
    ) {
      setEditingDescription(false);
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(currentTask.description, referenceTasks),
      descriptionSegments,
    );

    setSavingProperty("description");
    onError(null);
    try {
      const uploadedImages = await Promise.all(
        inlineImages.map((image) => uploadAttachment(currentTask.id, image.file, "inline")),
      );
      const uploadedFiles = await Promise.all(
        inlineFiles.map((file) => uploadAttachment(currentTask.id, file.file, "attachment")),
      );
      const resolvedDescription = resolveInlineAttachmentMarkdown(
        resolveInlineMediaMarkdown(
          draftDescription,
          inlineImages,
          uploadedImages,
        ),
        inlineFiles,
        uploadedFiles,
      ).trim();
      const saved = await onUpdate(currentTask, { description: resolvedDescription }).catch((error) => {
        onError(issueMessageFor(error));
        return null;
      });
      if (!saved) return;
      const savedWithAddedRelations = await addMentionRelations(saved, descriptionSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      setDescription(savedWithRelations.description);
      const nextAttachments = [
        ...attachments,
        ...[...uploadedImages, ...uploadedFiles].filter((attachment) => (
          !attachments.some((item) => item.id === attachment.id)
        )),
      ];
      setDescriptionSegments(createInlineMediaSegments(
        savedWithRelations.description,
        referenceTasks,
        nextAttachments,
      ));
      setAttachments(nextAttachments);
      setEditingDescription(false);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && commentInlineImages.length === 0 && commentInlineFiles.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [inlineAttachments, fileAttachments] = await Promise.all([
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file, "inline")),
        ),
        Promise.all(
          commentInlineFiles.map((file) => uploadCommentAttachment(comment.id, file.file, "attachment")),
        ),
      ]);
      const nextComment = commentInlineImages.length > 0 || commentInlineFiles.length > 0
        ? await updateComment(
            comment,
            resolveInlineAttachmentMarkdown(
              resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
              commentInlineFiles,
              fileAttachments,
            ),
          )
        : comment;
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      let relationAnchor = await getTask(currentTask.id);
      if (changeStatusToTodo) {
        const saved = await onUpdate(relationAnchor, { status: "todo" });
        setCurrentTask(saved);
        relationAnchor = saved;
        setChangeStatusToTodo(false);
      }
      const savedWithRelations = await addMentionRelations(relationAnchor, commentSegments);
      setCurrentTask(savedWithRelations);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function beginEdit(comment: Comment, source: HTMLElement) {
    if (savingCommentId !== null) return;
    const scrollContainer = source.closest<HTMLElement>(".issue-detail-scroll");
    editingCommentScrollPositionRef.current = scrollContainer
      ? { element: scrollContainer, top: scrollContainer.scrollTop }
      : null;
    editingUploadedAttachmentsRef.current.clear();
    setEditingId(comment.id);
    setEditingSegments(createInlineMediaSegments(comment.body, referenceTasks, comment.attachments));
    setActiveMenuId(null);
  }

  function endCommentEdit() {
    setEditingId(null);
    editingUploadedAttachmentsRef.current.clear();
  }

  async function saveComment(comment: Comment) {
    const body = editingDraft.trim();
    if (!body || (
      body === comment.body
      && editingInlineImages.length === 0
      && editingInlineFiles.length === 0
    )) {
      if (body === comment.body) endCommentEdit();
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(comment.body, referenceTasks),
      editingSegments,
    );
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const uploadedImages: Attachment[] = [];
      for (const image of editingInlineImages) {
        let attachment = editingUploadedAttachmentsRef.current.get(image.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, image.file, "inline");
          editingUploadedAttachmentsRef.current.set(image.id, attachment);
        }
        uploadedImages.push(attachment);
      }
      const uploadedFiles: Attachment[] = [];
      for (const file of editingInlineFiles) {
        let attachment = editingUploadedAttachmentsRef.current.get(file.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, file.file, "attachment");
          editingUploadedAttachmentsRef.current.set(file.id, attachment);
        }
        uploadedFiles.push(attachment);
      }
      const updated = await updateComment(
        comment,
        resolveInlineAttachmentMarkdown(
          resolveInlineMediaMarkdown(body, editingInlineImages, uploadedImages),
          editingInlineFiles,
          uploadedFiles,
        ).trim(),
      );
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      const relationAnchor = await getTask(currentTask.id);
      const savedWithAddedRelations = await addMentionRelations(relationAnchor, editingSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      endCommentEdit();
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    const removedMentionIds = mentionTaskIds(
      createInlineMediaSegments(pendingDelete.body, referenceTasks),
    );
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        currentTask,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  function handleAttachmentDownload(event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentsError(null);
    void downloadAttachmentFile(attachment).catch((error) => {
      setAttachmentsError(messageFor(error));
    });
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
    <section
      className="issue-detail"
      aria-label={text(`${displayIdentifier} 议题详情`, `${displayIdentifier} issue details`)}
    >
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label={text("议题内容", "Issue content")}>
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label={text("议题标题", "Issue title")}
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
                      mentionTasks={tasks}
                      referenceTasks={referenceTasks}
                      completionContext={{
                        projectId: currentTask.projectId,
                        surface: "issue-description",
                      }}
                      placeholder={text("添加描述…", "Add description…")}
                      ariaLabel={text("议题描述", "Issue description")}
                      disabled={savingProperty === "description"}
                      allowAttachments
                      onChange={setDescriptionSegments}
                      onError={onError}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setDescriptionSegments(createInlineMediaSegments(
                            currentTask.description,
                            referenceTasks,
                            attachments,
                          ));
                          setEditingDescription(false);
                        }
                      }}
                    />
                    <button
                      className="comment-attach-button issue-description-attach-button"
                      type="button"
                      disabled={savingProperty === "description"}
                      aria-label={text("添加描述附件", "Add description attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          descriptionComposerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label={text("编辑议题描述", "Edit issue description")}
                    onClick={(event) => {
                      if (window.getSelection()?.isCollapsed === false) return;
                      descriptionCaretRef.current = null;
                      const range = event.currentTarget.ownerDocument.caretRangeFromPoint(
                        event.clientX,
                        event.clientY,
                      );
                      const node = range?.startContainer;
                      if (range && node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node)) {
                        const value = node.textContent ?? "";
                        const walker = event.currentTarget.ownerDocument.createTreeWalker(
                          event.currentTarget,
                          NodeFilter.SHOW_TEXT,
                        );
                        let occurrence = 0;
                        while (walker.nextNode() && walker.currentNode !== node) {
                          if (walker.currentNode.textContent === value) occurrence += 1;
                        }
                        descriptionCaretRef.current = {
                          text: value,
                          offset: range.startOffset,
                          occurrence,
                        };
                      }
                      const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                      descriptionScrollPositionRef.current = scrollContainer
                        ? { element: scrollContainer, top: scrollContainer.scrollTop }
                        : null;
                      setDescriptionSegments(createInlineMediaSegments(
                        description,
                        referenceTasks,
                        attachments,
                      ));
                      setEditingDescription(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        descriptionCaretRef.current = null;
                        const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                        descriptionScrollPositionRef.current = scrollContainer
                          ? { element: scrollContainer, top: scrollContainer.scrollTop }
                          : null;
                        setDescriptionSegments(createInlineMediaSegments(
                          description,
                          referenceTasks,
                          attachments,
                        ));
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description
                      ? <DescriptionDocument
                          value={description}
                          referenceTasks={referenceTasks}
                          onOpenTask={onOpenTask}
                          attachments={attachments}
                          enableImagePreview
                          onOpenAttachment={handleAttachmentDownload}
                        />
                      : text("添加描述…", "Add description…")}
                  </div>
                )}
                {(currentTask.threadBinding || currentTask.legacyLocalThreadId) && (
                  <div
                    className="issue-conversation-list"
                    aria-label={text("处理此议题的对话", "Conversations for this issue")}
                  >
                    <ConversationLink
                      threadId={currentTask.threadBinding?.threadId ?? currentTask.legacyLocalThreadId!}
                      onOpen={() => currentTask.threadBinding
                        ? onOpenThread(currentTask.threadBinding)
                        : onOpenLegacyLocalThread(currentTask.legacyLocalThreadId!)}
                      onCopy={onCopy}
                    />
                  </div>
                )}
              </div>
              {attachmentsError && (
                <div className="attachments-error" role="alert">
                  {typeof attachmentsError === "string"
                    ? attachmentsError
                    : text(attachmentsError[0], attachmentsError[1])}
                </div>
              )}
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

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">{text("活动", "Activity")}</h2>
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
                    {text(" 创建了此议题", " created this issue")}
                    <time title={exactTime(currentTask.createdAt, locale)}>{relativeTime(currentTask.createdAt, locale)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label={text("正在加载活动", "Loading activity")} aria-busy="true"><i /><i /></div>
                ) : activityTimeline.map((item) => {
                  if (item.kind === "change") {
                    const { activity, change } = item;
                    const fieldLabels = ACTIVITY_FIELD_LABELS[change.field];
                    const fieldLabel = fieldLabels
                      ? text(fieldLabels[0], fieldLabels[1])
                      : change.field;
                    const beforeValue = activityValue(
                      change.field,
                      change.before,
                      language,
                      locale,
                      text,
                    );
                    const afterValue = activityValue(
                      change.field,
                      change.after,
                      language,
                      locale,
                      text,
                    );
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
                            <>{text("更新了描述", "updated the description")}</>
                          ) : change.field === "relation" && change.before === null ? (
                            <>{text("添加了 ", "added ")}<span className="activity-change-value">{afterValue}</span></>
                          ) : change.field === "relation" && change.after === null ? (
                            <>{text("移除了 ", "removed ")}<span className="activity-change-value">{beforeValue}</span></>
                          ) : language === "zh" ? (
                            <>
                              将{fieldLabel}从
                              <span className="activity-change-value">{beforeValue}</span>
                              改为
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          ) : (
                            <>
                              {`changed ${fieldLabel} from `}
                              <span className="activity-change-value">{beforeValue}</span>
                              {" to "}
                              <span className="activity-change-value">{afterValue}</span>
                            </>
                          )}
                          <time title={exactTime(activity.createdAt, locale)}>{relativeTime(activity.createdAt, locale)}</time>
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
                        <time title={exactTime(comment.createdAt, locale)}>{relativeTime(comment.createdAt, locale)}</time>
                        {comment.version > 1 && (
                          <span
                            className="comment-edited"
                            title={text(
                              `编辑于 ${exactTime(comment.updatedAt, locale)}`,
                              `Edited ${exactTime(comment.updatedAt, locale)}`,
                            )}
                          >
                            {text("已编辑", "Edited")}
                          </span>
                        )}
                        {editingId !== comment.id && (
                          <div className="comment-actions" data-comment-menu-root={comment.id}>
                            <button
                              type="button"
                              className="comment-menu-trigger"
                              aria-label={text("评论操作", "Comment actions")}
                              aria-haspopup="menu"
                              aria-expanded={activeMenuId === comment.id}
                              onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                            >
                              <MoreIcon color="currentColor" />
                            </button>
                            {activeMenuId === comment.id && (
                              <div className="comment-action-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={savingCommentId !== null}
                                  onClick={(event) => beginEdit(comment, event.currentTarget)}
                                >
                                  <EditIcon color="currentColor" />
                                  {text("编辑评论", "Edit comment")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                                >
                                  <DeleteIcon color="currentColor" />
                                  {text("删除评论", "Delete comment")}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <InlineMediaComposer
                            ref={editingComposerRef}
                            className="comment-inline-media"
                            segments={editingSegments}
                            mentionTasks={tasks}
                            referenceTasks={referenceTasks}
                            completionContext={{
                              projectId: currentTask.projectId,
                              surface: "comment",
                            }}
                            placeholder={text("编辑评论", "Edit comment")}
                            ariaLabel={text("编辑评论", "Edit comment")}
                            disabled={savingCommentId === comment.id}
                            allowAttachments
                            onChange={setEditingSegments}
                            onError={setCommentsError}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                endCommentEdit();
                                return;
                              }
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div className="comment-edit-actions">
                            <div className="composer-footer-leading">
                              <button
                                className="comment-attach-button"
                                type="button"
                                disabled={savingCommentId === comment.id}
                                aria-label={text("添加评论附件", "Add comment attachments")}
                                title={text("添加附件", "Add attachments")}
                                onClick={() => editCommentAttachmentInputRef.current?.click()}
                              >
                                <AttachmentIcon color="currentColor" />
                              </button>
                              <input
                                ref={editCommentAttachmentInputRef}
                                type="file"
                                multiple
                                hidden
                                onChange={(event) => {
                                  if (event.currentTarget.files) {
                                    editingComposerRef.current?.addFiles(event.currentTarget.files);
                                  }
                                  event.currentTarget.value = "";
                                }}
                              />
                            </div>
                            <div>
                              <button
                                className="button secondary"
                                type="button"
                                disabled={savingCommentId === comment.id}
                                onClick={endCommentEdit}
                              >
                                {text("取消", "Cancel")}
                              </button>
                              <button
                                className="button primary"
                                type="button"
                                disabled={!editingDraft.trim() || savingCommentId === comment.id}
                                onClick={() => void saveComment(comment)}
                              >
                                {savingCommentId === comment.id
                                  ? text("保存中…", "Saving…")
                                  : text("保存", "Save")}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        comment.body && (
                          <div className="comment-body">
                            <DescriptionDocument
                              value={comment.body}
                              referenceTasks={referenceTasks}
                              onOpenTask={onOpenTask}
                              attachments={comment.attachments}
                              enableImagePreview
                              onOpenAttachment={handleAttachmentDownload}
                            />
                          </div>
                        )
                      )}
                      {(comment.threadBinding || comment.legacyLocalThreadId) && (
                        <div className="comment-conversation-link">
                          <ConversationLink
                            threadId={comment.threadBinding?.threadId ?? comment.legacyLocalThreadId!}
                            onOpen={() => comment.threadBinding
                              ? onOpenThread(comment.threadBinding)
                              : onOpenLegacyLocalThread(comment.legacyLocalThreadId!)}
                            onCopy={onCopy}
                          />
                        </div>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>

              {commentsError && (
                <div className="comments-error" role="alert">
                  {typeof commentsError === "string"
                    ? commentsError
                    : text(commentsError[0], commentsError[1])}
                </div>
              )}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
                <div className="composer-author">
                  <ActorAvatar
                    className="comment-avatar"
                    actor={currentUser}
                  />
                  <strong>{currentUser.name}</strong>
                </div>
                <InlineMediaComposer
                  ref={composerRef}
                  className="comment-inline-media"
                  segments={commentSegments}
                  mentionTasks={tasks}
                  referenceTasks={referenceTasks}
                  completionContext={{
                    projectId: currentTask.projectId,
                    surface: "comment",
                  }}
                  placeholder={text("留下评论…", "Leave a comment…")}
                  ariaLabel={text("留下评论", "Leave a comment")}
                  allowAttachments
                  onChange={setCommentSegments}
                  onError={setCommentsError}
                  onKeyDown={handleSubmitShortcut}
                />
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={submitting}
                      aria-label={text("添加评论附件", "Add comment attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          composerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                  <div>
                    <div className="comment-status-action">
                      <span>{text("改变状态为-等待认领", "Change status to Todo")}</span>
                      <button
                        type="button"
                        className={`board-setting-switch${changeStatusToTodo ? " is-on" : ""}`}
                        role="switch"
                        aria-checked={changeStatusToTodo}
                        disabled={submitting}
                        onClick={() => setChangeStatusToTodo((current) => !current)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && commentInlineImages.length === 0
                        && commentInlineFiles.length === 0
                      ) || submitting}
                    >
                      {submitting ? text("发布中…", "Posting…") : text("评论", "Comment")}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label={text("议题属性", "Issue properties")}>
            <div className="detail-primary-actions">
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                onClick={() => onOpenInThread(currentTask)}
              >
                <NewConversationIcon color="currentColor" />
                <span>{openingThread
                  ? text("正在打开…", "Opening…")
                  : text("在新对话打开", "Open in new conversation")}</span>
              </button>
              {currentTask.externalUrl && (
                <a
                  className="detail-copy-action detail-external-action"
                  href={currentTask.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="detail-copy-action-icon" aria-hidden="true">
                    <LinearIcon name="openExternal" />
                  </span>
                  <span className="detail-copy-action-label">{text("打开 Jira", "Open Jira")}</span>
                </a>
              )}
              <button
                className="detail-copy-action"
                type="button"
                title={text(
                  `复制议题 ID ${displayIdentifier}`,
                  `Copy issue ID ${displayIdentifier}`,
                )}
                onClick={() => onCopy(
                  displayIdentifier,
                  text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copied.`),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制 ID", "Copy ID")}</span>
                <span className="detail-copy-identifier">{displayIdentifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(
                    document.baseURI,
                    currentTask.projectId,
                    currentTask.identifier,
                  ).href,
                  text("议题链接已复制。", "Issue link copied."),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制链接", "Copy link")}</span>
              </button>
            </div>
            <h2>{text("属性", "Properties")}</h2>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("状态", "Status")}</span>
              <TaskPropertyPicker
                value={currentTask.status}
                options={TASK_STATUSES.map((status) => ({
                  value: status,
                  label: taskStatusLabel(language, status),
                  icon: <StatusIcon status={status} color="currentColor" size={14} />,
                }))}
                open={propertyMenu === "status"}
                disabled={savingProperty === "status"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                triggerContent={(
                  <>
                    <span className="task-property-trigger-icon">
                      <StatusIcon status={currentTask.status} color="currentColor" size={14} />
                    </span>
                    <span className="task-property-trigger-label">
                      {taskStatusLabel(language, currentTask.status)}
                    </span>
                  </>
                )}
                ariaLabel={text("状态", "Status")}
                onOpenChange={(open) => setPropertyMenu(open ? "status" : null)}
                onChange={(status) => void saveTask({ status }, "status")}
              />
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("优先级", "Priority")}</span>
              <TaskPropertyPicker
                value={currentTask.priority}
                options={TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: taskPriorityLabel(language, priority),
                  icon: <PriorityIcon priority={priority} size={14} />,
                  className: `priority-${priority}`,
                }))}
                open={propertyMenu === "priority"}
                disabled={savingProperty === "priority"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("优先级", "Priority")}
                onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <span className="detail-property-label">{text("负责人", "Assignee")}</span>
              <TaskPropertyPicker
                value={actorKey(currentTask.assignee)}
                options={assigneeOptions.map((actor) => ({
                  value: actorKey(actor),
                  label: actor.id === currentUser.id
                    ? `${actor.name}${text("（我）", " (me)")}`
                    : actor.name,
                  icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
                }))}
                open={propertyMenu === "assignee"}
                disabled={currentTask.source === "jira" || savingProperty === "assignee"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("负责人", "Assignee")}
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
                <LabelIcon color="currentColor" size={14} />
              </span>
              <span className="detail-property-label">{text("标签", "Labels")}</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={propertyMenu === "labels"}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                showSelectedAsChips
                placeholder={text("添加标签…", "Add labels…")}
                onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
                onCreateLabel={onCreateLabel}
                onDeleteLabel={currentTask.source === "jira" ? undefined : onDeleteLabel}
              />
            </div>
            <div className="detail-property-row development-property">
              <span className="detail-property-label">{text("开发上下文", "Development context")}</span>
              <TaskPropertyPicker
                value={contextValue(currentTask.developmentContext)}
                options={[
                  {
                    value: "",
                    label: developmentScanLoading
                      ? text("正在扫描 Git…", "Scanning Git…")
                      : text("未绑定", "Not linked"),
                    icon: <BranchIcon color="currentColor" size={14} />,
                  },
                  ...developmentOptions.map((context) => ({
                    value: contextValue(context),
                    label: contextLabel(context, text),
                    icon: context.type === "branch"
                      ? <BranchIcon color="currentColor" size={14} />
                      : <LinearIcon name="folder" />,
                  })),
                ]}
                open={propertyMenu === "development"}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                className="detail-property-picker"
                popoverClassName="development-context-popover"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("开发上下文", "Development context")}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onOpenChange={(open) => setPropertyMenu(open ? "development" : null)}
                onChange={(value) => void saveTask({
                  developmentContext: value ? JSON.parse(value) as DevelopmentContext : null,
                }, "developmentContext")}
              />
            </div>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("startDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("开始日期", "Start date")}</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("dueDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("截止日期", "Due date")}</span>
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
            <div className="detail-property-row">
              <span className="detail-property-label">{text("重复", "Recurrence")}</span>
              <TaskPropertyPicker
                value={currentTask.recurrence?.unit ?? ""}
                options={[
                  { value: "", label: text("不重复", "Does not repeat"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "day", label: text("每天", "Daily"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "week", label: text("每周", "Weekly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "month", label: text("每月", "Monthly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                  { value: "year", label: text("每年", "Yearly"), icon: <RecurrenceIcon color="currentColor" size={14} /> },
                ]}
                open={propertyMenu === "recurrence"}
                disabled={savingProperty === "recurrence"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("重复", "Recurrence")}
                onOpenChange={(open) => setPropertyMenu(open ? "recurrence" : null)}
                onChange={(value) => {
                  const unit = value as Recurrence["unit"] | "";
                  const changes: Partial<TaskDraft> = {
                    recurrence: unit ? { interval: 1, unit } : null,
                  };
                  if (unit && !currentTask.dueDate) {
                    const dueDate = new Date();
                    dueDate.setDate(dueDate.getDate() + 7);
                    changes.dueDate = new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60_000)
                      .toISOString().slice(0, 10);
                  }
                  void saveTask(changes, "recurrence");
                }}
              />
            </div>
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
              <span>{text(
                `创建于 ${exactTime(currentTask.createdAt, locale)}`,
                `Created ${exactTime(currentTask.createdAt, locale)}`,
              )}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>{text(
                `更新于 ${exactTime(currentTask.updatedAt, locale)}`,
                `Updated ${exactTime(currentTask.updatedAt, locale)}`,
              )}</span>}
            </div>
          </aside>
        </div>
      </div>

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">{text("删除这条评论？", "Delete this comment?")}</h2>
            <p>{text("此操作无法撤销。", "This action cannot be undone.")}</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>{text("取消", "Cancel")}</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? text("删除中…", "Deleting…") : text("删除评论", "Delete comment")}</button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}
