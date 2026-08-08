import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { ActorIdentity, Task, TaskDraft, TaskStatus } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import {
  SECONDARY_STATUSES,
  type SecondaryTaskStatus,
} from "../issueBoardStatuses";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";
import { TaskboardIcon } from "./TaskboardIcon";

interface OtherTasksPanelProps {
  open: boolean;
  activeStatus: SecondaryTaskStatus;
  tasksByStatus: Record<TaskStatus, Task[]>;
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  hasActiveFilters: boolean;
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  availableLabels: string[];
  currentUser: ActorIdentity;
  onStatusChange: (status: SecondaryTaskStatus) => void;
  onCreate: (status: SecondaryTaskStatus) => void;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

export function OtherTasksPanel({
  open,
  activeStatus,
  tasksByStatus,
  presentations,
  now,
  hasActiveFilters,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  availableLabels,
  currentUser,
  onStatusChange,
  onCreate,
  onEdit,
  onUpdate,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
}: OtherTasksPanelProps) {
  const tasks = tasksByStatus[activeStatus];
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
    if (taskId) onDrop(activeStatus, taskId, findDropBefore(event.currentTarget, event.clientY));
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
    <aside
      className={`other-tasks-panel${open ? " is-open" : ""}`}
      id="other-tasks-panel"
      aria-label="其他任务"
      aria-hidden={!open}
    >
      <div className="other-tasks-tabs" role="tablist" aria-label="其他任务状态">
        {SECONDARY_STATUSES.map((status) => {
          const details = STATUS_DETAILS[status];
          const selected = status === activeStatus;
          return (
            <button
              className={`other-tasks-tab${selected ? " is-active" : ""}`}
              id={`other-tasks-tab-${status}`}
              key={status}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="other-tasks-list"
              title={`${details.label} ${tasksByStatus[status].length}`}
              onClick={() => onStatusChange(status)}
            >
              <span className="other-tasks-tab-label">{details.label}</span>
              <span className="other-tasks-tab-count" aria-label={`${tasksByStatus[status].length} 个议题`}>
                {tasksByStatus[status].length}
              </span>
            </button>
          );
        })}
      </div>

      <button
        className="other-tasks-add"
        type="button"
        aria-label={`在${STATUS_DETAILS[activeStatus].label}中新建议题`}
        title={`添加到${STATUS_DETAILS[activeStatus].label}`}
        onClick={() => onCreate(activeStatus)}
      >
        <TaskboardIcon name="sidebarAdd" />
      </button>

      <div
        className="other-tasks-list"
        id="other-tasks-list"
        role="tabpanel"
        aria-labelledby={`other-tasks-tab-${activeStatus}`}
        onDragEnter={() => onDragEnter(activeStatus)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDragEnter(activeStatus);
          setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            setDropBeforeTaskId(undefined);
          }
        }}
        onDrop={handleDrop}
      >
        {tasks.map((task) => {
          const dragShift = getTaskDragShift(task);
          return (
            <TaskCard
              key={task.id}
              task={task}
              variant="sidebar"
              presentation={presentations[task.id]}
              now={now}
              isDragging={draggedTaskId === task.id}
              dragShift={dragShift}
              isMoving={movingTaskId === task.id}
              isSettling={settlingTaskId === task.id}
              isContextMenuOpen={contextMenuTaskId === task.id}
              availableLabels={availableLabels}
              currentUser={currentUser}
              onEdit={onEdit}
              onUpdate={onUpdate}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpenConversation={onOpenConversation}
            />
          );
        })}
        {tasks.length === 0 && (
          <div className="other-tasks-empty">
            <LinearIcon name={hasActiveFilters ? "search" : "panel"} />
            <strong>{hasActiveFilters ? "当前筛选下无匹配议题" : "暂无议题"}</strong>
            <span>{hasActiveFilters ? "搜索和筛选会同步作用于所有状态。" : `没有${STATUS_DETAILS[activeStatus].label}。`}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
