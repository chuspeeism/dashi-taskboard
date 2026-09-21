import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);
const cliReference = await readFile(
  new URL("../skills/manage-taskboard/references/cli.md", import.meta.url),
  "utf8",
);

test("the taskboard skill disambiguates companion terminology for agents", () => {
  assert.match(skillSource, /## Terminology: local companion/i);
  assert.match(skillSource, /device-local loopback service/i);
  assert.match(skillSource, /Never translate as \*\*伴侶\*\*/i);
  assert.match(skillSource, /not “companion API”/i);

  assert.match(cliReference, /## Terminology: local companion/i);
  assert.match(cliReference, /Do not use/i);
  assert.match(cliReference, /伴侶 API/i);
  assert.match(cliReference, /Taskboard HTTP API/i);
  assert.match(cliReference, /local loopback service/i);
});

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(
    skillSource,
    /first run `issue get` and `comment list`[\s\S]*Read the description and latest comments before deciding whether to start[\s\S]*If they say to wait, not execute, or not start now, stop and report without changing the status/i,
  );
  assert.match(skillSource, /Treat comments as current requirements, including returned work/i);
  assert.match(
    skillSource,
    /If work may start[\s\S]*before reading code, downloading attachments, analyzing the implementation, or doing any other task work[\s\S]*Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds/i,
  );
  assert.match(
    skillSource,
    /If the move conflicts because the `version` is stale[\s\S]*Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description and latest comments are unchanged[\s\S]*If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report[\s\S]*Never loop or take over another agent's claim/i,
  );

  assert.match(
    skillSource,
    /Verify the requested operation path[\s\S]*Add a comment with the changes, verification result, outcome, and remaining risks[\s\S]*Read the issue again, then move it to `in_review` with its current `version`/i,
  );
});

test("the taskboard skill requires complete thread bindings for claimed work", () => {
  assert.match(
    skillSource,
    /This value alone is not a complete task binding/i,
  );
  assert.match(
    skillSource,
    /must store a complete `threadBinding`:[\s\S]*`threadId`[\s\S]*`codexProjectId`[\s\S]*`codexProjectKind`[\s\S]*`codexHostId`[\s\S]*`workspacePath`/i,
  );
  assert.match(
    skillSource,
    /Pass all five explicit `--binding-\*` options[\s\S]*never create a legacy binding containing only `threadId`/i,
  );
  assert.match(
    skillSource,
    /preserve its exact five saved values on every status write[\s\S]*never take over a binding owned by another conversation/i,
  );

  assert.match(cliReference, /--binding-thread-id ID/i);
  assert.match(cliReference, /--binding-codex-project-id PROJECT_ID/i);
  assert.match(cliReference, /--binding-codex-project-kind local\|remote/i);
  assert.match(cliReference, /--binding-codex-host-id HOST_ID/i);
  assert.match(cliReference, /--binding-workspace-path PATH/i);
  assert.match(
    cliReference,
    /`--thread-id` records the conversation performing the mutation; it does not create a complete task binding/i,
  );
});
