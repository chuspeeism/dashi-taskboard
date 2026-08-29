import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { taskboardStorage } from "../storage";
import { useTaskboardI18n } from "../i18n";
import {
  createAiChatThread,
  deleteAiChatThread,
  getAiChatCatalog,
  getAiChatComposerCandidates,
  getAiChatThread,
  interruptAiChatRun,
  compactAiChatThread,
  listAiChatThreads,
  rebindAiChatComposerReferences,
  startAiChatComposerTurn,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../api";
import {
  AI_CHAT_SKILL_MARKER,
  aiChatEventStatus,
  buildThreadCreateInput,
  buildComposerTurnInput,
  buildTurnInput,
  chatPrimaryAction,
  createAiSnapshotRefreshQueue,
  createComposerDocument,
  filterVisibleAiEvents,
  needsDangerConfirmation,
  normalizeChatSelection,
  parseAiChatComposerFragment,
  patchAiChatSnapshot,
  reasoningEffortForModel,
  insertComposerAgent,
  insertComposerSkill,
  serializeComposerDocument,
} from "../aiChatState";
import type {
  AiChatCatalog,
  AiChatEvent,
  AiChatAttachmentInput,
  AiChatModel,
  AiChatRun,
  AiChatSandbox,
  AiChatSkill,
  AiChatThread,
  AiChatThreadSnapshot,
  CodexProjectIdentity,
  ComposerCandidatesResponse,
  ComposerDocument,
  ComposerPersistedDocument,
  ComposerAgentCandidate,
  ComposerCandidate,
  ComposerSkillCandidate,
  ComposerSlashActionCandidate,
  ComposerTrigger,
} from "../types";
import { COMPOSER_CONTRACT_VERSION } from "../types";
import { LinearIcon } from "./LinearIcon";
import {
  AttachmentIcon,
  ConversationIcon,
  DeleteIcon,
  EditIcon,
  FullAccessPermissionIcon,
  PlusIcon,
  ProjectIcon,
  ReadOnlyPermissionIcon,
  RefreshIcon,
  RelationIcon,
  SendIcon,
  StatusIcon,
  WorkspaceWritePermissionIcon,
} from "./SemanticIcons";
import { TaskboardIcon } from "./TaskboardIcon";

export type AiChatOpenThreadRequest = {
  threadId: string;
  requestId: number;
} | {
  projectId: string;
  issueId: string | null;
  composerText: string;
  requestId: number;
} | {
  projectId: string;
  issueId: string | null;
  composerDraft: {
    ready: boolean;
    revision: string;
    document: ComposerDocument | ComposerPersistedDocument;
  };
  requestId: number;
};

interface AiChatProps {
  available: boolean;
  projectId: string | null;
  issueId: string | null;
  codexProjectIdentity: CodexProjectIdentity | null;
  onThreadsChange?: (threads: AiChatThread[]) => void;
  openThreadRequest?: AiChatOpenThreadRequest | null;
}

type MenuName = "model" | "model-list" | "effort-list" | "sandbox" | null;
type ComposerDraftNode =
  | ComposerDocument["nodes"][number]
  | ComposerPersistedDocument["nodes"][number];
type ComposerPersistedNode = Exclude<
  ComposerPersistedDocument["nodes"][number],
  { type: "text" }
>;
type ComposerDraftDocument = {
  version: 1;
  nodes: ComposerDraftNode[];
};
type PendingDangerInput = {
  message: string;
  skillIds: string[];
  composerDocument?: ComposerDraftDocument;
  composerRevision?: string;
  attachments: AiChatAttachmentInput[];
  clearSubmittedDraft: boolean;
};
type ComposerAttachment = AiChatAttachmentInput & {
  id: string;
  previewUrl?: string;
};
type ComposerSkillToken = {
  key: string;
  candidateRef: string;
  label: string;
  kind?: "skill" | "agent";
  unavailable?: boolean;
  element: HTMLSpanElement;
};
type ComposerStableReference = {
  kind: "skill" | "agent";
  stableId: string;
  referenceKey: string;
  label: string;
  markdown: string;
};
type ComposerFragment = {
  message: string;
  skillIds: string[];
  references?: Array<ComposerStableReference | null>;
};
type ComposerQuery = {
  trigger: ComposerTrigger;
  query: string;
};
type ComposerBeforeInput = {
  container: Node;
  offset: number;
  text: string;
};
type DraftThreadOrigin = {
  projectId: string;
  issueId: string | null;
  codexProjectIdentity: CodexProjectIdentity | null;
};
type PanelResizeEdge = "top" | "left" | "top-left";
type PanelGeometry = {
  width: number;
  height: number;
};
type PanelResizeSession = {
  edge: PanelResizeEdge;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  geometry: PanelGeometry;
  captureTarget: HTMLElement;
};

const LAST_THREAD_KEY = "taskboard.aiChat.lastThreadId";
const PANEL_VIEW_KEY = "taskboard.aiChat.panelView";
const PANEL_GEOMETRY_KEY = "taskboard.aiChat.panelGeometry";
const PANEL_EDGE_GAP = 8;
const PANEL_MIN_WIDTH = 420;
const PANEL_MAX_WIDTH = 960;
const PANEL_MIN_HEIGHT = 360;
const PANEL_DEFAULT_GEOMETRY: PanelGeometry = {
  width: 420,
  height: 700,
};
const SKILL_MARKER = AI_CHAT_SKILL_MARKER;
const SKILL_LINK_PREFIX = "#ai-chat-skill-";
const COMPOSER_FRAGMENT_MIME = "application/x-codex-taskboard-composer-fragment";
const COMPOSER_HTML_BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
  "SECTION",
]);
const COMPOSER_HTML_IGNORED = new Set(["SCRIPT", "STYLE", "SVG"]);
const SANDBOX_LABELS: Record<AiChatSandbox, readonly [string, string]> = {
  "read-only": ["请求批准", "Ask for approval"],
  "workspace-write": ["帮我批准", "Approve selected actions"],
  "danger-full-access": ["完全访问权限", "Full access"],
};

function clampPanelGeometry(geometry: PanelGeometry): PanelGeometry {
  const maxWidth = Math.min(
    PANEL_MAX_WIDTH,
    window.innerWidth - PANEL_EDGE_GAP * 2,
  );
  const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
  const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
  const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, geometry.width)),
    height: Math.min(maxHeight, Math.max(minHeight, geometry.height)),
  };
}

function loadPanelGeometry(): PanelGeometry {
  const stored = taskboardStorage.getItem(PANEL_GEOMETRY_KEY);
  if (!stored) return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  try {
    const geometry = JSON.parse(stored) as PanelGeometry;
    if (
      !Number.isFinite(geometry.width)
      || !Number.isFinite(geometry.height)
    ) {
      return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
    }
    return clampPanelGeometry(geometry);
  } catch {
    return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  }
}

const SANDBOX_DESCRIPTIONS: Record<AiChatSandbox, readonly [string, string]> = {
  "read-only": ["编辑外部文件和使用互联网时始终询问", "Always ask before editing external files or using the internet"],
  "workspace-write": ["仅对检测到的风险操作请求批准", "Ask only for operations that are detected as risky"],
  "danger-full-access": ["不受限制地访问互联网和您电脑上的任何文件", "Access the internet and any file on your computer without restrictions"],
};

function SandboxIcon({ sandbox }: { sandbox: AiChatSandbox }) {
  if (sandbox === "read-only") return <ReadOnlyPermissionIcon color="currentColor" />;
  if (sandbox === "workspace-write") return <WorkspaceWritePermissionIcon color="currentColor" />;
  return <FullAccessPermissionIcon />;
}

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高", "Extra high"],
  max: ["最高", "Maximum"],
  ultra: ["极高", "Ultra"],
};

function modelDisplayName(value: string): string {
  return value.replace(/^GPT-/i, "").replaceAll("-", " ");
}

const SKILL_ACRONYMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["cli", "CLI"],
  ["mcp", "MCP"],
  ["sdk", "SDK"],
  ["ui", "UI"],
]);

function skillDisplayName(skill: Pick<AiChatSkill, "id" | "label">): string {
  const rawLabel = skill.label === skill.id && skill.id.includes(":")
    ? skill.id.slice(skill.id.lastIndexOf(":") + 1)
    : skill.label;
  return rawLabel
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (
      SKILL_ACRONYMS.get(word.toLocaleLowerCase())
      ?? (/^[A-Z][A-Za-z0-9]*$/.test(word)
        ? word
        : `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    ))
    .join(" ");
}

function stableComposerReferenceId(
  referenceKey: string,
  kind: "skill" | "agent" = "skill",
): string | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(referenceKey) || referenceKey.length % 4 === 1) return null;
    const padded = `${referenceKey.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - referenceKey.length % 4) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const stableId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!stableId || (kind === "skill" && stableId !== stableId.normalize("NFC"))) return null;
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(stableId)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return encoded === referenceKey ? stableId : null;
  } catch {
    return null;
  }
}

function stableComposerReferenceKey(
  stableId: string,
  kind: "skill" | "agent" = "skill",
): string {
  const normalizedStableId = kind === "skill" ? stableId.normalize("NFC") : stableId;
  return btoa(String.fromCharCode(...new TextEncoder().encode(normalizedStableId)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function escapedComposerReferenceLabel(label: string): string {
  return label.replace(/[\\[\]]/g, "\\$&");
}

function composerStableReference(
  kind: "skill" | "agent",
  stableId: string,
  label: string,
  referenceKey = stableComposerReferenceKey(stableId, kind),
  markdown = `[${escapedComposerReferenceLabel(label)}](taskboard://composer-reference/v1/${kind}/${referenceKey})`,
): ComposerStableReference {
  return { kind, stableId, referenceKey, label, markdown };
}

function eventSkillIds(event: AiChatEvent): string[] {
  const values = event.data?.skillIds;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function eventHasAttachments(event: AiChatEvent): boolean {
  return Array.isArray(event.data?.attachments) && event.data.attachments.length > 0;
}

function serializeComposer(root: HTMLElement): ComposerFragment {
  let message = "";
  const skillIds: string[] = [];
  const references: Array<ComposerStableReference | null> = [];
  const appendText = (value: string) => {
    message += value.replaceAll("\u200B", "");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const stableId = node.dataset.composerStableId ?? node.dataset.skillId;
    const skillId = stableId ?? node.dataset.composerCandidateRef;
    if (skillId) {
      message += SKILL_MARKER;
      skillIds.push(skillId);
      const referenceKey = node.dataset.composerReferenceKey;
      const kind = node.dataset.composerKind === "agent" ? "agent" : "skill";
      references.push(stableId && referenceKey ? composerStableReference(
        kind,
        stableId,
        node.dataset.composerLabel ?? stableId,
        referenceKey,
        node.dataset.composerMarkdown,
      ) : null);
      return;
    }
    if (node.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of node.childNodes) visit(child);
    if (isBlock && node.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of root.childNodes) visit(child);
  return { message, skillIds, references };
}

function serializeComposerDocumentFromDom(
  root: HTMLElement,
): ComposerDraftDocument {
  const nodes: ComposerDraftNode[] = [];
  const appendText = (value: string) => {
    const text = value.replaceAll("\u200B", "");
    if (!text) return;
    const previous = nodes.at(-1);
    if (previous?.type === "text") previous.text += text;
    else nodes.push({ type: "text", text });
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.composerReferenceKey) {
      nodes.push({
        type: "persistedReference",
        referenceKind: node.dataset.composerKind === "agent" ? "agent" : "skill",
        referenceKey: node.dataset.composerReferenceKey,
        label: node.dataset.composerLabel ?? "",
      });
      return;
    }
    if (node.dataset.composerCandidateRef) {
      nodes.push({
          type: node.dataset.composerKind === "agent" ? "agent" : "skill",
          candidateRef: node.dataset.composerCandidateRef,
          label: node.dataset.composerLabel ?? "",
      });
      return;
    }
    if (node.tagName === "BR") {
      appendText("\n");
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    const previousText = nodes.at(-1);
    if (
      isBlock
      && nodes.length > 0
      && !(previousText?.type === "text" && previousText.text.endsWith("\n"))
    ) appendText("\n");
    for (const child of node.childNodes) visit(child);
    const finalText = nodes.at(-1);
    if (
      isBlock
      && node.nextSibling
      && !(finalText?.type === "text" && finalText.text.endsWith("\n"))
    ) appendText("\n");
  };
  for (const child of root.childNodes) visit(child);
  return { version: 1, nodes };
}

function selectedComposerFragment(root: HTMLElement): {
  message: string;
  skillIds: string[];
  references?: Array<ComposerStableReference | null>;
  range: Range;
} | null {
  const selection = root.ownerDocument.getSelection();
  const selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (
    !selection
    || selection.isCollapsed
    || !selectionRange
    || !root.contains(selectionRange.commonAncestorContainer)
  ) {
    return null;
  }
  const skillReferenceAt = (node: Node): HTMLElement | null => {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const composerToken = element?.closest<HTMLElement>(".ai-chat-composer-skill-token") ?? null;
    if (composerToken && root.contains(composerToken)) return composerToken;
    const reference = element?.closest<HTMLElement>("[data-skill-id]") ?? null;
    return reference && root.contains(reference) ? reference : null;
  };
  const copyRange = selectionRange.cloneRange();
  const startSkill = skillReferenceAt(copyRange.startContainer);
  const endSkill = skillReferenceAt(copyRange.endContainer);
  if (startSkill) copyRange.setStartBefore(startSkill);
  if (endSkill) copyRange.setEndAfter(endSkill);
  const wrapper = root.ownerDocument.createElement("div");
  wrapper.append(copyRange.cloneContents());
  const fragment = serializeComposer(wrapper);
  return fragment.message ? { ...fragment, range: copyRange } : null;
}

function composerMarkerCount(message: string): number {
  return message.split(SKILL_MARKER).length - 1;
}

function isPersistedComposerNode(node: ComposerDraftNode): node is ComposerPersistedNode {
  return node.type === "persistedReference" || node.type === "unsupportedReference";
}

function hasPersistedComposerReference(document: ComposerDraftDocument): boolean {
  return document.nodes.some(isPersistedComposerNode);
}

function composerFragmentReference(
  fragment: ComposerFragment,
  index: number,
  skillsById: Map<string, AiChatSkill>,
): ComposerStableReference | null {
  const reference = fragment.references?.[index];
  if (reference) return reference;
  const skill = skillsById.get(fragment.skillIds[index] ?? "");
  return skill ? composerStableReference("skill", skill.id, skill.label) : null;
}

function canonicalComposerFragment(
  fragment: ComposerFragment,
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return fragment.message.replaceAll(SKILL_MARKER, () => {
    const reference = composerFragmentReference(fragment, index, skillsById);
    index += 1;
    return reference?.markdown ?? SKILL_MARKER;
  });
}

function composerFragmentHtml(
  fragment: ComposerFragment,
  skillsById: Map<string, AiChatSkill>,
  document: Document,
): string {
  const wrapper = document.createElement("div");
  const parts = fragment.message.split(SKILL_MARKER);
  parts.forEach((part, index) => {
    if (index > 0) {
      const reference = composerFragmentReference(fragment, index - 1, skillsById);
      if (reference) {
        const link = document.createElement("a");
        link.setAttribute(
          "href",
          `taskboard://composer-reference/v1/${reference.kind}/${reference.referenceKey}`,
        );
        link.dataset.composerStableId = reference.stableId;
        link.dataset.composerReferenceKey = reference.referenceKey;
        link.dataset.composerKind = reference.kind;
        link.dataset.composerLabel = reference.label;
        link.dataset.composerMarkdown = reference.markdown;
        link.textContent = reference.label;
        wrapper.append(link);
      } else {
        wrapper.append(SKILL_MARKER);
      }
    }
    const lines = part.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) wrapper.append(document.createElement("br"));
      wrapper.append(line);
    });
  });
  return wrapper.innerHTML;
}

function writeSkillFragmentToClipboard(
  event: ReactClipboardEvent<HTMLElement>,
  fragment: ComposerFragment,
  skillsById: Map<string, AiChatSkill>,
): boolean {
  if (
    fragment.skillIds.length === 0
    || !fragment.skillIds.every((_, index) => (
      composerFragmentReference(fragment, index, skillsById) !== null
    ))
  ) {
    return false;
  }
  event.preventDefault();
  if (fragment.skillIds.every((_, index) => (
    composerFragmentReference(fragment, index, skillsById)?.kind === "skill"
  ))) {
    event.clipboardData.setData(COMPOSER_FRAGMENT_MIME, JSON.stringify({
      message: fragment.message,
      skillIds: fragment.skillIds,
    }));
  }
  event.clipboardData.setData("text/plain", canonicalComposerFragment(fragment, skillsById));
  event.clipboardData.setData(
    "text/html",
    composerFragmentHtml(fragment, skillsById, event.currentTarget.ownerDocument),
  );
  return true;
}

function decodedSkillPath(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("file:")) return decodeURIComponent(new URL(raw).pathname);
    if (!raw.startsWith("/")) return null;
    return decodeURIComponent(raw.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
}

function composerFragmentFromHtml(
  html: string,
  skills: AiChatSkill[],
): ComposerFragment | null {
  if (!html) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const skillsByPath = new Map(skills.map((skill) => [skill.path, skill]));
  const skillIds: string[] = [];
  const references: ComposerStableReference[] = [];
  let message = "";
  let matchedReference = false;
  const appendText = (value: string) => {
    message += value.replaceAll(SKILL_MARKER, "\uFFFD");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (COMPOSER_HTML_IGNORED.has(element.tagName)) return;
    if (element.tagName === "A") {
      const href = element.getAttribute("href") ?? "";
      const referenceMatch = /^taskboard:\/\/composer-reference\/v1\/(skill|agent)\/([A-Za-z0-9_-]+)$/.exec(href);
      const referenceKind = referenceMatch?.[1] === "agent" ? "agent" : "skill";
      const stableReferenceId = referenceMatch
        ? stableComposerReferenceId(referenceMatch[2], referenceKind)
        : null;
      if (stableReferenceId && referenceMatch) {
        const referenceKey = referenceMatch[2];
        const label = element.dataset.composerLabel || element.textContent || stableReferenceId;
        message += SKILL_MARKER;
        skillIds.push(stableReferenceId);
        references.push(composerStableReference(
          referenceKind,
          stableReferenceId,
          label,
          referenceKey,
          element.dataset.composerReferenceKey === referenceKey
            ? element.dataset.composerMarkdown
            : undefined,
        ));
        matchedReference = true;
        return;
      }
      const path = decodedSkillPath(href);
      const skill = path?.endsWith("/SKILL.md") ? skillsByPath.get(path) : null;
      if (skill) {
        message += SKILL_MARKER;
        skillIds.push(skill.id);
        references.push(composerStableReference("skill", skill.id, skill.label));
        matchedReference = true;
        return;
      }
    }
    if (element.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = COMPOSER_HTML_BLOCKS.has(element.tagName);
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of element.childNodes) visit(child);
    if (isBlock && element.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of document.body.childNodes) visit(child);
  return matchedReference ? { message, skillIds, references } : null;
}

function composerFragmentFromPlainText(
  text: string,
  skills: AiChatSkill[],
): ComposerFragment | null {
  if (!text) return null;
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const skillIds: string[] = [];
  const references: ComposerStableReference[] = [];
  let message = "";
  let cursor = 0;
  const referencePattern = /\[((?:\\[\\[\]]|[^\]\\\r\n])+)]\((\/[^)\r\n]*\/SKILL\.md|taskboard:\/\/composer-reference\/v1\/(skill|agent)\/([A-Za-z0-9_-]+))\)/g;
  for (const match of text.matchAll(referencePattern)) {
    const markdownLabel = match[1];
    const label = markdownLabel.replace(/\\([\\[\]])/g, "$1");
    const referenceKind = match[3] === "agent" ? "agent" : "skill";
    const referenceKey = match[4];
    const stableReferenceId = referenceKey
      ? stableComposerReferenceId(referenceKey, referenceKind)
      : null;
    const legacySkillId = !referenceKey && label.startsWith("$") ? label.slice(1) : null;
    const stableId = stableReferenceId ?? legacySkillId;
    if (!stableId) continue;
    const kind = stableReferenceId ? referenceKind : "skill";
    const skill = skillsById.get(stableId);
    const reference = composerStableReference(
      kind,
      stableId,
      stableReferenceId ? label : skill?.label ?? stableId,
      referenceKey || stableComposerReferenceKey(stableId),
      stableReferenceId ? match[0] : undefined,
    );
    message += text.slice(cursor, match.index).replaceAll(SKILL_MARKER, "\uFFFD");
    message += SKILL_MARKER;
    skillIds.push(stableId);
    references.push(reference);
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (skillIds.length === 0) return null;
  message += text.slice(cursor).replaceAll(SKILL_MARKER, "\uFFFD");
  return { message, skillIds, references };
}

function composerQueryAt(
  root: HTMLElement,
  focusNode: Text,
  focusOffset: number,
): { trigger: ComposerTrigger; query: string; range: Range } | null {
  if (!root.contains(focusNode)) return null;
  const rawPrefix = (focusNode.textContent ?? "").slice(0, focusOffset);
  const prefix = rawPrefix.replaceAll("\u200B", "");
  const match = /(?:^|\s)([@/])([^\s@/]*)$/.exec(prefix);
  if (!match) return null;
  const trigger = match[1] as ComposerTrigger;
  const triggerOffset = rawPrefix.lastIndexOf(trigger);
  const range = root.ownerDocument.createRange();
  range.setStart(focusNode, triggerOffset);
  range.setEnd(focusNode, focusOffset);
  return { trigger, query: match[2], range };
}

function composerQuery(root: HTMLElement): {
  trigger: ComposerTrigger;
  query: string;
  range: Range;
} | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || !selection.focusNode) return null;
  if (selection.focusNode.nodeType === Node.TEXT_NODE) {
    return composerQueryAt(root, selection.focusNode as Text, selection.focusOffset);
  }
  if (!(selection.focusNode instanceof HTMLElement) || !root.contains(selection.focusNode)) {
    return null;
  }
  let candidate = selection.focusNode.childNodes[selection.focusOffset - 1] ?? null;
  while (candidate?.lastChild) candidate = candidate.lastChild;
  return candidate?.nodeType === Node.TEXT_NODE
    ? composerQueryAt(root, candidate as Text, candidate.textContent?.length ?? 0)
    : null;
}

function composerQueryAtEnd(root: HTMLElement): {
  trigger: ComposerTrigger;
  query: string;
  range: Range;
} | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let lastText: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) lastText = node as Text;
  return lastText ? composerQueryAt(root, lastText, lastText.length) : null;
}

function composerQueryAfterInput(
  root: HTMLElement,
  beforeInput: ComposerBeforeInput,
): { trigger: ComposerTrigger; query: string; range: Range } | null {
  if (beforeInput.container.nodeType === Node.TEXT_NODE) {
    const textNode = beforeInput.container as Text;
    return composerQueryAt(
      root,
      textNode,
      Math.min(beforeInput.offset + beforeInput.text.length, textNode.length),
    );
  }
  if (!(beforeInput.container instanceof HTMLElement) || !root.contains(beforeInput.container)) {
    return null;
  }
  const insertedNode = beforeInput.container.childNodes[beforeInput.offset];
  if (insertedNode?.nodeType !== Node.TEXT_NODE) return null;
  return composerQueryAt(
    root,
    insertedNode as Text,
    Math.min(beforeInput.text.length, insertedNode.textContent?.length ?? 0),
  );
}

function tokenBeforeComposerCaret(root: HTMLElement): HTMLElement | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || !selection.focusNode) return null;
  const focusNode = selection.focusNode;
  let candidate: ChildNode | null = null;
  if (focusNode.nodeType === Node.TEXT_NODE) {
    const prefix = (focusNode.textContent ?? "").slice(0, selection.focusOffset);
    if (prefix.replaceAll("\u200B", "").length > 0) return null;
    candidate = focusNode.previousSibling;
  } else if (focusNode instanceof HTMLElement) {
    candidate = focusNode.childNodes[selection.focusOffset - 1] ?? null;
  }
  while (
    candidate?.nodeType === Node.TEXT_NODE
    && !(candidate.textContent ?? "").replaceAll("\u200B", "")
  ) {
    candidate = candidate.previousSibling;
  }
  return candidate instanceof HTMLElement
    && (candidate.dataset.skillId || candidate.dataset.composerCandidateRef)
    ? candidate
    : null;
}

function skillMarkdown(
  content: string,
  skillIds: string[],
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return content.replaceAll(SKILL_MARKER, () => {
    const skillId = skillIds[index] ?? "";
    index += 1;
    const skill = skillsById.get(skillId);
    const label = skill
      ? skillDisplayName(skill)
      : skillDisplayName({ id: skillId, label: skillId });
    return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${SKILL_LINK_PREFIX}${encodeURIComponent(skillId)})`;
  });
}

function SkillReference({
  skill,
  skillId,
}: {
  skill?: AiChatSkill;
  skillId: string;
}) {
  return (
    <span
      className="ai-chat-skill-reference"
      data-skill-id={skillId || undefined}
    >
      <ProjectIcon color="currentColor" />
      <span>{skill ? skillDisplayName(skill) : skillDisplayName({ id: skillId, label: skillId })}</span>
    </span>
  );
}

const ACTIVITY_LABELS: Record<string, readonly [string, string]> = {
  plan: ["执行计划", "Plan"],
  todo: ["任务进度", "Task progress"],
  todo_list: ["任务进度", "Task progress"],
  command: ["运行命令", "Run command"],
  command_execution: ["运行命令", "Run command"],
  file: ["文件修改", "File changes"],
  file_change: ["文件修改", "File changes"],
  mcp: ["调用 MCP", "Use MCP"],
  mcp_tool_call: ["调用 MCP", "Use MCP"],
  skill: ["调用 Skill", "Use Skill"],
  web: ["搜索资料", "Search the web"],
  web_search: ["搜索资料", "Search the web"],
  error: ["执行失败", "Failed"],
  "turn.failed": ["执行失败", "Failed"],
};
const WARNING_ACTIVITY_LABEL: readonly [string, string] = ["警告", "Warning"];

function ActivityIcon({ failed, type }: { failed: boolean; type: string }) {
  if (failed || type === "error" || type === "turn.failed") return <LinearIcon name="alert" />;
  if (type === "plan") return <EditIcon color="currentColor" />;
  if (type === "todo" || type === "todo_list") return <StatusIcon status="todo" color="currentColor" />;
  if (type === "command" || type === "command_execution") return <LinearIcon name="terminal" />;
  if (type === "file" || type === "file_change") return <LinearIcon name="file" />;
  if (type === "mcp" || type === "mcp_tool_call") return <RelationIcon color="currentColor" size={16} />;
  if (type === "skill") return <ProjectIcon color="currentColor" />;
  if (type === "web" || type === "web_search") return <LinearIcon name="search" />;
  return <StatusIcon status="todo" color="currentColor" />;
}

const AI_CHAT_UNAVAILABLE_ERROR = Symbol("ai-chat-unavailable");
type AiChatError = string | typeof AI_CHAT_UNAVAILABLE_ERROR;

function messageFor(error: unknown): AiChatError {
  return error instanceof Error ? error.message : AI_CHAT_UNAVAILABLE_ERROR;
}

function isAiChatSandbox(value: string): value is AiChatSandbox {
  return value === "read-only"
    || value === "workspace-write"
    || value === "danger-full-access";
}

function dateLabel(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type ThinkingActivityDetail =
  | { kind: "lines"; summary: string; value: string[] }
  | { kind: "pre"; summary: string; value: string };

function parsedTodoLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text] : [];
    });
  } catch {
    return [];
  }
}

function activityDetail(
  event: AiChatEvent,
  text: (chinese: string, english: string) => string,
): ThinkingActivityDetail | null {
  const files = event.data?.files;
  if (Array.isArray(files)) {
    const visibleFiles = files.filter((value): value is string => typeof value === "string");
    if (visibleFiles.length > 0) {
      return { kind: "lines", summary: text("查看文件", "View files"), value: visibleFiles };
    }
  }
  if (event.type === "todo" || event.type === "todo_list") {
    const lines = parsedTodoLines(event.data?.detail);
    if (lines.length > 0) {
      return { kind: "lines", summary: text("查看任务", "View tasks"), value: lines };
    }
  }
  for (const key of ["output", "command", "detail", "path"]) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) {
      return {
        kind: "pre",
        summary: activityDetailSummary(event, text),
        value,
      };
    }
  }
  return null;
}

function activityDetailSummary(
  event: AiChatEvent,
  text: (chinese: string, english: string) => string,
): string {
  if (typeof event.data?.output === "string" && event.data.output.trim()) return text("查看输出", "View output");
  if (typeof event.data?.command === "string" && event.data.command.trim()) return text("查看命令", "View command");
  if (typeof event.data?.detail === "string" && event.data.detail.trim()) return text("查看详情", "View details");
  if (typeof event.data?.path === "string" && event.data.path.trim()) return text("查看路径", "View path");
  if (Array.isArray(event.data?.files)) return text("查看文件", "View files");
  return text("查看详情", "View details");
}

function MarkdownMessage({
  children,
  skillsById,
}: {
  children: string;
  skillsById?: Map<string, AiChatSkill>;
}) {
  return (
    <div className="ai-chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (href?.startsWith(SKILL_LINK_PREFIX)) {
              const skillId = decodeURIComponent(href.slice(SKILL_LINK_PREFIX.length));
              return <SkillReference skill={skillsById?.get(skillId)} skillId={skillId} />;
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingStepDetail({
  detail,
  label,
  content,
  running,
}: {
  detail: ThinkingActivityDetail;
  label: string;
  content: string;
  running: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`ai-chat-thinking-detail${isOpen ? " is-open" : ""}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-detail-trigger"
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          setIsOpen((open) => !open);
        }}
        title={content}
        type="button"
      >
        <span className="ai-chat-thinking-step-label">
          {label}
          {running && <span aria-hidden="true">…</span>}
        </span>
        {content && (
          <span className="ai-chat-thinking-step-description">
            {content}
          </span>
        )}
        <LinearIcon name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className="ai-chat-thinking-detail-panel"
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-detail-panel-inner">
          {detail.kind === "lines" ? (
            <div className="ai-chat-thinking-detail-lines">
              {detail.value.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ) : (
            <pre><code>{detail.value}</code></pre>
          )}
        </div>
      </div>
    </div>
  );
}

function ThinkingSteps({
  events,
  active,
}: {
  events: AiChatEvent[];
  active: boolean;
}) {
  const { text } = useTaskboardI18n();
  const statuses = events.map(aiChatEventStatus);
  const status = statuses.includes("running")
    ? "running"
    : statuses.includes("failed") ? "failed" : "completed";
  const [isOpen, setIsOpen] = useState(active);
  const previousActiveRef = useRef(active);

  useEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    setIsOpen(active);
  }, [active]);

  const statusLabel = status === "running"
    ? text("思考中", "Thinking")
    : status === "failed"
      ? text("思考中断", "Thinking stopped")
      : text("已思考", "Thought");

  return (
    <section className={`ai-chat-thinking-steps is-${status}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-header"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span className="ai-chat-thinking-label">{statusLabel}</span>
        <LinearIcon className="ai-chat-thinking-chevron" name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className={`ai-chat-thinking-panel${isOpen ? " is-open" : ""}`}
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-panel-clip">
          <div className="ai-chat-thinking-list">
            {events.map((event, index) => {
              const eventStatus = aiChatEventStatus(event);
              const detail = activityDetail(event, text);
              const activityLabel = event.type === "error" && event.data?.status === "warning"
                ? WARNING_ACTIVITY_LABEL
                : ACTIVITY_LABELS[event.type];
              const label = activityLabel
                ? text(...activityLabel)
                : text("执行活动", "Activity");
              const content = detail?.kind === "lines"
                && (event.type === "file" || event.type === "file_change")
                ? text(
                  `${detail.value.length} 个文件`,
                  `${detail.value.length} ${detail.value.length === 1 ? "file" : "files"}`,
                )
                : detail?.kind === "lines"
                  && (event.type === "todo" || event.type === "todo_list")
                  ? text(
                    `${detail.value.length} 项任务`,
                    `${detail.value.length} ${detail.value.length === 1 ? "task" : "tasks"}`,
                  )
                  : event.content.trim();
              return (
                <div
                  className="ai-chat-thinking-step-entry"
                  key={typeof event.data?.itemId === "string" && event.data.itemId
                    ? event.data.itemId
                    : event.id}
                  style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
                >
                  <div className={`ai-chat-thinking-step is-${eventStatus}${index === events.length - 1 ? " is-last" : ""}`}>
                    <span className="ai-chat-thinking-step-rail" aria-hidden="true">
                      <span className="ai-chat-thinking-step-icon">
                        <ActivityIcon failed={eventStatus === "failed"} type={event.type} />
                      </span>
                      {index !== events.length - 1 && (
                        <span className="ai-chat-thinking-step-connector" />
                      )}
                    </span>
                    <div className="ai-chat-thinking-step-content">
                      {detail ? (
                        <ThinkingStepDetail
                          content={content}
                          detail={detail}
                          label={label}
                          running={eventStatus === "running"}
                        />
                      ) : (
                        <div className="ai-chat-thinking-step-heading">
                          <span className="ai-chat-thinking-step-label">
                            {label}
                            {eventStatus === "running" && <span aria-hidden="true">…</span>}
                          </span>
                          {content && (
                            <span
                              className="ai-chat-thinking-step-description"
                              title={content}
                            >
                              {content}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function EventAttachments({ event }: { event: AiChatEvent }) {
  const rawAttachments = event.data?.attachments;
  if (!Array.isArray(rawAttachments)) return null;
  const attachments = rawAttachments.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const attachment = value as Record<string, unknown>;
    if (
      typeof attachment.filename !== "string"
      || typeof attachment.contentType !== "string"
      || typeof attachment.size !== "number"
    ) return [];
    return [{
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
    }];
  });
  if (attachments.length === 0) return null;
  return (
    <div className="ai-chat-event-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.filename}-${index}`}>
          <AttachmentIcon color="currentColor" />
          <span>{attachment.filename}</span>
        </span>
      ))}
    </div>
  );
}

function MessageTimeline({
  activeRunId,
  events,
  skills,
}: {
  activeRunId: string | null;
  events: AiChatEvent[];
  skills: AiChatSkill[];
}) {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const handleSkillFragmentCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const fragment = selectedComposerFragment(event.currentTarget);
    if (fragment) writeSkillFragmentToClipboard(event, fragment, skillsById);
  };
  const timeline = filterVisibleAiEvents(events).reduce<Array<AiChatEvent | AiChatEvent[]>>(
    (items, event) => {
      const isMessage = event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
        || event.role === "assistant"
        || event.type === "assistant"
        || event.type === "agent_message";
      if (isMessage) {
        items.push(event);
        return items;
      }
      const previous = items[items.length - 1];
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
      return items;
    },
    [],
  );
  return (
    <>
      {timeline.map((entry) => {
        if (Array.isArray(entry)) {
          return (
            <ThinkingSteps
              active={Boolean(
                activeRunId
                && entry.some((event) => event.runId === activeRunId),
              )}
              events={entry}
              key={`activity-${
                typeof entry[0]?.data?.itemId === "string" && entry[0].data.itemId
                  ? entry[0].data.itemId
                  : entry[0]?.id ?? "empty"
              }`}
            />
          );
        }
        const event = entry;
        if (event.role === "user" || event.type === "user" || event.type === "user_message") {
          return (
            <article
              className="ai-chat-user-message"
              key={event.id}
              onCopy={handleSkillFragmentCopy}
            >
              <MarkdownMessage skillsById={skillsById}>
                {skillMarkdown(event.content, eventSkillIds(event), skillsById)}
              </MarkdownMessage>
              <EventAttachments event={event} />
            </article>
          );
        }
        if (event.role === "assistant" || event.type === "assistant" || event.type === "agent_message") {
          return (
            <article className="ai-chat-assistant-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        return null;
      })}
    </>
  );
}

function OptionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ai-chat-option-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export function AiChat({
  available,
  projectId,
  issueId,
  codexProjectIdentity,
  onThreadsChange,
  openThreadRequest,
}: AiChatProps) {
  const { locale, text } = useTaskboardI18n();
  const [panelOpen, setPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(
    () => taskboardStorage.getItem(PANEL_VIEW_KEY) === "history",
  );
  const [menu, setMenu] = useState<MenuName>(null);
  const [threads, setThreads] = useState<AiChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => taskboardStorage.getItem(LAST_THREAD_KEY),
  );
  const [snapshot, setSnapshot] = useState<AiChatThreadSnapshot | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<DraftThreadOrigin | null>(null);
  const [catalog, setCatalog] = useState<AiChatCatalog | null>(null);
  const [catalogLoadedProjectId, setCatalogLoadedProjectId] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<AiChatError | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AiChatError | null>(null);
  const [draft, setDraft] = useState("");
  const [requestedComposerText, setRequestedComposerText] = useState<string | null>(null);
  const [requestedComposerDraft, setRequestedComposerDraft] = useState<
    Extract<AiChatOpenThreadRequest, { composerDraft: unknown }>["composerDraft"] | null
  >(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [composerQueryState, setComposerQueryState] = useState<ComposerQuery | null>(null);
  const [composerCandidates, setComposerCandidates] = useState<ComposerCandidatesResponse | null>(null);
  const [composerCandidatesLoading, setComposerCandidatesLoading] = useState(false);
  const [composerCandidatesError, setComposerCandidatesError] = useState<AiChatError | null>(null);
  const [composerRevision, setComposerRevision] = useState<string | null>(null);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(0);
  const [slashQueryBlocked, setSlashQueryBlocked] = useState(false);
  const [composerRebindBlocked, setComposerRebindBlocked] = useState(false);
  const [composerSkillTokens, setComposerSkillTokens] = useState<ComposerSkillToken[]>([]);
  const [pendingDangerInput, setPendingDangerInput] = useState<PendingDangerInput | null>(null);
  const [unread, setUnread] = useState(false);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState("");
  const [draftSandbox, setDraftSandbox] = useState<AiChatSandbox>("workspace-write");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [panelGeometry, setPanelGeometry] = useState<PanelGeometry | null>(
    () => window.innerWidth <= 719 ? null : loadPanelGeometry(),
  );
  const [panelResizeEdge, setPanelResizeEdge] = useState<PanelResizeEdge | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const composerQueryRangeRef = useRef<Range | null>(null);
  const dismissedComposerQueryRef = useRef<string | null>(null);
  const composerBeforeInputRef = useRef<ComposerBeforeInput | null>(null);
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelResizeSessionRef = useRef<PanelResizeSession | null>(null);
  const selectedThreadRef = useRef(selectedThreadId);
  const handledOpenThreadRequestRef = useRef<number | null>(null);
  const draftReturnThreadIdRef = useRef<string | null>(null);
  const taskComposerDraftOriginRef = useRef<DraftThreadOrigin | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const snapshotRequestRef = useRef(0);
  const snapshotLoadingRequestRef = useRef(0);
  const observedRunStatusesRef = useRef(new Map<string, AiChatRun["status"]>());
  const dangerConfirmOpen = pendingDangerInput !== null;
  const openThreadRequestId = openThreadRequest && "threadId" in openThreadRequest
    ? openThreadRequest.requestId
    : null;

  const selectThread = useCallback((threadId: string | null) => {
    selectedThreadRef.current = threadId;
    setSelectedThreadId(threadId);
  }, []);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
    if (selectedThreadId) taskboardStorage.setItem(LAST_THREAD_KEY, selectedThreadId);
    else taskboardStorage.removeItem(LAST_THREAD_KEY);
  }, [selectedThreadId]);

  useEffect(() => {
    taskboardStorage.setItem(PANEL_VIEW_KEY, historyOpen ? "history" : "thread");
  }, [historyOpen]);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (panelOpen) {
      setUnread(false);
      setPanelGeometry(window.innerWidth <= 719 ? null : loadPanelGeometry());
    }
  }, [panelOpen]);

  useEffect(() => {
    if (panelOpen && selectedThreadId) editorRef.current?.focus();
  }, [panelOpen, selectedThreadId, openThreadRequestId]);

  useEffect(() => {
    function finishPanelResize(pointerId?: number) {
      const session = panelResizeSessionRef.current;
      if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
      if (session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
      if (window.innerWidth > 719) {
        taskboardStorage.setItem(
          PANEL_GEOMETRY_KEY,
          JSON.stringify(session.geometry),
        );
      }
      panelResizeSessionRef.current = null;
      setPanelResizeEdge(null);
    }

    function resizePanel(event: PointerEvent) {
      const session = panelResizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();

      const maxWidth = Math.min(
        PANEL_MAX_WIDTH,
        window.innerWidth - PANEL_EDGE_GAP * 2,
      );
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      const resizeWidth = session.edge === "left" || session.edge === "top-left";
      const resizeHeight = session.edge === "top" || session.edge === "top-left";
      const width = resizeWidth
        ? Math.min(
            maxWidth,
            Math.max(minWidth, session.startWidth - (event.clientX - session.startX)),
          )
        : session.startWidth;
      const height = resizeHeight
        ? Math.min(
            maxHeight,
            Math.max(minHeight, session.startHeight - (event.clientY - session.startY)),
          )
        : session.startHeight;
      session.geometry = { width, height };
      setPanelGeometry(session.geometry);
    }

    function handlePointerEnd(event: PointerEvent) {
      finishPanelResize(event.pointerId);
    }

    function handleWindowBlur() {
      finishPanelResize();
    }

    function handleWindowResize() {
      finishPanelResize();
      if (window.innerWidth <= 719) {
        setPanelGeometry(null);
        return;
      }

      setPanelGeometry(loadPanelGeometry());
    }

    window.addEventListener("pointermove", resizePanel, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("pointermove", resizePanel);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  function startPanelResize(
    event: ReactPointerEvent<HTMLDivElement>,
    edge: PanelResizeEdge,
  ) {
    if (window.innerWidth <= 719) return;
    const panel = panelRef.current;
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeSessionRef.current = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      geometry: {
        width: rect.width,
        height: rect.height,
      },
      captureTarget: event.currentTarget,
    };
    setPanelGeometry({
      width: rect.width,
      height: rect.height,
    });
    setPanelResizeEdge(edge);
  }

  const replaceThread = useCallback((thread: AiChatThread) => {
    setThreads((current) => {
      const next = current.filter((candidate) => candidate.id !== thread.id);
      return [thread, ...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const observeRunTransitions = useCallback((threadId: string, runs: AiChatRun[]) => {
    let unreadCompletion = false;
    for (const run of runs) {
      const previous = observedRunStatusesRef.current.get(run.id);
      observedRunStatusesRef.current.set(run.id, run.status);
      if (
        previous === "running"
        && run.status !== "running"
        && (!panelOpenRef.current || selectedThreadRef.current !== threadId)
      ) unreadCompletion = true;
    }
    if (unreadCompletion) setUnread(true);
  }, []);

  const loadSnapshot = useCallback(async (threadId: string, quiet = false) => {
    const requestId = ++snapshotRequestRef.current;
    if (!quiet) {
      snapshotLoadingRequestRef.current = requestId;
      setLoading(true);
    }
    try {
      const next = await getAiChatThread(threadId);
      if (requestId !== snapshotRequestRef.current || selectedThreadRef.current !== threadId) return;
      setSnapshot(next);
      replaceThread(next.thread);
      observeRunTransitions(threadId, next.runs);
      if (!quiet) setError(null);
    } catch (nextError) {
      if (
        !quiet
        && requestId === snapshotRequestRef.current
        && selectedThreadRef.current === threadId
      ) setError(messageFor(nextError));
    } finally {
      if (!quiet && requestId === snapshotLoadingRequestRef.current) setLoading(false);
    }
  }, [observeRunTransitions, replaceThread]);

  const selectedHintRefreshQueue = useMemo(
    () => createAiSnapshotRefreshQueue((threadId) => loadSnapshot(threadId, true)),
    [loadSnapshot],
  );
  useEffect(() => () => selectedHintRefreshQueue.clear(), [selectedHintRefreshQueue]);

  const loadThreads = useCallback(async () => {
    try {
      const next = await listAiChatThreads();
      setThreads(next);
      if (next.length === 0) setHistoryOpen(false);
      setSelectedThreadId((current) => {
        const selected = current && next.some((thread) => thread.id === current)
          ? current
          : next[0]?.id ?? null;
        selectedThreadRef.current = selected;
        return selected;
      });
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }, []);

  useEffect(() => {
    if (!available) {
      setPanelOpen(false);
      setThreads([]);
      return;
    }
    void loadThreads();
  }, [available, loadThreads]);

  useEffect(() => {
    onThreadsChange?.(available ? threads : []);
  }, [available, onThreadsChange, threads]);

  useEffect(() => {
    setSnapshot(null);
    if (!selectedThreadId) return;
    let initialPending = true;
    let refreshQueued = false;
    let disposed = false;
    void loadSnapshot(selectedThreadId).finally(() => {
      initialPending = false;
      if (refreshQueued && !disposed) {
        void selectedHintRefreshQueue.request(selectedThreadId);
      }
    });
    const unsubscribe = subscribeAiChatThread(
      selectedThreadId,
      () => {
        if (initialPending) refreshQueued = true;
        else void selectedHintRefreshQueue.request(selectedThreadId);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [loadSnapshot, selectedHintRefreshQueue, selectedThreadId]);

  const backgroundRunningThreadIds = threads
    .filter((thread) => thread.status === "running" && thread.id !== selectedThreadId)
    .map((thread) => thread.id);
  useEffect(() => {
    if (!available || backgroundRunningThreadIds.length === 0) return;
    const refresh = async (threadId: string) => {
      try {
        const next = await getAiChatThread(threadId);
        replaceThread(next.thread);
        observeRunTransitions(threadId, next.runs);
      } catch {
        // The selected thread surfaces request errors; background history refresh stays quiet.
      }
    };
    const refreshQueue = createAiSnapshotRefreshQueue(refresh);
    const unsubscribers = backgroundRunningThreadIds.map((threadId) => (
      subscribeAiChatThread(threadId, () => void refreshQueue.request(threadId))
    ));
    return () => {
      refreshQueue.clear();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [
    available,
    backgroundRunningThreadIds.join(","),
    observeRunTransitions,
    replaceThread,
    selectedThreadId,
  ]);

  const selectedThreadSummary = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const catalogProjectId = snapshot?.thread.origin.projectId
    ?? selectedThreadSummary?.origin.projectId
    ?? draftOrigin?.projectId
    ?? projectId;
  const catalogThreadOrigin = snapshot?.thread.origin ?? selectedThreadSummary?.origin;
  const catalogCodexProjectIdentity = catalogThreadOrigin
    ? catalogThreadOrigin.codexProjectKind === "remote"
      && catalogThreadOrigin.codexProjectId
      && catalogThreadOrigin.codexHostId
        ? {
            codexProjectId: catalogThreadOrigin.codexProjectId,
            codexProjectKind: "remote" as const,
            codexHostId: catalogThreadOrigin.codexHostId,
            workspacePath: catalogThreadOrigin.workspacePath,
          }
        : null
    : draftOrigin?.projectId === catalogProjectId
      ? draftOrigin.codexProjectIdentity
      : projectId === catalogProjectId
        ? codexProjectIdentity
        : null;
  const activeCatalog = catalogLoadedProjectId === catalogProjectId ? catalog : null;
  useEffect(() => {
    if (!available || !catalogProjectId) {
      setCatalog(null);
      setCatalogLoadedProjectId(null);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    setCatalog(null);
    setCatalogLoadedProjectId(null);
    setCatalogError(null);
    void getAiChatCatalog(catalogProjectId, controller.signal, catalogCodexProjectIdentity).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setCatalogLoadedProjectId(catalogProjectId);
        setCatalogError(null);
      },
      (nextError) => {
        if (controller.signal.aborted) return;
        if ((nextError as Error).name !== "AbortError") {
          setCatalog(null);
          setCatalogLoadedProjectId(null);
          setCatalogError(messageFor(nextError));
        }
      },
    );
    return () => controller.abort();
  }, [
    available,
    catalogProjectId,
    catalogCodexProjectIdentity?.codexHostId,
    catalogCodexProjectIdentity?.codexProjectId,
    catalogCodexProjectIdentity?.codexProjectKind,
    catalogCodexProjectIdentity?.workspacePath,
  ]);

  const composerRequestQuery = useMemo(() => {
    if (!composerQueryState) return "";
    const escapedTrigger = composerQueryState.trigger === "/" ? "\\/" : "@";
    const match = new RegExp(`(?:^|\\s)${escapedTrigger}([^\\s@/]*)$`).exec(draft);
    return match?.[1] ?? composerQueryState.query;
  }, [composerQueryState, draft]);

  useEffect(() => {
    if (!composerQueryState) {
      setComposerCandidates(null);
      setComposerCandidatesLoading(false);
      setComposerCandidatesError(null);
      return;
    }
    const controller = new AbortController();
    setComposerCandidates(null);
    setComposerCandidatesLoading(true);
    setComposerCandidatesError(null);
    void getAiChatComposerCandidates({
      ...(catalogProjectId ? { projectId: catalogProjectId } : {}),
      ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
      ...(!selectedThreadId && catalogCodexProjectIdentity ? catalogCodexProjectIdentity : {}),
      trigger: composerQueryState.trigger,
      query: composerRequestQuery,
    }, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setComposerCandidates(next);
        setComposerRevision(next.revision);
        setComposerCandidatesLoading(false);
      },
      (nextError) => {
        if (controller.signal.aborted) return;
        if ((nextError as Error).name !== "AbortError") {
          setComposerCandidatesError(messageFor(nextError));
          setComposerCandidatesLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [
    catalogProjectId,
    catalogCodexProjectIdentity?.codexHostId,
    catalogCodexProjectIdentity?.codexProjectId,
    catalogCodexProjectIdentity?.codexProjectKind,
    catalogCodexProjectIdentity?.workspacePath,
    composerQueryState,
    composerRequestQuery,
    selectedThreadId,
  ]);

  const restoreDraftSettings = useCallback((thread: AiChatThread) => {
    setDraftModel(thread.model);
    setDraftEffort(thread.reasoningEffort);
    setDraftSandbox(thread.sandbox);
  }, []);

  useEffect(() => {
    const thread = snapshot?.thread;
    if (thread) {
      restoreDraftSettings(thread);
      return;
    }
    const normalized = normalizeChatSelection(activeCatalog?.models ?? [], draftModel, draftEffort);
    if (normalized) {
      setDraftModel(normalized.model);
      setDraftEffort(normalized.reasoningEffort);
    }
    const sandbox = draftOrigin && activeCatalog?.sandboxes.includes(draftSandbox)
      ? draftSandbox
      : activeCatalog?.sandboxes.find(
          (candidate): candidate is AiChatSandbox => candidate === "workspace-write",
        ) ?? activeCatalog?.sandboxes.find(isAiChatSandbox);
    if (sandbox) setDraftSandbox(sandbox);
  }, [activeCatalog, draftOrigin, restoreDraftSettings, snapshot?.thread.id]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || !panelOpen) return;
    container.scrollTop = container.scrollHeight;
  }, [panelOpen, snapshot?.events.length, snapshot?.thread.status]);

  useEffect(() => {
    if (!panelOpen) return;
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      restorePersistedConversationFromDraft();
      setPanelOpen(false);
    }
    document.addEventListener("keydown", closeWithEscape, true);
    return () => document.removeEventListener("keydown", closeWithEscape, true);
  }, [draftOrigin, panelOpen, threads]);

  const visibleComposerCandidates = useMemo(() => {
    const candidates = composerCandidates?.candidates.filter((candidate) => (
      candidate.trigger === composerQueryState?.trigger
    )) ?? [];
    return composerRequestQuery ? candidates.slice(0, 8) : candidates;
  }, [composerCandidates?.candidates, composerQueryState?.trigger, composerRequestQuery]);
  const selectableComposerCandidates = useMemo(
    () => visibleComposerCandidates.filter((candidate) => candidate.selectable),
    [visibleComposerCandidates],
  );
  const selectedModel = activeCatalog?.models.find((model) => model.slug === draftModel) ?? null;
  const availableSandboxes = (activeCatalog?.sandboxes ?? []).filter(isAiChatSandbox);
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
  const visibleError = error ?? catalogError;
  const composerBlocked = Boolean(
    selectedThreadId && deletingThreadId === selectedThreadId,
  ) || composerRebindBlocked;
  const sendBlocked = loading
    || settingsSaving
    || composerBlocked
    || Boolean(selectedThreadId && !snapshot);
  const threadSettingsBlocked = loading || Boolean(selectedThreadId && !snapshot);
  const attachmentBlocked = composerBlocked;
  const primaryAction = chatPrimaryAction(
    snapshot?.thread.status ?? "idle",
    draft,
    sendBlocked || (snapshot?.thread.status !== "running" && slashQueryBlocked),
    attachments.length > 0,
  );
  const launcherState = unread ? "unread" : "idle";
  const lastUserEvent = snapshot?.thread.status === "failed"
    ? [...snapshot.events].reverse().find((event) => (
        event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
      )) ?? null
    : null;
  const retryableUserEvent = lastUserEvent && !eventHasAttachments(lastUserEvent)
    ? lastUserEvent
    : null;

  useEffect(() => {
    setSelectedCandidateIndex(0);
  }, [composerQueryState?.trigger, composerRequestQuery]);

  useEffect(() => {
    setSelectedCandidateIndex((current) => (
      selectableComposerCandidates.length === 0
        ? 0
        : Math.min(current, selectableComposerCandidates.length - 1)
    ));
  }, [selectableComposerCandidates.length]);

  useEffect(() => {
    const selected = selectableComposerCandidates[selectedCandidateIndex];
    if (!selected) return;
    const option = composerMenuRef.current?.querySelector<HTMLElement>(
      `[data-candidate-ref="${CSS.escape(selected.candidateRef)}"]`,
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [selectedCandidateIndex, selectableComposerCandidates]);

  useEffect(() => {
    if (attachmentBlocked) setAttachmentDragActive(false);
  }, [attachmentBlocked]);

  function resetComposer() {
    editorRef.current?.replaceChildren();
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setDraft("");
    setAttachments([]);
    setSkillIds([]);
    setComposerSkillTokens([]);
    setComposerQueryState(null);
    setComposerCandidates(null);
    setComposerRevision(null);
    setSlashQueryBlocked(false);
    composerQueryRangeRef.current = null;
    dismissedComposerQueryRef.current = null;
    setPendingDangerInput(null);
    setAttachmentDragActive(false);
    setRequestedComposerText(null);
    setRequestedComposerDraft(null);
    setComposerRebindBlocked(false);
    taskComposerDraftOriginRef.current = null;
  }

  useEffect(() => {
    if (!available || !openThreadRequest) return;
    if (handledOpenThreadRequestRef.current === openThreadRequest.requestId) return;
    if ("projectId" in openThreadRequest) {
      handledOpenThreadRequestRef.current = openThreadRequest.requestId;
      if (!draftOrigin) draftReturnThreadIdRef.current = selectedThreadRef.current;
      resetComposer();
      setDraftOrigin({
        projectId: openThreadRequest.projectId,
        issueId: openThreadRequest.issueId,
        codexProjectIdentity: openThreadRequest.projectId === projectId
          ? codexProjectIdentity
          : null,
      });
      taskComposerDraftOriginRef.current = {
        projectId: openThreadRequest.projectId,
        issueId: openThreadRequest.issueId,
        codexProjectIdentity: openThreadRequest.projectId === projectId
          ? codexProjectIdentity
          : null,
      };
      setSnapshot(null);
      selectThread(null);
      setHistoryOpen(false);
      setMenu(null);
      const composerDraft = "composerDraft" in openThreadRequest
        ? openThreadRequest.composerDraft
        : null;
      setError(composerDraft && !composerDraft.ready
        ? text(
            "议题中的 Agent 或 Skill 已失效，请返回议题重新选择后再发送。",
            "An Agent or Skill in this issue is unavailable. Re-select it in the issue before sending.",
          )
        : null);
      setRequestedComposerText("composerText" in openThreadRequest
        ? openThreadRequest.composerText
        : null);
      setRequestedComposerDraft(composerDraft);
      setComposerRebindBlocked(composerDraft?.ready === false);
      if (composerDraft?.ready) setComposerRevision(composerDraft.revision);
      setPanelOpen(true);
      return;
    }
    if (!threads.some((thread) => thread.id === openThreadRequest.threadId)) return;
    handledOpenThreadRequestRef.current = openThreadRequest.requestId;
    const selectedChanged = selectedThreadRef.current !== openThreadRequest.threadId;
    const leavingDraft = draftOrigin !== null;
    draftReturnThreadIdRef.current = null;
    setDraftOrigin(null);
    if (selectedChanged || leavingDraft) {
      setSnapshot(null);
      resetComposer();
    }
    selectThread(openThreadRequest.threadId);
    if (!selectedChanged && (leavingDraft || snapshot?.thread.id !== openThreadRequest.threadId)) {
      void loadSnapshot(openThreadRequest.threadId);
    }
    setHistoryOpen(false);
    setMenu(null);
    setError(null);
    setPanelOpen(true);
  }, [
    available,
    draftOrigin,
    loadSnapshot,
    openThreadRequest,
    selectThread,
    snapshot?.thread.id,
    threads,
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!panelOpen || requestedComposerText === null || !editor) return;
    editor.replaceChildren(document.createTextNode(requestedComposerText));
    setDraft(requestedComposerText);
    setRequestedComposerText(null);
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [panelOpen, requestedComposerText]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!panelOpen || requestedComposerDraft === null || !editor) return;
    const nextTokens: ComposerSkillToken[] = [];
    const content = editor.ownerDocument.createDocumentFragment();
    for (const node of requestedComposerDraft.document.nodes) {
      if (node.type === "text") {
        content.append(editor.ownerDocument.createTextNode(node.text));
        continue;
      }
      const unavailable = node.type === "persistedReference" || node.type === "unsupportedReference";
      const kind = node.type === "unsupportedReference"
        ? undefined
        : node.type === "persistedReference"
          ? node.referenceKind
          : node.type;
      const tokenElement = editor.ownerDocument.createElement("span");
      tokenElement.className = "ai-chat-composer-skill-token";
      tokenElement.dataset.composerLabel = node.label;
      if (kind) tokenElement.dataset.composerKind = kind;
      if (!unavailable) tokenElement.dataset.composerCandidateRef = node.candidateRef;
      tokenElement.contentEditable = "false";
      tokenElement.title = unavailable
        ? text(`${node.label}（不可用）`, `${node.label} (unavailable)`)
        : node.label;
      content.append(tokenElement, editor.ownerDocument.createTextNode("\u200B"));
      nextTokens.push({
        key: crypto.randomUUID(),
        candidateRef: node.type === "unsupportedReference"
          ? node.referenceUri
          : node.type === "persistedReference"
            ? node.referenceKey
            : node.candidateRef,
        label: node.label,
        kind,
        unavailable,
        element: tokenElement,
      });
    }
    editor.replaceChildren(content);
    const serialized = serializeComposer(editor);
    setDraft(serialized.message || requestedComposerDraft.document.nodes.map((node) => (
      node.type === "text" ? node.text : node.label
    )).join(""));
    setSkillIds(serialized.skillIds);
    setComposerSkillTokens(nextTokens);
    setRequestedComposerDraft(null);
    editor.focus();
    const range = editor.ownerDocument.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [panelOpen, requestedComposerDraft, text]);

  function restorePersistedConversationFromDraft() {
    if (!draftOrigin) return;
    const previousThreadId = draftReturnThreadIdRef.current;
    const nextThreadId = previousThreadId && threads.some((thread) => thread.id === previousThreadId)
      ? previousThreadId
      : threads[0]?.id ?? null;
    draftReturnThreadIdRef.current = null;
    setDraftOrigin(null);
    setSnapshot(null);
    selectThread(nextThreadId);
    resetComposer();
  }

  useEffect(() => {
    if (
      !draftOrigin
      || (
        draftOrigin.projectId === projectId
        && draftOrigin.issueId === (issueId ?? null)
      )
    ) return;
    restorePersistedConversationFromDraft();
  }, [draftOrigin?.issueId, draftOrigin?.projectId, issueId, projectId]);

  function beginNewConversation() {
    const input = buildThreadCreateInput(projectId ?? "", issueId);
    if (!input) {
      setError(text(
        "请先进入一个已映射的项目，再新建对话",
        "Open a mapped project before you start a new chat.",
      ));
      return;
    }
    if (!draftOrigin) draftReturnThreadIdRef.current = selectedThreadRef.current;
    resetComposer();
    setDraftOrigin({
      projectId: input.projectId,
      issueId: input.issueId ?? null,
      codexProjectIdentity,
    });
    setSnapshot(null);
    selectThread(null);
    setHistoryOpen(false);
    setMenu(null);
    setError(null);
  }

  async function createThreadForDraftOrigin(): Promise<AiChatThread | null> {
    const origin = draftOrigin ?? (
      projectId ? { projectId, issueId, codexProjectIdentity } : null
    );
    const input = buildThreadCreateInput(origin?.projectId ?? "", origin?.issueId ?? null);
    if (!input) {
      setError(text(
        "请先进入一个已映射的项目，再新建对话",
        "Open a mapped project before you start a new chat.",
      ));
      return null;
    }
    const inheritedSettings = {
      model: draftModel,
      reasoningEffort: draftEffort,
      sandbox: draftSandbox,
    };
    setLoading(true);
    try {
      const targetCatalog = catalogLoadedProjectId === input.projectId && activeCatalog
        ? activeCatalog
        : await getAiChatCatalog(input.projectId, undefined, origin?.codexProjectIdentity);
      const normalized = normalizeChatSelection(
        targetCatalog.models,
        inheritedSettings.model,
        inheritedSettings.reasoningEffort,
      );
      const sandbox = targetCatalog.sandboxes.includes(inheritedSettings.sandbox)
        ? inheritedSettings.sandbox
        : targetCatalog.sandboxes.find(
          (candidate): candidate is AiChatSandbox => candidate === "workspace-write",
        ) ?? targetCatalog.sandboxes.find(isAiChatSandbox) ?? inheritedSettings.sandbox;
      const settings = {
        model: normalized?.model ?? inheritedSettings.model,
        reasoningEffort: normalized?.reasoningEffort ?? inheritedSettings.reasoningEffort,
        sandbox,
      };
      const thread = await createAiChatThread({
        ...input,
        ...settings,
        ...(origin?.codexProjectIdentity ?? {}),
      });
      replaceThread(thread);
      selectThread(thread.id);
      setSnapshot({ thread, events: [], runs: [] });
      draftReturnThreadIdRef.current = null;
      setDraftOrigin(null);
      setHistoryOpen(false);
      setError(null);
      return thread;
    } catch (nextError) {
      setError(messageFor(nextError));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function deleteThread(thread: AiChatThread) {
    if (!window.confirm(text(
      `删除本地对话“${thread.title}”？`,
      `Delete local chat “${thread.title}”?`,
    ))) return;
    setDeletingThreadId(thread.id);
    try {
      await deleteAiChatThread(thread.id);
      const remainingThreads = threads.filter((candidate) => candidate.id !== thread.id);
      setThreads(remainingThreads);
      if (remainingThreads.length === 0) setHistoryOpen(false);
      if (selectedThreadRef.current === thread.id) {
        setSnapshot(null);
        setDraftOrigin(null);
        selectThread(remainingThreads[0]?.id ?? null);
        resetComposer();
      }
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setDeletingThreadId(null);
    }
  }

  async function saveThreadSettings(changes: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  }) {
    const previousThread = snapshot?.thread;
    if (!previousThread) return;
    const threadId = previousThread.id;
    setSettingsSaving(true);
    try {
      const thread = await updateAiChatThread(threadId, changes);
      setSnapshot((current) => patchAiChatSnapshot(current, threadId, thread));
      replaceThread(thread);
      if (selectedThreadRef.current === threadId) setError(null);
    } catch (nextError) {
      if (selectedThreadRef.current === threadId) {
        restoreDraftSettings(previousThread);
        setError(messageFor(nextError));
      }
    } finally {
      setSettingsSaving(false);
    }
  }

  async function chooseModel(model: AiChatModel) {
    const reasoningEffort = reasoningEffortForModel(model, draftEffort);
    setMenu(null);
    setDraftModel(model.slug);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({
      model: model.slug,
      reasoningEffort,
    });
  }

  async function chooseEffort(reasoningEffort: string) {
    setMenu(null);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({ reasoningEffort });
  }

  async function chooseSandbox(sandbox: AiChatSandbox) {
    setMenu(null);
    setDraftSandbox(sandbox);
    await saveThreadSettings({ sandbox });
  }

  function syncComposerState() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = serializeComposer(editor);
    setDraft(next.message);
    setSkillIds(next.skillIds);
    setComposerSkillTokens((current) => current.filter((token) => editor.contains(token.element)));
    if (!next.message && editor.childNodes.length > 0) editor.replaceChildren();
  }

  function rememberComposerBeforeInput(event: InputEvent) {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.getSelection();
    if (
      !editor
      || !selection
      || !selection.isCollapsed
      || !selection.focusNode
      || !editor.contains(selection.focusNode)
      || event.inputType !== "insertText"
      || event.data === null
    ) {
      composerBeforeInputRef.current = null;
      return;
    }
    composerBeforeInputRef.current = {
      container: selection.focusNode,
      offset: selection.focusOffset,
      text: event.data,
    };
  }

  function updateComposerQuery(fromInput = false) {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.ownerDocument.activeElement !== editor) {
      composerBeforeInputRef.current = null;
      composerQueryRangeRef.current = null;
      setComposerQueryState(null);
      return;
    }
    const beforeInput = fromInput ? composerBeforeInputRef.current : null;
    const detected = (fromInput ? composerQueryAtEnd(editor) : composerQuery(editor)) ?? (
      beforeInput ? composerQueryAfterInput(editor, beforeInput) : null
    );
    const textMatch = /(?:^|\s)([@/])([^\s@/]*)$/.exec(
      (editor.textContent ?? "").replaceAll("\u200B", ""),
    );
    const next = detected && textMatch?.[1] === detected.trigger
      ? { ...detected, query: textMatch[2] }
      : detected;
    composerBeforeInputRef.current = null;
    if (fromInput) dismissedComposerQueryRef.current = null;
    const queryKey = next ? `${next.trigger}${next.query}` : null;
    composerQueryRangeRef.current = next?.range ?? null;
    setSlashQueryBlocked(next?.trigger === "/");
    setComposerQueryState(
      next && dismissedComposerQueryRef.current !== queryKey
        ? { trigger: next.trigger, query: next.query }
        : null,
    );
  }

  function removeComposerSkillToken(element: HTMLElement) {
    const editor = editorRef.current;
    const parent = element.parentNode;
    if (!editor || !parent) return;
    const nextSibling = element.nextSibling;
    const childIndex = Array.prototype.indexOf.call(parent.childNodes, element) as number;
    if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent?.startsWith("\u200B")) {
      nextSibling.textContent = nextSibling.textContent.slice(1);
    }
    element.remove();
    setComposerSkillTokens((current) => current.filter((token) => token.element !== element));
    const selection = editor.ownerDocument.getSelection();
    const range = editor.ownerDocument.createRange();
    if (nextSibling?.isConnected && nextSibling.nodeType === Node.TEXT_NODE) {
      range.setStart(nextSibling, 0);
    } else {
      range.setStart(parent, Math.min(childIndex, parent.childNodes.length));
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    editor.focus();
  }

  function insertComposerFragment(
    fragment: ComposerFragment,
    targetRange?: Range,
  ): boolean {
    const editor = editorRef.current;
    if (!editor || composerMarkerCount(fragment.message) !== fragment.skillIds.length) return false;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    const selection = editor.ownerDocument.getSelection();
    const range = targetRange ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!range || !editor.contains(range.commonAncestorContainer)) return false;

    const content = editor.ownerDocument.createDocumentFragment();
    const newTokens: ComposerSkillToken[] = [];
    let messageOffset = 0;
    let skillIndex = 0;
    for (
      let markerOffset = fragment.message.indexOf(SKILL_MARKER);
      markerOffset >= 0;
      markerOffset = fragment.message.indexOf(SKILL_MARKER, messageOffset)
    ) {
      if (markerOffset > messageOffset) {
        content.append(editor.ownerDocument.createTextNode(
          fragment.message.slice(messageOffset, markerOffset),
        ));
      }
      const skillId = fragment.skillIds[skillIndex];
      const skill = skillsById.get(skillId);
      const reference = composerFragmentReference(fragment, skillIndex, skillsById);
      if (!reference) return false;
      const tokenElement = editor.ownerDocument.createElement("span");
      tokenElement.className = "ai-chat-composer-skill-token";
      tokenElement.dataset.skillId = reference.stableId;
      tokenElement.dataset.composerStableId = reference.stableId;
      tokenElement.dataset.composerReferenceKey = reference.referenceKey;
      tokenElement.dataset.composerMarkdown = reference.markdown;
      tokenElement.dataset.composerKind = reference.kind;
      tokenElement.dataset.composerLabel = reference.label;
      tokenElement.contentEditable = "false";
      tokenElement.title = reference.label;
      content.append(tokenElement, editor.ownerDocument.createTextNode("\u200B"));
      newTokens.push({
        key: crypto.randomUUID(),
        candidateRef: reference.stableId,
        label: reference.label,
        kind: reference.kind,
        element: tokenElement,
      });
      skillIndex += 1;
      messageOffset = markerOffset + SKILL_MARKER.length;
    }
    if (messageOffset < fragment.message.length) {
      content.append(editor.ownerDocument.createTextNode(fragment.message.slice(messageOffset)));
    }
    if (!content.lastChild) return false;

    const lastNode = content.lastChild;
    range.deleteContents();
    range.insertNode(content);
    if (lastNode.nodeType === Node.TEXT_NODE) {
      range.setStart(lastNode, lastNode.textContent?.length ?? 0);
    } else {
      range.setStartAfter(lastNode);
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    setComposerSkillTokens((current) => [...current, ...newTokens]);
    setComposerQueryState(null);
    composerQueryRangeRef.current = null;
    editor.focus();
    return true;
  }

  function selectComposerSkill(candidate: ComposerSkillCandidate) {
    const editor = editorRef.current;
    const range = editor ? composerQueryAtEnd(editor)?.range ?? composerQueryRangeRef.current : null;
    if (!composerQueryState || !editor || !range) return;
    const insertedDocument = insertComposerSkill(createComposerDocument(), 0, 0, candidate);
    const skillNode = insertedDocument.nodes[0];
    if (!skillNode || skillNode.type !== "skill") return;
    const tokenElement = editor.ownerDocument.createElement("span");
    tokenElement.className = "ai-chat-composer-skill-token";
    tokenElement.dataset.composerCandidateRef = skillNode.candidateRef;
    tokenElement.dataset.composerLabel = skillNode.label;
    tokenElement.dataset.composerKind = "skill";
    const persistence = candidate.persistence?.kind === "skill" ? candidate.persistence : null;
    const stableSkillId = persistence
      ? stableComposerReferenceId(persistence.referenceKey)
      : null;
    if (stableSkillId && persistence) {
      tokenElement.dataset.skillId = stableSkillId;
      tokenElement.dataset.composerStableId = stableSkillId;
      tokenElement.dataset.composerReferenceKey = persistence.referenceKey;
      tokenElement.dataset.composerMarkdown = persistence.markdown;
    }
    tokenElement.contentEditable = "false";
    tokenElement.title = skillNode.label;
    const sentinel = editor.ownerDocument.createTextNode("\u200B");
    range.deleteContents();
    range.insertNode(sentinel);
    range.insertNode(tokenElement);
    range.setStart(sentinel, sentinel.length);
    range.collapse(true);
    editor.ownerDocument.getSelection()?.removeAllRanges();
    editor.ownerDocument.getSelection()?.addRange(range);
    setComposerSkillTokens((current) => [...current, {
      key: crypto.randomUUID(),
      candidateRef: skillNode.candidateRef,
      label: skillNode.label,
      kind: "skill",
      element: tokenElement,
    }]);
    setComposerRevision(composerCandidates?.revision ?? null);
    setComposerQueryState(null);
    setSlashQueryBlocked(false);
    composerQueryRangeRef.current = null;
    dismissedComposerQueryRef.current = null;
    syncComposerState();
    editor.focus();
  }

  function selectComposerAgent(candidate: ComposerAgentCandidate) {
    const editor = editorRef.current;
    const range = editor ? composerQueryAtEnd(editor)?.range ?? composerQueryRangeRef.current : null;
    if (!composerQueryState || !editor || !range) return;
    const insertedDocument = insertComposerAgent(createComposerDocument(), 0, 0, candidate);
    const agentNode = insertedDocument.nodes[0];
    if (!agentNode || agentNode.type !== "agent") return;
    const tokenElement = editor.ownerDocument.createElement("span");
    tokenElement.className = "ai-chat-composer-skill-token";
    tokenElement.dataset.composerCandidateRef = agentNode.candidateRef;
    tokenElement.dataset.composerLabel = agentNode.label;
    tokenElement.dataset.composerKind = "agent";
    const persistence = candidate.persistence?.kind === "agent" ? candidate.persistence : null;
    const stableAgentId = persistence
      ? stableComposerReferenceId(persistence.referenceKey, "agent")
      : null;
    if (stableAgentId && persistence) {
      tokenElement.dataset.composerStableId = stableAgentId;
      tokenElement.dataset.composerReferenceKey = persistence.referenceKey;
      tokenElement.dataset.composerMarkdown = persistence.markdown;
    }
    tokenElement.contentEditable = "false";
    tokenElement.title = agentNode.label;
    const sentinel = editor.ownerDocument.createTextNode("\u200B");
    range.deleteContents();
    range.insertNode(sentinel);
    range.insertNode(tokenElement);
    range.setStart(sentinel, sentinel.length);
    range.collapse(true);
    editor.ownerDocument.getSelection()?.removeAllRanges();
    editor.ownerDocument.getSelection()?.addRange(range);
    setComposerSkillTokens((current) => [...current, {
      key: crypto.randomUUID(),
      candidateRef: agentNode.candidateRef,
      label: agentNode.label,
      kind: "agent",
      element: tokenElement,
    }]);
    setComposerRevision(composerCandidates?.revision ?? null);
    setComposerQueryState(null);
    setSlashQueryBlocked(false);
    composerQueryRangeRef.current = null;
    dismissedComposerQueryRef.current = null;
    syncComposerState();
    editor.focus();
  }

  function selectSlashAction(candidate: ComposerSlashActionCandidate) {
    const editor = editorRef.current;
    const range = editor ? composerQueryAtEnd(editor)?.range ?? composerQueryRangeRef.current : null;
    if (!composerQueryState || !editor || !range) return;
    range.deleteContents();
    setComposerQueryState(null);
    setSlashQueryBlocked(false);
    composerQueryRangeRef.current = null;
    dismissedComposerQueryRef.current = null;
    syncComposerState();
    if (candidate.dispatch.handlerId === "new-conversation") beginNewConversation();
    else if (candidate.dispatch.handlerId === "open-model-menu") setMenu("model-list");
    else if (candidate.dispatch.handlerId === "open-reasoning-menu") setMenu("effort-list");
    else if (candidate.dispatch.handlerId === "compact-conversation" && selectedThreadId) {
      setLoading(true);
      void compactAiChatThread(selectedThreadId).then((thread) => {
        replaceThread(thread);
        setError(null);
      }, (nextError) => setError(messageFor(nextError))).finally(() => setLoading(false));
    }
  }

  function selectComposerCandidate(candidate: ComposerCandidate) {
    if (candidate.kind === "skill") selectComposerSkill(candidate);
    else if (candidate.kind === "agent") selectComposerAgent(candidate);
    else selectSlashAction(candidate);
  }

  function realSkillIdsForMessage(): string[] {
    return skillIds;
  }

  async function startMessage(
    message: string,
    dangerConfirmed: boolean,
    boundSkillIds?: string[],
    clearSubmittedDraft = true,
    boundAttachments?: AiChatAttachmentInput[],
    boundComposerDocument?: ComposerDraftDocument,
    boundComposerRevision?: string,
  ) {
    if (sendBlocked) return;
    if (boundSkillIds === undefined && slashQueryBlocked) return;
    const trimmed = message.trim();
    const submittedSkillIds = boundSkillIds ?? [...realSkillIdsForMessage()];
    let currentComposerDocument = boundComposerDocument
      ?? (editorRef.current ? serializeComposerDocumentFromDom(editorRef.current) : undefined);
    let currentComposerRevision = boundComposerRevision ?? composerRevision ?? undefined;
    const hasPersistedReference = currentComposerDocument
      ? hasPersistedComposerReference(currentComposerDocument)
      : false;
    const hasStructuredReference = currentComposerDocument?.nodes.some((node) => (
      node.type === "skill" || node.type === "agent"
      || node.type === "persistedReference"
      || node.type === "unsupportedReference"
    )) ?? false;
    const isTaskOriginPlainTextDraft = Boolean(
      taskComposerDraftOriginRef.current
      && currentComposerDocument?.nodes.every((node) => node.type === "text"),
    );
    if (isTaskOriginPlainTextDraft) {
      if (!boundComposerDocument) currentComposerDocument = createComposerDocument(message);
      if (!currentComposerRevision) {
        try {
          const candidates = await getAiChatComposerCandidates({
            projectId: taskComposerDraftOriginRef.current?.projectId,
            ...(catalogCodexProjectIdentity ?? {}),
            trigger: "@",
            query: "",
          });
          if (!candidates.revision.trim()) {
            throw new Error(text(
              "补全来源无效，请重新打开任务草稿",
              "The completion source is invalid. Reopen the task draft.",
            ));
          }
          currentComposerRevision = candidates.revision;
          setComposerRevision(candidates.revision);
        } catch (nextError) {
          setError(messageFor(nextError));
          return;
        }
      }
    }
    const useComposerTurn = hasStructuredReference || isTaskOriginPlainTextDraft;
    if (useComposerTurn && !hasPersistedReference && !currentComposerRevision) {
      setError(text(
        "补全来源已失效，请重新选择 Skill",
        "The completion source is stale. Select the Skill again.",
      ));
      return;
    }
    const messageAttachments = boundAttachments ?? attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      dataBase64: attachment.dataBase64,
    }));
    if (!trimmed && messageAttachments.length === 0) return;
    let thread = snapshot?.thread ?? null;
    const creatingThread = !thread;
    const messageSandbox = thread?.sandbox ?? draftSandbox;
    if (needsDangerConfirmation(messageSandbox, dangerConfirmed)) {
      setPendingDangerInput({
        message: trimmed,
        skillIds: submittedSkillIds,
        ...(useComposerTurn && currentComposerDocument ? {
          composerDocument: currentComposerDocument,
          ...(currentComposerRevision ? { composerRevision: currentComposerRevision } : {}),
        } : {}),
        attachments: messageAttachments,
        clearSubmittedDraft,
      });
      return;
    }
    if (creatingThread && clearSubmittedDraft && !useComposerTurn) resetComposer();
    if (!thread) thread = await createThreadForDraftOrigin();
    if (!thread) return;
    const messageSkillIds = (
      boundSkillIds !== undefined || catalogLoadedProjectId === thread.origin.projectId
    ) ? submittedSkillIds : [];
    setPendingDangerInput(null);
    setError(null);
    try {
      let resolvedComposerDocument: ComposerDocument | undefined;
      if (useComposerTurn && currentComposerDocument) {
        if (hasPersistedComposerReference(currentComposerDocument)) {
          const persistedNodes = currentComposerDocument.nodes.filter(
            isPersistedComposerNode,
          );
          const rebound = await rebindAiChatComposerReferences({
            contractVersion: COMPOSER_CONTRACT_VERSION,
            projectId: thread.origin.projectId,
            threadId: thread.id,
            document: { version: 1, nodes: persistedNodes },
          });
          if (!rebound.ready) {
            throw new Error(text(
              "Skill 当前不可用，请稍后重试",
              "The Skill is currently unavailable. Try again later.",
            ));
          }
          let reboundIndex = 0;
          const resolvedNodes: ComposerDocument["nodes"] = [];
          for (const node of currentComposerDocument.nodes) {
            if (isPersistedComposerNode(node)) {
              resolvedNodes.push(rebound.document.nodes[reboundIndex]);
              reboundIndex += 1;
            } else {
              resolvedNodes.push(node);
            }
          }
          resolvedComposerDocument = serializeComposerDocument({
            version: 1,
            nodes: resolvedNodes,
          });
          currentComposerRevision = rebound.revision;
          setComposerRevision(rebound.revision);
        } else {
          resolvedComposerDocument = serializeComposerDocument({
            version: 1,
            nodes: currentComposerDocument.nodes as ComposerDocument["nodes"],
          });
        }
      }
      const composerTurnInput = useComposerTurn
        && resolvedComposerDocument
        && currentComposerRevision
        ? buildComposerTurnInput(
            resolvedComposerDocument,
            currentComposerRevision,
            dangerConfirmed,
            messageAttachments,
          )
        : null;
      if (clearSubmittedDraft && !creatingThread && !composerTurnInput) {
        resetComposer();
      }
      const run = composerTurnInput
        ? await startAiChatComposerTurn(thread.id, composerTurnInput)
        : await startAiChatTurn(thread.id, buildTurnInput(
            trimmed,
            messageSkillIds,
            dangerConfirmed,
            messageAttachments,
          ));
      if (clearSubmittedDraft && composerTurnInput) resetComposer();
      observedRunStatusesRef.current.set(run.id, run.status);
      setSnapshot((current) => current?.thread.id === thread.id ? {
          ...current,
          thread: {
            ...current.thread,
            status: "running",
            currentRun: run,
            latestTodo: null,
          },
          runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
        } : current);
      replaceThread({ ...thread, status: "running", currentRun: run, latestTodo: null });
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === thread.id) setError(messageFor(nextError));
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    }
  }

  function attachmentFiles(files: FileList | File[]): File[] {
    return Array.from(files);
  }

  async function addAttachments(files: File[]) {
    if (attachmentBlocked) return;
    const acceptedFiles = attachmentFiles(files);
    if (acceptedFiles.length === 0) return;
    try {
      const nextAttachments = await Promise.all(acceptedFiles.map((file, index) => (
        new Promise<ComposerAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error(text(
                `无法读取附件 ${file.name}`,
                `Could not read attachment ${file.name}.`,
              )));
              return;
            }
            const separator = reader.result.indexOf(",");
            resolve({
              id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              dataBase64: reader.result.slice(separator + 1),
              ...(file.type.startsWith("image/") ? { previewUrl: reader.result } : {}),
            });
          };
          reader.onerror = () => reject(new Error(text(
            `无法读取附件 ${file.name}`,
            `Could not read attachment ${file.name}.`,
          )));
          reader.readAsDataURL(file);
        })
      )));
      setAttachments((current) => [...current, ...nextAttachments]);
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = attachmentFiles(event.target.files ?? []);
    event.target.value = "";
    await addAttachments(files);
  }

  function hasDraggedFile(event: ReactDragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.items).some((item) => (
      item.kind === "file"
    )) || event.dataTransfer.files.length > 0;
  }

  function handleAttachmentDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFile(event)) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!attachmentDragActive && !hasDraggedFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentBlocked ? "none" : "copy";
  }

  function handleAttachmentDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setAttachmentDragActive(false);
  }

  function handleAttachmentDrop(event: ReactDragEvent<HTMLDivElement>) {
    setAttachmentDragActive(false);
    const files = attachmentFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    void addAttachments(files);
  }

  function handleComposerCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    writeSkillFragmentToClipboard(event, fragment, skillsById);
  }

  function handleComposerCut(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    if (!writeSkillFragmentToClipboard(event, fragment, skillsById)) return;

    const range = fragment.range;
    range.deleteContents();
    range.collapse(true);
    const { startContainer, startOffset } = range;
    let sentinel: Text | null = null;
    let sentinelOffset = 0;
    if (startContainer.nodeType === Node.TEXT_NODE) {
      const text = startContainer as Text;
      if (text.data[startOffset] === "\u200B") {
        sentinel = text;
        sentinelOffset = startOffset;
      } else if (
        startOffset === text.length
        && text.nextSibling?.nodeType === Node.TEXT_NODE
        && (text.nextSibling as Text).data.startsWith("\u200B")
      ) {
        sentinel = text.nextSibling as Text;
      }
    } else if (
      startContainer.nodeType === Node.ELEMENT_NODE
      && startContainer.childNodes[startOffset]?.nodeType === Node.TEXT_NODE
      && (startContainer.childNodes[startOffset] as Text).data.startsWith("\u200B")
    ) {
      sentinel = startContainer.childNodes[startOffset] as Text;
    }
    if (sentinel) {
      sentinel.deleteData(sentinelOffset, 1);
      if (!sentinel.data && sentinel !== startContainer) sentinel.remove();
    }

    syncComposerState();
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    if (range.startContainer === editor || editor.contains(range.startContainer)) {
      selection?.addRange(range);
    } else {
      const caret = editor.ownerDocument.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      selection?.addRange(caret);
    }
    setComposerQueryState(null);
    composerQueryRangeRef.current = null;
    editor.focus();
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    if (attachmentBlocked) return;
    const files = attachmentFiles(event.clipboardData.files);
    event.preventDefault();
    if (files.length > 0) {
      void addAttachments(files);
      return;
    }
    const skills = activeCatalog?.skills ?? [];
    const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    const internalFragment = parseAiChatComposerFragment(
      event.clipboardData.getData(COMPOSER_FRAGMENT_MIME),
      skillsById.keys(),
    );
    if (internalFragment && insertComposerFragment(internalFragment)) return;
    const htmlFragment = composerFragmentFromHtml(
      event.clipboardData.getData("text/html"),
      skills,
    );
    if (htmlFragment && insertComposerFragment(htmlFragment)) return;
    const clipboardText = event.clipboardData.getData("text/plain");
    const plainFragment = composerFragmentFromPlainText(clipboardText, skills);
    if (plainFragment && insertComposerFragment(plainFragment)) return;
    const plainText = clipboardText.replaceAll(SKILL_MARKER, "\uFFFD");
    if (plainText) insertComposerFragment({ message: plainText, skillIds: [] });
  }

  async function stopRun(run: AiChatRun | null) {
    if (!run) return;
    try {
      await interruptAiChatRun(run.id);
      if (selectedThreadRef.current === run.threadId) {
        void selectedHintRefreshQueue.request(run.threadId);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === run.threadId) setError(messageFor(nextError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (composerBlocked) return;
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "Backspace") {
      const token = editorRef.current ? tokenBeforeComposerCaret(editorRef.current) : null;
      if (token) {
        event.preventDefault();
        removeComposerSkillToken(token);
        return;
      }
    }
    const navigationDirection = event.key === "ArrowDown" || (event.ctrlKey && event.key.toLocaleLowerCase() === "n")
      ? 1
      : event.key === "ArrowUp" || (event.ctrlKey && event.key.toLocaleLowerCase() === "p")
        ? -1
        : 0;
    if (composerQueryState && navigationDirection > 0) {
      event.preventDefault();
      if (selectableComposerCandidates.length > 0) {
        setSelectedCandidateIndex((current) => (
          (current + 1) % selectableComposerCandidates.length
        ));
      }
      return;
    }
    if (composerQueryState && navigationDirection < 0) {
      event.preventDefault();
      if (selectableComposerCandidates.length > 0) {
        setSelectedCandidateIndex((current) => (
          (current - 1 + selectableComposerCandidates.length) % selectableComposerCandidates.length
        ));
      }
      return;
    }
    if (
      (event.key === "Enter" || event.key === "Tab")
      && composerQueryState
    ) {
      event.preventDefault();
      const selected = selectableComposerCandidates[selectedCandidateIndex];
      if (selected) selectComposerCandidate(selected);
      return;
    }
    if (event.key === "Enter") {
      if (primaryAction === "stop") return;
      event.preventDefault();
      if (primaryAction === "send") void startMessage(draft, false);
    }
  }

  if (!available) return null;

  return (
    <div
      className={`ai-chat-root is-${launcherState}`}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest(".ai-chat-menu-wrap")) setMenu(null);
      }}
    >
      {panelOpen && (
        <section
          ref={panelRef}
          className={`ai-chat-panel${panelResizeEdge ? ` is-resizing-${panelResizeEdge}` : ""}`}
          style={panelGeometry ?? undefined}
          aria-label={text("Codex AI 对话", "Codex AI chat")}
          data-screen-label={text("Codex AI 对话", "Codex AI chat")}
        >
          <div
            className="ai-chat-resize-handle is-top"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top")}
          />
          <div
            className="ai-chat-resize-handle is-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "left")}
          />
          <div
            className="ai-chat-resize-handle is-top-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top-left")}
          />
          <header className="ai-chat-panel-header">
            <div className="ai-chat-panel-title">
              <strong>{snapshot?.thread.title ?? text("新对话", "New chat")}</strong>
              <span>{snapshot?.thread.origin.projectName ?? text(
                "选择对话或从当前项目新建",
                "Select a chat or start one in the current project",
              )}</span>
            </div>
            <button
              type="button"
              aria-label={text("对话历史", "Chat history")}
              aria-pressed={historyOpen}
              title={text("对话历史", "Chat history")}
              onClick={() => { setHistoryOpen((current) => !current); setMenu(null); }}
            >
              <ConversationIcon color="currentColor" />
            </button>
            <button
              type="button"
              aria-label={text("新建对话", "New chat")}
              title={projectId
                ? text("新建对话", "New chat")
                : text("请先进入项目", "Open a project first")}
              disabled={!projectId || loading}
              onClick={beginNewConversation}
            >
              <PlusIcon color="currentColor" size={15} />
            </button>
            <button
              type="button"
              aria-label={text("关闭 AI 对话", "Close AI chat")}
              title={text("关闭", "Close")}
              onClick={() => {
                restorePersistedConversationFromDraft();
                setPanelOpen(false);
              }}
            >
              <LinearIcon name="close" />
            </button>
          </header>

          {historyOpen && (
            <div className="ai-chat-history" aria-label={text("对话历史", "Chat history")}>
              <div className="ai-chat-history-heading">
                <strong>{text("对话历史", "Chat history")}</strong>
                <span>{threads.length}</span>
              </div>
              {threads.length > 0 ? threads.map((thread) => (
                <div
                  className={`ai-chat-history-row${thread.id === selectedThreadId ? " is-active" : ""}`}
                  key={thread.id}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (thread.id !== selectedThreadRef.current) resetComposer();
                      draftReturnThreadIdRef.current = null;
                      setDraftOrigin(null);
                      selectThread(thread.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <span className={`ai-chat-thread-status is-${thread.status}`} aria-hidden="true" />
                    <span>
                      <strong>{thread.title}</strong>
                      <small>{thread.origin.projectName} · {dateLabel(thread.updatedAt, locale)}</small>
                    </span>
                  </button>
                  <button
                    className="ai-chat-history-delete"
                    type="button"
                    aria-label={text(`删除对话 ${thread.title}`, `Delete chat ${thread.title}`)}
                    title={text("删除本地记录", "Delete local record")}
                    disabled={thread.status === "running" || deletingThreadId === thread.id}
                    onClick={() => void deleteThread(thread)}
                  >
                    <DeleteIcon color="currentColor" />
                  </button>
                </div>
              )) : (
                <p>{text("还没有本地对话", "No local chats yet")}</p>
              )}
            </div>
          )}

          <div
            className="ai-chat-messages"
            ref={messagesRef}
            aria-busy={loading}
            aria-live="polite"
          >
            {loading && !snapshot ? (
              <div className="ai-chat-empty">
                <span className="ai-chat-spinner" />
                {text("正在恢复对话…", "Restoring chat…")}
              </div>
            ) : snapshot ? (
              <>
                <MessageTimeline
                  activeRunId={currentRun?.id ?? null}
                  events={snapshot.events}
                  skills={activeCatalog?.skills ?? []}
                />
                {snapshot.thread.status === "running" && (
                  <div className="ai-chat-running" role="status">
                    <span className="ai-chat-spinner" />
                    {text("Codex 正在处理", "Codex is working")}
                  </div>
                )}
                {retryableUserEvent && (
                  <button
                    className="ai-chat-retry"
                    type="button"
                    onClick={() => {
                      void startMessage(
                        retryableUserEvent.content,
                        false,
                        eventSkillIds(retryableUserEvent),
                        false,
                        [],
                      );
                    }}
                  >
                    <RefreshIcon color="currentColor" />
                    {text("重试上一条消息", "Retry the previous message")}
                  </button>
                )}
              </>
            ) : (
              <div className="ai-chat-empty">
                <ConversationIcon color="currentColor" />
                <strong>{projectId
                  ? text("在当前项目中开始对话", "Start a chat in the current project")
                  : text("打开一个历史对话", "Open a chat from history")}</strong>
                <p>{projectId
                  ? text(
                    "Codex 会在新对话创建时记住当前项目。",
                    "Codex will remember the current project when it creates the new chat.",
                  )
                  : text("进入项目后可以新建对话。", "Open a project to start a new chat.")}</p>
              </div>
            )}
          </div>

          {visibleError && (
            <div className="ai-chat-error" role="alert">
              <LinearIcon name="alert" />
              <span>{visibleError === AI_CHAT_UNAVAILABLE_ERROR
                ? text("AI 对话暂时不可用", "AI chat is temporarily unavailable.")
                : visibleError}</span>
            </div>
          )}

          <div
            className={`ai-chat-composer${attachmentDragActive ? " is-attachment-drag-active" : ""}`}
            onDragEnter={handleAttachmentDragEnter}
            onDragOver={handleAttachmentDragOver}
            onDragLeave={handleAttachmentDragLeave}
            onDrop={handleAttachmentDrop}
          >
            {attachmentDragActive && (
              <div className="ai-chat-attachment-drop-hint" aria-hidden="true">
                {text("松开添加文件", "Drop files to add them")}
              </div>
            )}
            <div className="ai-chat-input-wrap">
              {attachments.length > 0 && (
                <div className="ai-chat-composer-attachments">
                  {attachments.map((attachment) => (
                    <div
                      className={`ai-chat-composer-attachment${attachment.previewUrl ? "" : " is-file"}`}
                      key={attachment.id}
                    >
                      {attachment.previewUrl
                        ? <img src={attachment.previewUrl} alt="" />
                        : (
                          <span className="ai-chat-composer-file">
                            <LinearIcon name="file" />
                            <span>{attachment.filename}</span>
                          </span>
                        )}
                      <button
                        type="button"
                        aria-label={text(
                          `移除附件 ${attachment.filename}`,
                          `Remove attachment ${attachment.filename}`,
                        )}
                        title={text("移除附件", "Remove attachment")}
                        onClick={() => {
                          setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        }}
                      >
                        <LinearIcon name="close" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div
                ref={editorRef}
                className="ai-chat-composer-editor"
                contentEditable={!composerBlocked}
                data-placeholder={text("询问 Codex", "Ask Codex")}
                role="textbox"
                aria-label={text("发送给 Codex 的消息", "Message to Codex")}
                aria-multiline="true"
                aria-autocomplete="list"
                aria-controls={composerQueryState ? "ai-chat-composer-candidates" : undefined}
                aria-expanded={Boolean(composerQueryState)}
                suppressContentEditableWarning
                onBeforeInput={(event) => rememberComposerBeforeInput(event.nativeEvent as InputEvent)}
                onInput={(event) => {
                  syncComposerState();
                  if (!event.nativeEvent.isComposing) {
                    updateComposerQuery(true);
                    requestAnimationFrame(() => updateComposerQuery());
                  }
                }}
                onClick={(event) => {
                  const token = (event.target as HTMLElement).closest<HTMLElement>(
                    ".ai-chat-composer-skill-token",
                  );
                  if (token && event.currentTarget.contains(token)) {
                    removeComposerSkillToken(token);
                    return;
                  }
                  updateComposerQuery();
                }}
                onKeyDown={handleComposerKeyDown}
                onKeyUp={(event) => {
                  if (
                    event.key === "ArrowLeft"
                    || event.key === "ArrowRight"
                    || event.key === "Home"
                    || event.key === "End"
                    || (!composerQueryState && (
                      event.key === "ArrowUp"
                      || event.key === "ArrowDown"
                    ))
                  ) updateComposerQuery();
                }}
                onCompositionEnd={() => updateComposerQuery()}
                onBlur={() => setComposerQueryState(null)}
                onCopy={handleComposerCopy}
                onCut={handleComposerCut}
                onPaste={handleComposerPaste}
              />
              {composerSkillTokens.map((token) => {
                return createPortal(
                  <button
                    type="button"
                    aria-label={text(
                      `移除${token.kind === "agent" ? " Agent" : " Skill"} ${token.label}`,
                      `Remove ${token.kind === "agent" ? "Agent" : "Skill"} ${token.label}`,
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeComposerSkillToken(token.element)}
                    disabled={token.unavailable}
                  >
                    <span className="ai-chat-skill-reference">
                      {token.kind === "agent"
                        ? <ConversationIcon color="currentColor" />
                        : <ProjectIcon color="currentColor" />}
                      <span>{token.label}</span>
                    </span>
                  </button>,
                  token.element,
                  token.key,
                );
              })}
              {composerQueryState && (
                <div
                  ref={composerMenuRef}
                  id="ai-chat-composer-candidates"
                  className="ai-chat-skill-menu"
                  role="listbox"
                  aria-label={text("Composer 补全", "Composer completions")}
                  aria-busy={composerCandidatesLoading}
                >
                  {composerCandidatesLoading && (
                    <div className="ai-chat-composer-candidate-state" role="status">
                      <span className="ai-chat-spinner" />
                      {text("正在读取补全…", "Loading completions…")}
                    </div>
                  )}
                  {!composerCandidatesLoading && composerCandidatesError && (
                    <div className="ai-chat-composer-candidate-state is-error" role="alert">
                      {composerCandidatesError === AI_CHAT_UNAVAILABLE_ERROR
                        ? text("补全来源暂时不可用", "Completion sources are temporarily unavailable.")
                        : composerCandidatesError}
                    </div>
                  )}
                  {!composerCandidatesLoading && !composerCandidatesError && visibleComposerCandidates.map((candidate) => {
                    const selectableIndex = selectableComposerCandidates.findIndex((item) => (
                      item.candidateRef === candidate.candidateRef
                    ));
                    const selected = selectableIndex === selectedCandidateIndex && selectableIndex >= 0;
                    const disabled = !candidate.selectable;
                    return (
                      <button
                        className={selected ? "is-selected" : undefined}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={disabled}
                        disabled={disabled}
                        data-candidate-ref={candidate.candidateRef}
                        key={candidate.candidateRef}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerEnter={() => {
                          if (selectableIndex >= 0) setSelectedCandidateIndex(selectableIndex);
                        }}
                        onClick={() => {
                          selectComposerCandidate(candidate);
                        }}
                      >
                        {candidate.kind === "skill"
                          ? <ProjectIcon color="currentColor" />
                          : candidate.kind === "agent"
                            ? <ConversationIcon color="currentColor" />
                            : <LinearIcon name="terminal" />}
                        <span>
                          <strong>{candidate.kind === "slashAction" ? candidate.command : candidate.label}</strong>
                          <small>{candidate.description ?? candidate.group}</small>
                          {disabled && <em>{text("当前客户端未接入执行", "No client handler available")}</em>}
                        </span>
                      </button>
                    );
                  })}
                  {!composerCandidatesLoading
                    && !composerCandidatesError
                    && visibleComposerCandidates.length === 0
                    && composerCandidates && (
                      <div className="ai-chat-composer-candidate-state" role="status">
                        {text("没有匹配的可选项", "No matching completions")}
                      </div>
                    )}
                </div>
              )}
            </div>

            <div className="ai-chat-composer-toolbar">
              <input
                ref={attachmentInputRef}
                className="ai-chat-attachment-input"
                type="file"
                multiple
                tabIndex={-1}
                onChange={(event) => void handleAttachmentSelection(event)}
              />
              <button
                className="ai-chat-attachment-button"
                type="button"
                aria-label={text("添加附件", "Add attachment")}
                title={text("添加附件", "Add attachment")}
                disabled={attachmentBlocked}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <PlusIcon color="currentColor" size={15} />
              </button>
              <div className="ai-chat-menu-wrap ai-chat-permission-menu-wrap">
                <button
                  className="ai-chat-permission-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "sandbox"}
                  disabled={
                    !activeCatalog
                    || snapshot?.thread.status === "running"
                    || settingsSaving
                    || threadSettingsBlocked
                  }
                  onClick={() => setMenu((current) => current === "sandbox" ? null : "sandbox")}
                >
                  <SandboxIcon sandbox={draftSandbox} />
                  {text(...SANDBOX_LABELS[draftSandbox])}
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "sandbox" && (
                  <div
                    className="ai-chat-option-menu ai-chat-permission-menu"
                    role="menu"
                    aria-label={text("执行权限", "Execution permissions")}
                  >
                    <header>
                      <span>{text("应如何批准 Codex 操作？", "How should Codex operations be approved?")}</span>
                      <a
                        href="https://developers.openai.com/codex/security"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {text("了解更多", "Learn more")}
                      </a>
                    </header>
                    {availableSandboxes.map((sandbox) => (
                      <button
                        className={sandbox === "danger-full-access" ? "is-danger" : undefined}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sandbox === draftSandbox}
                        key={sandbox}
                        onClick={() => void chooseSandbox(sandbox)}
                      >
                        <SandboxIcon sandbox={sandbox} />
                        <span>
                          <strong>{text(...SANDBOX_LABELS[sandbox])}</strong>
                          <small>{text(...SANDBOX_DESCRIPTIONS[sandbox])}</small>
                        </span>
                        {sandbox === draftSandbox && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span className="ai-chat-toolbar-spacer" />
              <div className="ai-chat-menu-wrap ai-chat-model-menu-wrap">
                <button
                  className="ai-chat-model-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "model" || menu === "model-list" || menu === "effort-list"}
                  disabled={
                    !activeCatalog
                    || snapshot?.thread.status === "running"
                    || settingsSaving
                    || threadSettingsBlocked
                  }
                  onClick={() => setMenu((current) => (
                    current === "model" || current === "model-list" || current === "effort-list"
                      ? null
                      : "model"
                  ))}
                >
                  <span>{modelDisplayName(
                    selectedModel?.displayName ?? (draftModel || text("模型", "Model")),
                  )}</span>
                  <span className="ai-chat-model-effort">
                    {EFFORT_LABELS[draftEffort]
                      ? text(...EFFORT_LABELS[draftEffort])
                      : draftEffort || text("推理", "Reasoning")}
                  </span>
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "model" && (
                  <div
                    className="ai-chat-option-menu ai-chat-config-menu"
                    role="menu"
                    aria-label={text("模型与推理强度", "Model and reasoning effort")}
                  >
                    <button type="button" onClick={() => setMenu("model-list")}>
                      <span>{text("模型", "Model")}</span>
                      <strong>{modelDisplayName(selectedModel?.displayName ?? draftModel)}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                    <button type="button" onClick={() => setMenu("effort-list")}>
                      <span>{text("推理强度", "Reasoning effort")}</span>
                      <strong>{EFFORT_LABELS[draftEffort]
                        ? text(...EFFORT_LABELS[draftEffort])
                        : draftEffort}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                  </div>
                )}
                {menu === "model-list" && (
                  <div
                    className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu ai-chat-model-list"
                    role="menu"
                    aria-label={text("选择模型", "Select model")}
                  >
                    <header>
                      <button
                        type="button"
                        aria-label={text("返回模型与推理强度", "Back to model and reasoning effort")}
                        onClick={() => setMenu("model")}
                      >
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>{text("模型", "Model")}</strong>
                    </header>
                    {(activeCatalog?.models ?? []).map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.slug === draftModel}
                        key={model.slug}
                        onClick={() => void chooseModel(model)}
                      >
                        <span>
                          <strong>{modelDisplayName(model.displayName)}</strong>
                        </span>
                        {model.slug === draftModel && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
                {menu === "effort-list" && selectedModel && (
                  <div
                    className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu"
                    role="menu"
                    aria-label={text("选择推理强度", "Select reasoning effort")}
                  >
                    <header>
                      <button
                        type="button"
                        aria-label={text("返回模型与推理强度", "Back to model and reasoning effort")}
                        onClick={() => setMenu("model")}
                      >
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>{text("推理强度", "Reasoning effort")}</strong>
                    </header>
                    {selectedModel.supportedReasoningEfforts.map((effort) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={effort === draftEffort}
                        key={effort}
                        onClick={() => void chooseEffort(effort)}
                      >
                        <span>{EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort}</span>
                        {effort === draftEffort && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {primaryAction === "stop" ? (
                <button
                  className="ai-chat-send-button is-stop"
                  type="button"
                  aria-label={text("停止生成", "Stop generating")}
                  title={text("停止", "Stop")}
                  onClick={() => void stopRun(currentRun)}
                >
                  <span className="ai-chat-stop-mark" aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="ai-chat-send-button"
                  type="button"
                  aria-label={text("发送消息", "Send message")}
                  title={text("发送", "Send")}
                  disabled={
                    primaryAction === "disabled"
                    || loading
                    || settingsSaving
                    || Boolean(catalogError)
                  }
                  onClick={() => void startMessage(draft, false)}
                >
                  <SendIcon color="currentColor" />
                </button>
              )}
            </div>
          </div>

          {dangerConfirmOpen && (
            <div className="ai-chat-confirm-backdrop">
              <div className="ai-chat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ai-chat-confirm-title">
                <strong id="ai-chat-confirm-title">{text("允许完全访问？", "Allow full access?")}</strong>
                <p>{text(
                  "本次消息允许 Codex 访问工作区之外的文件和命令。确认只对本次发送生效。",
                  "This message lets Codex access files and commands outside the workspace. This approval applies only to this message.",
                )}</p>
                <div>
                  <button type="button" onClick={() => setPendingDangerInput(null)}>
                    {text("取消", "Cancel")}
                  </button>
                  <button
                    className="is-danger"
                    type="button"
                    onClick={() => {
                      if (!pendingDangerInput) return;
                      void startMessage(
                        pendingDangerInput.message,
                        true,
                        pendingDangerInput.skillIds,
                        pendingDangerInput.clearSubmittedDraft,
                        pendingDangerInput.attachments,
                        pendingDangerInput.composerDocument,
                        pendingDangerInput.composerRevision,
                      );
                    }}
                  >
                    {text("允许并发送", "Allow and send")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {!panelOpen && (
        <button
          type="button"
          className={`ai-chat-launcher is-${launcherState}`}
          aria-label={text("打开 AI 对话", "Open AI chat")}
          aria-expanded="false"
          title={text("AI 对话", "AI chat")}
          onClick={() => setPanelOpen(true)}
        >
          <TaskboardIcon name="aiLauncher" />
          {launcherState !== "idle" && <span className="ai-chat-launcher-state" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
