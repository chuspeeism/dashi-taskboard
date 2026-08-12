import type { ImgHTMLAttributes } from "react";
import aiLauncher from "../assets/figma-taskboard/ai-launcher.svg";
import automationPause from "../assets/figma-taskboard/automation-pause.svg";
import automationPlay from "../assets/figma-taskboard/automation-play.svg";
import breadcrumb from "../assets/figma-taskboard/breadcrumb.svg";
import calendar from "../assets/figma-taskboard/calendar.svg";
import columnAddBlocked from "../assets/figma-taskboard/column-add-blocked.svg";
import columnAddProgress from "../assets/figma-taskboard/column-add-progress.svg";
import columnAddReview from "../assets/figma-taskboard/column-add-review.svg";
import columnAddTodo from "../assets/figma-taskboard/column-add-todo.svg";
import columnAdd from "../assets/figma-taskboard/column-add.svg";
import columnStatusBlocked from "../assets/figma-taskboard/column-status-blocked.svg";
import columnStatusProgress from "../assets/figma-taskboard/column-status-progress.svg";
import columnStatusReview from "../assets/figma-taskboard/column-status-review.svg";
import columnStatusTodo from "../assets/figma-taskboard/column-status-todo.svg";
import conversation from "../assets/figma-taskboard/conversation.svg";
import create from "../assets/figma-taskboard/create.svg";
import dropdown from "../assets/figma-taskboard/dropdown.svg";
import filter from "../assets/figma-taskboard/filter.svg";
import home from "../assets/figma-taskboard/home.svg";
import panel from "../assets/figma-taskboard/panel.svg";
import projectFolder from "../assets/figma-taskboard/project-folder.svg";
import relationBlockedBy from "../assets/figma-taskboard/relation-blocked-by.svg";
import relationBlocks from "../assets/figma-taskboard/relation-blocks.svg";
import search from "../assets/figma-taskboard/search.svg";
import sidebarAdd from "../assets/figma-taskboard/sidebar-add.svg";
import statusBlocked from "../assets/figma-taskboard/status-blocked.svg";
import statusProgress from "../assets/figma-taskboard/status-progress.svg";
import statusReview from "../assets/figma-taskboard/status-review.svg";
import statusTodo from "../assets/figma-taskboard/status-todo.svg";

const TASKBOARD_ICONS = {
  aiLauncher,
  automationPause,
  automationPlay,
  breadcrumb,
  calendar,
  columnAdd,
  columnAddBlocked,
  columnAddProgress,
  columnAddReview,
  columnAddTodo,
  columnStatusBlocked,
  columnStatusProgress,
  columnStatusReview,
  columnStatusTodo,
  conversation,
  create,
  dropdown,
  filter,
  home,
  panel,
  projectFolder,
  relationBlockedBy,
  relationBlocks,
  search,
  sidebarAdd,
  statusBlocked,
  statusProgress,
  statusReview,
  statusTodo,
} as const;

export type TaskboardIconName = keyof typeof TASKBOARD_ICONS;

const MONOCHROME_ICONS = new Set<TaskboardIconName>([
  "aiLauncher",
  "automationPlay",
  "breadcrumb",
  "calendar",
  "columnAdd",
  "conversation",
  "create",
  "dropdown",
  "filter",
  "home",
  "panel",
  "projectFolder",
  "search",
  "sidebarAdd",
  "statusBlocked",
  "statusProgress",
  "statusReview",
  "statusTodo",
]);

export function taskboardIconSource(name: TaskboardIconName) {
  return TASKBOARD_ICONS[name];
}

interface TaskboardIconProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> {
  name: TaskboardIconName;
}

export function TaskboardIcon({ name, className, ...props }: TaskboardIconProps) {
  const classes = [
    "taskboard-icon",
    MONOCHROME_ICONS.has(name) ? "taskboard-icon-monochrome" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <img
      {...props}
      className={classes}
      src={TASKBOARD_ICONS[name]}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
