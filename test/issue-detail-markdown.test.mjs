import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);
const markdownSource = await readFile(
  new URL("../web/src/components/MarkdownDocument.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

test("issue detail renders descriptions and comments with GFM markdown", () => {
  assert.equal(typeof packageJson.dependencies["react-markdown"], "string");
  assert.equal(typeof packageJson.dependencies["remark-gfm"], "string");
  assert.match(markdownSource, /import ReactMarkdown/);
  assert.match(markdownSource, /import remarkGfm from "remark-gfm";/);
  assert.match(
    markdownSource,
    /<ReactMarkdown[\s\S]*remarkPlugins=\{\[remarkGfm, remarkStripMarkdownComments, remarkBreaks\]\}[\s\S]*>\s*\{value\}\s*<\/ReactMarkdown>/,
  );
  assert.match(
    detailSource,
    /\{description\s*\?\s*<DescriptionDocument\s*value=\{description\}\s*referenceTasks=\{referenceTasks\}\s*onOpenTask=\{onOpenTask\}\s*attachments=\{attachments\}\s*enableImagePreview\s*onOpenAttachment=\{handleAttachmentDownload\}\s*\/>\s*:\s*text\("添加描述…", "Add description…"\)\}/,
  );
  assert.match(
    detailSource,
    /comment\.body && \(\s*<div className="comment-body">\s*<DescriptionDocument\s*value=\{comment\.body\}\s*referenceTasks=\{referenceTasks\}\s*onOpenTask=\{onOpenTask\}\s*attachments=\{comment\.attachments\}\s*enableImagePreview\s*onOpenAttachment=\{handleAttachmentDownload\}\s*\/>\s*<\/div>\s*\)/s,
  );
  assert.doesNotMatch(detailSource, /value\.split\("\\n"\)/);
});

test("issue detail safely hides Markdown comments and renders Mermaid diagrams lazily", () => {
  assert.equal(typeof packageJson.dependencies.mermaid, "string");
  assert.equal(typeof packageJson.dependencies.dompurify, "string");
  assert.match(markdownSource, /function remarkStripMarkdownComments/);
  assert.match(markdownSource, /remarkPlugins=\{\[remarkGfm, remarkStripMarkdownComments, remarkBreaks\]\}/);
  assert.match(markdownSource, /function MarkdownPre/);
  assert.match(markdownSource, /function MermaidDiagram/);
  assert.match(markdownSource, /import\("mermaid"\)/);
  assert.match(markdownSource, /import\("dompurify"\)/);
  assert.match(markdownSource, /securityLevel:\s*"strict"/);
  assert.match(markdownSource, /suppressErrorRendering:\s*true/);
  assert.match(markdownSource, /FORBID_TAGS/);
  assert.match(markdownSource, /foreignObject/);
  assert.match(markdownSource, /"script"/);
  assert.match(markdownSource, /dangerouslySetInnerHTML/);
  assert.match(markdownSource, /Mermaid source/);
  assert.doesNotMatch(markdownSource, /rehypeRaw/);
});

test("issue detail keeps ordinary code blocks and the Mermaid fallback readable in both themes", () => {
  assert.match(markdownSource, /language === "mermaid"/);
  assert.match(markdownSource, /return <pre \{\.\.\.props\}>\{children\}<\/pre>/);
  assert.match(markdownSource, /theme === "dark" \? "dark" : "default"/);
  for (const selector of [
    ".issue-description-document .markdown-mermaid",
    ".issue-description-document .markdown-mermaid-fallback",
    ':root[data-theme="dark"] .issue-description-document .markdown-mermaid',
  ]) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("issue detail markdown styles cover rich document elements", () => {
  for (const selector of [
    ".issue-description-document blockquote",
    ".issue-description-document pre",
    ".issue-description-document table",
    ".issue-description-document a",
    ".issue-description-document img",
    ".issue-description-document input[type=\"checkbox\"]",
  ]) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the configured markdown renderer produces CommonMark and GFM elements", () => {
  const markdown = [
    "**粗体**和[链接](https://example.com)",
    "",
    "> 引用",
    "",
    "- [x] 已完成",
    "- [ ] 未完成",
    "",
    "~~删除线~~",
    "",
    "| 名称 | 状态 |",
    "| --- | --- |",
    "| Taskboard | Ready |",
    "",
    "```js",
    "const ready = true;",
    "```",
  ].join("\n");
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown),
  );

  for (const element of ["strong", "a", "blockquote", "input", "del", "table", "pre", "code"]) {
    assert.match(html, new RegExp(`<${element}(?: |>)`));
  }
});
