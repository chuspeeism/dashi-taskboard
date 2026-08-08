import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildMacOSLauncherArtifacts,
  installMacOSLauncher,
  loadLaunchAgent,
} from "../scripts/macos-launcher.mjs";
import { codexLaunchArguments } from "../scripts/codex-injector.mjs";
import { shouldStopWatchingForMissingRenderer } from "../scripts/codex-injector-runtime.mjs";

const fixture = buildMacOSLauncherArtifacts({
  homeDirectory: "/Users/tester",
  repoRoot: "/Users/tester/Projects/dashi-taskboard",
  nodeBinary: "/Users/tester/.nvm/versions/node/v24.15.0/bin/node",
  codexExecutable: "/Users/tester/.nvm/versions/node/v24.15.0/bin/codex",
});
const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");

test("the macOS plan has one visible entry and an independent persistent service", () => {
  assert.equal(fixture.appPath, "/Users/tester/Applications/Codex + Taskboard.app");
  assert.match(fixture.appInfoPlist, /CFBundleDisplayName.*Codex \+ Taskboard/s);
  assert.match(fixture.servicePlist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(fixture.servicePlist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(fixture.servicePlist, /CODEX_TASKBOARD_DATA_DIR/);
  assert.match(fixture.servicePlist, /CODEX_EXECUTABLE/);
  assert.match(fixture.servicePlist, /\/Users\/tester\/\.nvm\/versions\/node\/v24\.15\.0\/bin\/codex/);
  assert.match(fixture.servicePlist, /server\/index\.mjs/);
  assert.match(fixture.codexPlist, /CodexTaskboardLauncher/);
  assert.match(fixture.codexPlist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(fixture.codexPlist, /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  assert.doesNotMatch(fixture.codexPlist, /<key>KeepAlive<\/key>/);
});

test("the launcher recovers a stale injector and degrades ordinary Codex once without quitting it", () => {
  assert.match(fixture.launcherScript, /--launch --watch --managed-taskboard --open/);
  assert.match(fixture.launcherScript, /--managed-taskboard/);
  assert.match(fixture.launcherScript, /--attach-existing/);
  assert.match(fixture.launcherScript, /stale resident injector without CDP; stopping pids=/);
  assert.match(fixture.launcherScript, /resident injector failed open readiness; stopping pids=/);
  assert.doesNotMatch(fixture.launcherScript, /refresh_existing \|\| true/);
  assert.match(fixture.launcherScript, /\/bin\/kill -TERM "\$stale_pid"/);
  assert.doesNotMatch(fixture.launcherScript, /tell application "ChatGPT" to quit/);
  assert.match(fixture.launcherScript, /ordinary_codex_running\(\)/);
  assert.match(fixture.launcherScript, /notify_degraded\(\)/);
  assert.match(fixture.launcherScript, /display notification/);
  assert.doesNotMatch(fixture.launcherScript, /display dialog/);
  assert.match(fixture.launcherScript, /CODEX_TASKBOARD_CODEX_USER_DATA_PATH/);
  assert.match(fixture.launcherScript, /CodexProfile/);
  assert.match(fixture.launcherScript, /if \[\[ "\$MODE" != "--login" \]\]/);
  assert.match(fixture.launcherScript, /launchctl kickstart -k/);
  assert.match(fixture.launcherScript, /launchctl bootstrap/);
  assert.match(fixture.launcherScript, /wait "\$RESIDENT_PID"/);
  assert.doesNotMatch(fixture.launcherScript, /KeepAlive/);
});

test("the Taskboard launch opens an isolated Codex instance with loopback CDP", () => {
  assert.deepEqual(codexLaunchArguments(
    "/Applications/ChatGPT.app",
    9229,
    "/Users/tester/Library/Application Support/Dashi Taskboard/CodexProfile",
  ), [
    "-W",
    "-n",
    "--env",
    "CODEX_ELECTRON_USER_DATA_PATH=/Users/tester/Library/Application Support/Dashi Taskboard/CodexProfile",
    "-a",
    "/Applications/ChatGPT.app",
    "--args",
    "--user-data-dir=/Users/tester/Library/Application Support/Dashi Taskboard/CodexProfile",
    "--remote-debugging-port=9229",
    "--remote-allow-origins=http://127.0.0.1:9229",
  ]);
  assert.match(injectorSource, /if \(shouldOpen\) await cdp\.send\("Page\.bringToFront"\)/);
});

test("resident recovery is scoped to the configured Codex debugging port", () => {
  const residentStart = fixture.launcherScript.indexOf("resident_pids() {");
  const runtimeDirectoryStart = fixture.launcherScript.indexOf("ensure_runtime_directory() {", residentStart);
  const residentSource = fixture.launcherScript.slice(residentStart, runtimeDirectoryStart);

  assert.match(residentSource, /--watch\.\*--port\[=\[:space:\]\]\$CDP_PORT/);
  assert.doesNotMatch(fixture.launcherScript, /pgrep -f "\$INJECTOR_SCRIPT\.\*--watch"/);
  assert.match(fixture.launcherScript, /RESIDENT_PIDS=\$\(resident_pids\)/);
  assert.match(fixture.launcherScript, /STALE_RESIDENT_PIDS="\$RESIDENT_PIDS"/);
});

test("a newly bootstrapped Taskboard service gets a readiness window before kickstart", () => {
  const ensureStart = fixture.launcherScript.indexOf("ensure_taskboard_service() {");
  const refreshStart = fixture.launcherScript.indexOf("refresh_existing() {", ensureStart);
  const ensureSource = fixture.launcherScript.slice(ensureStart, refreshStart);
  const bootstrapAt = ensureSource.indexOf("launchctl bootstrap");
  const bootstrapWaitAt = ensureSource.indexOf("if wait_for_taskboard_service; then", bootstrapAt);
  const bootstrapFailureAt = ensureSource.indexOf(
    "Taskboard service did not become ready after bootstrap",
    bootstrapWaitAt,
  );
  const kickstartAt = ensureSource.indexOf("launchctl kickstart -k", bootstrapFailureAt);

  assert.ok(bootstrapAt >= 0);
  assert.ok(bootstrapWaitAt > bootstrapAt);
  assert.ok(bootstrapFailureAt > bootstrapWaitAt);
  assert.ok(kickstartAt > bootstrapFailureAt);
});

test("repeated launcher clicks open the existing Taskboard without restarting Codex", () => {
  const refreshStart = fixture.launcherScript.indexOf("refresh_existing() {");
  const residentStart = fixture.launcherScript.indexOf("run_resident() {");
  const refreshSource = fixture.launcherScript.slice(refreshStart, residentStart);

  assert.match(refreshSource, /--refresh --open/);
  assert.doesNotMatch(refreshSource, /--refresh-if-running/);
  const interactiveStart = fixture.launcherScript.indexOf('if [[ "$MODE" != "--login" ]]');
  const loginStart = fixture.launcherScript.indexOf("RESIDENT_PIDS=$(resident_pids)", interactiveStart);
  const interactiveSource = fixture.launcherScript.slice(interactiveStart, loginStart);
  assert.ok(loginStart > interactiveStart);
  assert.match(
    interactiveSource,
    /if cdp_reachable; then[\s\S]*tell application "ChatGPT" to activate[\s\S]*if refresh_existing; then/,
  );
  assert.doesNotMatch(fixture.launcherScript, /\/bin\/sleep 8/);
});

test("reinstalling waits for a registered agent to disappear before bootstrapping", async () => {
  const calls = [];
  const waits = [];
  const printStatuses = [0, 0, 1, 1];
  let bootstrapCalls = 0;
  const runLaunchctl = (args) => {
    calls.push(args);
    if (args[0] === "print") return { status: printStatuses.shift() ?? 1, stdout: "", stderr: "" };
    if (args[0] === "bootout") return { status: 0, stdout: "", stderr: "" };
    bootstrapCalls += 1;
    return bootstrapCalls === 1
      ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      : { status: 0, stdout: "", stderr: "" };
  };

  await loadLaunchAgent("/tmp/example.plist", "com.example.agent", 501, {
    runLaunchctl,
    waitFor: async (milliseconds) => waits.push(milliseconds),
    removalPollIntervalMs: 10,
    removalTimeoutMs: 30,
    bootstrapRetryDelayMs: 20,
  });

  assert.deepEqual(calls, [
    ["print", "gui/501/com.example.agent"],
    ["bootout", "gui/501/com.example.agent"],
    ["print", "gui/501/com.example.agent"],
    ["print", "gui/501/com.example.agent"],
    ["bootstrap", "gui/501", "/tmp/example.plist"],
    ["print", "gui/501/com.example.agent"],
    ["bootstrap", "gui/501", "/tmp/example.plist"],
  ]);
  assert.deepEqual(waits, [10, 20]);
});

test("the default removal budget covers launchd's five-second exit window", async () => {
  let bootoutStarted = false;
  let removalChecks = 0;
  const waits = [];
  const runLaunchctl = (args) => {
    if (args[0] === "print") {
      if (!bootoutStarted) return { status: 0, stdout: "", stderr: "" };
      removalChecks += 1;
      return removalChecks > 50
        ? { status: 1, stdout: "", stderr: "not loaded" }
        : { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      bootoutStarted = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  await loadLaunchAgent("/tmp/example.plist", "com.example.agent", 501, {
    runLaunchctl,
    waitFor: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(removalChecks, 51);
  assert.equal(waits.length, 50);
  assert.ok(waits.every((milliseconds) => milliseconds === 100));
  assert.equal(waits.reduce((total, milliseconds) => total + milliseconds, 0), 5_000);
});

test("bootstrap status 5 stops after the finite retry budget", async () => {
  let bootstrapCalls = 0;
  const waits = [];
  const runLaunchctl = (args) => {
    if (args[0] === "print") return { status: 1, stdout: "", stderr: "not loaded" };
    bootstrapCalls += 1;
    return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
  };

  await assert.rejects(
    loadLaunchAgent("/tmp/example.plist", "com.example.agent", 501, {
      runLaunchctl,
      waitFor: async (milliseconds) => waits.push(milliseconds),
      bootstrapAttempts: 3,
      bootstrapRetryDelayMs: 20,
    }),
    /bootstrap failed for com\.example\.agent after 3 attempts: Bootstrap failed: 5/,
  );
  assert.equal(bootstrapCalls, 3);
  assert.deepEqual(waits, [20, 20]);
});

test("installing the launcher refreshes the macOS app signature", {
  skip: process.platform !== "darwin",
}, async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "codex-taskboard-launcher-"));
  try {
    const installed = await installMacOSLauncher({
      homeDirectory,
      repoRoot: "/Users/tester/Projects/dashi-taskboard",
      nodeBinary: process.execPath,
      codexExecutable: "codex",
    });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed.appPath]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("the renderer watcher exits only after the recovery grace window", () => {
  assert.equal(shouldStopWatchingForMissingRenderer({
    missingSince: 1_000,
    now: 5_000,
    graceMs: 5_000,
    codexProcessExited: false,
  }), false);
  assert.equal(shouldStopWatchingForMissingRenderer({
    missingSince: 1_000,
    now: 6_000,
    graceMs: 5_000,
    codexProcessExited: false,
  }), true);
  assert.equal(shouldStopWatchingForMissingRenderer({
    missingSince: 1_000,
    now: 1_001,
    graceMs: 60_000,
    codexProcessExited: true,
  }), true);
});
