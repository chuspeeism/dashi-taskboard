import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEventHandler,
} from "react";
import { definitions } from "mdast-util-definitions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Attachment } from "../types";
import { attachmentContentUrl, resolvePersistedAttachmentUrl } from "../api";
import { useTaskboardI18n } from "../i18n";
import { clipboardImages, fileKey, MAX_ATTACHMENT_SIZE } from "./PendingAttachments";
import { LinearIcon } from "./LinearIcon";

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
}

interface PersistedImageSegment {
  id: string;
  type: "persisted-image";
  markdown: string;
  alt: string;
  url: string;
}

interface MarkdownAstNode {
  type: string;
  position: {
    start: { offset: number };
    end: { offset: number };
  };
  children?: MarkdownAstNode[];
  alt?: string | null;
  identifier?: string;
  url?: string;
}

export type InlineMediaSegment = InlineTextSegment | InlineImageSegment | PersistedImageSegment;
export type PendingInlineImage = InlineImageSegment;
type InlineMediaError = string | readonly [string, string];

export interface InlineMediaComposerHandle {
  focus: () => void;
  addImages: (files: FileList | File[]) => void;
}

interface InlineMediaComposerProps {
  segments: InlineMediaSegment[];
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onChange: (segments: InlineMediaSegment[]) => void;
  onError: (message: InlineMediaError | null) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}

let segmentSequence = 0;
const inlineMediaMarkdownParser = unified().use(remarkParse).use(remarkGfm);

function segmentId(prefix: string): string {
  segmentSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
}

function textSegment(text = ""): InlineTextSegment {
  return { id: segmentId("text"), type: "text", text };
}

function imageSegment(file: File): InlineImageSegment {
  const id = segmentId("image");
  return {
    id,
    type: "pending-image",
    token: `<!--taskboard-inline-image:${id}-->`,
    file,
  };
}

export function createInlineMediaSegments(text = ""): InlineMediaSegment[] {
  const segments: InlineMediaSegment[] = [];
  const images: Array<{ start: number; end: number; alt: string; url: string }> = [];
  const root = inlineMediaMarkdownParser.parse(text);
  const getDefinition = definitions(root);
  const nodes = [root as MarkdownAstNode];

  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (node.type === "image") {
      images.push({
        start: node.position.start.offset,
        end: node.position.end.offset,
        alt: node.alt ?? "",
        url: node.url!,
      });
    }
    if (node.type === "imageReference") {
      const definition = getDefinition(node.identifier);
      if (definition) {
        images.push({
          start: node.position.start.offset,
          end: node.position.end.offset,
          alt: node.alt ?? "",
          url: definition.url,
        });
      }
    }
    if (node.children) nodes.push(...node.children);
  }

  images.sort((a, b) => a.start - b.start);
  let offset = 0;

  for (const image of images) {
    if (image.start > offset) segments.push(textSegment(text.slice(offset, image.start)));
    segments.push({
      id: segmentId("image"),
      type: "persisted-image",
      markdown: text.slice(image.start, image.end),
      alt: image.alt,
      url: image.url,
    });
    offset = image.end;
  }

  if (offset < text.length) segments.push(textSegment(text.slice(offset)));
  return normalizeSegments(segments);
}

export function inlineMediaImages(segments: InlineMediaSegment[]): PendingInlineImage[] {
  return segments.filter((segment): segment is PendingInlineImage => segment.type === "pending-image");
}

export function inlineMediaText(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "persisted-image") return segment.markdown;
    return "";
  }).join("");
}

export function serializeInlineMedia(segments: InlineMediaSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    if (segment.type === "persisted-image") return segment.markdown;
    return `\n\n${segment.token}\n\n`;
  }).join("");
}

export function resolveInlineMediaMarkdown(
  value: string,
  images: PendingInlineImage[],
  attachments: Attachment[],
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
    if (segment.type === "text" && previous?.type === "text") {
      normalized[normalized.length - 1] = {
        ...previous,
        text: previous.text + segment.text,
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

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
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
    <figure className="inline-media-image">
      {previewUrl && <img src={previewUrl} alt={segment.file.name} />}
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
    <figure className="inline-media-image">
      <img src={resolvePersistedAttachmentUrl(segment.url)} alt={segment.alt} />
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

export const InlineMediaComposer = forwardRef<InlineMediaComposerHandle, InlineMediaComposerProps>(
  function InlineMediaComposer({
    segments,
    placeholder,
    ariaLabel,
    disabled = false,
    className = "",
    onChange,
    onError,
    onKeyDown,
  }, ref) {
    const textareas = useRef(new Map<string, HTMLTextAreaElement>());
    const pendingFocus = useRef<{ id: string; offset: number } | null>(null);
    const { text } = useTaskboardI18n();

    useLayoutEffect(() => {
      for (const element of textareas.current.values()) resizeTextarea(element);
      const focus = pendingFocus.current;
      if (!focus) return;
      const target = textareas.current.get(focus.id);
      if (!target) return;
      target.focus();
      target.setSelectionRange(focus.offset, focus.offset);
      pendingFocus.current = null;
    }, [segments]);

    useImperativeHandle(ref, () => ({
      focus() {
        const firstText = segments.find((segment) => segment.type === "text");
        if (firstText) textareas.current.get(firstText.id)?.focus();
      },
      addImages(files) {
        const selected = Array.from(files).filter((file) => file.type.startsWith("image/"));
        if (selected.length === 0) return;

        const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
        if (oversized) {
          onError([
            `“${oversized.name}” 超过 25 MB，无法上传。`,
            `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
          ]);
          return;
        }

        const existing = new Set(inlineMediaImages(segments).map((image) => fileKey(image.file)));
        const images = selected.filter((file) => {
          const key = fileKey(file);
          if (existing.has(key)) return false;
          existing.add(key);
          return true;
        });
        if (images.length === 0) return;
        onError(null);
        onChange(normalizeSegments([...segments, ...images.map(imageSegment)]));
      },
    }), [onChange, onError, segments]);

    function changeText(id: string, text: string) {
      onChange(segments.map((segment) => (
        segment.id === id && segment.type === "text" ? { ...segment, text } : segment
      )));
    }

    function pasteImages(
      event: ClipboardEvent<HTMLTextAreaElement>,
      segment: InlineTextSegment,
    ) {
      const clipboardFiles = clipboardImages(event.clipboardData);
      if (clipboardFiles.length === 0) return;
      event.preventDefault();

      const oversized = clipboardFiles.find((file) => file.size > MAX_ATTACHMENT_SIZE);
      if (oversized) {
        onError([
          `“${oversized.name}” 超过 25 MB，无法上传。`,
          `“${oversized.name}” is larger than 25 MB and cannot be uploaded.`,
        ]);
        return;
      }

      const existing = new Set(inlineMediaImages(segments).map((image) => fileKey(image.file)));
      const images = clipboardFiles.filter((file) => {
        const key = fileKey(file);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (images.length === 0) return;
      onError(null);

      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = { ...segment, text: segment.text.slice(0, start) };
      const after = textSegment(segment.text.slice(end));
      const insertion = images.map(imageSegment);
      const next = segments.flatMap((candidate) => (
        candidate.id === segment.id ? [before, ...insertion, after] : [candidate]
      ));
      pendingFocus.current = { id: after.id, offset: 0 };
      onChange(next);
    }

    function removeImage(id: string) {
      onChange(normalizeSegments(segments.filter((segment) => segment.id !== id)));
    }

    const isEmpty = segments.every((segment) => (
      segment.type === "text" ? segment.text.length === 0 : false
    ));

    return (
      <div className={`inline-media-composer ${className}`.trim()} aria-label={ariaLabel}>
        {segments.map((segment, index) => (
          segment.type === "text" ? (
            <textarea
              key={segment.id}
              ref={(element) => {
                if (element) textareas.current.set(segment.id, element);
                else textareas.current.delete(segment.id);
              }}
              value={segment.text}
              rows={1}
              disabled={disabled}
              aria-label={index === 0 ? ariaLabel : text(`${ariaLabel}续写`, `${ariaLabel} continuation`)}
              placeholder={isEmpty && index === 0 ? placeholder : undefined}
              onChange={(event) => {
                changeText(segment.id, event.target.value);
                resizeTextarea(event.currentTarget);
              }}
              onPaste={(event) => pasteImages(event, segment)}
              onKeyDown={onKeyDown}
            />
          ) : segment.type === "pending-image" ? (
            <PendingImageBlock
              key={segment.id}
              segment={segment}
              disabled={disabled}
              onRemove={() => removeImage(segment.id)}
            />
          ) : (
            <PersistedImageBlock
              key={segment.id}
              segment={segment}
              disabled={disabled}
              onRemove={() => removeImage(segment.id)}
            />
          )
        ))}
      </div>
    );
  },
);
