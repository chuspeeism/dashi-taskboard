---
name: manage-taskboard
description: Manage taskboard projects, issues, issue relations, and comments through the taskctl CLI. Use when Codex needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Taskboard

Use `taskctl` for every project, issue, and comment operation. Read [references/cli.md](references/cli.md) before choosing a command or option. For shared context operations, use the `$shared-project-context` Skill's MCP tools, not `taskctl`.

## Workflow

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, load its shared context in this order:
   - Call `taskboard_context_current_project`. Stop and fix the workspace mapping if it does not resolve the intended project.
   - Read the latest issue content and all comments with `taskctl`. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - Call `taskboard_context_brief` for the resolved project.
   - Call `taskboard_context_search` using the issue title, labels, and meaningful terms from its description. Use `taskboard_context_get` when a search result needs full inspection.
   - Treat shared requirements, constraints, decisions, and risks as work constraints. If entries conflict, report each source and `updatedAt`; never choose silently.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
   - Before that handoff, publish only durable decision, constraint, current state, risk, handoff, summary, or next step information that will help later work.
   - Use a stable issue-scoped `idempotencyKey`, such as `issue:<issue-id>:<kind>:<topic>`. Reuse it for retries; update the existing entry with its current `version` when the durable fact changes.
   - MCP publication is agent-authored and must remain `sourceType: agent`; do not present an inference as user-confirmed.
   - Never publish credentials, private paths, raw chats, full logs, or temporary diagnostics. Before publishing potentially sensitive material, obtain explicit user approval.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
