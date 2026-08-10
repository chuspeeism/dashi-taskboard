import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { ActorIdentity, Task, TaskDraft, TaskStatus } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import {
  OTHER_TASK_TABS,
  type OtherTaskTab,
} from "../issueBoardStatuses";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";
import { TaskboardIcon } from "./TaskboardIcon";

const ARCHIVED_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

function archivedDate(value: string | null) {
  return value ? `${ARCHIVED_DATE_FORMATTER.format(new Date(value))}归档` : "";
}

interface ArchivedTaskCardProps {
  task: Task;
  busy: boolean;
  restoring: boolean;
  onRestore: (task: Task) => void;
  onDelete: (task: Task) => void;
}

function ArchivedTaskCard({
  task,
  busy,
  restoring,
  onRestore,
  onDelete,
}: ArchivedTaskCardProps) {
  return (
    <article className={`task-card task-card-sidebar archived-task-card status-${task.status}`}>
      <div className="card-topline">
        <span className="task-identifier">ID: {task.identifier}</span>
        <span className="archived-task-date">{archivedDate(task.archivedAt)}</span>
      </div>
      <h3>{task.title}</h3>
      <div className="archived-task-footer">
        <span className="archived-task-status">
          <LinearStatusIcon status={task.status} />
          {STATUS_DETAILS[task.status].label}
        </span>
        <button
          className="archived-task-action archived-task-restore"
          type="button"
          disabled={busy}
          onClick={() => onRestore(task)}
        >
          <LinearIcon name="recurrence" />
          {restoring ? "恢复中…" : "恢复"}
        </button>
        <button
          className="archived-task-action archived-task-delete"
          type="button"
          aria-label={`永久删除 ${task.identifier}`}
          title="永久删除"
          disabled={busy}
          onClick={() => onDelete(task)}
        >
          <LinearIcon name="trash" />
        </button>
      </div>
    </article>
  );
}

interface OtherTasksPanelProps {
  open: boolean;
  activeTab: OtherTaskTab;
  tasksByStatus: Record<TaskStatus, Task[]>;
  archivedTasks: Task[];
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
  restoringTaskId: string | null;
  deletingTaskId: string | null;
  onTabChange: (tab: OtherTaskTab) => void;
  onCreate: (status: Exclude<OtherTaskTab, "archived">) => void;
  onRestore: (task: Task) => void;
  onDelete: (task: Task) => void;
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
  activeTab,
  tasksByStatus,
  archivedTasks,
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
  restoringTaskId,
  deletingTaskId,
  onTabChange,
  onCreate,
  onRestore,
  onDelete,
  onEdit,
  onUpdate,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenConversation,
}: OtherTasksPanelProps) {
  const archived = activeTab === "archived";
  const tasks = archived ? archivedTasks : tasksByStatus[activeTab];
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
    if (archived) return;
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(activeTab, taskId, findDropBefore(event.currentTarget, event.clientY));
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
        {OTHER_TASK_TABS.map((tab) => {
          const label = tab === "archived" ? "已归档" : STATUS_DETAILS[tab].label;
          const count = tab === "archived" ? archivedTasks.length : tasksByStatus[tab].length;
          const selected = tab === activeTab;
          return (
            <button
              className={`other-tasks-tab${selected ? " is-active" : ""}`}
              id={`other-tasks-tab-${tab}`}
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="other-tasks-list"
              title={`${label} ${count}`}
              onClick={() => onTabChange(tab)}
            >
              <span className="other-tasks-tab-label">{label}</span>
              <span className="other-tasks-tab-count" aria-label={`${count} 个议题`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {!archived && (
        <button
          className="other-tasks-add"
          type="button"
          aria-label={`在${STATUS_DETAILS[activeTab].label}中新建议题`}
          title={`添加到${STATUS_DETAILS[activeTab].label}`}
          onClick={() => onCreate(activeTab)}
        >
          <TaskboardIcon name="sidebarAdd" />
        </button>
      )}

      <div
        className={`other-tasks-list${archived ? " is-archived" : ""}`}
        id="other-tasks-list"
        role="tabpanel"
        aria-labelledby={`other-tasks-tab-${activeTab}`}
        onDragEnter={() => {
          if (!archived) onDragEnter(activeTab);
        }}
        onDragOver={(event) => {
          if (archived) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDragEnter(activeTab);
          setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            setDropBeforeTaskId(undefined);
          }
        }}
        onDrop={handleDrop}
      >
        {archived ? archivedTasks.map((task) => (
          <ArchivedTaskCard
            key={task.id}
            task={task}
            busy={restoringTaskId !== null || deletingTaskId !== null}
            restoring={restoringTaskId === task.id}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        )) : tasks.map((task) => {
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
            <LinearIcon name={hasActiveFilters ? "search" : archived ? "trash" : "panel"} />
            <strong>{hasActiveFilters ? "当前筛选下无匹配议题" : "暂无议题"}</strong>
            <span>
              {hasActiveFilters
                ? "搜索和筛选会同步作用于所有状态。"
                : archived
                  ? "没有已归档议题。"
                  : `没有${STATUS_DETAILS[activeTab].label}。`}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
