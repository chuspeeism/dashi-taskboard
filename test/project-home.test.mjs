import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const pendingAttachmentsSource = await readFile(new URL("../web/src/components/PendingAttachments.tsx", import.meta.url), "utf8");
const labelsSource = await readFile(new URL("../web/src/labels.ts", import.meta.url), "utf8");

test("the project switcher merges live Codex projects with persisted Taskboard projects", () => {
  assert.match(appSource, /hostContext\?\.projects \?\? \[\]/);
  assert.match(appSource, /persistedById/);
  assert.match(appSource, /name: project\.id === GLOBAL_PROJECT_ID\s*\? text\("臨時任務", "Temporary tasks"\)\s*: persistedById\.get\(project\.id\)\?\.name \?\? project\.name/);
  assert.match(appSource, /for \(const project of projects\) \{[\s\S]*?inCodex: false,[\s\S]*?persisted: true/);
  assert.match(appSource, /projectMenuChoices\.map\(\(project\) => \(/);
  assert.match(appSource, /createProjectRequest/);
  assert.match(apiSource, /export async function createProject/);
});

test("each device stores an independent workspace path for every project", () => {
  assert.match(appSource, /const DEVICE_WORKSPACE_PATHS_KEY = "taskboard\.deviceWorkspacePaths\.v1"/);
  assert.match(appSource, /function readDeviceWorkspacePaths\(\)/);
  assert.match(appSource, /rememberDeviceWorkspacePath/);
  assert.match(appSource, /const \[nextProjects, metadata, workspaces\] = await Promise\.all\(\[/);
  assert.match(appSource, /listDeviceWorkspaces\(signal\)/);
  assert.match(appSource, /const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID[\s\S]*?: deviceWorkspacePaths\[selectedProjectId\]/);
  assert.match(appSource, /listDevelopmentContexts\([\s\S]*?selectedDeviceWorkspacePath,[\s\S]*?\)/);
  assert.match(apiSource, /query\.set\("workspacePath", workspacePath\)/);
  assert.match(apiSource, /\/api\/device-workspaces/);
});

test("imported Codex projects persist their exact device identity", () => {
  assert.match(appSource, /const PROJECT_CODEX_IDENTITIES_KEY = "taskboard\.projectCodexIdentities\.v1"/);
  assert.match(appSource, /codexProjectId: project\.id,[\s\S]*?codexProjectKind: project\.projectKind,[\s\S]*?codexHostId: project\.hostId,[\s\S]*?workspacePath: project\.workspacePath/);
  assert.match(appSource, /setProjectCodexIdentities[\s\S]*?PROJECT_CODEX_IDENTITIES_KEY/);
});

test("project selection starts from the route or recent projects and updates the route", () => {
  assert.match(appSource, /const RECENT_PROJECT_IDS_KEY = "taskboard\.recentProjectIds\.v1"/);
  assert.match(appSource, /const initialProjectId = query\.get\("project"\) \?\? recentProjectIds\[0\] \?\? ALL_PROJECTS_ID/);
  assert.match(appSource, /const rememberProjectOpen = useCallback/);
  assert.match(appSource, /taskboardStorage\.setItem\(RECENT_PROJECT_IDS_KEY, JSON\.stringify\(next\)\)/);
  assert.match(appSource, /function changeProject\(projectId: string\)/);
  assert.match(appSource, /setSelectedProjectId\(projectId\)/);
  assert.match(appSource, /const url = buildIssueUrl\(window\.location\.href, projectId, null\)/);
  assert.match(appSource, /window\.history\.replaceState\(null, "", url\)/);
});

test("the selected project exposes the current board surfaces", () => {
  assert.match(appSource, /<header className="workspace-header">/);
  assert.match(appSource, /<div className="board-toolbar">/);
  assert.match(appSource, /<DashboardView/);
  assert.match(appSource, /<IssueListView/);
  assert.match(appSource, /<GanttView/);
  assert.match(appSource, /<BoardColumn/);
  assert.match(styles, /\.workspace-header \{[\s\S]*?border-bottom: var\(--border-hairline\) solid var\(--border\)/);
});

test("new issues stage attachments in the composer and upload them after creation", () => {
  assert.match(editorSource, /type="file"[\s\S]*?multiple/);
  assert.match(editorSource, /<PendingAttachments[\s\S]*?uploadLabel=\{text\("儲存後上傳", "Upload after saving"\)\}/);
  assert.match(pendingAttachmentsSource, /className="composer-attachment-list"/);
  assert.match(appSource, /Promise\.allSettled/);
  assert.match(appSource, /uploadAttachment\(saved\.id, file, "attachment"\)/);
  assert.match(appSource, /uploadAttachment\(saved\.id, image\.file, "inline"\)/);
  assert.match(appSource, /zh: `\$\{failedAttachments\} 個附件`[\s\S]*?以下內容寫入失敗/);
});

test("the issue composer includes Linear-style labels and scheduling", () => {
  for (const label of ["缺陷", "特性", "for-claude", "hold", "改進", "phase-1", "phase-6"]) {
    assert.match(labelsSource, new RegExp(label));
  }
  assert.match(editorSource, /<LabelPicker/);
  assert.match(labelPickerSource, /text\(`建立 “\$\{normalizedSearch\}”`, `Create “\$\{normalizedSearch\}”`\)/);
  assert.match(editorSource, /設定截止日期/);
  assert.match(editorSource, /設定重複/);
  assert.match(editorSource, /最早截止日期/);
  assert.match(editorSource, /developmentScan\.contexts/);
});

test("issue creation selects a project only from all projects and keeps the current project otherwise", () => {
  assert.match(editorSource, /\{!task && projectOptions && \([\s\S]*?ariaLabel=\{text\("專案", "Project"\)\}/);
  assert.doesNotMatch(detailSource, /detail-property-label">專案|project-property-icon|project\.name/);
  assert.match(appSource, /projectOptions=\{!editor\.task && isAllProjects \? createTargetProjects : undefined\}/);
  assert.match(appSource, /const targetProjectId = editorProjectId \?\? selectedProjectId;[\s\S]*?createTaskRequest\(targetProjectId, draft\)/);
  assert.match(appSource, /className="header-project-switcher"/);
});

test("the project header exposes project, automation, and create controls", () => {
  assert.match(appSource, /className="header-project-button"[\s\S]*?aria-haspopup="menu"/);
  assert.match(appSource, /className="header-project-menu" role="menu" aria-label=\{text\("專案", "Projects"\)\}/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /className="icon-button header-create-button"/);
  assert.match(styles, /\.header-project-menu \{[\s\S]*?-webkit-app-region: no-drag/);
});

test("the project header keeps detail navigation separate from the project switcher", () => {
  assert.match(appSource, /const headerProjectName = isAllProjects\s*\? text\("所有專案", "All projects"\)\s*: selectedProject\?\.id === GLOBAL_PROJECT_ID\s*\? text\("臨時任務", "Temporary tasks"\)\s*: selectedProject\?\.name \?\? text\("任務面板", "Taskboard"\)/);
  assert.match(appSource, /detailTask && \([\s\S]*?aria-label=\{text\("返回議題看板", "Back to issue board"\)\}[\s\S]*?<\/button>/);
  assert.match(appSource, /className="header-project-switcher"[\s\S]*?<span className="project-name">\{headerProjectName\}<\/span>/);
  assert.doesNotMatch(appSource, /className="issue-root-button"/);
  assert.doesNotMatch(appSource, /detailTask\?\.identifier \?\? "議題"/);
});

test("the collapsed Codex sidebar can be expanded immediately left of the project switcher", () => {
  assert.match(
    appSource,
    /hostContext\?\.sidebarCollapsed[\s\S]*?className="detail-back-button codex-sidebar-expand-button"[\s\S]*?className="header-project-switcher"/,
  );
  assert.match(styles, /\.codex-sidebar-expand-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test("the app omits the old navigation and keeps the embedded draggable header region", () => {
  assert.doesNotMatch(appSource, /<aside className="app-nav"/);
  assert.match(appSource, /<header className="workspace-header">/);
  assert.match(appSource, /ref=\{dragRegionRef\} className="workspace-drag-region"/);
  assert.match(styles, /\.workspace-drag-region \{[\s\S]*?flex: 1;[\s\S]*?align-self: stretch/);
  assert.match(styles, /\.app-shell\.embedded \.workspace-drag-region \{[\s\S]*?-webkit-app-region: drag/);
});

test("realtime updates remain active on the project home and reconcile after reconnecting", () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const source = new EventSource\(resolveTaskboardUrl\("\/api\/events"\)\)/);
  assert.match(appSource, /event\.type\.startsWith\("task\."\)[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: affectsSelectedProject \}\)/);
  assert.match(appSource, /source\.onopen = \(\) => \{[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: Boolean\(selectedProjectId\) \}\)/);
});
