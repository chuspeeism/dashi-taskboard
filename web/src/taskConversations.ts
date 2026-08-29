import type {
  AiChatRun,
  AiChatThread,
  AiChatTodoProgress,
  CodexThreadBinding,
  ComposerPersistedDocument,
  Task,
} from "./types";
import type { InlineMediaSegment } from "./components/InlineMediaComposer";

export interface TaskConversationItem {
  key: string;
  projectId: string;
  kind: "native" | "local-ai";
  title: string;
  source: "task" | "comment" | "local-ai";
  nativeThreadId: string | null;
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
  aiThreadId: string | null;
  updatedAt: string;
  currentRun: AiChatRun | null;
  latestTodo: AiChatTodoProgress | null;
}

export interface TaskProcessingPresentation {
  running: boolean;
  completed: number | null;
  total: number | null;
  startedAt: string | null;
}

export interface TaskCardPresentation {
  conversations: TaskConversationItem[];
  processing: TaskProcessingPresentation;
  unread: boolean;
}

export function buildPersistedTaskComposerDocument(
  beforeDescription: string,
  descriptionSegments: InlineMediaSegment[],
  afterDescription: string,
): ComposerPersistedDocument {
  const nodes: ComposerPersistedDocument["nodes"] = [];
  const appendText = (value: string) => {
    if (!value) return;
    const previous = nodes.at(-1);
    if (previous?.type === "text") previous.text += value;
    else nodes.push({ type: "text", text: value });
  };

  appendText(beforeDescription);
  for (const segment of descriptionSegments) {
    if (segment.type === "skill-reference" || segment.type === "agent-reference") {
      nodes.push({
        type: "persistedReference",
        referenceKind: segment.type === "skill-reference" ? "skill" : "agent",
        referenceKey: segment.referenceKey,
        label: segment.label,
      });
    } else if (segment.type === "unsupported-reference") {
      nodes.push({
        type: "unsupportedReference",
        referenceUri: segment.referenceUri,
        label: segment.label,
      });
    } else if (segment.type === "text") {
      appendText(segment.text);
    } else if (segment.type === "pending-image" || segment.type === "pending-attachment") {
      appendText(segment.token);
    } else {
      appendText(segment.markdown);
    }
  }
  appendText(afterDescription);
  return { version: 1, nodes };
}

export function normalizeCodexThreadId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/^(?:local|cloud):/i, "").trim();
}

function newerTimestamp(left: string, right: string) {
  return left > right ? left : right;
}

export function taskConversations(task: Task, aiThreads: AiChatThread[]) {
  const items = new Map<string, TaskConversationItem>();

  for (const ref of task.conversationRefs ?? []) {
    const normalizedId = normalizeCodexThreadId(ref.threadId);
    if (!normalizedId) continue;
    const key = `codex:${normalizedId}`;
    const current = items.get(key);
    const next: TaskConversationItem = {
      key,
      projectId: task.projectId,
      kind: "native",
      title: ref.title || task.title,
      source: ref.source,
      nativeThreadId: ref.threadId,
      threadBinding: ref.legacyLocal ? null : {
        threadId: ref.threadId,
        codexProjectId: ref.codexProjectId,
        codexProjectKind: ref.codexProjectKind,
        codexHostId: ref.codexHostId,
        workspacePath: ref.workspacePath,
      },
      legacyLocalThreadId: ref.legacyLocal ? ref.threadId : null,
      aiThreadId: null,
      updatedAt: ref.updatedAt,
      currentRun: null,
      latestTodo: null,
    };
    if (!current || next.updatedAt >= current.updatedAt) items.set(key, next);
  }

  for (const thread of aiThreads) {
    if (thread.origin.projectId !== task.projectId || thread.origin.issueId !== task.id) continue;
    const normalizedId = normalizeCodexThreadId(thread.codexThreadId);
    const key = normalizedId ? `codex:${normalizedId}` : `ai:${thread.id}`;
    const current = items.get(key);
    const threadActivityUpdatedAt = [
      thread.updatedAt,
      thread.currentRun?.startedAt ?? "",
      thread.latestTodo?.updatedAt ?? "",
    ].reduce(newerTimestamp);
    const candidate: TaskConversationItem = {
      key,
      projectId: task.projectId,
      kind: "local-ai",
      title: thread.title || thread.origin.issueIdentifier || task.title,
      source: "local-ai",
      nativeThreadId: current?.nativeThreadId ?? thread.codexThreadId,
      threadBinding: current?.threadBinding ?? null,
      legacyLocalThreadId: current?.legacyLocalThreadId ?? null,
      aiThreadId: thread.id,
      updatedAt: current?.kind === "native"
        ? newerTimestamp(current.updatedAt, threadActivityUpdatedAt)
        : threadActivityUpdatedAt,
      currentRun: thread.currentRun ?? null,
      latestTodo: thread.latestTodo ?? null,
    };
    if (current?.kind === "local-ai") {
      const currentRunning = current.currentRun?.status === "running";
      const candidateRunning = candidate.currentRun?.status === "running";
      if (currentRunning && !candidateRunning) continue;
      if (currentRunning === candidateRunning && current.updatedAt > threadActivityUpdatedAt) continue;
    }
    items.set(key, candidate);
  }

  return [...items.values()].sort((left, right) => {
    const leftRunning = left.currentRun?.status === "running" ? 1 : 0;
    const rightRunning = right.currentRun?.status === "running" ? 1 : 0;
    if (leftRunning !== rightRunning) return rightRunning - leftRunning;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.key.localeCompare(right.key);
  });
}

export function taskCardPresentation(
  task: Task,
  aiThreads: AiChatThread[],
  unread: boolean,
  runningNativeThreadId: string | null = null,
  runningNativeTodoProgress: { completed: number; total: number } | null = null,
  taskNativeSession: {
    completed: number | null;
    total: number | null;
    running: boolean;
  } | null | undefined = undefined,
): TaskCardPresentation {
  const conversations = taskConversations(task, aiThreads);
  const runningAi = conversations
    .filter((conversation) => conversation.currentRun?.status === "running")
    .sort((left, right) => (
      (right.currentRun?.startedAt ?? "").localeCompare(left.currentRun?.startedAt ?? "")
    ))[0];
  const normalizedRunningNativeThreadId = normalizeCodexThreadId(runningNativeThreadId);
  const runningNative = task.status === "in_progress" && normalizedRunningNativeThreadId
    ? conversations.find((conversation) => (
        normalizeCodexThreadId(conversation.nativeThreadId) === normalizedRunningNativeThreadId
      ))
    : undefined;
  const running = runningAi ?? runningNative;
  const taskNativeTodoProgress = taskNativeSession
    && taskNativeSession.completed !== null
    && taskNativeSession.total !== null
    ? { completed: taskNativeSession.completed, total: taskNativeSession.total }
    : null;
  const latestTodo = runningAi
    ? runningAi.latestTodo
    : runningNative
      ? taskNativeTodoProgress ?? runningNativeTodoProgress ?? null
      : taskNativeSession !== undefined
        ? taskNativeTodoProgress
        : conversations.find((conversation) => conversation.latestTodo)?.latestTodo ?? null;
  return {
    conversations,
    unread,
    processing: {
      running: task.status === "in_progress"
        && (Boolean(running) || taskNativeSession?.running === true),
      completed: latestTodo?.completed ?? null,
      total: latestTodo?.total ?? null,
      startedAt: runningAi?.currentRun?.startedAt ?? null,
    },
  };
}
