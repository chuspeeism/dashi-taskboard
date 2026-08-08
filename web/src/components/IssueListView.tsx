import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { assigneeTargetForActor } from "../actors";
import { labelPresentation } from "../labels";
import type { TaskCardPresentation } from "../taskConversations";
import { TASK_PRIORITIES, TASK_STATUSES, type ActorIdentity, type Task, type TaskDraft, type TaskPriority, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const COLLAPSED_BY_DEFAULT = new Set<TaskStatus>(["backlog", "done", "canceled"]);

interface IssueListViewProps {
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  hasActiveFilters: boolean;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskCardPresentation["conversations"][number]) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
}

function createdDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function calendarDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function IssueListView({
  tasks,
  presentations,
  currentUser,
  hasActiveFilters,
  onOpenTask,
  onOpenConversation,
  onUpdate,
}: IssueListViewProps) {
  const [collapsed, setCollapsed] = useState(() => new Set(COLLAPSED_BY_DEFAULT));
  const [priorityMenuTaskId, setPriorityMenuTaskId] = useState<string | null>(null);

  function stopRow(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation();
  }

  function toggleStatus(status: TaskStatus) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="issue-list-view">
      <div className="issue-list-groups">
        {TASK_STATUSES.map((status) => {
          const statusTasks = tasks.filter((task) => task.status === status);
          const isCollapsed = collapsed.has(status);
          return (
            <section className={`issue-list-group status-${status}`} key={status}>
              <button className="issue-list-group-header" type="button" onClick={() => toggleStatus(status)} aria-expanded={!isCollapsed}>
                <LinearIcon name={isCollapsed ? "chevronRight" : "chevronDown"} />
                <span className="issue-list-status-icon"><StatusIcon status={status} /></span>
                <strong>{STATUS_DETAILS[status].label}</strong>
                <span>{statusTasks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="issue-list-rows">
                  {statusTasks.length ? statusTasks.map((task) => {
                    const assigneeTarget = assigneeTargetForActor(task.assignee, currentUser) ?? "current-user";
                    return (
                      <div
                        className={`issue-list-row${presentations[task.id]?.unread ? " is-unread" : ""}`}
                        role="button"
                        tabIndex={0}
                        key={task.id}
                        onClick={() => onOpenTask(task)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") onOpenTask(task);
                        }}
                      >
                        <span className="issue-list-title-cell">
                          <small>{task.identifier}</small>
                          <strong>{task.title}</strong>
                          {presentations[task.id]?.unread && <span className="task-unread-dot" aria-label="有未读更新" />}
                        </span>
                        <span className="issue-list-metadata" aria-label="议题属性">
                          <span className="issue-list-priority-control" onClick={stopRow} onKeyDown={stopRow}>
                            <TaskPropertyPicker
                              value={task.priority}
                              options={TASK_PRIORITIES.map((priority) => ({
                                value: priority,
                                label: PRIORITY_LABELS[priority],
                                icon: <LinearPriorityIcon priority={priority} />,
                                className: `priority-${priority}`,
                              }))}
                              open={priorityMenuTaskId === task.id}
                              className="issue-list-property-picker"
                              triggerClassName={`issue-list-priority priority-${task.priority}`}
                              ariaLabel={`${task.identifier} 优先级`}
                              onOpenChange={(open) => setPriorityMenuTaskId(open ? task.id : null)}
                              onChange={(priority) => void onUpdate(task, { priority }).catch(() => {})}
                            />
                          </span>
                          <span className="issue-list-labels">
                            {task.labels.slice(0, 2).map((label) => {
                              const presentation = labelPresentation(label);
                              return (
                                <i className={presentation.tone ? `tone-${presentation.tone}` : ""} key={label}>
                                  {presentation.tone && <span aria-hidden="true" />}
                                  <b>{presentation.name}</b>
                                </i>
                              );
                            })}
                            {task.labels.length > 2 && <b>+{task.labels.length - 2}</b>}
                          </span>
                          {task.dueDate && (
                            <label className="issue-list-date" onClick={stopRow}>
                              <TaskboardIcon name="calendar" />
                              <span>{calendarDate(task.dueDate)}</span>
                              <input
                                type="date"
                                aria-label={`${task.identifier} 截止日期`}
                                value={task.dueDate}
                                onChange={(event) => void onUpdate(task, {
                                  dueDate: event.target.value || null,
                                  ...(event.target.value ? {} : { recurrence: null }),
                                }).catch(() => {})}
                              />
                            </label>
                          )}
                          <TaskConversationMenu
                            conversations={presentations[task.id]?.conversations ?? []}
                            onOpenConversation={onOpenConversation}
                          />
                          <label className="issue-list-assignee" title={task.assignee.name} onClick={stopRow}>
                            <ActorAvatar actor={task.assignee} />
                            <select
                              aria-label={`${task.identifier} 负责人`}
                              value={assigneeTarget}
                              onChange={(event) => void onUpdate(task, { assigneeTarget: event.target.value as "current-user" | "codex-agent" }).catch(() => {})}
                            >
                              <option value="current-user">{currentUser.name}</option>
                              <option value="codex-agent">Codex Agent</option>
                            </select>
                          </label>
                        </span>
                        <time dateTime={task.createdAt} title={`创建于 ${new Date(task.createdAt).toLocaleString("zh-CN")}`}>
                          {createdDate(task.createdAt)}
                        </time>
                      </div>
                    );
                  }) : (
                    <div className="issue-list-empty">{hasActiveFilters ? "当前筛选下没有匹配议题" : `没有${STATUS_DETAILS[status].label}议题`}</div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
