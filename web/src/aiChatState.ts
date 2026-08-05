import type {
  AiChatEvent,
  AiChatAttachmentInput,
  AiChatModel,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  AiChatThreadStatus,
  TaskboardCapabilities,
} from "./types";

export interface AiChatRouteState {
  selectedThreadId: string | null;
  pendingProjectId: string | null;
  pendingIssueId: string | null;
}

export const AI_CHAT_SKILL_MARKER = "\uFFFC";

export const AI_CHAT_PREFERENCE_KEY = "taskboard.aiChat.preference.v1";

export interface AiChatPreference {
  model: string;
  reasoningEffort: string;
}

export function readAiChatPreference(storage?: Pick<Storage, "getItem">): AiChatPreference | null {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(AI_CHAT_PREFERENCE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || typeof (value as AiChatPreference).model !== "string"
      || !(value as AiChatPreference).model.trim()
      || typeof (value as AiChatPreference).reasoningEffort !== "string"
    ) {
      return null;
    }
    return {
      model: (value as AiChatPreference).model,
      reasoningEffort: (value as AiChatPreference).reasoningEffort,
    };
  } catch {
    return null;
  }
}

export function writeAiChatPreference(
  pref: AiChatPreference,
  storage?: Pick<Storage, "setItem">,
): void {
  storage?.setItem?.(AI_CHAT_PREFERENCE_KEY, JSON.stringify(pref));
}

export function parseAiChatComposerFragment(
  raw: string,
  validSkillIds: Iterable<string>,
): { message: string; skillIds: string[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; skillIds?: unknown };
    const validIds = new Set(validSkillIds);
    if (
      typeof parsed.message !== "string"
      || !Array.isArray(parsed.skillIds)
      || !parsed.skillIds.every((skillId): skillId is string => typeof skillId === "string")
      || parsed.message.split(AI_CHAT_SKILL_MARKER).length - 1 !== parsed.skillIds.length
      || !parsed.skillIds.every((skillId) => validIds.has(skillId))
    ) {
      return null;
    }
    return { message: parsed.message, skillIds: parsed.skillIds };
  } catch {
    return null;
  }
}

export function isAiChatCapabilityAvailable(capabilities?: TaskboardCapabilities): boolean {
  return capabilities?.localAiChat === true;
}

export function buildThreadCreateInput(projectId: string, issueId: string | null) {
  if (!projectId) return null;
  return {
    projectId,
    ...(issueId ? { issueId } : {}),
  };
}

export function routeChatState(
  state: AiChatRouteState,
  projectId: string | null,
  issueId: string | null,
): AiChatRouteState {
  return {
    ...state,
    pendingProjectId: projectId,
    pendingIssueId: issueId,
  };
}

export function normalizeChatSelection(
  models: AiChatModel[],
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
) {
  const selectedModel = models.find((candidate) => candidate.slug === model) ?? models[0];
  if (!selectedModel) return null;
  return {
    model: selectedModel.slug,
    reasoningEffort: reasoningEffortForModel(selectedModel, reasoningEffort),
  };
}

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function reasoningEffortForModel(
  model: AiChatModel,
  currentEffort: string | null | undefined,
): string {
  const current = currentEffort ?? "";
  const currentIndex = REASONING_EFFORTS.indexOf(current);
  if (currentIndex < 0) return model.defaultReasoningEffort;
  if (model.supportedReasoningEfforts.includes(current)) {
    return current;
  }
  const nearestEffort = model.supportedReasoningEfforts
    .map((effort) => ({ effort, index: REASONING_EFFORTS.indexOf(effort) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => (
      Math.abs(left.index - currentIndex) - Math.abs(right.index - currentIndex)
      || left.index - right.index
    ))[0];
  return nearestEffort?.effort ?? model.defaultReasoningEffort;
}

export function settingsForNewAiThread(
  catalogProjectId: string | null,
  draftProjectId: string | null,
  settings: { model: string; reasoningEffort: string; sandbox: AiChatSandbox } | undefined,
): Partial<{ model: string; reasoningEffort: string; sandbox: AiChatSandbox }> {
  if (!catalogProjectId || catalogProjectId !== draftProjectId || !settings) return {};
  return settings;
}

export function buildTurnInput(
  message: string,
  skillIds: string[],
  dangerFullAccessConfirmed: boolean,
  attachments: AiChatAttachmentInput[] = [],
) {
  return {
    message,
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(dangerFullAccessConfirmed ? { dangerFullAccessConfirmed: true } : {}),
  };
}

export function chatPrimaryAction(
  status: AiChatThreadStatus,
  message: string,
  blocked = false,
  hasAttachments = false,
): "send" | "stop" | "disabled" {
  if (blocked) return "disabled";
  if (status === "running") return "stop";
  return message.trim() || hasAttachments ? "send" : "disabled";
}

export function needsDangerConfirmation(
  sandbox: AiChatSandbox,
  confirmed: boolean,
): boolean {
  return sandbox === "danger-full-access" && !confirmed;
}

export function shouldRefreshAiSnapshot(type: string): boolean {
  return type === "ai.event" || type === "ai.run";
}

const VISIBLE_EVENT_TYPES = new Set([
  "agent_message",
  "assistant",
  "plan",
  "todo",
  "todo_list",
  "command",
  "command_execution",
  "file",
  "file_change",
  "mcp",
  "mcp_tool_call",
  "skill",
  "web",
  "web_search",
  "error",
  "turn.failed",
  "user_message",
  "user",
]);

function isMessageEvent(event: Pick<AiChatEvent, "role" | "type">): boolean {
  return event.role === "user"
    || event.role === "assistant"
    || event.type === "user"
    || event.type === "user_message"
    || event.type === "assistant"
    || event.type === "agent_message";
}

export function filterVisibleAiEvents<
  T extends Pick<AiChatEvent, "type" | "role" | "data">,
>(events: T[]): T[] {
  const visible = events.filter((event) => VISIBLE_EVENT_TYPES.has(event.type));
  const latestActivityIndex = new Map<string, number>();
  visible.forEach((event, index) => {
    const itemId = event.data?.itemId;
    if (!isMessageEvent(event) && typeof itemId === "string") {
      latestActivityIndex.set(itemId, index);
    }
  });
  return visible.filter((event, index) => {
    const itemId = event.data?.itemId;
    return isMessageEvent(event)
      || typeof itemId !== "string"
      || latestActivityIndex.get(itemId) === index;
  });
}

export function aiChatEventStatus(
  event: Pick<AiChatEvent, "role" | "type" | "data">,
): "running" | "completed" | "failed" {
  if (event.role === "error" || event.type === "error" || event.type === "turn.failed") {
    return "failed";
  }
  const status = event.data?.status;
  if (status === "running" || status === "started" || status === "in_progress") {
    return "running";
  }
  if (status === "failed" || status === "error") return "failed";
  return "completed";
}

export function patchAiChatSnapshot(
  current: AiChatThreadSnapshot | null,
  threadId: string,
  thread: AiChatThread,
): AiChatThreadSnapshot | null {
  if (!current || current.thread.id !== threadId) return current;
  return { ...current, thread };
}

export interface SkillMentionMatch {
  start: number;
  end: number;
  query: string;
}

export function readSkillMention(text: string, offset: number): SkillMentionMatch | null {
  const prefix = text.slice(0, offset);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  return {
    start: prefix.lastIndexOf("@"),
    end: offset,
    query: match[1],
  };
}

export function insertSkillMention(
  text: string,
  start: number,
  end: number,
  skill: { id: string; label: string },
): { value: string; caret: number; skillId: string } {
  const label = skill.label;
  const value = `${text.slice(0, start)}@${label}${text.slice(end)}`;
  return { value, caret: start + 1 + label.length, skillId: skill.id };
}

export function createAiSnapshotRefreshQueue(
  refresh: (threadId: string) => Promise<void>,
) {
  const states = new Map<string, {
    queued: boolean;
    promise: Promise<void>;
  }>();
  let active = true;

  return {
    request(threadId: string): Promise<void> {
      const current = states.get(threadId);
      if (current) {
        current.queued = true;
        return current.promise;
      }

      const state = {
        queued: false,
        promise: Promise.resolve(),
      };
      state.promise = (async () => {
        do {
          state.queued = false;
          await refresh(threadId);
        } while (active && state.queued);
      })().finally(() => {
        if (states.get(threadId) === state) states.delete(threadId);
      });
      states.set(threadId, state);
      return state.promise;
    },
    clear() {
      active = false;
      states.clear();
    },
  };
}
