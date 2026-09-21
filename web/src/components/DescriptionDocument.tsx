import { memo, useEffect, useState, type ClipboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { attachmentContentUrl } from "../api";
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";
import { useTaskboardI18n } from "../i18n";
import type { Attachment, Task, TaskRelationSummary } from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import {
  createInlineMediaSegmentsFromHtml,
  parseInternalDocumentUrl,
  writeInlineMediaClipboard,
} from "../documentModel";
import { MarkdownDocument } from "./MarkdownDocument";
import { LinearIcon } from "./LinearIcon";
import { StatusIcon } from "./SemanticIcons";

function referencedTask(
  href: string,
  referenceTasks: Task[],
): { identifier: string; task: Task | null } | null {
  const reference = parseInternalDocumentUrl(href, document.baseURI);
  if (reference?.type !== "issue") return null;
  const { projectId, identifier } = reference;
  const task = referenceTasks.find((candidate) => (
    candidate.projectId === projectId && candidate.identifier === identifier
  )) ?? null;
  return { identifier: task?.externalKey ?? identifier, task };
}

function referencedAttachment(href: string, attachments: Attachment[]): Attachment | null {
  const reference = parseInternalDocumentUrl(href, document.baseURI);
  if (reference?.type !== "attachment" || reference.endpoint !== "download") return null;
  return attachments.find((attachment) => attachment.id === reference.attachmentId) ?? null;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function AttachmentLocalActions({ attachment, onCopy }: {
  attachment: Attachment;
  onCopy: (path: string, announcement: string) => void;
}) {
  const { text } = useTaskboardI18n();
  const [localPath, setLocalPath] = useState<string | null>(null);

  useEffect(() => {
    setLocalPath(null);
    if (new URL(document.baseURI).searchParams.get("host") !== "codex" || window.parent === window) return;
    function receiveLocalPath(event: MessageEvent) {
      if (event.source !== window.parent || event.data?.type !== "taskboard:attachment-local-path") return;
      const payload = event.data.payload;
      if (payload?.attachmentId !== attachment.id || payload?.filename !== attachment.filename) return;
      setLocalPath(typeof payload.localPath === "string" ? payload.localPath : null);
    }
    function locate() {
      postEmbeddedHostMessage({
        type: "taskboard:open-attachment",
        payload: { attachmentId: attachment.id, filename: attachment.filename, operation: "local-path" },
      });
    }
    window.addEventListener("message", receiveLocalPath);
    window.addEventListener("focus", locate);
    locate();
    return () => {
      window.removeEventListener("message", receiveLocalPath);
      window.removeEventListener("focus", locate);
    };
  }, [attachment.id, attachment.filename]);

  if (!localPath) return null;
  return (
    <span className="attachment-local-actions">
      <button
        type="button"
        className="icon-button"
        aria-label={text("複製路徑", "Copy path")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy(localPath, text("已複製檔案路徑", "File path copied"));
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M6 3.25C6.68858 3.25 7.24259 3.24959 7.69238 3.28027C8.14894 3.31142 8.55327 3.37681 8.93555 3.53516C9.85415 3.91575 10.5842 4.64585 10.9648 5.56445C11.1232 5.94673 11.1886 6.35106 11.2197 6.80762C11.2504 7.25741 11.25 7.81142 11.25 8.5V10.5C11.25 11.1886 11.2504 11.7426 11.2197 12.1924C11.1886 12.6489 11.1232 13.0533 10.9648 13.4355C10.5842 14.3542 9.85415 15.0842 8.93555 15.4648C8.55327 15.6232 8.14894 15.6886 7.69238 15.7197C7.24259 15.7504 6.68858 15.75 6 15.75C5.31142 15.75 4.75741 15.7504 4.30762 15.7197C3.85106 15.6886 3.44673 15.6232 3.06445 15.4648C2.14585 15.0842 1.41575 14.3542 1.03516 13.4355C0.876813 13.0533 0.811424 12.6489 0.780273 12.1924C0.749592 11.7426 0.75 11.1886 0.75 10.5V8.5C0.75 7.81142 0.749592 7.25741 0.780273 6.80762C0.811424 6.35106 0.876813 5.94673 1.03516 5.56445C1.41575 4.64585 2.14585 3.91575 3.06445 3.53516C3.44673 3.37681 3.85106 3.31142 4.30762 3.28027C4.75741 3.24959 5.31142 3.25 6 3.25ZM6 4.75C5.29083 4.75 4.7961 4.74997 4.40918 4.77637C4.02923 4.80231 3.80765 4.8509 3.63867 4.9209C3.08745 5.14926 2.64926 5.58745 2.4209 6.13867C2.3509 6.30765 2.30231 6.52923 2.27637 6.90918C2.24997 7.2961 2.25 7.79083 2.25 8.5V10.5C2.25 11.2092 2.24997 11.7039 2.27637 12.0908C2.30231 12.4708 2.3509 12.6923 2.4209 12.8613C2.64926 13.4125 3.08745 13.8507 3.63867 14.0791C3.80765 14.1491 4.02923 14.1977 4.40918 14.2236C4.7961 14.25 5.29083 14.25 6 14.25C6.70917 14.25 7.2039 14.25 7.59082 14.2236C7.97077 14.1977 8.19234 14.1491 8.36133 14.0791C8.91255 13.8507 9.35074 13.4125 9.5791 12.8613C9.6491 12.6923 9.69769 12.4708 9.72363 12.0908C9.75003 11.7039 9.75 11.2092 9.75 10.5V8.5C9.75 7.79083 9.75003 7.2961 9.72363 6.90918C9.69769 6.52923 9.6491 6.30765 9.5791 6.13867C9.35074 5.58745 8.91255 5.14926 8.36133 4.9209C8.19235 4.8509 7.97077 4.80231 7.59082 4.77637C7.2039 4.74997 6.70917 4.75 6 4.75ZM8.5 0.25C9.42141 0.25 10.1501 0.249861 10.7393 0.290039C11.3351 0.330693 11.8433 0.415042 12.3174 0.611328C13.4813 1.09342 14.4066 2.01873 14.8887 3.18262C15.085 3.65667 15.1693 4.16484 15.21 4.76074C15.2501 5.34995 15.25 6.07859 15.25 7V9C15.25 10.9015 13.8346 12.4713 12 12.7158V11.1914C13.0017 10.9638 13.75 10.0706 13.75 9V7C13.75 6.05793 13.7498 5.38868 13.7139 4.8623C13.6784 4.34271 13.611 4.01674 13.5029 3.75586C13.1731 2.95971 12.5403 2.32692 11.7441 1.99707C11.4832 1.889 11.1573 1.82159 10.6377 1.78613C10.1113 1.75022 9.44214 1.75 8.5 1.75C7.83441 1.75 7.23812 2.04063 6.82617 2.5H5.06348C5.64227 1.17585 6.96247 0.25 8.5 0.25Z" fill="currentColor" stroke="none" />
        </svg>
        <span className="attachment-action-tooltip" role="tooltip">{text("複製路徑", "Copy path")}</span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={text("開啟", "Open")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          postEmbeddedHostMessage({
            type: "taskboard:open-attachment",
            payload: { attachmentId: attachment.id, filename: attachment.filename, operation: "reveal" },
          });
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M4.87109 9.71614H11.2664" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path fillRule="evenodd" clipRule="evenodd" d="M1.66699 5.19899C1.66699 3.57105 2.50033 2.17296 4.08166 1.84851C5.66233 1.52344 6.86366 1.63582 7.86166 2.17423C8.86033 2.71264 8.57433 3.50756 9.60033 4.09105C10.627 4.67518 12.2783 3.79772 13.357 4.96153C14.4863 6.17994 14.4803 8.05042 14.4803 9.2428C14.4803 13.7736 11.9423 14.133 8.07366 14.133C4.20499 14.133 1.66699 13.8193 1.66699 9.2428V5.19899Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="attachment-action-tooltip" role="tooltip">{text("開啟", "Open")}</span>
      </button>
    </span>
  );
}

export const DescriptionDocument = memo(function DescriptionDocument({
  value,
  referenceTasks,
  onOpenTask,
  attachments = [],
  enableImagePreview = false,
  onOpenAttachment,
  onCopyAttachmentPath,
}: {
  value: string;
  referenceTasks: Task[];
  onOpenTask: (task: TaskRelationSummary) => void;
  attachments?: Attachment[];
  enableImagePreview?: boolean;
  onOpenAttachment?: (event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) => void;
  onCopyAttachmentPath?: (path: string, announcement: string) => void;
}) {
  const [previewImage, setPreviewImage] = useState<{
    src: string; alt: string;
  } | null>(null);

  useEffect(() => {
    if (!previewImage) return;
    function closePreview(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPreviewImage(null);
    }
    window.addEventListener("keydown", closePreview, true);
    return () => window.removeEventListener("keydown", closePreview, true);
  }, [previewImage]);

  return (<>
    <MarkdownDocument
      value={value}
      onImageClick={enableImagePreview ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        const src = event.currentTarget.currentSrc || event.currentTarget.src;
        setPreviewImage({
          src,
          alt: event.currentTarget.alt,
        });
      } : undefined}
      onCopy={(event: ClipboardEvent<HTMLDivElement>) => {
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (
          !event.currentTarget.contains(range.startContainer)
          || !event.currentTarget.contains(range.endContainer)
        ) return;
        const selectedRange = range.cloneRange();
        const wrapper = event.currentTarget.ownerDocument.createElement("div");
        wrapper.append(selectedRange.cloneContents());
        const segments = createInlineMediaSegmentsFromHtml(wrapper.innerHTML, referenceTasks);
        if (!segments) return;
        event.preventDefault();
        writeInlineMediaClipboard(
          event.clipboardData,
          segments,
        );
      }}
      renderLink={(href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        if (attachment) {
          if (attachment.contentType.startsWith("video/")) {
            return (
              <video
                className="document-inline-video"
                src={attachmentContentUrl(attachment)}
                aria-label={attachment.filename}
                controls
              />
            );
          }
          return (
            <span className="document-attachment-card">
              <span className="attachment-file-icon" aria-hidden="true">
                <LinearIcon name="file" />
              </span>
              <span className="attachment-copy composer-attachment-copy">
                <strong>{attachment.filename}</strong>
                <span>{fileSize(attachment.size)}</span>
              </span>
            </span>
          );
        }
        const reference = href ? referencedTask(href, referenceTasks) : null;
        if (!reference) return null;
        const { task } = reference;
        if (!task) {
          return (
            <span className="issue-reference-inline">
              <span className="issue-reference-identity">
                <span className="issue-reference-id">{reference.identifier}</span>
              </span>
            </span>
          );
        }
        return (
          <span className={`issue-reference-inline issue-reference-status-${task.status}`}>
            <span className="issue-reference-identity">
              <span className={`status-icon issue-reference-status status-icon-${STATUS_DETAILS[task.status].tone}`}>
                <StatusIcon status={task.status} color="var(--column-status-color)" size={15} />
              </span>
              <span className="issue-reference-id">{task.externalKey ?? task.identifier}</span>
            </span>
            <span className="issue-reference-title">{task.title}</span>
          </span>
        );
      }}
      renderLinkActions={onCopyAttachmentPath ? (href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        return attachment && !attachment.contentType.startsWith("video/") && !attachment.contentType.startsWith("image/")
          ? <AttachmentLocalActions key={attachment.id} attachment={attachment} onCopy={onCopyAttachmentPath} />
          : null;
      } : undefined}
      onLinkClick={(event, href) => {
        const attachment = href ? referencedAttachment(href, attachments) : null;
        if (attachment && onOpenAttachment) {
          if (
            event.button === 0
            && !event.metaKey
            && !event.ctrlKey
            && !event.shiftKey
            && !event.altKey
          ) onOpenAttachment(event, attachment);
          return;
        }
        const reference = href ? referencedTask(href, referenceTasks) : null;
        if (
          !reference
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return;
        event.preventDefault();
        if (reference.task) onOpenTask(reference.task);
      }}
    />
    {previewImage && createPortal(
      <div
        className="display-settings-backdrop image-preview-backdrop"
        role="presentation"
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) setPreviewImage(null);
        }}
      >
        <div
          className="image-preview-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.alt || "Image preview"}
        >
          <img src={previewImage.src} alt={previewImage.alt} />
          <button
            className="icon-button display-settings-close image-preview-close"
            type="button"
            aria-label="Close image preview"
            onClick={() => setPreviewImage(null)}
          >
            <LinearIcon name="close" />
          </button>
        </div>
      </div>,
      document.body,
    )}
  </>);
});
