import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ApiError } from "../api";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActorIdentity,
  type DevelopmentContext,
  type DevelopmentScan,
  type Recurrence,
  type Task,
  type TaskDraft,
  type TaskPriority,
  type TaskStatus,
} from "../types";
import {
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { LabelPicker } from "./LabelPicker";
import { IssuePickerContent } from "./IssueRelations";
import { LinearIcon } from "./LinearIcon";
import {
  AttachmentIcon,
  BranchIcon,
  DueDateIcon,
  MoreIcon,
  PlusIcon,
  PriorityIcon,
  RecurrenceIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  fileKey,
  MAX_ATTACHMENT_SIZE,
  PendingAttachments,
} from "./PendingAttachments";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaImages,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
  type PendingInlineImage,
} from "./InlineMediaComposer";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

const RECURRENCE_UNITS: Record<TaskboardLanguage, Record<Recurrence["unit"], string>> = {
  zh: {
    day: "天",
    week: "周",
    month: "月",
    year: "年",
  },
  en: {
    day: "day",
    week: "week",
    month: "month",
    year: "year",
  },
};

type TaskEditorError = string | readonly [string, string];
type DraftRelationMenu = "parent" | "related" | "subIssue";

export interface NewTaskRelationDraft {
  parentId: string | null;
  relatedIds: string[];
  subIssueIds: string[];
}

export interface NewTaskCreateOptions {
  keepOpen: boolean;
  relations: NewTaskRelationDraft;
}

export interface NewTaskEditorDraft {
  title: string;
  descriptionSegments: InlineMediaSegment[];
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  selectedLabels: string[];
  developmentContext: DevelopmentContext | null;
  startDate: string;
  dueDate: string;
  recurrence: Recurrence | null;
  attachments: File[];
  relations: NewTaskRelationDraft;
}

interface TaskEditorProps {
  projectId: string | null;
  projectOptions?: Array<{ id: string; name: string }>;
  onProjectChange?: (projectId: string | null) => void;
  task: Task | null;
  tasks: Task[];
  referenceTasks: Task[];
  initialStatus: TaskStatus;
  initialDraft: NewTaskEditorDraft | null;
  labels: string[];
  currentUser: ActorIdentity;
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  onCreateLabel: (label: string) => Promise<void>;
  onCancel: (draft: NewTaskEditorDraft | null) => void;
  onSave: (
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) => Promise<void>;
}

function isoDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function endOfWeek(): string {
  const date = new Date();
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysUntilFriday);
  return isoDate(date);
}

function displayDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
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

export function TaskEditor({
  projectId,
  projectOptions,
  onProjectChange,
  task,
  tasks,
  referenceTasks,
  initialStatus,
  initialDraft,
  labels: availableLabels,
  currentUser,
  developmentScan,
  developmentScanLoading,
  onCreateLabel,
  onCancel,
  onSave,
}: TaskEditorProps) {
  const { language, locale, text } = useTaskboardI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const backdropPointerRef = useRef({ down: false, up: false });
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const createSubmitIntentRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(task?.title ?? initialDraft?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => initialDraft?.descriptionSegments ?? createInlineMediaSegments(),
  );
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? initialStatus);
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? initialDraft?.priority ?? "none");
  const [assignee, setAssignee] = useState<ActorIdentity>(task?.assignee ?? initialDraft?.assignee ?? currentUser);
  const [selectedLabels, setSelectedLabels] = useState<string[]>(task?.labels ?? initialDraft?.selectedLabels ?? []);
  const [developmentContext, setDevelopmentContext] = useState<DevelopmentContext | null>(task?.developmentContext ?? initialDraft?.developmentContext ?? null);
  const [startDate] = useState(task?.startDate ?? initialDraft?.startDate ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? initialDraft?.dueDate ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence | null>(task?.recurrence ?? initialDraft?.recurrence ?? null);
  const [parentId, setParentId] = useState<string | null>(initialDraft?.relations.parentId ?? null);
  const [relatedIds, setRelatedIds] = useState<string[]>(initialDraft?.relations.relatedIds ?? []);
  const [subIssueIds, setSubIssueIds] = useState<string[]>(initialDraft?.relations.subIssueIds ?? []);
  const [createMore, setCreateMore] = useState(false);
  const [menu, setMenu] = useState<"project" | "status" | "priority" | "assignee" | "labels" | "development" | "more" | "due" | "recurrence" | null>(null);
  const [relationMenu, setRelationMenu] = useState<DraftRelationMenu | null>(null);
  const [moreMenuPosition, setMoreMenuPosition] = useState<{ right: number; bottom: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TaskEditorError | null>(null);
  const [attachmentError, setAttachmentError] = useState<TaskEditorError | null>(null);
  const [attachments, setAttachments] = useState<File[]>(initialDraft?.attachments ?? []);

  const developmentOptions = useMemo(() => {
    const options = [...developmentScan.contexts];
    if (developmentContext && !options.some((option) => contextValue(option) === contextValue(developmentContext))) {
      options.unshift(developmentContext);
    }
    return options;
  }, [developmentContext, developmentScan.contexts]);

  const taskById = useMemo(() => new Map(tasks.map((candidate) => [candidate.id, candidate])), [tasks]);
  const availableRelationTasks = tasks.filter((candidate) => candidate.archivedAt === null);
  const selectedParent = parentId ? taskById.get(parentId) ?? null : null;
  const selectedRelated = relatedIds
    .map((id) => taskById.get(id))
    .filter((candidate): candidate is Task => candidate !== undefined);
  const selectedSubIssues = subIssueIds
    .map((id) => taskById.get(id))
    .filter((candidate): candidate is Task => candidate !== undefined);
  const selectedRelationChips = [
    ...selectedSubIssues.map((issue) => ({ type: "subIssue" as const, issue })),
    ...(selectedParent ? [{ type: "parent" as const, issue: selectedParent }] : []),
    ...selectedRelated.map((issue) => ({ type: "related" as const, issue })),
  ];
  const selectedParentAncestorIds = useMemo(() => {
    const ids = new Set<string>();
    let currentId = parentId;
    while (currentId && !ids.has(currentId)) {
      ids.add(currentId);
      currentId = taskById.get(currentId)?.relations.parent?.id ?? null;
    }
    return ids;
  }, [parentId, taskById]);
  const selectedSubIssueDescendantIds = useMemo(() => {
    const ids = new Set<string>();
    const queue = [...subIssueIds];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (ids.has(currentId)) continue;
      ids.add(currentId);
      queue.push(...(taskById.get(currentId)?.relations.subIssues.map((item) => item.id) ?? []));
    }
    return ids;
  }, [subIssueIds, taskById]);
  const parentCandidates = availableRelationTasks.filter((candidate) => (
    !selectedSubIssueDescendantIds.has(candidate.id)
  ));
  const relatedCandidates = availableRelationTasks;
  const subIssueCandidates = availableRelationTasks.filter((candidate) => (
    !selectedParentAncestorIds.has(candidate.id)
  ));
  const relationCandidates = relationMenu === "parent"
    ? parentCandidates
    : relationMenu === "related"
      ? relatedCandidates
      : subIssueCandidates;
  const selectedRelationIds = new Set(
    relationMenu === "parent"
      ? parentId ? [parentId] : []
      : relationMenu === "related"
        ? relatedIds
        : subIssueIds,
  );

  const assigneeOptions = [task?.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor): actor is ActorIdentity => actor !== undefined)
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));

  useEffect(() => {
    dialogRef.current?.showModal();
    titleRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (menu !== "more" && menu !== "due" && menu !== "recurrence") return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [menu]);

  useEffect(() => {
    if (menu !== "more") {
      setRelationMenu(null);
      setMoreMenuPosition(null);
    }
  }, [menu]);

  function toggleDraftRelation(candidate: Task) {
    if (relationMenu === "parent") {
      setParentId((current) => current === candidate.id ? null : candidate.id);
    } else if (relationMenu === "related") {
      setRelatedIds((current) => current.includes(candidate.id)
        ? current.filter((id) => id !== candidate.id)
        : [...current, candidate.id]);
    } else if (relationMenu === "subIssue") {
      setSubIssueIds((current) => current.includes(candidate.id)
        ? current.filter((id) => id !== candidate.id)
        : [...current, candidate.id]);
    }
  }

  function toggleMoreMenu() {
    setRelationMenu(null);
    if (menu === "more") {
      setMenu(null);
      return;
    }
    const rect = moreMenuRef.current?.getBoundingClientRect();
    setMoreMenuPosition(rect ? {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 8,
    } : null);
    setMenu("more");
  }

  useEffect(() => {
    const titleElement = titleRef.current;
    if (!titleElement) return;
    const resizeTitle = () => {
      titleElement.style.height = "0px";
      titleElement.style.height = `${titleElement.scrollHeight}px`;
    };
    resizeTitle();

    let titleWidth = titleElement.clientWidth;
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      const nextWidth = titleElement.clientWidth;
      if (nextWidth === titleWidth) return;
      titleWidth = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resizeTitle);
    });
    observer.observe(titleElement);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [title]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task) {
      if (!createSubmitIntentRef.current) return;
      createSubmitIntentRef.current = false;
      if (projectOptions && !projectId) {
        setError(["请选择项目。", "Select a project."]);
        return;
      }
    }
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError([
        "请为议题填写一个简短、明确的标题。",
        "Enter a short, clear issue title.",
      ]);
      titleRef.current?.focus();
      return;
    }
    if (recurrence && !dueDate) {
      setError([
        "重复议题需要先设置最早截止日期。",
        "A recurring issue needs an initial due date.",
      ]);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const assigneeTarget = task && actorKey(assignee) === actorKey(task.assignee)
        ? undefined
        : assigneeTargetForActor(assignee, currentUser);
      const descriptionValue = task
        ? description.trim()
        : serializeInlineMedia(descriptionSegments).trim();
      await onSave({
        title: cleanTitle,
        description: descriptionValue,
        status,
        priority,
        labels: selectedLabels,
        ...(assigneeTarget ? { assigneeTarget } : {}),
        developmentContext,
        startDate: startDate || null,
        dueDate: dueDate || null,
        recurrence,
      }, attachments, inlineMediaImages(descriptionSegments), task ? undefined : {
        keepOpen: createMore,
        relations: { parentId, relatedIds, subIssueIds },
      });
      if (!task && createMore) {
        setTitle("");
        setDescriptionSegments(createInlineMediaSegments());
        setAttachments([]);
        setSubIssueIds([]);
        setRelationMenu(null);
        setAttachmentError(null);
        if (attachmentInputRef.current) attachmentInputRef.current.value = "";
        requestAnimationFrame(() => titleRef.current?.focus());
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT") {
        setError([
          "这个议题已在其他位置发生变更，请关闭并刷新后重试。",
          "This issue changed elsewhere. Close the editor, refresh, and try again.",
        ]);
      } else {
        setError(caught instanceof Error
          ? caught.message
          : ["无法保存这个议题。", "Could not save this issue."]);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter") return;
    if (!task && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      createSubmitIntentRef.current = true;
      event.currentTarget.requestSubmit();
      return;
    }
    if (event.target !== titleRef.current) return;
    event.preventDefault();
    if (task) event.currentTarget.requestSubmit();
  }

  function addAttachments(files: FileList | File[]) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentError([
        `“${oversized.name}” 超过 25 MB，无法上传。`,
        `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
      ]);
      return;
    }
    setAttachmentError(null);
    setAttachments((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function chooseDueDate(value: string) {
    setDueDate(value);
    setMenu(null);
  }

  function cancelEditor() {
    onCancel(task ? null : {
      title,
      descriptionSegments,
      status,
      priority,
      assignee,
      selectedLabels,
      developmentContext,
      startDate,
      dueDate,
      recurrence,
      attachments,
      relations: { parentId, relatedIds, subIssueIds },
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className={`task-dialog${expanded ? " is-expanded" : ""}`}
      aria-labelledby="task-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) cancelEditor();
      }}
      onPointerDown={(event) => {
        backdropPointerRef.current = {
          down: event.target === event.currentTarget,
          up: false,
        };
      }}
      onPointerUp={(event) => {
        backdropPointerRef.current.up = event.target === event.currentTarget;
      }}
      onPointerCancel={() => {
        backdropPointerRef.current = { down: false, up: false };
      }}
      onClick={(event) => {
        const backdropClick = backdropPointerRef.current.down
          && backdropPointerRef.current.up
          && event.target === event.currentTarget;
        backdropPointerRef.current = { down: false, up: false };
        if (backdropClick && !saving) cancelEditor();
      }}
    >
      <form className={`task-form${task ? "" : " is-creating"}`} onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <header className="dialog-header">
          <div className="dialog-context">
            <strong id="task-dialog-title">{task ? task.identifier : text("新建议题", "New issue")}</strong>
          </div>
          <div className="dialog-header-actions">
            <button
              type="button"
              className="icon-button dialog-expand"
              aria-label={expanded
                ? text("收起编辑器", "Collapse editor")
                : text("展开编辑器", "Expand editor")}
              onClick={() => setExpanded((current) => !current)}
            >
              <LinearIcon name="expand" />
            </button>
            <button
              type="button"
              className="icon-button dialog-close"
              onClick={cancelEditor}
              disabled={saving}
              aria-label={text("关闭编辑器", "Close editor")}
            >
              <LinearIcon name="close" />
            </button>
          </div>
        </header>

        <div className="form-body">
          <label className="composer-title">
            <span className="sr-only">{text("标题", "Title")}</span>
            <textarea ref={titleRef} rows={1} value={title} onChange={(event) => setTitle(event.target.value.replace(/\n/g, ""))} placeholder={text("议题标题", "Issue title")} maxLength={240} autoComplete="off" />
          </label>
          {task ? (
            <label className="composer-description">
              <span className="sr-only">{text("描述", "Description")}</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={text("添加描述…", "Add description…")} rows={5} />
            </label>
          ) : (
            <InlineMediaComposer
              ref={descriptionComposerRef}
              className="composer-description inline-media-description"
              segments={descriptionSegments}
              mentionTasks={tasks}
              referenceTasks={referenceTasks}
              completionContext={projectId ? { projectId, surface: "issue-description" } : undefined}
              placeholder={text("添加描述…", "Add description…")}
              ariaLabel={text("描述", "Description")}
              disabled={saving}
              onChange={setDescriptionSegments}
              onError={setAttachmentError}
            />
          )}

          {!task && (
            <PendingAttachments
              files={attachments}
              disabled={saving}
              uploadLabel={text("保存后上传", "Upload after saving")}
              ariaLabel={text("待上传附件", "Pending attachments")}
              onRemove={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            />
          )}

        </div>

        <div className="task-form-dock">
          <div className="property-row">
            {!task && projectOptions && (
              <TaskPropertyPicker
                value={projectId ?? ""}
                options={[
                  {
                    value: "",
                    label: text("项目", "Project"),
                    icon: <TaskboardIcon name="projectFolder" />,
                  },
                  ...projectOptions.map((project) => ({
                    value: project.id,
                    label: project.name,
                    icon: <TaskboardIcon name="projectFolder" />,
                  })),
                ]}
                open={menu === "project"}
                triggerClassName="property-control property-project"
                ariaLabel={text("项目", "Project")}
                onOpenChange={(open) => setMenu(open ? "project" : null)}
                onChange={(value) => {
                  const nextProjectId = value || null;
                  if (nextProjectId !== projectId) setDevelopmentContext(null);
                  onProjectChange?.(nextProjectId);
                }}
              />
            )}
            <TaskPropertyPicker
              value={status}
              options={TASK_STATUSES.map((value) => ({
                value,
                label: taskStatusLabel(language, value),
                icon: <StatusIcon status={value} color="currentColor" size={14} />,
              }))}
              open={menu === "status"}
              triggerClassName="property-control property-status"
              ariaLabel={text("状态", "Status")}
              onOpenChange={(open) => setMenu(open ? "status" : null)}
              onChange={setStatus}
            />
            <TaskPropertyPicker
              value={priority}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label: taskPriorityLabel(language, value),
                icon: <PriorityIcon priority={value} size={14} />,
                className: `priority-${value}`,
              }))}
              open={menu === "priority"}
              triggerClassName={`property-control property-priority priority-${priority}`}
              ariaLabel={text("优先级", "Priority")}
              onOpenChange={(open) => setMenu(open ? "priority" : null)}
              onChange={setPriority}
            />
            <TaskPropertyPicker
              value={actorKey(assignee)}
              options={assigneeOptions.map((actor) => ({
                value: actorKey(actor),
                label: actor.id === currentUser.id
                  ? `${actor.name}${text("（我）", " (me)")}`
                  : actor.name,
                icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
              }))}
              open={menu === "assignee"}
              triggerClassName="property-control property-assignee"
              ariaLabel={text("负责人", "Assignee")}
              onOpenChange={(open) => setMenu(open ? "assignee" : null)}
              onChange={(value) => {
                const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                if (selected) setAssignee(selected);
              }}
            />
            <LabelPicker
              availableLabels={availableLabels}
              selectedLabels={selectedLabels}
              open={menu === "labels"}
              triggerClassName="property-control"
              showIcon
              onOpenChange={(open) => setMenu(open ? "labels" : null)}
              onChange={setSelectedLabels}
              onCreateLabel={onCreateLabel}
            />

            <TaskPropertyPicker
              value={contextValue(developmentContext)}
              options={[
                {
                  value: "",
                  label: developmentScanLoading
                    ? text("正在扫描 Git…", "Scanning Git…")
                    : text("分支 / Worktree", "Branch / worktree"),
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
              open={menu === "development"}
              disabled={developmentScanLoading}
              popoverClassName="development-context-popover"
              triggerClassName="property-control property-development"
              ariaLabel={text("代码分支或 Worktree", "Code branch or worktree")}
              title={developmentScan.workspacePath ?? undefined}
              onOpenChange={(open) => setMenu(open ? "development" : null)}
              onChange={(value) => setDevelopmentContext(value ? JSON.parse(value) as DevelopmentContext : null)}
            />

            {dueDate && (
              <button className="property-control" type="button" onClick={() => setMenu("due")}>
                <span>{text(
                  `截止 ${displayDate(dueDate, locale)}`,
                  `Due ${displayDate(dueDate, locale)}`,
                )}</span>
              </button>
            )}
            {recurrence && (
              <button className="property-control" type="button" onClick={() => setMenu("recurrence")}>
                <span>{text(
                  `每 ${recurrence.interval} ${RECURRENCE_UNITS.zh[recurrence.unit]}`,
                  `Every ${recurrence.interval} ${RECURRENCE_UNITS.en[recurrence.unit]}${recurrence.interval === 1 ? "" : "s"}`,
                )}</span>
              </button>
            )}

            {!task && selectedRelationChips.map(({ type, issue }) => {
              const identifier = issue.externalKey ?? issue.identifier;
              const relationLabel = type === "subIssue"
                ? text("子", "Sub")
                : type === "parent"
                  ? text("父", "Parent")
                  : text("关联", "Related");
              return (
                <span className="property-control property-relation-chip" key={`${type}:${issue.id}`}>
                  <span className="property-relation-kind">{relationLabel}</span>
                  <span>{identifier}</span>
                  <span className="property-relation-tooltip" role="tooltip">{issue.title}</span>
                  <button
                    className="property-relation-remove"
                    type="button"
                    aria-label={text(`移除 ${identifier}`, `Remove ${identifier}`)}
                    onClick={() => {
                      if (type === "parent") setParentId(null);
                      else if (type === "related") {
                        setRelatedIds((current) => current.filter((id) => id !== issue.id));
                      } else {
                        setSubIssueIds((current) => current.filter((id) => id !== issue.id));
                      }
                    }}
                  >
                    <LinearIcon name="close" />
                  </button>
                </span>
              );
            })}

            <div className="composer-menu-anchor" ref={moreMenuRef}>
              <button className="property-control property-more" type="button" aria-label={text("更多属性", "More properties")} onClick={toggleMoreMenu}><MoreIcon color="currentColor" /></button>
              {menu === "more" && (
                <div
                  className="composer-popover more-popover"
                  role="menu"
                  style={moreMenuPosition ? {
                    position: "fixed",
                    top: "auto",
                    right: moreMenuPosition.right,
                    bottom: moreMenuPosition.bottom,
                    left: "auto",
                  } : undefined}
                >
                  <button type="button" onClick={() => setMenu("due")}><span><DueDateIcon color="currentColor" /></span><strong>{text("设置截止日期", "Set due date")}</strong><kbd>⇧ D</kbd><b><LinearIcon name="chevronRight" /></b></button>
                  <button type="button" onClick={() => setMenu("recurrence")}><span><RecurrenceIcon color="currentColor" /></span><strong>{text("设置重复…", "Set recurrence…")}</strong><b><LinearIcon name="chevronRight" /></b></button>
                  {!task && (
                    <>
                      <div className="more-popover-divider" />
                      <button className={relationMenu === "subIssue" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "subIssue"} onClick={() => setRelationMenu("subIssue")}><span><PlusIcon color="currentColor" size={16} /></span><strong>{text("添加子议题", "Add sub-issue")}</strong>{selectedSubIssues.length > 0 && <small>{text(`${selectedSubIssues.length} 个已选`, `${selectedSubIssues.length} selected`)}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                      <button className={relationMenu === "parent" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "parent"} onClick={() => setRelationMenu("parent")}><span><PlusIcon color="currentColor" size={16} /></span><strong>{text("添加父议题", "Add parent issue")}</strong>{selectedParent && <small>{selectedParent.externalKey ?? selectedParent.identifier}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                      <button className={relationMenu === "related" ? "is-open" : undefined} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={relationMenu === "related"} onClick={() => setRelationMenu("related")}><span><RelationIcon color="currentColor" size={16} /></span><strong>{text("添加关联议题", "Add related issue")}</strong>{selectedRelated.length > 0 && <small>{text(`${selectedRelated.length} 个已选`, `${selectedRelated.length} selected`)}</small>}<b><LinearIcon name="chevronRight" /></b></button>
                      {relationMenu && (
                        <div className="issue-relation-popover task-create-relation-submenu" aria-label={text("选择关系议题", "Select relation issue")}>
                          <IssuePickerContent
                            key={relationMenu}
                            candidates={relationCandidates}
                            selectedIds={selectedRelationIds}
                            onEscape={() => setRelationMenu(null)}
                            onSelect={toggleDraftRelation}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {menu === "due" && (
                <div className="composer-popover due-popover">
                  <label className="custom-date-row"><span>{text("自定义…", "Custom…")}</span><input type="date" value={dueDate} onChange={(event) => chooseDueDate(event.target.value)} /></label>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(1))}><strong>{text("明天", "Tomorrow")}</strong><span>{displayDate(dateFromNow(1), locale)}</span></button>
                  <button type="button" onClick={() => chooseDueDate(endOfWeek())}><strong>{text("本周结束", "End of this week")}</strong><span>{displayDate(endOfWeek(), locale)}</span></button>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(7))}><strong>{text("一周后", "In one week")}</strong><span>{displayDate(dateFromNow(7), locale)}</span></button>
                  {dueDate && <button className="destructive-menu-row" type="button" onClick={() => { setDueDate(""); setRecurrence(null); setMenu(null); }}>{text("清除截止日期", "Clear due date")}</button>}
                </div>
              )}
              {menu === "recurrence" && (
                <div className="composer-popover recurrence-popover">
                  <label><span>{text("最早截止日期", "Initial due date")}</span><input type="date" value={dueDate || dateFromNow(7)} onChange={(event) => setDueDate(event.target.value)} /></label>
                  <label><span>{text("重复频率", "Repeat frequency")}</span><span className="recurrence-controls"><input type="number" min="1" max="365" value={recurrence?.interval ?? 1} onChange={(event) => setRecurrence({ interval: Number(event.target.value), unit: recurrence?.unit ?? "week" })} /><select value={recurrence?.unit ?? "week"} onChange={(event) => setRecurrence({ interval: recurrence?.interval ?? 1, unit: event.target.value as Recurrence["unit"] })}>{Object.entries(RECURRENCE_UNITS[language]).map(([unit, label]) => <option value={unit} key={unit}>{label}</option>)}</select></span></label>
                  <button className="recurrence-save" type="button" onClick={() => { if (!dueDate) setDueDate(dateFromNow(7)); if (!recurrence) setRecurrence({ interval: 1, unit: "week" }); setMenu(null); }}>{text("设置重复", "Set recurrence")}</button>
                  {recurrence && <button className="destructive-menu-row" type="button" onClick={() => { setRecurrence(null); setMenu(null); }}>{text("清除重复", "Clear recurrence")}</button>}
                </div>
              )}
            </div>
          </div>

          {attachmentError && (
            <div className="form-error" role="alert">
              {typeof attachmentError === "string"
                ? attachmentError
                : text(attachmentError[0], attachmentError[1])}
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              {typeof error === "string" ? error : text(error[0], error[1])}
            </div>
          )}

          <footer className="dialog-footer">
            {!task && (
              <>
                <button className="composer-attach-icon" type="button" disabled={saving} onClick={() => attachmentInputRef.current?.click()} aria-label={text("上传附件", "Upload attachments")}>
                  <AttachmentIcon color="currentColor" />{attachments.length > 0 && <span>{attachments.length}</span>}
                </button>
                <input ref={attachmentInputRef} type="file" multiple hidden onChange={(event) => { if (event.currentTarget.files) addAttachments(event.currentTarget.files); event.currentTarget.value = ""; }} />
              </>
            )}
            {task && <span aria-hidden="true" />}
            <div className="dialog-actions">
              {task && <span className="dialog-updated">{text(`编辑 ${task.identifier}`, `Editing ${task.identifier}`)}</span>}
              {!task && (
                <div className="create-more-control">
                  <span>{text("创建更多", "Create more")}</span>
                  <button
                    type="button"
                    className={`board-setting-switch${createMore ? " is-on" : ""}`}
                    role="switch"
                    aria-checked={createMore}
                    disabled={saving}
                    onClick={() => setCreateMore((current) => !current)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
              )}
              <button
                className="button primary"
                type="submit"
                disabled={saving}
                onClick={() => {
                  if (!task) createSubmitIntentRef.current = true;
                }}
              >
                {saving
                  ? text("正在保存…", "Saving…")
                  : task
                    ? text("保存更改", "Save changes")
                    : text("创建议题", "Create issue")}
              </button>
            </div>
          </footer>
        </div>
      </form>
    </dialog>
  );
}
