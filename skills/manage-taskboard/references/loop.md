# Agent loop

Use this when an agent works Taskboard issues in a loop instead of one requested issue.

## Settings

The loop is configured per project in client storage key `taskboard.agentLoop.v1`:

```bash
taskctl loop config --project PROJECT_ID --enable --max-concurrent 2
taskctl loop config --project PROJECT_ID --disable
```

- `enabled`: the loop hands out work only when true. The default is false.
- `maxConcurrent`: the most issues agents may work at once, from 1 to 10. The default is 2. An issue counts as worked while it is `in_progress` with an agent session or a Codex thread binding.
- `repoPath`: the repository the agent works in. Required for the Linear project (`linear-my-tasks`), which has no workspace of its own.
- `labelRepos`: optional per-label overrides. An issue with a mapped label uses that repository instead of `repoPath`.

```bash
taskctl loop config --project linear-my-tasks --enable --repo /path/to/repo
taskctl loop config --project linear-my-tasks --label-repo PowerFlow=/path/to/powerflow
taskctl loop config --project linear-my-tasks --label-repo PowerFlow=   # remove the override
```

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

1. `resume`: a `blocked` issue whose latest `[decision-request]` agent comment has a later user comment, meaning the user answered.
2. `rework`: an `in_review` issue whose latest user comment starts with `/rework` and has no later agent comment.
3. `new`: a `todo` issue whose blockers are all `done`. It must not have the `hold` label or an unanswered decision request. For Linear issues `todo` means the Ready For Dev state.

Never claim `backlog`, and never take over an issue another session is working.

## Working an issue

Follow the core workflow in `SKILL.md`: read the issue, comments and attachments, do the work in your own branch or worktree, verify the direct path, and open a PR. When `repoPath` is set, branch from that repository's default branch and follow its own `AGENTS.md` or `CLAUDE.md`.

For Linear issues, status moves write back to Linear: claiming moves Ready For Dev to In Development, handing off to `in_review` moves it to Code Review, and `blocked` moves it to Blocked. Comments stay in Taskboard and are not synced to Linear. For `resume`, start from the user's answer. For `rework`, start from the `/rework` comment.

## Stopping for a decision

Stop and ask instead of guessing when the next step needs any of these:

- A product or UX trade-off that the issue and comments do not settle.
- A scope change, or dropping part of the requirement.
- A destructive or irreversible operation (data migration, deleting user data, force-pushing shared history).
- A production deploy, release, or anything outside the repository.
- Credentials, payments, or access you do not have.

To stop, add one comment and move the issue to `blocked`:

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

When the work is done and verified, add one comment and move the issue to `in_review`. Never move it to `done` and never merge.

```text
Done: <what changed>
PR: <url> (head <sha>)
Verified: <direct path and result>
Limitations: <known gaps, or none>
```

The user either accepts the issue or replies `/rework <what to change>`.
