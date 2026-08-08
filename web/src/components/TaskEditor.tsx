import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ApiError } from "../api";
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
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
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

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const RECURRENCE_UNITS: Record<Recurrence["unit"], string> = {
  day: "天",
  week: "周",
  month: "月",
  year: "年",
};

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
}

interface TaskEditorProps {
  task: Task | null;
  initialStatus: TaskStatus;
  initialDraft: NewTaskEditorDraft | null;
  labels: string[];
  currentUser: ActorIdentity;
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  onCancel: (draft: NewTaskEditorDraft | null) => void;
  onSave: (
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
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

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

export function TaskEditor({
  task,
  initialStatus,
  initialDraft,
  labels: availableLabels,
  currentUser,
  developmentScan,
  developmentScanLoading,
  onCancel,
  onSave,
}: TaskEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
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
  const [menu, setMenu] = useState<"status" | "priority" | "assignee" | "labels" | "more" | "due" | "recurrence" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>(initialDraft?.attachments ?? []);

  const developmentOptions = useMemo(() => {
    const options = [...developmentScan.contexts];
    if (developmentContext && !options.some((option) => contextValue(option) === contextValue(developmentContext))) {
      options.unshift(developmentContext);
    }
    return options;
  }, [developmentContext, developmentScan.contexts]);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task) {
      if (!createSubmitIntentRef.current) return;
      createSubmitIntentRef.current = false;
    }
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("请为议题填写一个简短、明确的标题。");
      titleRef.current?.focus();
      return;
    }
    if (recurrence && !dueDate) {
      setError("重复议题需要先设置最早截止日期。");
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
      }, attachments, inlineMediaImages(descriptionSegments));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT") {
        setError("这个议题已在其他位置发生变更，请关闭并刷新后重试。");
      } else {
        setError(caught instanceof Error ? caught.message : "无法保存这个议题。");
      }
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (task || event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      createSubmitIntentRef.current = true;
      event.currentTarget.requestSubmit();
      return;
    }
    if (event.target === titleRef.current) {
      event.preventDefault();
      descriptionComposerRef.current?.focus();
    }
  }

  function addAttachments(files: FileList | File[]) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentError(`“${oversized.name}” 超过 25 MB，无法上传。`);
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
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) cancelEditor();
      }}
    >
      <form className="task-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <header className="dialog-header">
          <div className="dialog-context">
            <strong id="task-dialog-title">{task ? task.identifier : "新建议题"}</strong>
          </div>
          <div className="dialog-header-actions">
            <button type="button" className="icon-button dialog-expand" aria-label={expanded ? "收起编辑器" : "展开编辑器"} onClick={() => setExpanded((current) => !current)}>
              <LinearIcon name="expand" />
            </button>
            <button type="button" className="icon-button dialog-close" onClick={cancelEditor} disabled={saving} aria-label="关闭编辑器">
              <LinearIcon name="close" />
            </button>
          </div>
        </header>

        <div className="form-body">
          <label className="composer-title">
            <span className="sr-only">标题</span>
            <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Issue title" maxLength={240} autoComplete="off" />
          </label>
          {task ? (
            <label className="composer-description">
              <span className="sr-only">描述</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={5} />
            </label>
          ) : (
            <InlineMediaComposer
              ref={descriptionComposerRef}
              className="composer-description inline-media-description"
              segments={descriptionSegments}
              placeholder="Add description…"
              ariaLabel="描述"
              disabled={saving}
              onChange={setDescriptionSegments}
              onError={setAttachmentError}
            />
          )}

          {!task && (
            <PendingAttachments
              files={attachments}
              disabled={saving}
              uploadLabel="保存后上传"
              ariaLabel="待上传附件"
              onRemove={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            />
          )}
        </div>

        <div className="task-form-dock">
          <div className="property-row">
            <TaskPropertyPicker
              value={status}
              options={TASK_STATUSES.map((value) => ({
                value,
                label: STATUS_DETAILS[value].label,
                icon: <StatusIcon status={value} />,
                className: `status-icon-${STATUS_DETAILS[value].tone}`,
              }))}
              open={menu === "status"}
              triggerClassName="property-control property-status"
              ariaLabel="状态"
              onOpenChange={(open) => setMenu(open ? "status" : null)}
              onChange={setStatus}
            />
            <TaskPropertyPicker
              value={priority}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label: PRIORITY_LABELS[value],
                icon: <LinearPriorityIcon priority={value} />,
                className: `priority-${value}`,
              }))}
              open={menu === "priority"}
              triggerClassName={`property-control property-priority priority-${priority}`}
              ariaLabel="优先级"
              onOpenChange={(open) => setMenu(open ? "priority" : null)}
              onChange={setPriority}
            />
            <TaskPropertyPicker
              value={actorKey(assignee)}
              options={assigneeOptions.map((actor) => ({
                value: actorKey(actor),
                label: actor.id === currentUser.id ? `${actor.name}（我）` : actor.name,
                icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
              }))}
              open={menu === "assignee"}
              triggerClassName="property-control property-assignee"
              ariaLabel="负责人"
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
            />

            <label className="property-control property-development" title={developmentScan.workspacePath ?? undefined}>
              <LinearIcon name="branch" />
              <span className="sr-only">代码分支或 Worktree</span>
              <select
                value={contextValue(developmentContext)}
                disabled={developmentScanLoading}
                onChange={(event) => setDevelopmentContext(event.target.value ? JSON.parse(event.target.value) as DevelopmentContext : null)}
              >
                <option value="">{developmentScanLoading ? "正在扫描 Git…" : "分支 / Worktree"}</option>
                <optgroup label="代码分支">
                  {developmentOptions.filter((context) => context.type === "branch").map((context) => <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>)}
                </optgroup>
                <optgroup label="Worktree">
                  {developmentOptions.filter((context) => context.type === "worktree").map((context) => <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>)}
                </optgroup>
              </select>
            </label>

            {dueDate && <button className="property-control" type="button" onClick={() => setMenu("due")}><span>截止 {displayDate(dueDate)}</span></button>}
            {recurrence && <button className="property-control" type="button" onClick={() => setMenu("recurrence")}><span>每 {recurrence.interval} {RECURRENCE_UNITS[recurrence.unit]}</span></button>}

            <div className="composer-menu-anchor">
              <button className="property-control property-more" type="button" aria-label="更多属性" onClick={() => setMenu(menu === "more" ? null : "more")}><LinearIcon name="more" /></button>
              {menu === "more" && (
                <div className="composer-popover more-popover">
                  <button type="button" onClick={() => setMenu("due")}><span><LinearIcon name="calendarAdd" /></span><strong>设置截止日期</strong><kbd>⇧ D</kbd><b><LinearIcon name="chevronRight" /></b></button>
                  <button type="button" onClick={() => setMenu("recurrence")}><span><LinearIcon name="recurrence" /></span><strong>设置重复…</strong><b><LinearIcon name="chevronRight" /></b></button>
                </div>
              )}
              {menu === "due" && (
                <div className="composer-popover due-popover">
                  <label className="custom-date-row"><span>自定义…</span><input type="date" value={dueDate} onChange={(event) => chooseDueDate(event.target.value)} /></label>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(1))}><strong>明天</strong><span>{displayDate(dateFromNow(1))}</span></button>
                  <button type="button" onClick={() => chooseDueDate(endOfWeek())}><strong>本周结束</strong><span>{displayDate(endOfWeek())}</span></button>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(7))}><strong>一周后</strong><span>{displayDate(dateFromNow(7))}</span></button>
                  {dueDate && <button className="destructive-menu-row" type="button" onClick={() => { setDueDate(""); setRecurrence(null); setMenu(null); }}>清除截止日期</button>}
                </div>
              )}
              {menu === "recurrence" && (
                <div className="composer-popover recurrence-popover">
                  <label><span>最早截止日期</span><input type="date" value={dueDate || dateFromNow(7)} onChange={(event) => setDueDate(event.target.value)} /></label>
                  <label><span>重复频率</span><span className="recurrence-controls"><input type="number" min="1" max="365" value={recurrence?.interval ?? 1} onChange={(event) => setRecurrence({ interval: Number(event.target.value), unit: recurrence?.unit ?? "week" })} /><select value={recurrence?.unit ?? "week"} onChange={(event) => setRecurrence({ interval: recurrence?.interval ?? 1, unit: event.target.value as Recurrence["unit"] })}>{Object.entries(RECURRENCE_UNITS).map(([unit, label]) => <option value={unit} key={unit}>{label}</option>)}</select></span></label>
                  <button className="recurrence-save" type="button" onClick={() => { if (!dueDate) setDueDate(dateFromNow(7)); if (!recurrence) setRecurrence({ interval: 1, unit: "week" }); setMenu(null); }}>设置重复</button>
                  {recurrence && <button className="destructive-menu-row" type="button" onClick={() => { setRecurrence(null); setMenu(null); }}>清除重复</button>}
                </div>
              )}
            </div>
          </div>

          {attachmentError && <div className="form-error" role="alert">{attachmentError}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}

          <footer className="dialog-footer">
            {!task && (
              <>
                <button className="composer-attach-icon" type="button" disabled={saving} onClick={() => attachmentInputRef.current?.click()} aria-label="上传附件">
                  <LinearIcon name="attachment" />{attachments.length > 0 && <span>{attachments.length}</span>}
                </button>
                <input ref={attachmentInputRef} type="file" multiple hidden onChange={(event) => { if (event.currentTarget.files) addAttachments(event.currentTarget.files); event.currentTarget.value = ""; }} />
              </>
            )}
            {task && <span aria-hidden="true" />}
            <div className="dialog-actions">
              {task && <span className="dialog-updated">编辑 {task.identifier}</span>}
              <button
                className="button primary"
                type="submit"
                disabled={saving}
                onClick={() => {
                  if (!task) createSubmitIntentRef.current = true;
                }}
              >
                {saving ? "正在保存…" : task ? "保存更改" : "创建议题"}
              </button>
            </div>
          </footer>
        </div>
      </form>
    </dialog>
  );
}
