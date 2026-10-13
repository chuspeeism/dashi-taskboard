# Agent loop

Use this when an agent works Taskboard issues in a loop instead of one requested issue.

## Settings

The loop is configured per project in client storage key `taskboard.agentLoop.v1`:

```bash
taskctl loop config --project PROJECT_ID --enable --max-concurrent 2
taskctl loop config --project PROJECT_ID --disable
```

- `enabled`: the loop hands out work only when true. The default is false.
- `maxConcurrent`: the most issues agents may work at once, from 1 to 10. The default is 2. An issue counts as worked while it is `in_progress` with an agent session or a Codex thread binding and is not paused.
- `repoPath`: the repository the agent works in. Required for the Linear project (`linear-my-tasks`), which has no workspace of its own.
- `labelRepos`: optional per-label overrides. An issue with a mapped label uses that repository instead of `repoPath`.

```bash
taskctl loop config --project linear-my-tasks --enable --repo /path/to/repo
taskctl loop config --project linear-my-tasks --label-repo PowerFlow=/path/to/powerflow
taskctl loop config --project linear-my-tasks --label-repo PowerFlow=   # remove the override
```

## Early analysis (next sprint)

For the Linear project, `earlyAnalysis` (the "Early analysis (next sprint)" toggle in the Auto-run menu, independent of `enabled`) also syncs my issues in Defining Requirements in the team's next cycle. They show in a purple "Next sprint · preparing" group at the top of To do, do not count toward the sprint points or the missing sprint label check (`inScope: false`), and are never handed out by `next` (Defining Requirements is `backlog`). Turning the flag off removes them from the board.

Preparation is analysis only: a report file and a Slack DM, no code and no Linear writes. A runner job that analyses Defining Requirements issues uses this contract:

```bash
# 1. Read the flag.
taskctl loop config --project linear-my-tasks --json          # settings.earlyAnalysis
taskctl loop config --project linear-my-tasks --early-analysis on|off

# 2. List the next sprint's Defining Requirements issues (only present while the flag is on).
taskctl issue list --project linear-my-tasks --json
#    tasks[] with nextCycle != null; nextCycle is { name, number }.
#    externalKey is the Linear key, startedOutsideAt is set when a GitHub PR is attached
#    (card "Already has PR"; say in the analysis that it may already be started),
#    analysedAt / analysisReport are set once analysed. Skip issues with analysedAt.

# 3. After writing the report, mark the issue analysed (card "Analysed", detail shows the path).
taskctl issue analysed ISSUE_ID --report /path/to/report.md
taskctl issue analysed ISSUE_ID --clear
```

Current-sprint Defining Requirements issues are the tasks with `inScope: true` and `externalState: "Defining Requirements"`; `taskctl issue analysed` works on them too. Analyse the current sprint first and share the per-tick analysis budget between both.

## Runner heartbeat

The runner that drives the loop (a coordinator session or a scheduled task) records each tick so the board header shows whether it is running:

```bash
taskctl loop heartbeat --project PROJECT_ID --phase start [--note TEXT]   # first command of a tick
taskctl loop heartbeat --project PROJECT_ID --phase end [--note TEXT]     # last command of a tick
```

They are stored per project in client storage key `taskboard.loopRunner.v1`; `taskctl next --claim` also counts as tick activity. The header shows "Running · last tick Nm ago", "Tick in progress Nm", "Stuck?" (a tick started over 15 minutes ago with no end, no `next --claim` and no issue heartbeat since; the board sends one notification) or "Not running" (no tick for 90 minutes while the loop is enabled). Always send `--phase end`, also when the tick did nothing.

## Picking work

```bash
taskctl next --project PROJECT_ID --claim --agent-platform claude --session-id ID
```

`next` returns `{ task, kind, repoPath, reason, active, maxConcurrent }`. `repoPath` is the mapped repository for `task`, or null. `reason` is one of:

- `claimed`: `task` is now `in_progress` and belongs to you.
- `available`: without `--claim`, the next pick.
- `disabled`: the loop is off.
- `repo_unmapped`: the Linear project has no `repoPath`.
- `concurrency_limit`: `active` already reached `maxConcurrent`.
- `no_eligible`: nothing to do.
- `conflict`: every candidate changed while claiming.

Candidates are tried in this order, then by priority and board order:

1. `resume`: a `blocked` issue whose `[decision-request]` agent comment has a user comment written after the agent comment's last edit, meaning the user answered; or an `in_progress` issue the user paused and then resumed.
2. `rework`: an `in_review` issue whose latest `/rework` user comment was written after the agent comment's last edit.
3. `new`: a `todo` issue whose blockers are all satisfied. A blocker is satisfied when it is `done`, or when it is `in_review` and its agent comment starts with `[merged]`. It must not have the `hold` label or an unanswered decision request. For Linear issues `todo` means the Ready For Dev state.

Never claim `backlog`, never hand out a paused issue, and never take over an issue another session is working.

A Linear `new` candidate is skipped when the user already started it: a GitHub pull request is attached to the Linear issue, or its Linear branch exists in the mapped repository (local or remote-tracking). `next` lists these in `skipped: [{ task, reason: "already_started" }]` and the card shows "Started outside the loop". Before writing a status to Linear, Taskboard reads the issue's live state; if the user moved it since the last sync, nothing is written, the board resyncs, and the move fails with `LINEAR_STATE_CONFLICT`, so `next --claim` tries the next candidate.

Issues are not moved to `done` without user acceptance, so a merge is recorded in the agent comment instead. Right after the coordinator merges an issue's PR (only when the user authorized the merge), it edits that issue's agent comment to start with `[merged] <PR URL> <merge SHA>` and leaves the issue `in_review`. `taskctl next` reads that comment from Taskboard only; it makes no GitHub calls.

## One agent comment per ticket

Each issue holds at most one agent comment. The claim note, progress, the handoff, a `[decision-request]` and the `[merged]` record all go into that comment. Add it once with `taskctl comment add`, then edit it with `taskctl comment update COMMENT_ID --body ... --if-version N` instead of adding another. When a marker applies, it leads the body.

`taskctl next` compares user comments with the agent comment's last edit time, not its position in the list: a `[decision-request]` counts as answered only by a user comment written after that edit, and a `/rework` counts only when the agent comment has not been edited since.

## Working an issue

Follow the core workflow in `SKILL.md`: read the issue, comments and attachments, do the work in your own branch or worktree, verify the direct path, and open a PR. When `repoPath` is set, branch from that repository's default branch and follow its own `AGENTS.md` or `CLAUDE.md`.

For Linear issues, status moves write back to Linear: claiming moves Ready For Dev to In Development, handing off to `in_review` moves it to Code Review, and `blocked` moves it to Blocked. Comments stay in Taskboard and are not synced to Linear. For `resume`, start from the user's answer. For `rework`, start from the `/rework` comment.

At each step, record activity so the `in_progress` card shows the agent as active (it shows no activity after 10 minutes without one):

```bash
taskctl issue heartbeat ISSUE_ID --agent-platform claude --session-id ID
```

The user can pause an agent issue from its detail view. The issue stays `in_progress` (a Linear issue stays In Development) and its card shows "Paused (you)". While it is paused, `heartbeat` returns `paused: true`: stop at that point, record in the agent comment where you stopped, and end your run without moving the issue. When the user presses Resume, `taskctl next` returns the issue with `kind: "resume"`; start from that comment. An `in_progress` issue without an agent session or Codex thread shows "Manual (you)": the user is working it by hand, so leave it alone. The user can also press "Take over": the agent session is cleared, the card shows "Manual (you)", `heartbeat` returns `paused: true` (stop the same way), and `next` never hands the issue out again. A Linear `in_progress` issue in Staging Ready For QA or In QA shows "Waiting for QA", and one in Staging Failed shows "QA failed"; these do not count toward `maxConcurrent`.

## Stopping for a decision

Stop and ask instead of guessing when the next step needs any of these:

- A product or UX trade-off that the issue and comments do not settle.
- A scope change, or dropping part of the requirement.
- A destructive or irreversible operation (data migration, deleting user data, force-pushing shared history).
- A production deploy, release, or anything outside the repository.
- Credentials, payments, or access you do not have.

To stop, edit the agent comment to start with the decision request and move the issue to `blocked`:

```text
[decision-request] <one-line question>

Options:
1. <option>: <consequence>
2. <option>: <consequence>

Recommendation: <option and why>
Context: <what is done so far, branch/PR>
```

The user answers with a normal comment. The next `taskctl next` then returns the issue as `resume`.

## Handing off

When the work is done and verified, rewrite the agent comment into the handoff and move the issue to `in_review`. Never move it to `done` and never merge.

```text
Done: <what changed>
PR: <url> (head <sha>)
Verified: <direct path and result>
Limitations: <known gaps, or none>
```

The user either accepts the issue or replies `/rework <what to change>`.
