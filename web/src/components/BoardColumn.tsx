import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { ActorIdentity, Task, TaskDraft, TaskStatus } from "../types";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { TaskCard } from "./TaskCard";
import { PlusIcon, StatusIcon } from "./SemanticIcons";

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
  onComplete: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
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
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
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
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
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
        {tasks.map((task) => {
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
        {tasks.length === 0 && <div className="column-empty">{emptyMessage}</div>}
      </div>
    </section>
  );
}
