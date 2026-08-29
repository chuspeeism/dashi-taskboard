import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { parseTaskboardAutomationHostRequest } from "../shared/taskboard-automation.mjs";

const sourceUrl = new URL("../inject/codex-taskboard.user.js", import.meta.url);
const source = (await readFile(sourceUrl, "utf8")).replaceAll("\r\n", "\n");
const webStyles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const webApp = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const embeddedHost = await readFile(new URL("../web/src/embeddedHost.mjs", import.meta.url), "utf8");

test("injection is an idempotent IIFE guarded by its current source hash", () => {
  assert.match(source, /^\(\(\) => \{/);
  assert.match(source, /const VERSION = "0\.6\.13"/);
  assert.match(source, /const SOURCE_HASH = window\.__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /const SENTINEL_KEY = "__codexTaskboardInjection__"/);
  assert.match(source, /previous\?\.sourceHash === SOURCE_HASH/);
  assert.match(source, /previous\.refresh\(\);\s*return;/);
  assert.match(source, /sourceHash: SOURCE_HASH/);
  assert.match(source, /window\[SENTINEL_KEY\] = api/);
});

test("embedded page uses the launcher URL inside an opaque sandbox", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:47823\/\?host=codex/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__/);
  assert.match(source, /nextFrame\.name = frameName/);
  assert.match(source, /nextFrame\.src = "about:blank"/);
  assert.match(source, /requestHost\("load-frame", \{ frameName, frameCapability: capability \}\)/);
  assert.match(source, /frameCapability = crypto\.randomUUID\(\)/);
  assert.match(source, /nextFrame\.setAttribute\("sandbox", "allow-scripts/);
  assert.match(source, /taskboardOrigin = taskboardUrl\.origin/);
  assert.match(source, /frameOrigin = "null"/);
  assert.doesNotMatch(source, /allow-same-origin/);
});

test("entry clones the native Plugins row and the page covers the complete Codex workspace", () => {
  assert.match(source, /const PLUGIN_LABELS = \["插件", "plugins"\]/);
  assert.match(source, /if \(plugin\?\.parentElement\) return plugin;/);
  assert.match(source, /return directButtons\.length >= 3/);
  assert.match(source, /const button = reference\.cloneNode\(true\)/);
  assert.match(source, /reference\.after\(entry\)/);
  assert.match(source, /document\.querySelector\("\.app-shell-main-content-frame"\)/);
  assert.match(source, /const surface = viewport\?\.parentElement/);
  assert.match(source, /surface\.appendChild\(page\)/);
  assert.match(source, /#\$\{PAGE_ID\} \{[\s\S]*?top: 0;/);
  assert.doesNotMatch(source, /--codex-taskboard-top-offset/);
  assert.match(source, /child\.setAttribute\(HIDDEN_ATTRIBUTE, "true"\)/);
  assert.match(source, /page\.hidden = false/);
  assert.doesNotMatch(source, /codex-taskboard-overlay/);
  assert.doesNotMatch(source, /codex-taskboard-toolbar/);
  assert.doesNotMatch(source, /aria-modal/);
});

test("opening Taskboard suppresses native selection and contextual header until close", () => {
  assert.match(source, /aside nav\[role="navigation"\] \[aria-current\]/);
  assert.match(source, /node\.removeAttribute\("aria-current"\)/);
  assert.match(source, /NATIVE_SELECTED_ATTRIBUTE/);
  assert.match(source, /app-shell-header-context-menu-surface/);
  assert.match(source, /restoreNativeSelection\(\)/);
  assert.match(source, /function onDocumentClick[\s\S]*closeTaskboard\(false\);/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => closeTaskboard\(false\), 0\)/);
});

test("the embedded header fills the native titlebar without clipping or a full-page no-drag region", () => {
  assert.match(source, /top: 0;/);
  assert.match(source, /z-index: 31 !important/);
  assert.doesNotMatch(source, /headerRightInset/);
  assert.doesNotMatch(source, /NATIVE_HEADER_RIGHT_INSET/);
  assert.doesNotMatch(source, /clip-path: polygon/);
  assert.doesNotMatch(source, /codex-taskboard-titlebar-fill/);
  assert.doesNotMatch(source, /#\$\{PAGE_ID\} \{[^}]*-webkit-app-region: no-drag !important;/);
  assert.doesNotMatch(source, /#\$\{FRAME_ID\} \{[^}]*-webkit-app-region: no-drag !important;/);
  assert.match(source, /const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left"/);
  assert.match(source, /const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right"/);
  assert.match(source, /window\.addEventListener\("resize", scheduleRefresh\)/);
});

test("only the empty embedded header spacer is draggable", () => {
  assert.match(webApp, /<div ref=\{dragRegionRef\} className="workspace-drag-region" aria-hidden="true" \/>/);
  assert.match(webApp, /type: "taskboard:drag-region"/);
  assert.match(source, /const DRAG_REGION_ID = "codex-taskboard-drag-region"/);
  assert.match(source, /message\.type === "taskboard:drag-region"/);
  assert.match(source, /function updateDragRegion\(payload\)/);
  assert.match(source, /#\$\{DRAG_REGION_ID\} \{[\s\S]*?-webkit-app-region: drag;/);
  assert.doesNotMatch(webStyles, /\.app-shell\.embedded \.workspace-header \{\s*-webkit-app-region: no-drag;/);
  assert.match(
    webStyles,
    /\.app-shell\.embedded \.workspace-drag-region \{\s*-webkit-app-region: drag;/,
  );
  assert.match(
    webStyles,
    /\.app-shell\.embedded \.workspace-header \.header-actions,[\s\S]*?-webkit-app-region: no-drag;/,
  );
});

test("the embedded header clears the macOS window controls when the Codex sidebar is collapsed", () => {
  assert.match(source, /const MACOS_TITLEBAR_SAFE_LEFT = 80/);
  assert.match(source, /function titlebarLeftInset\(\)/);
  assert.match(source, /if \(nativeSidebarCollapsed\(\)\) return MACOS_TITLEBAR_SAFE_LEFT/);
  assert.match(source, /MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft/);
  assert.match(source, /titlebarLeftInset: titlebarLeftInset\(\)/);
  assert.match(webApp, /--codex-titlebar-left-inset/);
  assert.match(webStyles, /padding-left: calc\(16px \+ var\(--codex-titlebar-left-inset, 0px\)\)/);
});

test("the embedded header exposes Codex's native sidebar expansion when collapsed", () => {
  assert.match(source, /\[data-app-shell-sidebar-trigger="true"\]/);
  assert.match(source, /function nativeSidebarCollapsed\(\)/);
  assert.match(source, /sidebarCollapsed: nativeSidebarCollapsed\(\)/);
  assert.match(source, /message\.type === "taskboard:expand-sidebar"/);
  assert.match(source, /function expandNativeSidebar\(\)[\s\S]*?trigger\.click\(\)/);
  assert.match(webApp, /embedded && hostContext\?\.sidebarCollapsed/);
  assert.match(webApp, /type: "taskboard:expand-sidebar"/);
  assert.match(webApp, /className="detail-back-button codex-sidebar-expand-button"/);
  assert.match(webApp, /<LinearIcon name="codexSidebarExpand" \/>/);
  assert.match(webStyles, /\.codex-sidebar-expand-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test("opening asks the resident launcher to ensure the service and rebuilds failed frames", () => {
  assert.match(source, /const HOST_REQUEST_MESSAGE = "__codexTaskboardHostRequestV1"/);
  assert.match(source, /return requestHost\("ensure"\)/);
  assert.match(source, /result\.restarted/);
  assert.match(source, /loadTaskboardFrame\(\)/);
  assert.match(source, /waitForFrameReady\(\)/);
  assert.match(source, /function onHostBridgeMessage/);
  assert.match(source, /function hasLiveHostBinding/);
  assert.match(source, /HOST_HEARTBEAT_MAX_AGE_MS/);
});

test("the injected iframe can be cache-busted without reloading the Codex shell", () => {
  assert.match(source, /const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh"/);
  assert.match(source, /function reloadFrame\(\)/);
  assert.match(source, /loadTaskboardFrame\(true\)/);
  assert.match(source, /reloadFrame,/);
});

test("reopening reuses a ready cache-busted iframe without showing the startup placeholder", () => {
  assert.match(source, /function frameMatchesTaskboardUrl\(taskboardUrl\)/);
  assert.match(source, /loadedUrl\.searchParams\.delete\(FRAME_REFRESH_PARAM\)/);
  assert.match(source, /expectedUrl\.searchParams\.delete\(FRAME_REFRESH_PARAM\)/);
  const prepareSource = source.slice(
    source.indexOf("async function prepareTaskboard"),
    source.indexOf("function restoreNativeContent"),
  );
  assert.match(prepareSource, /const canReuseFrame = Boolean\([\s\S]*frameMatchesTaskboardUrl\(taskboardUrl\)/);
  assert.match(prepareSource, /if \(canReuseFrame\) showFrame\(\);\s*else showLoading\(\);/);
  assert.match(
    prepareSource,
    /if \(!frameReady \|\| result\.restarted \|\| !frameMatchesTaskboardUrl\(taskboardUrl\)\) \{\s*showLoading\(\);/,
  );
  assert.doesNotMatch(prepareSource, /async function prepareTaskboard\(generation\) \{\s*showLoading\(\);/);
});

test("opaque iframe messages require the current document capability", () => {
  assert.match(
    source,
    /event\.source !== frame\.contentWindow \|\| event\.origin !== frameOrigin/,
  );
  assert.match(source, /message\.type === "taskboard:open-thread"/);
  assert.match(source, /message\.type === "taskboard:create-thread"/);
  assert.match(source, /message\.capability !== frameCapability/);
  assert.match(source, /message\.challenge !== frameChallenge/);
  assert.match(source, /nextFrame\.addEventListener\("load", challengeFrameDocument\)/);
  assert.match(source, /type: "taskboard:frame-challenge"/);
  assert.match(source, /frameCapability = ""/);
  assert.doesNotMatch(source, /nextFrame\.addEventListener\("load", postHostContext\)/);
  assert.match(source, /postMessage\(message, frameOrigin === "null" \? "\*" : frameOrigin\)/);
});

test("HTTP and HTTPS links are opened by the authenticated host instead of a sandbox popup", () => {
  assert.match(embeddedHost, /a\[target="_blank"\]/);
  assert.match(embeddedHost, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
  assert.match(embeddedHost, /event\.preventDefault\(\)/);
  assert.match(embeddedHost, /type: "taskboard:open-external"/);
  assert.match(embeddedHost, /challenge: activeFrameChallenge/);
  assert.match(source, /message\.type === "taskboard:open-external"/);
  assert.match(source, /requestHost\("open-external", \{ url: url\.href \}\)/);
  assert.match(source, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
});

test("the iframe automation contract is forwarded through the fixed host binding", () => {
  assert.match(source, /message\.type === "taskboard:automation-request"/);
  assert.match(source, /function handleAutomationRequest\(payload\)/);
  assert.match(source, /requestHost\(\s*"automation",\s*buildAutomationHostPayload\(payload\),\s*\)/);
  assert.match(source, /operation: payload\.operation/);
  assert.match(source, /taskboardProjectId: payload\.taskboardProjectId/);
  assert.match(source, /codexProjectId: payload\.codexProjectId/);
  assert.match(source, /codexProjectKind: payload\.codexProjectKind/);
  assert.match(source, /codexHostId: payload\.codexHostId/);
  assert.match(source, /workspacePath: payload\.workspacePath/);
  assert.match(source, /remoteProjects: payload\.remoteProjects/);
  assert.match(source, /skillPath: payload\.skillPath/);
  assert.match(source, /model: payload\.model/);
  assert.match(source, /reasoningEffort: payload\.reasoningEffort/);
  assert.match(source, /type: "taskboard:automation-response"/);
  assert.match(source, /requestId,\s*ok: true,\s*item: response\.item/);
  assert.match(source, /items: response\.items/);
  assert.match(source, /policy: response\.policy/);
  assert.match(source, /requestId,\s*ok: false,\s*error:/);
  assert.match(source, /type: HOST_REQUEST_MESSAGE/);
  assert.match(source, /capability: HOST_CAPABILITY/);
  assert.match(source, /event\.source !== window/);
  assert.doesNotMatch(source, /window\[HOST_BINDING_NAME\]/);
});

test("complete App automation payloads cross the injected forwarder into the current parser", () => {
  const functionSource = source.slice(
    source.indexOf("function buildAutomationHostPayload"),
    source.indexOf("\n\n  async function handleAutomationRequest"),
  );
  assert.ok(functionSource.startsWith("function buildAutomationHostPayload"));
  const buildAutomationHostPayload = vm.runInNewContext(`(${functionSource})`);
  const basePayload = {
    requestId: "request-1",
    taskboardProjectId: "local",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    projectName: "Local",
    workspacePath: "/tmp/local-project",
    remoteProjects: [],
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    automationId: "automation-1",
    enabledByUser: true,
    quotaAware: true,
    intervalMinutes: 10,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    enabledByUser: true,
    quotaAware: false,
  };

  for (const operation of ["list", "pause", "ensure-active"]) {
    const forwarded = {
      id: `host-${operation}`,
      action: "automation",
      ...buildAutomationHostPayload({ ...basePayload, operation }),
    };
    assert.deepEqual(
      parseTaskboardAutomationHostRequest(forwarded),
      forwarded,
      `${operation} must retain model and reasoningEffort`,
    );
  }
});

test("only a loopback Taskboard iframe can request native automation", () => {
  assert.match(source, /function isLocalTaskboardOrigin\(origin\)/);
  assert.match(source, /hostname === "127\.0\.0\.1" \|\| hostname === "localhost"/);
  assert.match(
    source,
    /if \(!isLocalTaskboardOrigin\(taskboardOrigin\)\) \{\s*postToFrame\(\{\s*type: "taskboard:automation-response"/,
  );
});

test("issues open an unsent native Codex composer in the confirmed project", () => {
  const createThreadSource = source.slice(
    source.indexOf("async function createThreadForTask"),
    source.indexOf("function buildAutomationHostPayload"),
  );
  assert.match(source, /async function createThreadForTask\(payload\)/);
  assert.match(source, /async function nativeProjectContext\(\)/);
  assert.match(source, /async function activeNativeWorkspaceRoots\(\)/);
  assert.match(source, /requestNativeFetch\("active-workspace-roots", \{\}\)/);
  assert.match(source, /function normalizeNativeRootPath\(value\)/);
  assert.match(source, /async function resolveNativeProject\(requestedProjectId, workspacePath\)/);
  assert.match(source, /candidate\.id === requestedProjectId\s*\|\|\s*candidate\.rootPaths\.some/);
  assert.match(source, /const targetRoot = normalizedWorkspacePath \? workspacePath : project\?\.rootPaths\[0\]/);
  assert.match(source, /async function waitForNativeProject\(targetRoot\)/);
  const waitStart = source.indexOf("async function waitForNativeProject");
  const waitSource = source.slice(waitStart, source.indexOf("async function createThreadForTask", waitStart));
  assert.match(waitSource, /selectedNativeProjectId\(\)/);
  assert.match(waitSource, /activeNativeWorkspaceRoots\(\)/);
  assert.match(waitSource, /projectId\s*&&\s*normalizeNativeRootPath\(activeRoots\[0\]\) === normalizedTargetRoot/);
  assert.match(
    source,
    /bridge\.sendMessageFromView\(\{\s*type: "electron-add-new-workspace-root-option",\s*root: targetRoot,/,
  );
  assert.match(source, /await waitForNativeProject\(targetRoot\)/);
  assert.match(
    createThreadSource,
    /if \(!projectless && codexProjectKind === "remote"\) \{[\s\S]*?codexHostId = typeof payload\?\.codexHostId[\s\S]*?codexProjectWorkspacePath[\s\S]*?await waitForRemoteProject\(requestedProjectId, codexHostId, codexProjectWorkspacePath\);/,
  );
  assert.match(source, /const focusComposerNonce = crypto\.randomUUID\(\)/);
  assert.match(createThreadSource, /type: "navigate-to-route",\s*path: "\/",\s*state: \{\s*focusComposerNonce,\s*prefillPrompt: instruction,/);
  assert.match(createThreadSource, /type: "taskboard:thread-prepared", payload: \{ taskId \}/);
  assert.doesNotMatch(createThreadSource, /start-task-conversation|previousThreadId|threadId:/);
  assert.match(webApp, /title: task\.title,/);
  assert.match(webApp, /instruction: embeddedInstruction,/);
  assert.match(webApp, /type: "taskboard:create-thread"/);
  assert.match(webApp, /codexProjectWorkspacePath: codexProjectContext\?\.workspacePath/);
  assert.match(webApp, /workspacePath,/);
});

test("the standalone web page opens linked Codex tasks through the app deep link", () => {
  assert.match(webApp, /window\.location\.assign\(`codex:\/\/threads\/\$\{encodeURIComponent\(binding\.threadId\.trim\(\)\)\}`\)/);
});

test("the injected app opens an existing local Codex task instead of a new composer", () => {
  const openThreadStart = source.indexOf("async function openThread");
  const openThreadSource = source.slice(
    openThreadStart,
    source.indexOf("async function nativeProjectContext", openThreadStart),
  );
  assert.match(openThreadSource, /if \(row\?\.isConnected\) \{\s*row\.click\?\.\(\);\s*return;/);
  assert.match(openThreadSource, /await dispatchHostMessage\(\{\s*type: "navigate-to-route",\s*path: routeForThread\(normalizedThreadId\)/);
  assert.match(source, /return `\/local\/\$\{encodeURIComponent\(threadId\)\}`/);
  assert.doesNotMatch(source, /return `\/thread\/\$\{encodeURIComponent\(threadId\)\}`/);
  assert.doesNotMatch(openThreadSource, /focusComposerNonce/);
  assert.match(webApp, /payload: \{ threadId, legacyLocal: true \}/);
  assert.doesNotMatch(webApp, /payload: \{ threadId, legacyLocal: true, [^}]*codexProject/);
});

test("remote Codex tasks wait for the exact project and host without a local route fallback", () => {
  const remoteProjectSource = source.slice(
    source.indexOf("async function waitForRemoteProject"),
    source.indexOf("async function waitForRemoteThreadRow"),
  );
  const openThreadSource = source.slice(
    source.indexOf("async function openThread"),
    source.indexOf("async function nativeProjectContext"),
  );
  const remoteOpenSource = openThreadSource.slice(
    openThreadSource.indexOf("if (remoteProject)"),
    openThreadSource.indexOf("\n    lastNativeThreadId = normalizedThreadId;"),
  );
  assert.match(remoteProjectSource, /if \(!projectId \|\| !hostId \|\| hostId === "local"\)/);
  assert.match(remoteProjectSource, /row = projectRowById\(projectId\)/);
  assert.match(remoteProjectSource, /selectedNativeProjectId\(\)/);
  assert.match(remoteProjectSource, /readCodexProjectMetadata\(\)/);
  assert.match(remoteProjectSource, /selectedProjectId === projectId/);
  assert.match(remoteProjectSource, /selectedProject\?\.projectKind === "remote"/);
  assert.match(remoteProjectSource, /selectedProject\.hostId === hostId/);
  assert.match(remoteProjectSource, /!workspacePath \|\| selectedProject\.workspacePath === workspacePath/);
  assert.match(remoteOpenSource, /waitForRemoteThreadRow\(normalizedThreadId, projectId\)/);
  assert.match(remoteOpenSource, /type: "taskboard:thread-open-error"/);
  assert.doesNotMatch(remoteOpenSource, /routeForThread/);
  assert.match(webApp, /openThread\(conversation\.threadBinding\)/);
  assert.match(webApp, /onOpenThread=\{openThread\}/);
  assert.match(webApp, /project\.id === binding\.codexProjectId[\s\S]*?project\.hostId === binding\.codexHostId[\s\S]*?project\.workspacePath === binding\.workspacePath/);
  assert.match(webApp, /message\.type === "taskboard:thread-open-error"/);
});

test("host navigation follows Codex's renderer message bus", () => {
  assert.match(source, /function dispatchHostMessage\(message\)/);
  assert.match(source, /window\.postMessage\(message, window\.location\.origin\)/);
  assert.doesNotMatch(source, /new CustomEvent\("codex-message-from-view"/);
});

test("the standalone web page always opens a project-scoped Codex composer", () => {
  assert.doesNotMatch(webApp, /standalone && task\.threadBinding[\s\S]*?openThread\(task\.threadBinding\)/);
  assert.doesNotMatch(webApp, /standalone && task\.legacyLocalThreadId[\s\S]*?openLegacyLocalThread\(task\.legacyLocalThreadId\)/);
  assert.match(webApp, /new URL\("codex:\/\/threads\/new"\)/);
  assert.match(webApp, /deepLink\.searchParams\.set\("path", workspacePath\)/);
  assert.match(webApp, /deepLink\.searchParams\.set\("prompt", embeddedInstruction\)/);
});

test("host context captures all Codex projects even when the sidebar section is collapsed", () => {
  assert.match(source, /async function readCodexProjectMetadata\(\)/);
  assert.match(source, /await window\.electronBridge\?\.getInitialSidebarBootstrap\?\.\(\)/);
  assert.match(source, /entries\.get\("local-projects"\)/);
  assert.match(source, /entries\.get\("remote-projects"\)/);
  assert.match(source, /projectKind: "remote"/);
  assert.match(source, /workspacePath,[\s\S]*?hostId/);
  assert.match(source, /function readCodexProjects\(metadata = codexProjectMetadata\)/);
  assert.match(source, /\[data-app-action-sidebar-project-row\]/);
  assert.match(source, /data-app-action-sidebar-project-id/);
  assert.match(source, /function findProjectsSection\(\)/);
  assert.match(source, /data-app-action-sidebar-section-collapsed/);
  assert.match(source, /async function captureHostContext\(\)/);
  assert.match(source, /while \(!section && Date\.now\(\) < sectionDeadline\)/);
  assert.match(source, /requestHostEnsure\(taskboardUrl\),\s*captureHostContext\(\),/);
  assert.match(source, /let lastNativeThreadId = ""/);
  assert.match(source, /clickedThreadId.*lastNativeThreadId/s);
  assert.match(source, /const currentThreadId = activeThreadId \|\| runningThreadId \|\| lastNativeThreadId/);
  assert.match(source, /const threadId = currentThreadId \|\| lastNativeThreadId \|\| normalizeThreadId\(threadIdFromLocation\(\)\)/);
  assert.match(source, /replace\(\/\^\(\?:local\|cloud\):\/i, ""\)/);
  assert.match(source, /function findTasksSection\(\)/);
});

test("Codex bootstrap metadata resolves local roots and SSH remote roots asynchronously", async () => {
  const functionSource = source.slice(
    source.indexOf("async function readCodexProjectMetadata"),
    source.indexOf("\n\n  async function activeNativeWorkspaceRoots"),
  );
  const readCodexProjectMetadata = vm.runInNewContext(`(${functionSource})`, {
    window: {
      electronBridge: {
        getInitialSidebarBootstrap: async () => ({
          globalStateEntries: [
            {
              key: "local-projects",
              value: {
                local: { rootPaths: ["/Users/example/project"] },
              },
            },
            {
              key: "remote-projects",
              value: [{
                id: "remote-project",
                hostId: "remote-ssh-discovered:example",
                remotePath: "/srv/example/project",
              }],
            },
          ],
        }),
      },
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify([...(await readCodexProjectMetadata()).entries()])),
    [
      ["local", {
        projectKind: "local",
        hostId: "local",
        workspacePath: "/Users/example/project",
      }],
      ["remote-project", {
        projectKind: "remote",
        workspacePath: "/srv/example/project",
        hostId: "remote-ssh-discovered:example",
        name: "remote-project",
      }],
    ],
  );
});

test("SSH task project selection uses its stable ID and local project IDs use bootstrap keys", () => {
  assert.match(source, /row = projectRowById\(projectId\)/);
  assert.doesNotMatch(source, /projectRowForTask|projectRowByLabel/);
  assert.match(source, /Object\.entries\(localProjects\)/);
  assert.match(source, /\[\{ \.\.\.project, id \}\]/);
});

test("cleanup removes observers, listeners, timers and owned DOM", () => {
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /window\.removeEventListener\("message", onFrameMessage\)/);
  assert.match(source, /document\.removeEventListener\("click", onDocumentClick, true\)/);
  assert.match(source, /window\.removeEventListener\("popstate", onNativeRouteChange\)/);
  assert.match(source, /window\.clearTimeout\(reattachTimer\)/);
  assert.match(source, /data-codex-taskboard-owned/);
  assert.match(source, /delete window\[SENTINEL_KEY\]/);
});

test("host integration stays thin", () => {
  assert.match(source, /new MutationObserver\(scheduleRefresh\)/);
  assert.match(source, /type: "taskboard:host-context"/);
  assert.match(source, /type: "taskboard:theme"/);
  assert.match(source, /type: "navigate-to-route"/);
  assert.doesNotMatch(source, /__codexSessionDeleteBridge/);
  assert.doesNotMatch(source, /import\s*\(/);
  assert.doesNotMatch(source, /window\.fetch\s*=/);
});
