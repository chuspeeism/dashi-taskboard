import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /read the latest issue content and all comments/i);
  assert.match(skillSource, /completed work.*returned|returned.*completed work/i);
  assert.match(skillSource, /claim.*`todo`.*`in_progress`.*`--if-version`/is);
  assert.match(skillSource, /version conflict.*skip the issue.*do not implement/is);

  assert.match(
    skillSource,
    /after implementation and self-verification[\s\S]*?add a comment[\s\S]*?key changes[\s\S]*?verification[\s\S]*?result[\s\S]*?remaining risks[\s\S]*?move the issue to `in_review`/i,
  );
  assert.match(skillSource, /attachment upload[\s\S]*?previewable delivery cards/i);
});
