import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("Atlas Workbench is the visible product while existing Taskboard data remains compatible", async () => {
  const [html, styles, tauriSource, injectionSource, packageSource, tauriConfigSource, buildSource, updaterSource, releaseWorkflow] =
    await Promise.all([
      read("../web/index.html"),
      read("../web/src/styles.css"),
      read("../src-tauri/src/main.rs"),
      read("../inject/codex-taskboard.user.js"),
      read("../package.json"),
      read("../src-tauri/tauri.conf.json"),
      read("../scripts/tauri-build.mjs"),
      read("../scripts/create-macos-updater.mjs"),
      read("../.github/workflows/release-macos.yml"),
    ]);

  const packageJson = JSON.parse(packageSource);
  const tauriConfig = JSON.parse(tauriConfigSource);

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Atlas Workbench<\/title>/);
  assert.match(html, /阿特拉斯工作台/);
  assert.match(styles, /--accent:\s*#6a1b9a;/i);
  assert.equal(tauriConfig.productName, "Atlas Workbench");
  assert.equal(tauriConfig.identifier, "com.chuspeeism.codex-taskboard");
  assert.equal(packageJson.bin.atlasctl, "./cli/taskctl.mjs");
  assert.equal(packageJson.bin.taskctl, "./cli/taskctl.mjs");
  assert.match(buildSource, /"Atlas Workbench"/);
  assert.match(updaterSource, /Atlas\.Workbench_/);
  assert.doesNotMatch(releaseWorkflow, /Codex\.Taskboard_/);
  assert.match(releaseWorkflow, /Atlas\.Workbench_/);
  assert.match(injectionSource, /阿特拉斯工作台/);
  assert.match(injectionSource, /Atlas Workbench/);

  // Compatibility boundary: do not move existing local data during the rename.
  assert.match(tauriSource, /Library\/Application Support\/Codex Taskboard/);
});
