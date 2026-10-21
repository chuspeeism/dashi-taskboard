import type { DragEvent } from "react";
import { LINEAR_DEFINING_STATE, LINEAR_QA_WAITING_STATES, linearStatesForStatus } from "../../../shared/linear-states.mjs";
import { useTaskCardDragPreview } from "../useTaskCardDragPreview";
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
  // Linear early analysis: next sprint's issues, shown as a group at the top of To do.
  nextSprintTasks?: Task[];
  presentations: Record<string, TaskCardPresentation>;
  missingLabelIds?: ReadonlySet<string> | null;
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
  showCreatedAt: boolean;
  createEnabled?: boolean;
  isLinearProject?: boolean;
  // Linear board only: display-only Waiting for QA column (cards keep status in_progress).
  qaColumn?: boolean;
  // Linear board only: display-only Defining Requirements column (cards keep status backlog).
  definingColumn?: boolean;
  onCreateLabel: (label: string, projectId?: string) => Promise<void>;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete: (task: Task) => Promise<void>;
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
  nextSprintTasks = [],
  presentations,
  missingLabelIds = null,
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
  showCreatedAt,
  createEnabled = true,
  isLinearProject = false,
  qaColumn = false,
  definingColumn = false,
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
  const displayOnly = qaColumn || definingColumn;
  const label = qaColumn
    ? text("等待 QA", "Waiting for QA")
    : definingColumn
      ? text("需求定義", "Defining Requirements")
      : taskStatusLabel(language, status);
  const columnId = qaColumn ? "waiting_qa" : definingColumn ? "defining" : status;
  const linearStates = !isLinearProject
    ? []
    : qaColumn
      ? LINEAR_QA_WAITING_STATES
      : definingColumn
        ? [LINEAR_DEFINING_STATE]
        : linearStatesForStatus(status).filter((state) => !LINEAR_QA_WAITING_STATES.includes(state));
  const { findDropBefore, clearDropPreview, updateDropPreview, leaveDropPreview, getTaskDragShift } =
    useTaskCardDragPreview({ tasks, draggedTaskId, draggedTaskHeight, isDropTarget });

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    clearDropPreview();
  }

  return (
    <section
      className={`board-column status-${status}${displayOnly ? " is-qa-column" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      aria-labelledby={`column-${columnId}`}
      // QA and Defining Requirements states change only in Linear: these columns are not drop targets.
      {...(!displayOnly && {
        onDragEnter: () => onDragEnter(status),
        onDragOver: (event: DragEvent<HTMLElement>) => {
          onDragEnter(status);
          updateDropPreview(event);
        },
        onDragLeave: leaveDropPreview,
        onDrop: handleDrop,
      })}
    >
      <header className="column-header">
        <div className="column-heading">
          <span className={`column-status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} color="var(--column-status-color)" size={14} />
          </span>
          <h2 id={`column-${columnId}`}>
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
      {linearStates.length > 0 && (
        <p className="column-linear-states" title={text("映射到此列的 Linear 状态", "Linear states mapped to this column")}>
          {linearStates.join(" · ")}
        </p>
      )}

      <div className="column-list" ref={scrollRef}>
        {nextSprintTasks.length > 0 && (
          <div className="next-sprint-group" role="group" aria-label={text("下个 sprint · 准备中", "Next sprint · preparing")}>
            <p className="next-sprint-group-heading">
              {text("下个 sprint · 准备中", "Next sprint · preparing")}
              {` · ${nextSprintTasks[0].nextCycle?.name ?? `Cycle ${nextSprintTasks[0].nextCycle?.number}`}`}
            </p>
            {nextSprintTasks.map((task) => renderCard(task))}
          </div>
        )}
        {tasks.map((task) => renderCard(task))}
        {tasks.length === 0 && nextSprintTasks.length === 0 && <div className="column-empty">{emptyMessage}</div>}
      </div>
    </section>
  );

  function renderCard(task: Task) {
    const dragShift = getTaskDragShift(task.id);
    return (
      <TaskCard
        key={task.id}
        task={task}
        presentation={presentations[task.id]}
        missingSprintLabel={missingLabelIds?.has(task.id) === true}
        isDragging={draggedTaskId === task.id}
        dragShift={dragShift}
        isMoving={movingTaskId === task.id}
        isSettling={settlingTaskId === task.id}
        isContextMenuOpen={contextMenuTaskId === task.id}
        draggable={!displayOnly}
        availableLabels={availableLabels}
        projectName={projectNames?.[task.projectId]}
        currentUser={currentUser}
        showCover={showCover}
        showBody={showBody}
        showCreatedAt={showCreatedAt}
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
  }
}
