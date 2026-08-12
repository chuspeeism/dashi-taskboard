import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, type GanttStatic, type Task as GanttTask } from "dhtmlx-gantt";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import type { Task, TaskDraft } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";
import { taskboardIconSource } from "./TaskboardIcon";

type GanttZoom = "day" | "week" | "month";

interface GanttGroupDefinition {
  id: string;
  chineseLabel: string;
  englishLabel: string;
  statuses: Task["status"][];
  defaultOpen: boolean;
}

interface TaskboardGanttTask extends GanttTask {
  taskboardStatus: Task["status"];
  taskboardTitle: string;
  taskboardUnread: boolean;
  taskboardAssigneeType: Task["assignee"]["type"] | null;
  taskboardAssigneeName: string;
  taskboardAssigneeAvatarUrl: string | null;
  taskboardAssigneeInitial: string;
  taskboardGroup: boolean;
  taskboardCount: number;
}

interface GanttViewProps {
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  hasActiveFilters: boolean;
  zoom: GanttZoom;
  hideCompleted: boolean;
  todayRequest: number;
  onOpenTask: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
}

let pendingDetailViewport: { projectId: string; x: number; y: number } | null = null;

const GANTT_GROUPS: GanttGroupDefinition[] = [
  { id: "in-progress", chineseLabel: "处理中", englishLabel: "In progress", statuses: ["in_progress"], defaultOpen: true },
  { id: "in-review", chineseLabel: "等你确认", englishLabel: "In review", statuses: ["in_review"], defaultOpen: true },
  { id: "blocked", chineseLabel: "遇到阻碍", englishLabel: "Blocked", statuses: ["blocked"], defaultOpen: true },
  { id: "todo", chineseLabel: "待处理", englishLabel: "To do", statuses: ["backlog", "todo"], defaultOpen: true },
  { id: "done", chineseLabel: "已完成", englishLabel: "Completed", statuses: ["done"], defaultOpen: false },
  { id: "canceled", chineseLabel: "已取消", englishLabel: "Canceled", statuses: ["canceled"], defaultOpen: false },
];

function localDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function dateValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ganttDate(value: Date, locale: string, includeYear = false) {
  return new Intl.DateTimeFormat(locale, {
    year: includeYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  }).format(value);
}

function taskProgress(task: Task, presentation: TaskCardPresentation | undefined) {
  const processing = presentation?.processing;
  if (processing?.total) return Math.min(1, (processing.completed ?? 0) / processing.total);
  if (task.status === "in_review" || task.status === "done") return 1;
  return 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[character]!));
}

function dateCellClass(date: Date) {
  const today = new Date();
  const classes: string[] = [];
  if (date.getDay() === 0 || date.getDay() === 6) classes.push("is-weekend");
  if (
    date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  ) classes.push("is-today");
  return classes.join(" ");
}

export function GanttView({ tasks, presentations, hasActiveFilters, zoom, hideCompleted, todayRequest, onOpenTask, onUpdate }: GanttViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const i18nRef = useRef({ language, locale, text });
  const containerRef = useRef<HTMLDivElement>(null);
  const ganttRef = useRef<GanttStatic | null>(null);
  const [gridCollapsed, setGridCollapsed] = useState(false);
  const [gridWidth, setGridWidth] = useState(360);
  const [todayMarkerLeft, setTodayMarkerLeft] = useState<number | null>(null);
  const gridCollapsedRef = useRef(false);
  const expandedGridWidthRef = useRef(360);
  const hasParsedDataRef = useRef(false);
  const tasksRef = useRef(tasks);
  const onOpenTaskRef = useRef(onOpenTask);
  const onUpdateRef = useRef(onUpdate);
  tasksRef.current = tasks;
  onOpenTaskRef.current = onOpenTask;
  onUpdateRef.current = onUpdate;
  i18nRef.current = { language, locale, text };

  const visibleTasks = useMemo(
    () => hideCompleted ? tasks.filter((task) => task.status !== "done" && task.status !== "canceled") : tasks,
    [hideCompleted, tasks],
  );
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = Gantt.getGanttInstance();
    ganttRef.current = instance;
    instance.config.date_format = "%Y-%m-%d";
    instance.config.xml_date = "%Y-%m-%d";
    instance.config.row_height = 58;
    instance.config.bar_height = 44;
    instance.config.scale_height = 66;
    instance.config.scroll_size = 1;
    instance.config.grid_width = 360;
    instance.config.min_column_width = 38;
    instance.config.drag_progress = false;
    instance.config.drag_links = false;
    instance.config.show_progress = true;
    instance.config.show_unscheduled = true;
    instance.config.smart_rendering = true;
    instance.config.details_on_dblclick = false;
    instance.config.round_dnd_dates = true;
    instance.config.select_task = false;
    instance.config.columns = [
      {
        name: "text",
        label: i18nRef.current.text("议题", "Issue"),
        tree: true,
        width: "*",
        min_width: 190,
        template: (item) => {
          const task = item as TaskboardGanttTask;
          if (task.taskboardGroup) {
            return `<div class="gantt-grid-group"><strong>${escapeHtml(task.taskboardTitle)}</strong><span>${task.taskboardCount}</span></div>`;
          }
          return `<div class="gantt-grid-issue"><strong>${escapeHtml(task.taskboardTitle)}</strong>${task.taskboardUnread ? `<i class="task-unread-dot" aria-label="${escapeHtml(i18nRef.current.text("有未读更新", "Unread updates"))}"></i>` : ""}</div>`;
        },
      },
    ];
    const dropdownIcon = taskboardIconSource("dropdown");
    instance.templates.grid_open = (item) => {
      const open = Boolean((item as GanttTask & { $open?: boolean }).$open);
      return `<div class="gantt_tree_icon gantt_${open ? "close" : "open"}"><img src="${dropdownIcon}" alt=""></div>`;
    };
    instance.templates.grid_folder = () => "";
    instance.templates.grid_file = () => "";
    instance.templates.grid_blank = () => "";
    instance.templates.task_class = (_start, _end, item) => {
      const task = item as TaskboardGanttTask;
      return task.taskboardGroup ? "gantt-group-task" : `gantt-status-${task.taskboardStatus}`;
    };
    instance.templates.task_text = (start, end, item) => {
      const task = item as TaskboardGanttTask;
      if (task.taskboardGroup) return "";
      const displayEnd = addDays(end, -1);
      const dateLabel = start.getFullYear() === displayEnd.getFullYear()
        ? `${ganttDate(start, i18nRef.current.locale)} — ${ganttDate(displayEnd, i18nRef.current.locale)}`
        : `${ganttDate(start, i18nRef.current.locale, true)} — ${ganttDate(displayEnd, i18nRef.current.locale, true)}`;
      const avatar = task.taskboardAssigneeType === "agent"
        ? `<img src="codex-agent-logo.png" alt="">`
        : task.taskboardAssigneeAvatarUrl
        ? `<img src="${escapeHtml(task.taskboardAssigneeAvatarUrl)}" alt="">`
        : `<span>${escapeHtml(task.taskboardAssigneeInitial)}</span>`;
      return `<span class="gantt-bar-content"><i class="gantt-bar-assignee${task.taskboardAssigneeType === "agent" ? " is-agent" : ""}" title="${escapeHtml(task.taskboardAssigneeName)}">${avatar}</i><span class="gantt-bar-copy"><strong>${escapeHtml(task.taskboardTitle)}</strong><small>${dateLabel}</small></span></span>`;
    };
    const rowClass = (item: GanttTask) => {
      const task = item as TaskboardGanttTask;
      if (task.taskboardGroup) return `is-group gantt-status-${task.taskboardStatus}`;
      return `gantt-status-${task.taskboardStatus}${task.taskboardUnread ? " is-unread" : ""}`;
    };
    instance.templates.grid_row_class = (_start, _end, item) => rowClass(item);
    instance.templates.task_row_class = (_start, _end, item) => rowClass(item);
    instance.templates.scale_cell_class = dateCellClass;
    instance.templates.timeline_cell_class = (_item, date) => dateCellClass(date);
    const monthFormat = (date: Date) => new Intl.DateTimeFormat(i18nRef.current.locale, { year: "numeric", month: "long" }).format(date);
    const dayFormat = (date: Date) => {
      const weekdayLabels = i18nRef.current.language === "zh"
        ? ["日", "一", "二", "三", "四", "五", "六"]
        : ["S", "M", "T", "W", "T", "F", "S"];
      return `<span class="gantt-scale-date"><span class="gantt-scale-weekday">${weekdayLabels[date.getDay()]}</span><span class="gantt-scale-day">${date.getDate()}</span></span>`;
    };
    instance.ext.zoom.init({
      levels: [
        {
          name: "day",
          scale_height: 66,
          min_column_width: 58,
          scales: [
            { unit: "month", step: 1, format: monthFormat },
            { unit: "day", step: 1, format: dayFormat, css: dateCellClass },
          ],
        },
        {
          name: "week",
          scale_height: 66,
          min_column_width: 42,
          scales: [
            { unit: "month", step: 1, format: monthFormat },
            { unit: "day", step: 1, format: dayFormat, css: dateCellClass },
          ],
        },
        {
          name: "month",
          scale_height: 66,
          min_column_width: 82,
          scales: [
            { unit: "year", step: 1, format: (date: Date) => new Intl.DateTimeFormat(i18nRef.current.locale, { year: "numeric" }).format(date) },
            { unit: "month", step: 1, format: (date: Date) => new Intl.DateTimeFormat(i18nRef.current.locale, { month: "short" }).format(date) },
          ],
        },
      ],
    });
    instance.ext.zoom.setLevel(zoom);
    const updateTodayMarker = () => {
      if (!containerRef.current) return;
      const gridOffset = instance.config.show_grid === false ? 0 : Number(instance.config.grid_width);
      const left = gridOffset + instance.posFromDate(localDate(dateValue(new Date()))) - instance.getScrollState().x;
      setTodayMarkerLeft(left >= gridOffset && left <= containerRef.current.clientWidth ? left : null);
    };
    const updateTimelineFill = () => {
      const dataArea = container.querySelector<HTMLElement>(".gantt_data_area");
      const sourceRow = container.querySelector<HTMLElement>(".gantt_task_bg .gantt_task_row");
      if (!dataArea || !sourceRow) return;
      let fill = dataArea.querySelector<HTMLElement>(":scope > .gantt-timeline-fill");
      if (!fill) {
        fill = document.createElement("div");
        fill.className = "gantt-timeline-fill";
        dataArea.prepend(fill);
      }
      fill.replaceChildren(...Array.from(sourceRow.querySelectorAll(".gantt_task_cell"), (cell) => cell.cloneNode(false)));
    };
    const updateOverlays = () => {
      updateTodayMarker();
      updateTimelineFill();
    };
    instance.attachEvent("onGanttScroll", updateOverlays);
    instance.attachEvent("onGanttRender", updateOverlays);
    instance.attachEvent("onAfterTaskUpdate", (id, item) => {
      const ganttTask = item as TaskboardGanttTask;
      const task = tasksRef.current.find((candidate) => candidate.id === String(id));
      if (!task || ganttTask.taskboardGroup || item.unscheduled) return true;
      const startDate = dateValue(item.start_date as Date);
      const dueDate = dateValue(addDays(item.end_date as Date, -1));
      if (task.startDate === startDate && task.dueDate === dueDate) return true;
      void onUpdateRef.current(task, { startDate, dueDate }).catch(() => {});
      return true;
    });
    instance.attachEvent("onTaskDblClick", (id) => {
      const task = tasksRef.current.find((candidate) => candidate.id === String(id));
      if (task) {
        const scroll = instance.getScrollState();
        pendingDetailViewport = { projectId: task.projectId, x: scroll.x, y: scroll.y };
        onOpenTaskRef.current(task);
      }
      return false;
    });
    let linkedHoverTaskId: string | null = null;
    const setLinkedHoverTask = (taskId: string | null) => {
      if (taskId === linkedHoverTaskId) return;
      container.querySelectorAll(".gantt_row.is-linked-hover, .gantt_task_row.is-linked-hover")
        .forEach((row) => row.classList.remove("is-linked-hover"));
      linkedHoverTaskId = taskId;
      if (!taskId) return;
      container.querySelectorAll<HTMLElement>(".gantt_row, .gantt_task_row").forEach((row) => {
        if (row.getAttribute("task_id") === taskId) row.classList.add("is-linked-hover");
      });
    };
    const handlePointerMove = (event: PointerEvent) => {
      const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(".gantt_row, .gantt_task_row, .gantt_task_line");
      const taskId = item && !item.matches(".is-group, .gantt-group-task") ? item.getAttribute("task_id") : null;
      setLinkedHoverTask(taskId);
    };
    const handlePointerLeave = () => setLinkedHoverTask(null);
    const originalEvent = instance.event;
    instance.event = (...args) => {
      const [target, eventName] = args;
      const resizeWatcherWindow = container.querySelector<HTMLIFrameElement>("iframe.gantt_container_resize_watcher")?.contentWindow;
      if (eventName === "resize" && Object.is(target, resizeWatcherWindow)) return;
      originalEvent(...args);
    };
    try {
      instance.init(container);
    } finally {
      instance.event = originalEvent;
    }
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerleave", handlePointerLeave);
    const markerFrame = requestAnimationFrame(updateOverlays);
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const ratio = width >= 1200 ? 0.3 : 0.32;
      const nextGridWidth = Math.round(Math.max(300, Math.min(460, width * ratio)));
      expandedGridWidthRef.current = nextGridWidth;
      setGridWidth(nextGridWidth);
      if (!gridCollapsedRef.current) instance.config.grid_width = nextGridWidth;
      instance.setSizes();
    });
    resizeObserver.observe(container);
    return () => {
      cancelAnimationFrame(markerFrame);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerleave", handlePointerLeave);
      ganttRef.current = null;
      instance.destructor();
    };
  }, []);

  useEffect(() => {
    const instance = ganttRef.current;
    if (!instance) return;
    const scroll = instance.getScrollState();
    const showGrid = instance.config.show_grid;
    const gridWidth = instance.config.grid_width;
    const issueColumn = instance.config.columns.find((column) => column.name === "text");
    if (issueColumn) issueColumn.label = i18nRef.current.text("议题", "Issue");

    for (const group of GANTT_GROUPS) {
      const id = `gantt-group-${group.id}`;
      if (!instance.isTaskExists(id)) continue;
      const task = instance.getTask(id) as TaskboardGanttTask & { $open?: boolean };
      const open = task.$open;
      const label = i18nRef.current.text(group.chineseLabel, group.englishLabel);
      task.text = label;
      task.taskboardTitle = label;
      task.$open = open;
    }

    instance.config.show_grid = showGrid;
    instance.config.grid_width = gridWidth;
    instance.refreshData();
    instance.render();
    instance.config.show_grid = showGrid;
    instance.config.grid_width = gridWidth;
    instance.scrollTo(scroll.x, scroll.y);
  }, [language, locale, text]);

  useEffect(() => {
    const instance = ganttRef.current;
    if (!instance) return;
    const data: TaskboardGanttTask[] = [];
    const groupOpenState = new Map<string, boolean>();

    for (const group of GANTT_GROUPS) {
      const groupId = `gantt-group-${group.id}`;
      if (!instance.isTaskExists(groupId)) continue;
      const existingGroup = instance.getTask(groupId) as TaskboardGanttTask & { $open?: boolean };
      groupOpenState.set(groupId, Boolean(existingGroup.$open));
    }

    for (const group of GANTT_GROUPS) {
      const groupId = `gantt-group-${group.id}`;
      const groupLabel = i18nRef.current.text(group.chineseLabel, group.englishLabel);
      const groupTasks = visibleTasks
        .filter((task) => group.statuses.includes(task.status))
        .sort((left, right) => Number(Boolean(right.startDate && right.dueDate)) - Number(Boolean(left.startDate && left.dueDate)));
      if (!groupTasks.length) continue;
      const progress = groupTasks.reduce((sum, task) => sum + taskProgress(task, presentations[task.id]), 0) / groupTasks.length;
      data.push({
        id: groupId,
        text: groupLabel,
        type: "project",
        open: groupOpenState.get(groupId) ?? group.defaultOpen,
        readonly: true,
        row_height: 46,
        bar_height: 4,
        unscheduled: true,
        progress,
        taskboardStatus: group.statuses[0],
        taskboardTitle: groupLabel,
        taskboardUnread: groupTasks.some((task) => presentations[task.id]?.unread),
        taskboardAssigneeType: null,
        taskboardAssigneeName: "",
        taskboardAssigneeAvatarUrl: null,
        taskboardAssigneeInitial: "",
        taskboardGroup: true,
        taskboardCount: groupTasks.length,
      } as TaskboardGanttTask);

      for (const task of groupTasks) {
        const isScheduled = Boolean(task.startDate && task.dueDate);
        const itemProgress = taskProgress(task, presentations[task.id]);
        data.push({
          id: task.id,
          parent: groupId,
          text: task.title,
          row_height: 58,
          bar_height: 44,
          ...(isScheduled ? {
            start_date: localDate(task.startDate!),
            end_date: addDays(localDate(task.dueDate!), 1),
          } : { unscheduled: true }),
          progress: itemProgress,
          taskboardStatus: task.status,
          taskboardTitle: task.title,
          taskboardUnread: presentations[task.id]?.unread ?? false,
          taskboardAssigneeType: task.assignee.type,
          taskboardAssigneeName: task.assignee.name,
          taskboardAssigneeAvatarUrl: task.assignee.avatarUrl,
          taskboardAssigneeInitial: Array.from(task.assignee.name.trim())[0] ?? "·",
          taskboardGroup: false,
          taskboardCount: 0,
        } as TaskboardGanttTask);
      }
    }

    const scheduledTasks = visibleTasks.filter((task) => task.startDate && task.dueDate);
    const scheduledIds = new Set(scheduledTasks.map((task) => task.id));
    const links = visibleTasks.flatMap((task) => task.relations.blocks
      .filter((relation) => scheduledIds.has(task.id) && scheduledIds.has(relation.id))
      .map((relation) => ({
        id: `${task.id}:${relation.id}`,
        source: task.id,
        target: relation.id,
        type: "0",
      })));
    const today = localDate(dateValue(new Date()));
    const scheduledStarts = scheduledTasks.map((task) => localDate(task.startDate!).getTime());
    const scheduledEnds = scheduledTasks.map((task) => localDate(task.dueDate!).getTime());
    const rangeStart = new Date(Math.min(today.getTime(), ...scheduledStarts));
    const rangeEnd = new Date(Math.max(today.getTime(), ...scheduledEnds));
    const previousScroll = instance.getScrollState();
    const timelineWidth = containerRef.current?.querySelector<HTMLElement>(".gantt_task")?.clientWidth ?? 0;
    const restoredViewport = pendingDetailViewport?.projectId === visibleTasks[0]?.projectId
      ? pendingDetailViewport
      : null;
    const anchorDate = hasParsedDataRef.current && timelineWidth
      ? instance.dateFromPos(previousScroll.x + timelineWidth / 2)
      : null;
    instance.config.start_date = addDays(rangeStart, -7);
    instance.config.end_date = addDays(rangeEnd, 8);
    instance.clearAll();
    instance.parse({ data, links });
    if (restoredViewport) {
      instance.scrollTo(restoredViewport.x, restoredViewport.y);
    } else if (anchorDate) {
      instance.scrollTo(Math.max(0, instance.posFromDate(anchorDate) - timelineWidth / 2), previousScroll.y);
    } else if (scheduledStarts.length) {
      instance.showDate(new Date(Math.min(...scheduledStarts)));
    }
    if (restoredViewport) pendingDetailViewport = null;
    hasParsedDataRef.current = true;
  }, [presentations, visibleTasks]);

  useEffect(() => {
    ganttRef.current?.ext.zoom.setLevel(zoom);
  }, [zoom]);

  useEffect(() => {
    if (todayRequest) ganttRef.current?.showDate(new Date());
  }, [todayRequest]);

  const toggleGrid = () => {
    const instance = ganttRef.current;
    if (!instance) return;
    const nextCollapsed = !gridCollapsedRef.current;
    const scroll = instance.getScrollState();
    gridCollapsedRef.current = nextCollapsed;
    setGridCollapsed(nextCollapsed);
    instance.config.show_grid = !nextCollapsed;
    instance.config.grid_width = nextCollapsed ? 0 : expandedGridWidthRef.current;
    instance.render();
    instance.scrollTo(scroll.x, scroll.y);
  };

  return (
    <div className="gantt-view">
      <div className="gantt-canvas-shell">
        <div className="gantt-canvas" ref={containerRef} />
        {todayMarkerLeft !== null && (
          <div className="gantt-today-marker" style={{ left: todayMarkerLeft }} aria-label={text("今天", "Today")}>
            <span>{text("今天", "Today")}</span>
          </div>
        )}
        <button
          type="button"
          className={`gantt-grid-toggle${gridCollapsed ? " is-collapsed" : ""}`}
          style={{ left: gridCollapsed ? 14 : gridWidth }}
          aria-label={gridCollapsed
            ? text("展开标题区域", "Expand title area")
            : text("收起标题区域", "Collapse title area")}
          aria-expanded={!gridCollapsed}
          title={gridCollapsed
            ? text("展开标题区域", "Expand title area")
            : text("收起标题区域", "Collapse title area")}
          onClick={toggleGrid}
        >
          <LinearIcon name={gridCollapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        {!visibleTasks.length && (
          <div className="gantt-empty-overlay">
            <LinearIcon name="calendar" />
            <span>{hasActiveFilters || hideCompleted
              ? text("当前条件下没有议题", "No issues match the current conditions")
              : text("创建议题后，可在这里安排时间线", "Create an issue to schedule it on the timeline")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
