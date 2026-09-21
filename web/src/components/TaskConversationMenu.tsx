import { agentPlatformLabel, sessionResumeCommand } from "../agentSessions";
import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { TaskConversationItem } from "../taskConversations";
import { useTaskboardI18n } from "../i18n";
import { listenForMenuViewportChange, listenForOutsidePointerDown } from "../menuEvents";
import { ConversationIcon } from "./SemanticIcons";

interface TaskConversationMenuProps {
  conversations: TaskConversationItem[];
  onOpenConversation: (conversation: TaskConversationItem) => void;
}

function conversationSource(
  conversation: TaskConversationItem,
  text: (chinese: string, english: string) => string,
) {
  if (conversation.kind === "local-ai") return text("內建 AI", "Built-in AI");
  if (conversation.kind === "agent-session") {
    return conversation.source === "comment"
      ? text("評論對話 · 複製恢復命令", "Comment conversation · Copy resume command")
      : text("任務對話 · 複製恢復命令", "Task conversation · Copy resume command");
  }
  return conversation.source === "comment"
    ? text("評論對話", "Comment conversation")
    : text("任務對話", "Task conversation");
}

function conversationStatus(
  conversation: TaskConversationItem,
  text: (chinese: string, english: string) => string,
) {
  if (conversation.currentRun?.status === "running") {
    if (conversation.latestTodo?.total) {
      return `${conversation.latestTodo.completed}/${conversation.latestTodo.total}`;
    }
    return text("正在處理", "Processing");
  }
  if (conversation.agentSession) return agentPlatformLabel(conversation.agentSession.platform);
  return conversation.kind === "local-ai" ? text("已暫停", "Paused") : "Codex";
}

export function TaskConversationMenu({
  conversations,
  onOpenConversation,
}: TaskConversationMenuProps) {
  const { text } = useTaskboardI18n();
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
    const close = () => setOpen(false);
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], close);
    const stopViewport = listenForMenuViewportChange(menuRef, close);
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      stopOutside();
      stopViewport();
      window.removeEventListener("keydown", closeFromEscape);
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
  const singleAgentSession = !multiple ? conversations[0].agentSession : undefined;
  const singleAgentLabel = singleAgentSession ? agentPlatformLabel(singleAgentSession.platform) : "";
  return (
    <>
      <button
        ref={triggerRef}
        className={`task-conversation-trigger${multiple ? " is-multiple" : ""}${singleAgentSession ? " is-agent-session" : ""}${open ? " is-open" : ""}`}
        type="button"
        draggable={false}
        aria-label={multiple
          ? text(`檢視 ${conversations.length} 個對話`, `View ${conversations.length} conversations`)
          : singleAgentSession
            ? text(`複製 ${singleAgentLabel} 恢復命令`, `Copy ${singleAgentLabel} resume command`)
            : text(`開啟對話 ${conversations[0].title}`, `Open conversation ${conversations[0].title}`)}
        aria-haspopup={multiple ? "menu" : undefined}
        aria-expanded={multiple ? open : undefined}
        title={multiple
          ? text(`${conversations.length} 個對話`, `${conversations.length} conversations`)
          : singleAgentSession
            ? `${singleAgentLabel}: ${sessionResumeCommand(singleAgentSession.platform, singleAgentSession.sessionId)}`
            : conversations[0].title}
        onPointerDown={stop}
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (multiple) setOpen((current) => !current);
          else openConversation(conversations[0]);
        }}
      >
        <ConversationIcon color="currentColor" size={16} />
        {multiple && <span>+{conversations.length}</span>}
        {singleAgentSession && <span>{singleAgentLabel}</span>}
      </button>
      {open && multiple && createPortal(
        <div
          ref={menuRef}
          className="task-conversation-menu"
          role="menu"
          aria-label={text("選擇對話", "Select conversation")}
          style={{
            left: position.left,
            top: position.top,
            visibility: position.ready ? "visible" : "hidden",
          }}
          onClick={stop}
        >
          <div className="task-conversation-menu-heading">{text("關聯對話", "Linked conversations")}</div>
          {conversations.map((conversation) => (
            <button
              key={conversation.key}
              type="button"
              role="menuitem"
              title={conversation.agentSession
                ? sessionResumeCommand(conversation.agentSession.platform, conversation.agentSession.sessionId)
                : undefined}
              onClick={() => openConversation(conversation)}
            >
              <span className="task-conversation-menu-icon">
                <ConversationIcon color="currentColor" size={13} />
              </span>
              <span className="task-conversation-menu-copy">
                <strong>{conversation.title}</strong>
                <small>{conversationSource(conversation, text)}</small>
              </span>
              <span className={`task-conversation-menu-status${conversation.currentRun?.status === "running" ? " is-running" : ""}`}>
                {conversationStatus(conversation, text)}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
