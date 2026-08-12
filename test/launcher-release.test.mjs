import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the macOS launcher uses one instance, serialized lifecycle changes, and a private CDP pipe", () => {
  assert.match(launcherSource, /libc::flock/);
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(launcherSource, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/);
  assert.equal(launcherSource.match(/TcpListener::bind/g)?.length, 1);
  assert.match(launcherSource, /"--cdp-pipe"/);
  assert.doesNotMatch(launcherSource, /cdp_port/);
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

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, "14.0");
});
