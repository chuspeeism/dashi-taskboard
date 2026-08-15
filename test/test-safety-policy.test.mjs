import assert from "node:assert/strict";
import test from "node:test";
import { matchesGlob } from "node:path";

import packageManifest from "../package.json" with { type: "json" };

import { lanTestOptions } from "./support/safety-policy.mjs";

function isDefaultNodeTestFile(file) {
  return [
    "**/test.{js,mjs,cjs}",
    "**/test-*.{js,mjs,cjs}",
    "**/*.test.{js,mjs,cjs}",
    "**/*.spec.{js,mjs,cjs}",
  ].some((pattern) => matchesGlob(file, pattern));
}

test("LAN tests are skipped before their callbacks when loopback-only mode is enabled", () => {
  assert.deepEqual(
    lanTestOptions({ CODEX_TASKBOARD_LOOPBACK_ONLY: "1" }),
    { skip: "Disabled by loopback-only safety policy" },
  );
});

test("LAN tests retain their normal execution options outside loopback-only mode", () => {
  assert.deepEqual(lanTestOptions({}), {});
  assert.deepEqual(lanTestOptions({ CODEX_TASKBOARD_LOOPBACK_ONLY: "0" }), {});
});

test("the loopback-safe package entry avoids Node's default test discovery", () => {
  const runner = packageManifest.scripts["test:loopback-safe"].split(/\s+/).at(-1);
  assert.equal(isDefaultNodeTestFile(runner), false);
});
