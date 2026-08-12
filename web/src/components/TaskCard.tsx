import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentContentUrl, resolvePersistedAttachmentUrl } from "../api";
import {
  TASK_PRIORITIES,
  type ActorIdentity,
  type AssigneeTarget,
  type Task,
  type TaskDraft,
  type TaskPriority,
} from "../types";
import { labelPresentation } from "../labels";
import { taskPriorityLabel, useTaskboardI18n } from "../i18n";
import { CODEX_AGENT_ACTOR, actorKey, assigneeTargetForActor } from "../actors";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { LinearPriorityIcon } from "./LinearIcon";
import { LabelPicker } from "./LabelPicker";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskboardIcon } from "./TaskboardIcon";
import completeIcon from "../assets/figma-taskboard/card-complete.svg";
import processingAnimation from "../assets/figma-taskboard/loading-16.svg";

interface TaskCardProps {
  task: Task;
  variant?: "main" | "sidebar";
  presentation: TaskCardPresentation;
  now: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  availableLabels: string[];
  currentUser: ActorIdentity;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete?: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

function calendarDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function createdDate(value: string, locale: string, text: (chinese: string, english: string) => string) {
  const formatted = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(value));
  return text(`${formatted}创建`, `Created ${formatted}`);
}

function elapsedTime(startedAt: string | null, now: number) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m${elapsed % 60 ? `${elapsed % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function firstTaskImage(task: Task) {
  const markdownImage = task.description.match(
    /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\)/,
  );
  const source = markdownImage?.[1]
    ?? markdownImage?.[2]
    ?? (task.previewImage ? attachmentContentUrl(task.previewImage) : null);
  return source ? resolvePersistedAttachmentUrl(source) : null;
}

function TaskCardMedia({ src }: { src: string }) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const imageSizeRef = useRef<{ naturalWidth: number; naturalHeight: number } | null>(null);
  const [presentation, setPresentation] = useState<{ width: number; clamped: boolean } | null>(null);
  const clamped = presentation?.clamped ?? false;
  const updatePresentation = useCallback(() => {
    const media = mediaRef.current;
    const imageSize = imageSizeRef.current;
    if (!media || !imageSize) return;
    const renderedWidth = Math.min(imageSize.naturalWidth, media.clientWidth);
    const nextPresentation = {
      width: imageSize.naturalWidth,
      clamped: imageSize.naturalHeight * renderedWidth / imageSize.naturalWidth > 300,
    };
    setPresentation((current) => (
      current?.width === nextPresentation.width && current.clamped === nextPresentation.clamped
        ? current
        : nextPresentation
    ));
  }, []);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const observer = new ResizeObserver(updatePresentation);
    observer.observe(media);
    return () => observer.disconnect();
  }, [updatePresentation]);

  return (
    <div
      ref={mediaRef}
      className={`task-card-media${clamped ? " is-clamped" : ""}`}
      style={presentation ? { width: presentation.width } : undefined}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          imageSizeRef.current = {
            naturalWidth: event.currentTarget.naturalWidth,
            naturalHeight: event.currentTarget.naturalHeight,
          };
          updatePresentation();
        }}
      />
    </div>
  );
}

function ProcessingProgress({
  presentation,
}: {
  presentation: TaskCardPresentation;
}) {
  const { text } = useTaskboardI18n();
  const { processing } = presentation;
  const hasProgress = processing.total !== null
    && processing.total > 0
    && processing.completed !== null;
  if (!hasProgress) return null;

  const total = processing.total!;
  const completed = Math.max(0, Math.min(processing.completed!, total));
  const label = text(`处理进度 ${completed}/${total}`, `Processing progress ${completed}/${total}`);

  return (
    <div className="card-progress-row">
      <div
        className={`task-progress-segments${processing.running ? " is-running" : ""}`}
        aria-label={label}
        title={label}
      >
        {Array.from({ length: total }, (_, index) => (
          <span className={index < completed ? "is-complete" : ""} key={index} />
        ))}
      </div>
    </div>
  );
}

function ProcessingStatusRow({
  presentation,
  now,
  onOpenConversation,
}: {
  presentation: TaskCardPresentation;
  now: number;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}) {
  const { text } = useTaskboardI18n();
  const elapsed = elapsedTime(presentation.processing.startedAt, now);
  const running = presentation.processing.running;
  return (
    <div className={`task-processing-row${running ? " is-running" : " is-paused"}`}>
      {running && <img className="task-processing-glyph" src={processingAnimation} alt="" aria-hidden="true" />}
      <span className="task-processing-label">
        {running
          ? (elapsed ? text(`已处理 ${elapsed}...`, `Processing for ${elapsed}...`) : text("正在处理...", "Processing..."))
          : text("暂停处理", "Processing paused")}
      </span>
      <span className="task-processing-spacer" aria-hidden="true" />
      {presentation.conversations.length > 0 && (
        <TaskConversationMenu
          conversations={presentation.conversations}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

function ParticipantAvatars({ participants }: { participants: ActorIdentity[] }) {
  const { text } = useTaskboardI18n();
  if (participants.length === 0) return null;
  return (
    <span
      className="task-participants"
      aria-label={text(
        `参与人：${participants.map((participant) => participant.name).join("、")}`,
        `Participants: ${participants.map((participant) => participant.name).join(", ")}`,
      )}
    >
      {participants.map((participant) => (
        <ActorAvatar
          actor={participant}
          className="task-participant-avatar"
          key={`${participant.type}:${participant.id}`}
        />
      ))}
    </span>
  );
}

function TaskLabels({ task }: { task: Task }) {
  const { language } = useTaskboardI18n();
  return (
    <>
      {task.labels.slice(0, 2).map((label) => {
        const presentation = labelPresentation(label, language);
        return (
          <span className={`label-chip${presentation.tone ? ` label-chip-${presentation.tone}` : ""}`} key={label}>
            {presentation.tone && <i aria-hidden="true" />}
            <span>{presentation.name}</span>
          </span>
        );
      })}
      {task.labels.length > 2 && (
        <span className="label-more" title={task.labels.slice(2).map((label) => labelPresentation(label, language).name).join(", ")}>
          +{task.labels.length - 2}
        </span>
      )}
    </>
  );
}

function PriorityControl({
  task,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  task: Task;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (priority: TaskPriority) => void;
}) {
  const { language, text } = useTaskboardI18n();
  return (
    <TaskPropertyPicker
      value={task.priority}
      options={TASK_PRIORITIES.map((priority) => ({
        value: priority,
        label: taskPriorityLabel(language, priority),
        icon: <LinearPriorityIcon priority={priority} />,
        className: `priority-${priority}`,
      }))}
      open={open}
      disabled={disabled}
      className="card-property-control"
      triggerClassName={`priority-chip priority-chip-${task.priority}`}
      ariaLabel={text(`${task.identifier} 优先级`, `${task.identifier} priority`)}
      title={text(
        `优先级：${taskPriorityLabel(language, task.priority)}`,
        `Priority: ${taskPriorityLabel(language, task.priority)}`,
      )}
      onOpenChange={onOpenChange}
      onChange={onChange}
    />
  );
}

function DueDateControl({
  task,
  disabled,
  onChange,
}: {
  task: Task;
  disabled: boolean;
  onChange: (dueDate: string | null) => void;
}) {
  const { locale, text } = useTaskboardI18n();
  if (!task.dueDate) return null;
  return (
    <label className="due-date-chip card-property-control" title={text(`截止日期 ${task.dueDate}`, `Due date ${task.dueDate}`)}>
      <TaskboardIcon name="calendar" /> {calendarDate(task.dueDate, locale)}
      <input
        type="date"
        aria-label={text(`${task.identifier} 截止日期`, `${task.identifier} due date`)}
        value={task.dueDate}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  );
}

function AssigneeControl({
  task,
  participants,
  currentUser,
  disabled,
  onChange,
}: {
  task: Task;
  participants: ActorIdentity[];
  currentUser: ActorIdentity;
  disabled: boolean;
  onChange: (target: AssigneeTarget) => void;
}) {
  const { text } = useTaskboardI18n();
  const options = [task.assignee, currentUser, CODEX_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  return (
    <label className="task-participants-control card-property-control" title={text(`负责人：${task.assignee.name}`, `Assignee: ${task.assignee.name}`)}>
      <ParticipantAvatars participants={participants} />
      <select
        aria-label={text(`${task.identifier} 负责人`, `${task.identifier} assignee`)}
        value={actorKey(task.assignee)}
        disabled={disabled}
        onChange={(event) => {
          const selected = options.find((actor) => actorKey(actor) === event.target.value);
          const target = selected ? assigneeTargetForActor(selected, currentUser) : undefined;
          if (target) onChange(target);
        }}
      >
        {options.map((actor) => (
          <option value={actorKey(actor)} key={actorKey(actor)}>
            {actor.id === currentUser.id ? text(`${actor.name}（我）`, `${actor.name} (me)`) : actor.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaskCard({
  task,
  variant = "main",
  presentation,
  now,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  availableLabels,
  currentUser,
  onEdit,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onOpenConversation,
}: TaskCardProps) {
  const { locale, text } = useTaskboardI18n();
  const [propertyMenu, setPropertyMenu] = useState<"priority" | "labels" | null>(null);
  const [savingProperty, setSavingProperty] = useState<"priority" | "labels" | "dueDate" | "assignee" | null>(null);
  const creator: ActorIdentity = {
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  };
  const processingCard = task.status === "in_progress";
  const supportsConversation = task.status === "in_progress"
    || task.status === "in_review"
    || task.status === "blocked"
    || task.status === "done"
    || task.status === "canceled";
  const showsConversation = supportsConversation && presentation.conversations.length > 0;
  const showsInlineParticipants = variant === "main"
    && task.participants.length > 0;
  const image = firstTaskImage(task);
  const hasProperties = task.priority !== "none" || task.labels.length > 0 || task.dueDate;
  const showsProperties = !processingCard
    && (hasProperties || showsInlineParticipants || showsConversation);
  const propertyDisabled = savingProperty !== null;

  function updateProperty(changes: Partial<TaskDraft>, property: NonNullable<typeof savingProperty>) {
    setSavingProperty(property);
    void onUpdate(task, changes)
      .catch(() => {})
      .finally(() => setSavingProperty((current) => current === property ? null : current));
  }

  return (
    <article
      className={`task-card task-card-${variant} status-${task.status}${processingCard ? " is-processing-card" : ""}${processingCard && presentation.processing.running ? " is-running-card" : ""}${image ? " has-media" : ""}${presentation.unread ? " is-unread" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}${propertyMenu ? " is-property-menu-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={text(`打开 ${task.identifier}: ${task.title}`, `Open ${task.identifier}: ${task.title}`)}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">ID: {task.identifier}</span>
        </span>
        {presentation.unread && <span className="task-unread-dot" aria-label={text("有未读更新", "Unread updates")} />}
        {task.status === "in_review" && onComplete && (
          <button
            className="task-card-complete"
            type="button"
            aria-label={text(`完成 ${task.identifier}`, `Complete ${task.identifier}`)}
            title={text("完成", "Complete")}
            onClick={(event) => {
              event.stopPropagation();
              onComplete(task);
            }}
          >
            <img src={completeIcon} alt="" aria-hidden="true" />
            <span>{text("完成", "Complete")}</span>
          </button>
        )}
        {variant === "sidebar" && (
          <span className="sidebar-card-creator">
            <AssigneeControl
              task={task}
              participants={task.participants.length ? task.participants : [creator]}
              currentUser={currentUser}
              disabled={propertyDisabled}
              onChange={(assigneeTarget) => updateProperty({ assigneeTarget }, "assignee")}
            />
            <span>{createdDate(task.createdAt, locale, text)}</span>
          </span>
        )}
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {image && (
        <TaskCardMedia key={image} src={image} />
      )}

      {showsProperties && (
        <div className="card-properties" aria-label={text("议题属性", "Issue properties")}>
          {task.priority !== "none" && (
            <PriorityControl
              task={task}
              disabled={propertyDisabled}
              open={propertyMenu === "priority"}
              onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
              onChange={(priority) => updateProperty({ priority }, "priority")}
            />
          )}
          {task.labels.length > 0 && (
            <LabelPicker
              availableLabels={availableLabels}
              selectedLabels={task.labels}
              open={propertyMenu === "labels"}
              disabled={propertyDisabled}
              className="card-label-picker card-property-control"
              triggerClassName="card-label-trigger"
              triggerContent={<TaskLabels task={task} />}
              onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
              onChange={(labels) => updateProperty({ labels }, "labels")}
            />
          )}
          <DueDateControl
            task={task}
            disabled={propertyDisabled}
            onChange={(dueDate) => updateProperty({
              dueDate,
              ...(dueDate ? {} : { recurrence: null }),
            }, "dueDate")}
          />
          {showsInlineParticipants && (
            <AssigneeControl
              task={task}
              participants={task.participants}
              currentUser={currentUser}
              disabled={propertyDisabled}
              onChange={(assigneeTarget) => updateProperty({ assigneeTarget }, "assignee")}
            />
          )}
          {showsConversation && <span className="card-properties-spacer" aria-hidden="true" />}
          {showsConversation && (
            <TaskConversationMenu
              conversations={presentation.conversations}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      )}

      {processingCard && (
        <>
          <ProcessingProgress presentation={presentation} />
          <ProcessingStatusRow
            presentation={presentation}
            now={now}
            onOpenConversation={onOpenConversation}
          />
        </>
      )}
    </article>
  );
}
