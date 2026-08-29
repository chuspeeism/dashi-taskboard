import { useEffect, useRef, useState } from "react";

import "./DashboardView.css";
import dueDoneIcon from "../assets/figma-taskboard/dashboard-due-done.svg";
import dueEditIcon from "../assets/figma-taskboard/dashboard-due-edit.svg";
import processingAnimation from "../assets/figma-taskboard/loading-16.svg";
import { getProjectSummary } from "../api";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { labelPresentation } from "../labels";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import type { ActorIdentity, ProjectSummary, Task } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { PriorityIcon } from "./SemanticIcons";
import { TaskConversationMenu } from "./TaskConversationMenu";

interface DashboardViewProps {
  projectId: string;
  projectCreatedAt: string | null;
  isAllProjects: boolean;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  animateSummary: boolean;
  onSummaryAnimationStart: (projectId: string) => void;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"] satisfies Task["priority"][];

const LABEL_COLORS = [
  "#5e6ad2",
  "#d25e5e",
  "#5eccd2",
  "#f9ac28",
  "#85d254",
  "#5482d2",
  "#bf49d7",
];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const STARTED_STATUSES = new Set<Task["status"]>([
  "in_progress",
  "in_review",
  "blocked",
]);

interface ProgressPoint {
  timestamp: number;
  scope: number;
  started: number;
  completed: number;
  completions: number;
}

interface ProgressForecast {
  optimisticAt: number;
  conservativeAt: number;
}

function chartDate(value: number, locale: string, referenceValue?: number) {
  const includeYear = referenceValue !== undefined
    && new Date(value).getFullYear() !== new Date(referenceValue).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    year: includeYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  }).format(value);
}

function taskStartValue(task: Task) {
  const createdAt = new Date(task.createdAt).getTime();
  if (task.startDate) return Math.max(createdAt, dayValue(task.startDate));
  if (task.status === "done") return createdAt;
  return Math.max(createdAt, new Date(task.updatedAt).getTime());
}

function buildProgressData(tasks: Task[], todayValue: number, projectCreatedAt: string | null) {
  const scopeTasks = tasks.filter((task) => task.status !== "canceled");
  const completedTasks = scopeTasks.filter((task) => task.status === "done");
  const activeStartedTasks = scopeTasks.filter((task) => STARTED_STATUSES.has(task.status));
  const startedTasks = scopeTasks.filter((task) => (
    task.status === "done" || STARTED_STATUSES.has(task.status)
  ));
  const projectStart = projectCreatedAt
    ? new Date(projectCreatedAt).getTime()
    : todayValue;
  const historyStart = Math.min(projectStart, todayValue);
  const interval = (todayValue - historyStart) / 12;
  const points = Array.from({ length: 13 }, (_, index): ProgressPoint => {
    const timestamp = index === 12 ? todayValue : historyStart + interval * index;
    const previousTimestamp = index === 0 ? historyStart - 1 : historyStart + interval * (index - 1);
    return {
      timestamp,
      scope: scopeTasks.filter((task) => new Date(task.createdAt).getTime() <= timestamp).length,
      started: startedTasks.filter((task) => taskStartValue(task) <= timestamp).length,
      completed: completedTasks.filter((task) => new Date(task.updatedAt).getTime() <= timestamp).length,
      completions: completedTasks.filter((task) => {
        const completedAt = new Date(task.updatedAt).getTime();
        return completedAt > previousTimestamp && completedAt <= timestamp;
      }).length,
    };
  });

  points[points.length - 1] = {
    ...points[points.length - 1],
    scope: scopeTasks.length,
    started: startedTasks.length,
    completed: completedTasks.length,
  };

  const remaining = scopeTasks.length - completedTasks.length;
  const recentStart = Math.max(historyStart, todayValue - 28 * DAY_MS);
  const recentCompletions = completedTasks.filter((task) => (
    new Date(task.updatedAt).getTime() >= recentStart
  )).length;
  const recentWeeks = Math.max(1, (todayValue - recentStart) / WEEK_MS);
  const elapsedWeeks = Math.max(1, (todayValue - historyStart) / WEEK_MS);
  const weeklyVelocity = recentCompletions > 0
    ? recentCompletions / recentWeeks
    : completedTasks.length / elapsedWeeks;
  const forecast = remaining > 0 && weeklyVelocity > 0
    ? {
        optimisticAt: todayValue + (remaining / (weeklyVelocity * 1.4)) * WEEK_MS,
        conservativeAt: todayValue + (remaining / (weeklyVelocity * .6)) * WEEK_MS,
      }
    : null;

  return {
    scope: scopeTasks.length,
    started: activeStartedTasks.length,
    completed: completedTasks.length,
    unstarted: Math.max(0, scopeTasks.length - startedTasks.length),
    points,
    forecast,
  } satisfies {
    scope: number;
    started: number;
    completed: number;
    unstarted: number;
    points: ProgressPoint[];
    forecast: ProgressForecast | null;
  };
}

function dateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayValue(value: string) {
  return new Date(`${value}T00:00:00`).getTime();
}

function shortDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function DashboardView({
  projectId,
  projectCreatedAt,
  isAllProjects,
  tasks,
  presentations,
  currentUser,
  animateSummary,
  onSummaryAnimationStart,
  onOpenTask,
  onOpenConversation,
}: DashboardViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [summaryLoadFailed, setSummaryLoadFailed] = useState(false);
  const [displayedSummary, setDisplayedSummary] = useState("");
  const [summaryTyping, setSummaryTyping] = useState(true);
  const [progressHoverIndex, setProgressHoverIndex] = useState<number | null>(null);
  const [animateSummaryOnMount] = useState(animateSummary);
  const summaryAnimationStartedRef = useRef(false);
  const summaryTypedRef = useRef(false);

  useEffect(() => {
    if (!animateSummaryOnMount || summaryAnimationStartedRef.current) return;
    summaryAnimationStartedRef.current = true;
    onSummaryAnimationStart(projectId);
  }, [animateSummaryOnMount, onSummaryAnimationStart, projectId]);

  useEffect(() => {
    if (isAllProjects) {
      setProjectSummary(null);
      setSummaryLoadFailed(false);
      return undefined;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setProjectSummary(null);
    setSummaryLoadFailed(false);

    async function loadSummary() {
      let delay = 60_000;
      try {
        const next = await getProjectSummary(projectId, controller.signal);
        if (disposed) return;
        setProjectSummary(next);
        setSummaryLoadFailed(false);
        if (next.refreshing) delay = 2_000;
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === "AbortError")) return;
        setSummaryLoadFailed(true);
      }
      if (!disposed) timer = setTimeout(loadSummary, delay);
    }

    void loadSummary();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [isAllProjects, projectId]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayValue = today.getTime();
  const rangeEnd = new Date(todayValue);
  rangeEnd.setMonth(rangeEnd.getMonth() + 3);
  const rangeEndValue = rangeEnd.getTime();
  const upcomingEnd = todayValue + 14 * 86_400_000;
  const activeTasks = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  const completedTasks = tasks.filter((task) => task.status === "done");
  const overdueTasks = activeTasks.filter((task) => task.dueDate && dayValue(task.dueDate) < todayValue);
  const runningTasks = tasks.filter((task) => presentations[task.id]?.processing.running);
  const upcomingTasks = activeTasks
    .filter((task) => task.dueDate && dayValue(task.dueDate) <= upcomingEnd)
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))
    .slice(0, 5);
  const completionRate = tasks.length
    ? Math.round((completedTasks.length / tasks.length) * 100)
    : 0;
  const aggregateCreatedAt = isAllProjects
    ? tasks.reduce<string | null>((earliest, task) => (
        !earliest || task.createdAt < earliest ? task.createdAt : earliest
      ), null)
    : null;
  const progressData = buildProgressData(
    tasks,
    todayValue,
    projectCreatedAt ?? aggregateCreatedAt,
  );
  const progressChart = (() => {
    const left = 0;
    const right = 426;
    const top = 28;
    const bottom = 227;
    const currentX = 294;
    const valueMaximum = Math.max(1, progressData.scope);
    const y = (value: number) => bottom - (value / valueMaximum) * (bottom - top);
    const points = progressData.points.map((point, index) => ({
      ...point,
      x: left + ((currentX - left) * index) / (progressData.points.length - 1),
    }));
    const path = (key: "scope" | "started" | "completed") => points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${y(point[key]).toFixed(2)}`)
      .join(" ");
    const completedPath = path("completed");
    const forecast = progressData.forecast
      ? {
          optimisticX: currentX + ((right - currentX)
            * (progressData.forecast.optimisticAt - todayValue))
            / (rangeEndValue - todayValue),
          conservativeX: currentX + ((right - currentX)
            * (progressData.forecast.conservativeAt - todayValue))
            / (rangeEndValue - todayValue),
        }
      : null;
    return {
      left,
      right,
      top,
      bottom,
      currentX,
      y,
      points,
      scopePath: `${path("scope")} L${right} ${y(progressData.scope).toFixed(2)}`,
      startedPath: path("started"),
      completedPath,
      completedArea: `${completedPath} L${currentX} ${bottom} L${left} ${bottom} Z`,
      forecast,
      maximumCompletions: Math.max(1, ...progressData.points.map((point) => point.completions)),
    };
  })();
  const hoveredProgressPoint = progressHoverIndex === null
    ? null
    : progressChart.points[progressHoverIndex];

  const roleContributionMap = new Map<string, { actor: Task["assignee"]; count: number }>();
  for (const task of tasks) {
    const key = `${task.assignee.type}:${task.assignee.id}`;
    const current = roleContributionMap.get(key);
    roleContributionMap.set(key, {
      actor: task.assignee,
      count: (current?.count ?? 0) + (task.status === "done" ? 1 : 0),
    });
  }
  const roleContributions = [...roleContributionMap.values()]
    .sort((left, right) => right.count - left.count);
  const completedTotal = Math.max(1, completedTasks.length);

  const priorityCounts = PRIORITIES.map((priority) => ({
    priority,
    label: taskPriorityLabel(language, priority),
    count: tasks.filter((task) => task.priority === priority).length,
  }));

  const labelCountMap = new Map<string, number>();
  for (const task of tasks) {
    for (const label of task.labels) {
      labelCountMap.set(label, (labelCountMap.get(label) ?? 0) + 1);
    }
  }
  const labelCounts = [...labelCountMap.entries()]
    .map(([label, count]) => ({
      label,
      count,
      sortName: labelPresentation(label).name,
      presentation: labelPresentation(label, language),
    }))
    .sort((left, right) => (
      right.count - left.count
      || left.sortName.localeCompare(right.sortName)
    ));
  const totalLabelAssignments = Math.max(
    1,
    labelCounts.reduce((total, item) => total + item.count, 0),
  );
  const visibleLabelCounts = (labelCounts.length > 12
    ? [
        ...labelCounts.slice(0, 11),
        {
          label: "__other__",
          count: labelCounts.slice(11).reduce((total, item) => total + item.count, 0),
          presentation: {
            ...labelPresentation("其他"),
            name: text(`其他（${labelCounts.length - 11}个）`, `Other (${labelCounts.length - 11})`),
          },
        },
      ]
    : labelCounts
  ).map((item, index) => ({
    ...item,
    color: item.label === "__other__" ? "var(--dashboard-other-label-color)" : LABEL_COLORS[index % LABEL_COLORS.length],
  }));
  const maximumVisibleLabelCount = Math.max(1, ...visibleLabelCounts.map((item) => item.count));

  const activityByDay = new Map<string, number>();
  for (const task of tasks) {
    const key = dateKey(new Date(task.activityUpdatedAt));
    activityByDay.set(key, (activityByDay.get(key) ?? 0) + 1);
  }
  const contributionStart = new Date(todayValue);
  contributionStart.setDate(contributionStart.getDate() - contributionStart.getDay() - 51 * 7);
  const contributionWeeks = Array.from({ length: 52 }, (_, weekIndex) => (
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(contributionStart);
      date.setDate(date.getDate() + weekIndex * 7 + dayIndex);
      const key = dateKey(date);
      return {
        date,
        key,
        count: activityByDay.get(key) ?? 0,
        future: date.getTime() > todayValue,
      };
    })
  ));
  const contributionMaximum = Math.max(1, ...contributionWeeks.flat().map((day) => day.count));
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short" });
  const contributionDateFormatter = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const monthMarkers = contributionWeeks.flatMap((week, weekIndex) => {
    const firstDay = week.find((day) => day.date.getDate() === 1);
    return firstDay ? [{ weekIndex, label: monthFormatter.format(firstDay.date) }] : [];
  });
  if (monthMarkers[0]?.weekIndex !== 0) {
    monthMarkers.unshift({ weekIndex: 0, label: monthFormatter.format(contributionStart) });
  }

  const attentionItems = activeTasks
    .filter((task) => task.status === "blocked" || presentations[task.id]?.unread)
    .sort((left, right) => {
      const leftUnread = presentations[left.id]?.unread ? 1 : 0;
      const rightUnread = presentations[right.id]?.unread ? 1 : 0;
      return rightUnread - leftUnread
        || right.activityUpdatedAt.localeCompare(left.activityUpdatedAt);
    })
    .slice(0, 5);

  const metrics = [
    {
      label: taskStatusLabel(language, "in_progress"),
      value: tasks.filter((task) => task.status === "in_progress").length,
      tone: "progress",
    },
    {
      label: taskStatusLabel(language, "in_review"),
      value: tasks.filter((task) => task.status === "in_review").length,
      tone: "review",
    },
    {
      label: taskStatusLabel(language, "blocked"),
      value: tasks.filter((task) => task.status === "blocked").length,
      tone: "blocked",
    },
    { label: text("已逾期", "Overdue"), value: overdueTasks.length, tone: "overdue" },
    {
      label: taskStatusLabel(language, "backlog"),
      value: tasks.filter((task) => task.status === "backlog").length,
      tone: "backlog",
    },
  ];

  const summaryBody = isAllProjects
    ? text(
        `所有项目共有 ${tasks.length} 个议题，${completedTasks.length} 个已完成，${activeTasks.length} 个尚未结束；当前 ${tasks.filter((task) => task.status === "blocked").length} 个遇到阻碍，${overdueTasks.length} 个已逾期。`,
        `Across all projects, ${tasks.length} issues are tracked: ${completedTasks.length} completed and ${activeTasks.length} still open; ${tasks.filter((task) => task.status === "blocked").length} are blocked and ${overdueTasks.length} overdue.`,
      )
    : projectSummary?.summary
      ?? (projectSummary?.refreshing
        ? text(
            "Codex 正在整理当前项目的进展、风险和下一步重点…",
            "Codex is reviewing the project's progress, risks, and next steps…",
          )
        : summaryLoadFailed || projectSummary?.error
          ? text("Codex 暂时无法生成项目总结。", "Codex cannot generate the project summary now.")
          : text(
              "Codex 正在整理当前项目的进展、风险和下一步重点…",
              "Codex is reviewing the project's progress, risks, and next steps…",
            ));
  const hour = new Date().getHours();
  const greeting = hour < 12
    ? text("上午好", "Good morning")
    : hour < 18
      ? text("下午好", "Good afternoon")
      : text("晚上好", "Good evening");
  const summaryDate = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(today);
  const summary = text(
    `${greeting}，${currentUser.name}，今天是${summaryDate}，${summaryBody}`,
    `${greeting}, ${currentUser.name}. Today is ${summaryDate}. ${summaryBody}`,
  );
  const summaryReady = isAllProjects || projectSummary !== null || summaryLoadFailed;

  useEffect(() => {
    if (!summaryReady) {
      setDisplayedSummary("");
      setSummaryTyping(animateSummaryOnMount);
      return undefined;
    }

    if (!animateSummaryOnMount || summaryTypedRef.current) {
      setDisplayedSummary(summary);
      setSummaryTyping(false);
      return undefined;
    }

    const characters = Array.from(summary);
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    summaryTypedRef.current = true;
    setDisplayedSummary("");
    setSummaryTyping(true);

    function typeNextCharacter() {
      index += 1;
      setDisplayedSummary(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        setSummaryTyping(false);
        return;
      }

      const character = characters[index - 1];
      const delay = /[。！？]/.test(character)
        ? 140
        : /[，；：]/.test(character)
          ? 80
          : character === " "
            ? 12
            : 26;
      timer = setTimeout(typeNextCharacter, delay);
    }

    timer = setTimeout(typeNextCharacter, 180);
    return () => clearTimeout(timer);
  }, [animateSummaryOnMount, projectId, summary, summaryReady]);

  return (
    <div className="dashboard-view">
      <div className="dashboard-content">
        <div className="dashboard-overview">
          <header className="dashboard-heading">
            <h1>{text("项目完成度", "Project completion")}</h1>
            <div className="dashboard-hero-value">
              <strong>{completionRate}%</strong>
              <span>{text(
                `${completedTasks.length} 个已完成 · ${activeTasks.length} 个尚未结束`,
                `${completedTasks.length} completed · ${activeTasks.length} remaining`,
              )}</span>
            </div>
          </header>

          <section className="dashboard-codex-summary" aria-label={text("Codex 项目总结", "Codex project summary")}>
            <div className="dashboard-summary-bubble">
              <p
                className={summaryTyping ? "is-typing" : undefined}
                aria-label={summaryReady ? summary : text("Codex 正在整理项目总结", "Codex is preparing the project summary")}
              >{displayedSummary}</p>
            </div>
            <img className="dashboard-codex-mark" src="codex-agent-logo.png" alt="" aria-hidden="true" />
          </section>
        </div>

        <div className="dashboard-metrics">
          {metrics.map((metric) => {
            const percent = activeTasks.length ? Math.round((metric.value / activeTasks.length) * 100) : 0;
            return (
              <article className={`dashboard-metric tone-${metric.tone}`} key={metric.label}>
                <span className="dashboard-metric-label">{metric.label}</span>
                <div className="dashboard-metric-value">
                  <strong>{metric.value}</strong>
                  <b>{percent}%</b>
                </div>
                <span className="dashboard-metric-meter" aria-hidden="true">
                  <i style={{ width: `${percent}%` }} />
                </span>
              </article>
            );
          })}
        </div>

        <div className="dashboard-analysis-heading">
          <h2>{text("项目分析", "Project analysis")}</h2>
        </div>

        <div className="dashboard-grid">
          <section className="dashboard-panel dashboard-primary-panel dashboard-priority-panel">
            <header><span>{text("优先级", "Priority")}</span></header>
            <div className="dashboard-priority-list">
              {priorityCounts.map((item) => (
                <div className={`dashboard-priority-row priority-${item.priority}`} key={item.priority}>
                  <span className="dashboard-priority-name">
                    <PriorityIcon priority={item.priority} size={13} />
                    {item.label}
                  </span>
                  <span className="dashboard-priority-track">
                    <i style={{ width: `${tasks.length ? (item.count / tasks.length) * 100 : 0}%` }} />
                  </span>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="dashboard-panel dashboard-primary-panel dashboard-attention-panel">
            <header><span>{text("需要关注（未读、阻塞）", "Needs attention (unread, blocked)")}</span></header>
            <div className="dashboard-task-list">
              {attentionItems.length ? attentionItems.map((task) => (
                <button
                  type="button"
                  className="dashboard-attention-row"
                  onClick={() => onOpenTask(task)}
                  key={task.id}
                >
                  <span className="dashboard-attention-mark" aria-hidden="true"><i /></span>
                  <strong>{task.title}</strong>
                  <small>ID: {task.externalKey ?? task.identifier}</small>
                </button>
              )) : (
                <div className="dashboard-empty">{text("当前没有需要关注的议题", "No issues need attention")}</div>
              )}
            </div>
          </section>

          <section className="dashboard-panel dashboard-primary-panel dashboard-running-panel">
            <header><span>{text("运行中对话", "Active conversations")}</span></header>
            <div className="dashboard-task-list">
              {runningTasks.length ? runningTasks.map((task) => (
                <article
                  className="dashboard-running-card"
                  key={task.id}
                  onClick={() => onOpenTask(task)}
                >
                  <button
                    type="button"
                    className="dashboard-running-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenTask(task);
                    }}
                  >
                    <small>ID: {task.externalKey ?? task.identifier}</small>
                    <strong>{task.title}</strong>
                  </button>
                  <div className="dashboard-running-footer">
                    <span className="task-processing is-running">
                      <img className="task-processing-glyph" src={processingAnimation} alt="" aria-hidden="true" />
                      <span className="task-processing-label">{text("正在处理…", "Processing…")}</span>
                    </span>
                    <TaskConversationMenu
                      conversations={presentations[task.id].conversations}
                      onOpenConversation={onOpenConversation}
                    />
                  </div>
                </article>
              )) : (
                <div className="dashboard-empty">{text("当前没有运行中的对话", "No active conversations")}</div>
              )}
            </div>
          </section>

          <section className="dashboard-panel dashboard-secondary-panel dashboard-role-panel">
            <header><span>{text("角色贡献", "Role contributions")}</span><b>{roleContributions.length}</b></header>
            {roleContributions.length ? (
              <div className="dashboard-role-body">
                <div className="dashboard-role-stack" aria-hidden="true">
                  {roleContributions.filter((item) => item.count > 0).map((item, index) => (
                    <i
                      className={`tone-${index % 5}`}
                      style={{ width: `${(item.count / completedTotal) * 100}%` }}
                      key={`${item.actor.type}:${item.actor.id}`}
                    />
                  ))}
                </div>
                <div className="dashboard-role-list">
                  {roleContributions.map((item, index) => (
                    <div className="dashboard-role-row" key={`${item.actor.type}:${item.actor.id}`}>
                      <ActorAvatar actor={item.actor} />
                      <span className="dashboard-role-copy">
                        <strong>{item.actor.name}</strong>
                        <small>{text(
                          `${item.count} 个已完成议题`,
                          `${item.count} completed ${item.count === 1 ? "issue" : "issues"}`,
                        )}</small>
                      </span>
                      <span className={`dashboard-role-share tone-${index % 5}`}>
                        {Math.round((item.count / completedTotal) * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="dashboard-empty">{text("当前没有角色数据", "No role data")}</div>
            )}
          </section>

          <section className="dashboard-panel dashboard-secondary-panel dashboard-contribution-panel">
            <header><span>{text("贡献图", "Contribution chart")}</span></header>
            <div className="dashboard-contribution-body">
              <div className="dashboard-contribution-chart">
                <div className="dashboard-contribution-months" aria-hidden="true">
                  {monthMarkers.map((marker) => (
                    <span
                      style={{ gridColumn: marker.weekIndex + 1 }}
                      key={`${marker.weekIndex}-${marker.label}`}
                    >
                      {marker.label}
                    </span>
                  ))}
                </div>
                <div className="dashboard-contribution-main">
                  <div className="dashboard-contribution-weekdays" aria-hidden="true">
                    <span style={{ gridRow: 2 }}>{text("一", "M")}</span>
                    <span style={{ gridRow: 4 }}>{text("三", "W")}</span>
                    <span style={{ gridRow: 6 }}>{text("五", "F")}</span>
                  </div>
                  <div className="dashboard-contribution-grid" aria-label={text("过去一年议题贡献图", "Issue contributions over the past year")}>
                    {contributionWeeks.flat().map((day) => {
                      const level = day.count === 0
                        ? 0
                        : Math.min(4, Math.ceil((day.count / contributionMaximum) * 4));
                      return (
                        <span
                          className={`dashboard-contribution-cell level-${level}${day.future ? " is-future" : ""}`}
                          title={day.future ? undefined : text(
                            `${contributionDateFormatter.format(day.date)} · ${day.count} 个议题更新`,
                            `${contributionDateFormatter.format(day.date)} · ${day.count} issue ${day.count === 1 ? "update" : "updates"}`,
                          )}
                          key={day.key}
                        />
                      );
                    })}
                  </div>
                </div>
                <div className="dashboard-contribution-legend" aria-label={text("贡献强度图例", "Contribution intensity legend")}>
                  <span>{text("少", "Less")}</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <i className={`dashboard-contribution-cell level-${level}`} key={level} />
                  ))}
                  <span>{text("多", "More")}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="dashboard-panel dashboard-tertiary-panel dashboard-upcoming-panel">
            <header><span>{text("即将到期", "Due soon")}</span></header>
            <div className="dashboard-task-list">
              {upcomingTasks.length ? upcomingTasks.map((task) => (
                <button
                  type="button"
                  className="dashboard-upcoming-row"
                  onClick={() => onOpenTask(task)}
                  key={task.id}
                >
                  <img
                    src={task.status === "in_review" ? dueDoneIcon : dueEditIcon}
                    alt=""
                    aria-hidden="true"
                  />
                  <strong>{task.title}</strong>
                  <time>ID: {task.externalKey ?? task.identifier} | {shortDate(task.dueDate!, locale)}</time>
                </button>
              )) : (
                <div className="dashboard-empty">{text("近期没有到期议题", "No issues are due soon")}</div>
              )}
            </div>
          </section>

          <section className="dashboard-panel dashboard-tertiary-panel dashboard-label-panel">
            <header><span>{text("标签分布", "Label distribution")} {Math.min(12, labelCounts.length)}</span></header>
            {visibleLabelCounts.length ? (
              <div className="dashboard-label-chart">
                {visibleLabelCounts.map((item) => (
                  <div className="dashboard-label-chart-row" key={item.label}>
                    <strong>{item.presentation.name}</strong>
                    <span>{Math.round((item.count / totalLabelAssignments) * 100)}% | <b>{item.count}</b></span>
                    <i
                      aria-hidden="true"
                      style={{
                        width: `${(item.count / maximumVisibleLabelCount) * 100}%`,
                        background: item.color,
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="dashboard-empty">{text("当前没有标签数据", "No label data")}</div>
            )}
          </section>

          <section className="dashboard-panel dashboard-tertiary-panel dashboard-progress-panel">
          <header className="dashboard-progress-header">
            <div className="dashboard-progress-title">
              <span>{text("优先级", "Priority")}</span>
            </div>
            <div className="dashboard-progress-legend">
              <span className="tone-scope"><i />{text("范围", "Scope")} <strong>{progressData.scope}</strong></span>
              <span className="tone-started"><i />{text("已开始", "Started")} <strong>{progressData.started}</strong></span>
              <span className="tone-completed"><i />{text("已完成", "Completed")} <strong>{progressData.completed}</strong></span>
            </div>
          </header>
          <div className="dashboard-progress-body">
            <svg
              className="dashboard-progress-chart"
              viewBox="0 0 426 272"
              role="img"
              aria-label={text(
                `项目累计进度：范围 ${progressData.scope}，已开始 ${progressData.started}，已完成 ${progressData.completed}`,
                `Cumulative project progress: scope ${progressData.scope}, started ${progressData.started}, completed ${progressData.completed}`,
              )}
            >
              <defs>
                <linearGradient id="dashboard-progress-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#22b889" stopOpacity=".18" />
                  <stop offset="1" stopColor="#22b889" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="dashboard-progress-forecast-area" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#22b889" stopOpacity=".11" />
                  <stop offset="1" stopColor="#22b889" stopOpacity=".025" />
                </linearGradient>
              </defs>

              <line
                className="dashboard-progress-baseline"
                x1={progressChart.left}
                y1={progressChart.bottom}
                x2={progressChart.right}
                y2={progressChart.bottom}
              />
              <path className="dashboard-progress-completed-area" d={progressChart.completedArea} />
              {progressChart.forecast ? (
                <path
                  className="dashboard-progress-forecast-area"
                  d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.optimisticX} ${progressChart.y(progressData.scope)} L${progressChart.forecast.conservativeX} ${progressChart.y(progressData.scope)} Z`}
                />
              ) : null}
              <path className="dashboard-progress-line tone-scope" d={progressChart.scopePath} />
              <path className="dashboard-progress-line tone-started" d={progressChart.startedPath} />
              <path className="dashboard-progress-line tone-completed" d={progressChart.completedPath} />
              {progressChart.forecast ? (
                <>
                  <path
                    className="dashboard-progress-projection"
                    d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.optimisticX} ${progressChart.y(progressData.scope)}`}
                  />
                  <path
                    className="dashboard-progress-projection"
                    d={`M${progressChart.currentX} ${progressChart.y(progressData.completed)} L${progressChart.forecast.conservativeX} ${progressChart.y(progressData.scope)}`}
                  />
                </>
              ) : null}

              {progressChart.points.slice(1).map((point, index) => {
                if (!point.completions) return null;
                const width = 4;
                const height = 8 + (point.completions / progressChart.maximumCompletions) * 20;
                return (
                  <rect
                    className="dashboard-progress-delivery-bar"
                    x={point.x - width / 2}
                    y={progressChart.bottom - height}
                    width={width}
                    height={height}
                    rx="2"
                    key={`${point.timestamp}-${index}`}
                  />
                );
              })}

              <line
                className="dashboard-progress-now-line"
                x1={progressChart.currentX}
                y1={progressChart.top - 4}
                x2={progressChart.currentX}
                y2={progressChart.bottom + 7}
              />
              <circle className="dashboard-progress-point tone-scope" cx={progressChart.currentX} cy={progressChart.y(progressData.scope)} r="4" />
              <circle className="dashboard-progress-point tone-started" cx={progressChart.currentX} cy={progressChart.y(progressData.completed + progressData.started)} r="4" />
              <circle className="dashboard-progress-point tone-completed" cx={progressChart.currentX} cy={progressChart.y(progressData.completed)} r="4" />

              {hoveredProgressPoint ? (
                <>
                  <line
                    className="dashboard-progress-hover-line"
                    x1={hoveredProgressPoint.x}
                    y1={progressChart.top - 2}
                    x2={hoveredProgressPoint.x}
                    y2={progressChart.bottom + 5}
                  />
                  <g
                    className="dashboard-progress-tooltip"
                    transform={`translate(${hoveredProgressPoint.x > progressChart.right - 172 ? hoveredProgressPoint.x - 172 : hoveredProgressPoint.x + 10} 8)`}
                  >
                    <rect width="162" height="80" rx="9" />
                    <text className="dashboard-progress-tooltip-date" x="12" y="20">
                      {chartDate(hoveredProgressPoint.timestamp, locale)}
                    </text>
                    <text x="12" y="40">{text("范围", "Scope")} {hoveredProgressPoint.scope}</text>
                    <text x="12" y="58">{text("已开始", "Started")} {Math.max(0, hoveredProgressPoint.started - hoveredProgressPoint.completed)}</text>
                    <text x="88" y="58">{text("已完成", "Completed")} {hoveredProgressPoint.completed}</text>
                    <text className="dashboard-progress-tooltip-delta" x="88" y="40">
                      Δ {hoveredProgressPoint.scope - (progressChart.points[Math.max(0, progressHoverIndex! - 1)]?.scope ?? hoveredProgressPoint.scope)}
                    </text>
                  </g>
                </>
              ) : null}

              {progressChart.points.map((point, index) => {
                const hitWidth = (progressChart.currentX - progressChart.left) / (progressChart.points.length - 1);
                return (
                  <rect
                    className="dashboard-progress-hitbox"
                    x={Math.max(progressChart.left, point.x - hitWidth / 2)}
                    y={progressChart.top - 6}
                    width={index === 0 || index === progressChart.points.length - 1 ? hitWidth / 2 : hitWidth}
                    height={progressChart.bottom - progressChart.top + 16}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    aria-label={text(
                      `${chartDate(point.timestamp, locale)}：范围 ${point.scope}，已开始 ${Math.max(0, point.started - point.completed)}，已完成 ${point.completed}`,
                      `${chartDate(point.timestamp, locale)}: scope ${point.scope}, started ${Math.max(0, point.started - point.completed)}, completed ${point.completed}`,
                    )}
                    onMouseEnter={() => setProgressHoverIndex(index)}
                    onMouseLeave={() => setProgressHoverIndex(null)}
                    onFocus={() => setProgressHoverIndex(index)}
                    onBlur={() => setProgressHoverIndex(null)}
                    onClick={() => setProgressHoverIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setProgressHoverIndex(index);
                    }}
                    key={`${point.timestamp}-${index}`}
                  />
                );
              })}

              <text className="dashboard-progress-axis-label" x={progressChart.left} y="260">
                {chartDate(progressChart.points[0].timestamp, locale)}
              </text>
              <text className="dashboard-progress-axis-label is-current" x={progressChart.currentX} y="260" textAnchor="middle">
                {chartDate(todayValue, locale)}
              </text>
              <text className="dashboard-progress-axis-label" x={progressChart.right} y="260" textAnchor="end">
                {chartDate(rangeEndValue, locale, todayValue)}
              </text>
            </svg>
          </div>
          </section>
        </div>
      </div>
    </div>
  );
}
