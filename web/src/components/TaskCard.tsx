import type { MouseEvent } from "react";
import {
  TASK_STATUSES,
  type Task,
  type TaskInterventionView,
  type TaskPriority,
  type TaskStatus,
} from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { taskIntervention } from "../taskIntervention";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "积压事项",
  todo: "待开发",
  blocked: "待解决",
  in_progress: "进行中",
  in_review: "审核中",
  pending_retrospective: "待复盘",
  done: "完成",
  canceled: "已取消",
};

function sequenceSummary(issues: Task["relations"]["blockedBy"]): string {
  if (issues.length === 0) return "无";
  return issues
    .map((issue) => `${issue.identifier}（${STATUS_LABELS[issue.status]}）`)
    .join("、");
}

function sequenceTitle(issues: Task["relations"]["blockedBy"]): string | undefined {
  if (issues.length === 0) return undefined;
  return issues
    .map((issue) => `${issue.identifier} · ${issue.title} · ${STATUS_LABELS[issue.status]}`)
    .join("\n");
}

function statusProgressSummary(issues: Task["relations"]["subIssues"]): string {
  const counts = new Map<TaskStatus, number>();
  for (const issue of issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  const completed = (counts.get("pending_retrospective") ?? 0) + (counts.get("done") ?? 0);
  const details: Array<[TaskStatus, string]> = [
    ["in_progress", "进行中"],
    ["in_review", "审核中"],
    ["blocked", "待解决"],
    ["todo", "待开发"],
    ["backlog", "积压事项"],
    ["canceled", "已取消"],
  ];
  return [
    `${completed}/${issues.length} 已完成`,
    ...details.flatMap(([status, label]) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? [`${count} ${label}`] : [];
    }),
  ].join(" · ");
}

function firstOrderedSubIssues(parent: Task, allTasks: Task[]): Task[] {
  const childIds = new Set(
    parent.relations.subIssues.filter((issue) => issue.archivedAt === null).map((issue) => issue.id),
  );
  const unfinished = allTasks.filter((issue) => (
    childIds.has(issue.id)
    && !["pending_retrospective", "done", "canceled"].includes(issue.status)
  ));
  const unfinishedIds = new Set(unfinished.map((issue) => issue.id));
  return unfinished
    .filter((issue) => issue.relations.blockedBy.every((blocker) => (
      ["pending_retrospective", "done", "canceled"].includes(blocker.status)
    )))
    .sort((left, right) => {
      const leftContinuesSequence = left.relations.blocks.some((issue) => unfinishedIds.has(issue.id));
      const rightContinuesSequence = right.relations.blocks.some((issue) => unfinishedIds.has(issue.id));
      if (leftContinuesSequence !== rightContinuesSequence) return leftContinuesSequence ? -1 : 1;
      return left.createdAt.localeCompare(right.createdAt) || left.identifier.localeCompare(right.identifier);
    })
    .slice(0, 2);
}

interface TaskCardProps {
  task: Task;
  allTasks: Task[];
  interventionView: TaskInterventionView | null;
  projectName?: string;
  allowBoardActions: boolean;
  statusIndex: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
}

export function TaskCard({
  task,
  allTasks,
  interventionView,
  projectName,
  allowBoardActions,
  statusIndex,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
}: TaskCardProps) {
  const dueDate = task.dueDate
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : null;
  const subIssueTotal = task.relations.subIssues.length;
  const completedSubIssues = task.relations.subIssues.filter(
    (issue) => issue.status === "pending_retrospective" || issue.status === "done",
  ).length;
  const activeBlockers = task.relations.blockedBy.filter((issue) => (
    issue.status !== "pending_retrospective" && issue.status !== "done" && issue.status !== "canceled"
  )).length;
  const intervention = taskIntervention(task);
  const interventionReason = interventionView
    ? intervention.reasons.find((reason) => reason.view === interventionView) ?? null
    : intervention.primary;
  const agentProgress = intervention.progress ?? (
    task.readinessReview?.status === "running"
      ? { label: "Agent 审核中", action: "当前无需你处理" }
      : null
  );
  const parentTask = task.relations.parent;
  const isSubIssue = parentTask !== null;
  const isParentIssue = subIssueTotal > 0;
  const orderedSubIssues = firstOrderedSubIssues(task, allTasks);
  const blockedSubIssueSummary = orderedSubIssues.length === 0
    ? "无"
    : `先完成 ${orderedSubIssues.map((issue) => issue.identifier).join("、")}`;

  function stopThen(callback: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      callback();
    };
  }

  return (
    <article
      className={`task-card priority-${task.priority}${interventionReason ? " has-intervention" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={allowBoardActions && !isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={allowBoardActions ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      } : undefined}
      onDragStart={allowBoardActions ? (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      } : undefined}
      onDragEnd={allowBoardActions ? onDragEnd : undefined}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          {isSubIssue && <span className="task-level-chip is-child">子任务</span>}
          {!isSubIssue && isParentIssue && <span className="task-level-chip is-parent">主任务</span>}
          <span className="task-identifier">{task.identifier}</span>
          {projectName && <span className="project-chip" title={`所属项目：${projectName}`}>{projectName}</span>}
        </span>
        <ActorAvatar actor={task.assignee} className="card-assignee-avatar" />
        {allowBoardActions && <div className="card-actions" aria-label="移动议题">
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === 0 || isMoving}
            aria-label="移到上一状态"
            title="移到上一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex - 1]))}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === TASK_STATUSES.length - 1 || isMoving}
            aria-label="移到下一状态"
            title="移到下一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex + 1]))}
          >
            <LinearIcon name="chevronRight" />
          </button>
        </div>}
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {!isSubIssue && isParentIssue && (
        <dl className="task-sequence task-parent-summary" aria-label="主任务进度与卡点">
          <div>
            <dt>当前进度</dt>
            <dd>{statusProgressSummary(task.relations.subIssues)}</dd>
          </div>
          <div>
            <dt>当前卡点</dt>
            <dd title={sequenceTitle(orderedSubIssues)}>{blockedSubIssueSummary}</dd>
          </div>
        </dl>
      )}

      {parentTask && (
        <dl className="task-sequence" aria-label="子任务执行关系">
          <div>
            <dt>父任务</dt>
            <dd title={`${parentTask.identifier} · ${parentTask.title}`}>
              <strong>{parentTask.identifier}</strong>
              <span>{parentTask.title}</span>
            </dd>
          </div>
          <div>
            <dt>上一步</dt>
            <dd title={sequenceTitle(task.relations.blockedBy)}>
              {sequenceSummary(task.relations.blockedBy)}
            </dd>
          </div>
          <div>
            <dt>下一步</dt>
            <dd title={sequenceTitle(task.relations.blocks)}>
              {sequenceSummary(task.relations.blocks)}
            </dd>
          </div>
        </dl>
      )}

      {interventionReason ? (
        <button
          className="task-intervention-chip"
          type="button"
          aria-label={`${interventionReason.label}：${interventionReason.action}`}
          title={`${interventionReason.label}：${interventionReason.action}`}
          onClick={stopThen(() => onEdit(task))}
        >
          <LinearIcon name="hand" />
          <span>
            <strong>{interventionReason.label}</strong>
            <small>{interventionReason.action}</small>
          </span>
        </button>
      ) : agentProgress ? (
        <button
          className="task-intervention-chip is-processing"
          type="button"
          aria-label={`${agentProgress.label}：${agentProgress.action}`}
          title={`${agentProgress.label}：${agentProgress.action}`}
          onClick={stopThen(() => onEdit(task))}
        >
          <LinearIcon name="conversation" />
          <span>
            <strong>{agentProgress.label}</strong>
            <small>{agentProgress.action}</small>
          </span>
        </button>
      ) : null}

      <div className="card-properties" aria-label="议题属性">
        <span className={`priority-icon priority-icon-${task.priority}`} title={PRIORITY_LABELS[task.priority]}>
          <LinearPriorityIcon priority={task.priority} />
        </span>
        {activeBlockers > 0 && (
          <span className="blocked-by-count" title={`被 ${activeBlockers} 个未完成议题阻塞`}>
            <LinearIcon name="alert" />
            {activeBlockers}
          </span>
        )}
        {subIssueTotal > 0 && (
          <span className="sub-issue-progress-chip" title={`${completedSubIssues}/${subIssueTotal} 个子议题已完成`}>
            <span className="sub-issue-progress" aria-hidden="true" />
            {completedSubIssues}/{subIssueTotal}
          </span>
        )}
        {task.reworkRound && (
          <span className="rework-round-chip" title={`当前处于第 ${task.reworkRound} 轮返工`}>
            ↩ 返工 #{task.reworkRound}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span className="label-chip" key={label}>{label}</span>
        ))}
        {task.labels.length > 2 && (
          <span className="label-more" title={task.labels.slice(2).join(", ")}>+{task.labels.length - 2}</span>
        )}
        {dueDate && (
          <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
            <LinearIcon name="calendar" /> {dueDate}
          </span>
        )}
        {task.threadId && (
          <button
            className="thread-link"
            type="button"
            aria-label={`查看对话 ${task.threadId}`}
            title={`查看对话 ${task.threadId}`}
            onClick={stopThen(() => onOpenThread(task.threadId!))}
          >
            <LinearIcon name="conversation" />
          </button>
        )}
      </div>
    </article>
  );
}
