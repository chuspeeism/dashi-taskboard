# Shared Project Context MCP Design

## Scope

Package Codex Taskboard as an official Codex plugin containing the existing `manage-taskboard` Skill, a new `shared-project-context` Skill, and a local stdio MCP server. The MCP server consumes only the loopback companion HTTP API and does not import or access SQLite, D1, cloud credentials, or Codex internal state.

## Chosen Approach

Use a focused MCP companion client rather than wrapping `taskctl` as a subprocess or refactoring the existing CLI. A subprocess wrapper would weaken tool schemas and error contracts. A shared CLI refactor would broaden regression risk without improving the required HTTP boundary.

The MCP server runs as the npm bin `dashi-taskboard-mcp`. The plugin's `.mcp.json` invokes that stable command, so the manifest contains no installation path. Local developers run `npm ci && npm link` before installing the repo marketplace.

## Components

- `mcp/companion-client.mjs`: validate a loopback companion origin, issue timeout-bounded JSON requests, resolve the most-specific cwd mapping, strip local path fields, and normalize errors into a whitelist-only model response.
- `mcp/context-server.mjs`: define the seven strict tools with Zod, call the companion client, and return `structuredContent` plus concise text for success and failure.
- `mcp/server.mjs`: connect the configured server to the official SDK stdio transport without writing non-protocol output to stdout.
- `.codex-plugin/plugin.json` and `.mcp.json`: package both Skills and the bundled server according to the current official format.
- `.agents/plugins/marketplace.json`: expose the repository-root plugin for local development without changing personal marketplace state.

## Tool Semantics

`taskboard_context_current_project` resolves the most-specific mapped project from `cwd`; it does not silently fall back to an unrelated project. Project-scoped tools accept an optional explicit `projectId`, otherwise they resolve the current project. `brief` and `search` read project data, `get` reads one entry, `publish` requires a stable `idempotencyKey`, and `update`/`archive` require a positive `version`.

All tools return an `ok` discriminant, JSON structured data, and short model-readable text. Tool errors retain the upstream HTTP status and code but replace message/details with a stable category, action, and whitelisted numeric version fields. The implementation recognizes both the actual `VERSION_CONFLICT`/`IDEMPOTENCY_CONFLICT` codes and the stale handoff aliases, while always returning the actual upstream code.

## Security Boundary

- Only loopback HTTP(S) companion origins are accepted.
- MCP never sends or returns an Authorization header or cloud shared password.
- Current-project output omits `cwd`, `workspacePath`, and every device mapping.
- Error output never includes upstream URLs, network exception text, complete environment data, or unfiltered details.
- User-authored context body remains application data; the server does not inspect Codex chats or internal files.
- Cloud failures remain failures; MCP has no local fallback or dual-write path.

## Skill Workflow

Before work, resolve the project, read the issue/comments, load the brief, and search by meaningful issue terms. Treat requirements, constraints, decisions, and risks as work constraints. When entries conflict, show both sources and `updatedAt` values rather than choosing silently.

After work, publish only durable decisions, constraints, state, risks, handoffs, summaries, or next steps. Never publish raw chats, full command output, temporary debugging, credentials, or private paths. Potentially sensitive publication requires an explicit user request, and agent inference uses `sourceType: agent`.

## Verification

Use the official MCP client over a spawned stdio process to cover initialize, tools/list, tools/call, success, 404, all relevant 409 classes, 401, remote unavailability, idempotent replay, and leak sentinels. Validate both Skills, the plugin manifest, the marketplace, focused tests, typecheck/build, and the full check against the recorded 18-failure baseline.
