import assert from "node:assert/strict";
import test from "node:test";

import { taskStatusForCodexThread } from "../server/codex-sessions.mjs";

test("Codex thread states map to taskboard columns", () => {
  assert.equal(taskStatusForCodexThread({ type: "active", activeFlags: [] }), "in_progress");
  assert.equal(taskStatusForCodexThread({ type: "active", activeFlags: ["waitingOnUserInput"] }), "todo");
  assert.equal(taskStatusForCodexThread({ type: "active", activeFlags: ["waitingOnApproval"] }), "in_review");
  assert.equal(taskStatusForCodexThread({ type: "systemError" }), "blocked");
  assert.equal(taskStatusForCodexThread({ type: "idle" }), "done");
});
