import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type KeyboardEventHandler,
} from "react";
import { createPortal } from "react-dom";
import MarkdownIt, { type StateInline } from "markdown-it";
import { exampleSetup } from "prosemirror-example-setup";
import { Fragment, Schema, Slice, type MarkType, type Node as ProseMirrorNode } from "prosemirror-model";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Plugin,
  type Selection,
} from "prosemirror-state";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { EditorView, type NodeView } from "prosemirror-view";
import { definitions } from "mdast-util-definitions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  Attachment,
  ComposerCandidate,
  ComposerCandidatesResponse,
  ComposerSurface,
  ComposerTrigger,
  Task,
} from "../types";
import {
  attachmentContentUrl,
  attachmentDownloadUrl,
  getAiChatComposerCandidates,
  resolvePersistedAttachmentUrl,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import { readIssueIdentifier } from "../issueRoute";
import { STATUS_DETAILS } from "./BoardColumn";
import { fileKey, MAX_ATTACHMENT_SIZE } from "./PendingAttachments";
import { LinearIcon } from "./LinearIcon";
import { MermaidDiagram } from "./MarkdownDocument";
import {
  ConversationIcon,
  ProjectIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  ComposerCompletionMenu,
  type ComposerCompletionGroup,
} from "./ComposerCompletionMenu";
import "./InlineMediaComposer.css";

interface InlineTextSegment {
  id: string;
  type: "text";
  text: string;
}

interface InlineImageSegment {
  id: string;
  type: "pending-image";
  token: string;
  file: File;
  dataUrl: string | null;
  dataUrlReady: Promise<void>;
}

interface PersistedImageSegment {
  id: string;
  type: "persisted-image";
  markdown: string;
  alt: string;
  url: string;
}

interface PendingAttachmentSegment {
  id: string;
  type: "pending-attachment";
  token: string;
  file: File;
}

interface PersistedAttachmentSegment {
  id: string;
  type: "persisted-attachment";
  markdown: string;
  attachmentId: string;
  contentType: string | null;
  size: number | null;
  filename: string;
  url: string;
}

interface IssueReferenceSegment {
  id: string;
  type: "issue-reference";
  markdown: string;
  identifier: string;
  projectId: string;
  taskId: string | null;
}

export interface InlineComposerReferenceSegment {
  id: string;
  type: "skill-reference" | "agent-reference";
  markdown: string;
  referenceKey: string;
  label: string;
}

export interface InlineUnsupportedComposerReferenceSegment {
  id: string;
  type: "unsupported-reference";
  markdown: string;
  referenceUri: string;
  label: string;
}

interface MarkdownAstNode {
  type: string;
  position: {
    start: { offset: number };
    end: { offset: number };
  };
  children?: MarkdownAstNode[];
  value?: string;
  alt?: string | null;
  identifier?: string;
  url?: string;
}

export type InlineMediaSegment =
  | InlineTextSegment
  | InlineImageSegment
  | PersistedImageSegment
  | PendingAttachmentSegment
  | PersistedAttachmentSegment
  | IssueReferenceSegment
  | InlineComposerReferenceSegment
  | InlineUnsupportedComposerReferenceSegment;
export type PendingInlineImage = InlineImageSegment;
export type PendingInlineAttachment = PendingAttachmentSegment;
type InlineMediaError = string | readonly [string, string];

export interface InlineMediaComposerHandle {
  focus: () => void;
  focusAtText: (text: string, offset: number, occurrence: number) => void;
  addFiles: (files: FileList | File[]) => void;
}

export interface InlineMediaCompletionContext {
  projectId?: string;
  threadId?: string;
  surface: Exclude<ComposerSurface, "ai-chat">;
}

export interface InlineMediaComposerProps {
  segments: InlineMediaSegment[];
  mentionTasks?: readonly Task[];
  referenceTasks: readonly Task[];
  completionContext?: InlineMediaCompletionContext;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  allowAttachments?: boolean;
  className?: string;
  onChange: (segments: InlineMediaSegment[]) => void;
  onError: (message: InlineMediaError | null) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

interface ComposerQuery {
  from: number;
  to: number;
  query: string;
  trigger: ComposerTrigger;
  anchor: HTMLElement;
  anchorRect: DOMRect;
}

type CompletionSelection =
  | { type: "candidate"; candidate: ComposerCandidate }
  | { type: "issue"; task: Task };

function completionSelectionId(selection: CompletionSelection): string {
  return selection.type === "candidate"
    ? `candidate:${selection.candidate.kind}:${selection.candidate.candidateRef}`
    : `issue:${selection.task.id}`;
}

let segmentSequence = 0;
const inlineMediaMarkdownParser = unified().use(remarkParse).use(remarkGfm);
const EMPTY_MENTION_TASKS: readonly Task[] = [];
const INLINE_MEDIA_HTML_BLOCKS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "UL",
]);

function segmentId(prefix: string): string {
  segmentSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
}

function textSegment(text = ""): InlineTextSegment {
  return { id: segmentId("text"), type: "text", text };
}

function imageSegment(file: File, dataUrl: string | null = null): InlineImageSegment {
  const id = segmentId("image");
  const segment: InlineImageSegment = {
    id,
    type: "pending-image",
    token: `<!--taskboard-inline-image:${id}-->`,
    file,
    dataUrl,
    dataUrlReady: Promise.resolve(),
  };
  if (!dataUrl) {
    const reader = new FileReader();
    segment.dataUrlReady = new Promise((resolve, reject) => {
      reader.addEventListener("load", () => {
        segment.dataUrl = reader.result as string;
        resolve();
      });
      reader.addEventListener("error", () => reject(reader.error));
    });
    reader.readAsDataURL(file);
  }
  return segment;
}

function attachmentSegment(file: File): PendingAttachmentSegment {
  const id = segmentId("attachment");
  return {
    id,
    type: "pending-attachment",
    token: `<!--taskboard-inline-attachment:${id}-->`,
    file,
  };
}

const COMPOSER_REFERENCE_URL = /^taskboard:\/\/composer-reference\/v1\/(skill|agent)\/([A-Za-z0-9_-]+)$/;
const COMPOSER_REFERENCE_NAMESPACE_URL = /^taskboard:\/\/composer-reference\/([^/]+)\/([^/]+)\/([A-Za-z0-9_-]+)$/;
const PENDING_IMAGE_COMPOSER_REFERENCE_URL = /^taskboard:\/\/composer-reference\/v1\/pending-image\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function encodedComposerReferenceKey(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodedComposerReferenceKey(value: string): string | null {
  if (!value || value.length % 4 === 1) return null;
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded && encodedComposerReferenceKey(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function base64UrlReferenceKey(
  value: string,
  requireNfc: boolean,
): string | null {
  const decoded = decodedComposerReferenceKey(value);
  return decoded && (!requireNfc || decoded === decoded.normalize("NFC")) ? value : null;
}

function pendingImageComposerReference(
  url: string,
  name: string,
): { file: File; dataUrl: string } | null {
  const match = PENDING_IMAGE_COMPOSER_REFERENCE_URL.exec(url);
  const type = match ? decodedComposerReferenceKey(match[1]) : null;
  if (!match || !type?.startsWith("image/")) return null;
  try {
    const base64 = `${match[2].replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - match[2].length % 4) % 4)}`;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return {
      file: new File([bytes], name || "image", { type }),
      dataUrl: `data:${type};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

function markdownNodeText(node: MarkdownAstNode): string | null {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return null;
  let result = "";
  for (const child of node.children) {
    const text = markdownNodeText(child);
    if (text === null) return null;
    result += text;
  }
  return result;
}

function composerReferenceFromNode(
  node: MarkdownAstNode,
  source: string,
): (
  | Omit<InlineComposerReferenceSegment, "id">
  | Omit<InlineUnsupportedComposerReferenceSegment, "id">
) & { start: number; end: number } | null {
  if (node.type !== "link" || !node.url) return null;
  const namespaceMatch = COMPOSER_REFERENCE_NAMESPACE_URL.exec(node.url);
  if (!namespaceMatch || !base64UrlReferenceKey(namespaceMatch[3], namespaceMatch[2] === "skill")) return null;
  const label = markdownNodeText(node);
  const markdown = source.slice(node.position.start.offset, node.position.end.offset);
  if (
    !label
    || !markdown.startsWith("[")
    || !markdown.endsWith(`](${node.url})`)
  ) return null;
  const urlMatch = COMPOSER_REFERENCE_URL.exec(node.url);
  if (!urlMatch) {
    return {
      type: "unsupported-reference",
      start: node.position.start.offset,
      end: node.position.end.offset,
      markdown,
      referenceUri: node.url,
      label,
    };
  }
  const kind = urlMatch[1] as "skill" | "agent";
  const referenceKey = base64UrlReferenceKey(urlMatch[2], kind === "skill")!;
  return {
    type: `${kind}-reference`,
    start: node.position.start.offset,
    end: node.position.end.offset,
    markdown,
    referenceKey,
    label,
  };
}

export function createInlineMediaSegments(
  text = "",
  referenceTasks: readonly Task[] = EMPTY_MENTION_TASKS,
  attachments: readonly Attachment[] = [],
): InlineMediaSegment[] {
  const segments: InlineMediaSegment[] = [];
  const items: Array<
    | {
        type: "persisted-image";
        start: number;
        end: number;
        alt: string;
        url: string;
        markdown?: string;
      }
    | {
        type: "persisted-attachment";
        start: number;
        end: number;
        attachmentId: string;
        contentType: string | null;
        size: number | null;
        filename: string;
        url: string;
      }
    | {
        type: "issue-reference";
        start: number;
        end: number;
        identifier: string;
        projectId: string;
        taskId: string | null;
      }
    | {
        type: "pending-image";
        start: number;
        end: number;
        file: File;
        dataUrl: string;
      }
    | (Omit<InlineComposerReferenceSegment, "id"> & { start: number; end: number })
    | (Omit<InlineUnsupportedComposerReferenceSegment, "id"> & { start: number; end: number })
  > = [];
  const root = inlineMediaMarkdownParser.parse(text);
  const getDefinition = definitions(root);
  const nodes = [root as MarkdownAstNode];

  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (node.type === "image") {
      const alt = node.alt ?? "";
      const pendingImage = pendingImageComposerReference(node.url!, alt);
      if (pendingImage) {
        items.push({
          type: "pending-image",
          start: node.position.start.offset,
          end: node.position.end.offset,
          ...pendingImage,
        });
      } else {
        items.push({
          type: "persisted-image",
          start: node.position.start.offset,
          end: node.position.end.offset,
          alt,
          url: node.url!,
        });
      }
    }
    if (node.type === "imageReference") {
      const definition = getDefinition(node.identifier);
      if (definition) {
        items.push({
          type: "persisted-image",
          start: node.position.start.offset,
          end: node.position.end.offset,
          alt: node.alt ?? "",
          url: definition.url,
        });
      }
    }
    let handledAttachment = false;
    let handledIssueReference = false;
    if (node.type === "link" && node.url) {
      const attachmentMatch = node.url.match(/^\/?api\/attachments\/([^/?#]+)\/download$/);
      if (attachmentMatch) {
        const filename = markdownNodeText(node);
        if (filename) {
          const attachment = attachments.find((candidate) => (
            encodeURIComponent(candidate.id) === attachmentMatch[1]
          ));
          items.push({
            type: "persisted-attachment",
            start: node.position.start.offset,
            end: node.position.end.offset,
            attachmentId: attachmentMatch[1],
            contentType: attachment?.contentType ?? null,
            size: attachment?.size ?? null,
            filename,
            url: node.url,
          });
          handledAttachment = true;
        }
      }
      const projectId = node.url.startsWith("?")
        ? new URLSearchParams(node.url).get("project")
        : null;
      const identifier = node.url.startsWith("?") ? readIssueIdentifier(node.url) : null;
      const task = projectId && identifier
        ? referenceTasks.find((candidate) => (
            candidate.projectId === projectId && candidate.identifier === identifier
          ))
        : null;
      if (projectId && identifier) {
        items.push({
          type: "issue-reference",
          start: node.position.start.offset,
          end: node.position.end.offset,
          identifier: task?.externalKey ?? identifier,
          projectId,
          taskId: task?.id ?? null,
        });
        handledIssueReference = true;
      }
    }
    const composerReference = handledAttachment || handledIssueReference
      ? null
      : composerReferenceFromNode(node, text);
    if (composerReference) items.push(composerReference);
    if (node.children) nodes.push(...node.children);
  }

  items.sort((a, b) => a.start - b.start);
  let offset = 0;

  for (const item of items) {
    if (item.start > offset) segments.push(textSegment(text.slice(offset, item.start)));
    if (item.type === "pending-image") {
      segments.push(imageSegment(item.file, item.dataUrl));
    } else if (item.type === "persisted-image") {
      segments.push({
        id: segmentId("image"),
        type: "persisted-image",
        markdown: item.markdown ?? text.slice(item.start, item.end),
        alt: item.alt,
        url: item.url,
      });
    } else if (item.type === "persisted-attachment") {
      segments.push({
        id: segmentId("attachment"),
        type: "persisted-attachment",
        markdown: text.slice(item.start, item.end),
        attachmentId: item.attachmentId,
        contentType: item.contentType,
        size: item.size,
        filename: item.filename,
        url: item.url,
      });
    } else if (item.type === "issue-reference") {
      segments.push({
        id: segmentId("issue"),
        type: "issue-reference",
        markdown: text.slice(item.start, item.end),
        identifier: item.identifier,
        projectId: item.projectId,
        taskId: item.taskId,
      });
    } else if (item.type === "unsupported-reference") {
      segments.push({
        id: segmentId("unsupported"),
        type: item.type,
        markdown: item.markdown,
        label: item.label,
        referenceUri: item.referenceUri,
      });
    } else {
      segments.push({
        id: segmentId(item.type === "skill-reference" ? "skill" : "agent"),
        type: item.type,
        markdown: item.markdown,
        label: item.label,
        referenceKey: item.referenceKey,
      });
    }
    offset = item.end;
  }

  if (offset < text.length) segments.push(textSegment(text.slice(offset)));
  const normalized = normalizeSegments(segments);
  return normalized.map((segment, index) => {
    if (segment.type !== "text") return segment;
    const previousIsMedia = isTaskboardAttachmentMedia(normalized[index - 1]);
    const nextIsMedia = isTaskboardAttachmentMedia(normalized[index + 1]);
    let value = segment.text;
    if (previousIsMedia && nextIsMedia && /^\n+$/.test(value)) {
      value = value.slice(1);
    } else {
      if (previousIsMedia && value.startsWith("\n")) value = value.slice(1);
      if (nextIsMedia && value.endsWith("\n")) value = value.slice(0, -1);
    }
    return value === segment.text ? segment : { ...segment, text: value };
  });
}

export function inlineMediaImages(segments: InlineMediaSegment[]): PendingInlineImage[] {
  return segments.filter((segment): segment is PendingInlineImage => segment.type === "pending-image");
}

export function inlineMediaFiles(segments: InlineMediaSegment[]): PendingInlineAttachment[] {
  return segments.filter((segment): segment is PendingInlineAttachment => (
    segment.type === "pending-attachment"
  ));
}

export function inlineMediaComposerReferences(
  segments: InlineMediaSegment[],
): Array<InlineComposerReferenceSegment | InlineUnsupportedComposerReferenceSegment> {
  return segments.filter((segment): segment is (
    InlineComposerReferenceSegment | InlineUnsupportedComposerReferenceSegment
  ) => (
    segment.type === "skill-reference"
    || segment.type === "agent-reference"
    || segment.type === "unsupported-reference"
  ));
}

export function inlineMediaText(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "pending-image" || segment.type === "pending-attachment") return "";
    return segment.markdown;
  }).join("");
}

function isTaskboardAttachmentMedia(segment: InlineMediaSegment | undefined): boolean {
  return segment?.type === "pending-image"
    || segment?.type === "pending-attachment"
    || segment?.type === "persisted-attachment"
    || (
    segment?.type === "persisted-image"
    && /^\/?api\/attachments\/[^/?#]+\/content$/.test(segment.url)
  );
}

function serializeInlineMediaSegments(
  segments: InlineMediaSegment[],
  segmentValue: (segment: InlineMediaSegment) => string,
): string {
  let markdown = "";
  let previousWasMedia = false;
  let sharedMediaBoundary = false;
  segments.forEach((segment, index) => {
    const value = segmentValue(segment);
    if (
      segment.type === "text"
      && isTaskboardAttachmentMedia(segments[index - 1])
      && isTaskboardAttachmentMedia(segments[index + 1])
      && /^\n*$/.test(value)
    ) {
      markdown += `\n${value}`;
      previousWasMedia = false;
      sharedMediaBoundary = true;
      return;
    }
    if (!value) return;
    const isMedia = isTaskboardAttachmentMedia(segment);
    if (isMedia) {
      if (markdown && !sharedMediaBoundary) markdown += "\n";
      markdown += value;
      previousWasMedia = true;
      sharedMediaBoundary = false;
      return;
    }
    if (previousWasMedia) markdown += "\n";
    markdown += value;
    previousWasMedia = false;
    sharedMediaBoundary = false;
  });
  return markdown;
}

export function serializeInlineMedia(segments: InlineMediaSegment[]): string {
  return serializeInlineMediaSegments(segments, (segment) => (
    segment.type === "text"
      ? segment.text
      : segment.type === "pending-image"
        ? segment.token
        : segment.type === "pending-attachment"
          ? segment.token
        : segment.markdown
  ));
}

export function resolveInlineMediaMarkdown(
  value: string,
  images: PendingInlineImage[],
  attachments: Array<{ id: string }>,
): string {
  return images.reduce((markdown, image, index) => {
    const attachment = attachments[index];
    if (!attachment) return markdown;
    const alt = image.file.name.replace(/[\\[\]]/g, "\\$&");
    return markdown.replace(
      image.token,
      `![${alt}](${attachmentContentUrl(attachment)})`,
    );
  }, value);
}

export function resolveInlineAttachmentMarkdown(
  value: string,
  files: PendingInlineAttachment[],
  attachments: Attachment[],
): string {
  return files.reduce((markdown, file, index) => {
    const attachment = attachments[index];
    if (!attachment) return markdown;
    const filename = file.file.name.replace(/[\\[\]]/g, "\\$&");
    return markdown.replace(
      file.token,
      `[${filename}](${attachmentDownloadUrl(attachment)})`,
    );
  }, value);
}

function normalizeSegments(segments: InlineMediaSegment[]): InlineMediaSegment[] {
  const normalized: InlineMediaSegment[] = [];
  for (const segment of segments) {
    const previous = normalized.at(-1);
    if (
      (isInlineReference(segment) && previous?.type !== "text")
      || (previous && isInlineReference(previous) && segment.type !== "text")
    ) {
      normalized.push(textSegment());
    }
    const adjacent = normalized.at(-1);
    if (segment.type === "text" && adjacent?.type === "text") {
      normalized[normalized.length - 1] = {
        ...adjacent,
        text: adjacent.text + segment.text,
      };
    } else {
      normalized.push(segment);
    }
  }
  if (normalized.length === 0) return [textSegment()];
  if (normalized[0].type !== "text") normalized.unshift(textSegment());
  if (normalized.at(-1)?.type !== "text") normalized.push(textSegment());
  return normalized;
}

function isInlineReference(
  segment: InlineMediaSegment,
): segment is IssueReferenceSegment | InlineComposerReferenceSegment | InlineUnsupportedComposerReferenceSegment {
  return segment.type === "issue-reference"
    || segment.type === "skill-reference"
    || segment.type === "agent-reference"
    || segment.type === "unsupported-reference";
}

function inlineMediaClipboardText(segments: InlineMediaSegment[]): string {
  return serializeInlineMediaSegments(segments, (segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "pending-image") {
      return pendingImageClipboardMarkdown(segment) ?? segment.file.name;
    }
    if (segment.type === "pending-attachment") return segment.file.name;
    return segment.markdown;
  });
}

function pendingImageClipboardMarkdown(segment: InlineImageSegment): string | null {
  const match = segment.dataUrl?.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const typeKey = encodedComposerReferenceKey(match[1]);
  const dataKey = match[2].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const alt = segment.file.name.replace(/[\\[\]]/g, "\\$&");
  return `![${alt}](taskboard://composer-reference/v1/pending-image/${typeKey}.${dataKey})`;
}

function selfContainedClipboardSegments(
  segments: InlineMediaSegment[],
): InlineMediaSegment[] {
  return segments.map((segment) => {
    if (
      segment.type !== "persisted-image"
      || /^!\[(?:\\.|[^\]])*\]\(/.test(segment.markdown)
    ) return segment;
    const alt = segment.alt.replace(/[\\[\]]/g, "\\$&");
    return { ...segment, markdown: `![${alt}](${segment.url})` };
  });
}

export function writeInlineMediaClipboard(
  clipboardData: DataTransfer,
  segments: InlineMediaSegment[],
) {
  clipboardData.setData(
    "text/plain",
    inlineMediaClipboardText(selfContainedClipboardSegments(segments)),
  );
}

export function createInlineMediaSegmentsFromHtml(
  html: string,
  referenceTasks: readonly Task[],
): InlineMediaSegment[] | null {
  if (!html) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  let markdown = "";
  let structured = false;

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      markdown += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (["SCRIPT", "STYLE"].includes(element.tagName)) return;

    const inlineMarkdown = element.dataset.taskboardInlineMediaMarkdown;
    if (inlineMarkdown) {
      markdown += inlineMarkdown;
      structured = true;
      return;
    }
    if (element.tagName === "BUTTON") return;
    if (element.tagName === "A") {
      const href = element.getAttribute("href") ?? "";
      try {
        const base = new URL(window.document.baseURI);
        base.search = "";
        base.hash = "";
        const url = new URL(href, base);
        if (url.origin === base.origin && url.pathname === base.pathname) {
          const identifier = readIssueIdentifier(url.search);
          const projectId = url.searchParams.get("project");
          if (identifier && projectId) {
            const task = referenceTasks.find((candidate) => (
              candidate.projectId === projectId && candidate.identifier === identifier
            ));
            const displayIdentifier = task?.externalKey ?? identifier;
            const route = new URLSearchParams({ project: projectId, issue: identifier });
            markdown += `[@${displayIdentifier}](?${route})`;
            structured = true;
            return;
          }
        }
      } catch {}
    }
    if (element.tagName === "IMG") {
      const source = element.getAttribute("src");
      if (source) {
        let url = source;
        try {
          const parsed = new URL(source);
          const attachment = parsed.pathname.match(/\/api\/attachments\/([^/]+)\/content$/);
          if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && attachment) {
            url = `api/attachments/${attachment[1]}/content`;
          }
        } catch {}
        const alt = (element.getAttribute("alt") ?? "").replace(/[\\[\]]/g, "\\$&");
        markdown += `![${alt}](${url})`;
        structured = true;
      }
      return;
    }
    if (element.tagName === "BR") {
      markdown += "\n";
      return;
    }

    const block = INLINE_MEDIA_HTML_BLOCKS.has(element.tagName);
    if (block && markdown && !markdown.endsWith("\n")) markdown += "\n";
    for (const child of element.childNodes) visit(child);
    if (block && element.nextSibling && !markdown.endsWith("\n")) markdown += "\n";
  };

  for (const child of document.body.childNodes) visit(child);
  return structured ? createInlineMediaSegments(markdown, referenceTasks) : null;
}

function PendingImageBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PendingInlineImage;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const { text } = useTaskboardI18n();

  useLayoutEffect(() => {
    const url = URL.createObjectURL(segment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [segment.file]);

  return (
    <figure
      className="inline-media-image"
      contentEditable={false}
      data-inline-media-segment={segment.id}
    >
      {previewUrl && <img src={previewUrl} alt={segment.file.name} draggable={false} />}
      <button
        type="button"
        disabled={disabled}
        aria-label={text(`移除 ${segment.file.name}`, `Remove ${segment.file.name}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
}

function PersistedImageBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PersistedImageSegment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useTaskboardI18n();

  return (
    <figure
      className="inline-media-image"
      contentEditable={false}
      data-inline-media-segment={segment.id}
    >
      <img src={resolvePersistedAttachmentUrl(segment.url)} alt={segment.alt} draggable={false} />
      <button
        type="button"
        disabled={disabled}
        aria-label={text(`移除 ${segment.alt || "图片"}`, `Remove ${segment.alt || "image"}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
}

function PendingVideoBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PendingAttachmentSegment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const { text } = useTaskboardI18n();

  useLayoutEffect(() => {
    const url = URL.createObjectURL(segment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [segment.file]);

  return (
    <figure
      className="inline-media-image inline-media-video"
      contentEditable={false}
      data-inline-media-segment={segment.id}
    >
      {previewUrl && <video src={previewUrl} aria-label={segment.file.name} controls />}
      <button
        type="button"
        disabled={disabled}
        aria-label={text(`移除 ${segment.file.name}`, `Remove ${segment.file.name}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
}

function PersistedVideoBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PersistedAttachmentSegment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useTaskboardI18n();

  return (
    <figure
      className="inline-media-image inline-media-video"
      contentEditable={false}
      data-inline-media-segment={segment.id}
    >
      <video
        src={attachmentContentUrl({ id: segment.attachmentId })}
        aria-label={segment.filename}
        controls
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={text(`移除 ${segment.filename}`, `Remove ${segment.filename}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
}

function AttachmentBlock({
  segment,
  disabled,
  onRemove,
}: {
  segment: PendingAttachmentSegment | PersistedAttachmentSegment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useTaskboardI18n();
  const filename = segment.type === "pending-attachment" ? segment.file.name : segment.filename;
  const size = segment.type === "pending-attachment" ? segment.file.size : segment.size;

  return (
    <span
      className="inline-media-attachment"
      contentEditable={false}
      data-inline-media-segment={segment.id}
    >
      <span className="attachment-file-icon" aria-hidden="true">
        <LinearIcon name="file" />
      </span>
      <span className="attachment-copy composer-attachment-copy">
        <strong>{filename}</strong>
        {size !== null && <span>{fileSize(size)}</span>}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-label={text(`移除 ${filename}`, `Remove ${filename}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </span>
  );
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function IssueReferenceChip({
  segment,
  task,
  disabled,
  onRemove,
}: {
  segment: IssueReferenceSegment;
  task: Task | null;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useTaskboardI18n();
  const displayIdentifier = task?.externalKey ?? segment.identifier;

  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={`issue-reference-inline inline-media-issue-reference${task ? ` issue-reference-status-${task.status}` : ""}`}
      contentEditable={false}
      data-inline-media-segment={segment.id}
      data-taskboard-inline-media-markdown={segment.markdown}
      aria-disabled={disabled}
      aria-label={task
        ? text(
            `${displayIdentifier} ${task.title}，按退格键或删除键移除`,
            `${displayIdentifier} ${task.title}, press Backspace or Delete to remove`,
          )
        : text(
            `${displayIdentifier}，按退格键或删除键移除`,
            `${displayIdentifier}, press Backspace or Delete to remove`,
          )}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.defaultPrevented) return;
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        event.preventDefault();
        onRemove();
      }}
    >
      <span className="issue-reference-identity">
        {task && (
          <span className={`status-icon issue-reference-status status-icon-${STATUS_DETAILS[task.status].tone}`}>
            <StatusIcon status={task.status} color="var(--column-status-color)" size={15} />
          </span>
        )}
        <span className="issue-reference-id">{displayIdentifier}</span>
      </span>
      {task && <span className="issue-reference-title">{task.title}</span>}
    </span>
  );
}

function ComposerReferenceChip({
  segment,
  disabled,
  onRemove,
}: {
  segment: InlineComposerReferenceSegment | InlineUnsupportedComposerReferenceSegment;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useTaskboardI18n();
  const kind = segment.type === "skill-reference"
    ? text("Skill", "Skill")
    : segment.type === "agent-reference"
      ? text("Agent", "Agent")
      : text("不支持的引用", "Unsupported reference");

  return (
    <button
      type="button"
      className={`inline-media-composer-reference is-${segment.type}`}
      contentEditable={false}
      data-inline-media-segment={segment.id}
      data-taskboard-inline-media-markdown={segment.markdown}
      disabled={disabled}
      aria-label={text(
        `${kind} ${segment.label}，按退格键或删除键移除`,
        `${kind} ${segment.label}, press Backspace or Delete to remove`,
      )}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        event.preventDefault();
        onRemove();
      }}
    >
      {segment.type === "skill-reference"
        ? <ProjectIcon color="currentColor" />
        : <ConversationIcon color="currentColor" />}
      <span>{segment.label}</span>
    </button>
  );
}

const INLINE_MEDIA_NODE = "taskboard_inline_media";
const INLINE_REFERENCE_NODE = "taskboard_inline_reference";
const INLINE_MEDIA_PLACEHOLDER_PREFIX = "https://taskboard.invalid/inline-media/";

const markdownMarks = defaultMarkdownParser.schema.spec.marks.append({
  strike: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { style: "text-decoration=line-through" },
    ],
    toDOM() {
      return ["s", 0];
    },
  },
});

const composerMarks = ["strong", "em", "code", "link", "strike"].reduce(
  (marks, name) => {
    const spec = marks.get(name);
    return spec ? marks.update(name, { ...spec, inclusive: false }) : marks;
  },
  markdownMarks,
);

const markdownNodes = defaultMarkdownParser.schema.spec.nodes;
const composerNodes = markdownNodes.update("heading", {
  ...markdownNodes.get("heading")!,
  content: "inline*",
}).append({
  table: {
    group: "block",
    content: "table_row+",
    parseDOM: [{ tag: "table" }],
    toDOM() {
      return ["table", ["tbody", 0]];
    },
  },
  table_row: {
    content: "(table_header | table_cell)+",
    parseDOM: [{ tag: "tr" }],
    toDOM() {
      return ["tr", 0];
    },
  },
  table_header: {
    attrs: { align: { default: null } },
    content: "inline*",
    parseDOM: [{
      tag: "th",
      getAttrs(dom) {
        return { align: dom instanceof HTMLElement ? dom.style.textAlign || null : null };
      },
    }],
    toDOM(node) {
      return ["th", node.attrs.align ? { style: `text-align:${node.attrs.align}` } : {}, 0];
    },
  },
  table_cell: {
    attrs: { align: { default: null } },
    content: "inline*",
    parseDOM: [{
      tag: "td",
      getAttrs(dom) {
        return { align: dom instanceof HTMLElement ? dom.style.textAlign || null : null };
      },
    }],
    toDOM(node) {
      return ["td", node.attrs.align ? { style: `text-align:${node.attrs.align}` } : {}, 0];
    },
  },
  [INLINE_MEDIA_NODE]: {
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    attrs: { segmentId: {} },
    toDOM(node) {
      return ["div", {
        "data-taskboard-editor-media": String(node.attrs.segmentId),
      }];
    },
    parseDOM: [{
      tag: "div[data-taskboard-editor-media]",
      getAttrs(dom) {
        if (!(dom instanceof HTMLElement)) return false;
        const segmentIdValue = dom.dataset.taskboardEditorMedia;
        return segmentIdValue ? { segmentId: segmentIdValue } : false;
      },
    }],
  },
  [INLINE_REFERENCE_NODE]: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    draggable: true,
    attrs: { segmentId: {} },
    toDOM(node) {
      return ["span", {
        "data-taskboard-editor-reference": String(node.attrs.segmentId),
      }];
    },
    parseDOM: [{
      tag: "span[data-taskboard-editor-reference]",
      getAttrs(dom) {
        if (!(dom instanceof HTMLElement)) return false;
        const segmentIdValue = dom.dataset.taskboardEditorReference;
        return segmentIdValue ? { segmentId: segmentIdValue } : false;
      },
    }],
  },
});

const composerSchema = new Schema({
  nodes: composerNodes,
  marks: composerMarks,
});

function inlineMediaPlaceholderMarkdown(segmentIdValue: string): string {
  return `![taskboard atom](${INLINE_MEDIA_PLACEHOLDER_PREFIX}${encodeURIComponent(segmentIdValue)})`;
}

function inlineMediaPlaceholderId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(INLINE_MEDIA_PLACEHOLDER_PREFIX)) return null;
  const encoded = value.slice(INLINE_MEDIA_PLACEHOLDER_PREFIX.length);
  if (!encoded || encoded.includes("/") || encoded.includes("?") || encoded.includes("#")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function isAtomSegment(segment: InlineMediaSegment): boolean {
  return segment.type !== "text";
}

function isMediaAtomSegment(segment: InlineMediaSegment | undefined): boolean {
  return segment?.type === "pending-image"
    || segment?.type === "persisted-image"
    || segment?.type === "pending-attachment"
    || segment?.type === "persisted-attachment";
}

function atomHostClass(segment: InlineMediaSegment | undefined): string {
  if (!segment || segment.type === "text") return "inline-media-atom";
  if (isInlineReference(segment)) return "inline-media-atom";
  if (segment.type === "pending-attachment" || segment.type === "persisted-attachment") {
    if (
      (segment.type === "pending-attachment" && segment.file.type.startsWith("video/"))
      || (segment.type === "persisted-attachment" && segment.contentType?.startsWith("video/"))
    ) return "inline-media-atom inline-media-attachment-atom inline-media-video-atom";
    return "inline-media-atom inline-media-attachment-atom";
  }
  return "inline-media-atom inline-media-image-atom";
}

function populateAtomSegments(
  target: Map<string, InlineMediaSegment>,
  segments: readonly InlineMediaSegment[],
  clear = false,
): void {
  if (clear) target.clear();
  for (const segment of segments) {
    if (isAtomSegment(segment)) target.set(segment.id, segment);
  }
}

function markdownBlockBoundary(left: string, right: string): string {
  if (!left || !right) return `${left}${right}`;
  const trailing = left.match(/\n*$/)?.[0].length ?? 0;
  const leading = right.match(/^\n*/)?.[0].length ?? 0;
  return `${left}${"\n".repeat(Math.max(0, 2 - trailing - leading))}${right}`;
}

function editorMarkdownFromSegments(segments: readonly InlineMediaSegment[]): string {
  let markdown = "";
  let previousWasMedia = false;
  for (const segment of segments) {
    const value = segment.type === "text"
      ? segment.text
      : inlineMediaPlaceholderMarkdown(segment.id);
    if (!value) continue;
    if (isMediaAtomSegment(segment)) {
      markdown = markdownBlockBoundary(markdown, value);
      previousWasMedia = true;
      continue;
    }
    markdown = previousWasMedia ? markdownBlockBoundary(markdown, value) : markdown + value;
    previousWasMedia = false;
  }
  return markdown;
}

function editorAtomNode(segment: InlineMediaSegment): ProseMirrorNode {
  const nodeType = isMediaAtomSegment(segment)
    ? composerSchema.nodes[INLINE_MEDIA_NODE]
    : composerSchema.nodes[INLINE_REFERENCE_NODE];
  return nodeType.create({ segmentId: segment.id });
}

function editorNodesWithAtoms(
  node: ProseMirrorNode,
  atomSegments: ReadonlyMap<string, InlineMediaSegment>,
): ProseMirrorNode[] {
  if (node.isTextblock) {
    const blocks: ProseMirrorNode[] = [];
    let inline: ProseMirrorNode[] = [];
    const flushInline = () => {
      if (inline.length === 0) return;
      blocks.push(node.copy(Fragment.fromArray(inline)));
      inline = [];
    };

    node.forEach((child) => {
      if (child.type.name === "image") {
        const segmentIdValue = inlineMediaPlaceholderId(child.attrs.src);
        const segment = segmentIdValue ? atomSegments.get(segmentIdValue) : undefined;
        if (segment) {
          const atom = editorAtomNode(segment);
          if (isMediaAtomSegment(segment)) {
            flushInline();
            blocks.push(atom);
          } else {
            inline.push(atom);
          }
          return;
        }
      }
      inline.push(child);
    });
    flushInline();
    return blocks.length > 0 ? blocks : [node.copy(Fragment.empty)];
  }
  if (node.isLeaf) return [node];

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(...editorNodesWithAtoms(child, atomSegments)));
  if (node.type.name === "list_item" && children[0]?.type.name !== "paragraph") {
    children.unshift(composerSchema.nodes.paragraph.create());
  }
  return [node.copy(Fragment.fromArray(children))];
}

const composerMarkdownTokenizer = new MarkdownIt("commonmark", { html: false })
  .enable(["table", "strikethrough"]);
const singleTildeDelimiterMarker = -0x7e;

composerMarkdownTokenizer.inline.ruler.before(
  "strikethrough",
  "single_tilde_strikethrough",
  (state: StateInline, silent: boolean) => {
    const scanned = state.src.charCodeAt(state.pos) === 0x7e
      ? state.scanDelims(state.pos, true)
      : null;
    if (!scanned || scanned.length !== 1 || silent) return false;

    const token = state.push("text", "", 0);
    token.content = "~";
    state.delimiters.push({
      marker: singleTildeDelimiterMarker,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
    state.pos += 1;
    return true;
  },
);

composerMarkdownTokenizer.inline.ruler2.before(
  "strikethrough",
  "restore_single_tilde_marker",
  (state: StateInline) => {
    for (const delimiter of state.delimiters) {
      if (delimiter.marker === singleTildeDelimiterMarker) delimiter.marker = 0x7e;
    }
    for (const tokenMeta of state.tokens_meta) {
      for (const delimiter of tokenMeta?.delimiters ?? []) {
        if (delimiter.marker === singleTildeDelimiterMarker) delimiter.marker = 0x7e;
      }
    }
    return true;
  },
);

const composerMarkdownParser = new MarkdownParser(
  composerSchema,
  composerMarkdownTokenizer,
  {
    ...defaultMarkdownParser.tokens,
    s: { mark: "strike" },
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "table_row" },
    th: {
      block: "table_header",
      getAttrs(token) {
        const align = /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "")?.[1];
        return { align: align ?? null };
      },
    },
    td: {
      block: "table_cell",
      getAttrs(token) {
        const align = /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "")?.[1];
        return { align: align ?? null };
      },
    },
    softbreak: { node: "hard_break" },
  },
);

function editorDocumentFromSegments(segments: readonly InlineMediaSegment[]): ProseMirrorNode {
  const atoms = new Map<string, InlineMediaSegment>();
  populateAtomSegments(atoms, segments);
  const parsed = composerMarkdownParser.parse(editorMarkdownFromSegments(segments));
  const documentNode = editorNodesWithAtoms(parsed, atoms)[0];
  if (documentNode.lastChild?.type === composerSchema.nodes.paragraph) return documentNode;
  return documentNode.copy(documentNode.content.append(Fragment.from(
    composerSchema.nodes.paragraph.create(),
  )));
}

function markInputRule(
  expression: RegExp,
  markType: MarkType,
  getAttrs?: (match: RegExpMatchArray) => Record<string, unknown>,
): InputRule {
  return new InputRule(expression, (state, match, start, end) => {
    const value = match[1];
    if (!value) return null;
    const attrs = getAttrs?.(match);
    return state.tr
      .replaceWith(start, end, state.schema.text(value, [markType.create(attrs)]))
      .setStoredMarks([]);
  });
}

function composerPlugins(): Plugin[] {
  const rules: InputRule[] = [
    wrappingInputRule(/^\s*>\s$/, composerSchema.nodes.blockquote),
    wrappingInputRule(
      /^(\d+)\.\s$/,
      composerSchema.nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1]),
    ),
    wrappingInputRule(/^\s*([-+*])\s$/, composerSchema.nodes.bullet_list),
    textblockTypeInputRule(/^```$/, composerSchema.nodes.code_block),
    textblockTypeInputRule(/^(#{1,6})\s$/, composerSchema.nodes.heading, (match) => ({
      level: match[1].length,
    })),
    markInputRule(/\*\*([^*\n]+)\*\*$/, composerSchema.marks.strong),
    markInputRule(/__([^_\n]+)__$/, composerSchema.marks.strong),
    markInputRule(/`([^`\n]+)`$/, composerSchema.marks.code),
    markInputRule(/(?<!\*)\*([^*\n]+)\*$/, composerSchema.marks.em),
    markInputRule(/(?<!_)_([^_\n]+)_$/, composerSchema.marks.em),
    markInputRule(/~~([^~\n]+)~~$/, composerSchema.marks.strike),
    markInputRule(/(?<!~)~([^~\n]+)~$/, composerSchema.marks.strike),
    markInputRule(/\[([^\]\n]+)\]\(([^)\s]+)\)$/, composerSchema.marks.link, (match) => ({
      href: match[2],
      title: null,
    })),
  ];
  const [, ...setupPlugins] = exampleSetup({ schema: composerSchema, menuBar: false });
  return [inputRules({ rules }), ...setupPlugins];
}

function handleIndentKey(view: EditorView, event: globalThis.KeyboardEvent): boolean {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return false;
  event.preventDefault();

  const listCommand = event.shiftKey
    ? liftListItem(composerSchema.nodes.list_item)
    : sinkListItem(composerSchema.nodes.list_item);
  if (listCommand(view.state, (transaction) => view.dispatch(transaction), view)) return true;

  const { $from } = view.state.selection;
  if (!$from.parent.isTextblock) return true;
  const blockStart = $from.start();
  const indentation = /^[\u00a0 ]{1,2}/.exec($from.parent.textContent)?.[0];
  if (event.shiftKey) {
    if (indentation) view.dispatch(view.state.tr.delete(blockStart, blockStart + indentation.length));
  } else {
    view.dispatch(view.state.tr.insertText("\u00a0\u00a0", blockStart));
  }
  return true;
}

const editorMarkdownSerializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  hard_break(state) {
    state.write("\n");
  },
  paragraph(state, node, parent, index) {
    const taskMarker = parent.type === composerSchema.nodes.list_item && index === 0
      ? /^\[([ xX])\][\t ]+/.exec(node.textContent)?.[0]
      : null;
    if (taskMarker) {
      state.write(taskMarker);
      state.renderInline(node.cut(taskMarker.length), false);
    } else {
      state.renderInline(node);
    }
    state.closeBlock(node);
  },
  table(state, node) {
    const outputState = state as typeof state & { out: string };
    node.forEach((row, _offset, rowIndex) => {
      state.write("|");
      row.forEach((cell) => {
        state.write(" ");
        const cellStart = outputState.out.length;
        state.renderInline(cell, false);
        outputState.out = outputState.out.slice(0, cellStart)
          + outputState.out.slice(cellStart).replace(/\|/g, "\\|");
        state.write(" |");
      });
      state.ensureNewLine();
      if (rowIndex === 0) {
        state.write("|");
        row.forEach((cell) => {
          const separator = cell.attrs.align === "left"
            ? ":---"
            : cell.attrs.align === "center"
              ? ":---:"
              : cell.attrs.align === "right"
                ? "---:"
                : "---";
          state.write(` ${separator} |`);
        });
        state.ensureNewLine();
      }
    });
    state.closeBlock(node);
  },
  [INLINE_MEDIA_NODE](state, node) {
    state.write(inlineMediaPlaceholderMarkdown(String(node.attrs.segmentId)));
    state.closeBlock(node);
  },
  [INLINE_REFERENCE_NODE](state, node) {
    state.write(inlineMediaPlaceholderMarkdown(String(node.attrs.segmentId)));
  },
}, {
  ...defaultMarkdownSerializer.marks,
  strike: {
    open: "~~",
    close: "~~",
    mixable: true,
    expelEnclosingWhitespace: true,
  },
});

function segmentsFromEditorDocument(
  documentNode: ProseMirrorNode,
  referenceTasks: readonly Task[],
  atomSegments: ReadonlyMap<string, InlineMediaSegment>,
): InlineMediaSegment[] {
  const markdown = editorMarkdownSerializer.serialize(documentNode);
  const restored = createInlineMediaSegments(markdown, referenceTasks).map((segment) => {
    if (segment.type !== "persisted-image") return segment;
    const atomId = inlineMediaPlaceholderId(segment.url);
    return atomId ? atomSegments.get(atomId) ?? segment : segment;
  });
  return selfContainedClipboardSegments(normalizeSegments(restored.map((segment, index) => {
    if (segment.type !== "text") return segment;
    let value = segment.text;
    if (isMediaAtomSegment(restored[index - 1]) && value.startsWith("\n\n")) {
      value = value.slice(2);
    }
    if (isMediaAtomSegment(restored[index + 1]) && value.endsWith("\n\n")) {
      value = value.slice(0, -2);
    }
    return value === segment.text ? segment : { ...segment, text: value };
  })));
}

function clipboardSegmentsFromSlice(
  slice: Slice,
  referenceTasks: readonly Task[],
  atomSegments: ReadonlyMap<string, InlineMediaSegment>,
): InlineMediaSegment[] {
  let content = slice.content;
  if (content.firstChild?.isInline) {
    content = Fragment.from(composerSchema.nodes.paragraph.create(null, content));
  }
  const documentNode = composerSchema.topNodeType.create(null, content);
  return segmentsFromEditorDocument(documentNode, referenceTasks, atomSegments);
}

function inlineMediaStateSignature(segments: readonly InlineMediaSegment[]): string {
  const atomMetadata = segments.flatMap((segment) => {
    switch (segment.type) {
      case "text":
        return [];
      case "pending-image":
      case "pending-attachment":
        return [`${segment.type}:${segment.id}:${fileKey(segment.file)}`];
      case "persisted-image":
        return [`${segment.type}:${segment.id}:${segment.url}:${segment.alt}`];
      case "persisted-attachment":
        return [`${segment.type}:${segment.id}:${segment.attachmentId}:${segment.contentType ?? ""}:${segment.size ?? ""}:${segment.filename}:${segment.url}`];
      case "issue-reference":
        return [`${segment.type}:${segment.id}:${segment.taskId ?? ""}:${segment.markdown}`];
      case "skill-reference":
      case "agent-reference":
        return [`${segment.type}:${segment.id}:${segment.referenceKey}:${segment.markdown}`];
      case "unsupported-reference":
        return [`${segment.type}:${segment.id}:${segment.referenceUri}:${segment.markdown}`];
    }
  });
  return `${serializeInlineMedia([...segments])}\u0000${atomMetadata.join("\u0001")}`;
}

function editorIsEmpty(documentNode: ProseMirrorNode): boolean {
  let hasAtom = false;
  documentNode.descendants((node) => {
    if (node.type.name === INLINE_MEDIA_NODE || node.type.name === INLINE_REFERENCE_NODE) hasAtom = true;
    return !hasAtom;
  });
  return !hasAtom && documentNode.textContent.length === 0;
}

function completionQueryForView(
  view: EditorView,
  completionContext: InlineMediaCompletionContext | undefined,
  mentionTaskCount: number,
): ComposerQuery | null {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty || !selection.$from.parent.isTextblock) {
    return null;
  }
  const prefix = selection.$from.parent.textBetween(0, selection.$from.parentOffset, "\n", "\ufffc");
  const match = /(?:^|\s)([@/])([^\s@/]*)$/.exec(prefix);
  if (!match) return null;
  const trigger = match[1] as ComposerTrigger;
  if ((trigger === "/" && !completionContext) || (
    trigger === "@" && !completionContext && mentionTaskCount === 0
  )) return null;

  const triggerOffset = match.index + match[0].lastIndexOf(trigger);
  const from = selection.$from.start() + triggerOffset;
  const coords = view.coordsAtPos(from);
  return {
    from,
    to: selection.from,
    query: match[2],
    trigger,
    anchor: view.dom,
    anchorRect: new DOMRect(coords.left, coords.top, 0, Math.max(1, coords.bottom - coords.top)),
  };
}

function atomPosition(documentNode: ProseMirrorNode, segmentIdValue: string): number | null {
  let found: number | null = null;
  documentNode.descendants((node, position) => {
    if (
      found === null
      && (node.type.name === INLINE_MEDIA_NODE || node.type.name === INLINE_REFERENCE_NODE)
      && node.attrs.segmentId === segmentIdValue
    ) {
      found = position;
      return false;
    }
    return found === null;
  });
  return found;
}

function adjacentNodeForDelete(
  selection: Selection,
  backwards: boolean,
): { node: ProseMirrorNode; position: number } | null {
  const $position = selection.$from;
  if (backwards && $position.parentOffset > 0) {
    const node = $position.nodeBefore;
    return node ? { node, position: selection.from - node.nodeSize } : null;
  }
  if (!backwards && $position.parentOffset < $position.parent.content.size) {
    const node = $position.nodeAfter;
    return node ? { node, position: selection.from } : null;
  }

  for (let childDepth = $position.depth; childDepth > 0; childDepth -= 1) {
    const parentDepth = childDepth - 1;
    const parent = $position.node(parentDepth);
    const currentIndex = $position.index(parentDepth);
    if (backwards && currentIndex > 0) {
      const node = parent.child(currentIndex - 1);
      return {
        node,
        position: $position.before(childDepth) - node.nodeSize,
      };
    }
    if (!backwards && currentIndex + 1 < parent.childCount) {
      return {
        node: parent.child(currentIndex + 1),
        position: $position.after(childDepth),
      };
    }
  }
  return null;
}

export const InlineMediaComposer = forwardRef<InlineMediaComposerHandle, InlineMediaComposerProps>(
  function InlineMediaComposer({
    segments,
    mentionTasks = EMPTY_MENTION_TASKS,
    referenceTasks,
    completionContext,
    placeholder,
    ariaLabel,
    disabled = false,
    allowAttachments = false,
    className = "",
    onChange,
    onError,
    onKeyDown,
  }, ref) {
    const { text } = useTaskboardI18n();
    const editorElement = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const atomSegments = useRef(new Map<string, InlineMediaSegment>());
    const atomHosts = useRef(new Map<string, HTMLElement>());
    const mermaidHosts = useRef(new Map<string, { host: HTMLElement; source: string }>());
    const editorSegments = useRef<InlineMediaSegment[]>(segments);
    const armedMediaAtom = useRef<string | null>(null);
    const requestSequence = useRef(0);
    const disabledRef = useRef(disabled);
    const allowAttachmentsRef = useRef(allowAttachments);
    const mentionTasksRef = useRef(mentionTasks);
    const referenceTasksRef = useRef(referenceTasks);
    const completionContextRef = useRef(completionContext);
    const onChangeRef = useRef(onChange);
    const onErrorRef = useRef(onError);
    const onKeyDownRef = useRef(onKeyDown);
    const [atomHostRevision, refreshAtomHosts] = useState(0);
    const [mermaidHostRevision, refreshMermaidHosts] = useState(0);
    const [completionQuery, setCompletionQuery] = useState<ComposerQuery | null>(null);
    const completionQueryRef = useRef<ComposerQuery | null>(completionQuery);
    const completionSelectionsRef = useRef<CompletionSelection[]>([]);
    const selectedCompletionIndexRef = useRef(-1);
    const [activeCompletionId, setActiveCompletionId] = useState<string | null>(null);
    const [completionResponse, setCompletionResponse] = useState<ComposerCandidatesResponse | null>(null);
    const [completionLoading, setCompletionLoading] = useState(false);
    const [completionError, setCompletionError] = useState<string | null>(null);

    disabledRef.current = disabled;
    allowAttachmentsRef.current = allowAttachments;
    mentionTasksRef.current = mentionTasks;
    referenceTasksRef.current = referenceTasks;
    completionContextRef.current = completionContext;
    onChangeRef.current = onChange;
    onErrorRef.current = onError;
    onKeyDownRef.current = onKeyDown;

    const issueResults = useMemo(() => {
      if (!completionQuery || completionQuery.trigger !== "@") return [];
      const query = completionQuery.query.toLocaleLowerCase();
      return mentionTasks.filter((task) => (
        !query
        || (task.externalKey ?? task.identifier).toLocaleLowerCase().includes(query)
        || task.title.toLocaleLowerCase().includes(query)
      ));
    }, [completionQuery, mentionTasks]);

    const completionSelections = useMemo<CompletionSelection[]>(() => {
      const candidates = completionResponse?.candidates.filter((candidate) => {
        if (!candidate.selectable || candidate.trigger !== completionQuery?.trigger) return false;
        if (candidate.kind === "slashAction") {
          return candidate.selection?.type === "insertText"
            && typeof candidate.selection.text === "string";
        }
        return candidate.persistence?.format === "taskboard.composer-reference.v1"
          && candidate.persistence.kind === candidate.kind
          && Boolean(candidate.persistence.referenceKey)
          && Boolean(candidate.persistence.markdown);
      }) ?? [];
      return [
        ...issueResults.map((task): CompletionSelection => ({ type: "issue", task })),
        ...candidates.map((candidate): CompletionSelection => ({ type: "candidate", candidate })),
      ];
    }, [completionQuery?.trigger, completionResponse, issueResults]);

    const selectedCompletionIndex = completionSelections.length === 0
      ? -1
      : Math.max(
          completionSelections.findIndex((selection) => (
            completionSelectionId(selection) === activeCompletionId
          )),
          0,
        );
    completionSelectionsRef.current = completionSelections;
    selectedCompletionIndexRef.current = selectedCompletionIndex;

    const completionGroups = useMemo<ComposerCompletionGroup[]>(() => {
      const groups: ComposerCompletionGroup[] = [];
      const groupsById = new Map<string, ComposerCompletionGroup>();
      let selectableIndex = 0;
      for (const selection of completionSelections) {
        const candidate = selection.type === "candidate" ? selection.candidate : null;
        const groupId = candidate ? `codex:${candidate.group}` : "taskboard:issues";
        const groupLabel = candidate?.group ?? text("Taskboard 议题", "Taskboard issues");
        let group = groupsById.get(groupId);
        if (!group) {
          group = { id: groupId, label: groupLabel, options: [] };
          groups.push(group);
          groupsById.set(groupId, group);
        }
        const task = selection.type === "issue" ? selection.task : null;
        group.options.push({
          id: completionSelectionId(selection),
          label: candidate?.kind === "slashAction"
            ? candidate.command
            : candidate?.label ?? task!.externalKey ?? task!.identifier,
          description: candidate ? candidate.description : task!.title,
          icon: candidate?.kind === "skill"
            ? "project"
            : candidate?.kind === "agent"
              ? "conversation"
              : candidate?.kind === "slashAction"
                ? "action"
                : "project",
          selectableIndex,
        });
        selectableIndex += 1;
      }
      return groups;
    }, [completionSelections, text]);

    const completionDiagnostics = useMemo(() => (
      completionResponse?.sources
        .filter((source) => source.state !== "available")
        .map((source) => `${source.kind}: ${source.state}${
          source.reasonCode ? ` (${source.reasonCode})` : ""
        }`) ?? []
    ), [completionResponse]);

    function editorAttributes(): Record<string, string> {
      return {
        class: `inline-media-composer ${className}`.trim(),
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        "aria-disabled": String(disabled),
        "data-placeholder": placeholder,
      };
    }

    function updateEmptyState(view: EditorView): void {
      view.dom.dataset.empty = String(editorIsEmpty(view.state.doc));
    }

    function closeCompletion(): void {
      completionQueryRef.current = null;
      setCompletionQuery(null);
    }

    function updateCompletion(view: EditorView): void {
      const next = completionQueryForView(
        view,
        completionContextRef.current,
        mentionTasksRef.current.length,
      );
      const current = completionQueryRef.current;
      const sameQuery = current?.from === next?.from
        && current?.to === next?.to
        && current?.query === next?.query
        && current?.trigger === next?.trigger;
      if (!sameQuery) {
        completionSelectionsRef.current = [];
        selectedCompletionIndexRef.current = -1;
      }
      completionQueryRef.current = next;
      setCompletionQuery(next);
    }

    function createAtomNodeView(
      node: ProseMirrorNode,
      _view: EditorView,
      _getPos: () => number | undefined,
    ): NodeView {
      const segmentIdValue = String(node.attrs.segmentId);
      const host = document.createElement(
        node.type.name === INLINE_MEDIA_NODE ? "div" : "span",
      );
      host.className = atomHostClass(atomSegments.current.get(segmentIdValue));
      host.dataset.inlineMediaSegment = segmentIdValue;
      host.contentEditable = "false";
      atomHosts.current.set(segmentIdValue, host);
      refreshAtomHosts((revision) => revision + 1);

      return {
        dom: host,
        update(nextNode) {
          if (
            nextNode.type !== node.type
            || String(nextNode.attrs.segmentId) !== segmentIdValue
          ) return false;
          host.className = atomHostClass(atomSegments.current.get(segmentIdValue));
          return true;
        },
        selectNode() {
          host.classList.add("is-range-selected");
        },
        deselectNode() {
          host.classList.remove("is-range-selected");
        },
        stopEvent(event) {
          const target = event.target;
          return target instanceof Element && Boolean(target.closest("button, video, a"));
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          if (atomHosts.current.get(segmentIdValue) === host) {
            atomHosts.current.delete(segmentIdValue);
            if (viewRef.current) refreshAtomHosts((revision) => revision + 1);
          }
        },
      };
    }

    function createCodeBlockNodeView(node: ProseMirrorNode): NodeView {
      const params = String(node.attrs.params ?? "");
      if (params.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid") {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (params) pre.dataset.params = params;
        pre.append(code);
        return { dom: pre, contentDOM: code };
      }

      const id = segmentId("mermaid");
      const wrapper = document.createElement("div");
      const preview = document.createElement("div");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      wrapper.className = "inline-media-mermaid-editor";
      preview.className = "inline-media-mermaid-preview";
      preview.contentEditable = "false";
      pre.className = "inline-media-mermaid-source";
      pre.dataset.params = params;
      pre.append(code);
      wrapper.append(preview, pre);
      mermaidHosts.current.set(id, { host: preview, source: node.textContent });
      refreshMermaidHosts((revision) => revision + 1);

      return {
        dom: wrapper,
        contentDOM: code,
        update(nextNode) {
          const nextParams = String(nextNode.attrs.params ?? "");
          if (
            nextNode.type !== node.type
            || nextParams.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid"
          ) return false;
          const current = mermaidHosts.current.get(id);
          if (current && current.source !== nextNode.textContent) {
            mermaidHosts.current.set(id, { ...current, source: nextNode.textContent });
            refreshMermaidHosts((revision) => revision + 1);
          }
          return true;
        },
        stopEvent(event) {
          return event.target instanceof Node && preview.contains(event.target);
        },
        ignoreMutation(mutation) {
          return mutation.type !== "selection"
            && mutation.target instanceof Node
            && preview.contains(mutation.target);
        },
        destroy() {
          mermaidHosts.current.delete(id);
          if (viewRef.current) refreshMermaidHosts((revision) => revision + 1);
        },
      };
    }

    function removeAtom(segmentIdValue: string): void {
      const view = viewRef.current;
      if (!view || disabledRef.current) return;
      const position = atomPosition(view.state.doc, segmentIdValue);
      if (position === null) return;
      armedMediaAtom.current = null;
      view.dispatch(view.state.tr.delete(position, position + 1).scrollIntoView());
      view.focus();
    }

    function insertFiles(files: FileList | File[], position?: number): void {
      const view = viewRef.current;
      if (!view || disabledRef.current) return;
      const selected = Array.from(files).filter((file) => (
        file.type.startsWith("image/") || allowAttachmentsRef.current
      ));
      if (selected.length === 0) return;

      const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
      if (oversized) {
        onErrorRef.current([
          `“${oversized.name}” 超过 25 MB，无法上传。`,
          `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
        ]);
        return;
      }

      const existing = new Set(editorSegments.current.flatMap((segment) => (
        segment.type === "pending-image" || segment.type === "pending-attachment"
          ? [fileKey(segment.file)]
          : []
      )));
      const insertable = selected.filter((file) => {
        const key = fileKey(file);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (insertable.length === 0) return;

      const additions = insertable.map((file): InlineMediaSegment => (
        file.type.startsWith("image/") ? imageSegment(file) : attachmentSegment(file)
      ));
      populateAtomSegments(atomSegments.current, additions);
      const nodes = additions.map(editorAtomNode);
      let transaction = view.state.tr;
      if (position !== undefined) {
        transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(position)));
      }
      transaction = transaction.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0));
      onErrorRef.current(null);
      view.dispatch(transaction.scrollIntoView());
      view.focus();
    }

    function insertSegments(insertion: InlineMediaSegment[], position?: number): void {
      const view = viewRef.current;
      if (!view || disabledRef.current || insertion.length === 0) return;
      populateAtomSegments(atomSegments.current, insertion);
      const insertionDocument = editorDocumentFromSegments(insertion);
      let transaction = view.state.tr;
      if (position !== undefined) {
        transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(position)));
      }
      view.dispatch(transaction.replaceSelection(Slice.maxOpen(insertionDocument.content)).scrollIntoView());
      view.focus();
    }

    function handleMediaDelete(view: EditorView, event: globalThis.KeyboardEvent): boolean {
      if (event.key !== "Backspace" && event.key !== "Delete") return false;
      const { selection } = view.state;

      if (selection instanceof NodeSelection && selection.node.type.name === INLINE_MEDIA_NODE) {
        const segmentIdValue = String(selection.node.attrs.segmentId);
        if (!isMediaAtomSegment(atomSegments.current.get(segmentIdValue))) return false;
        if (armedMediaAtom.current !== segmentIdValue) {
          armedMediaAtom.current = segmentIdValue;
          return true;
        }
        armedMediaAtom.current = null;
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
        return true;
      }

      if (!selection.empty) {
        armedMediaAtom.current = null;
        return false;
      }
      const adjacent = adjacentNodeForDelete(selection, event.key === "Backspace");
      if (!adjacent || adjacent.node.type.name !== INLINE_MEDIA_NODE) {
        armedMediaAtom.current = null;
        return false;
      }
      const segmentIdValue = String(adjacent.node.attrs.segmentId);
      if (!isMediaAtomSegment(atomSegments.current.get(segmentIdValue))) return false;
      armedMediaAtom.current = segmentIdValue;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(
        view.state.doc,
        adjacent.position,
      )));
      return true;
    }

    function handleCompletionKey(view: EditorView, event: globalThis.KeyboardEvent): boolean {
      const query = completionQueryRef.current;
      const selections = completionSelectionsRef.current;
      if (!query || selections.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (selectedCompletionIndexRef.current + direction + selections.length)
          % selections.length;
        selectedCompletionIndexRef.current = nextIndex;
        setActiveCompletionId(completionSelectionId(selections[nextIndex]));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const selection = selections[selectedCompletionIndexRef.current];
        if (selection) selectCompletion(selection);
        return Boolean(selection);
      }
      if (event.key === "Escape") {
        closeCompletion();
        return true;
      }
      return false;
    }

    function selectCompletion(selection: CompletionSelection): void {
      const view = viewRef.current;
      const query = completionQueryRef.current;
      if (!view || !query || disabledRef.current) return;
      const freshQuery = completionQueryForView(
        view,
        completionContextRef.current,
        mentionTasksRef.current.length,
      );
      if (
        !freshQuery
        || freshQuery.from !== query.from
        || freshQuery.to !== query.to
        || freshQuery.trigger !== query.trigger
      ) return;

      if (selection.type === "candidate" && selection.candidate.kind === "slashAction") {
        const insertedText = selection.candidate.selection?.type === "insertText"
          ? selection.candidate.selection.text
          : null;
        if (insertedText === null) return;
        const insertion = createInlineMediaSegments(insertedText, referenceTasksRef.current);
        populateAtomSegments(atomSegments.current, insertion);
        const insertionDocument = editorDocumentFromSegments(insertion);
        const transaction = view.state.tr
          .setSelection(TextSelection.create(view.state.doc, freshQuery.from, freshQuery.to))
          .replaceSelection(Slice.maxOpen(insertionDocument.content))
          .scrollIntoView();
        view.dispatch(transaction);
        closeCompletion();
        view.focus();
        return;
      }

      let reference: InlineMediaSegment | null = null;
      if (selection.type === "issue") {
        const task = selection.task;
        const displayIdentifier = task.externalKey ?? task.identifier;
        const route = new URLSearchParams({ project: task.projectId, issue: task.identifier });
        reference = {
          id: segmentId("issue"),
          type: "issue-reference",
          markdown: `[@${displayIdentifier}](?${route})`,
          identifier: displayIdentifier,
          projectId: task.projectId,
          taskId: task.id,
        };
      } else {
        const candidate = selection.candidate;
        if (candidate.kind === "slashAction") return;
        const persistence = candidate.persistence;
        if (!persistence || persistence.kind !== candidate.kind) return;
        const parsed = createInlineMediaSegments(persistence.markdown).filter(isAtomSegment);
        const parsedReference = parsed.length === 1 && (
          parsed[0].type === "skill-reference" || parsed[0].type === "agent-reference"
        ) ? parsed[0] : null;
        if (
          !parsedReference
          || parsedReference.type !== `${candidate.kind}-reference`
          || parsedReference.referenceKey !== persistence.referenceKey
        ) return;
        reference = parsedReference;
      }

      atomSegments.current.set(reference.id, reference);
      const atomNode = editorAtomNode(reference);
      const nextCharacter = view.state.doc.textBetween(
        freshQuery.to,
        Math.min(freshQuery.to + 1, view.state.doc.content.size),
      );
      const replacement = nextCharacter && /^\s/.test(nextCharacter)
        ? Fragment.from(atomNode)
        : Fragment.fromArray([atomNode, composerSchema.text(" ")]);
      view.dispatch(view.state.tr.replaceWith(freshQuery.from, freshQuery.to, replacement).scrollIntoView());
      closeCompletion();
      view.focus();
    }

    useLayoutEffect(() => {
      const mount = editorElement.current;
      if (!mount) return;
      populateAtomSegments(atomSegments.current, segments, true);
      editorSegments.current = segments;

      const view = new EditorView({ mount }, {
        state: EditorState.create({
          schema: composerSchema,
          doc: editorDocumentFromSegments(segments),
          plugins: composerPlugins(),
        }),
        attributes: editorAttributes(),
        editable: () => !disabledRef.current,
        nodeViews: {
          code_block: createCodeBlockNodeView,
          [INLINE_MEDIA_NODE]: createAtomNodeView,
          [INLINE_REFERENCE_NODE]: createAtomNodeView,
        },
        clipboardTextSerializer(slice) {
          return inlineMediaClipboardText(clipboardSegmentsFromSlice(
            slice,
            referenceTasksRef.current,
            atomSegments.current,
          ));
        },
        dispatchTransaction(transaction) {
          const previousSelection = view.state.selection;
          const nextState = view.state.apply(transaction);
          view.updateState(nextState);
          updateEmptyState(view);

          if (transaction.docChanged) {
            armedMediaAtom.current = null;
            const nextSegments = segmentsFromEditorDocument(
              nextState.doc,
              referenceTasksRef.current,
              atomSegments.current,
            );
            editorSegments.current = nextSegments;
            onChangeRef.current(nextSegments);
            refreshAtomHosts((revision) => revision + 1);
          } else if (
            previousSelection !== nextState.selection
            && (!(nextState.selection instanceof NodeSelection)
              || String(nextState.selection.node.attrs.segmentId) !== armedMediaAtom.current)
          ) {
            armedMediaAtom.current = null;
          }
          updateCompletion(view);
        },
        handleKeyDown(view, event) {
          if (event.isComposing || event.keyCode === 229) {
            onKeyDownRef.current?.(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
            return event.defaultPrevented;
          }
          if (handleCompletionKey(view, event)) return true;
          if (!disabledRef.current && handleIndentKey(view, event)) return true;
          if (!disabledRef.current && handleMediaDelete(view, event)) return true;
          onKeyDownRef.current?.(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
          return event.defaultPrevented;
        },
        handlePaste(view, event) {
          if (disabledRef.current) return false;
          const pastedFiles: File[] = event.clipboardData
            ? Array.from(event.clipboardData.files)
            : [];
          if (pastedFiles.length > 0) {
            insertFiles(pastedFiles);
            return true;
          }
          const html = event.clipboardData?.getData("text/html") ?? "";
          const structured = html ? createInlineMediaSegmentsFromHtml(html, referenceTasksRef.current) : null;
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          const insertion = structured ?? (plain ? createInlineMediaSegments(plain, referenceTasksRef.current) : []);
          if (insertion.length === 0) return false;
          insertSegments(insertion);
          return true;
        },
        handleDrop(view, event, _slice, moved) {
          if (disabledRef.current || moved) return false;
          const files: File[] = event.dataTransfer
            ? Array.from(event.dataTransfer.files)
            : [];
          if (files.length === 0) return false;
          const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
          insertFiles(files, coordinates?.pos);
          return true;
        },
        handleDOMEvents: {
          dragover(_view, event) {
            if (disabledRef.current || !event.dataTransfer?.types.includes("Files")) return false;
            event.preventDefault();
            return true;
          },
          blur() {
            armedMediaAtom.current = null;
            closeCompletion();
            return false;
          },
        },
      });
      viewRef.current = view;
      updateEmptyState(view);
      updateCompletion(view);

      return () => {
        viewRef.current = null;
        atomHosts.current.clear();
        mermaidHosts.current.clear();
        view.destroy();
      };
    }, []);

    useLayoutEffect(() => {
      populateAtomSegments(atomSegments.current, segments);
      const view = viewRef.current;
      if (!view) return;
      if (inlineMediaStateSignature(segments) === inlineMediaStateSignature(editorSegments.current)) {
        refreshAtomHosts((revision) => revision + 1);
        return;
      }

      populateAtomSegments(atomSegments.current, segments, true);
      editorSegments.current = segments;
      const nextDocument = editorDocumentFromSegments(segments);
      const wasFocused = view.hasFocus();
      view.updateState(EditorState.create({
        schema: composerSchema,
        doc: nextDocument,
        selection: TextSelection.atEnd(nextDocument),
        plugins: composerPlugins(),
      }));
      updateEmptyState(view);
      refreshAtomHosts((revision) => revision + 1);
      if (wasFocused) view.focus();
    }, [segments]);

    useLayoutEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.setProps({
        attributes: editorAttributes(),
        editable: () => !disabledRef.current,
      });
      updateEmptyState(view);
    }, [ariaLabel, className, disabled, placeholder]);

    useEffect(() => {
      setActiveCompletionId(null);
    }, [completionQuery?.query, completionQuery?.trigger]);

    useEffect(() => {
      if (disabled || (!completionContext && mentionTasks.length === 0)) closeCompletion();
    }, [completionContext, disabled, mentionTasks.length]);

    useEffect(() => {
      if (!completionQuery || !completionContext) {
        requestSequence.current += 1;
        setCompletionResponse(null);
        setCompletionLoading(false);
        setCompletionError(null);
        return;
      }
      const controller = new AbortController();
      const sequence = requestSequence.current + 1;
      requestSequence.current = sequence;
      setCompletionResponse(null);
      setCompletionLoading(true);
      setCompletionError(null);
      void getAiChatComposerCandidates({
        projectId: completionContext.projectId,
        threadId: completionContext.threadId,
        surface: completionContext.surface,
        trigger: completionQuery.trigger,
        query: completionQuery.query,
      }, controller.signal).then((response) => {
        if (requestSequence.current !== sequence) return;
        setCompletionResponse(response);
        setCompletionLoading(false);
      }, (error: unknown) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        setCompletionError(error instanceof Error ? error.message : text(
          "补全来源暂时不可用",
          "Completion sources are temporarily unavailable.",
        ));
        setCompletionLoading(false);
      });
      return () => controller.abort();
    }, [
      completionContext?.projectId,
      completionContext?.surface,
      completionContext?.threadId,
      completionQuery?.query,
      completionQuery?.trigger,
      text,
    ]);

    useImperativeHandle(ref, () => ({
      focus() {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
        view.focus();
      },
      focusAtText(text, offset, occurrence) {
        const view = viewRef.current;
        if (!view) return;
        const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
        let remaining = occurrence;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent !== text) continue;
          if (remaining > 0) {
            remaining -= 1;
            continue;
          }
          const position = view.posAtDOM(node, Math.min(offset, text.length));
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position))));
          view.focus();
          return;
        }
      },
      addFiles(files) {
        insertFiles(files);
      },
    }));

    void atomHostRevision;
    void mermaidHostRevision;
    const atomEntries: Array<[string, HTMLElement]> = Array.from(atomHosts.current.entries());
    const atomPortals = atomEntries.flatMap(([segmentIdValue, host]) => {
      const segment = atomSegments.current.get(segmentIdValue);
      if (!segment || segment.type === "text") return [];
      const remove = () => removeAtom(segment.id);
      const content = segment.type === "pending-image"
        ? <PendingImageBlock segment={segment} disabled={disabled} onRemove={remove} />
        : segment.type === "persisted-image"
          ? <PersistedImageBlock segment={segment} disabled={disabled} onRemove={remove} />
          : segment.type === "pending-attachment" && segment.file.type.startsWith("video/")
            ? <PendingVideoBlock segment={segment} disabled={disabled} onRemove={remove} />
            : segment.type === "persisted-attachment" && segment.contentType?.startsWith("video/")
              ? <PersistedVideoBlock segment={segment} disabled={disabled} onRemove={remove} />
              : segment.type === "pending-attachment" || segment.type === "persisted-attachment"
                ? <AttachmentBlock segment={segment} disabled={disabled} onRemove={remove} />
                : segment.type === "issue-reference"
                  ? (
                    <IssueReferenceChip
                      segment={segment}
                      task={referenceTasks.find((task) => task.id === segment.taskId) ?? null}
                      disabled={disabled}
                      onRemove={remove}
                    />
                  )
                  : <ComposerReferenceChip segment={segment} disabled={disabled} onRemove={remove} />;
      return [createPortal(content, host, segment.id)];
    });
    const mermaidPortals = Array.from(mermaidHosts.current.entries()).map(([
      id,
      { host, source },
    ]) => createPortal(<MermaidDiagram source={source} />, host, id));

    return (
      <>
        <div ref={editorElement} />
        {atomPortals}
        {mermaidPortals}
        {completionQuery
          && (completionLoading || completionError !== null || completionSelections.length > 0)
          && (
          <ComposerCompletionMenu
            anchor={completionQuery.anchor}
            anchorRect={completionQuery.anchorRect}
            getAnchorRect={() => {
              const view = viewRef.current;
              if (!view) return completionQuery.anchorRect;
              const coords = view.coordsAtPos(completionQuery.from);
              return new DOMRect(
                coords.left,
                coords.top,
                0,
                Math.max(1, coords.bottom - coords.top),
              );
            }}
            groups={completionGroups}
            activeIndex={selectedCompletionIndex}
            loading={completionLoading}
            error={completionError}
            emptyDiagnostics={completionDiagnostics}
            onActiveIndexChange={(index) => {
              const selection = completionSelections[index];
              if (selection) setActiveCompletionId(completionSelectionId(selection));
            }}
            onSelect={(index) => {
              const selection = completionSelections[index];
              if (selection) selectCompletion(selection);
            }}
            onClose={closeCompletion}
          />
          )}
      </>
    );
  },
);
