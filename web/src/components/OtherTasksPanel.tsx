import { useEffect, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { ActorIdentity, Task, TaskDraft, TaskStatus } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { OtherTaskTab } from "../issueBoardStatuses";
import { LinearIcon } from "./LinearIcon";
import { DeleteIcon, PlusIcon, RefreshIcon, StatusIcon } from "./SemanticIcons";
import { TaskCard } from "./TaskCard";

function archivedDate(
  value: string | null,
  locale: string,
  text: (chinese: string, english: string) => string,
) {
  if (!value) return "";
  const formatted = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(value));
  return text(`${formatted}归档`, `Archived ${formatted}`);
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
  const { language, locale, text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  return (
    <article className={`task-card task-card-sidebar archived-task-card status-${task.status}`}>
      <div className="card-topline">
        <span className="task-identifier">ID: {displayIdentifier}</span>
        <span className="archived-task-date">{archivedDate(task.archivedAt, locale, text)}</span>
      </div>
      <h3>{task.title}</h3>
      <div className="archived-task-footer">
        <span className="archived-task-status">
          <StatusIcon status={task.status} size={14} />
          {taskStatusLabel(language, task.status)}
        </span>
        {task.source !== "jira" && (
          <>
            <button
              className="archived-task-action archived-task-restore"
              type="button"
              disabled={busy}
              onClick={() => onRestore(task)}
            >
              <RefreshIcon color="currentColor" />
              {restoring ? text("恢复中…", "Restoring…") : text("恢复", "Restore")}
            </button>
            <button
              className="archived-task-action archived-task-delete"
              type="button"
              aria-label={text(`永久删除 ${displayIdentifier}`, `Permanently delete ${displayIdentifier}`)}
              title={text("永久删除", "Delete permanently")}
              disabled={busy}
              onClick={() => onDelete(task)}
            >
              <DeleteIcon color="currentColor" />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

interface ArchivedTasksColumnProps {
  tasks: Task[];
  hasActiveFilters: boolean;
  restoringTaskId: string | null;
  deletingTaskId: string | null;
  onRestore: (task: Task) => void;
  onDelete: (task: Task) => void;
}

export function ArchivedTasksColumn({
  tasks,
  hasActiveFilters,
  restoringTaskId,
  deletingTaskId,
  onRestore,
  onDelete,
}: ArchivedTasksColumnProps) {
  const { text } = useTaskboardI18n();
  return (
    <section className="board-column status-archived" aria-labelledby="column-archived">
      <header className="column-header">
        <div className="column-heading">
          <span className="column-status-icon">
            <DeleteIcon color="var(--column-status-color)" size={14} />
          </span>
          <h2 id="column-archived">
            {text("已归档", "Archived")}{tasks.length > 0 ? ` ${tasks.length}` : ""}
          </h2>
        </div>
      </header>
      <div className="column-list">
        {tasks.map((task) => (
          <ArchivedTaskCard
            key={task.id}
            task={task}
            busy={restoringTaskId !== null || deletingTaskId !== null}
            restoring={restoringTaskId === task.id}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        ))}
        {tasks.length === 0 && (
          <div className="column-empty">
            {hasActiveFilters
              ? text("当前筛选下无匹配议题", "No issues match the current filters")
              : text("没有已归档议题。", "There are no archived issues.")}
          </div>
        )}
      </div>
    </section>
  );
}

interface OtherTasksPanelProps {
  open: boolean;
  activeTab: OtherTaskTab;
  tabs: readonly OtherTaskTab[];
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
  projectNames?: Record<string, string>;
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  onCreateLabel: (label: string, projectId?: string) => Promise<void>;
  restoringTaskId: string | null;
  deletingTaskId: string | null;
  onTabChange: (tab: OtherTaskTab) => void;
  onCreate?: (status: Exclude<OtherTaskTab, "archived">) => void;
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
  tabs,
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
  projectNames,
  currentUser,
  showCover,
  showBody,
  onCreateLabel,
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
  const { language, text } = useTaskboardI18n();
  const archived = activeTab === "archived";
  const activeLabel = archived
    ? text("已归档", "Archived")
    : taskStatusLabel(language, activeTab);
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
      aria-label={text("其他任务", "Other issues")}
      aria-hidden={!open}
    >
      <div
        className="other-tasks-tabs"
        role="tablist"
        aria-label={text("其他任务状态", "Other issue statuses")}
        style={{ "--other-task-tab-count": tabs.length } as CSSProperties}
      >
        {tabs.map((tab) => {
          const label = tab === "archived"
            ? text("已归档", "Archived")
            : taskStatusLabel(language, tab);
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
              <span className="other-tasks-tab-count" aria-label={text(`${count} 个议题`, `${count} issues`)}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {!archived && onCreate && (
        <button
          className="other-tasks-add"
          type="button"
          aria-label={text(`在${activeLabel}中新建议题`, `Create issue in ${activeLabel}`)}
          title={text(`添加到${activeLabel}`, `Add to ${activeLabel}`)}
          onClick={() => onCreate(activeTab)}
        >
          <PlusIcon color="currentColor" size={11} />
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
              projectName={projectNames?.[task.projectId]}
              currentUser={currentUser}
              showCover={showCover}
              showBody={showBody}
              onCreateLabel={(label) => onCreateLabel(label, task.projectId)}
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
            {hasActiveFilters
              ? <LinearIcon name="search" />
              : archived
                ? <DeleteIcon color="currentColor" />
                : <LinearIcon name="panel" />}
            <strong>{hasActiveFilters
              ? text("当前筛选下无匹配议题", "No issues match the current filters")
              : text("暂无议题", "No issues")}</strong>
            <span>
              {hasActiveFilters
                ? text("搜索和筛选会同步作用于所有状态。", "Search and filters apply to every status.")
                : archived
                  ? text("没有已归档议题。", "There are no archived issues.")
                  : text(`没有${activeLabel}。`, `There are no issues in ${activeLabel}.`)}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
