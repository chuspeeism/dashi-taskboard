import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/taskboard-supervisor.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector authenticates its launcher-managed Taskboard service", () => {
  assert.match(source, /if \(options\.launch\) options\.attachExisting = true;/);
  assert.match(supervisorSource, /function createTaskboardSupervisor/);
  assert.match(source, /CODEX_TASKBOARD_INSTANCE_TOKEN/);
  assert.match(source, /createHmac\("sha256"/);
  assert.match(source, /x-codex-taskboard-challenge/);
  assert.match(source, /proof/);
  assert.match(source, /taskboardInstanceSecret/);
  assert.match(source, /Page\.setDocumentContent/);
  assert.match(runtimeSource, /request\.action === "load-frame"/);
  assert.match(supervisorSource, /ensureInFlight/);
  assert.match(supervisorSource, /await terminateManagedChild\(managedChild\)/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.frameCapability/);
});

test("the CDP bridge accepts service ensure and native task conversation start actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "start-task-conversation"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.taskId/);
  assert.match(runtimeSource, /request\.previousThreadId\.length <= 240/);
  assert.match(runtimeSource, /request\.targetRoot\.length <= 4_096/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.title\.length <= 240/);
  assert.match(source, /async function startTaskConversationViaCdp/);
  assert.match(source, /data-composer-placement="home"/);
  assert.match(source, /\(editor\.textContent \|\| ""\) !== \$\{JSON\.stringify\(instruction\)\}/);
  assert.doesNotMatch(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyDown",\s*key: "Enter"/,
  );
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyUp",\s*key: "Enter"/,
  );
  assert.match(source, /submitted = true/);
  assert.match(source, /if \(!submitted\) throw new Error/);
  assert.match(source, /const threadId = typeof started\.result\.value === "string"/);
  assert.match(source, /threadId && threadId !== previousThreadId/);
  assert.match(source, /function requestCodexAppServerViaCdp/);
  assert.match(source, /type: "mcp-request"/);
  assert.match(source, /"thread\/read"/);
  assert.match(source, /normalizeWorkspaceRoot\(result\.thread\.cwd\) === normalizedTargetRoot/);
  assert.match(source, /"thread\/name\/set"/);
  assert.match(source, /result\.thread\.name === title/);
  assert.match(source, /const taskConversationOperations = new Map\(\)/);
  assert.match(source, /taskConversationOperations\.get\(request\.taskId\)/);
  assert.match(source, /const taskConversationAppServerTimeoutMs = 30_000/);
  assert.doesNotMatch(source, /window\.postMessage\(\{ type: "rename-thread" \}/);
  assert.match(source, /return \{ threadId, title \}/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(source, /Page\.createIsolatedWorld/);
  assert.match(source, /Runtime\.addBinding", \{\s*name: hostBindingName,\s*executionContextId:/);
  assert.match(source, /params\.executionContextId !== activeContextId/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponseMessage/);
  assert.match(source, /if \(keepAlive\) await hostBridge\.install\(\)/);
  assert.match(source, /hostBridge\.publishHeartbeat/);
  assert.match(source, /withoutTaskboardLauncherEnvironment\(process\.env\)/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("passive automation policy keeps idle pauses and only resumes quota pauses", () => {
  assert.match(source, /taskboardAutomationPolicyOperation/);
  assert.match(source, /previousQuotaState: current\.quota\?\.state/);
  assert.match(source, /enqueueQuotaPolicyMutation\(record, rpc, \{ explicit: true \}\)/);
  assert.match(
    source,
    /!explicit && result\.operation === "list" && result\.item\?\.status === "PAUSED"/,
  );
  assert.match(source, /enabledByUser: false/);
  assert.match(source, /record\.quota \? \{ quota: record\.quota \} : \{\}/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardBaseUrl = `\$\{taskboardOrigin\}\/\$\{encodeURIComponent\(taskboardInstanceToken\)\}`/);
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardBaseUrl\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});
