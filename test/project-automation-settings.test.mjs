import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/TaskboardIcon.tsx", import.meta.url),
  "utf8",
);
const playIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-play.svg", import.meta.url),
  "utf8",
);
const pauseIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-pause.svg", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation state is device-local and scoped by taskboard project", () => {
  assert.match(appSource, /const PROJECT_AUTOMATIONS_KEY = "taskboard\.projectAutomations\.v1"/);
  assert.match(appSource, /type ProjectAutomationStatus = "ACTIVE" \| "PAUSED"/);
  assert.match(appSource, /automationId\?: string/);
  assert.match(appSource, /codexProjectId: string/);
  assert.match(appSource, /codexProjectKind: "local" \| "remote"/);
  assert.match(appSource, /codexHostId: string/);
  assert.match(appSource, /workspacePath: string/);
  assert.match(appSource, /type AutomationIntervalMinutes = 5 \| 10 \| 15 \| 30 \| 60/);
  assert.match(appSource, /getAiChatCatalog\(\s*selectedProject\.id,\s*controller\.signal,\s*selectedCodexProjectIdentity,\s*\)/);
  assert.match(appSource, /defaultModel\.slug/);
  assert.match(appSource, /defaultModel\.defaultReasoningEffort/);
  assert.match(appSource, /taskboardStorage\.getItem\(PROJECT_AUTOMATIONS_KEY\)/);
  assert.match(appSource, /taskboardStorage\.setItem\(PROJECT_AUTOMATIONS_KEY, JSON\.stringify\(next\)\)/);
  assert.match(appSource, /projectAutomations\[selectedProjectId\]/);
});

test("automation requests use the exact Codex host message contract", () => {
  assert.match(appSource, /type: "taskboard:automation-request"/);
  assert.match(appSource, /operation: "ensure-active" \| "pause" \| "list"/);
  assert.match(appSource, /context: AutomationRequestContext[\s\S]*?taskboardProjectId: context\.taskboardProjectId/);
  assert.match(appSource, /codexProjectId/);
  assert.match(appSource, /codexProjectKind/);
  assert.match(appSource, /codexHostId/);
  assert.match(appSource, /projectName: selectedProject\.name/);
  assert.match(appSource, /workspacePath/);
  assert.match(appSource, /skillPath: manageTaskboardSkillPath/);
  assert.match(appSource, /intervalMinutes: options\.intervalMinutes/);
  assert.match(appSource, /model: options\.model/);
  assert.match(appSource, /reasoningEffort: options\.reasoningEffort/);
  assert.match(appSource, /message\.type === "taskboard:automation-response"/);
  assert.match(appSource, /pendingAutomationRequestsRef/);
  assert.match(appSource, /requestId/);
  assert.match(appSource, /window\.setTimeout/);
});

test("project mapping is based on exact ids and workspace paths, never project names", () => {
  const automationContextSource = appSource.slice(
    appSource.indexOf("const automationProjectContext"),
    appSource.indexOf("const automationRequestContext"),
  );
  assert.match(
    automationContextSource,
    /const effectiveCodexProjectId = selectedProject\.id === GLOBAL_PROJECT_ID\s*\? hostContext\?\.projectId\s*: selectedProject\.id/,
  );
  assert.match(automationContextSource, /project\.id === effectiveCodexProjectId/);
  assert.match(automationContextSource, /savedIdentity\?\.codexProjectKind === "remote"/);
  assert.match(automationContextSource, /project\.id === savedIdentity\.codexProjectId/);
  assert.match(automationContextSource, /liveProject\.hostId !== savedIdentity\.codexHostId/);
  assert.match(automationContextSource, /liveProject\.workspacePath !== savedIdentity\.workspacePath/);
  assert.match(appSource, /directCodexProject\?\.workspacePath/);
  assert.match(appSource, /\(deviceWorkspacePaths\[project\.id\] \?\? project\.workspacePath\) === workspacePath/);
  assert.match(appSource, /请先在 Codex 中添加并映射该项目目录/);
  assert.doesNotMatch(appSource, /project\.name === selectedProject\.name/);
});

test("global tasks open a projectless conversation", () => {
  const openTaskSource = appSource.slice(
    appSource.indexOf("function codexProjectContextForTaskProject"),
    appSource.indexOf("function changeProject"),
  );
  assert.match(
    openTaskSource,
    /if \(taskboardProjectId === GLOBAL_PROJECT_ID\) return null/,
  );
  assert.match(
    openTaskSource,
    /const projectless = task\.projectId === GLOBAL_PROJECT_ID/,
  );
  assert.match(openTaskSource, /codexProjectId: codexProject\.id,\s*codexProjectKind: codexProject\.projectKind/);
  assert.match(openTaskSource, /const savedRemoteIdentity = projectCodexIdentities\[task\.projectId\]/);
  assert.match(openTaskSource, /codexProjectContextForTaskProject\(task\.projectId\)/);
  assert.match(openTaskSource, /project\.hostId === baseIdentity\.codexHostId/);
  assert.match(openTaskSource, /project\.workspacePath === worktreePath/);
  assert.match(openTaskSource, /if \(matches\.length !== 1\) return null/);
  assert.match(openTaskSource, /codexProjectId: codexProjectContext\?\.codexProjectId/);
});

test("the project navigation automation menu owns the icon, fields, and accessible popover", () => {
  assert.match(menuSource, /status === "ACTIVE" \? "automationPause" : "automationPlay"/);
  assert.doesNotMatch(menuSource, /statusStarted|statusTodo/);
  assert.match(menuSource, /aria-busy=\{pending/);
  assert.match(menuSource, /自动认领/);
  assert.match(menuSource, /aria-label=\{status === "ACTIVE"\s*\? text\("自动认领中", "Auto-claiming"\)\s*: text\("自动化", "Automation"\)\}/);
  assert.doesNotMatch(menuSource, /已开启自动认领|自动认领未开启/);
  assert.match(menuSource, /自动认领开关/);
  assert.match(menuSource, /5, 10, 15, 30, 60/);
  assert.match(menuSource, /models\.map/);
  assert.match(menuSource, /EFFORT_LABELS\[effort\]/);
  assert.match(menuSource, /createPortal/);
  assert.match(menuSource, /window\.addEventListener\("resize"/);
  assert.match(menuSource, /window\.addEventListener\("scroll", closeFromViewportChange, true\)/);
  assert.match(menuSource, /no-drag/);
  assert.doesNotMatch(menuSource, /event\.key === "Tab"/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /<ProjectAutomationMenu[\s\S]*?<button[\s\S]*?header-create-button/);
  assert.doesNotMatch(appSource, /toolbar-connection/);
  assert.match(appSource, /仅本地任务面板可用/);
});

test("automation status uses the exported Taskboard play and pause icon assets", () => {
  assert.match(iconSource, /import automationPause from "\.\.\/assets\/figma-taskboard\/automation-pause\.svg"/);
  assert.match(iconSource, /import automationPlay from "\.\.\/assets\/figma-taskboard\/automation-play\.svg"/);
  assert.match(iconSource, /const TASKBOARD_ICONS = \{[\s\S]*?automationPause,[\s\S]*?automationPlay,/);
});

test("automation play and pause retain the exported 16px presentation", () => {
  assert.match(playIcon, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(pauseIcon, /width="16" height="16" viewBox="0 0 16 16"/);
});

test("the automation menu reuses the board switches and keeps form focus chrome suppressed", () => {
  assert.match(menuSource, /className=\{`board-setting-switch\$\{draft\.enabledByUser \? " is-on" : ""\}`\}/);
  assert.match(menuSource, /role="switch"/);
  assert.match(menuSource, /aria-checked=\{draft\.enabledByUser\}/);
  assert.match(menuSource, /className=\{`board-setting-switch\$\{draft\.quotaAware \? " is-on" : ""\}`\}/);
  assert.match(menuSource, /aria-checked=\{draft\.quotaAware\}/);
  assert.doesNotMatch(menuSource, /type="checkbox"/);
  assert.match(styles, /\.project-automation-picker-trigger:focus-visible\s*\{[^}]*outline:\s*0;[^}]*box-shadow:\s*0 0 0 2px var\(--accent-soft\);/s);
  assert.doesNotMatch(styles, /\.project-automation-switch input:focus-visible/);
});

test("unavailable automation state has one notice, clears stale errors, and cannot change", () => {
  assert.match(menuSource, /error && error !== unavailableReason/);
  assert.match(menuSource, /const disabled = pending \|\| !selectedModel \|\| Boolean\(unavailableReason\)/);
  assert.equal(menuSource.match(/disabled=\{disabled\}/g)?.length, 5);
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  assert.match(
    reconcileSource,
    /if \(!automationRequestContext\) \{\s*setAutomationError\(null\);\s*return;/,
  );
  assert.doesNotMatch(reconcileSource, /setAutomationError\(automationProjectContext\.unavailableReason/);
});

test("automation changes submit immediately with model-specific effort normalization", () => {
  assert.match(menuSource, /onChange: \(options: AutomationOptions\) => void/);
  assert.match(menuSource, /const disabled = pending \|\| !selectedModel \|\| Boolean\(unavailableReason\)/);
  assert.match(menuSource, /const submitChange = \(next: AutomationOptions\) => \{[\s\S]*?setDraft\(next\);[\s\S]*?onChange\(next\);[\s\S]*?\}/);
  assert.match(menuSource, /const model = models\.find\(\(candidate\) => candidate\.slug === value\)/);
  assert.match(menuSource, /model\.supportedReasoningEfforts\.includes\(draft\.reasoningEffort\)/);
  assert.match(menuSource, /selectedModel\.supportedReasoningEfforts\.map/);
  assert.match(menuSource, /EFFORT_LABELS\[effort\] \? text\(\.\.\.EFFORT_LABELS\[effort\]\) : effort/);
  assert.match(menuSource, /low: \["轻度", "Low"\]/);
  assert.match(menuSource, /xhigh: \["极高 \(xhigh\)", "Extra high \(xhigh\)"\]/);
  assert.match(menuSource, /max: \["最高", "Maximum"\]/);
  assert.match(menuSource, /ultra: \["极高 \(ultra\)", "Ultra"\]/);
  assert.doesNotMatch(menuSource, />取消</);
  assert.doesNotMatch(menuSource, />保存</);
  assert.doesNotMatch(menuSource, /project-automation-actions/);
  assert.doesNotMatch(menuSource, /onSave/);
  assert.doesNotMatch(styles, /\.project-automation-actions/);
});

test("pending completion reconciles the optimistic draft to confirmed host state", () => {
  assert.match(menuSource, /const wasPendingRef = useRef\(pending\)/);
  assert.match(
    menuSource,
    /if \(wasPendingRef\.current && !pending\) \{\s*setDraft\(automationOptions\(models, automation\)\);\s*\}/,
  );
  assert.match(menuSource, /wasPendingRef\.current = pending/);
  assert.match(menuSource, /disabled=\{disabled\}/);
});

test("opening settings and changing projects reconcile with the host list", () => {
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  const drainSource = appSource.slice(
    appSource.indexOf("const drainQueuedAutomationSaves"),
    appSource.indexOf("const reconcileProjectAutomation"),
  );
  assert.match(
    reconcileSource,
    /sendAutomationRequest\(\s*"list",\s*options,\s*automationRequestContext,\s*stored\?\.automationId,\s*\)/,
  );
  assert.doesNotMatch(reconcileSource, /"apply-policy"/);
  assert.match(
    drainSource,
    /sendAutomationRequest\(\s*"apply-policy",\s*queuedSave\.options,\s*queuedSave\.context,\s*previousRecord\?\.automationId,\s*\)/,
  );
  assert.match(appSource, /const policy = isAutomationHostPolicy\(response\.policy\) \? response\.policy : null/);
  assert.match(appSource, /typeof value\.codexProjectId === "string"/);
  assert.match(appSource, /value\.codexProjectKind === "local" \|\| value\.codexProjectKind === "remote"/);
  assert.match(appSource, /typeof value\.codexHostId === "string"/);
  assert.match(appSource, /typeof value\.workspacePath === "string"/);
  assert.match(appSource, /const item = \(isAutomationHostItem\(response\.item\) \? response\.item : undefined\)\s*\?\? items\.find\(\(candidate\) => candidate\.id === policy\.automationId\)/);
  assert.match(appSource, /items\.find\(\(candidate\) => candidate\.id === policy\.automationId\)/);
  assert.match(appSource, /items\.length === 1 \? items\[0\] : undefined/);
  assert.match(appSource, /automationId: item\?\.id \?\? policy\.automationId/);
  assert.match(appSource, /status: item\?\.status \?\? "PAUSED"/);
  assert.match(appSource, /enabledByUser: policy\.enabledByUser/);
  assert.match(appSource, /quotaAware: policy\.quotaAware/);
  assert.match(drainSource, /codexProjectId: policy\.codexProjectId/);
  assert.match(drainSource, /codexProjectKind: policy\.codexProjectKind/);
  assert.match(drainSource, /codexHostId: policy\.codexHostId/);
  assert.match(drainSource, /workspacePath: policy\.workspacePath/);
  assert.doesNotMatch(drainSource, /codexProjectId: queuedSave\.context\.codexProjectId/);
  assert.match(reconcileSource, /const effectiveProjectIdentity = policy \?\? automationRequestContext/);
  assert.match(reconcileSource, /codexProjectId: effectiveProjectIdentity\.codexProjectId/);
  assert.match(reconcileSource, /codexProjectKind: effectiveProjectIdentity\.codexProjectKind/);
  assert.match(reconcileSource, /codexHostId: effectiveProjectIdentity\.codexHostId/);
  assert.match(reconcileSource, /workspacePath: effectiveProjectIdentity\.workspacePath/);
  assert.match(appSource, /automationId: undefined,[\s\S]*?status: "PAUSED"/);
  assert.match(drainSource, /writeProjectAutomation\(queuedSave\.projectId, previousRecord\)/);
});
