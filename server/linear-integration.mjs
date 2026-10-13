import { createHash } from "node:crypto";

import { LINEAR_PROJECT_ID } from "../shared/domain.mjs";
import { LINEAR_STATE_STATUSES } from "../shared/linear-states.mjs";
import { ApiError } from "../shared/api-fields.mjs";
import { validateSelectedCycle } from "./linear-config.mjs";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

const STATUS_BY_STATE_NAME = new Map(
  LINEAR_STATE_STATUSES.map(([name, status]) => [stateKey(name), status]),
);
const STATUS_BY_STATE_TYPE = {
  triage: "backlog",
  backlog: "backlog",
  // Only "Ready For Dev" is todo, so the agent loop never picks up another unstarted state.
  unstarted: "backlog",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
  duplicate: "canceled",
};
// The only board moves written back to Linear, and the state each one writes.
// A move to blocked (a decision request) stays local: Linear keeps its state.
const WRITE_BACK_STATE = [
  { from: "todo", to: "in_progress", state: "In Development" },
  { from: "in_progress", to: "in_review", state: "Code Review" },
  { from: "blocked", to: "in_progress", state: "In Development" },
  { from: "in_review", to: "in_progress", state: "In Development" },
];
// Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const PRIORITIES = ["none", "urgent", "high", "medium", "low"];
const READ_ONLY_FIELDS = ["title", "description", "priority", "labels", "dueDate"];

const VIEWER_QUERY = `
  query TaskboardViewer {
    viewer { id name displayName organization { id urlKey } }
  }
`;

const TEAM_QUERY = `
  query TaskboardTeam($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }, first: 1) {
      nodes {
        id
        key
        states(first: 100) { nodes { id name type } }
        cycles(first: 100) { nodes { id number name startsAt endsAt completedAt isActive } }
      }
    }
  }
`;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  branchName
  priority
  estimate
  dueDate
  createdAt
  updatedAt
  state { id name type }
  labels(first: 50) { nodes { name } }
  assignee { id name displayName avatarUrl }
  creator { id name displayName avatarUrl }
  parent { id }
  cycle { id }
`;

const ASSIGNED_ISSUES_QUERY = `
  query TaskboardAssignedIssues($after: String, $filter: IssueFilter) {
    viewer {
      assignedIssues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Early analysis: my Defining Requirements issues in the next cycle, with their
// links so an attached GitHub PR can mark the issue as already started. Smaller pages
// keep it under Linear's query complexity limit with the extra attachments connection.
const NEXT_CYCLE_ISSUES_QUERY = `
  query TaskboardNextCycleIssues($after: String, $filter: IssueFilter) {
    viewer {
      assignedIssues(first: 25, after: $after, filter: $filter, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} attachments(first: 20) { nodes { url } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const EARLY_ANALYSIS_STATE = "Defining Requirements";
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

// Parents of pulled sub-issues that fall outside the filter (another cycle or assignee),
// shown for context the way Linear does.
const PARENT_ISSUES_QUERY = `
  query TaskboardParentIssues($ids: [ID!]) {
    issues(first: 100, filter: { id: { in: $ids } }) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

// State changes for the Gantt timeline. Kept out of ISSUE_FIELDS so the
// assigned-issue page stays under Linear's query complexity limit.
const ISSUE_HISTORY_QUERY = `
  query TaskboardIssueHistory($ids: [ID!]) {
    issues(first: 25, filter: { id: { in: $ids } }) {
      nodes {
        id
        history(first: 50) {
          nodes { createdAt fromState { name type } toState { name type } }
        }
      }
    }
  }
`;
const HISTORY_BATCH_SIZE = 25;

const ISSUE_STATE_QUERY = `
  query TaskboardIssueState($id: String!) {
    issue(id: $id) { id state { id name type } }
  }
`;

// Links attached to the issue, for the agent loop's already-started check.
const ISSUE_ATTACHMENTS_QUERY = `
  query TaskboardIssueAttachments($id: String!) {
    issue(id: $id) { id attachments(first: 50) { nodes { url } } }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation TaskboardIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

function stateKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

export function taskStatusFromLinear(state) {
  return STATUS_BY_STATE_NAME.get(stateKey(state?.name))
    ?? STATUS_BY_STATE_TYPE[state?.type]
    ?? "in_progress";
}

export function taskPriorityFromLinear(priority) {
  return PRIORITIES[priority] ?? "none";
}

// cycleId: a Linear cycle id, null when the selected cycle does not exist,
// or undefined for "all cycles".
export function buildLinearFilter({ teamKey, cycleId }) {
  const team = { team: { key: { eq: teamKey } } };
  if (cycleId === undefined) {
    // "All cycles" keeps Jira's window so years of closed issues are not pulled.
    return {
      and: [
        team,
        {
          or: [
            { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
            { updatedAt: { gte: "-P30D" } },
          ],
        },
      ],
    };
  }
  return { and: [team, { cycle: { id: { eq: cycleId } } }] };
}

export function resolveLinearCycle(cycles, selection, now = Date.now()) {
  if (selection === "all") return undefined;
  const sorted = [...cycles].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const current = sorted.find((cycle) => cycle.isActive === true) ?? null;
  if (selection === "current") return current;
  const pivotStart = current ? Date.parse(current.startsAt) : now;
  const pivotEnd = current ? Date.parse(current.endsAt) : now;
  if (selection === "previous") {
    return sorted.filter((cycle) => Date.parse(cycle.endsAt) <= pivotStart).at(-1) ?? null;
  }
  return sorted.find((cycle) => Date.parse(cycle.startsAt) >= pivotEnd) ?? null;
}

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

function actorFromLinear(user, fallback) {
  const id = limitedString(user?.id, fallback, 240);
  return {
    type: "user",
    id: `linear:${id}`,
    name: limitedString(user?.displayName ?? user?.name, fallback, 120),
    avatarUrl: user?.avatarUrl ?? null,
  };
}

function linearOriginId(organizationId) {
  return createHash("sha256").update(organizationId).digest("hex");
}

function normalizeIssue(issue, config, index = 0) {
  const externalId = String(issue.id);
  const externalKey = limitedString(issue.identifier, "LINEAR", 128);
  const internalId = `LINEAR:${config.originId.toUpperCase()}:${externalId}`;
  const labels = [...new Set((issue.labels?.nodes ?? []).flatMap((label) => {
    const normalized = typeof label?.name === "string" ? label.name.trim().slice(0, 64) : "";
    return normalized ? [normalized] : [];
  }))].slice(0, 20);
  const gitBranch = typeof issue.branchName === "string" ? issue.branchName.trim().slice(0, 255) : "";
  return {
    id: internalId,
    identifier: internalId,
    title: limitedString(issue.title, externalKey, 240),
    description: typeof issue.description === "string" ? issue.description.slice(0, 100_000) : "",
    status: taskStatusFromLinear(issue.state),
    externalState: typeof issue.state?.name === "string" ? issue.state.name.slice(0, 120) : null,
    priority: taskPriorityFromLinear(issue.priority),
    labels,
    sortOrder: (index + 1) * 1024,
    creator: actorFromLinear(issue.creator, config.displayName),
    assignee: actorFromLinear(issue.assignee, config.displayName),
    dueDate: typeof issue.dueDate === "string" ? issue.dueDate : null,
    estimate: typeof issue.estimate === "number" ? issue.estimate : null,
    inScope: issue.inScope === true,
    nextCycle: issue.nextCycle ?? null,
    startedOutside: issue.startedOutside === true,
    statusTimeline: typeof issue.createdAt === "string" ? statusTimelineFromLinear(issue) : null,
    gitBranch: gitBranch || null,
    parentExternalId: typeof issue.parent?.id === "string" ? issue.parent.id : null,
    cycleId: typeof issue.cycle?.id === "string" ? issue.cycle.id : null,
    externalOrigin: config.originId,
    externalId,
    externalKey,
    externalUrl: typeof issue.url === "string" ? issue.url : null,
    createdAt: typeof issue.createdAt === "string" ? issue.createdAt : new Date().toISOString(),
    updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : new Date().toISOString(),
  };
}

// Phases from the issue's state changes, oldest first; `to` is null for the current phase.
export function statusTimelineFromLinear(issue) {
  const changes = (issue.history?.nodes ?? [])
    .filter((entry) => entry?.toState && typeof entry.createdAt === "string")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const phase = (state, from) => ({
    status: taskStatusFromLinear(state),
    externalState: typeof state?.name === "string" ? state.name.slice(0, 120) : null,
    from,
    to: null,
  });
  const timeline = [phase(changes[0]?.fromState ?? issue.state, issue.createdAt)];
  for (const change of changes) {
    timeline.at(-1).to = change.createdAt;
    timeline.push(phase(change.toState, change.createdAt));
  }
  return timeline;
}

function cycleSummary(cycle) {
  if (!cycle) return null;
  return {
    id: String(cycle.id),
    number: Number(cycle.number),
    name: typeof cycle.name === "string" && cycle.name.trim() ? cycle.name.trim() : null,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
  };
}

function safeConfig(config, lastSyncedAt = null, cycle = null) {
  return config
    ? {
      configured: true,
      workspaceUrlKey: config.workspaceUrlKey,
      displayName: config.displayName,
      teamKey: config.teamKey,
      selectedCycle: config.selectedCycle,
      cycle: cycleSummary(cycle),
      projectId: LINEAR_PROJECT_ID,
      lastSyncedAt,
    }
    : {
      configured: false,
      workspaceUrlKey: null,
      displayName: null,
      teamKey: null,
      selectedCycle: "current",
      cycle: null,
      projectId: LINEAR_PROJECT_ID,
      lastSyncedAt: null,
    };
}

export function createLinearIntegration({
  configStore,
  database,
  fetch: fetchImplementation = globalThis.fetch,
  readEarlyAnalysis = async () => false,
}) {
  let lastSyncedAt = null;
  let lastCycle = null;
  // State ids by lowercase name for the configured team, refreshed on every sync.
  let stateCache = null;
  let pendingSync = null;
  let pendingOperation = Promise.resolve();

  function runInOrder(operation) {
    const result = pendingOperation.then(operation);
    // Recover only the scheduling tail; callers still receive the rejection.
    pendingOperation = result.catch(() => {});
    return result;
  }

  async function graphql(config, query, variables = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(LINEAR_GRAPHQL_URL, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: config.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "LINEAR_TIMEOUT" : "LINEAR_UNAVAILABLE",
        timedOut ? "连接 Linear 超时" : "无法连接 Linear，请检查网络连接",
      );
    } finally {
      clearTimeout(timeout);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) {
        throw new ApiError(502, "INVALID_LINEAR_RESPONSE", "Linear 返回了无效的 JSON 数据");
      }
    }
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const authFailed = response.status === 401
      || response.status === 403
      || errors.some((error) => error?.extensions?.code === "AUTHENTICATION_ERROR");
    if (authFailed) {
      throw new ApiError(401, "LINEAR_AUTH_FAILED", "Linear 认证失败，请检查 API Key");
    }
    if (!response.ok || errors.length > 0) {
      const detail = errors[0]?.message ? `：${String(errors[0].message).slice(0, 200)}` : "";
      throw new ApiError(
        response.status >= 500 ? 502 : 409,
        "LINEAR_REQUEST_FAILED",
        `Linear 请求失败（HTTP ${response.status}）${detail}`,
      );
    }
    return payload?.data ?? {};
  }

  async function fetchViewer(config) {
    const viewer = (await graphql(config, VIEWER_QUERY)).viewer;
    const organizationId = typeof viewer?.organization?.id === "string" ? viewer.organization.id.trim() : "";
    if (!organizationId) {
      throw new ApiError(502, "INVALID_LINEAR_ORIGIN", "Linear 未返回稳定的工作区身份");
    }
    return {
      originId: linearOriginId(organizationId),
      workspaceUrlKey: viewer.organization.urlKey ?? null,
      displayName: limitedString(viewer.displayName ?? viewer.name, "Linear", 254),
    };
  }

  async function fetchTeam(config) {
    const team = (await graphql(config, TEAM_QUERY, { teamKey: config.teamKey })).teams?.nodes?.[0];
    if (!team) {
      throw new ApiError(409, "LINEAR_TEAM_NOT_FOUND", `Linear 中找不到团队 ${config.teamKey}`);
    }
    stateCache = {
      originId: config.originId,
      teamKey: config.teamKey,
      idsByName: new Map((team.states?.nodes ?? []).map((state) => [stateKey(state.name), String(state.id)])),
    };
    return team;
  }

  async function fetchAssignedIssues(config, filter, query = ASSIGNED_ISSUES_QUERY) {
    const issues = [];
    let after = null;
    while (true) {
      const data = await graphql(config, query, { after, filter });
      const connection = data.viewer?.assignedIssues;
      issues.push(...(Array.isArray(connection?.nodes) ? connection.nodes : []));
      if (connection?.pageInfo?.hasNextPage !== true) break;
      if (typeof connection.pageInfo.endCursor !== "string" || !connection.pageInfo.endCursor) {
        throw new ApiError(502, "INVALID_LINEAR_RESPONSE", "Linear 搜索结果缺少下一页标记");
      }
      after = connection.pageInfo.endCursor;
    }
    return issues;
  }

  async function attachHistory(config, issues) {
    const historyById = new Map();
    for (let offset = 0; offset < issues.length; offset += HISTORY_BATCH_SIZE) {
      const ids = issues.slice(offset, offset + HISTORY_BATCH_SIZE).map((issue) => issue.id);
      const nodes = (await graphql(config, ISSUE_HISTORY_QUERY, { ids })).issues?.nodes ?? [];
      for (const node of nodes) historyById.set(node.id, node.history);
    }
    for (const issue of issues) issue.history = historyById.get(issue.id) ?? null;
  }

  // Pulls the selected cycle's issues; returns the resolved cycle (null for none or "all").
  async function pull(config) {
    const team = await fetchTeam(config);
    const cycle = resolveLinearCycle(team.cycles?.nodes ?? [], config.selectedCycle);
    // The selected cycle does not exist (e.g. no next cycle yet): show nothing.
    const issues = cycle === null
      ? []
      : await fetchAssignedIssues(config, buildLinearFilter({ teamKey: config.teamKey, cycleId: cycle?.id }));
    for (const issue of issues) issue.inScope = true;
    const pulledIds = new Set(issues.map((issue) => issue.id));
    const missingParentIds = [...new Set(issues.flatMap((issue) => (
      issue.parent?.id && !pulledIds.has(issue.parent.id) ? [issue.parent.id] : []
    )))];
    if (missingParentIds.length > 0) {
      const parents = (await graphql(config, PARENT_ISSUES_QUERY, { ids: missingParentIds })).issues?.nodes ?? [];
      issues.push(...parents.map((parent) => ({ ...parent, inScope: false })));
    }
    // Early analysis: my Defining Requirements issues in the team's next cycle, outside the sprint.
    const nextCycle = await readEarlyAnalysis()
      ? resolveLinearCycle(team.cycles?.nodes ?? [], "next")
      : null;
    if (nextCycle) {
      // A failed next-cycle fetch skips those issues for this sync; the sprint sync still completes.
      const nextIssues = await fetchAssignedIssues(config, {
        and: [
          { team: { key: { eq: config.teamKey } } },
          { cycle: { id: { eq: nextCycle.id } } },
          { state: { name: { eq: EARLY_ANALYSIS_STATE } } },
        ],
      }, NEXT_CYCLE_ISSUES_QUERY).catch(() => []);
      const marker = {
        name: typeof nextCycle.name === "string" && nextCycle.name.trim() ? nextCycle.name.trim() : null,
        number: Number(nextCycle.number),
      };
      for (const issue of nextIssues) {
        if (issues.some((pulled) => pulled.id === issue.id)) continue;
        issues.push({
          ...issue,
          inScope: false,
          nextCycle: marker,
          startedOutside: (issue.attachments?.nodes ?? []).some(
            (attachment) => GITHUB_PULL_REQUEST_URL.test(attachment?.url ?? ""),
          ),
        });
      }
    }
    await attachHistory(config, issues);
    return { cycle: cycle ?? null, issues };
  }

  // releaseCycleMoves: the board views the same cycle as the last sync, so an issue that left it
  // was moved in Linear (a cycle selection change or rollover releases nothing).
  function syncDatabase(config, issues, archiveMissing, cycle = null, releaseCycleMoves = false) {
    database.syncLinearTasks(
      issues.map((issue, index) => normalizeIssue(issue, config, index)),
      {
        archiveMissing,
        projectName: `Linear · ${config.teamKey} · ${config.displayName}`,
        releaseCycleMoves,
        selectedCycleId: cycle?.id ?? null,
      },
    );
  }

  async function assertLiveOrigin(config) {
    if ((await fetchViewer(config)).originId !== config.originId) {
      throw new ApiError(
        409,
        "LINEAR_ORIGIN_MISMATCH",
        "当前 Linear API Key 属于另一个工作区，请重新连接后再操作",
      );
    }
  }

  async function syncWithConfig(config, { archiveMissing = true } = {}) {
    await assertLiveOrigin(config);
    const { cycle, issues } = await pull(config);
    const sameCycle = lastSyncedAt !== null && (lastCycle?.id ?? null) === (cycle?.id ?? null);
    syncDatabase(config, issues, archiveMissing, cycle, sameCycle);
    lastSyncedAt = new Date().toISOString();
    lastCycle = cycle;
    return safeConfig(config, lastSyncedAt, lastCycle);
  }

  async function sync({ force = false } = {}) {
    if (pendingSync) {
      // A forced caller must not inherit a queued, throttled no-op.
      pendingSync.force ||= force;
      return pendingSync.promise;
    }
    const syncRequest = { force, promise: null };
    syncRequest.promise = runInOrder(async () => {
      try {
        const config = await configStore.read();
        if (!config) return safeConfig(null);
        if (!syncRequest.force && lastSyncedAt && Date.now() - new Date(lastSyncedAt).getTime() < SYNC_INTERVAL_MS) {
          return safeConfig(config, lastSyncedAt, lastCycle);
        }
        return await syncWithConfig(config);
      } finally {
        pendingSync = null;
      }
    });
    pendingSync = syncRequest;
    return syncRequest.promise;
  }

  async function assertOwnedTask(config, task) {
    if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
    if (task.externalOrigin !== config.originId || !task.externalKey) {
      throw new ApiError(
        409,
        "LINEAR_ORIGIN_MISMATCH",
        "此任务不属于当前 Linear 连接，请重新同步后再操作",
      );
    }
    await assertLiveOrigin(config);
  }

  async function writeStatus(config, task, targetStatus) {
    // A locally blocked task still has its Linear state; moves are checked against that state.
    const linearStatus = task.status === "blocked" ? taskStatusFromLinear({ name: task.externalState }) : task.status;
    if (targetStatus === "blocked" || targetStatus === linearStatus) return;
    const rule = WRITE_BACK_STATE.find(
      (candidate) => candidate.to === targetStatus && candidate.from === linearStatus,
    );
    if (!rule) {
      throw new ApiError(
        409,
        "LINEAR_TRANSITION_UNAVAILABLE",
        `Taskboard 不能将 Linear 任务 ${task.externalKey} 从此状态移到目标状态，请在 Linear 中操作`,
      );
    }
    if (!stateCache || stateCache.originId !== config.originId || stateCache.teamKey !== config.teamKey) {
      await fetchTeam(config);
    }
    const stateId = stateCache.idsByName.get(stateKey(rule.state));
    if (!stateId) {
      throw new ApiError(
        409,
        "LINEAR_STATE_UNAVAILABLE",
        `Linear 团队 ${config.teamKey} 没有“${rule.state}”状态`,
      );
    }
    // The user may have moved the issue in Linear since the last sync: never overwrite that move.
    const live = (await graphql(config, ISSUE_STATE_QUERY, { id: task.externalKey })).issue;
    if (taskStatusFromLinear(live?.state) !== linearStatus) {
      await runInOrder(() => syncWithConfig(config, { archiveMissing: false })).catch(() => {});
      throw new ApiError(
        409,
        "LINEAR_STATE_CONFLICT",
        `Linear 中 ${task.externalKey} 当前为“${live?.state?.name ?? "未知"}”，已重新同步`,
      );
    }
    const data = await graphql(config, ISSUE_UPDATE_MUTATION, {
      id: task.externalKey,
      input: { stateId },
    });
    if (data.issueUpdate?.success !== true) {
      throw new ApiError(409, "LINEAR_REQUEST_FAILED", "Linear 未能更新此任务");
    }
    // Linear has no optimistic lock: re-read and surface a concurrent change.
    const issue = (await graphql(config, ISSUE_STATE_QUERY, { id: task.externalKey })).issue;
    if (issue?.state?.id !== stateId) {
      throw new ApiError(
        409,
        "LINEAR_STATE_CONFLICT",
        `Linear 中 ${task.externalKey} 当前为“${issue?.state?.name ?? "未知"}”，不是“${rule.state}”，请重新同步`,
      );
    }
    database.setTaskExternalState(task.id, issue.state.name);
  }

  // Sprint planning (read-only): capacity from the last 3 finished cycles,
  // the current cycle's scope, and my open issues with no cycle.
  async function planning() {
    const config = await configStore.read();
    if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
    const team = await fetchTeam(config);
    const cycles = team.cycles?.nodes ?? [];
    const finished = cycles
      .filter((cycle) => cycle.completedAt)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
      .slice(0, 3);
    const current = resolveLinearCycle(cycles, "current");
    const teamFilter = { team: { key: { eq: config.teamKey } } };
    const cycleIds = [...finished, ...(current ? [current] : [])].map((cycle) => cycle.id);
    const cycleIssues = cycleIds.length > 0
      ? await fetchAssignedIssues(config, { and: [teamFilter, { cycle: { id: { in: cycleIds } } }] })
      : [];
    const candidates = await fetchAssignedIssues(config, {
      and: [
        teamFilter,
        { cycle: { null: true } },
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
      ],
    });
    const points = (cycleId, include) => cycleIssues
      .filter((issue) => issue.cycle?.id === cycleId && typeof issue.estimate === "number")
      .filter((issue) => include(taskStatusFromLinear(issue.state)))
      .reduce((sum, issue) => sum + issue.estimate, 0);
    const previousCycles = finished.map((cycle) => ({
      number: Number(cycle.number),
      name: typeof cycle.name === "string" && cycle.name.trim() ? cycle.name.trim() : null,
      completedPoints: points(cycle.id, (status) => status === "done"),
    }));
    const capacity = previousCycles.length > 0
      ? Math.round((previousCycles.reduce((sum, cycle) => sum + cycle.completedPoints, 0) / previousCycles.length) * 10) / 10
      : 0;
    return {
      capacity,
      previousCycles,
      currentScope: {
        total: current ? points(current.id, (status) => status !== "canceled") : 0,
        completed: current ? points(current.id, (status) => status === "done") : 0,
      },
      candidates: candidates.map((issue) => ({
        externalKey: issue.identifier,
        title: issue.title,
        estimate: typeof issue.estimate === "number" ? issue.estimate : null,
        status: taskStatusFromLinear(issue.state),
        url: typeof issue.url === "string" ? issue.url : null,
      })),
    };
  }

  // True when a GitHub pull request is attached to the Linear issue.
  async function hasPullRequest(task) {
    const config = await configStore.read();
    await assertOwnedTask(config, task);
    const issue = (await graphql(config, ISSUE_ATTACHMENTS_QUERY, { id: task.externalKey })).issue;
    return (issue?.attachments?.nodes ?? []).some(
      (attachment) => GITHUB_PULL_REQUEST_URL.test(attachment?.url ?? ""),
    );
  }

  return {
    planning,
    hasPullRequest,
    async status() {
      return safeConfig(await configStore.read(), lastSyncedAt, lastCycle);
    },
    async configure(input) {
      return runInOrder(async () => {
        const current = await configStore.read();
        const candidate = configStore.validate({
          apiKey: input.apiKey || current?.apiKey,
          teamKey: input.teamKey,
          selectedCycle: input.selectedCycle ?? current?.selectedCycle,
        });
        const config = { ...candidate, ...(await fetchViewer(candidate)) };
        const { cycle, issues } = await pull(config);
        syncDatabase(config, issues, true);
        const savedConfig = await configStore.save(config);
        lastSyncedAt = new Date().toISOString();
        lastCycle = cycle;
        return safeConfig(savedConfig, lastSyncedAt, lastCycle);
      });
    },
    async selectCycle(selectedCycle) {
      return runInOrder(async () => {
        const current = await configStore.read();
        if (!current) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
        const config = { ...current, selectedCycle: validateSelectedCycle(selectedCycle) };
        const connection = await syncWithConfig(config);
        await configStore.save(config);
        return connection;
      });
    },
    sync,
    async reconcile() {
      return runInOrder(async () => {
        const config = await configStore.read();
        if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
        return syncWithConfig(config, { archiveMissing: false });
      });
    },
    async updateTask(task, changes) {
      const readOnlyChange = READ_ONLY_FIELDS.find(
        (field) => Object.hasOwn(changes, field) && JSON.stringify(changes[field]) !== JSON.stringify(task[field]),
      );
      if (readOnlyChange) {
        throw new ApiError(
          409,
          "LINEAR_FIELD_READ_ONLY",
          "Linear 任务的标题、描述、优先级、标签和截止日期为只读，请在 Linear 中修改",
          { field: readOnlyChange },
        );
      }
      if (!Object.hasOwn(changes, "status") || changes.status === task.status) return false;
      const config = await configStore.read();
      await assertOwnedTask(config, task);
      await writeStatus(config, task, changes.status);
      return true;
    },
    async moveTask(task, status) {
      if (status === task.status) return;
      const config = await configStore.read();
      await assertOwnedTask(config, task);
      await writeStatus(config, task, status);
    },
  };
}
