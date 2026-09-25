import { attachmentContentUrl, attachmentDownloadUrl } from "./api";
import type { Attachment } from "./types";
import { referencedAttachmentIds, type PendingInlineAttachment, type PendingInlineImage } from "./documentModel";

type PendingAttachment = PendingInlineImage | PendingInlineAttachment;

export function uploadInlineAttachments(
  pending: PendingAttachment[],
  upload: (file: File, kind: Attachment["kind"]) => Promise<Attachment>,
) {
  return Promise.all(pending.map((item) => upload(
    item.file, item.type === "pending-image" ? "inline" : "attachment",
  )));
}

export function resolveInlineAttachments(
  value: string,
  pending: PendingAttachment[],
  attachments: Array<{ id: string }>,
): string {
  return pending.reduce((markdown, item, index) => {
    const attachment = attachments[index];
    if (!attachment) return markdown;
    const label = item.file.name.replace(/[\\[\]]/g, "\\$&");
    const image = item.type === "pending-image";
    const url = image ? attachmentContentUrl(attachment) : attachmentDownloadUrl(attachment);
    return markdown.replace(item.token, `${image ? "!" : ""}[${label}](${url})`);
  }, value);
}

// Legacy uploads belong to the document, not a separate attachment list. Once
// its owner saves a complete body, persistence consumes the fallback eligibility.
export function appendUnreferencedAttachments(value: string, attachments: readonly Attachment[]): string {
  const referenced = referencedAttachmentIds(value);
  const missing: string[] = [];
  for (const attachment of attachments) {
    if (!attachment.bodyFallback || referenced.has(attachment.id)) continue;
    referenced.add(attachment.id);
    const label = attachment.filename.replace(/[\\[\]]/g, "\\$&");
    const image = attachment.contentType.startsWith("image/");
    const url = image ? attachmentContentUrl(attachment) : attachmentDownloadUrl(attachment);
    missing.push(`${image ? "!" : ""}[${label}](${url})`);
  }
  return missing.length > 0
    ? `${value}${value ? "\n\n" : ""}${missing.join("\n\n")}`
    : value;
}
