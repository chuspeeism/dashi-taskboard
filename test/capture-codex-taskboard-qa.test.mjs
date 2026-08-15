import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultCaptureOutputDirectory,
  minimalSidebarEvidence,
  normalizeScreenshotClip,
} from "../scripts/capture-codex-taskboard-qa-lib.mjs";

test("Codex QA capture defaults to ignored local artifacts", () => {
  assert.equal(
    defaultCaptureOutputDirectory("/workspace/taskboard"),
    path.join("/workspace/taskboard", ".artifacts/codex-qa/customized-codex"),
  );
});

test("Codex QA evidence excludes task and thread text", () => {
  const evidence = minimalSidebarEvidence({
    dataTheme: "light",
    colorScheme: "light",
    taskboardRuntime: "present",
    sidebarScrollCount: 1,
    pluginPresent: true,
    entryMounted: true,
    sameParent: true,
    pluginIndex: 2,
    entryIndex: 3,
    passesAfterPlugins: true,
    bodyText: "private task and thread content",
    visibleSiblings: [{ text: "private conversation title" }],
    plugin: { text: "Plugins", attributes: { title: "private" } },
    entry: { text: "Taskboard", attributes: { title: "private" } },
  });

  assert.deepEqual(evidence, {
    dataTheme: "light",
    colorScheme: "light",
    taskboardRuntime: "present",
    sidebarScrollCount: 1,
    pluginPresent: true,
    entryMounted: true,
    sameParent: true,
    pluginIndex: 2,
    entryIndex: 3,
    itemsBetween: 0,
    passesAfterPlugins: true,
  });
  assert.equal(JSON.stringify(evidence).includes("private"), false);
});

test("Codex QA screenshot clip is limited to the sidebar entries and viewport", () => {
  assert.deepEqual(
    normalizeScreenshotClip(
      { x: -8, y: 96, width: 308, height: 128 },
      { width: 1440, height: 900 },
    ),
    { x: 0, y: 96, width: 300, height: 128, scale: 1 },
  );
});
