import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  decideRefreshTaskboardPass,
  waitForFocusedRendererAttempt,
} from "../scripts/codex-injector.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises the fixed local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(source, /await isReachable\(taskboardHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /options\.managedTaskboard/);
  assert.match(source, /if \(managed\) \{/);
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installTaskboardHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexTaskboardHostHeartbeatV1/);
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
  assert.match(
    source,
    /const previousStatus = await readInjectionStatus\(cdp\);[\s\S]*removeRegisteredPageScript\([\s\S]*await reloadPageAndWait\(cdp\);/,
  );
  assert.match(
    source,
    /const scriptIdentifier = await registerInjectionSource[\s\S]*await publishInjectionScriptIdentifier\(cdp, scriptIdentifier\);[\s\S]*await reloadPageAndWait\(cdp\);/,
  );
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

test("cold launch retries against the current Codex renderer and releases a failed app waiter", () => {
  assert.match(source, /async function waitForInitialInjection\(runInjection, timeoutMs\)/);
  assert.match(source, /const firstResults = await waitForInitialInjection\(/);
  assert.doesNotMatch(source, /initialTargets/);
  assert.match(source, /async function fetchJson\(url\)[\s\S]*AbortSignal\.timeout\(3_000\)/);
  assert.match(
    source,
    /catch \(error\) \{\s*supervisor\.stop\(\);\s*codexProcess\?\.unref\(\);\s*throw error;/,
  );
});

test("an in-place open reports success only after the Taskboard iframe signals readiness", () => {
  const refreshStart = source.indexOf("export function decideRefreshTaskboardPass");
  const automationStart = source.indexOf("async function requestCodexAutomationViaCdp", refreshStart);
  const refreshSource = source.slice(refreshStart, automationStart);

  assert.match(refreshSource, /outcomes: await Promise\.all\(attempts\)/);
  assert.match(refreshSource, /persistentFailures\.length > 0/);
  assert.match(refreshSource, /currentTargets = await codexTargets\(port\)/);
  assert.match(refreshSource, /focusedFailures\.length > 0/);
  assert.match(refreshSource, /if \(focusedSuccess\)/);
  assert.match(refreshSource, /waitForInjectionStatus\(cdp, true, null, 15_000\)/);
  assert.match(refreshSource, /injectionStatusReady\(status, true, null\)/);
  assert.match(refreshSource, /frameLoaded: openStatus\.frameReady === true/);
  assert.match(refreshSource, /waitForFocusedRendererAttempt\(attempts\)/);
  assert.match(refreshSource, /controller\.abort\(\)[\s\S]*await Promise\.all\(attempts\)/);
  assert.doesNotMatch(source, /Page\.getFrameTree/);
  assert.doesNotMatch(source, /waitForFrame/);
  assert.match(
    source,
    /let nextOpenAttemptAt = Date\.now\(\)[\s\S]*shouldOpen[\s\S]*status\.entryMounted[\s\S]*!status\.pageVisible[\s\S]*Date\.now\(\) >= nextOpenAttemptAt[\s\S]*__codexTaskboardInjection__\?\.open\(\)[\s\S]*nextOpenAttemptAt = Date\.now\(\) \+ 500/,
  );
  assert.doesNotMatch(source, /reopenedWhileHidden/);
});

test("OOPIF readiness uses the renderer's verified ready signal without a frame-tree false negative", () => {
  assert.match(source, /status\.frameReady[\s\S]*status\.frameVisible/);
  assert.match(source, /const frameLoaded = status\.frameReady === true/);
  assert.doesNotMatch(source, /Page\.getFrameTree/);
  assert.doesNotMatch(source, /Target\.getTargets/);
});

test("a newly appeared foreground renderer is tried before an old background failure wins", () => {
  const successfulResults = new Map();
  const attemptedTargets = new Set(["background-a"]);
  const failures = new Map([
    ["background-a", { focused: false, message: "background failed" }],
  ]);

  const firstPass = decideRefreshTaskboardPass({
    currentTargets: [{ id: "background-a" }, { id: "foreground-b" }],
    successfulResults,
    attemptedTargets,
    failures,
  });
  assert.deepEqual(firstPass, { action: "retry" });

  attemptedTargets.add("foreground-b");
  successfulResults.set("foreground-b", { targetId: "foreground-b", focused: true });
  const secondPass = decideRefreshTaskboardPass({
    currentTargets: [{ id: "background-a" }, { id: "foreground-b" }],
    successfulResults,
    attemptedTargets,
    failures,
  });
  assert.equal(secondPass.action, "success");
  assert.deepEqual(secondPass.results, [{ targetId: "foreground-b", focused: true }]);
});

test("foreground injection readiness is not blocked by a slow background target", async () => {
  let releaseBackground;
  let backgroundSettled = false;
  const background = new Promise((resolve) => {
    releaseBackground = () => {
      backgroundSettled = true;
      resolve({ status: "rejected", focused: false, targetId: "background-a" });
    };
  });
  const foreground = Promise.resolve({
    status: "fulfilled",
    focused: true,
    value: { targetId: "foreground-b" },
  });

  let timeout;
  try {
    const decision = await Promise.race([
      waitForFocusedRendererAttempt([background, foreground]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("foreground readiness was blocked")), 100);
      }),
    ]);
    assert.equal(decision.action, "focused-success");
    assert.equal(decision.outcome.value.targetId, "foreground-b");
    assert.equal(backgroundSettled, false);
  } finally {
    clearTimeout(timeout);
    releaseBackground();
    await background;
  }
});

test("initial readiness keeps its heartbeat fresh and stale refreshes fail immediately", () => {
  const waitStart = source.indexOf("async function waitForInjectionStatus");
  const evaluateStart = source.indexOf("async function evaluateInjectionSource", waitStart);
  const waitSource = source.slice(waitStart, evaluateStart);
  const injectStart = source.indexOf("async function injectTarget");
  const injectAllStart = source.indexOf("async function injectAll", injectStart);
  const injectSource = source.slice(injectStart, injectAllStart);

  assert.match(waitSource, /nextReadinessRefreshAt = Date\.now\(\) \+ 2_000/);
  assert.match(waitSource, /await refreshReadiness\(\)/);
  assert.match(waitSource, /!refreshReadiness[\s\S]*status\.heartbeatAge > 8_000/);
  assert.match(injectSource, /\(\) => publishHostHeartbeat\(cdp, startupToken\)/);
});

test("the resident preserves the open request when Codex replaces its renderer", () => {
  const watchLoopStart = source.indexOf("while (true)", source.indexOf("const firstResults"));
  const watchLoop = source.slice(watchLoopStart);
  assert.match(watchLoop, /options\.open,/);
  assert.match(watchLoop, /const cdpReachable = await isReachable\(cdpVersionUrl\)/);
  assert.match(source, /function isTransientRendererDisconnect\(error\)/);
  assert.match(source, /message === "fetch failed"/);
  assert.match(watchLoop, /!cdpReachable \|\| isTransientRendererDisconnect\(error\)/);
  assert.match(watchLoop, /rendererMissingLogged/);
  const injectAllStart = source.indexOf("async function injectAll");
  const currentSourceStart = source.indexOf("async function currentInjectionSource", injectAllStart);
  const injectAllSource = source.slice(injectAllStart, currentSourceStart);
  assert.match(injectAllSource, /sourceHash,\s*shouldOpen,\s*target\.id === screenshotTargetId \? screenshotPath/);
  assert.match(injectAllSource, /waitForFocusedRendererAttempt\(attempts\)/);
  assert.doesNotMatch(injectAllSource, /shouldOpen && firstTarget/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardOrigin\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});
