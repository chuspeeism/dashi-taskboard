---
name: manage-taskboard
description: Manage taskboard work with taskctl. Use for e-taskboard prompts, issue IDs from any project, status sync, or comments.
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix. For shared context operations, use the `$shared-project-context` Skill's MCP tools, not `taskctl`.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Core workflow

1. For an existing issue, load its task and shared context in this order:
   - Call `taskboard_context_current_project`. Stop and fix the workspace mapping if it does not resolve the intended project.
   - Read the latest issue content and all comments: run `issue get` and `comment list` before acting. Treat comments as current requirements, including returned work.
   - Call `taskboard_context_brief` for the resolved project.
   - Call `taskboard_context_search` using the issue title, labels, and meaningful terms from its description. Use `taskboard_context_get` when a result needs full inspection.
   - Treat shared requirements, constraints, decisions, and risks as work constraints. If entries conflict, report each source and `updatedAt`; never choose silently.
2. For a new durable requirement, run `context current` and search existing project issues before creating one. Update a matching issue instead of creating a duplicate. Do not track trivial requests.
3. Before starting or resuming work, read the issue again and move it to `in_progress` with its current `version`. Stop if the status changed or the write conflicts.
4. Execute only the requested work in the issue's branch or worktree when one is bound.
5. Verify the requested operation path.
   - Before the handoff, publish only durable decision, constraint, current state, risk, handoff, summary, or next step information that will help later work.
   - Use a stable issue-scoped `idempotencyKey`, such as `issue:<issue-id>:<kind>:<topic>`. Reuse it for retries; update an existing entry with its current `version` when the durable fact changes.
   - MCP publication is agent-authored and must remain `sourceType: agent`; do not present an inference as user-confirmed.
   - Never publish credentials, private paths, raw chats, full logs, or temporary diagnostics. Before publishing potentially sensitive material, obtain explicit user approval.
   - Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
6. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](/api/attachments/<id>/content)` image only when it is needed to understand the requirement.
