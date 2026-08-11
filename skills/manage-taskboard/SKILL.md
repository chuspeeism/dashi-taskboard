---
name: manage-taskboard
description: Manage taskboard work with taskctl. Use for e-taskboard prompts, issue IDs from any project, status sync, or comments.
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Core workflow

1. When claiming, starting, or resuming an existing issue, first run `issue get`, then immediately move it to `in_progress` with its current `version`. Do this before reading comments or code, downloading attachments, analyzing the implementation, or doing any other task work. If the write fails or conflicts, run `issue get` again and retry with the latest `version`; do not continue until the move succeeds.
2. After the move succeeds, run `comment list`. Treat comments as current requirements, including returned work.
3. For a new durable requirement, run `context current` and search existing project issues before creating one. Update a matching issue instead of creating a duplicate. Do not track trivial requests.
4. Execute only the requested work in the issue's branch or worktree when one is bound.
5. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
6. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
