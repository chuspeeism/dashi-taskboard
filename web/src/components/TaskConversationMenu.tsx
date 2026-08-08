import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { TaskConversationItem } from "../taskConversations";
import { TaskboardIcon } from "./TaskboardIcon";

interface TaskConversationMenuProps {
  conversations: TaskConversationItem[];
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

function conversationSource(conversation: TaskConversationItem) {
  if (conversation.kind === "local-ai") return "内置 AI";
  return conversation.source === "comment" ? "评论对话" : "任务对话";
}

function conversationStatus(conversation: TaskConversationItem) {
  if (conversation.currentRun?.status === "running") {
    if (conversation.latestTodo?.total) {
      return `${conversation.latestTodo.completed}/${conversation.latestTodo.total}`;
    }
    return "正在处理";
  }
  return conversation.kind === "local-ai" ? "已暂停" : "Codex";
}

export function TaskConversationMenu({
  conversations,
  onOpenConversation,
}: TaskConversationMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 6;
    const left = Math.max(8, Math.min(
      window.innerWidth - menuRect.width - 8,
      rect.right - menuRect.width,
    ));
    const preferredTop = rect.bottom + gap;
    const top = preferredTop + menuRect.height <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - menuRect.height - gap);
    setPosition({ left, top, ready: true });
  }, [open, conversations.length]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  if (conversations.length === 0) return null;

  function stop(event: SyntheticEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function openConversation(conversation: TaskConversationItem) {
    setOpen(false);
    onOpenConversation(conversation);
  }

  const multiple = conversations.length > 1;
  return (
    <>
      <button
        ref={triggerRef}
        className={`task-conversation-trigger${multiple ? " is-multiple" : ""}${open ? " is-open" : ""}`}
        type="button"
        draggable={false}
        aria-label={multiple ? `查看 ${conversations.length} 个对话` : `打开对话 ${conversations[0].title}`}
        aria-haspopup={multiple ? "menu" : undefined}
        aria-expanded={multiple ? open : undefined}
        title={multiple ? `${conversations.length} 个对话` : conversations[0].title}
        onPointerDown={stop}
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (multiple) setOpen((current) => !current);
          else openConversation(conversations[0]);
        }}
      >
        <TaskboardIcon name="conversation" />
        {multiple && <span>+{conversations.length}</span>}
      </button>
      {open && multiple && createPortal(
        <div
          ref={menuRef}
          className="task-conversation-menu"
          role="menu"
          aria-label="选择对话"
          style={{
            left: position.left,
            top: position.top,
            visibility: position.ready ? "visible" : "hidden",
          }}
          onClick={stop}
        >
          <div className="task-conversation-menu-heading">关联对话</div>
          {conversations.map((conversation) => (
            <button
              key={conversation.key}
              type="button"
              role="menuitem"
              onClick={() => openConversation(conversation)}
            >
              <span className="task-conversation-menu-icon">
                <TaskboardIcon name="conversation" />
              </span>
              <span className="task-conversation-menu-copy">
                <strong>{conversation.title}</strong>
                <small>{conversationSource(conversation)}</small>
              </span>
              <span className={`task-conversation-menu-status${conversation.currentRun?.status === "running" ? " is-running" : ""}`}>
                {conversationStatus(conversation)}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
