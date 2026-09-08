import { attachmentContentUrl, attachmentDownloadUrl } from "./api";
import type { Attachment } from "./types";
import type { PendingInlineAttachment, PendingInlineImage } from "./documentModel";

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
