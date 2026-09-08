import { encodeComposerReferenceKey, readComposerReferenceId } from "../../shared/composer-reference.mjs";
import { definitions } from "mdast-util-definitions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { readIssueIdentifier } from "./issueRoute";
import type { Attachment, Task } from "./types";

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

export interface PersistedImageSegment {
  id: string;
  type: "persisted-image";
  markdown: string;
  alt: string;
  url: string;
}

export interface PendingAttachmentSegment {
  id: string;
  type: "pending-attachment";
  token: string;
  file: File;
}

export interface PersistedAttachmentSegment {
  id: string;
  type: "persisted-attachment";
  markdown: string;
  attachmentId: string;
  contentType: string | null;
  size: number | null;
  filename: string;
  url: string;
}

export interface IssueReferenceSegment {
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
export type InternalDocumentReference =
  | { type: "issue"; projectId: string; identifier: string }
  | { type: "attachment"; attachmentId: string; endpoint: "content" | "download" };

// Identity is independent of the DOM and of attachment transport URL rewriting.
export function parseInternalDocumentUrl(
  href: string,
  baseUri: string,
): InternalDocumentReference | null {
  try {
    const base = new URL(baseUri);
    base.search = "";
    base.hash = "";
    const url = new URL(href, base);
    if (url.origin !== base.origin) return null;

    if (url.pathname === base.pathname) {
      const identifier = readIssueIdentifier(url.search);
      const projectId = url.searchParams.get("project");
      if (identifier && projectId) return { type: "issue", projectId, identifier };
    }

    // Accept the app-relative API route and its existing root-relative spelling,
    // not an arbitrary path that merely ends in /api/attachments/....
    const attachmentBase = new URL("api/attachments/", base).pathname;
    const rootAttachmentBase = "/api/attachments/";
    const path = url.pathname.startsWith(attachmentBase)
      ? url.pathname.slice(attachmentBase.length)
      : url.pathname.startsWith(rootAttachmentBase)
        ? url.pathname.slice(rootAttachmentBase.length)
        : "";
    const attachment = /^([^/]+)\/(content|download)$/.exec(path);
    if (!attachment) return null;
    return {
      type: "attachment",
      attachmentId: decodeURIComponent(attachment[1]),
      endpoint: attachment[2] as "content" | "download",
    };
  } catch {
    return null;
  }
}

const EMPTY_MENTION_TASKS: readonly Task[] = [];

let segmentSequence = 0;
const inlineMediaMarkdownParser = unified().use(remarkParse).use(remarkGfm);
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

export function segmentId(prefix: string): string {
  segmentSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
}

function textSegment(text = ""): InlineTextSegment {
  return { id: segmentId("text"), type: "text", text };
}

export function imageSegment(file: File, dataUrl: string | null = null): InlineImageSegment {
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

export function attachmentSegment(file: File): PendingAttachmentSegment {
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

function pendingImageComposerReference(
  url: string,
  name: string,
): { file: File; dataUrl: string } | null {
  const match = PENDING_IMAGE_COMPOSER_REFERENCE_URL.exec(url);
  const type = match ? readComposerReferenceId(match[1]) : null;
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
  if (!namespaceMatch || !readComposerReferenceId(namespaceMatch[3], namespaceMatch[2])) return null;
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
  const referenceKey = urlMatch[2];
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
  baseUri: string = document.baseURI,
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
      const reference = parseInternalDocumentUrl(node.url, baseUri);
      if (reference?.type === "attachment" && reference.endpoint === "download") {
        const filename = markdownNodeText(node);
        if (filename) {
          const attachment = attachments.find((candidate) => (
            candidate.id === reference.attachmentId
          ));
          items.push({
            type: "persisted-attachment",
            start: node.position.start.offset,
            end: node.position.end.offset,
            attachmentId: reference.attachmentId,
            contentType: attachment?.contentType ?? null,
            size: attachment?.size ?? null,
            filename,
            url: node.url,
          });
          handledAttachment = true;
        }
      }
      if (reference?.type === "issue") {
        const { projectId, identifier } = reference;
        const task = referenceTasks.find((candidate) => (
          candidate.projectId === projectId && candidate.identifier === identifier
        ));
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
    const previousIsMedia = isTaskboardAttachmentMedia(normalized[index - 1], baseUri);
    const nextIsMedia = isTaskboardAttachmentMedia(normalized[index + 1], baseUri);
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

export function inlineMediaText(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "pending-image" || segment.type === "pending-attachment") return "";
    return segment.markdown;
  }).join("");
}

export function isTaskboardAttachmentMedia(
  segment: InlineMediaSegment | undefined,
  baseUri: string = document.baseURI,
): boolean {
  if (segment?.type === "persisted-image") {
    const reference = parseInternalDocumentUrl(segment.url, baseUri);
    return reference?.type === "attachment" && reference.endpoint === "content";
  }
  return segment?.type === "pending-image"
    || segment?.type === "pending-attachment"
    || segment?.type === "persisted-attachment";
}

function serializeInlineMediaSegments(
  segments: InlineMediaSegment[],
  segmentValue: (segment: InlineMediaSegment) => string,
  baseUri: string,
): string {
  let markdown = "";
  let previousWasMedia = false;
  let sharedMediaBoundary = false;
  segments.forEach((segment, index) => {
    const value = segmentValue(segment);
    if (
      segment.type === "text"
      && isTaskboardAttachmentMedia(segments[index - 1], baseUri)
      && isTaskboardAttachmentMedia(segments[index + 1], baseUri)
      && /^\n*$/.test(value)
    ) {
      markdown += `\n${value}`;
      previousWasMedia = false;
      sharedMediaBoundary = true;
      return;
    }
    if (!value) return;
    const isMedia = isTaskboardAttachmentMedia(segment, baseUri);
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

export function serializeInlineMedia(
  segments: InlineMediaSegment[],
  baseUri: string = document.baseURI,
): string {
  return serializeInlineMediaSegments(segments, (segment) => (
    segment.type === "text"
      ? segment.text
      : segment.type === "pending-image"
        ? segment.token
        : segment.type === "pending-attachment"
          ? segment.token
        : segment.markdown
  ), baseUri);
}

export function normalizeSegments(segments: InlineMediaSegment[]): InlineMediaSegment[] {
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

export function isInlineReference(
  segment: InlineMediaSegment,
): segment is IssueReferenceSegment | InlineComposerReferenceSegment | InlineUnsupportedComposerReferenceSegment {
  return segment.type === "issue-reference"
    || segment.type === "skill-reference"
    || segment.type === "agent-reference"
    || segment.type === "unsupported-reference";
}

export function inlineMediaClipboardText(
  segments: InlineMediaSegment[],
  baseUri: string = document.baseURI,
): string {
  return serializeInlineMediaSegments(segments, (segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "pending-image") {
      return pendingImageClipboardMarkdown(segment) ?? segment.file.name;
    }
    if (segment.type === "pending-attachment") return segment.file.name;
    return segment.markdown;
  }, baseUri);
}

function pendingImageClipboardMarkdown(segment: InlineImageSegment): string | null {
  const match = segment.dataUrl?.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  const typeKey = encodeComposerReferenceKey(match[1]);
  const dataKey = match[2].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const alt = segment.file.name.replace(/[\\[\]]/g, "\\$&");
  return `![${alt}](taskboard://composer-reference/v1/pending-image/${typeKey}.${dataKey})`;
}

export function selfContainedClipboardSegments(
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
  baseUri: string = document.baseURI,
) {
  clipboardData.setData(
    "text/plain",
    inlineMediaClipboardText(selfContainedClipboardSegments(segments), baseUri),
  );
}

export function createInlineMediaSegmentsFromHtml(
  html: string,
  referenceTasks: readonly Task[],
  baseUri: string = document.baseURI,
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
      const reference = parseInternalDocumentUrl(href, baseUri);
      if (reference?.type === "issue") {
        const { projectId, identifier } = reference;
        const task = referenceTasks.find((candidate) => (
          candidate.projectId === projectId && candidate.identifier === identifier
        ));
        const displayIdentifier = task?.externalKey ?? identifier;
        const route = new URLSearchParams({ project: projectId, issue: identifier });
        markdown += `[@${displayIdentifier}](?${route})`;
        structured = true;
        return;
      }
      if (href) {
        // Keep attachment and external links intact alongside structured content.
        const start = markdown.length;
        for (const child of element.childNodes) visit(child);
        const label = markdown.slice(start);
        markdown = `${markdown.slice(0, start)}[${label}](${href})`;
        structured = true;
        return;
      }
    }
    if (element.tagName === "IMG") {
      const source = element.getAttribute("src");
      if (source) {
        const reference = parseInternalDocumentUrl(source, baseUri);
        const url = reference?.type === "attachment" && reference.endpoint === "content"
          ? `api/attachments/${encodeURIComponent(reference.attachmentId)}/content`
          : source;
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
  return structured ? createInlineMediaSegments(markdown, referenceTasks, [], baseUri) : null;
}
