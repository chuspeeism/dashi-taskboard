import { useEffect, useMemo, useRef, useState } from "react";
import { Gantt, type GanttStatic, type Task as GanttTask } from "dhtmlx-gantt";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import type { Task, TaskDraft } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { LinearIcon } from "./LinearIcon";
import { taskboardIconSource } from "./TaskboardIcon";

type GanttZoom = "day" | "week" | "month";

interface GanttGroupDefinition {
  id: string;
  label: string;
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
  { id: "in-progress", label: "处理中", statuses: ["in_progress"], defaultOpen: true },
  { id: "in-review", label: "等你确认", statuses: ["in_review"], defaultOpen: true },
  { id: "blocked", label: "遇到阻碍", statuses: ["blocked"], defaultOpen: true },
  { id: "todo", label: "待处理", statuses: ["backlog", "todo"], defaultOpen: true },
  { id: "done", label: "已完成", statuses: ["done"], defaultOpen: false },
  { id: "canceled", label: "已取消", statuses: ["canceled"], defaultOpen: false },
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
        label: "议题",
        tree: true,
        width: "*",
        min_width: 190,
        template: (item) => {
          const task = item as TaskboardGanttTask;
          if (task.taskboardGroup) {
            return `<div class="gantt-grid-group"><strong>${escapeHtml(task.taskboardTitle)}</strong><span>${task.taskboardCount}</span></div>`;
          }
          return `<div class="gantt-grid-issue"><strong>${escapeHtml(task.taskboardTitle)}</strong>${task.taskboardUnread ? '<i class="task-unread-dot" aria-label="有未读更新"></i>' : ""}</div>`;
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
        ? `${start.getMonth() + 1}月${start.getDate()}日 — ${displayEnd.getMonth() + 1}月${displayEnd.getDate()}日`
        : `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 — ${displayEnd.getFullYear()}年${displayEnd.getMonth() + 1}月${displayEnd.getDate()}日`;
      const avatar = task.taskboardAssigneeType === "agent"
        ? `<img src="/codex-agent-logo.png" alt="">`
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
    const monthFormat = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
    const dayFormat = (date: Date) => `<span class="gantt-scale-date"><span class="gantt-scale-weekday">${["S", "M", "T", "W", "T", "F", "S"][date.getDay()]}</span><span class="gantt-scale-day">${date.getDate()}</span></span>`;
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
            { unit: "year", step: 1, format: "%Y年" },
            { unit: "month", step: 1, format: (date: Date) => `${date.getMonth() + 1}月` },
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
    instance.init(container);
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerleave", handlePointerLeave);
    const markerFrame = requestAnimationFrame(updateOverlays);
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const ratio = width >= 1200 ? 0.3 : 0.32;
      const nextGridWidth = Math.round(Math.max(300, Math.min(460, width * ratio)));
      expandedGridWidthRef.current = nextGridWidth;
      setGridWidth(nextGridWidth);
      if (gridCollapsedRef.current) return;
      instance.config.grid_width = nextGridWidth;
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
    const data: TaskboardGanttTask[] = [];

    for (const group of GANTT_GROUPS) {
      const groupTasks = visibleTasks
        .filter((task) => group.statuses.includes(task.status))
        .sort((left, right) => Number(Boolean(right.startDate && right.dueDate)) - Number(Boolean(left.startDate && left.dueDate)));
      if (!groupTasks.length) continue;
      const progress = groupTasks.reduce((sum, task) => sum + taskProgress(task, presentations[task.id]), 0) / groupTasks.length;
      data.push({
        id: `gantt-group-${group.id}`,
        text: group.label,
        type: "project",
        open: group.defaultOpen,
        readonly: true,
        row_height: 46,
        bar_height: 4,
        unscheduled: true,
        progress,
        taskboardStatus: group.statuses[0],
        taskboardTitle: group.label,
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
          parent: `gantt-group-${group.id}`,
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
          <div className="gantt-today-marker" style={{ left: todayMarkerLeft }} aria-label="今天">
            <span>Today</span>
          </div>
        )}
        <button
          type="button"
          className={`gantt-grid-toggle${gridCollapsed ? " is-collapsed" : ""}`}
          style={{ left: gridCollapsed ? 14 : gridWidth }}
          aria-label={gridCollapsed ? "展开标题区域" : "收起标题区域"}
          aria-expanded={!gridCollapsed}
          title={gridCollapsed ? "展开标题区域" : "收起标题区域"}
          onClick={toggleGrid}
        >
          <LinearIcon name={gridCollapsed ? "chevronRight" : "chevronLeft"} />
        </button>
        {!visibleTasks.length && (
          <div className="gantt-empty-overlay"><LinearIcon name="calendar" /><span>{hasActiveFilters || hideCompleted ? "当前条件下没有议题" : "创建议题后，可在这里安排时间线"}</span></div>
        )}
      </div>
    </div>
  );
}
