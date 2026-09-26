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

test("fenced examples cannot override the real completion policy", () => {
  const result = parseTaskContinuation(`
\`\`\`markdown
## Completion policy
continuation: auto
## Next task:
Title: Example only
Goal: Must never run
## Acceptance
- Example
\`\`\`

## Completion policy
continuation: stop
`);
  assert.equal(result.outcome, "stopped");
  assert.equal(result.nextTask, null);
});

test("acceptance is taken from the next task rather than the parent task", () => {
  const result = parseTaskContinuation(`
## Acceptance
- Parent behavior works

## Completion policy
continuation: auto

## Next task:
Title: Release phase
Goal: Prepare the approved release
## Acceptance
- Deploy production
`);
  assert.equal(result.outcome, "backlog_created");
  assert.equal(result.nextTask.status, "backlog");
  assert.equal(result.nextTask.highImpact, true);
  assert.match(result.nextTask.description, /Deploy production/);
  assert.doesNotMatch(result.nextTask.description, /Parent behavior works/);
});

test("longer closing and unclosed fences cannot supply continuation directives", () => {
  const longerClose = parseTaskContinuation(`
\`\`\`
## Completion policy
continuation: auto
\`\`\`\`
## Completion policy
continuation: stop
`);
  assert.equal(longerClose.outcome, "stopped");

  const unclosed = parseTaskContinuation(`
\`\`\`
## Completion policy
continuation: auto
## Next task:
Title: Hidden
Goal: Hidden
`);
  assert.equal(unclosed.outcome, "missing_next_task");
});

test("next task acceptance cannot be borrowed across another section", () => {
  const result = parseTaskContinuation(`
## Completion policy
continuation: auto
## Next task:
Title: Incomplete child
## Parent report
### Acceptance
- Parent evidence only
`);
  assert.equal(result.outcome, "missing_next_task");
  assert.equal(result.nextTask, null);
});

test("a blank title cannot consume the following goal line", () => {
  const result = parseTaskContinuation(`
## Completion policy
continuation: auto
## Next task:
Title:
Goal: Work
## Acceptance
- Verified
`);
  assert.equal(result.outcome, "missing_next_task");
  assert.equal(result.nextTask, null);
});
