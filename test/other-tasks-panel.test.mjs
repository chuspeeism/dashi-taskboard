import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const statusSource = await readFile(new URL("../web/src/issueBoardStatuses.ts", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../web/src/components/OtherTasksPanel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

function statusList(name) {
  const match = statusSource.match(new RegExp(`export const ${name} = \\[(.*?)\\] as const`, "s"));
  assert.ok(match, `${name} should be declared as a readonly status list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function cssBlock(selector) {
  const marker = styles.lastIndexOf(`\n${selector} {`);
  assert.notEqual(marker, -1, `${selector} should exist`);
  const start = marker + 1;
  const end = styles.indexOf("\n}", start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 2);
}

test("the issue workspace projects the seven statuses into adaptive main and secondary groups", () => {
  assert.deepEqual(statusList("MAIN_STATUSES"), ["todo", "in_progress", "blocked", "in_review"]);
  assert.deepEqual(statusList("SECONDARY_STATUSES"), ["backlog", "done", "canceled"]);
  assert.match(statusSource, /satisfies readonly TaskStatus\[\]/);
  assert.match(appSource, /const mainStatuses = hasBlockedTasks[\s\S]*?MAIN_STATUSES\.filter\(\(status\) => status !== "blocked"\)/);
  assert.match(appSource, /mainStatuses\.map\(\(status\) => \([\s\S]*?<BoardColumn/);
  assert.match(appSource, /mainStatuses\.map\(\(status\) => \([\s\S]*?className="loading-column"/);
  assert.match(boardColumnSource, /todo: \{ label: "等待认领", tone: "todo" \}/);
  assert.match(boardColumnSource, /in_progress: \{ label: "处理中", tone: "progress" \}/);
  assert.match(boardColumnSource, /blocked: \{ label: "遇到阻碍", tone: "blocked" \}/);
  assert.match(boardColumnSource, /in_review: \{ label: "等你确认", tone: "review" \}/);
});

test("other tasks is a closed-by-default non-modal panel with archived issues", () => {
  assert.match(appSource, /useState\(false\)/);
  assert.match(appSource, /useState<OtherTaskTab>\("backlog"\)/);
  assert.match(statusSource, /OTHER_TASK_TABS = \[[\s\S]*?\.\.\.SECONDARY_STATUSES,[\s\S]*?"archived"/);
  assert.match(appSource, /className=\{`other-tasks-trigger\$\{otherTasksOpen \? " is-open" : ""\}`\}/);
  assert.match(appSource, /aria-controls="other-tasks-panel"/);
  assert.match(appSource, /aria-expanded=\{otherTasksOpen\}/);
  assert.match(appSource, /otherTasksMounted && \([\s\S]*?<OtherTasksPanel/);
  assert.match(appSource, /open=\{otherTasksVisible\}/);
  assert.match(panelSource, /<aside[\s\S]*?id="other-tasks-panel"/);
  assert.match(panelSource, /aria-hidden=\{!open\}/);
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /OTHER_TASK_TABS\.map\(\(tab\) =>/);
  assert.match(panelSource, /aria-selected=\{selected\}/);
  assert.match(panelSource, /tab === "archived" \? archivedTasks\.length : tasksByStatus\[tab\]\.length/);
  assert.match(panelSource, /<ArchivedTaskCard/);
  assert.doesNotMatch(panelSource, /createPortal|role="dialog"|backdrop|overlay/);
  assert.match(cssBlock(".issue-board-layout"), /display: grid/);
  assert.match(cssBlock(".issue-board-layout.has-other-tasks"), /minmax\(0, 1fr\)/);
  assert.match(cssBlock(".other-tasks-panel"), /position: absolute/);
  assert.match(cssBlock(".other-tasks-panel"), /visibility: hidden/);
  assert.match(cssBlock(".other-tasks-panel"), /transform: translateX/);
  assert.match(cssBlock(".other-tasks-panel.is-open"), /visibility: visible/);
  assert.match(cssBlock(".other-tasks-panel.is-open"), /transform: translateX\(0\)/);
});

test("search and filters feed the same status buckets used by the board and panel", () => {
  assert.match(appSource, /const filteredTasks = useMemo\([\s\S]*?matchesTaskSearch\(task, search, language\) && matchesTaskFilters\(task, filters\)/);
  assert.match(appSource, /TASK_STATUSES\.map\(\(status\) => \[status, filteredTasks\.filter\(\(task\) => task\.status === status\)\]\)/);
  assert.match(appSource, /tasks=\{tasksByStatus\[status\]\}/);
  assert.match(appSource, /tasksByStatus=\{tasksByStatus\}/);
  assert.match(appSource, /archivedTasks=\{filteredArchivedTasks\}/);
  assert.match(appSource, /hasActiveFilters=\{hasActiveTaskFilters\}/);
  assert.match(panelSource, /const tasks = archived \? archivedTasks : tasksByStatus\[activeTab\]/);
  assert.match(panelSource, /hasActiveFilters\s*\? text\("当前筛选下无匹配议题", "No issues match the current filters"\)/);
  assert.match(boardColumnSource, /tasks\.length === 0 && <div className="column-empty">\{emptyMessage\}<\/div>/);
});

test("panel cards reuse TaskCard and the existing ranked board drop path", () => {
  assert.match(panelSource, /<TaskCard/);
  assert.match(panelSource, /variant="sidebar"/);
  assert.match(panelSource, /presentation=\{presentations\[task\.id\]\}/);
  assert.match(panelSource, /onEdit=\{onEdit\}/);
  assert.match(panelSource, /onUpdate=\{onUpdate\}/);
  assert.match(panelSource, /onContextMenu=\{onContextMenu\}/);
  assert.match(panelSource, /onDragStart=\{onDragStart\}/);
  assert.match(panelSource, /onDragEnd=\{onDragEnd\}/);
  assert.match(panelSource, /onOpenConversation=\{onOpenConversation\}/);
  assert.equal(appSource.match(/onDragStart=\{startTaskDrag\}/g)?.length, 2);
  assert.equal(appSource.match(/onDragEnd=\{endTaskDrag\}/g)?.length, 2);
  assert.match(boardColumnSource, /findDropBefore\(event\.currentTarget, event\.clientY\)/);
  assert.match(boardColumnSource, /onDrop\(status, taskId, findDropBefore/);
  assert.match(panelSource, /findDropBefore\(event\.currentTarget, event\.clientY\)/);
  assert.match(panelSource, /onDrop\(activeTab, taskId, findDropBefore/);
  assert.match(panelSource, /busy=\{restoringTaskId !== null \|\| deletingTaskId !== null\}/);
  assert.match(appSource, /onDrop=\{finishTaskDrop\}/);
  assert.match(appSource, /moveTask\(task, destination, beforeTaskId, true\)/);
});

test("global creation defaults to todo while per-column creation keeps the chosen status", () => {
  assert.equal(appSource.match(/setEditor\(\{ task: null, status: "todo" \}\)/g)?.length, 2);
  assert.doesNotMatch(appSource, /setEditor\(\{ task: null, status: "backlog" \}\)/);
  assert.match(appSource, /onCreate=\{\(initialStatus\) => setEditor\(\{ task: null, status: initialStatus \}\)\}/);
});

test("legacy empty-column and manual visibility runtime paths are removed", async () => {
  assert.doesNotMatch(appSource, /showEmptyColumns|visibleStatuses|hiddenStatuses|columnVisibility|SHOW_EMPTY_COLUMNS_KEY|COLUMN_VISIBILITY_KEY/);
  assert.doesNotMatch(boardColumnSource, /ColumnVisibilityMenu|onHide|隐藏列/);
  assert.doesNotMatch(styles, /\.hidden-columns|\.hidden-column-|\.column-visibility-|\.column-menu|\.board-settings-trigger|\.board-settings-menu|\.board-filter-empty/);
  assert.match(styles, /\.board-setting-switch \{/);

  await assert.rejects(access(new URL("../web/src/components/HiddenColumns.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../web/src/components/BoardSettingsMenu.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../web/src/components/ColumnVisibilityMenu.tsx", import.meta.url)));
});

test("the adaptive desktop grid fills available width and degrades to horizontal scrolling", () => {
  assert.match(cssBlock(".board"), /display: grid/);
  assert.match(cssBlock(".board"), /grid-template-columns: repeat\(var\(--main-column-count, 3\), minmax\(300px, 1fr\)\)/);
  assert.match(cssBlock(".board"), /width: 100%/);
  assert.match(cssBlock(".board"), /min-width: var\(--main-board-min-width, 948px\)/);
  assert.match(cssBlock(".board-scroll"), /overflow-x: auto/);
  assert.match(cssBlock(".board-scroll"), /overflow-y: hidden/);
  assert.match(cssBlock(".column-list"), /overflow-y: auto/);
  assert.match(styles, /@media \(max-width: 719px\)[\s\S]*?\.board \{[\s\S]*?display: flex[\s\S]*?width: max-content/);
  assert.match(styles, /@media \(max-width: 719px\)[\s\S]*?\.board-column \{[\s\S]*?flex: 0 0 300px/);
  assert.match(styles, /@media \(max-width: 719px\)[\s\S]*?\.other-tasks-panel \{[\s\S]*?width: 300px/);
});
