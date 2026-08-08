# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.

## Documentation maintenance

- `docs/ai-intervention-triggers.md` is the source-of-truth reference for AI entry points, trigger conditions, model roles, permissions, task/comment side effects, and non-triggering actions.
- `docs/task-status-reference.md` is the source-of-truth reference for task status meaning, entry and exit conditions, responsibility, storage behavior, and AI consequences.
- Any change to task statuses, comment intent/action routing, readiness, planner/worker dispatch, handoff, AI retry, project automation, or AI role/model/sandbox settings must update the relevant reference in the same change.
- Any new user or server entry point that can create an AI thread, start an AI run, write an AI comment, or change task status must be added to `docs/ai-intervention-triggers.md`.
- Keep both references reachable from `README.md` and `docs/README.md`, and verify their relative links after edits.
