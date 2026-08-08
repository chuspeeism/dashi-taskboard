import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /run `issue get` and `comment list` before acting/i);
  assert.match(skillSource, /Treat comments as current requirements, including returned work/i);
  assert.match(skillSource, /read the issue again and move it to `in_progress` with its current `version`/i);
  assert.match(skillSource, /Stop if the status changed or the write conflicts/i);

  assert.match(
    skillSource,
    /Verify the requested operation path[\s\S]*Add a comment with the changes, verification result, outcome, and remaining risks[\s\S]*Read the issue again, then move it to `in_review` with its current `version`/i,
  );
});

test("the taskboard skill reads shared context before implementation and publishes durable outcomes", () => {
  assert.match(skillSource, /\$shared-project-context/i);
  assert.match(
    skillSource,
    /taskboard_context_current_project[\s\S]*read the latest issue content and all comments[\s\S]*taskboard_context_brief[\s\S]*taskboard_context_search/i,
  );
  assert.match(skillSource, /issue title[\s\S]*labels[\s\S]*meaningful terms.*description/i);
  assert.match(skillSource, /requirements?.*constraints?.*decisions?.*risks?.*work constraints/is);
  assert.match(skillSource, /conflict[\s\S]*source[\s\S]*`updatedAt`[\s\S]*never choose silently/i);
  assert.match(skillSource, /durable.*decision.*constraint.*state.*risk.*handoff.*summary.*next step/is);
  assert.match(skillSource, /stable.*issue-scoped.*`idempotencyKey`/i);
  assert.match(skillSource, /potentially sensitive[\s\S]*explicit (?:user )?approval/i);
  assert.match(skillSource, /`sourceType: agent`/i);
  assert.match(skillSource, /shared context.*MCP tools[\s\S]*not `taskctl`/i);
});

test("shared project context Skill uses only the seven guarded MCP operations", async () => {
  const sharedSkill = await readFile(
    new URL("../skills/shared-project-context/SKILL.md", import.meta.url),
    "utf8",
  );
  const agentManifest = await readFile(
    new URL("../skills/shared-project-context/agents/openai.yaml", import.meta.url),
    "utf8",
  );

  assert.match(sharedSkill, /^---\nname: shared-project-context\n/m);
  assert.match(sharedSkill, /MCP tools exclusively|exclusively.*MCP tools/i);
  assert.match(
    sharedSkill,
    /taskboard_context_current_project[\s\S]*taskboard_context_brief[\s\S]*taskboard_context_search[\s\S]*taskboard_context_get/i,
  );
  assert.match(sharedSkill, /conflict[\s\S]*source[\s\S]*`updatedAt`[\s\S]*never choose silently/i);
  assert.match(sharedSkill, /requirement.*decision.*constraint.*fact.*risk.*handoff.*summary/is);
  assert.match(sharedSkill, /stable.*`idempotencyKey`/i);
  assert.match(sharedSkill, /taskboard_context_update[\s\S]*current `version`/i);
  assert.match(sharedSkill, /taskboard_context_archive[\s\S]*current `version`/i);
  for (const code of [
    "PROJECT_MAPPING_NOT_FOUND",
    "CONTEXT_NOT_FOUND",
    "VERSION_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "CONTEXT_ALREADY_ARCHIVED",
    "UNAUTHORIZED",
    "CLOUD_NOT_CONFIGURED",
    "REMOTE_UNAVAILABLE",
    "COMPANION_UNAVAILABLE",
  ]) {
    assert.match(sharedSkill, new RegExp(code));
  }
  assert.match(sharedSkill, /potentially sensitive[\s\S]*explicit (?:user )?approval/i);
  assert.match(sharedSkill, /`sourceType: agent`/i);
  assert.match(sharedSkill, /never[\s\S]*(?:direct database|SQLite)[\s\S]*`curl`[\s\S]*Codex internal state/i);
  assert.match(sharedSkill, /no local fallback|never fall back.*local/i);
  assert.match(agentManifest, /value: "dashi-taskboard"/i);
  assert.match(agentManifest, /\$shared-project-context/i);
});
