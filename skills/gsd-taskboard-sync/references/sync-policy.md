# Synchronization Policy

## Phase and PLAN identifiers

Recognize GSD Phase and PLAN identifiers as structured labels, not only integers. Valid identifiers include numeric (`1`), decimal (`2.1`, `2.10`), and alphanumeric forms (`3A`, `3B`, `A`, `beta`) when the source uses them consistently. Preserve the identifier's spelling and case in the title, source metadata, labels, and matching evidence. Do not normalize `3A` to `3`, or treat `2.1` as Phase `2`.

Use the complete identifier when matching a Phase or PLAN to an existing task. A title or filename match that differs only by identifier is a rename/split candidate, not an automatic match. Phase labels should use a collision-free form such as `phase-2.1` or `phase-3a`, while the task title and description retain the original identifier.

## GSD hierarchy

For the GSD structure used by this project, distinguish planning levels from execution groupings:

1. Project or milestone: the overall product and release scope described by `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and `STATE.md`.
2. Phase: a milestone-level outcome in `ROADMAP.md`; this is the parent-task level in Taskboard.
3. Wave: an ordered execution grouping inside a Phase in `ROADMAP.md`, often carrying a dependency such as `blocked on Wave 1`; it is not a separate Taskboard task in the default sync shape.
4. PLAN: a `*-PLAN.md` implementation plan inside a Phase directory; this is a child task of the Phase in Taskboard.
5. Plan task: a `<task>` block inside a PLAN, such as `auto`, `tracer`, or `checkpoint:human-verify`; create it as a child task of that PLAN. Preserve its task name, type, TDD/checkpoint attributes, files, behavior, action, verification, and done criteria in the description.
6. Quick task: an independent plan-like item under `.planning/quick/<id>/`; keep it independent unless its source explicitly declares a Phase parent.
7. Todo: a pending item under `.planning/todos/pending/`; keep it independent unless its source explicitly declares a parent or dependency.

Auxiliary documents (`SUMMARY`, `RESEARCH`, `CONTEXT`, `REVIEW`, `VERIFICATION`, `UAT`, and similar evidence) support status and metadata but are not hierarchy nodes. Thus the default Taskboard projection is `Project -> Phase -> PLAN -> Plan Task`, with Wave represented as metadata/evidence.

The project directory and Taskboard project ID are runtime inputs, not skill configuration. Replace `PROJECT_DIR` and `PROJECT_ID` with values supplied or safely resolved for the current request; never copy a path from an earlier project.

## Canonical task shape

- `ROADMAP.md` Phase entries become parent tasks.
- A phase directory's `*-PLAN.md` becomes a child task of that Phase.
- Each `<task>` block inside a PLAN becomes a child task of that PLAN. Use a stable source identity such as `Source: /absolute/path/to/PLAN.md#task:<name-or-index>` so repeated syncs do not duplicate it.
- `.planning/todos/pending/*.md` becomes an independent todo task.
- `SUMMARY`, `RESEARCH`, `CONTEXT`, `REVIEW`, `VERIFICATION`, `UAT`, `DISCUSSION-LOG`, `PATTERNS`, `VALIDATION`, and coverage or debug evidence do not become standalone tasks.
- Every created or updated task description keeps a visible `Source: /absolute/path/to/file` line. For a Phase sourced from `ROADMAP.md`, also record the Phase number and title because the file path is shared by all phases.

## Metadata mapping

Use this precedence for each field: explicit user instruction, explicit source frontmatter/field, then evidence from the source's verification state. If no source supports a value, leave the field null or preserve the existing value.

- `priority`: use an explicit `priority` or `severity` first. Map `blocker`/`critical` to `urgent`, `major` to `high`, `minor` to `medium`, and `low` to `low`. An open blocker in UAT, VERIFICATION, or debug evidence is at least `high`; a security blocker is `urgent`. Do not assign a priority merely because a task exists.
- `labels`: preserve existing labels and add evidence-backed labels such as `phase-{identifier}` (for example `phase-2.1` or `phase-3a`), `plan`, `todo`, `verification-gap`, `human-review`, `blocked`, `security`, or `deferred`. Do not replace labels wholesale.
- `startDate` and `dueDate`: set only from an explicit `start_date`/`due_date`, `startDate`/`dueDate`, deadline, or schedule field in the source or user instruction. Do not use Markdown timestamps, file mtimes, `last_updated`, or plan execution dates as task dates. Date-less GSD plans remain date-less in Taskboard.
- `developmentContext`: set only from an explicit branch or worktree declaration in the source or user instruction. A workspace path maps to the Taskboard project mapping, not automatically to a task branch/worktree. Never invent a branch or worktree.

## Relation mapping

Create parent relations first, then dependency relations using exact Taskboard identifiers:

- A PLAN is a child of its Phase (`parent`).
- `Depends on: Phase <identifier>` means the dependent Phase is `blocked_by` the Phase with that complete identifier; `<identifier>` may be numeric, decimal, or alphanumeric.
- An explicit `depends_on`, `blocked_by`, or `blocks` declaration in a PLAN maps to the corresponding Taskboard relation after all referenced tasks exist.
- A roadmap statement such as `Wave 2 blocked on Wave 1 completion` may create `blocked_by` relations from each Wave 2 plan to the referenced Wave 1 plans, but only when the wave membership is unambiguous. Do not infer dependencies from file ordering alone.
- Todos remain independent unless their source explicitly names a parent or dependency.
- Never use a parent relation to represent a dependency; a PLAN or Plan Task can have one parent and also have dependency relations.

## Matching order

Use the strongest available identity and stop when identity is ambiguous:

1. An existing task description's exact `Source:` identity, including `#task:<name-or-index>` for Plan Tasks.
2. Exact Phase identifier, PLAN filename, or Plan Task name embedded in the title and the same parent chain.
3. Exact normalized title only as a review candidate, never as an automatic mutation when multiple candidates exist.

Do not match only by ordinal position. A Phase rename, reorder, or split can make ordinal matching destructive.

## Dry-run output

Before writes, produce a compact table with:

| Action | Existing task | Source | Reason | Confidence |
|---|---|---|---|---|
| create/update/archive/skip | identifier and title | absolute path | evidence | high/medium/ambiguous |

Classify a changed Phase as one of:

- `rename candidate`: one old task maps to one new task;
- `split candidate`: one old task maps to two or more new tasks;
- `merge candidate`: multiple old tasks map to one new task;
- `removed candidate`: no current source match.

Only apply high-confidence updates automatically. Ask for confirmation for rename, split, merge, and removal candidates.

Every dry run must also contain a separate difference summary with these exact dimensions:

| Dimension | Result | Required detail |
|---|---|---|
| Dependency relations | checked/no differences, checked/has differences, or not checked | Existing relation, source relation, proposed add/remove, and confidence |
| Dates | checked/no differences, checked/has differences, or not checked | `startDate`/`dueDate` source evidence and proposed changes |
| Development context | checked/no differences, checked/has differences, or not checked | branch/worktree source evidence and proposed changes |

Do not collapse these dimensions into a generic metadata summary. A report that says `skip relation updates` only records that relation mutations were skipped; it does not establish that relations were checked. If relations were not compared, report `Dependency relations: not checked` and do not describe the synchronization as fully reconciled.

High-confidence priority, label, date, or development-context changes may be applied through an explicitly approved metadata-only apply. That approval does not apply relation additions/removals, parent changes, renames, splits, merges, or archival. A metadata-only apply must preserve the separate relation audit result and must not change `not checked` to `checked`.

All non-execution sync updates must preserve the existing Codex conversation binding by using `taskctl issue update --preserve-thread` (or an equivalent API option). Creating a task or intentionally starting/continuing its implementation is the only workflow allowed to bind or replace `threadId`.

## Safe mutation rules

- Never call a destructive delete during sync.
- For a confirmed removal, use Taskboard archive and state that it is recoverable.
- For a rename, update the old task in place and preserve its identifier, comments, conversation references, and history.
- For a split, preserve the old task until the user confirms the replacement mapping; then create the new tasks and link or archive the old task only as explicitly directed.
- For content changes, update the description in place and add a comment with the old/new source path, changed sections, and sync timestamp. Taskboard activity records field-level changes, but the comment is the durable human-readable audit trail.
- Preserve existing labels unless the source clearly invalidates one. Add labels such as `phase-{identifier}`, `plan`, `verification-gap`, `human-review`, `blocked`, or `deferred` only when supported by the source evidence, retaining the complete Phase identifier.
- Set `developmentContext` only when the source or user explicitly provides a branch or worktree. Never invent a branch, worktree, or workspace path.
- Use `in_review` for implementation complete but explicitly awaiting human acceptance or a human decision, and assign it to the Taskboard current user. Use `--assignee current-user` only when a real current-user identity is available; otherwise leave assignment unchanged and report the assignment as pending manual action. Use `blocked` for an unresolved blocker. When no human acceptance is required and execution/verification evidence is complete with no open gap, set the task directly to `done`; do not wait for user confirmation. A plan with a SUMMARY is execution evidence, but may be enough for `done` when the source has no human gate.

## Status and metadata evidence

- PLAN without SUMMARY: `todo` unless active work is explicitly reported.
- PLAN with successful SUMMARY and no open gap: `done` when no human gate remains; `in_review` plus `current-user` assignee when human acceptance remains.
- Open blocker in UAT, VERIFICATION, or debug evidence: `blocked`.
- Phase with all plans executed: use `in_review` plus `current-user` assignee only when phase verification or human UAT explicitly requires human action; otherwise use `done` when verification evidence is complete and no gap remains.
- New or materially changed plans should inherit the Phase label and receive a priority based on evidence: blocker/security gap `urgent` or `high`, active implementation `medium`, maintenance/deferred work `low`.

## Post-sync record

For each applicable changed task, add one comment containing. Routine field-only updates rely on Taskboard activity history and do not require a comment:

```text
GSD sync: YYYY-MM-DD
Source: /absolute/path
Action: created | updated | renamed | split | archived
Changed: title, description, status, priority, labels, developmentContext
Evidence: /absolute/path/to/STATE.md, ROADMAP.md, VERIFICATION/UAT/debug file
Unresolved: none or a concise list
```

After all writes, re-read the exact Taskboard identifiers and report the final status. If a source change cannot be mapped safely, leave the task untouched and report it as ambiguous.
