import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const databaseSource = await readFile(
  new URL("../server/database.mjs", import.meta.url),
  "utf8",
);
const cloudSource = await readFile(
  new URL("../cloud/src/index.mjs", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("task list activity queries project metadata while detail routes retain full changes", () => {
  const localListQuery = between(
    databaseSource,
    "  #activitiesForTasks(taskIds)",
    "  #taskPreviewImages(taskIds)",
  );
  const localDetailQuery = between(
    databaseSource,
    "  listTaskActivities(taskId)",
    "  listComments(taskId)",
  );
  const cloudListQuery = between(
    cloudSource,
    "async function taskActivitiesForTasks(env, taskIds)",
    "function parseProjectCreate(body)",
  );
  const cloudDetailQuery = between(
    cloudSource,
    "async function listTaskActivities(env, taskId)",
    "async function listComments(env, taskId)",
  );

  for (const listQuery of [localListQuery, cloudListQuery]) {
    assert.match(
      listQuery,
      /SELECT\s+id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at\s+FROM task_activities/s,
    );
    assert.doesNotMatch(listQuery, /SELECT \* FROM task_activities/);
    assert.doesNotMatch(listQuery, /\bchanges\b/);
  }
  for (const detailQuery of [localDetailQuery, cloudDetailQuery]) {
    assert.match(detailQuery, /SELECT \* FROM task_activities/);
    assert.match(detailQuery, /taskActivityFromRow/);
  }
});

test("view tabs expose a visible keyboard focus indicator", () => {
  assert.match(
    styles,
    /button:focus-visible,[\s\S]*?\[tabindex\][^{]*\{[^}]*outline:\s*2px solid color-mix\(in srgb, var\(--accent\) 70%, transparent\);[^}]*outline-offset:\s*1px;/s,
  );
  assert.doesNotMatch(styles, /\.view-tab:focus-visible\s*\{[^}]*outline:\s*0;/s);
});
