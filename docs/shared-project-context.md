# Shared project context

The Dashi Taskboard official plugin lets Codex read and publish durable project knowledge without sharing a Codex session or giving the model direct database or cloud credentials. It packages the `manage-taskboard` and `shared-project-context` Skills with a local stdio MCP server.

## Architecture

```text
Codex
  -> official plugin Skills and taskboard_context_* MCP tools
  -> dashi-taskboard-mcp over stdio
  -> loopback companion HTTP API
  -> local SQLite, or authenticated Worker API -> D1
```

The MCP process accepts only a loopback `http://` or `https://` companion origin. It uses the companion HTTP API and never imports SQLite code, queries D1, reads the companion credential file, or inspects Codex internal state. In cloud mode the companion is the authentication and device-mapping boundary: it sends Basic Authentication to the HTTPS Worker and never exposes that header or password to MCP.

The cloud service is authoritative whenever cloud mode is active. `REMOTE_UNAVAILABLE` and other cloud failures are returned to the caller; there is no local fallback or dual write.

## Tools and HTTP routes

| MCP tool | Companion request | Purpose |
| --- | --- | --- |
| `taskboard_context_current_project` | `GET /api/projects` | Resolve the most-specific workspace mapping and return only public project metadata. |
| `taskboard_context_brief` | `GET /api/projects/:projectId/context/brief` | Load prioritized active requirements, constraints, decisions, risks, handoffs, and summary context. |
| `taskboard_context_search` | `GET /api/projects/:projectId/context` | Search/filter entries and page with `nextCursor`. |
| `taskboard_context_get` | `GET /api/context/:id` | Load one complete context entry. |
| `taskboard_context_publish` | `POST /api/projects/:projectId/context` | Publish an agent-authored entry with a required stable `idempotencyKey`. |
| `taskboard_context_update` | `PATCH /api/context/:id` | Update fields using a required positive `version`. |
| `taskboard_context_archive` | `POST /api/context/:id/archive` | Archive an entry using a required positive `version`. |

Every tool has a closed input schema and returns both structured JSON and a short model-readable text result. Successful structured results use `ok: true`. Failures use `ok: false`, set the MCP error flag, and return only `status`, `code`, `category`, `action`, and safe numeric version details when available.

Project-scoped tools accept an explicit `projectId`; otherwise they resolve the current process directory through local device mappings. Resolution never selects an unrelated fallback project. Current-project output omits `cwd`, `workspacePath`, and all device mappings. HTTP requests have a 10-second timeout, never include an incoming Authorization value, and never return upstream exception text, full environment data, or credential fields.

`taskboard_context_publish` always sends `sourceType: agent`. Use `sourceId` and `sourceThreadId` only for provenance. `sourceThreadId` does not contain a chat and cannot grant access to, transfer, or restore a Codex conversation on another device.

## Local installation

Requirements: Node.js 22.5 or newer and a Codex release with plugin support.

From the repository checkout:

```bash
npm ci
npm link
npm run build
npm run plugin:validate
```

`npm link` exposes `taskctl` and `dashi-taskboard-mcp` on `PATH`. Start the companion on loopback and leave it running:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

In another terminal, register the repository marketplace and install its plugin:

```bash
codex plugin marketplace add .
codex plugin add dashi-taskboard@dashi-taskboard-local
codex plugin list --json
```

Restart Codex or start a new thread. New sessions should expose both Skills and exactly seven `taskboard_context_*` tools. The plugin does not start the companion and does not embed the board UI. Use the browser at <http://127.0.0.1:47823>, or separately enable the optional CDP UI injector documented in the README.

## Refresh an existing installation

Codex caches installed local plugin contents. After pulling changes, update dependencies and UI artifacts, validate the clean manifest, add one local cachebuster, and reinstall from the already configured marketplace:

```bash
npm ci
npm link
npm run build:web
npm run plugin:validate
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" .
codex plugin add dashi-taskboard@dashi-taskboard-local
```

The helper replaces any existing `+codex.*` suffix and intentionally changes only the local `.codex-plugin/plugin.json` version so Codex sees new contents. Do not commit the generated timestamp as a product release version. Start a new thread after reinstalling. If `CODEX_HOME` is not exported, use the equivalent `skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py` path under the active Codex home.

## Two-device cloud setup

Plugin files, cloud access, and project mappings are separate concerns. On each trusted device:

1. Pull the same repository revision, then run `npm ci`, `npm link`, `npm run build:web`, and `npm run plugin:validate`.
2. Register/install `dashi-taskboard@dashi-taskboard-local` on that device, then restart Codex or start a new thread.
3. Start the local companion with `CODEX_TASKBOARD_HOST=127.0.0.1 npm start`.
4. Run `taskctl cloud login --url HTTPS_ORIGIN --actor-name NAME` and enter the shared password only at the private prompt.
5. Run `taskctl project list`, then map each shared project with `taskctl project map PROJECT_ID --workspace-path /that/devices/checkout`.
6. Run `taskctl context current --json` from the checkout and explicitly confirm its `project.id` and `workspacePath`; this legacy CLI command can fall back when no mapping matches. Then call `taskboard_context_current_project` in a new Codex thread and require the expected project ID. The MCP result is the strict no-fallback check.

The owner performs the same device steps. Each mapping stays local and may differ. Installing the plugin does not copy the shared password, D1 data, attachments, Codex chats, execution environments, or filesystem paths. See [Cloud collaboration](cloud-collaboration.md) for Worker provisioning and password rotation.

## Security and permission boundary

- The Basic password grants full shared-board read/write access. Actor names are display attribution, not verified identities; there is no per-user RBAC or individual revocation.
- The companion config is device-local and mode `0600`. Never put the shared password in plugin JSON, MCP arguments, an issue, context entry, shell history, or logs.
- MCP publishes only explicit tool arguments. It does not automatically scrape chats, command output, files, or environment variables.
- The Skills prohibit publishing credentials, private paths, raw chats, full logs, temporary diagnostics, and complete environment data. Potentially sensitive context requires explicit user approval.
- Context bodies are shared application data. Review them before publication; API and transport filtering cannot identify every secret a user may type into a body.
- Use a stable issue/source-scoped `idempotencyKey` for retries. Use the current `version` for update/archive and reload before resolving a conflict.

## Troubleshooting

| Code or symptom | Action |
| --- | --- |
| `dashi-taskboard-mcp` not found | Run `npm link`, confirm the npm global bin directory is on `PATH`, and start a new Codex session. |
| Plugin or tools missing | Run `npm run plugin:validate`, `codex plugin list --json`, reinstall from `dashi-taskboard-local`, then restart Codex or open a new thread. |
| `COMPANION_UNAVAILABLE` | Start the loopback companion. Check `CODEX_TASKBOARD_COMPANION_URL` only if using a non-default loopback port. |
| `INVALID_COMPANION_URL` | Use a credential-free loopback HTTP(S) origin with no path, query, or fragment. |
| `PROJECT_MAPPING_NOT_FOUND` | Run `taskctl project list` and map the intended project to this device's checkout. Do not use another project's fallback. |
| `PROJECT_NOT_FOUND` / `CONTEXT_NOT_FOUND` | Refresh the project or entry identifier. The server does not fabricate missing data. |
| `VERSION_CONFLICT` | Reload the entry, reconcile the newer state, and retry with `actualVersion`. The compatibility alias `CONTEXT_VERSION_CONFLICT` is also recognized. |
| `IDEMPOTENCY_CONFLICT` | Reuse the original content for that key, or choose a new stable key for a genuinely different entry. The compatibility alias `CONTEXT_IDEMPOTENCY_CONFLICT` is also recognized. |
| `CONTEXT_ALREADY_ARCHIVED` | Reload and treat the entry as archived; do not retry blindly. |
| `UNAUTHORIZED` | Repeat `taskctl cloud login` through the companion. Never place Basic credentials in MCP configuration. |
| `CLOUD_NOT_CONFIGURED` | Configure the cloud origin and shared key through `taskctl cloud login`. |
| `REMOTE_UNAVAILABLE` | Check Worker/network availability and retry later. Do not switch to local data for the same operation. |
| `SERVER_MISCONFIGURED` | Ask the deployment owner to check Worker bindings and server configuration. |

## Operational changes and rollback

This plugin layer adds no database migration and changes no context API route. Rollback consists of removing or disabling the plugin and unlinking its npm bins; existing SQLite/D1 context remains intact. Disabling the plugin stops agent access but does not stop the companion or delete shared entries.

The current shared-password design is intentionally small-team only. A future centralized deployment should add OIDC or another verified identity layer, scoped permissions, audit export, and explicit App Server/session architecture rather than treating `sourceThreadId` as session sharing.
