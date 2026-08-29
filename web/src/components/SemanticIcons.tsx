import type { CSSProperties, HTMLAttributes, ReactNode, SVGProps } from "react";
import conversationSource from "../assets/figma-taskboard/conversation.svg";
import prioritySource from "../assets/figma-taskboard/priority.svg";
import priorityHighSource from "../assets/figma-taskboard/priority-high.svg";
import priorityLowSource from "../assets/figma-taskboard/priority-low.svg";
import priorityMediumSource from "../assets/figma-taskboard/priority-medium.svg";
import priorityNoneSource from "../assets/figma-taskboard/priority-none.svg";
import priorityUrgentSource from "../assets/figma-taskboard/priority-urgent.svg";
import relationBlockedBySource from "../assets/figma-taskboard/relation-blocked-by.svg";
import relationBlocksSource from "../assets/figma-taskboard/relation-blocks.svg";
import statusBacklogSource from "../assets/figma-taskboard/status-backlog.svg";
import statusBlockedSource from "../assets/figma-taskboard/status-blocked.svg";
import statusCanceledSource from "../assets/figma-taskboard/status-canceled.svg";
import statusDoneSource from "../assets/figma-taskboard/status-done.svg";
import statusProgressSource from "../assets/figma-taskboard/status-progress.svg";
import statusReviewSource from "../assets/figma-taskboard/status-review.svg";
import statusTodoSource from "../assets/figma-taskboard/status-todo.svg";
import type { TaskPriority, TaskStatus } from "../types";

type IconSize = number | string;

interface SvgIconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "color" | "height" | "width"> {
  children: ReactNode;
  color?: CSSProperties["color"];
  size?: IconSize;
  title?: string;
  viewBox?: string;
}

function SvgIcon({
  children,
  color = "currentColor",
  size = 16,
  style,
  title,
  viewBox = "0 0 16 16",
  ...props
}: SvgIconProps) {
  return (
    <svg
      {...props}
      viewBox={viewBox}
      width={size}
      height={size}
      fill="currentColor"
      color={color}
      focusable="false"
      role={title || props["aria-label"] ? "img" : undefined}
      aria-hidden={title || props["aria-label"] ? undefined : true}
      style={{ color, fill: "currentColor", stroke: "none", ...style }}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

interface MaskIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  color?: CSSProperties["color"];
  size?: IconSize;
  source: string;
}

function MaskIcon({ color = "currentColor", size = 16, source, style, ...props }: MaskIconProps) {
  return (
    <span
      {...props}
      aria-hidden={props["aria-label"] ? undefined : true}
      role={props["aria-label"] ? "img" : undefined}
      style={{
        backgroundColor: "currentColor",
        color,
        display: "inline-block",
        flex: "0 0 auto",
        height: size,
        maskImage: `url("${source}")`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: `url("${source}")`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        width: size,
        ...style,
      }}
    />
  );
}

const STATUS_SOURCES: Record<TaskStatus, string> = {
  backlog: statusBacklogSource,
  todo: statusTodoSource,
  in_progress: statusProgressSource,
  in_review: statusReviewSource,
  blocked: statusBlockedSource,
  done: statusDoneSource,
  canceled: statusCanceledSource,
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  backlog: "var(--status-backlog)",
  todo: "var(--status-todo)",
  in_progress: "var(--status-progress)",
  in_review: "var(--status-review)",
  blocked: "var(--status-blocked)",
  done: "var(--status-done)",
  canceled: "var(--status-canceled)",
};

interface StatusIconProps extends Omit<MaskIconProps, "source"> {
  status: TaskStatus;
}

export function StatusIcon({ color, status, ...props }: StatusIconProps) {
  return (
    <MaskIcon
      {...props}
      color={color ?? STATUS_COLORS[status]}
      data-status-icon={status}
      source={STATUS_SOURCES[status]}
    />
  );
}

const PRIORITY_SOURCES: Record<TaskPriority, string> = {
  urgent: priorityUrgentSource,
  high: priorityHighSource,
  medium: priorityMediumSource,
  low: priorityLowSource,
  none: priorityNoneSource,
};

interface PriorityIconProps extends Omit<MaskIconProps, "source"> {
  priority?: TaskPriority;
}

export function PriorityIcon({ color, priority, ...props }: PriorityIconProps) {
  return (
    <MaskIcon
      {...props}
      color={color ?? (priority ? `var(--priority-${priority})` : "currentColor")}
      data-priority-icon={priority ?? "generic"}
      source={priority ? PRIORITY_SOURCES[priority] : prioritySource}
    />
  );
}

type BasicIconProps = Omit<SvgIconProps, "children">;

export function EditIcon({ color = "black", ...props }: BasicIconProps) {
  return (
    <SvgIcon {...props} color={color} viewBox="0 0 64 64">
      <path fillRule="evenodd" clipRule="evenodd" d="M29 3.96753C30.6566 3.96753 31.9995 5.31109 32 6.96753C32 8.62437 30.6568 9.96753 29 9.96753H19C14.0298 9.96753 10.0005 13.9973 10 18.9675V44.9675C10 49.9379 14.0294 53.9675 19 53.9675H45C49.9704 53.9675 54 49.9379 54 44.9675V34.9675C54.0004 33.3111 55.3436 31.9675 57 31.9675C58.6564 31.9675 59.9996 33.3111 60 34.9675V44.9675C60 53.2519 53.2844 59.9675 45 59.9675H19C10.7157 59.9675 4 53.2519 4 44.9675V18.9675C4.00048 10.6837 10.716 3.96753 19 3.96753H29Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M53.7305 5.04571C55.1653 3.61134 57.4913 3.61112 58.9257 5.04571C60.3589 6.48039 60.3597 8.80683 58.9257 10.241L36.9493 32.2137C34.7242 34.4384 31.7618 35.774 28.6212 35.9676C28.2703 35.9884 27.9788 35.6975 28.0001 35.3465C28.194 32.206 29.5294 29.2435 31.754 27.0184L53.7305 5.04571Z" />
    </SvgIcon>
  );
}

export function LabelIcon({ color = "black", ...props }: BasicIconProps) {
  return (
    <SvgIcon {...props} color={color} viewBox="0 0 64 64" fill="none">
      <path d="M22.8594 24.5756H41.1392" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path fill="none" fillRule="evenodd" clipRule="evenodd" d="M31.9988 6.66406C14.9668 6.66406 12.0894 9.14938 12.0894 29.1414C12.0894 51.5228 11.6708 57.3308 15.9268 57.3308C20.1801 57.3308 27.1268 47.5068 31.9988 47.5068C36.8708 47.5068 43.8176 57.3308 48.0708 57.3308C52.3268 57.3308 51.908 51.5228 51.908 29.1414C51.908 9.14938 49.0308 6.66406 31.9988 6.66406Z" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </SvgIcon>
  );
}

export function BranchIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path d="M9.5 3.25a2.25 2.25 0 0 1 4.315-.894c.164.378.22.795.164 1.203A2.25 2.25 0 0 1 12.5 5.371V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.25 2.25 0 1 1-1.5 0V5.37a2.25 2.25 0 1 1 1.5 0v1.836a2.492 2.492 0 0 1 1-.208h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.499.75.75 0 0 0 0-1.5Zm-7.5 9.499a.75.75 0 1 0 0 1.499.75.75 0 0 0 0-1.5Z" /></SvgIcon>;
}

export function AttachmentIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path d="m12.643 7.69-3.714 3.714c-1.447 1.448-3.586 1.606-4.762.43-1.18-1.18-1.023-3.312.425-4.76l3.41-3.41c.934-.933 2.296-1.033 3.031-.297.735.734.633 2.1-.297 3.03L7.324 9.81c-.422.421-1.002.464-1.3.166-.297-.297-.255-.879.175-1.308L9.29 5.576a.707.707 0 0 0-1-1L5.2 7.668c-.952.951-1.06 2.423-.175 3.308.886.886 2.356.777 3.3-.166l3.412-3.413c1.452-1.451 1.62-3.707.297-5.03s-3.575-1.158-5.03.298l-3.41 3.41c-1.97 1.97-2.193 4.991-.426 6.758 1.764 1.765 4.793 1.54 6.762-.429l3.714-3.714a.707.707 0 0 0-1-1" /></SvgIcon>;
}

export function MoreIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path d="M3 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" /></SvgIcon>;
}

export function PlusIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path d="M8.75 4C8.75 3.58579 8.41421 3.25 8 3.25C7.58579 3.25 7.25 3.58579 7.25 4V7.25H4C3.58579 7.25 3.25 7.58579 3.25 8C3.25 8.41421 3.58579 8.75 4 8.75H7.25V12C7.25 12.4142 7.58579 12.75 8 12.75C8.41421 12.75 8.75 12.4142 8.75 12V8.75H12C12.4142 8.75 12.75 8.41421 12.75 8C12.75 7.58579 12.4142 7.25 12 7.25H8.75V4Z" /></SvgIcon>;
}

export function DeleteIcon(props: BasicIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M12.7834 6.56006C12.7834 11.9061 13.5529 14.3226 8.37704 14.3226C3.20053 14.3226 3.98593 11.9061 3.98593 6.56006" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.767 4.51058H3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6667 4.51048C10.6667 4.51048 11.019 2 8.38285 2C5.74729 2 6.09967 4.51048 6.09967 4.51048" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </SvgIcon>
  );
}

export function ProjectIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path fillRule="evenodd" d="M7.331 1.07a3.2 3.2 0 0 1 1.338 0c.498.106.967.377 1.904.917l1.354.78c.937.541 1.406.812 1.747 1.19.301.334.53.728.669 1.156.157.484.157 1.025.157 2.107v1.56l-.003.718c-.007.63-.036 1.026-.154 1.389l-.057.158a3.2 3.2 0 0 1-.612.998l-.135.138c-.33.312-.792.578-1.612 1.051l-1.354.78-.623.357c-.55.309-.907.481-1.281.56l-.166.032a3.2 3.2 0 0 1-1.006 0l-.166-.031c-.374-.08-.73-.252-1.281-.561l-.623-.356-1.354-.78c-.82-.474-1.281-.74-1.612-1.052l-.135-.138a3.2 3.2 0 0 1-.612-.998l-.057-.158c-.118-.363-.147-.758-.154-1.39L1.5 8.78V7.22c0-.946 0-1.479.105-1.921l.052-.186c.122-.374.312-.723.56-1.028l.11-.128c.255-.284.583-.507 1.126-.83l.62-.36 1.354-.78c.82-.473 1.281-.739 1.718-.869zM3 7.22v1.56c0 1.183.018 1.439.084 1.643l.064.167q.11.246.292.449l.059.06c.151.143.427.318 1.323.835l1.354.78.632.36c.188.104.33.178.442.233V8.482l-4.247-1.93zm5.75 1.262v4.826c.212-.106.533-.282 1.074-.594l1.354-.78.628-.368c.499-.297.646-.407.754-.527l.113-.14q.158-.218.243-.476l.022-.081c.035-.144.051-.351.058-.835L13 8.78V7.22l-.004-.668zM7.82 2.51l-.177.027c-.159.034-.328.106-.835.39l-.632.359-1.354.78c-.896.517-1.172.692-1.323.834l-.059.06q-.046.051-.086.104l4.645 2.112 4.645-2.112-.084-.103c-.109-.12-.255-.23-.754-.528l-.628-.367-1.354-.78c-.897-.517-1.186-.668-1.386-.728l-.08-.021a1.7 1.7 0 0 0-.538-.027" clipRule="evenodd" /></SvgIcon>;
}

export function ConversationIcon(props: Omit<MaskIconProps, "source">) {
  return <MaskIcon {...props} source={conversationSource} />;
}

export function NewConversationIcon(props: BasicIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M5.7002 6.30005L6.7002 8.00005L5.7002 9.70005M8.59961 9.6001H10.7996M7.20215 1.93018C7.96231 1.93039 8.65815 2.20565 9.19629 2.66162L9.3877 2.82373L9.63379 2.77881C9.8134 2.74642 9.99778 2.72904 10.1836 2.729C11.8882 2.72952 13.2711 4.11205 13.2715 5.81689L13.2578 6.09326C13.2492 6.18462 13.237 6.27556 13.2207 6.36572L13.1758 6.61182L13.3379 6.80322C13.7943 7.34178 14.0702 8.03877 14.0703 8.79932C14.0699 10.1375 13.2176 11.2764 12.0254 11.7046L11.79 11.7896L11.7051 12.0249C11.2769 13.2172 10.138 14.0695 8.7998 14.0698C8.03929 14.0698 7.34241 13.7941 6.80371 13.3374L6.61328 13.1753L6.36719 13.2202C6.27684 13.2365 6.18551 13.2487 6.09375 13.2573L5.81738 13.271C4.11286 13.2707 2.73101 11.8881 2.73047 10.1831C2.73049 9.997 2.74782 9.81293 2.78027 9.6333L2.8252 9.38721L2.66309 9.1958C2.29195 8.7578 2.03996 8.21562 1.95898 7.61963L1.93555 7.36084L1.93066 7.20068C1.93084 5.86226 2.78273 4.7218 3.97461 4.29346L4.20996 4.2085L4.29492 3.97412C4.72324 2.78211 5.86353 1.93019 7.20215 1.93018Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </SvgIcon>
  );
}

export function CodexResumeIcon({ color = "#5D5D5F", ...props }: BasicIconProps) {
  return (
    <SvgIcon {...props} color={color} fill="none">
      <path fill="none" fillRule="evenodd" clipRule="evenodd" d="M13.4398 5.53325L9.65977 1.93325C9.17311 1.86659 8.62644 1.83325 8.02644 1.83325C3.83311 1.83325 2.43311 3.37992 2.43311 7.99992C2.43311 12.6266 3.83311 14.1666 8.02644 14.1666C12.2264 14.1666 13.6264 12.6266 13.6264 7.99992C13.6264 7.05325 13.5664 6.23325 13.4398 5.53325Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.28955 1.88843V3.66243C9.28955 4.90109 10.2936 5.90443 11.5322 5.90443H13.4996" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.2667 10.3333H7M5 7L6 8L5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </SvgIcon>
  );
}

export function RelationIcon(props: BasicIconProps) {
  return (
    <SvgIcon {...props} fill="none">
      <path d="M12.2429 9.4142L12.95 8.70709C14.5121 7.14499 14.5121 4.61233 12.95 3.05023C11.3879 1.48814 8.85522 1.48814 7.29312 3.05023L6.58601 3.75734M3.75759 6.58577L3.05048 7.29287C1.48838 8.85497 1.48838 11.3876 3.05048 12.9497C4.61258 14.5118 7.14524 14.5118 8.70733 12.9497L9.41444 12.2426M10.1215 5.87866L5.87891 10.1213" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </SvgIcon>
  );
}

export function BlockingRelationIcon({ type, ...props }: Omit<MaskIconProps, "source"> & {
  type: "blocked_by" | "blocks";
}) {
  return <MaskIcon {...props} source={type === "blocked_by" ? relationBlockedBySource : relationBlocksSource} />;
}

export function DueDateIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path fillRule="evenodd" clipRule="evenodd" d="M15 5C15 2.79086 13.2091 1 11 1H5C2.79086 1 1 2.79086 1 5V11C1 13.2091 2.79086 15 5 15H6.25C6.66421 15 7 14.6642 7 14.25C7 13.8358 6.66421 13.5 6.25 13.5H5C3.61929 13.5 2.5 12.3807 2.5 11V6H13.5V6.25C13.5 6.66421 13.8358 7 14.25 7C14.6642 7 15 6.66421 15 6.25V5ZM11.5001 8C11.9143 8 12.2501 8.33579 12.2501 8.75V10.75L14.2501 10.75C14.6643 10.75 15.0001 11.0858 15.0001 11.5C15.0001 11.9142 14.6643 12.25 14.2501 12.25L12.2501 12.25V14.25C12.2501 14.6642 11.9143 15 11.5001 15C11.0859 15 10.7501 14.6642 10.7501 14.25V12.25H8.75C8.33579 12.25 8 11.9142 8 11.5C8 11.0858 8.33579 10.75 8.75 10.75L10.7501 10.75V8.75C10.7501 8.33579 11.0859 8 11.5001 8Z" /></SvgIcon>;
}

export function RecurrenceIcon(props: BasicIconProps) {
  return <SvgIcon {...props}><path fillRule="evenodd" clipRule="evenodd" d="M15 5C15 2.79086 13.2091 1 11 1H5C2.79086 1 1 2.79086 1 5V11C1 13.2091 2.79086 15 5 15H6.25C6.66421 15 7 14.6642 7 14.25C7 13.8358 6.66421 13.5 6.25 13.5H5C3.61929 13.5 2.5 12.3807 2.5 11V6H13.5V6.25C13.5 6.66421 13.8358 7 14.25 7C14.6642 7 15 6.66421 15 6.25V5ZM11 7.25C10.5858 7.25 10.25 7.58579 10.25 8C10.25 8.41421 10.5858 8.75 11 8.75C12.2426 8.75 13.25 9.75736 13.25 11H12.6403C12.2622 11 12.0952 11.4761 12.3904 11.7123L13.7501 12.8001C13.8962 12.917 14.1038 12.917 14.2499 12.8001L15.6095 11.7123C15.9048 11.4761 15.7378 11 15.3597 11H14.75C14.75 8.92893 13.071 7.25 11 7.25ZM6.64029 11H7.24998C7.24998 13.0711 8.92891 14.75 11 14.75C11.4142 14.75 11.75 14.4142 11.75 14C11.75 13.5858 11.4142 13.25 11 13.25C9.75734 13.25 8.74998 12.2426 8.74998 11H9.35967C9.73778 11 9.9048 10.5239 9.60955 10.2877L8.24986 9.1999C8.10377 9.08303 7.89619 9.08303 7.7501 9.1999L6.39041 10.2877C6.09516 10.5239 6.26218 11 6.64029 11Z" /></SvgIcon>;
}

export function RefreshIcon(props: BasicIconProps) {
  return <RecurrenceIcon {...props} />;
}

export function ReadOnlyPermissionIcon({ color = "black", ...props }: BasicIconProps) {
  return <SvgIcon {...props} color={color} size={props.size ?? 18} viewBox="0 0 18 18" fill="none"><path d="M12.5067 5.96484V8.71484M12.5067 5.96484V3.46484C12.5067 2.77449 11.9471 2.21484 11.2567 2.21484C10.5664 2.21484 10.0067 2.77449 10.0067 3.46484M12.5067 5.96484C12.5067 5.27449 13.0664 4.71484 13.7567 4.71484C14.4471 4.71484 15.0067 5.27449 15.0067 5.96484V10.9282C15.0067 13.8201 12.1941 16.2218 9.42915 16.2836C5.88853 16.3626 4.16728 13.2449 2.29842 10.7653C1.84441 10.1629 1.90344 9.31811 2.43683 8.78473C3.32386 7.89769 4.30201 8.51015 5.00671 9.21484M10.0067 3.46484V7.21484M10.0067 3.46484V2.96484C10.0067 2.27449 9.44706 1.71484 8.75671 1.71484C8.06635 1.71484 7.50671 2.27449 7.50671 2.96484V4.46484M7.00671 11.2148L5.00671 9.21484M5.00671 9.21484V4.46484C5.00671 3.77449 5.56635 3.21484 6.25671 3.21484C6.94706 3.21484 7.50671 3.77449 7.50671 4.46484M7.50671 4.46484V7.21484" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></SvgIcon>;
}

export function WorkspaceWritePermissionIcon({ color = "black", ...props }: BasicIconProps) {
  return <SvgIcon {...props} color={color} size={props.size ?? 18} viewBox="0 0 18 18" fill="none"><path d="M6 7.5L7.55556 9.25L6 11M8.5 11H11M8.5 16C6.77292 16 5.48773 15.2635 4.55965 14.3558C2.67613 12.5138 2.5 9.66155 2.5 7.02699C2.5 6.05988 3.01595 5.16623 3.85349 4.68267L7 2.86603C7.9282 2.33013 9.0718 2.33013 10 2.86603L13.1465 4.68267C13.9841 5.16623 14.5 6.05988 14.5 7.02699C14.5 9.66155 14.3239 12.5138 12.4404 14.3558C11.5123 15.2635 10.2271 16 8.5 16Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></SvgIcon>;
}

export function FullAccessPermissionIcon({ color = "#DC865C", ...props }: BasicIconProps) {
  return <SvgIcon {...props} color={color} size={props.size ?? 18} viewBox="0 0 18 18" fill="none"><path d="M8.5 6V10M8.5 12.5002V12.51M8.5 16C6.77292 16 5.48773 15.2635 4.55965 14.3558C2.67613 12.5138 2.5 9.66155 2.5 7.02699C2.5 6.05988 3.01595 5.16623 3.85349 4.68267L7 2.86603C7.9282 2.33013 9.0718 2.33013 10 2.86603L13.1465 4.68267C13.9841 5.16623 14.5 6.05988 14.5 7.02699C14.5 9.66155 14.3239 12.5138 12.4404 14.3558C11.5123 15.2635 10.2271 16 8.5 16Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></SvgIcon>;
}

export function SendIcon({ color = "black", ...props }: BasicIconProps) {
  return (
    <SvgIcon {...props} color={color} viewBox="0 0 64 64" fill="none">
      <g clipPath="url(#clip0_1105_20971)">
        <path d="M21 30.9091L32 20L43 30.9091M32 20V44" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <defs>
        <clipPath id="clip0_1105_20971">
          <rect width="24" height="26" fill="white" transform="translate(20 19)" />
        </clipPath>
      </defs>
    </SvgIcon>
  );
}
