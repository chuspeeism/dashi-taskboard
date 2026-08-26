import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
} from "react";
import { createPortal } from "react-dom";
import { definitions } from "mdast-util-definitions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  ComposerCandidate,
  ComposerCandidatesResponse,
  ComposerSurface,
  ComposerTrigger,
  Task,
} from "../types";
import {
  attachmentContentUrl,
  getAiChatComposerCandidates,
  resolvePersistedAttachmentUrl,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import { readIssueIdentifier } from "../issueRoute";
import { STATUS_DETAILS } from "./BoardColumn";
import { clipboardImages, fileKey, MAX_ATTACHMENT_SIZE } from "./PendingAttachments";
import { LinearIcon } from "./LinearIcon";
import {
  ConversationIcon,
  ProjectIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  ComposerCompletionMenu,
  type ComposerCompletionGroup,
} from "./ComposerCompletionMenu";

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
  | IssueReferenceSegment
  | InlineComposerReferenceSegment
  | InlineUnsupportedComposerReferenceSegment;
export type PendingInlineImage = InlineImageSegment;
type InlineMediaError = string | readonly [string, string];

export interface InlineMediaComposerHandle {
  focus: () => void;
  addImages: (files: FileList | File[]) => void;
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
  className?: string;
  onChange: (segments: InlineMediaSegment[]) => void;
  onError: (message: InlineMediaError | null) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

interface ComposerQuery {
  segmentId: string;
  start: number;
  end: number;
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
const EMPTY_TEXT_CARET = "\uFEFF";
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
    let handledIssueReference = false;
    if (node.type === "link" && node.url) {
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
    const composerReference = handledIssueReference ? null : composerReferenceFromNode(node, text);
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
    const previousIsImage = isTaskboardAttachmentImage(normalized[index - 1]);
    const nextIsImage = isTaskboardAttachmentImage(normalized[index + 1]);
    let value = segment.text;
    if (previousIsImage && nextIsImage && /^\n+$/.test(value)) {
      value = value.slice(1);
    } else {
      if (previousIsImage && value.startsWith("\n")) value = value.slice(1);
      if (nextIsImage && value.endsWith("\n")) value = value.slice(0, -1);
    }
    return value === segment.text ? segment : { ...segment, text: value };
  });
}

export function inlineMediaImages(segments: InlineMediaSegment[]): PendingInlineImage[] {
  return segments.filter((segment): segment is PendingInlineImage => segment.type === "pending-image");
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
    if (segment.type === "pending-image") return "";
    return segment.markdown;
  }).join("");
}

function isTaskboardAttachmentImage(segment: InlineMediaSegment | undefined): boolean {
  return segment?.type === "pending-image" || (
    segment?.type === "persisted-image"
    && /^\/?api\/attachments\/[^/?#]+\/content$/.test(segment.url)
  );
}

function serializeInlineMediaSegments(
  segments: InlineMediaSegment[],
  segmentValue: (segment: InlineMediaSegment) => string,
): string {
  let markdown = "";
  let previousWasImage = false;
  let sharedImageBoundary = false;
  segments.forEach((segment, index) => {
    const value = segmentValue(segment);
    if (
      segment.type === "text"
      && isTaskboardAttachmentImage(segments[index - 1])
      && isTaskboardAttachmentImage(segments[index + 1])
      && /^\n*$/.test(value)
    ) {
      markdown += `\n${value}`;
      previousWasImage = false;
      sharedImageBoundary = true;
      return;
    }
    if (!value) return;
    const isImage = isTaskboardAttachmentImage(segment);
    if (isImage) {
      if (markdown && !sharedImageBoundary) markdown += "\n";
      markdown += value;
      previousWasImage = true;
      sharedImageBoundary = false;
      return;
    }
    if (previousWasImage) markdown += "\n";
    markdown += value;
    previousWasImage = false;
    sharedImageBoundary = false;
  });
  return markdown;
}

export function serializeInlineMedia(segments: InlineMediaSegment[]): string {
  return serializeInlineMediaSegments(segments, (segment) => (
    segment.type === "text"
      ? segment.text
      : segment.type === "pending-image"
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

function segmentLength(segment: InlineMediaSegment): number {
  return segment.type === "text" ? segment.text.length : 1;
}

function segmentsLength(segments: InlineMediaSegment[]): number {
  return segments.reduce((length, segment) => length + segmentLength(segment), 0);
}

function inlineMediaRangeSegments(
  segments: InlineMediaSegment[],
  start: number,
  end: number,
): InlineMediaSegment[] {
  let offset = 0;
  return segments.flatMap<InlineMediaSegment>((segment): InlineMediaSegment[] => {
    const length = segmentLength(segment);
    const segmentStart = offset;
    const segmentEnd = offset + length;
    offset = segmentEnd;
    if (end <= segmentStart || start >= segmentEnd) return [];
    if (segment.type !== "text") return [segment];
    return [{
      ...segment,
      text: segment.text.slice(
        Math.max(start - segmentStart, 0),
        Math.min(end - segmentStart, length),
      ),
    }];
  });
}

function inlineMediaClipboardText(segments: InlineMediaSegment[]): string {
  return serializeInlineMediaSegments(segments, (segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "pending-image") {
      return pendingImageClipboardMarkdown(segment) ?? segment.file.name;
    }
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

function replaceInlineMediaRange(
  segments: InlineMediaSegment[],
  start: number,
  end: number,
  insertion: InlineMediaSegment[],
): { segments: InlineMediaSegment[]; caret: number } {
  const before: InlineMediaSegment[] = [];
  const after: InlineMediaSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    const length = segmentLength(segment);
    const segmentStart = offset;
    const segmentEnd = offset + length;
    offset = segmentEnd;
    if (segmentEnd <= start) before.push(segment);
    else if (segment.type === "text" && segmentStart < start) {
      before.push({ ...segment, text: segment.text.slice(0, start - segmentStart) });
    }
    if (segmentStart >= end) after.push(segment);
    else if (segment.type === "text" && segmentEnd > end) {
      after.push({ ...segment, text: segment.text.slice(end - segmentStart) });
    }
  }

  const usedIds = new Set([...before, ...insertion].map((segment) => segment.id));
  const uniqueAfter = after.map((segment) => {
    if (!usedIds.has(segment.id)) return segment;
    return { ...segment, id: segmentId(segment.type === "text" ? "text" : "segment") };
  });
  return {
    segments: normalizeSegments([...before, ...insertion, ...uniqueAfter]),
    caret: segmentsLength(before) + segmentsLength(insertion),
  };
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
        aria-label={text(`移除 ${segment.alt || "圖片"}`, `Remove ${segment.alt || "image"}`)}
        onClick={onRemove}
      >
        <LinearIcon name="close" />
      </button>
    </figure>
  );
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
            `${displayIdentifier} ${task.title}，按退格鍵或刪除鍵移除`,
            `${displayIdentifier} ${task.title}, press Backspace or Delete to remove`,
          )
        : text(
            `${displayIdentifier}，按退格鍵或刪除鍵移除`,
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
      : text("不支援的引用", "Unsupported reference");

  return (
    <button
      type="button"
      className={`inline-media-composer-reference is-${segment.type}`}
      contentEditable={false}
      data-inline-media-segment={segment.id}
      data-taskboard-inline-media-markdown={segment.markdown}
      disabled={disabled}
      aria-label={text(
        `${kind} ${segment.label}，按退格鍵或刪除鍵移除`,
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

export const InlineMediaComposer = forwardRef<InlineMediaComposerHandle, InlineMediaComposerProps>(
  function InlineMediaComposer({
    segments,
    mentionTasks = EMPTY_MENTION_TASKS,
    referenceTasks,
    completionContext,
    placeholder,
    ariaLabel,
    disabled = false,
    className = "",
    onChange,
    onError,
    onKeyDown,
  }, ref) {
    const { text } = useTaskboardI18n();
    const rootRef = useRef<HTMLDivElement>(null);
    const latestSegments = useRef(segments);
    latestSegments.current = segments;
    const atomHosts = useRef(new Map<string, HTMLElement>());
    const nativeSegments = useRef(new Map<string, InlineMediaSegment>());
    const pendingSelection = useRef<number | null>(null);
    const pendingMentionUpdate = useRef(false);
    const pendingAtomHostRevision = useRef(0);
    const composing = useRef(false);
    const nativeInputPending = useRef(false);
    const [atomHostRevision, refreshAtomHosts] = useState(0);
    const requestSequence = useRef(0);
    const [completionQuery, setCompletionQuery] = useState<ComposerQuery | null>(null);
    const [activeCompletionId, setActiveCompletionId] = useState<string | null>(null);
    const [completionResponse, setCompletionResponse] = useState<ComposerCandidatesResponse | null>(null);
    const [completionLoading, setCompletionLoading] = useState(false);
    const [completionError, setCompletionError] = useState<string | null>(null);
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
    const completionGroups = useMemo<ComposerCompletionGroup[]>(() => {
      const groups: ComposerCompletionGroup[] = [];
      const groupsById = new Map<string, ComposerCompletionGroup>();
      let selectableIndex = 0;
      for (const selection of completionSelections) {
        const candidate = selection.type === "candidate" ? selection.candidate : null;
        const groupId = candidate ? `codex:${candidate.group}` : "taskboard:issues";
        const groupLabel = candidate?.group ?? text("Taskboard 議題", "Taskboard issues");
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

    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      if (nativeInputPending.current) {
        nativeInputPending.current = false;
        pendingSelection.current = null;
        if (pendingMentionUpdate.current) {
          pendingMentionUpdate.current = false;
          updateCompletionFromSelection();
        }
        return;
      }
      const fragment = document.createDocumentFragment();
      const nextAtomHosts = new Map<string, HTMLElement>();

      for (const segment of segments) {
        nativeSegments.current.set(segment.id, segment);
        const element = document.createElement("span");
        element.dataset.inlineMediaSegment = segment.id;
        if (segment.type === "text") {
          element.className = "inline-media-text";
          if (segment.text) {
            element.textContent = segment.text;
            if (segment.text.endsWith("\n")) element.append(document.createElement("br"));
          } else {
            element.dataset.inlineMediaEmptyText = "true";
            element.append(document.createTextNode(EMPTY_TEXT_CARET), document.createElement("br"));
          }
        } else {
          element.className = isInlineReference(segment)
            ? "inline-media-atom"
            : "inline-media-atom inline-media-image-atom";
          if (segment.type === "pending-image") element.contentEditable = "false";
          else element.dataset.taskboardInlineMediaMarkdown = segment.markdown;
          nextAtomHosts.set(segment.id, element);
        }
        fragment.append(element);
      }

      root.replaceChildren(fragment);
      atomHosts.current = nextAtomHosts;
      pendingAtomHostRevision.current = atomHostRevision + 1;
      refreshAtomHosts(pendingAtomHostRevision.current);
    }, [segments]);

    useLayoutEffect(() => {
      if (atomHostRevision !== pendingAtomHostRevision.current) return;
      if (pendingSelection.current === null) return;
      setCollapsedSelection(pendingSelection.current);
      pendingSelection.current = null;
      if (!pendingMentionUpdate.current) return;
      pendingMentionUpdate.current = false;
      updateCompletionFromSelection();
    }, [atomHostRevision, segments]);

    useEffect(() => {
      setActiveCompletionId(null);
    }, [completionQuery?.query, completionQuery?.trigger]);

    useEffect(() => {
      if (disabled || (!completionContext && mentionTasks.length === 0)) setCompletionQuery(null);
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
          "補全來源暫時不可用",
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

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      root.addEventListener("beforeinput", handleBeforeInput);
      return () => root.removeEventListener("beforeinput", handleBeforeInput);
    }, [disabled, onChange, segments]);

    useEffect(() => {
      function collapseFromOutsidePointer(event: PointerEvent) {
        const root = rootRef.current;
        if (!root || root.contains(event.target as Node)) return;
        collapseComposerSelection("focus");
      }

      document.addEventListener("pointerdown", collapseFromOutsidePointer, true);
      return () => document.removeEventListener("pointerdown", collapseFromOutsidePointer, true);
    }, [atomHostRevision, segments]);

    useEffect(() => {
      document.addEventListener("selectionchange", syncAtomSelection);
      syncAtomSelection();
      return () => document.removeEventListener("selectionchange", syncAtomSelection);
    }, [atomHostRevision, segments]);

    function insertableImages(files: FileList | File[]): File[] | null {
      const selected = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (selected.length === 0) return [];

      const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
      if (oversized) {
        onError([
          `“${oversized.name}” 超過 25 MB，無法上傳。`,
          `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
        ]);
        return null;
      }

      const existing = new Set(inlineMediaImages(segments).map((image) => fileKey(image.file)));
      const images = selected.filter((file) => {
        const key = fileKey(file);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (images.length > 0) onError(null);
      return images;
    }

    useImperativeHandle(ref, () => ({
      focus() {
        rootRef.current?.focus();
        setCollapsedSelection(segmentsLength(segments));
      },
      addImages(files) {
        const images = insertableImages(files);
        if (!images || images.length === 0) return;
        onChange(normalizeSegments([...segments, ...images.map((file) => imageSegment(file))]));
      },
    }), [onChange, onError, segments]);

    function directRootTextSegment(): InlineTextSegment | null {
      const root = rootRef.current;
      const segment = segments.length === 1 && segments[0].type === "text"
        ? segments[0]
        : null;
      if (!root || !segment || root.childNodes.length !== 1) return null;
      return root.firstChild instanceof Text || root.firstChild instanceof HTMLBRElement
        ? segment
        : null;
    }

    function segmentElement(node: Node | null): HTMLElement | null {
      const root = rootRef.current;
      if (!root || !node || !root.contains(node)) return null;
      const element = node instanceof Element ? node : node.parentElement;
      return element?.closest<HTMLElement>("[data-inline-media-segment]") ?? null;
    }

    function segmentOffset(id: string): number {
      let offset = 0;
      for (const segment of segments) {
        if (segment.id === id) return offset;
        offset += segmentLength(segment);
      }
      return offset;
    }

    function logicalOffsetForPoint(
      node: Node,
      offset: number,
      edge: "start" | "end",
    ): number | null {
      const root = rootRef.current;
      if (!root || !root.contains(node)) return null;
      const directText = directRootTextSegment();
      if (directText) {
        const child = root.firstChild;
        if (node === child && child instanceof Text) {
          return Math.max(0, Math.min(offset, child.length));
        }
        if (node === root) {
          return child instanceof Text && offset > 0 ? directText.text.length : 0;
        }
      }
      if (node === root) {
        let logicalOffset = 0;
        const boundary = Math.max(0, Math.min(offset, root.childNodes.length));
        for (let index = 0; index < boundary; index += 1) {
          const child = root.childNodes[index];
          if (child instanceof Text) {
            logicalOffset += child.length;
            continue;
          }
          if (!(child instanceof HTMLElement)) continue;
          const id = child.dataset.inlineMediaSegment;
          const segment = id ? nativeSegments.current.get(id) : null;
          logicalOffset += segment && segment.type !== "text"
            ? segmentLength(segment)
            : child.textContent?.length ?? 0;
        }
        return Math.min(logicalOffset, segmentsLength(segments));
      }
      const element = segmentElement(node);
      const id = element?.dataset.inlineMediaSegment;
      if (!element || !id) return null;
      const segment = segments.find((candidate) => candidate.id === id);
      if (!segment) return null;
      const start = segmentOffset(id);
      if (segment.type !== "text") return start + (edge === "end" ? 1 : 0);
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, offset);
      return start + (
        element.dataset.inlineMediaEmptyText === "true"
          ? 0
          : range.toString().length
      );
    }

    function currentLogicalRange(): { start: number; end: number } | null {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (!range.intersectsNode(root)) return null;
      const start = root.contains(range.startContainer)
        ? logicalOffsetForPoint(range.startContainer, range.startOffset, "start")
        : 0;
      if (start === null) return null;
      if (range.collapsed) return { start, end: start };
      const end = root.contains(range.endContainer)
        ? logicalOffsetForPoint(range.endContainer, range.endOffset, "end")
        : segmentsLength(segments);
      return end === null ? null : { start, end };
    }

    function elementForSegment(id: string): HTMLElement | null {
      const root = rootRef.current;
      if (!root) return null;
      return Array.from(root.querySelectorAll<HTMLElement>("[data-inline-media-segment]"))
        .find((element) => element.dataset.inlineMediaSegment === id) ?? null;
    }

    function domPointAtOffset(offset: number): { node: Node; offset: number } | null {
      const root = rootRef.current;
      if (!root) return null;
      const directText = directRootTextSegment();
      if (directText) {
        const child = root.firstChild;
        if (child instanceof Text) {
          return { node: child, offset: Math.max(0, Math.min(offset, child.length)) };
        }
        return { node: root, offset: 0 };
      }
      let current = 0;
      for (const segment of segments) {
        const element = elementForSegment(segment.id);
        if (!element) continue;
        const length = segmentLength(segment);
        if (segment.type === "text" && offset <= current + length) {
          const textNode = element.firstChild;
          if (textNode instanceof Text) {
            return { node: textNode, offset: Math.max(0, Math.min(offset - current, textNode.length)) };
          }
          return { node: element, offset: 0 };
        }
        const childIndex = Array.from(root.childNodes).indexOf(element);
        if (segment.type !== "text" && offset <= current) {
          return { node: root, offset: Math.max(childIndex, 0) };
        }
        if (segment.type !== "text" && offset < current + length) {
          return { node: root, offset: Math.max(childIndex + 1, 0) };
        }
        current += length;
      }
      return { node: root, offset: root.childNodes.length };
    }

    function setCollapsedSelection(offset: number) {
      const root = rootRef.current;
      const point = domPointAtOffset(offset);
      if (!root || !point) return;
      root.focus();
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      syncAtomSelection();
    }

    function collapseComposerSelection(edge: "start" | "end" | "focus"): boolean {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
      if (edge === "focus" && selection.focusNode && root.contains(selection.focusNode)) {
        selection.collapse(selection.focusNode, selection.focusOffset);
        syncAtomSelection();
        return true;
      }
      const collapsed = range.cloneRange();
      collapsed.collapse(edge === "start");
      selection.removeAllRanges();
      selection.addRange(collapsed);
      syncAtomSelection();
      return true;
    }

    function syncAtomSelection() {
      const range = currentLogicalRange();
      let offset = 0;
      for (const segment of segments) {
        const length = segmentLength(segment);
        if (segment.type !== "text") {
          elementForSegment(segment.id)?.classList.toggle(
            "is-range-selected",
            range !== null && range.start < offset + length && range.end > offset,
          );
        }
        offset += length;
      }
    }

    function applyRangeReplacement(
      start: number,
      end: number,
      insertion: InlineMediaSegment[],
      updateMention = true,
    ) {
      const replacement = replaceInlineMediaRange(segments, start, end, insertion);
      pendingSelection.current = replacement.caret;
      pendingMentionUpdate.current = updateMention;
      setCompletionQuery(null);
      onChange(replacement.segments);
    }

    function removeSegment(id: string) {
      const index = segments.findIndex((segment) => segment.id === id);
      if (index < 0) return;
      const start = segmentsLength(segments.slice(0, index));
      applyRangeReplacement(start, start + segmentLength(segments[index]), [], false);
    }

    function completionRangeFromCaret(caretRange: Range, triggerLength: number): Range | null {
      const root = rootRef.current;
      if (!root || !caretRange.collapsed || !root.contains(caretRange.startContainer)) return null;
      const textNode = caretRange.startContainer;
      if (!(textNode instanceof Text) || caretRange.startOffset < triggerLength) return null;
      const range = document.createRange();
      const triggerOffset = caretRange.startOffset - triggerLength;
      range.setStart(textNode, triggerOffset);
      range.setEnd(textNode, triggerOffset + 1);
      return range;
    }

    function completionAnchorRect(query: ComposerQuery): DOMRect {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0) return query.anchorRect;
      const caretRange = selection.getRangeAt(0);
      return completionRangeFromCaret(caretRange, query.end - query.start)
        ?.getBoundingClientRect() ?? query.anchorRect;
    }

    function updateCompletionFromSelection() {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (
        !root
        || (!completionContext && mentionTasks.length === 0)
        || !selection
        || selection.rangeCount === 0
      ) {
        setCompletionQuery(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        setCompletionQuery(null);
        return;
      }
      const directText = directRootTextSegment();
      const selectedElement = segmentElement(range.startContainer) ?? (directText ? root : null);
      const selectedId = selectedElement === root
        ? directText?.id
        : selectedElement?.dataset.inlineMediaSegment;
      const caretOffset = logicalOffsetForPoint(
        range.startContainer,
        range.startOffset,
        "start",
      );
      let segmentStart = 0;
      let segment = selectedId
        ? segments.find((candidate): candidate is InlineTextSegment => (
            candidate.id === selectedId && candidate.type === "text"
          ))
        : null;
      if (segment) {
        segmentStart = segmentOffset(segment.id);
      } else if (caretOffset !== null) {
        let offset = 0;
        segment = segments.find((candidate): candidate is InlineTextSegment => {
          const start = offset;
          offset += segmentLength(candidate);
          if (candidate.type !== "text") return false;
          const containsCaret = caretOffset >= start && caretOffset <= offset;
          if (containsCaret) segmentStart = start;
          return containsCaret;
        }) ?? null;
      }
      if (!segment || caretOffset === null) {
        setCompletionQuery(null);
        return;
      }
      const end = Math.max(0, Math.min(caretOffset - segmentStart, segment.text.length));
      const prefix = segment.text.slice(0, end);
      const match = /(?:^|\s)([@/])([^\s@/]*)$/.exec(prefix);
      if (!match) {
        setCompletionQuery(null);
        return;
      }
      const trigger = match[1] as ComposerTrigger;
      if ((trigger === "/" && !completionContext) || (
        trigger === "@" && !completionContext && mentionTasks.length === 0
      )) {
        setCompletionQuery(null);
        return;
      }
      const start = prefix.lastIndexOf(trigger);
      const triggerLength = end - start;
      let anchorRange = completionRangeFromCaret(range, triggerLength);
      if (!anchorRange) {
        anchorRange = range.cloneRange();
        anchorRange.setStart(range.startContainer, range.startOffset);
        anchorRange.collapse(true);
      }
      const anchorRect = anchorRange.getBoundingClientRect();
      setCompletionQuery({
        segmentId: segment.id,
        start,
        end,
        query: match[2],
        trigger,
        anchor: root,
        anchorRect,
      });
    }

    function selectCompletion(selection: CompletionSelection) {
      if (!completionQuery) return;
      const segment = segments.find((candidate): candidate is InlineTextSegment => (
        candidate.id === completionQuery.segmentId && candidate.type === "text"
      ));
      if (!segment) return;
      const suffix = segment.text.slice(completionQuery.end);
      const start = segmentOffset(segment.id) + completionQuery.start;
      const end = start + completionQuery.end - completionQuery.start;

      if (selection.type === "issue") {
        const task = selection.task;
        const displayIdentifier = task.externalKey ?? task.identifier;
        const route = new URLSearchParams({ project: task.projectId, issue: task.identifier });
        const reference: IssueReferenceSegment = {
          id: segmentId("issue"),
          type: "issue-reference",
          markdown: `[@${displayIdentifier}](?${route})`,
          identifier: displayIdentifier,
          projectId: task.projectId,
          taskId: task.id,
        };
        applyRangeReplacement(
          start,
          end,
          [reference, textSegment(/^\s/.test(suffix) ? "" : " ")],
          false,
        );
        return;
      }

      const candidate = selection.candidate;
      if (candidate.kind === "slashAction") {
        if (candidate.selection?.type !== "insertText") return;
        applyRangeReplacement(start, end, [textSegment(candidate.selection.text)], false);
        return;
      }

      const persistence = candidate.persistence;
      if (!persistence || persistence.kind !== candidate.kind) return;
      const parsed = createInlineMediaSegments(persistence.markdown).filter((item) => item.type !== "text");
      const reference = parsed.length === 1 && (
        parsed[0].type === "skill-reference" || parsed[0].type === "agent-reference"
      ) ? parsed[0] : null;
      if (
        !reference
        || reference.type !== `${candidate.kind}-reference`
        || reference.referenceKey !== persistence.referenceKey
      ) return;
      applyRangeReplacement(
        start,
        end,
        [reference, textSegment(/^\s/.test(suffix) ? "" : " ")],
        false,
      );
    }

    function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        onKeyDown?.(event);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        const root = rootRef.current;
        if (!root) return;
        root.focus();
        const range = document.createRange();
        range.selectNodeContents(root);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        syncAtomSelection();
        setCompletionQuery(null);
        return;
      }
      if (
        (event.key === "PageUp" || event.key === "PageDown")
        && collapseComposerSelection(event.key === "PageUp" ? "start" : "end")
      ) {
        event.preventDefault();
        setCompletionQuery(null);
        return;
      }
      if (completionQuery && event.key === "ArrowDown" && completionSelections.length > 0) {
        event.preventDefault();
        const nextIndex = (selectedCompletionIndex + 1) % completionSelections.length;
        setActiveCompletionId(completionSelectionId(completionSelections[nextIndex]));
        return;
      }
      if (completionQuery && event.key === "ArrowUp" && completionSelections.length > 0) {
        event.preventDefault();
        const nextIndex = (
          selectedCompletionIndex - 1 + completionSelections.length
        ) % completionSelections.length;
        setActiveCompletionId(completionSelectionId(completionSelections[nextIndex]));
        return;
      }
      if (
        completionQuery
        && (event.key === "Enter" || event.key === "Tab")
        && selectedCompletionIndex >= 0
        && completionSelections[selectedCompletionIndex]
      ) {
        event.preventDefault();
        selectCompletion(completionSelections[selectedCompletionIndex]);
        return;
      }
      if (completionQuery && event.key === "Escape") {
        event.preventDefault();
        setCompletionQuery(null);
        return;
      }
      onKeyDown?.(event);
    }

    function handleBeforeInput(input: InputEvent) {
      if (disabled || composing.current) return;
      const targetRange = input.getTargetRanges()[0];
      if (!targetRange) return;
      const root = rootRef.current;
      let start = logicalOffsetForPoint(
        targetRange.startContainer,
        targetRange.startOffset,
        "start",
      );
      let end = logicalOffsetForPoint(
        targetRange.endContainer,
        targetRange.endOffset,
        "end",
      );
      if (start === null || end === null) return;
      const startElement = segmentElement(targetRange.startContainer);
      const endElement = segmentElement(targetRange.endContainer);
      let backwardImageDelete = false;
      const caretRange = input.inputType === "deleteContentBackward"
        ? currentLogicalRange()
        : null;
      if (
        input.inputType === "deleteContentBackward"
        && caretRange
        && caretRange.start === caretRange.end
      ) {
        let offset = 0;
        for (const segment of segments) {
          const nextOffset = offset + segmentLength(segment);
          if (
            nextOffset === caretRange.start
            && (segment.type === "pending-image" || segment.type === "persisted-image")
          ) {
            start = offset;
            end = nextOffset;
            backwardImageDelete = true;
            break;
          }
          offset = nextOffset;
        }
      }
      const directText = directRootTextSegment();
      const directTextTarget = Boolean(
        root
        && directText
        && [targetRange.startContainer, targetRange.endContainer].every((node) => (
          node === root || node.parentNode === root
        )),
      );
      const targetSegment = startElement?.dataset.inlineMediaSegment
        ? segments.find((segment) => segment.id === startElement.dataset.inlineMediaSegment)
        : directTextTarget ? directText : null;
      const sameTextSegment = targetSegment?.type === "text"
        && (directTextTarget || startElement === endElement);
      const fullDelete = start === 0 && end > start && end === segmentsLength(segments);
      const nativeTextEdit = !backwardImageDelete && (
        (
          sameTextSegment
          && (
            input.inputType.startsWith("delete")
            || ["insertText", "insertReplacementText"].includes(input.inputType)
          )
        ) || (
          input.inputType.startsWith("delete")
          && fullDelete
        )
      );
      if (nativeTextEdit) return;
      let insertion: InlineMediaSegment[] | null = null;
      if (["insertText", "insertReplacementText"].includes(input.inputType)) {
        insertion = [textSegment(input.data ?? "")];
      } else if (["insertLineBreak", "insertParagraph"].includes(input.inputType)) {
        insertion = [textSegment("\n")];
      } else if (input.inputType.startsWith("delete")) {
        insertion = [];
      }
      if (insertion === null) return;
      input.preventDefault();
      applyRangeReplacement(start, end, insertion);
    }

    async function copyContent(event: ClipboardEvent<HTMLDivElement>): Promise<{
      range: { start: number; end: number };
      segments: InlineMediaSegment[];
    } | null> {
      const currentTarget = event.currentTarget;
      const ownerDocument = currentTarget.ownerDocument;
      const selection = ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const selectedRange = selection.getRangeAt(0);
      if (
        !currentTarget.contains(selectedRange.startContainer)
        || !currentTarget.contains(selectedRange.endContainer)
      ) return null;
      const range = currentLogicalRange();
      if (!range || range.start === range.end) return null;
      const copiedSegments = inlineMediaRangeSegments(segments, range.start, range.end);
      event.preventDefault();
      const pendingImages = copiedSegments.filter((segment): segment is InlineImageSegment => (
        segment.type === "pending-image"
      ));
      if (pendingImages.length > 0) {
        await Promise.all(copiedSegments.flatMap((segment) => (
          segment.type === "pending-image" ? [segment.dataUrlReady] : []
        )));
        await navigator.clipboard.writeText(inlineMediaClipboardText(
          selfContainedClipboardSegments(copiedSegments),
        ));
      } else {
        writeInlineMediaClipboard(
          event.clipboardData,
          copiedSegments,
        );
      }
      return { range, segments: copiedSegments };
    }

    function pasteContent(event: ClipboardEvent<HTMLDivElement>) {
      const range = currentLogicalRange();
      if (!range) return;
      const clipboardHtml = event.clipboardData.getData("text/html");
      const clipboardFiles = clipboardImages(event.clipboardData);
      if (clipboardFiles.length > 0) {
        event.preventDefault();
        const images = insertableImages(clipboardFiles);
        if (!images || images.length === 0) return;
        applyRangeReplacement(
          range.start,
          range.end,
          images.map((file) => imageSegment(file)),
          false,
        );
        return;
      }
      const htmlSegments = createInlineMediaSegmentsFromHtml(clipboardHtml, referenceTasks);
      if (htmlSegments) {
        event.preventDefault();
        applyRangeReplacement(range.start, range.end, htmlSegments, false);
        return;
      }

      const pastedText = event.clipboardData.getData("text/plain");
      const insertion = createInlineMediaSegments(pastedText, referenceTasks);
      event.preventDefault();
      applyRangeReplacement(range.start, range.end, insertion);
    }

    function dragContent(event: DragEvent<HTMLDivElement>) {
      if (Array.from(event.dataTransfer.items).some((item) => (
        item.kind === "file" && item.type.startsWith("image/")
      ))) event.preventDefault();
    }

    function dropContent(event: DragEvent<HTMLDivElement>) {
      const images = insertableImages(event.dataTransfer.files);
      if (!images || images.length === 0) return;
      event.preventDefault();
      const caretRange = (document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }).caretRangeFromPoint?.(event.clientX, event.clientY);
      const offset = caretRange
        ? logicalOffsetForPoint(caretRange.startContainer, caretRange.startOffset, "start")
        : null;
      const insertionOffset = offset ?? currentLogicalRange()?.end ?? segmentsLength(segments);
      applyRangeReplacement(
        insertionOffset,
        insertionOffset,
        images.map((file) => imageSegment(file)),
        false,
      );
    }

    function syncSegmentsFromDom() {
      const root = rootRef.current;
      if (!root) return;
      const existing = nativeSegments.current;
      for (const segment of segments) existing.set(segment.id, segment);
      const directText = directRootTextSegment();
      const next: InlineMediaSegment[] = [];
      const nextAtomHosts = new Map<string, HTMLElement>();
      for (const child of root.childNodes) {
        if (child instanceof Text) {
          if (child.data) {
            next.push(directText ? { ...directText, text: child.data } : textSegment(child.data));
          }
          continue;
        }
        if (!(child instanceof HTMLElement)) continue;
        const id = child.dataset.inlineMediaSegment;
        const segment = id ? existing.get(id) : null;
        if (segment?.type === "text") {
          let text = child.textContent ?? "";
          if (child.dataset.inlineMediaEmptyText) {
            const textNode = child.firstChild;
            const placeholderOffset = textNode instanceof Text
              ? textNode.data.indexOf(EMPTY_TEXT_CARET)
              : -1;
            text = text.replace(EMPTY_TEXT_CARET, "");
            if (text) {
              if (textNode instanceof Text && placeholderOffset >= 0) {
                textNode.deleteData(placeholderOffset, 1);
              }
              delete child.dataset.inlineMediaEmptyText;
            }
          }
          next.push({ ...segment, text });
        } else if (segment) {
          next.push(segment);
          nextAtomHosts.set(segment.id, child);
        } else if (child.tagName === "BR" && root.childNodes.length > 1) {
          next.push(textSegment("\n"));
        } else if (child.textContent) {
          next.push(textSegment(child.textContent));
        }
      }
      if (next.length === 0) {
        const text = segments.find((segment): segment is InlineTextSegment => segment.type === "text");
        if (text) next.push({ ...text, text: "" });
      }
      const normalized = normalizeSegments(next);
      for (const segment of normalized) existing.set(segment.id, segment);
      atomHosts.current = nextAtomHosts;
      nativeInputPending.current = true;
      pendingSelection.current = null;
      pendingMentionUpdate.current = true;
      onChange(normalized);
    }

    const isEmpty = segments.every((segment) => (
      segment.type === "text" ? segment.text.length === 0 : false
    ));
    const atomPortals = segments.flatMap((segment) => {
      if (segment.type === "text") return [];
      const host = atomHosts.current.get(segment.id);
      if (!host) return [];
      const content = segment.type === "pending-image" ? (
        <PendingImageBlock
          segment={segment}
          disabled={disabled}
          onRemove={() => removeSegment(segment.id)}
        />
      ) : segment.type === "persisted-image" ? (
        <PersistedImageBlock
          segment={segment}
          disabled={disabled}
          onRemove={() => removeSegment(segment.id)}
        />
      ) : segment.type === "issue-reference" ? (
        <IssueReferenceChip
          segment={segment}
          task={segment.taskId
            ? referenceTasks.find((task) => task.id === segment.taskId) ?? null
            : null}
          disabled={disabled}
          onRemove={() => removeSegment(segment.id)}
        />
      ) : (
        <ComposerReferenceChip
          segment={segment}
          disabled={disabled}
          onRemove={() => removeSegment(segment.id)}
        />
      );
      return [createPortal(content, host, segment.id)];
    });

    return (
      <>
        <div
          ref={rootRef}
          className={`inline-media-composer ${className}`.trim()}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-disabled={disabled}
          data-empty={isEmpty ? "true" : undefined}
          data-placeholder={placeholder}
          onKeyDownCapture={handleComposerKeyDown}
          onInput={() => {
            if (!composing.current) syncSegmentsFromDom();
          }}
          onCompositionStart={(event) => {
            composing.current = true;
            event.currentTarget.removeAttribute("data-empty");
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (isEmpty && !event.currentTarget.textContent?.replace(EMPTY_TEXT_CARET, "")) {
              event.currentTarget.dataset.empty = "true";
            }
            syncSegmentsFromDom();
          }}
          onDragOver={dragContent}
          onDrop={dropContent}
          onPaste={pasteContent}
          onCopy={copyContent}
          onCut={(event) => {
            void copyContent(event).then((copied) => {
              if (!copied) return;
              const currentSegments = latestSegments.current;
              const currentCut = inlineMediaRangeSegments(
                currentSegments,
                copied.range.start,
                copied.range.end,
              );
              const unchanged = currentCut.length === copied.segments.length
                && currentCut.every((segment, index) => {
                  const snapshot = copied.segments[index];
                  return segment.id === snapshot.id
                    && segment.type === snapshot.type
                    && (
                      segment.type !== "text"
                      || (snapshot.type === "text" && segment.text === snapshot.text)
                    );
                });
              if (!unchanged) return;
              const replacement = replaceInlineMediaRange(
                currentSegments,
                copied.range.start,
                copied.range.end,
                [],
              );
              pendingSelection.current = replacement.caret;
              pendingMentionUpdate.current = false;
              setCompletionQuery(null);
              onChange(replacement.segments);
            });
          }}
          onKeyUp={(event) => {
            if (event.key !== "Escape") updateCompletionFromSelection();
          }}
          onPointerUp={() => {
            syncAtomSelection();
            updateCompletionFromSelection();
          }}
          onBlur={(event) => {
            setCompletionQuery(null);
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              collapseComposerSelection("focus");
            }
          }}
        >
          {atomPortals}
        </div>
        {completionQuery
          && (completionLoading || completionError !== null || completionSelections.length > 0)
          && (
          <ComposerCompletionMenu
            anchor={completionQuery.anchor}
            anchorRect={completionQuery.anchorRect}
            getAnchorRect={() => completionAnchorRect(completionQuery)}
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
            onClose={() => setCompletionQuery(null)}
          />
          )}
      </>
    );
  },
);
