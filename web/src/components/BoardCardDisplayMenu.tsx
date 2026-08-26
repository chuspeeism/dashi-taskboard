import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { createPortal } from "react-dom";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import {
  MAIN_STATUSES,
  SECONDARY_STATUSES,
} from "../issueBoardStatuses";
import type { OtherTaskTab } from "../issueBoardStatuses";
import type { TaskStatus } from "../types";
import { LinearIcon } from "./LinearIcon";
import { DeleteIcon, StatusIcon } from "./SemanticIcons";

export type BoardStatusPlacement = "main" | "sidebar" | "hidden";

export interface BoardDisplaySettings {
  cover: boolean;
  body: boolean;
  mainStatuses: OtherTaskTab[];
  sidebarStatuses: OtherTaskTab[];
  hiddenStatuses: OtherTaskTab[];
}

export const DEFAULT_BOARD_DISPLAY_SETTINGS: BoardDisplaySettings = {
  cover: true,
  body: false,
  mainStatuses: [...MAIN_STATUSES],
  sidebarStatuses: [...SECONDARY_STATUSES, "archived"],
  hiddenStatuses: [],
};

interface BoardCardDisplayMenuProps {
  settings: BoardDisplaySettings;
  onChange: (value: BoardDisplaySettings) => void;
  onReset: () => void;
}

export function BoardCardDisplayMenu({
  settings,
  onChange,
  onReset,
}: BoardCardDisplayMenuProps) {
  const { language, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draggedStatus, setDraggedStatus] = useState<OtherTaskTab | null>(null);
  const [draggedStatusHeight, setDraggedStatusHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<{
    placement: BoardStatusPlacement;
    beforeStatus: OtherTaskTab | null;
  } | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!dialogOpen) return;
    closeRef.current?.focus();
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setDialogOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => document.removeEventListener("keydown", closeFromEscape);
  }, [dialogOpen]);

  function statusesFor(placement: BoardStatusPlacement) {
    if (placement === "main") return settings.mainStatuses;
    if (placement === "sidebar") return settings.sidebarStatuses;
    return settings.hiddenStatuses;
  }

  function moveStatus(
    status: OtherTaskTab,
    placement: BoardStatusPlacement,
    beforeStatus: OtherTaskTab | null,
  ) {
    const next = {
      main: settings.mainStatuses.filter((candidate) => candidate !== status),
      sidebar: settings.sidebarStatuses.filter((candidate) => candidate !== status),
      hidden: settings.hiddenStatuses.filter((candidate) => candidate !== status),
    };
    const target = next[placement];
    const beforeIndex = beforeStatus ? target.indexOf(beforeStatus) : -1;
    target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, status);
    onChange({
      ...settings,
      mainStatuses: next.main,
      sidebarStatuses: next.sidebar,
      hiddenStatuses: next.hidden,
    });
  }

  function findDropBefore(container: HTMLElement, clientY: number): OtherTaskTab | null {
    const items = Array.from(container.querySelectorAll<HTMLElement>("[data-display-status]"))
      .filter((item) => item.dataset.displayStatus !== draggedStatus);
    return (items.find((item) => (
      clientY < item.getBoundingClientRect().top + item.offsetHeight / 2
    ))?.dataset.displayStatus as OtherTaskTab | undefined) ?? null;
  }

  function getStatusDragShift(status: OtherTaskTab, placement: BoardStatusPlacement) {
    if (!draggedStatus || status === draggedStatus) return 0;
    const statuses = statusesFor(placement);
    const remainingStatuses = statuses.filter((candidate) => candidate !== draggedStatus);
    const statusIndex = statuses.indexOf(status);
    const remainingIndex = remainingStatuses.indexOf(status);
    const draggedIndex = statuses.indexOf(draggedStatus);
    const beforeIndex = dropTarget?.placement === placement
      ? dropTarget.beforeStatus
        ? remainingStatuses.indexOf(dropTarget.beforeStatus)
        : remainingStatuses.length
      : -1;
    let shift = 0;
    const dragDistance = draggedStatusHeight + 8;

    if (draggedIndex >= 0 && statusIndex > draggedIndex) shift -= dragDistance;
    if (beforeIndex >= 0 && remainingIndex >= beforeIndex) shift += dragDistance;
    return shift;
  }

  function handleDrop(event: DragEvent<HTMLElement>, placement: BoardStatusPlacement) {
    event.preventDefault();
    const status = (
      event.dataTransfer.getData("application/x-taskboard-display-status")
      || event.dataTransfer.getData("text/plain")
    ) as OtherTaskTab;
    if (status) moveStatus(status, placement, findDropBefore(event.currentTarget, event.clientY));
    setDraggedStatus(null);
    setDraggedStatusHeight(0);
    setDropTarget(null);
  }

  function closeDialog() {
    setDialogOpen(false);
    triggerRef.current?.focus();
  }

  const menu = menuOpen ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu board-display-menu no-drag"
      role="dialog"
      aria-label={text("顯示設定", "Display settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("顯示設定", "Display settings")}</strong>
      </div>
      <div className="project-automation-switch">
        <span>{text("封面", "Cover")}</span>
        <button
          type="button"
          className={"board-setting-switch" + (settings.cover ? " is-on" : "")}
          role="switch"
          aria-label={text("顯示封面", "Show cover")}
          aria-checked={settings.cover}
          onClick={() => onChange({ ...settings, cover: !settings.cover })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="project-automation-switch">
        <span>{text("正文", "Body")}</span>
        <button
          type="button"
          className={"board-setting-switch" + (settings.body ? " is-on" : "")}
          role="switch"
          aria-label={text("顯示正文", "Show body")}
          aria-checked={settings.body}
          onClick={() => onChange({ ...settings, body: !settings.body })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <button
        className="display-settings-more"
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setMenuOpen(false);
          setDialogOpen(true);
        }}
      >
        <span>{text("更多顯示設定", "More display settings")}</span>
        <span aria-hidden="true">›</span>
      </button>
    </div>,
    document.body,
  ) : null;

  const dialog = dialogOpen ? createPortal(
    <div
      className="display-settings-backdrop no-drag"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        className="display-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="display-settings-title"
      >
        <header className="display-settings-header">
          <h2 id="display-settings-title">{text("更多顯示設定", "More display settings")}</h2>
          <button
            ref={closeRef}
            className="icon-button display-settings-close"
            type="button"
            aria-label={text("關閉顯示設定", "Close display settings")}
            onClick={closeDialog}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <div className="display-settings-columns">
          {([
            ["main", text("正常顯示", "Main board")],
            ["sidebar", text("側邊欄顯示", "Sidebar")],
            ["hidden", text("隱藏", "Hidden")],
          ] as const).map(([placement, label]) => (
            <section
              className={"display-settings-column" + (
                dropTarget?.placement === placement ? " is-drop-target" : ""
              )}
              aria-label={label}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({
                  placement,
                  beforeStatus: findDropBefore(event.currentTarget, event.clientY),
                });
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(event) => handleDrop(event, placement)}
              key={placement}
            >
              <h3>{label}</h3>
              <div className="display-settings-status-list">
                {statusesFor(placement).map((status) => {
                  const dragShift = getStatusDragShift(status, placement);
                  return (
                    <div
                      className={`display-settings-status-item status-${status}` + (
                        draggedStatus === status ? " is-dragging" : ""
                      ) + (dragShift ? " is-drag-shifted" : "") + (
                        dropTarget?.placement === placement && dropTarget.beforeStatus === status
                          ? " is-drop-before"
                          : ""
                      )}
                      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
                      draggable
                      data-display-status={status}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", status);
                        event.dataTransfer.setData("application/x-taskboard-display-status", status);
                        setDraggedStatus(status);
                        setDraggedStatusHeight(event.currentTarget.offsetHeight);
                      }}
                      onDragEnd={() => {
                        setDraggedStatus(null);
                        setDraggedStatusHeight(0);
                        setDropTarget(null);
                      }}
                      key={status}
                    >
                      {status === "archived"
                        ? <DeleteIcon color="var(--display-status-color)" size={15} />
                        : <StatusIcon status={status as TaskStatus} color="var(--display-status-color)" size={15} />}
                      <span>{status === "archived"
                        ? text("已歸檔", "Archived")
                        : taskStatusLabel(language, status)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className="display-settings-footer">
          <button className="button secondary" type="button" onClick={onReset}>
            {text("重置為預設", "Reset to default")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        className={"task-filter-trigger board-card-display-trigger" + (
          menuOpen || dialogOpen ? " is-open" : ""
        )}
        type="button"
        aria-label={text("顯示設定", "Display settings")}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        title={text("顯示設定", "Display settings")}
        onClick={() => {
          if (!menuOpen) setPosition({ left: 0, top: 0, ready: false });
          setMenuOpen((current) => !current);
        }}
      >
        <LinearIcon name="displayOptions" />
      </button>
      {menu}
      {dialog}
    </>
  );
}
