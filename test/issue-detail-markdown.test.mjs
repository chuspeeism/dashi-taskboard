import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
