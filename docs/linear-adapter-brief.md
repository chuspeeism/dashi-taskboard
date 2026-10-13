# Linear adapter brief (fork-only feature)

Goal: pull the current user's Linear issues into a dedicated, read-mostly project on the
board, the way `server/jira-integration.mjs` + `server/jira-config.mjs` do for Jira, with a
cycle (sprint) selector. Copy the Jira shape; do not invent a new integration framework.

## Scope (decided)

- Pull filter: `assignee = me` AND `cycle = <selected cycle>`. Selector options: Current
  (default), Previous, Next, All cycles (issues assigned to me with any or no cycle).
- Team: configurable, default `MM7`. Linear cycles are per team; the selector resolves
  current/previous/next from that team's cycles (`cycles` query with `isActive`,
  `startsAt`/`endsAt`), not by number. MM7 today: Sprint 91 (previous), 92 (current,
  2026-10-04 to 10-18), 93 (next).
- Auth: Linear personal API key (`Authorization: <key>` header, GraphQL at
  `https://api.linear.app/graphql`). Store it like `jira-connection.json`
  (`linear-connection.json` in the data dir), never in the DB rows.
- Poll every 60 s like Jira (`SYNC_INTERVAL_MS`); manual sync button the same way. No
  webhooks (board is loopback-only).
- Local mode only, same guard as Jira (`JIRA_LOCAL_MODE_REQUIRED` equivalent).

## Status mapping (resolve by state NAME within the team; MM7 and Development share names
but have different state ids)

| Linear state | board status |
|---|---|
| Backlog, Triage, Defining Requirements | backlog |
| Ready For Dev | todo |
| In Development, Staging Ready For QA, In QA, Staging Failed | in_progress |
| Code Review | in_review |
| Blocked | blocked |
| Ready For Release, Commercial Verification, Released | done |
| Won't Do, Failed To Resolve, Duplicate | canceled |

Write-back on board status change (mirror of Jira `moveTask` / transitions), only for
these moves, everything else is refused with a clear error like `JIRA_ASSIGNEE_UNAVAILABLE`:
todo -> in_progress: `In Development`; in_progress -> in_review: `Code Review`;
blocked -> in_progress: `In Development` (only when Linear itself is Blocked). A board move to
blocked (an agent decision request) is local only and is not written to Linear.
Never write a done/canceled/QA state from the board. Title/description edits: do not write
back in v1 (read-only), reject like Jira rejects project moves.

Priority: Linear 0..4 (none, urgent, high, medium, low) maps 1:1 to board priorities.
Labels: mirror Linear label names into the project label catalog, same as Jira.
Identifier: keep the Linear identifier (MM7-1339) as `externalKey`; origin id from the
Linear organization id so the project id is stable across reconfiguration.
Also store `url` and `branchName` (Linear's `branchName` field) so "git branch" on the
card is prefilled.

## Mutation for write-back

`issueUpdate(id, input: { stateId })`. Resolve `stateId` by name from
`team.states` once per sync and cache it. No optimistic lock in Linear; re-read after write
and surface a conflict if the state is not the one requested.

## Files to add / touch (mirror the Jira ones)

- `server/linear-config.mjs` (validate url-less config: apiKey, teamKey, displayName,
  organization id, selectedCycle = current|previous|next|all)
- `server/linear-integration.mjs` (`createLinearIntegration({configStore, database, fetch})`,
  exports `taskStatusFromLinear`, `taskPriorityFromLinear`, `buildLinearFilter`)
- `server/app.mjs`: routes `/api/local/linear-connection`, `/sync`, plus the cycle selector
  endpoint `PATCH /api/local/linear-connection` with `{ selectedCycle }`; same guards as the
  Jira block (no create, no project move, no assignee change, label catalog read-only)
- `web/`: "Connect Linear" next to "Connect Jira" in the project menu; a cycle dropdown in
  the Linear project header (Current / Previous / Next / All)
- `shared/domain.mjs`: no change; statuses stay the seven existing ones
- tests under `test/`: unit for the mapping functions and the filter builder, one
  integration test with a stubbed `fetch` for sync + write-back, modelled on the Jira tests

## Verify

`npm run check` green, then manual: configure with a real key, see MM7 issues assigned to
the user appear under the current cycle, switch to Previous and Next, move one demo-safe
issue todo -> in_progress and confirm Linear shows In Development, then revert in Linear.
Do not test write-back on a real sprint ticket without the user naming it first.
