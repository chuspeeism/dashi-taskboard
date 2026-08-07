import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIssueUrl } from "../web/src/issueRoute.ts";
import {
  buildTaskboardHistoryUpdate,
  resolveTaskboardRouteUrl,
} from "../web/src/taskboardRoute.ts";

const BLOB_URL = "blob:app://-/702e061f-ea75-4125-8298-d3299605b1ea";
const PROJECT_ID = "e70fb922-5c6b-4d70-8ff6-d793b0c76c94";

test("blob taskboard routes keep the physical URL unchanged", () => {
  const currentRoute = resolveTaskboardRouteUrl(
    BLOB_URL,
    null,
    "http://127.0.0.1:47823/",
  );
  const projectRoute = buildIssueUrl(currentRoute.href, PROJECT_ID, null);
  const update = buildTaskboardHistoryUpdate(BLOB_URL, null, projectRoute);

  assert.equal(update.url, null);
  assert.equal(
    resolveTaskboardRouteUrl(BLOB_URL, update.state, "http://127.0.0.1:47823/").search,
    `?project=${PROJECT_ID}`,
  );
});

test("blob taskboard route updates preserve existing history state", () => {
  const route = new URL(`http://127.0.0.1:47823/?project=${PROJECT_ID}&issue=LOCAL-72`);
  const update = buildTaskboardHistoryUpdate(BLOB_URL, { codex: "state" }, route);

  assert.equal(update.url, null);
  assert.equal(update.state.codex, "state");
  assert.equal(
    resolveTaskboardRouteUrl(BLOB_URL, update.state, "http://127.0.0.1:47823/").href,
    route.href,
  );
});

test("http taskboard routes still write the requested URL", () => {
  const current = "http://127.0.0.1:47823/?host=codex";
  const route = buildIssueUrl(current, PROJECT_ID, "LOCAL-72");
  const state = { codex: "state" };
  const update = buildTaskboardHistoryUpdate(current, state, route);

  assert.equal(update.state, state);
  assert.equal(update.url?.href, route.href);
  assert.equal(resolveTaskboardRouteUrl(current, state, current).href, current);
});
