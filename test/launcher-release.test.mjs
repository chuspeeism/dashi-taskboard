import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the launcher keeps CDP random and prefers the Taskboard port with a fallback", () => {
  assert.match(launcherSource, /libc::flock/);
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(
    launcherSource,
    /fn loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/,
  );
  assert.match(launcherSource, /const TASKBOARD_PREFERRED_PORT: u16 = 47823;/);
  assert.match(
    launcherSource,
    /fn taskboard_loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", TASKBOARD_PREFERRED_PORT\)\)[\s\S]*?\.or_else\(\|_\| TcpListener::bind\(\("127\.0\.0\.1", 0\)\)\)/,
  );
  assert.equal(
    launcherSource.match(
      /fn taskboard_listener\([^)]*\)[\s\S]*?taskboard_loopback_listener\(\)\?/g,
    )?.length,
    2,
  );
  assert.match(launcherSource, /codex_port: Mutex<Option<u16>>/);
  assert.match(
    launcherSource,
    /fn codex_port\([\s\S]*?let listener = loopback_listener\(\)\?;/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "macos"\)\]\s+command\.args\(\["--launch", "--watch", "--open", "--port", &codex_port\]\);/,
  );
  assert.doesNotMatch(launcherSource, /const LAUNCHER_PORT/);
});

test("release signing is tag-only and PR CI builds the real unsigned app bundle", () => {
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
  assert.match(releaseWorkflow, /package\.json/);
  assert.match(releaseWorkflow, /Cargo\.toml/);
  assert.match(releaseWorkflow, /tauri\.conf\.json/);
  assert.match(releaseWorkflow, /TAG_FORCED/);
  assert.match(releaseWorkflow, /sign-macos-app\.mjs/);
  assert.match(releaseWorkflow, /notarytool submit/);
  assert.match(releaseWorkflow, /stapler validate/);
  assert.match(checkWorkflow, /tauri -- build/);
  assert.match(checkWorkflow, /--bundles app/);
  assert.match(checkWorkflow, /--no-sign/);
});

test("Windows CI runs the Node suite and the unsigned launcher skips unsupported updates", () => {
  assert.match(
    checkWorkflow,
    /windows-launcher:[\s\S]*?run: npm test[\s\S]*?run: npm run app:build:windows/,
  );
  assert.match(
    launcherSource,
    /cfg!\(target_os = "windows"\)[\s\S]*?Windows 版本暫不支援自動更新/,
  );
});

test("Windows CI uploads the NSIS installer with the pinned Node 24 artifact action", () => {
  assert.match(
    checkWorkflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  );
  assert.doesNotMatch(checkWorkflow, /actions\/upload-artifact@[^\s]+ # v4/);
});

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, "14.0");
});
