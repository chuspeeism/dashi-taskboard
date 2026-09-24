import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskContinuation } from "../shared/task-continuation.mjs";

test("auto continuation creates one eligible todo specification", () => {
  const result = parseTaskContinuation(`
## Completion policy
continuation: auto

## Next task:
Title: Build phase two
Goal: Implement the approved phase
## Acceptance
- Main path works
`);

  assert.equal(result.outcome, "todo_created");
  assert.equal(result.nextTask.status, "todo");
  assert.equal(result.nextTask.title, "Build phase two");
});

test("approval continuation produces backlog and stop produces nothing", () => {
  const approval = parseTaskContinuation(`
## Completion policy
continuation: approval
## Next task:
Title: Explore phase two
Goal: Draft options
## Acceptance
- Options documented
`);
  assert.equal(approval.outcome, "backlog_created");
  assert.equal(approval.nextTask.status, "backlog");

  const stopped = parseTaskContinuation("## Completion policy\ncontinuation: stop");
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.nextTask, null);
});

test("high-impact auto continuation is downgraded to approval", () => {
  const result = parseTaskContinuation(`
## Completion policy
continuation: auto
## Next task:
Title: Deploy production
Goal: Publish the release
## Acceptance
- Production is live
`);
  assert.equal(result.outcome, "backlog_created");
  assert.equal(result.nextTask.status, "backlog");
  assert.equal(result.nextTask.highImpact, true);
});
