---
name: taskboard-loop
description: Coordinate a Claude Code agent loop over a Taskboard project. Claim work with `taskctl next`, dispatch one worktree subagent per issue, and refill until nothing is left or every issue waits on the user. Use when the user asks to run, start, or continue the Taskboard loop for a project.
---

# Taskboard loop coordinator

Run this in the coordinating Claude Code session. Each issue goes to its own subagent. The coordinator does not implement issues itself.

## Inputs

Confirm both before the first tick, then reuse them:

- The Taskboard project id, for example `dashi-taskboard`.
- The Taskboard URL the user runs. Pass it as `CODEX_TASKBOARD_URL` (or `--runtime-file` for a launcher runtime). Never guess a port.

Invoke the CLI from the repository as `node cli/taskctl.mjs …`. Use this session's id as `--session-id` with `--agent-platform claude`.

## Each tick

Start every tick with `taskctl loop heartbeat --project P --phase start` and end it with `taskctl loop heartbeat --project P --phase end` (also when it dispatched nothing), so the board header shows the runner as running and flags a stuck tick.

1. Run `taskctl next --project P --claim --agent-platform claude --session-id S` until `reason` is not `claimed`.
   - `disabled`: tell the user the loop is off (`taskctl loop config --project P --enable`) and stop.
   - `repo_unmapped`: tell the user to map a repository (`taskctl loop config --project P --repo PATH`) and stop.
   - `concurrency_limit` or `no_eligible`: dispatch nothing more this tick.
2. For each claimed issue, start a background Agent with `isolation: "worktree"`. Give it:
   - the issue id, `kind` (`new`, `resume`, `rework`), the project id, the Taskboard URL and its own `--session-id`;
   - when `repoPath` is set (always for Linear), the instruction to work in that repository: create the worktree from it, branch from its current default branch, and follow its own `AGENTS.md` or `CLAUDE.md`;
   - the instruction to follow `skills/manage-taskboard/references/loop.md` and `AGENTS.md` (the mapped repository's own rules when `repoPath` is set): branch from its current default branch, implement the smallest real path, verify it, open a PR, then either hand off to `in_review` or turn its agent comment into a `[decision-request]` and move to `blocked`;
   - the one-agent-comment rule: the issue holds a single agent comment (claim note, handoff, `[decision-request]`, `[merged]`), added once and then edited with `taskctl comment update`, with the marker leading the body when it applies;
   - for a `[decision-request]`: after moving the issue to `blocked`, send the user one Slack DM with the ticket key, the question, the options and the recommendation (format in `loop.md`, "Stopping for a decision"); a Linear issue is not moved to Blocked in Linear, it stays In Development;
   - the instruction to stop when `taskctl issue heartbeat` returns `paused: true` (paused, taken over, or released because the user moved the Linear ticket back), recording in the agent comment where it stopped unless it already starts with `[released]`;
   - for `resume` or `rework`, the instruction to read the agent comment and the latest user comment first.
3. When a subagent finishes, check its handoff: the PR URL, the exact head SHA, the verification, and the final issue status. A paused issue that stays `in_progress` is expected. If an unpaused issue is still `in_progress` with no handoff, edit its agent comment to start with a `[decision-request]` saying what happened, move it to `blocked` and send the user the same Slack DM, so it surfaces to the user.
4. Run step 1 again to refill freed slots.

## After a merge

When the user has authorized a merge and you merge an issue's PR, edit that issue's agent comment right away so it starts with `[merged] <PR URL> <merge SHA>` (`taskctl comment update`, same `--agent-platform claude --session-id S`); do not add a second comment. Leave the issue `in_review`. `taskctl next` treats an `in_review` blocker whose agent comment starts with `[merged]` as satisfied, so issues blocked by it become `new` candidates.

## Pacing

Use `/loop` without an interval (self-paced). Subagent completion notifications wake the coordinator, so do not poll for them. When nothing is running and `next` returns `no_eligible` or only waiting work, schedule the next tick 20 to 30 minutes out.

## Never

- Merge a PR without the user's authorization, move an issue to `done`, or mark user acceptance.
- Work issues outside the given project. A Linear project (`linear-my-tasks`) is processed only when the user names it, its loop is enabled and a repository is mapped.
- Raise `maxConcurrent` yourself. The user sets it.
