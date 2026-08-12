import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../web/src/components/WorkflowBoard.tsx", import.meta.url), "utf8");
const workflowNodeSource = await readFile(new URL("../web/src/components/WorkflowNode.tsx", import.meta.url), "utf8");
const inspectorSource = await readFile(new URL("../web/src/components/WorkflowInspector.tsx", import.meta.url), "utf8");
const pickerSource = await readFile(new URL("../web/src/components/WorkflowStepPicker.tsx", import.meta.url), "utf8");
const catalogSource = await readFile(new URL("../web/src/components/workflowCatalog.ts", import.meta.url), "utf8");
const workflowStoreSource = await readFile(new URL("../web/src/workflowStore.ts", import.meta.url), "utf8");
const databaseSource = await readFile(new URL("../server/database.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/components/workflow.css", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("the taskboard defaults to issues and exposes the current project views", () => {
  assert.match(appSource, /type BoardView = "dashboard" \| "issues" \| "list" \| "gantt" \| "workflow"/);
  assert.match(
    appSource,
    /function readProjectBoardView\(projectId: string\): BoardView \{\s*const view = [^;]+;\s*return [\s\S]*?\? view\s*: "issues";\s*\}/,
  );
  assert.match(appSource, /useState<BoardView>\(\(\) => readProjectBoardView\(initialProjectId\)\)/);
  assert.match(appSource, />\s*\{text\("仪表盘", "Dashboard"\)\}\s*<\/button>/);
  assert.match(appSource, />\s*\{text\("议题看板", "Issue board"\)\}\s*<\/button>/);
  assert.match(appSource, />\s*\{text\("列表视图", "List"\)\}\s*<\/button>/);
  assert.match(appSource, />\s*\{text\("甘特图", "Gantt"\)\}\s*<\/button>/);
  assert.match(appSource, /aria-pressed=\{boardView === "issues"\}/);
  assert.match(appSource, /onClick=\{\(\) => selectBoardView\("issues"\)\}/);
  assert.match(appSource, /const SHOW_WORKFLOW_BOARD_ENTRY = false/);
  assert.match(appSource, /SHOW_WORKFLOW_BOARD_ENTRY && \([\s\S]*?>\s*\{text\("节点模式", "Workflow"\)\}\s*<\/button>/);
  assert.match(appSource, /function changeProject[\s\S]*?setBoardView\(readProjectBoardView\(projectId\)\)/);
  assert.doesNotMatch(appSource, /<span>活跃<\/span>|<span>积压事项<\/span>|所有议题|add-view/);
});

test("secondary views lazy-load while issue controls remain isolated", () => {
  assert.match(appSource, /lazy\(\(\) => import\("\.\/components\/WorkflowBoard"\)/);
  assert.match(appSource, /lazy\(\(\) => import\("\.\/components\/GanttView"\)/);
  assert.match(appSource, /\(boardView === "issues" \|\| boardView === "list" \|\| boardView === "gantt"\) && <div className="toolbar-tools">/);
  assert.match(appSource, /boardView === "issues" && \([\s\S]*?className=\{`other-tasks-trigger/);
  assert.match(appSource, /boardView === "workflow" \? \([\s\S]*?<Suspense[\s\S]*?<WorkflowBoard/);
  assert.match(appSource, /projectId=\{selectedProject\?\.id \?\? GLOBAL_PROJECT_ID\}/);
  assert.match(appSource, /onWorkflowsChange=\{setWorkflowOptions\}/);
  assert.match(workflowSource, /export function WorkflowBoard\(/);
  assert.match(workflowSource, /from "@xyflow\/react"/);
  assert.match(workflowSource, /aria-label=\{text\("流程编排区", "Workflow canvas"\)\}/);
  assert.match(workflowSource, /nodesConnectable=\{false\}/);
  assert.match(workflowSource, /connectOnClick=\{false\}/);
  assert.doesNotMatch(workflowSource, /MiniMap|onConnect=|aria-label="节点库"|workflow-library/);
  assert.match(styles, /\.workflow-board/);
  assert.match(globalStyles, /\.workflow-node/);
  assert.doesNotMatch(appSource, /workflow-board-placeholder|具体功能将在后续开发/);
});

test("the workflow catalog retains the real trigger, capability, API, integration, planning and result steps", () => {
  for (const label of [
    "Issue",
    "Skill",
    "MCP",
    "Nano Banana 生图",
    "即梦生图",
    "Midjourney 生图",
    "Seedance 2.0 生视频",
    "可灵生视频",
    "Git",
    "飞书文档",
    "OpenCLI",
    "Claude Design 设计",
    "Cloudflare 部署",
    "Vercel 部署",
    "基础规划",
    "Claude Code 规划",
    "自定义规划",
    "Codex 审核",
    "Claude Code 审核",
  ]) {
    assert.match(catalogSource, new RegExp(label));
  }
  assert.match(catalogSource, /const GIT_LOGO = "https:\/\/git-scm\.com\/images\/logos\/downloads\/Git-Icon-1788C\.svg"/);
  assert.doesNotMatch(catalogSource, /读取任务上下文|获取项目上下文|Codex 任务/);
  assert.doesNotMatch(workflowSource, /这是工作流 UI 示意|仅保存在当前页面|后续实现|将在后续接入/);
});

test("workflow tabs switch independent sequences, create blank workflows and rename in place", () => {
  assert.match(workflowSource, /interface WorkflowSnapshot[\s\S]*?nodes: WorkflowCanvasNode\[\][\s\S]*?flow: WorkflowFlow[\s\S]*?selectedNodeId/);
  assert.match(workflowSource, /const \[workflowTabs, setWorkflowTabs\] = useState<WorkflowTab\[\]>/);
  assert.match(workflowSource, /function activateWorkflow[\s\S]*?setNodes\(snapshot\.nodes\)[\s\S]*?setFlow\(snapshot\.flow\)/);
  assert.match(workflowSource, /function createWorkflow[\s\S]*?createWorkflowFlow\(\)[\s\S]*?nodes: \[\][\s\S]*?flow: emptyFlow[\s\S]*?setWorkflowTabs/);
  assert.match(workflowSource, /className="workflow-tabs"[\s\S]*?role="tablist"[\s\S]*?aria-label=\{text\(/);
  assert.match(workflowSource, /role="tab"[\s\S]*?aria-selected=\{active\}/);
  assert.match(workflowSource, /function handleWorkflowTabKeyDown[\s\S]*?ArrowLeft[\s\S]*?ArrowRight[\s\S]*?Home[\s\S]*?End/);
  assert.match(workflowSource, /aria-label=\{text\("新建流程", "Create workflow"\)\}/);
  assert.match(workflowSource, /const \[renamingWorkflowId, setRenamingWorkflowId\] = useState/);
  assert.match(workflowSource, /onDoubleClick=\{\(\) => startWorkflowRename\(workflow\)\}/);
  assert.match(workflowSource, /aria-label=\{text\("流程名称", "Workflow name"\)\}[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "Escape"/);
  assert.match(styles, /\.workflow-tab\.is-active \{[\s\S]*?border-bottom: 0[\s\S]*?background: var\(--bg\)/);
  assert.doesNotMatch(styles, /\.workflow-tab\.is-active::after/);
});

test("workflow tab context menu opens at the pointer and closes through established interactions", () => {
  assert.match(
    workflowSource,
    /function openWorkflowTabMenu[\s\S]*?event\.preventDefault\(\)[\s\S]*?clientX[\s\S]*?clientY/,
  );
  assert.match(
    workflowSource,
    /onContextMenu=\{\(event\) => openWorkflowTabMenu\(event, workflow\.id\)\}/,
  );
  assert.match(
    workflowSource,
    /className="task-context-menu workflow-tab-context-menu"[\s\S]*?role="menu"[\s\S]*?role="menuitem"[\s\S]*?<LinearIcon name="trash" \/>[\s\S]*?删除流程/,
  );
  assert.match(
    workflowSource,
    /getBoundingClientRect\(\)[\s\S]*?Math\.max\(8, Math\.min\(workflowTabMenu\.x, window\.innerWidth - rect\.width - 8\)\)[\s\S]*?Math\.max\(8, Math\.min\(workflowTabMenu\.y, window\.innerHeight - rect\.height - 8\)\)/,
  );
  assert.match(
    workflowSource,
    /document\.addEventListener\("pointerdown", closeWorkflowTabMenuFromOutside\)[\s\S]*?event\.key === "Escape"[\s\S]*?setWorkflowTabMenu\(null\)/,
  );
  assert.match(
    workflowSource,
    /function activateWorkflow[\s\S]*?setWorkflowTabMenu\(null\)[\s\S]*?if \(workflowId === activeWorkflowId\) return/,
  );
});

test("workflow deletion preserves inactive state, selects the right active neighbor and persists snapshots", () => {
  const deleteWorkflowSource = workflowSource.slice(
    workflowSource.indexOf("  function deleteWorkflow("),
    workflowSource.indexOf("  function handleWorkflowTabKeyDown("),
  );
  const inactiveDeleteBranch = deleteWorkflowSource.match(
    /if \(workflowId !== activeWorkflowId\) \{([\s\S]*?)\n    \}/,
  )?.[1] ?? "";
  assert.match(
    workflowSource,
    /function deleteWorkflow[\s\S]*?if \(workflowTabs\.length <= 1\) return/,
  );
  assert.match(
    workflowSource,
    /const workflowIndex = workflowTabs\.findIndex[\s\S]*?workflowSnapshotsRef\.current\.delete\(workflowId\)/,
  );
  assert.match(
    workflowSource,
    /if \(workflowId !== activeWorkflowId\) \{[\s\S]*?setWorkflowTabs\(nextTabs\)[\s\S]*?setWorkflowTabMenu\(null\)[\s\S]*?return;[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    inactiveDeleteBranch,
    /setActiveWorkflowId|setNodes|setFlow|setSelectedNodeId|setPickerTarget|setRenamingWorkflowId/,
  );
  assert.match(
    workflowSource,
    /const replacement = workflowTabs\[workflowIndex \+ 1\] \?\? workflowTabs\[workflowIndex - 1\][\s\S]*?normalizeSnapshot\(workflowSnapshotsRef\.current\.get\(replacement\.id\)!\)/,
  );
  assert.match(
    workflowSource,
    /setActiveWorkflowId\(replacement\.id\)[\s\S]*?setNodes\(snapshot\.nodes\)[\s\S]*?setFlow\(snapshot\.flow\)[\s\S]*?setSelectedNodeId\(null\)[\s\S]*?setPickerTarget\(null\)[\s\S]*?setRenamingWorkflowId\(null\)/,
  );
  assert.match(
    workflowSource,
    /disabled=\{workflowTabs\.length === 1\}[\s\S]*?aria-disabled=\{workflowTabs\.length === 1\}/,
  );
  assert.match(
    workflowSource,
    /serializeWorkflowWorkspace\([\s\S]*?workflowTabs,[\s\S]*?activeWorkflowId,[\s\S]*?workflowSnapshotsRef\.current[\s\S]*?saveWorkflowWorkspace\(/,
  );
  assert.doesNotMatch(workflowSource, /localStorage|deleteWorkflowWorkspace|confirm\(/);
});

test("workflow edits persist per project and continue to synchronize through the shared service", () => {
  assert.match(workflowSource, /export function WorkflowBoard\(/);
  assert.match(appSource, /const \[workflowRevision, setWorkflowRevision\] = useState\(0\)/);
  assert.match(appSource, /event\.type === "workflow\.updated"[\s\S]*?setWorkflowRevision\(\(current\) => current \+ 1\)/);
  assert.match(appSource, /<WorkflowBoard[\s\S]*?revision=\{workflowRevision\}/);
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS workflow_workspaces/);
  assert.match(databaseSource, /saveWorkflowWorkspace\(projectId, expectedVersion, workspace\)/);
  assert.match(serverSource, /\/workflow-workspace/);
  assert.match(serverSource, /events\.emit\("workflow\.updated"/);
  assert.match(apiSource, /export async function getWorkflowWorkspace/);
  assert.match(apiSource, /export async function saveWorkflowWorkspace/);
  assert.match(workflowStoreSource, /WORKFLOW_STATE_KEY_PREFIX = "taskboard\.workflow\.workspace\."/);
  assert.match(workflowSource, /getWorkflowWorkspace<WorkflowWorkspace>\(projectId/);
  assert.match(workflowSource, /saveWorkflowWorkspace\([\s\S]*?remoteVersionRef\.current/);
  assert.match(workflowSource, /saveQueueRef\.current = saveQueueRef\.current\.then/);
  assert.match(workflowSource, /mergeLegacyWorkspace/);
  assert.doesNotMatch(workflowSource, /resetLayout|重置布局/);
});

test("issue workflow choices read the shared service workspace without loading React Flow", () => {
  assert.match(workflowStoreSource, /INITIAL_WORKFLOW_ID = "issue-delivery"/);
  assert.match(workflowStoreSource, /INITIAL_WORKFLOW_NAME = "议题处理与交付"/);
  assert.match(workflowStoreSource, /export function workflowOptionsFromWorkspace\(workspace: unknown\)/);
  assert.match(appSource, /getWorkflowWorkspace<unknown>\(projectId, signal\)/);
  assert.match(appSource, /event\.type === "workflow\.updated"/);
  assert.match(appSource, /refreshWorkflowOptions\(selectedProjectId\)/);
  assert.match(appSource, /const WorkflowBoard = lazy/);
  assert.doesNotMatch(appSource, /import \{ WorkflowBoard \} from|from "@xyflow\/react"/);
  assert.doesNotMatch(appSource, /from "\.\/components\/WorkflowBoard".*workflowStorageKey/);
});

test("the on-demand inspector exposes real capabilities and the existing node configuration", () => {
  assert.doesNotMatch(workflowSource, /const AVAILABLE_SKILLS/);
  assert.match(apiSource, /export async function listWorkflowCapabilities[\s\S]*?\/api\/workflow-capabilities/);
  assert.match(typesSource, /export interface WorkflowCapabilities[\s\S]*?skills: WorkflowCapabilityOption\[\][\s\S]*?mcpServers: WorkflowMcpServerOption\[\]/);
  assert.match(workflowSource, /listWorkflowCapabilities\(workspacePath, controller\.signal\)/);
  assert.match(inspectorSource, /aria-label=\{text\("可用 Skill", "Available Skills"\)\}/);
  assert.match(inspectorSource, /capabilities\?\.skills/);
  assert.match(inspectorSource, /text\("未发现可用 Skill", "No available Skills found"\)/);
  assert.match(inspectorSource, /aria-label=\{text\("可用 MCP Server", "Available MCP Servers"\)\}/);
  assert.match(inspectorSource, /capabilities\?\.mcpServers/);
  assert.match(inspectorSource, /text\("未发现可用 MCP Server", "No available MCP Servers found"\)/);
  assert.match(inspectorSource, /aria-label=\{text\("Claude Code 模型", "Claude Code model"\)\}/);
  assert.match(inspectorSource, /Claude Sonnet[\s\S]*?Claude Opus[\s\S]*?Claude Haiku/);
  assert.match(inspectorSource, /text\("推理强度", "Reasoning effort"\)/);
  assert.match(inspectorSource, /text\("规划要求", "Planning requirements"\)/);
  assert.match(inspectorSource, /text\("议题选择", "Issue selection"\)/);
  for (const action of ["改变状态", "添加评论", "添加标签", "设置优先级", "附加流程运行产物", "记录执行该议题的 Codex 对话"]) {
    assert.match(inspectorSource, new RegExp(action));
  }
  assert.match(inspectorSource, /text\("额外说明", "Additional instructions"\)/);
  assert.match(workflowSource, /selectedNode && \([\s\S]*?<WorkflowInspector/);
});

test("Git and issue configuration render the selected action in each step title", () => {
  for (const action of ["查看状态", "提交更改", "拉取更新", "推送分支", "创建分支", "切换分支", "合并分支", "创建 Worktree"]) {
    assert.match(catalogSource, new RegExp(action));
  }
  assert.match(inspectorSource, /aria-label=\{text\("Git 操作", "Git operation"\)\}/);
  assert.match(inspectorSource, /aria-label=\{text\("Git 提交说明", "Git commit message"\)\}/);
  assert.match(inspectorSource, /aria-label=\{text\("Git 远程仓库", "Git remote"\)\}/);
  assert.match(inspectorSource, /aria-label=\{text\("Git Worktree 分支", "Git worktree branch"\)\}/);
  assert.match(inspectorSource, /aria-label=\{text\("Git Worktree 目录", "Git worktree directory"\)\}/);
  assert.match(inspectorSource, /aria-label=\{text\("议题触发状态", "Issue trigger status"\)\}/);
  assert.match(catalogSource, /function workflowNodeDisplayTitle[\s\S]*?data\.kind === "git"[\s\S]*?data\.kind === "issue-trigger"[\s\S]*?data\.kind === "issue-update"/);
  assert.match(workflowSource, /displayTitle: workflowNodeDisplayTitle\(node\.data, text\)/);
  assert.match(workflowNodeSource, /data\.displayTitle \?\? data\.title/);
});

test("the execution plan keeps compact ordered items with drag preview and settling animation", () => {
  assert.match(catalogSource, /kind: "basic-planning"[\s\S]*?acceptsChildren: true/);
  assert.match(workflowSource, /parentId: "basic-planning"/);
  assert.match(workflowSource, /interface PlanDragPreview[\s\S]*?sourceOrderIds: string\[\][\s\S]*?targetIndex: number/);
  assert.match(workflowSource, /function planDragShift[\s\S]*?targetIndex > preview\.sourceIndex[\s\S]*?-distance[\s\S]*?targetIndex < preview\.sourceIndex[\s\S]*?distance/);
  assert.match(workflowSource, /function reorderPlanItem/);
  assert.match(workflowSource, /setSettlingNodeId\(node\.id\)/);
  assert.match(workflowSource, /onNodeDragStart=\{onNodeDragStart\}[\s\S]*?onNodeDrag=\{onNodeDrag\}[\s\S]*?onNodeDragStop=\{onNodeDragStop\}/);
  assert.match(workflowNodeSource, /workflow-node-compact/);
  assert.match(workflowNodeSource, /is-drag-shifted[\s\S]*?is-settling[\s\S]*?translate3d\(0, \$\{data\.dragShiftY\}px, 0\)/);
  assert.match(globalStyles, /\.workflow-node-compact \{[\s\S]*?transform 160ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  assert.match(globalStyles, /\.workflow-node-compact\.is-settling/);
});

test("steps are inserted from sequence connectors through a searchable grouped chooser", () => {
  assert.match(workflowSource, /const openStepPicker = useCallback/);
  assert.match(workflowSource, /deriveWorkflowLayout\(flow, nodes\)/);
  assert.match(workflowSource, /edge\.data\.insertion[\s\S]*?openStepPicker\([\s\S]*?sequenceRef[\s\S]*?index/);
  assert.match(
    workflowSource,
    /insertWorkflowNode\([\s\S]*?pickerTarget\.sequenceRef[\s\S]*?pickerTarget\.index/,
  );
  assert.match(workflowSource, /aria-label=\{text\("添加第一个步骤", "Add the first step"\)\}/);
  assert.match(pickerSource, /role="dialog"/);
  assert.match(pickerSource, /placeholder=\{text\("搜索应用或动作…", "Search apps or actions…"\)\}/);
  assert.match(pickerSource, /onSelect\(item\)/);
});
