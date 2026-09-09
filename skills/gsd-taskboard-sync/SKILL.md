---
name: gsd-taskboard-sync
description: Optional GSD integration for reconciling a local .planning directory with a Taskboard project. Install this skill only when the workspace uses GSD; it is not required for ordinary Taskboard use.
---

# Optional GSD Taskboard Sync

Synchronize a local GSD planning model with Taskboard without losing history. This is an optional planning adapter layered on top of Taskboard's general issue and relation model; users who do not use GSD can ignore it.

## Workspace resolution

- The skill is project-agnostic. Never hard-code a repository, project, or user path from an example or a previous run.
- Prefer the absolute project directory explicitly supplied by the user. Otherwise use the current working directory only when it contains `.planning/`; if neither is true, ask for the project directory.
- Resolve `.planning/` relative to that selected project directory and use absolute paths in Taskboard descriptions and comments.
- Use the explicitly supplied Taskboard project ID. If it is omitted, resolve it with `taskctl context current --cwd PROJECT_DIR`; do not guess from the project name.

## Default behavior

- Treat local Markdown as the source of planning truth, but do not assume a changed title identifies the same task.
- Start with a read-only dry run. Report additions, changes, possible renames, splits, removals, and ambiguous mappings before writing.
- Before any apply, the dry run must explicitly report three independent difference dimensions: dependency relations, dates (`startDate`/`dueDate`), and development context (branch/worktree). Report each dimension even when there are no differences, and distinguish `checked/no differences`, `checked/has differences`, and `not checked`.
- Never delete tasks as part of synchronization. A confirmed removal may be archived with Taskboard's recoverable archive operation; unconfirmed removals remain untouched.
- Do not automatically archive an old Phase when a Phase was renamed, split, or reordered. Require an explicit user mapping and confirmation.
- Local file changes do not trigger synchronization. Only apply changes after the user explicitly asks to apply the dry-run result.
- A user may separately approve applying only high-confidence metadata updates (priority, labels, dates, or development context). This does not approve relation updates or archival.
- Rely on Taskboard's activity history for ordinary field-level before/after changes. Do not add a comment for every routine update. Add a comment only when a human-readable rationale or durable sync record is useful: ambiguous or confirmed rename/split/merge mapping, relation audit or skipped relation writes, archival, source-path/content migration, or unresolved risk.
- For every non-execution Taskboard write, use `taskctl issue update --preserve-thread` (or the equivalent preserve-binding option) so the synchronization conversation is never bound as the task's execution conversation. Only the Codex conversation that actually starts processing a task may write or replace its `threadId`.
- When source evidence requires human acceptance or a human decision, set status to `in_review` and assign the task to the Taskboard current user; do not leave it assigned to Codex. Use `--assignee current-user` only when the Taskboard request carries a real current-user identity; do not fabricate one. When no human acceptance is required and execution/verification evidence is complete with no open gap, set status directly to `done`.

## Source discovery

For the selected workspace, read `STATE.md`, `ROADMAP.md`, each phase directory's `*-PLAN.md`, matching `*-SUMMARY.md`, `*-UAT.md`, and `*-VERIFICATION.md`, plus `todos/pending/*.md`. Do not create tasks for `SUMMARY`, `RESEARCH`, `CONTEXT`, `REVIEW`, `VERIFICATION`, `UAT`, or other auxiliary documents. Read debug records when they explain a gap or priority.

Read [references/sync-policy.md](references/sync-policy.md) before comparing or mutating tasks. Use `taskctl` for every Taskboard operation and follow the existing `manage-taskboard` conventions for issue reads, exact identifiers, optimistic versions, conversation attribution, comments, and post-write verification.

## Apply mode

When the user confirms an identified mapping:

1. Create new Phase roots, PLAN children, and PLAN-internal Task grandchildren with parent relations. Preserve the GSD hierarchy; do not create Wave tasks.
2. Update matched task fields only when the source supports the change. Preserve existing useful labels and source paths.
3. Populate priority, labels, dates, development context, and relations using the evidence rules in the reference. Leave unsupported fields unchanged or null; never infer dates from file timestamps or invent branches.
4. Before any mutation, complete and display the dependency-relation, dates, and development-context difference checks. A metadata-only apply may proceed only after the relation check is explicitly reported; it must not perform relation mutations.
5. Map GSD execution and verification evidence to Taskboard statuses without claiming a phase is complete merely because its plans have summaries.
6. Rely on Taskboard activity history for routine field changes. Add a comment only for mapping decisions, relation audit/skips, archival, source-path/content migration, or unresolved risks, including source paths and sync time where relevant.
7. Re-read every written issue and report created, updated, archived, skipped, and ambiguous items. Keep relation audit status separate from relation mutation status: `skip relation updates` means no relation writes were made, not that all relations were checked.
