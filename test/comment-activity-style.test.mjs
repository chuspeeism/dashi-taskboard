import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("comment floors use Linear-style cards with the author inside the card", () => {
  assert.match(
    detailSource,
    /<div className="comment-card">\s*<header className="comment-header">\s*<ActorAvatar/s,
  );
  assert.match(styles, /\.comment-entry\s*\{[^}]*display:\s*block;/s);
  assert.doesNotMatch(styles, /\.activity-stream::before/);
  assert.match(
    styles,
    /\.comment-card\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*var\(--surface-muted\);[^}]*box-shadow:\s*none;/s,
  );
  assert.match(styles, /\.comment-header \.comment-avatar\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
});

test("comment body renders document formatting at Linear typography", () => {
  assert.match(
    detailSource,
    /comment\.body && \(\s*<div className="comment-body">\s*<DescriptionDocument\s*value=\{comment\.body\}\s*referenceTasks=\{referenceTasks\}\s*onOpenTask=\{onOpenTask\}\s*attachments=\{comment\.attachments\}\s*enableImagePreview\s*onOpenAttachment=\{handleAttachmentDownload\}\s*\/>\s*<\/div>\s*\)/s,
  );
  assert.match(styles, /\.comment-body\s*\{[^}]*font-size:\s*15px;[^}]*line-height:\s*24px;/s);
  assert.match(styles, /\.comment-body \.issue-description-document\s*\{/);
});

test("comment composer aligns with the full comment floor width", () => {
  assert.match(styles, /\.comment-composer\s*\{[^}]*margin:\s*18px 0 0;/s);
  assert.match(
    styles,
    /\.comment-composer\s*\{[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*0 1px 2px rgba\(0, 0, 0, 0\.035\);/s,
  );
  assert.match(styles, /\.composer-footer\s*\{[^}]*border-top:\s*var\(--border-hairline\) solid var\(--border\);/s);
});
