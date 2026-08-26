import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "../types";
import { useTaskboardI18n } from "../i18n";
import { ProjectIcon } from "./SemanticIcons";

interface IssueMentionMenuProps {
  anchor: HTMLElement;
  anchorRect: DOMRect;
  tasks: readonly Task[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (task: Task) => void;
  onClose: () => void;
}

export function IssueMentionMenu({
  anchor,
  anchorRect,
  tasks,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onClose,
}: IssueMentionMenuProps) {
  const { text } = useTaskboardI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const portalTarget = anchor.closest("dialog") ?? document.body;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const openAbove = anchorRect.top - gap - menuRect.height >= edge;
    const left = Math.max(edge, Math.min(anchorRect.left, window.innerWidth - menuRect.width - edge));
    const top = openAbove ? anchorRect.top - menuRect.height - gap : anchorRect.bottom + gap;
    setPosition({ left, top: Math.max(edge, top) });
  }, [activeIndex, anchorRect, tasks.length]);

  useLayoutEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!anchor.contains(target) && !menuRef.current?.contains(target)) onClose();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="ai-chat-skill-menu issue-mention-menu"
      role="listbox"
      aria-label={text("引用議題", "Mention issue")}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {tasks.length > 0 ? tasks.map((task, index) => (
        <button
          className={index === activeIndex ? "is-selected" : ""}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-mention-index={index}
          key={task.id}
          onPointerEnter={() => onActiveIndexChange(index)}
          onClick={() => onSelect(task)}
        >
          <ProjectIcon color="currentColor" />
          <span>
            <strong>{task.externalKey ?? task.identifier}</strong>
            <small>{task.title}</small>
          </span>
        </button>
      )) : (
        <p className="issue-mention-empty">{text("沒有匹配的議題", "No matching issues")}</p>
      )}
    </div>,
    portalTarget,
  );
}
