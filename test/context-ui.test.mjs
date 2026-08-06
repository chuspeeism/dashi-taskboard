import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const viewSource = await readFile(new URL("../web/src/components/ContextView.tsx", import.meta.url), "utf8").catch(() => "");
const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("context client exposes the ASH-46 DTOs and all endpoints", () => {
  assert.match(typesSource, /ProjectContextEntry/);
  for (const type of ["ProjectContextEntry", "ProjectContextRevision", "ProjectContextListResponse"]) {
    assert.match(typesSource, new RegExp(`interface ${type}`));
  }
  for (const method of [
    "listProjectContext", "getProjectContextBrief", "createProjectContextEntry",
    "getProjectContextEntry", "updateProjectContextEntry", "archiveProjectContextEntry",
    "restoreProjectContextEntry", "listProjectContextRevisions",
  ]) {
    assert.match(apiSource, new RegExp(`export async function ${method}`));
  }
  assert.match(apiSource, /query\.set\("kind"/);
  assert.match(apiSource, /query\.set\("tag"/);
  assert.match(apiSource, /query\.set\("archived"/);
});

test("context view uses safe markdown and preserves drafts on version conflict", () => {
  assert.match(viewSource, /ReactMarkdown/);
  assert.match(viewSource, /remarkGfm/);
  assert.doesNotMatch(viewSource, /dangerouslySetInnerHTML|rehypeRaw/);
  assert.match(viewSource, /getProjectContextEntry/);
  assert.match(viewSource, /VERSION_CONFLICT/);
  assert.match(viewSource, /archived: showArchived \? "all" : "false"/);
  assert.match(viewSource, /sortContextEntries/);
  assert.match(viewSource, /刷新后重试/);
  assert.match(viewSource, /sourceThreadId/);
  assert.match(viewSource, /visibleSourceIdentifier/);
  assert.doesNotMatch(viewSource, /恢复.*Codex|打开.*会话/);
});

test("context view is integrated as an accessible project peer tab", () => {
  assert.match(appSource, /BoardView = "issues" \| "context" \| "workflow"/);
  assert.match(appSource, /ContextView/);
  assert.match(appSource, /boardView === "context"/);
  assert.match(appSource, /context\.created/);
  assert.match(appSource, /局域网模式未启用账号认证/);
  assert.match(styles, /\.context-view/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});
