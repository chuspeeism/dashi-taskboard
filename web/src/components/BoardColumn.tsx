import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Task, TaskInterventionView, TaskStatus } from "../types";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "积压事项", tone: "backlog" },
  todo: { label: "待开发", tone: "todo" },
  in_progress: { label: "进行中", tone: "progress" },
  in_review: { label: "审核中", tone: "review" },
  pending_retrospective: { label: "待复盘", tone: "retrospective" },
  done: { label: "完成", tone: "done" },
  blocked: { label: "待解决", tone: "blocked" },
  canceled: { label: "已取消", tone: "canceled" },
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  return <LinearStatusIcon status={status} />;
}

interface BoardColumnProps {
  status: TaskStatus;
  statusIndex: number;
  tasks: Task[];
  allTasks: Task[];
  interventionView: TaskInterventionView | null;
  projectNames: Map<string, string> | null;
  allowBoardActions: boolean;
  allowColumnActions: boolean;
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenThread: (threadId: string) => void;
  onHide: (status: TaskStatus) => void;
}

export function BoardColumn({
  status,
  statusIndex,
  tasks,
  allTasks,
  interventionView,
  projectNames,
  allowBoardActions,
  allowColumnActions,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  onCreate,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenThread,
  onHide,
}: BoardColumnProps) {
  const details = STATUS_DETAILS[status];
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragRef = useRef<{ container: HTMLElement; clientY: number } | null>(null);
  const dropCardsRef = useRef<HTMLElement[] | null>(null);
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
    if (!isDropTarget || !draggedTaskId) {
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      pendingDragRef.current = null;
      dropCardsRef.current = null;
      setDropBeforeTaskId(undefined);
    }
  }, [draggedTaskId, isDropTarget]);

  useEffect(() => () => {
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    if (!dropCardsRef.current) {
      dropCardsRef.current = Array.from(
        container.querySelectorAll<HTMLElement>("[data-task-id]"),
      ).filter((card) => card.dataset.taskId !== draggedTaskId);
    }
    return dropCardsRef.current
      .find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function scheduleDragPreview(container: HTMLElement, clientY: number) {
    pendingDragRef.current = { container, clientY };
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const pending = pendingDragRef.current;
      pendingDragRef.current = null;
      if (!pending) return;
      const nextTaskId = findDropBefore(pending.container, pending.clientY);
      setDropBeforeTaskId((current) => current === nextTaskId ? current : nextTaskId);
    });
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    pendingDragRef.current = null;
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    dropCardsRef.current = null;
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
      onDragEnter={allowBoardActions ? () => {
        if (!isDropTarget) onDragEnter(status);
      } : undefined}
      onDragOver={allowBoardActions ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!isDropTarget) onDragEnter(status);
        scheduleDragPreview(event.currentTarget, event.clientY);
      } : undefined}
      onDragLeave={allowBoardActions ? (event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
          dragFrameRef.current = null;
          pendingDragRef.current = null;
          dropCardsRef.current = null;
          setDropBeforeTaskId(undefined);
        }
      } : undefined}
      onDrop={allowBoardActions ? handleDrop : undefined}
    >
      <header className="column-header">
        <div className="column-heading">
          <span className={`status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} />
          </span>
          <h2 id={`column-${status}`}>{details.label}</h2>
          <span className="task-count" aria-label={`${tasks.length} 个议题`}>{tasks.length}</span>
        </div>
        <div className="column-actions">
          {allowColumnActions && tasks.length > 0 && (
            <ColumnVisibilityMenu
              label={details.label}
              action="hide"
              className="icon-button column-menu"
              onAction={() => onHide(status)}
            />
          )}
          {allowColumnActions && <button
            type="button"
            className="icon-button add-task-button"
            onClick={() => onCreate(status)}
            aria-label={`在${details.label}中新建议题`}
            title={`添加到${details.label}`}
          >
            <LinearIcon name="plus" />
          </button>}
        </div>
      </header>

      <div className="column-list">
        {tasks.map((task) => {
          const dragShift = getTaskDragShift(task);
          return (
            <TaskCard
              key={task.id}
              task={task}
              allTasks={allTasks}
              interventionView={interventionView}
              projectName={projectNames?.get(task.projectId)}
              allowBoardActions={allowBoardActions}
              statusIndex={statusIndex}
              isDragging={draggedTaskId === task.id}
              dragShift={dragShift}
              isMoving={movingTaskId === task.id}
              isSettling={settlingTaskId === task.id}
              isContextMenuOpen={contextMenuTaskId === task.id}
              onEdit={onEdit}
              onContextMenu={onContextMenu}
              onMove={onMove}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpenThread={onOpenThread}
            />
          );
        })}
      </div>
    </section>
  );
}
