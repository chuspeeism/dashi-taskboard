import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const relationsSource = await readFile(new URL("../web/src/components/IssueRelations.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const skillSource = await readFile(new URL("../skills/manage-taskboard/SKILL.md", import.meta.url), "utf8");
const cliReference = await readFile(new URL("../skills/manage-taskboard/references/cli.md", import.meta.url), "utf8");

test("tasks expose one parent plus directional and symmetric issue relations", () => {
  assert.match(typesSource, /export type IssueRelationType = "parent" \| "blocks" \| "blocked_by" \| "related"/);
  assert.match(typesSource, /export interface TaskRelationSummary \{/);
  assert.match(typesSource, /export interface TaskRelations \{[\s\S]*?parent: TaskRelationSummary \| null/);
  assert.match(typesSource, /subIssues: TaskRelationSummary\[\]/);
  assert.match(typesSource, /blockedBy: TaskRelationSummary\[\]/);
  assert.match(typesSource, /blocks: TaskRelationSummary\[\]/);
  assert.match(typesSource, /related: TaskRelationSummary\[\]/);
  assert.match(typesSource, /export interface Task \{[\s\S]*?relations: TaskRelations/);
});

test("the web client mutates issue relations with optimistic concurrency", () => {
  assert.match(apiSource, /export async function addTaskRelation/);
  assert.match(apiSource, /export async function removeTaskRelation/);
  assert.match(apiSource, /\/relations\/\$\{type\}\/\$\{encodeURIComponent\(relatedTaskId\)\}/);
  assert.match(apiSource, /version: task\.version/);
  assert.match(appSource, /"task\.relation\.updated"/);
  assert.match(appSource, /onAddRelation=/);
  assert.match(appSource, /onRemoveRelation=/);
});

test("issue details mirror Linear parent, sub-issue, dependency, and related sections", () => {
  assert.match(detailSource, /<IssueParentLink/);
  assert.match(detailSource, /<IssueSubIssues/);
  assert.match(detailSource, /<IssueRelationSidebar/);
  assert.match(relationsSource, /\{text\("子议题", "Sub-issues"\)\}/);
  assert.match(relationsSource, /chineseLabel: "阻塞于", englishLabel: "Blocked by"/);
  assert.match(relationsSource, /chineseLabel: "阻塞", englishLabel: "Blocks"/);
  assert.match(relationsSource, /chineseLabel: "相关议题", englishLabel: "Related issues"/);
  assert.match(relationsSource, /placeholder=\{text\("搜索议题…", "Search issues…"\)\}/);
  assert.match(relationsSource, /role="combobox"/);
  assert.match(relationsSource, /role="listbox"/);
  assert.match(relationsSource, /<StatusIcon status=\{candidate\.status\} \/>/);
  assert.match(relationsSource, /onOpenTask/);
  assert.match(relationsSource, /onRemoveRelation/);
  assert.match(styles, /\.issue-relation-picker/);
  assert.match(styles, /\.issue-sub-issues/);
  assert.match(styles, /\.issue-relation-sidebar/);
});

test("board cards leave relation context in issue details", () => {
  assert.doesNotMatch(cardSource, /task\.relations/);
  assert.doesNotMatch(cardSource, /sub-issue-progress|blocked-by-count/);
});

test("the taskboard skill tracks substantive requests before implementation", () => {
  assert.match(skillSource, /new durable requirement[\s\S]*search existing project issues before creating one/i);
  assert.match(skillSource, /Update a matching issue instead of creating a duplicate/i);
  assert.match(skillSource, /Do not track trivial requests/i);
  assert.match(skillSource, /Use parent for contained work/i);
  assert.match(skillSource, /blocks or blocked_by for dependencies/i);
  assert.match(skillSource, /related for close association/i);
  assert.match(cliReference, /issue relation add/);
  assert.match(cliReference, /--type parent/);
  assert.match(cliReference, /--type blocks\|blocked_by\|related/);
});
