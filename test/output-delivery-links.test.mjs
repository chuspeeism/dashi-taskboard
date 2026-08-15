import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = path.join(projectRoot, "outputs/dashi-taskboard-apple-a");
const sourceIndex = path.join(projectRoot, "docs/DELIVERY-APPLE-LIGHT-A.zh-CN.md");
const outputIndex = path.join(outputRoot, "README.zh-CN.md");

function relativeMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
}

test("delivery README is the dedicated source index", async () => {
  assert.equal(await readFile(outputIndex, "utf8"), await readFile(sourceIndex, "utf8"));
});

test("every delivery Markdown link stays inside the package and exists", async () => {
  const markdownFiles = [
    outputIndex,
    path.join(outputRoot, "INSTALL-APPLE-LIGHT-A.zh-CN.md"),
    path.join(outputRoot, "apple-light-a-qa.md"),
  ];

  for (const markdownFile of markdownFiles) {
    const markdown = await readFile(markdownFile, "utf8");
    for (const target of relativeMarkdownLinks(markdown)) {
      const cleanTarget = decodeURIComponent(target.split("#", 1)[0]);
      const resolved = path.resolve(path.dirname(markdownFile), cleanTarget);
      assert.ok(
        resolved === outputRoot || resolved.startsWith(`${outputRoot}${path.sep}`),
        `${path.relative(outputRoot, markdownFile)} link escapes delivery: ${target}`,
      );
      await access(resolved);
    }
  }
});
