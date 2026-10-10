import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../cli/taskctl.mjs";
import { AGENT_LOOP_STORAGE_KEY, decisionState, reworkRequested } from "../shared/agent-loop.mjs";

const agent = (body) => ({ authorType: "agent", body });
const user = (body) => ({ authorType: "user", body });

function task(id, status, extra = {}) {
  return {
    id,
    status,
    priority: "none",
    sortOrder: 1024,
    version: 1,
    labels: [],
    archivedAt: null,
    relations: { blockedBy: [] },
    ...extra,
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// A minimal in-memory taskboard API for taskctl next / loop config.
function board({ tasks, comments = {}, loop = { enabled: true, maxConcurrent: 2 }, conflictIds = [] }) {
  const storage = { [AGENT_LOOP_STORAGE_KEY]: JSON.stringify({ demo: loop }) };
  const moves = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (pathname === "/api/client-storage" && method === "GET") return json({ entries: storage });
    if (pathname === "/api/client-storage" && method === "PATCH") {
      const { key, value } = JSON.parse(init.body);
      storage[key] = value;
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/tasks") return json({ tasks });
    const commentRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
    if (commentRoute) return json({ comments: comments[decodeURIComponent(commentRoute[1])] ?? [] });
    const moveRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (moveRoute) {
      const id = decodeURIComponent(moveRoute[1]);
      if (conflictIds.includes(id)) {
        return json({ error: { code: "VERSION_CONFLICT", message: "Task changed" } }, 409);
      }
      const body = JSON.parse(init.body);
      moves.push({ id, ...body });
      return json({ task: { ...tasks.find((candidate) => candidate.id === id), status: body.status } });
    }
    throw new Error(`Unexpected ${method} ${pathname}`);
  };
  return { fetch, moves, storage };
}

async function taskctl(argv, fetch) {
  let out = "";
  let err = "";
  const exitCode = await main(argv, {
    fetch,
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write(chunk) { err += chunk; } },
    env: { CODEX_TASKBOARD_URL: "http://127.0.0.1:1" },
  });
  return { exitCode, result: JSON.parse(exitCode === 0 ? out : err) };
}

const CLAIM = ["--claim", "--agent-platform", "claude", "--session-id", "loop-1"];

test("decision and rework markers follow comment order", () => {
  assert.equal(decisionState([agent("progress")]), "none");
  assert.equal(decisionState([agent("[decision-request] A or B?")]), "waiting");
  assert.equal(decisionState([agent("[decision-request] A or B?"), user("B")]), "answered");
  assert.equal(reworkRequested([agent("done"), user("/rework fix the copy")]), true);
  assert.equal(reworkRequested([user("/rework fix the copy"), agent("reworked")]), false);
});

test("next prefers answered decisions, then rework, then unblocked todo by priority", async () => {
  const tasks = [
    task("todo-low", "todo", { priority: "low" }),
    task("todo-blocked", "todo", { priority: "urgent", relations: { blockedBy: [{ status: "in_progress" }] } }),
    task("todo-hold", "todo", { priority: "urgent", labels: ["hold"] }),
    task("todo-high", "todo", { priority: "high" }),
    task("review", "in_review"),
    task("waiting", "blocked"),
  ];
  const comments = {
    review: [user("/rework please")],
    waiting: [agent("[decision-request] Which API?"), user("Use the GraphQL one")],
  };
  const { fetch } = board({ tasks, comments, loop: { enabled: true, maxConcurrent: 5 } });
  const picks = [];
  for (const done of [[], ["waiting"], ["waiting", "review"]]) {
    const remaining = tasks.filter((candidate) => !done.includes(candidate.id));
    const view = board({ tasks: remaining, comments, loop: { enabled: true, maxConcurrent: 5 } });
    const { result } = await taskctl(["next", "--project", "demo"], view.fetch);
    picks.push(`${result.kind}:${result.task.id}`);
  }
  assert.deepEqual(picks, ["resume:waiting", "rework:review", "new:todo-high"]);
  assert.equal((await taskctl(["next", "--project", "demo"], fetch)).result.reason, "available");
});

test("next --claim stops at the concurrency limit", async () => {
  const working = task("working", "in_progress", { agentSession: { platform: "claude", sessionId: "s" } });
  const { fetch, moves } = board({
    tasks: [working, task("a", "todo"), task("b", "todo")],
    loop: { enabled: true, maxConcurrent: 2 },
  });
  const first = await taskctl(["next", "--project", "demo", ...CLAIM], fetch);
  assert.equal(first.result.reason, "claimed");
  assert.equal(first.result.active, 2);
  assert.deepEqual(moves[0], {
    id: "a",
    status: "in_progress",
    agentSession: { platform: "claude", sessionId: "loop-1" },
    version: 1,
  });

  const full = board({ tasks: [working, { ...task("a", "in_progress"), threadId: "t" }, task("b", "todo")] });
  const second = await taskctl(["next", "--project", "demo", ...CLAIM], full.fetch);
  assert.equal(second.result.reason, "concurrency_limit");
  assert.equal(second.result.task, null);
});

test("next --claim skips a version conflict and claims the next candidate", async () => {
  const { fetch, moves } = board({
    tasks: [task("a", "todo", { priority: "high" }), task("b", "todo")],
    conflictIds: ["a"],
  });
  const { result } = await taskctl(["next", "--project", "demo", ...CLAIM], fetch);
  assert.equal(result.reason, "claimed");
  assert.equal(result.task.id, "b");
  assert.deepEqual(moves.map((move) => move.id), ["b"]);
});

test("next is a no-op while the loop is disabled", async () => {
  const { fetch, moves } = board({ tasks: [task("a", "todo")], loop: { enabled: false, maxConcurrent: 2 } });
  const { result } = await taskctl(["next", "--project", "demo", ...CLAIM], fetch);
  assert.equal(result.reason, "disabled");
  assert.equal(moves.length, 0);
});

test("loop config updates only the selected project", async () => {
  const { fetch, storage } = board({ tasks: [] });
  const { result } = await taskctl(
    ["loop", "config", "--project", "other", "--enable", "--max-concurrent", "3"],
    fetch,
  );
  const other = { enabled: true, maxConcurrent: 3, repoPath: null, labelRepos: {} };
  assert.deepEqual(result.settings, other);
  assert.deepEqual(JSON.parse(storage[AGENT_LOOP_STORAGE_KEY]), {
    demo: { enabled: true, maxConcurrent: 2 },
    other,
  });
  const invalid = await taskctl(["loop", "config", "--project", "other", "--max-concurrent", "0"], fetch);
  assert.equal(invalid.exitCode, 2);
});
