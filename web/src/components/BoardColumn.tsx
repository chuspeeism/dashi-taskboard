import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { ActorIdentity, Task, TaskDraft, TaskPriority, TaskStatus } from "../types";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { TaskCard } from "./TaskCard";
import { PlusIcon, PriorityIcon, StatusIcon } from "./SemanticIcons";

const PRIORITY_GROUPS: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "待立项", tone: "backlog" },
  todo: { label: "等待认领", tone: "todo" },
  in_progress: { label: "处理中", tone: "progress" },
  in_review: { label: "等你确认", tone: "review" },
  blocked: { label: "遇到阻碍", tone: "blocked" },
  done: { label: "完成", tone: "done" },
  canceled: { label: "取消", tone: "canceled" },
};

interface BoardColumnProps {
  scrollRef: (element: HTMLDivElement | null) => void;
  status: TaskStatus;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  emptyMessage: string;
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  availableLabels: string[];
  projectNames?: Record<string, string>;
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  createEnabled?: boolean;
  onCreateLabel: (label: string, projectId?: string) => Promise<void>;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => Promise<void>;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (
    status: TaskStatus,
    taskId: string,
    beforeTaskId: string | null,
    priority?: TaskPriority,
  ) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

export function BoardColumn({
  scrollRef,
  status,
  tasks,
  presentations,
  now,
  emptyMessage,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  availableLabels,
  projectNames,
  currentUser,
  showCover,
  showBody,
  createEnabled = true,
  onCreateLabel,
  onCreate,
  onEdit,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
}: BoardColumnProps) {
  const { language, text } = useTaskboardI18n();
  const details = STATUS_DETAILS[status];
  const label = taskStatusLabel(language, status);
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const [dropPriority, setDropPriority] = useState<TaskPriority | null>(null);
  const [collapsedPriorities, setCollapsedPriorities] = useState<Partial<Record<TaskPriority, boolean>>>({});
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTask = draggedTaskId
    ? tasks.find((task) => task.id === draggedTaskId)
    : undefined;
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) {
      setDropBeforeTaskId(undefined);
      setDropPriority(null);
    }
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    return cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    setDropBeforeTaskId(undefined);
    setDropPriority(null);
  }

  function handlePriorityDrop(event: DragEvent<HTMLElement>, priority: TaskPriority) {
    event.preventDefault();
    event.stopPropagation();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) {
      onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY), priority);
    }
    setDropBeforeTaskId(undefined);
    setDropPriority(null);
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
    if (dropPriority !== null) {
      if (task.priority !== dropPriority) return 0;
      if (draggedTask?.priority !== dropPriority) return 0;
    }
    let shift = 0;
    const taskIndex = taskIndexes.get(task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(task.id) ?? -1;

    if (draggedTaskIndex >= 0 && taskIndex > draggedTaskIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return (
    <section
      className={`board-column status-${status}${isDropTarget ? " is-drop-target" : ""}`}
      aria-labelledby={`column-${status}`}
      onDragEnter={() => onDragEnter(status)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragEnter(status);
        setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={handleDrop}
    >
      <header className="column-header">
        <div className="column-heading">
          <span className={`column-status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} color="var(--column-status-color)" size={14} />
          </span>
          <h2 id={`column-${status}`}>
            {label}{tasks.length > 0 ? ` ${tasks.length}` : ""}
          </h2>
        </div>
        {createEnabled && (
          <div className="column-actions">
            <button
              type="button"
              className="icon-button add-task-button"
              onClick={() => onCreate(status)}
              aria-label={text(`在${label}中新建议题`, `Create issue in ${label}`)}
              title={text(`添加到${label}`, `Add to ${label}`)}
            >
              <PlusIcon color="var(--column-status-color)" size={12} />
            </button>
          </div>
        )}
      </header>

      <div className="column-list" ref={scrollRef}>
        {PRIORITY_GROUPS.map((priority) => {
          const priorityTasks = tasks.filter((task) => task.priority === priority);
          const isCollapsed = collapsedPriorities[priority] ?? false;
          return (
<<<<<<< HEAD
            <section
              className={`priority-group priority-group-${priority}${priorityTasks.length === 0 ? " priority-group-empty" : ""}${dropPriority === priority ? " is-drop-target" : ""}`}
              data-priority-group={priority}
              data-status={status}
              key={priority}
              onDragEnter={(event) => {
                event.stopPropagation();
                onDragEnter(status);
                setDropPriority(priority);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                onDragEnter(status);
                setDropPriority(priority);
                setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropPriority((current) => current === priority ? null : current);
                }
              }}
              onDrop={(event) => handlePriorityDrop(event, priority)}
            >
              <button
                type="button"
                className="priority-group-header"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsedPriorities((current) => ({ ...current, [priority]: !isCollapsed }))}
              >
                <span className="priority-group-title">
                  <PriorityIcon priority={priority} size={14} />
                  <span>{taskPriorityLabel(language, priority)}</span>
                </span>
                <span className="priority-group-count">{priorityTasks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="priority-group-list">
                  {priorityTasks.map((task) => {
                    const dragShift = getTaskDragShift(task);
                    return (
                      <TaskCard
                        key={task.id}
                        task={task}
                        presentation={presentations[task.id]}
                        now={now}
                        isDragging={draggedTaskId === task.id}
                        dragShift={dragShift}
                        isMoving={movingTaskId === task.id}
                        isSettling={settlingTaskId === task.id}
                        isContextMenuOpen={contextMenuTaskId === task.id}
                        availableLabels={availableLabels}
                        projectName={projectNames?.[task.projectId]}
                        currentUser={currentUser}
                        showCover={showCover}
                        showBody={showBody}
                        onCreateLabel={(label) => onCreateLabel(label, task.projectId)}
                        onEdit={onEdit}
                        onUpdate={onUpdate}
                        onComplete={onComplete}
                        onContextMenu={onContextMenu}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onOpenConversation={onOpenConversation}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {tasks.length === 0 && <div className="column-empty">{emptyMessage}</div>}
      </div>
    </section>
  );
}
