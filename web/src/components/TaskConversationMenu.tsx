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
  if (conversation.kind === "local-ai") return text("内置 AI", "Built-in AI");
  if (conversation.kind === "agent-session") {
    if (conversation.agentSession?.platform === "chatgpt") {
      return conversation.source === "comment"
        ? text("评论来源 · ChatGPT 网页", "Comment source · ChatGPT web")
        : text("任务来源 · ChatGPT 网页", "Task source · ChatGPT web");
    }
    return conversation.source === "comment"
      ? text("评论对话 · 复制恢复命令", "Comment conversation · Copy resume command")
      : text("任务对话 · 复制恢复命令", "Task conversation · Copy resume command");
  }
  return conversation.source === "comment"
    ? text("评论对话", "Comment conversation")
    : text("任务对话", "Task conversation");
}

function conversationStatus(
  conversation: TaskConversationItem,
  text: (chinese: string, english: string) => string,
) {
  if (conversation.currentRun?.status === "running") {
    if (conversation.latestTodo?.total) {
      return `${conversation.latestTodo.completed}/${conversation.latestTodo.total}`;
    }
    return text("正在处理", "Processing");
  }
  if (conversation.agentSession) return agentPlatformLabel(conversation.agentSession.platform);
  return conversation.kind === "local-ai" ? text("已暂停", "Paused") : "Codex";
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
  if (singleAgentSession?.platform === "chatgpt" && !singleAgentSession.sessionId) {
    return <span className="task-conversation-trigger is-agent-session" title={singleAgentLabel}>
      <ConversationIcon color="currentColor" size={16} />
      <span>{singleAgentLabel}</span>
    </span>;
  }
  return (
    <>
      <button
        ref={triggerRef}
        className={`task-conversation-trigger${multiple ? " is-multiple" : ""}${singleAgentSession ? " is-agent-session" : ""}${open ? " is-open" : ""}`}
        type="button"
        draggable={false}
        aria-label={multiple
          ? text(`查看 ${conversations.length} 个对话`, `View ${conversations.length} conversations`)
          : singleAgentSession
            ? singleAgentSession.platform === "chatgpt"
              ? text("复制 ChatGPT 网页会话 ID", "Copy ChatGPT web conversation ID")
              : text(`复制 ${singleAgentLabel} 恢复命令`, `Copy ${singleAgentLabel} resume command`)
            : text(`打开对话 ${conversations[0].title}`, `Open conversation ${conversations[0].title}`)}
        aria-haspopup={multiple ? "menu" : undefined}
        aria-expanded={multiple ? open : undefined}
        title={multiple
          ? text(`${conversations.length} 个对话`, `${conversations.length} conversations`)
          : singleAgentSession
            ? `${singleAgentLabel}${singleAgentSession.sessionId ? `: ${sessionResumeCommand(singleAgentSession.platform, singleAgentSession.sessionId)}` : ""}`
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
          aria-label={text("选择对话", "Select conversation")}
          style={{
            left: position.left,
            top: position.top,
            visibility: position.ready ? "visible" : "hidden",
          }}
          onClick={stop}
        >
          <div className="task-conversation-menu-heading">{text("关联对话", "Linked conversations")}</div>
          {conversations.map((conversation) => (
            <button
              key={conversation.key}
              type="button"
              role="menuitem"
              disabled={conversation.agentSession?.platform === "chatgpt" && !conversation.agentSession.sessionId}
              title={conversation.agentSession?.sessionId
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
