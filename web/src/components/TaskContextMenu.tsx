import { listenForOutsidePointerDown, listenForMenuViewportChange } from "../menuEvents";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../types";
import { labelPresentation } from "../labels";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";
import {
  DeleteIcon,
  EditIcon,
  LabelIcon,
  NewConversationIcon,
  PriorityIcon,
  StatusIcon,
} from "./SemanticIcons";

type SubmenuName = "status" | "priority" | "labels" | "copy";

interface TaskContextMenuProps {
  task: Task;
  position: { x: number; y: number };
  labels: string[];
  onClose: () => void;
  onEdit: (task: Task) => void;
  onStatusChange: (task: Task, status: TaskStatus) => void;
  onPriorityChange: (task: Task, priority: TaskPriority) => void;
  onLabelsChange: (task: Task, labels: string[]) => void;
  onDuplicate: (task: Task) => void;
  onCopy: (text: string, announcement: string) => void;
  openInThreadDisabled?: boolean;
  onOpenInThread: (task: Task) => void;
  onArchive: (task: Task) => void;
}

interface MenuItemProps {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  submenu?: SubmenuName;
  submenuOpen?: boolean;
  rootShortcut?: string;
  onPointerEnter?: () => void;
  onClick?: () => void;
  children?: ReactNode;
}

function MenuItem({
  label,
  icon,
  shortcut,
  checked,
  danger,
  disabled,
  submenu,
  submenuOpen,
  rootShortcut,
  onPointerEnter,
  onClick,
  children,
}: MenuItemProps) {
  return (
    <div className="context-menu-item-anchor">
      <button
        type="button"
        role={checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={checked}
        aria-haspopup={submenu ? "menu" : undefined}
        aria-expanded={submenu ? submenuOpen : undefined}
        className={`context-menu-item${danger ? " is-danger" : ""}`}
        disabled={disabled}
        data-submenu={submenu}
        data-root-shortcut={rootShortcut}
        data-open={submenuOpen ? "true" : undefined}
        onPointerEnter={onPointerEnter}
        onClick={onClick}
      >
        <span className="context-menu-icon">{icon}</span>
        <span className="context-menu-label">{label}</span>
        {shortcut && <span className="context-menu-shortcut">{shortcut}</span>}
        {checked && <span className="context-menu-check"><LinearIcon name="check" /></span>}
        {submenu && <span className="context-menu-chevron"><LinearIcon name="chevronRight" /></span>}
      </button>
      {children}
    </div>
  );
}

export function TaskContextMenu({
  task,
  position,
  labels,
  onClose,
  onEdit,
  onStatusChange,
  onPriorityChange,
  onLabelsChange,
  onDuplicate,
  onCopy,
  openInThreadDisabled = false,
  onOpenInThread,
  onArchive,
}: TaskContextMenuProps) {
  const { language, text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuTimerRef = useRef<number | null>(null);
  const [submenu, setSubmenu] = useState<SubmenuName | null>(null);
  const [placedPosition, setPlacedPosition] = useState(position);
  const [submenuSide, setSubmenuSide] = useState<"left" | "right">("right");
  const [submenuShift, setSubmenuShift] = useState(0);

  function closeThen(action: () => void) {
    onClose();
    action();
  }

  function openSubmenu(name: SubmenuName, focus = false) {
    if (submenuTimerRef.current !== null) window.clearTimeout(submenuTimerRef.current);
    setSubmenu(name);
    if (focus) {
      requestAnimationFrame(() => {
        menuRef.current
          ?.querySelector<HTMLElement>(`[data-submenu-panel="${name}"] .context-menu-item:not(:disabled)`)
          ?.focus();
      });
    }
  }

  function scheduleSubmenu(name: SubmenuName) {
    if (submenuTimerRef.current !== null) window.clearTimeout(submenuTimerRef.current);
    submenuTimerRef.current = window.setTimeout(() => openSubmenu(name), 300);
  }

  function closeSubmenu() {
    if (submenuTimerRef.current !== null) window.clearTimeout(submenuTimerRef.current);
    setSubmenu(null);
  }

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const x = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
    setPlacedPosition((current) => current.x === x && current.y === y ? current : { x, y });
    setSubmenuSide(x + rect.width + 196 > window.innerWidth - 8 ? "left" : "right");
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    if (!submenu) {
      setSubmenuShift(0);
      return;
    }
    const panel = menuRef.current?.querySelector<HTMLElement>(`[data-submenu-panel="${submenu}"]`);
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const shift = rect.bottom > window.innerHeight - 8
      ? window.innerHeight - 8 - rect.bottom
      : rect.top < 8
        ? 8 - rect.top
        : 0;
    setSubmenuShift(shift);
  }, [submenu, placedPosition]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(".context-menu-item:not(:disabled)")?.focus());

    const stopOutside = listenForOutsidePointerDown([menuRef], onClose);
    const stopViewport = listenForMenuViewportChange(menuRef, onClose);

    return () => {
      if (submenuTimerRef.current !== null) window.clearTimeout(submenuTimerRef.current);
      stopOutside();
      stopViewport();
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  function buttonsIn(menu: HTMLElement): HTMLButtonElement[] {
    return Array.from(menu.querySelectorAll<HTMLButtonElement>(
      ":scope > .context-menu-group > .context-menu-item-anchor > .context-menu-item:not(:disabled), :scope > .context-menu-item-anchor > .context-menu-item:not(:disabled)",
    ));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = event.target as HTMLButtonElement;
    const activeMenu = current.closest<HTMLElement>('[role="menu"]');
    if (!activeMenu) return;

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowLeft" && activeMenu.classList.contains("context-submenu")) {
      event.preventDefault();
      const owner = submenu;
      setSubmenu(null);
      requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-submenu="${owner}"]`)?.focus());
      return;
    }

    if (event.key === "ArrowRight" && current.dataset.submenu) {
      event.preventDefault();
      openSubmenu(current.dataset.submenu as SubmenuName, true);
      return;
    }

    if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
      event.preventDefault();
      const buttons = buttonsIn(activeMenu);
      if (!buttons.length) return;
      if (event.key === "Home") buttons[0].focus();
      else if (event.key === "End") buttons.at(-1)?.focus();
      else {
        const direction = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
        const index = Math.max(0, buttons.indexOf(current));
        buttons[(index + direction + buttons.length) % buttons.length].focus();
      }
      return;
    }

    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
      const shortcut = menuRef.current?.querySelector<HTMLButtonElement>(
        `[data-root-shortcut="${event.key.toLowerCase()}"]`,
      );
      if (shortcut?.dataset.submenu) {
        event.preventDefault();
        shortcut.focus();
        openSubmenu(shortcut.dataset.submenu as SubmenuName, true);
      }
    }
  }

  const menu = (
    <div
      ref={menuRef}
      className="task-context-menu"
      role="menu"
      aria-label={text(`${displayIdentifier} 操作`, `${displayIdentifier} actions`)}
      data-submenu-side={submenuSide}
      style={{ left: placedPosition.x, top: placedPosition.y }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="context-menu-group">
        <MenuItem
          label={text("状态", "Status")}
          icon={<StatusIcon status={task.status} color="currentColor" />}
          shortcut="S"
          submenu="status"
          submenuOpen={submenu === "status"}
          rootShortcut="s"
          onPointerEnter={() => scheduleSubmenu("status")}
          onClick={() => openSubmenu("status", true)}
        >
          {submenu === "status" && (
            <div className="context-submenu" role="menu" data-submenu-panel="status" style={{ "--submenu-shift": `${submenuShift}px` } as CSSProperties}>
              {TASK_STATUSES.map((status, index) => (
                <MenuItem
                  key={status}
                  label={taskStatusLabel(language, status)}
                  icon={<StatusIcon status={status} color="currentColor" />}
                  shortcut={String(index + 1)}
                  checked={task.status === status}
                  onClick={() => closeThen(() => onStatusChange(task, status))}
                />
              ))}
            </div>
          )}
        </MenuItem>

        <MenuItem
          label={text("优先级", "Priority")}
          icon={<PriorityIcon priority={task.priority} />}
          shortcut="P"
          submenu="priority"
          submenuOpen={submenu === "priority"}
          rootShortcut="p"
          onPointerEnter={() => scheduleSubmenu("priority")}
          onClick={() => openSubmenu("priority", true)}
        >
          {submenu === "priority" && (
            <div className="context-submenu" role="menu" data-submenu-panel="priority" style={{ "--submenu-shift": `${submenuShift}px` } as CSSProperties}>
              {TASK_PRIORITIES.map((priority, index) => (
                <MenuItem
                  key={priority}
                  label={taskPriorityLabel(language, priority)}
                  icon={<PriorityIcon priority={priority} />}
                  shortcut={String(index)}
                  checked={task.priority === priority}
                  onClick={() => closeThen(() => onPriorityChange(task, priority))}
                />
              ))}
            </div>
          )}
        </MenuItem>

        <MenuItem
          label={text("标签", "Labels")}
          icon={<LabelIcon color="currentColor" />}
          shortcut="L"
          submenu="labels"
          submenuOpen={submenu === "labels"}
          rootShortcut="l"
          onPointerEnter={() => scheduleSubmenu("labels")}
          onClick={() => openSubmenu("labels", true)}
        >
          {submenu === "labels" && (
            <div className="context-submenu labels-submenu" role="menu" data-submenu-panel="labels" style={{ "--submenu-shift": `${submenuShift}px` } as CSSProperties}>
              {labels.length ? labels.map((label) => {
                const selected = task.labels.includes(label);
                const presentation = labelPresentation(label, language);
                return (
                  <MenuItem
                    key={label}
                    label={presentation.name}
                    icon={presentation.tone ? (
                      <span
                        className="context-label-glyph"
                        style={{ "--label-color": presentation.color } as CSSProperties}
                        aria-hidden="true"
                      />
                    ) : null}
                    checked={selected}
                    onClick={() => closeThen(() => onLabelsChange(
                      task,
                      selected ? task.labels.filter((value) => value !== label) : [...task.labels, label],
                    ))}
                  />
                );
              }) : (
                <MenuItem label={text("暂无可用标签", "No labels available")} disabled />
              )}
              <div className="context-menu-divider" role="separator" />
              <MenuItem
                label={text("在编辑器中管理…", "Manage in editor…")}
                icon={<EditIcon color="currentColor" />}
                onClick={() => closeThen(() => onEdit(task))}
              />
            </div>
          )}
        </MenuItem>
      </div>

      <div className="context-menu-divider" role="separator" />

      <div className="context-menu-group">
        <MenuItem
          label={text("编辑议题", "Edit issue")}
          icon={<EditIcon color="currentColor" />}
          shortcut="↵"
          onPointerEnter={closeSubmenu}
          onClick={() => closeThen(() => onEdit(task))}
        />
        {task.source !== "jira" && (
          <MenuItem
            label={text("创建副本", "Create copy")}
            icon={<LinearIcon name="copy" />}
            onPointerEnter={closeSubmenu}
            onClick={() => closeThen(() => onDuplicate(task))}
          />
        )}
        <MenuItem
          label={text("复制", "Copy")}
          icon={<LinearIcon name="copy" />}
          submenu="copy"
          submenuOpen={submenu === "copy"}
          onPointerEnter={() => scheduleSubmenu("copy")}
          onClick={() => openSubmenu("copy", true)}
        >
          {submenu === "copy" && (
            <div className="context-submenu" role="menu" data-submenu-panel="copy" style={{ "--submenu-shift": `${submenuShift}px` } as CSSProperties}>
              <MenuItem
                label={text("复制议题 ID", "Copy issue ID")}
                onClick={() => closeThen(() => onCopy(
                  displayIdentifier,
                  text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copied.`),
                ))}
              />
              <MenuItem
                label={text("复制标题", "Copy title")}
                onClick={() => closeThen(() => onCopy(
                  task.title,
                  text("议题标题已复制。", "Issue title copied."),
                ))}
              />
              <MenuItem
                label={text("复制 Markdown", "Copy Markdown")}
                onClick={() => closeThen(() => onCopy(
                  `**${displayIdentifier}** ${task.title}`,
                  text("Markdown 已复制。", "Markdown copied."),
                ))}
              />
            </div>
          )}
        </MenuItem>
        <MenuItem
          label={text("在新对话打开", "Open in new conversation")}
          icon={<NewConversationIcon color="currentColor" size={16} />}
          disabled={openInThreadDisabled}
          onPointerEnter={closeSubmenu}
          onClick={() => closeThen(() => onOpenInThread(task))}
        />
      </div>

      {task.source !== "jira" && (
        <>
          <div className="context-menu-divider" role="separator" />
          <div className="context-menu-group">
            <MenuItem
              label={text("归档议题", "Archive issue")}
              icon={<DeleteIcon color="currentColor" />}
              shortcut="⌘⌫"
              danger
              onPointerEnter={closeSubmenu}
              onClick={() => closeThen(() => onArchive(task))}
            />
          </div>
        </>
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
