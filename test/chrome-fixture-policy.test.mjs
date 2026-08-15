import assert from "node:assert/strict";
import test from "node:test";

import {
  chromeFixtureSkipReason,
  runChromeFixture,
} from "./support/chrome-fixture-policy.mjs";

test("Chrome fixtures skip only when no executable was found", () => {
  assert.equal(chromeFixtureSkipReason(null), "Chrome or Chromium is not installed");
  assert.equal(chromeFixtureSkipReason("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), null);
});

test("Chrome fixture launch failures are surfaced once an executable is found", async () => {
  const launchFailure = new Error("Chrome exited unexpectedly");
  await assert.rejects(
    runChromeFixture("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", async () => {
      throw launchFailure;
    }),
    launchFailure,
  );
});
