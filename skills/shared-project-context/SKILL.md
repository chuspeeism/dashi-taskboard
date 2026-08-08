---
name: shared-project-context
description: Read, search, publish, update, and archive durable project context through the Dashi Taskboard MCP server. Use before project work to load shared requirements, decisions, constraints, facts, risks, handoffs, or summaries, and after work when a durable outcome should be shared across devices or collaborators.
---

# Shared Project Context

Use the taskboard context MCP tools exclusively. Never use direct database or SQLite access, `curl`, local companion files, or Codex internal state for shared context. A cloud error remains an error: there is no local fallback or dual write.

## Read Workflow

1. Call `taskboard_context_current_project`. Stop on `PROJECT_MAPPING_NOT_FOUND`; map this workspace to the intended taskboard project before continuing. Do not select an unrelated project.
2. Call `taskboard_context_brief` for prioritized requirements, constraints, decisions, risks, handoffs, and the latest summary.
3. Call `taskboard_context_search` with focused terms, kinds, or tags. Follow `nextCursor` when more results matter.
4. Call `taskboard_context_get` for each result whose full body or provenance is needed.

Context can be stale or contradictory. When entries conflict, show each source and `updatedAt`, explain the conflict, and never choose silently. Ask for clarification when the conflict changes the requested work.

## Write Workflow

- Use `taskboard_context_publish` only for durable `requirement`, `decision`, `constraint`, `fact`, `risk`, `handoff`, or `summary` entries. Put a durable next step in an appropriate handoff or summary.
- Choose a stable `idempotencyKey` tied to the source and topic. Reuse the same key for retries so a replay cannot create a duplicate.
- MCP publication is agent-derived and remains `sourceType: agent`. Include `sourceId` or `sourceThreadId` only as provenance; neither field grants access to or restores a Codex session.
- Before changing an entry, load it with `taskboard_context_get`, then call `taskboard_context_update` with its current `version`. On a conflict, reload and reconcile before retrying.
- Before removing an entry from active context, load it, then call `taskboard_context_archive` with its current `version`. Archiving is destructive to active visibility; confirm the intent when it is not already explicit.

Never publish credentials, cookies, tokens, shared passwords, private device paths, raw chats, full logs, temporary diagnostics, or complete environment data. Before publishing potentially sensitive material, obtain explicit user approval. Keep inferences labeled as agent conclusions rather than user-confirmed requirements.

## Error Actions

- `PROJECT_MAPPING_NOT_FOUND`: map this device's workspace and retry.
- `PROJECT_NOT_FOUND` or `CONTEXT_NOT_FOUND`: refresh the project or entry identifier; do not fabricate an entry.
- `VERSION_CONFLICT` (or the compatibility alias `CONTEXT_VERSION_CONFLICT`): reload the entry and retry only after reconciling the current version.
- `IDEMPOTENCY_CONFLICT` (or `CONTEXT_IDEMPOTENCY_CONFLICT`): reuse the original content or deliberately choose a new key for a different entry.
- `CONTEXT_ALREADY_ARCHIVED`: reload the entry and treat it as archived; do not retry blindly.
- `CONTEXT_NOT_ARCHIVED`: reload before any restore workflow; this plugin does not expose a restore tool.
- `UNAUTHORIZED`: authenticate through the local companion, then retry. Never pass an Authorization header to the MCP tool.
- `CLOUD_NOT_CONFIGURED`: configure cloud collaboration in the companion before retrying.
- `REMOTE_UNAVAILABLE`: report the cloud outage and stop; never fall back to local context.
- `COMPANION_UNAVAILABLE`: start the local companion and retry.
- `SERVER_MISCONFIGURED`: ask the taskboard administrator to inspect server configuration.
