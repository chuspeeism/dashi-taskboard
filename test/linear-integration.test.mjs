import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskboardDatabase } from "../server/database.mjs";
import { LINEAR_PROJECT_ID } from "../shared/domain.mjs";
import { sprintPoints } from "../shared/sprint-points.mjs";

import {
  buildLinearFilter,
  createLinearIntegration,
  resolveLinearCycle,
  taskPriorityFromLinear,
  taskStatusFromLinear,
} from "../server/linear-integration.mjs";

const STATES = [
  ["Backlog", "backlog", "backlog"],
  ["Triage", "triage", "backlog"],
  ["Defining Requirements", "unstarted", "backlog"],
  ["Ready For Dev", "unstarted", "todo"],
  ["In Development", "started", "in_progress"],
  ["Staging Ready For QA", "started", "in_progress"],
  ["In QA", "started", "in_progress"],
  ["Staging Failed", "started", "in_progress"],
  ["Code Review", "started", "in_review"],
  ["Blocked", "started", "blocked"],
  ["Ready For Release", "completed", "done"],
  ["Commercial Verification", "completed", "done"],
  ["Released", "completed", "done"],
  ["Won't Do", "completed", "canceled"],
  ["Failed To Resolve", "canceled", "canceled"],
  ["Duplicate", "duplicate", "canceled"],
].map(([name, type, status], index) => ({ id: `state-${index}`, name, type, status }));

const CYCLES = [
  { id: "c93", number: 93, startsAt: "2026-10-18T00:00:00Z", endsAt: "2026-11-01T00:00:00Z", isActive: false },
  { id: "c91", number: 91, startsAt: "2026-09-20T00:00:00Z", endsAt: "2026-10-04T00:00:00Z", isActive: false },
  { id: "c92", number: 92, startsAt: "2026-10-04T00:00:00Z", endsAt: "2026-10-18T00:00:00Z", isActive: true },
];

test("maps every MM7 workflow state by name", () => {
  for (const state of STATES) {
    assert.equal(taskStatusFromLinear(state), state.status, state.name);
  }
  assert.equal(taskStatusFromLinear({ name: "Something New", type: "started" }), "in_progress");
  assert.equal(taskStatusFromLinear({ name: "Todo", type: "unstarted" }), "backlog");
});

test("maps Linear priorities 1:1", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(taskPriorityFromLinear), ["none", "urgent", "high", "medium", "low"]);
});

test("builds the assigned-issue filter per cycle selection", () => {
  assert.deepEqual(buildLinearFilter({ teamKey: "MM7", cycleId: "c92" }), {
    and: [{ team: { key: { eq: "MM7" } } }, { cycle: { id: { eq: "c92" } } }],
  });
  const all = buildLinearFilter({ teamKey: "MM7", cycleId: undefined });
  assert.deepEqual(all.and[0], { team: { key: { eq: "MM7" } } });
  assert.equal(all.and[1].or.length, 2);
});

test("resolves current, previous and next cycles from the team's cycles", () => {
  assert.equal(resolveLinearCycle(CYCLES, "current").number, 92);
  assert.equal(resolveLinearCycle(CYCLES, "previous").number, 91);
  assert.equal(resolveLinearCycle(CYCLES, "next").number, 93);
  assert.equal(resolveLinearCycle(CYCLES, "all"), undefined);
  assert.equal(resolveLinearCycle(CYCLES.filter((cycle) => cycle.id !== "c93"), "next"), null);
});

function linearStub() {
  const issue = {
    id: "issue-1",
    identifier: "MM7-2",
    title: "Demo",
    description: "",
    url: "https://linear.app/demo/issue/MM7-1",
    branchName: "user/mm7-1-demo",
    priority: 2,
    dueDate: null,
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    state: STATES[3],
    labels: { nodes: [{ name: "bug" }] },
    assignee: { id: "user-1", displayName: "Me" },
    creator: { id: "user-2", name: "PM" },
    parent: { id: "parent-1" },
  };
  // In another cycle, so only reachable through the sub-issue.
  const parent = { ...issue, id: "parent-1", identifier: "MM7-1", branchName: null, parent: null };
  const calls = [];
  const stub = {
    calls,
    issue,
    parent,
    overrideStateAfterWrite: null,
    async fetch(url, init) {
      assert.equal(url, "https://api.linear.app/graphql");
      assert.equal(init.headers.authorization, "lin_api_test");
      const { query, variables } = JSON.parse(init.body);
      const operation = query.match(/(?:query|mutation) (\w+)/)[1];
      calls.push({ operation, variables });
      const data = {
        TaskboardViewer: () => ({ viewer: { id: "user-1", displayName: "Me", organization: { id: "org-1", urlKey: "demo" } } }),
        TaskboardTeam: () => ({
          teams: { nodes: [{ id: "team-1", key: "MM7", states: { nodes: STATES }, cycles: { nodes: CYCLES } }] },
        }),
        TaskboardAssignedIssues: () => ({
          viewer: { assignedIssues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
        TaskboardParentIssues: () => {
          assert.deepEqual(variables.ids, ["parent-1"]);
          return { issues: { nodes: [parent] } };
        },
        TaskboardIssueUpdate: () => {
          issue.state = stub.overrideStateAfterWrite
            ?? STATES.find((state) => state.id === variables.input.stateId);
          return { issueUpdate: { success: true } };
        },
        TaskboardIssueState: () => ({ issue: { id: issue.id, state: issue.state } }),
      }[operation]();
      return { ok: true, status: 200, async json() { return { data }; } };
    },
  };
  return stub;
}

function memoryConfigStore() {
  let stored = null;
  return {
    async read() { return stored; },
    validate({ apiKey, teamKey, selectedCycle }) {
      return { apiKey, teamKey: teamKey ?? "MM7", selectedCycle: selectedCycle ?? "current" };
    },
    async save(config) { stored = { ...config, version: 1 }; return stored; },
  };
}

test("syncs the current cycle and writes back only allowed moves", async () => {
  const stub = linearStub();
  const syncCalls = [];
  const linear = createLinearIntegration({
    configStore: memoryConfigStore(),
    database: {
      syncLinearTasks: (tasks, options) => syncCalls.push({ tasks, options }),
      setTaskExternalState() {},
    },
    fetch: stub.fetch,
  });

  const connection = await linear.configure({ apiKey: "lin_api_test" });
  assert.equal(connection.cycle.number, 92);
  const filter = stub.calls.find((call) => call.operation === "TaskboardAssignedIssues").variables.filter;
  assert.deepEqual(filter.and[1], { cycle: { id: { eq: "c92" } } });
  const [task, parentTask] = syncCalls[0].tasks;
  assert.equal(parentTask.externalKey, "MM7-1");
  assert.equal(task.parentExternalId, "parent-1");
  assert.equal(task.externalKey, "MM7-2");
  assert.equal(task.status, "todo");
  assert.equal(task.priority, "high");
  assert.equal(task.gitBranch, "user/mm7-1-demo");
  assert.deepEqual(task.labels, ["bug"]);

  await linear.moveTask(task, "in_progress");
  const write = stub.calls.find((call) => call.operation === "TaskboardIssueUpdate");
  assert.deepEqual(write.variables, { id: "MM7-2", input: { stateId: STATES[4].id } });

  await linear.moveTask({ ...task, status: "in_review" }, "in_progress");
  assert.deepEqual(
    stub.calls.filter((call) => call.operation === "TaskboardIssueUpdate").at(-1).variables.input,
    { stateId: STATES[4].id },
  );

  await assert.rejects(
    linear.moveTask({ ...task, status: "in_progress" }, "done"),
    { code: "LINEAR_TRANSITION_UNAVAILABLE" },
  );
  await assert.rejects(
    linear.updateTask({ ...task, status: "in_progress" }, { title: "Renamed" }),
    { code: "LINEAR_FIELD_READ_ONLY" },
  );

  stub.overrideStateAfterWrite = STATES[6];
  await assert.rejects(
    linear.moveTask({ ...task, status: "in_progress" }, "in_review"),
    { code: "LINEAR_STATE_CONFLICT" },
  );
});

test("stores estimates and the in-scope flag; context parents stay out of sprint points", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-linear-points-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    const stub = linearStub();
    stub.issue.estimate = 3;
    stub.parent.estimate = 8;
    const linear = createLinearIntegration({ configStore: memoryConfigStore(), database, fetch: stub.fetch });
    await linear.configure({ apiKey: "lin_api_test" });

    const tasks = database.listTasks({ projectId: LINEAR_PROJECT_ID });
    const byKey = Object.fromEntries(tasks.map((task) => [task.externalKey, task]));
    assert.equal(byKey["MM7-2"].estimate, 3);
    assert.equal(byKey["MM7-2"].inScope, true);
    assert.equal(byKey["MM7-1"].estimate, 8);
    assert.equal(byKey["MM7-1"].inScope, false);
    assert.deepEqual(sprintPoints(tasks), { total: 3, completed: 0, remaining: 3, byStatus: { todo: 3 } });
    assert.equal(byKey["MM7-2"].externalState, "Ready For Dev");

    await linear.moveTask(byKey["MM7-2"], "in_progress");
    assert.equal(database.getTask(byKey["MM7-2"].id).externalState, "In Development");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("planning: capacity from the last 3 finished cycles and candidates without a cycle", async () => {
  const done = STATES.find((state) => state.name === "Released");
  const wontDo = STATES.find((state) => state.name === "Won't Do");
  const inDev = STATES.find((state) => state.name === "In Development");
  const ready = STATES.find((state) => state.name === "Ready For Dev");
  const cycles = [
    { id: "c88", number: 88, startsAt: "2026-08-09T00:00:00Z", endsAt: "2026-08-23T00:00:00Z", completedAt: "2026-08-23T00:00:00Z" },
    { id: "c89", number: 89, startsAt: "2026-08-23T00:00:00Z", endsAt: "2026-09-06T00:00:00Z", completedAt: "2026-09-06T00:00:00Z" },
    { id: "c90", number: 90, startsAt: "2026-09-06T00:00:00Z", endsAt: "2026-09-20T00:00:00Z", completedAt: "2026-09-20T00:00:00Z" },
    { id: "c91", number: 91, startsAt: "2026-09-20T00:00:00Z", endsAt: "2026-10-04T00:00:00Z", completedAt: "2026-10-04T00:00:00Z" },
    { id: "c92", number: 92, startsAt: "2026-10-04T00:00:00Z", endsAt: "2026-10-18T00:00:00Z", completedAt: null, isActive: true },
  ];
  const issue = (identifier, cycleId, state, estimate) => ({
    id: identifier, identifier, title: identifier, url: `https://linear.app/demo/issue/${identifier}`,
    estimate, state, cycle: cycleId ? { id: cycleId } : null,
  });
  const cycleIssues = [
    issue("MM7-88", "c88", done, 20), // older than the last 3 finished cycles
    issue("MM7-89", "c89", done, 8),
    issue("MM7-90a", "c90", done, 5),
    issue("MM7-90b", "c90", done, 3),
    issue("MM7-90c", "c90", wontDo, 13), // completed type but canceled: not counted
    issue("MM7-91", "c91", done, 10),
    issue("MM7-91b", "c91", inDev, 2), // unfinished: not counted
    issue("MM7-92a", "c92", done, 3),
    issue("MM7-92b", "c92", inDev, 5),
    issue("MM7-92c", "c92", wontDo, 8),
  ];
  const candidates = [issue("MM7-100", null, ready, 3), issue("MM7-101", null, inDev, null)];
  const filters = [];
  const fetch = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const operation = query.match(/query (\w+)/)[1];
    let data;
    if (operation === "TaskboardTeam") {
      data = { teams: { nodes: [{ id: "team-1", key: "MM7", states: { nodes: STATES }, cycles: { nodes: cycles } }] } };
    } else {
      filters.push(variables.filter);
      const cycleIds = variables.filter.and[1].cycle.id?.in;
      const nodes = cycleIds ? cycleIssues.filter((node) => cycleIds.includes(node.cycle.id)) : candidates;
      data = { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return { ok: true, status: 200, async json() { return { data }; } };
  };
  const linear = createLinearIntegration({
    configStore: { async read() { return { apiKey: "lin_api_test", teamKey: "MM7", selectedCycle: "current" }; } },
    database: {},
    fetch,
  });

  const planning = await linear.planning();
  assert.deepEqual(planning.previousCycles.map((cycle) => [cycle.number, cycle.completedPoints]), [[91, 10], [90, 8], [89, 8]]);
  assert.equal(planning.capacity, 8.7);
  assert.deepEqual(planning.currentScope, { total: 8, completed: 3 });
  assert.deepEqual(filters[0].and[1], { cycle: { id: { in: ["c91", "c90", "c89", "c92"] } } });
  assert.deepEqual(filters[1].and.slice(1), [
    { cycle: { null: true } },
    { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
  ]);
  assert.deepEqual(planning.candidates, [
    { externalKey: "MM7-100", title: "MM7-100", estimate: 3, status: "todo", url: "https://linear.app/demo/issue/MM7-100" },
    { externalKey: "MM7-101", title: "MM7-101", estimate: null, status: "in_progress", url: "https://linear.app/demo/issue/MM7-101" },
  ]);
});
