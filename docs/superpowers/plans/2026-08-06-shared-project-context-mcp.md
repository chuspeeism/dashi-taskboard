# Shared Project Context MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested official Codex plugin and stdio MCP server that safely reads and writes shared project context through the existing companion HTTP API.

**Architecture:** A dependency-injected companion client owns loopback URL validation, timeout-bounded HTTP, cwd mapping, and sanitized errors. A separate MCP registration module owns strict Zod schemas and structured/text results; a tiny executable connects it to stdio. Plugin, Skill, marketplace, tests, and docs wrap that server without changing the ASH-46 database/API layer.

**Tech Stack:** Node.js 22 ESM, `@modelcontextprotocol/server`/`client` v2, Zod v4, `node:test`, Codex plugin JSON.

---

### Task 1: Companion Client Contract

**Files:**
- Create: `test/mcp-context.test.mjs`
- Create: `mcp/companion-client.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the stable official SDK test/runtime dependency**

Run: `npm install @modelcontextprotocol/server@2.0.0 zod@^4.4.3`

Run: `npm install --save-dev @modelcontextprotocol/client@2.0.0`

Expected: lockfile records the current stable v2 server/client packages and Zod; no unrelated direct dependency changes.

- [ ] **Step 2: Write failing client tests**

Cover loopback-only URL validation, 10-second abort signal use, most-specific cwd mapping with no fallback, project output without `cwd`/`workspacePath`, path/query encoding, JSON response parsing, and sanitized categories for 404/409/401/502.

- [ ] **Step 3: Verify RED**

Run: `node --test test/mcp-context.test.mjs`

Expected: FAIL because `mcp/companion-client.mjs` does not exist.

- [ ] **Step 4: Implement the minimal client**

Export `CompanionError`, `createCompanionClient`, `resolveCompanionUrl`, `resolveMappedProject`, and `publicProject`. Requests must send `accept`, `content-type` when needed, and `x-taskboard-client: taskctl`, but never Authorization. Whitelist only numeric `expectedVersion` and `actualVersion` details.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/mcp-context.test.mjs`

Expected: all client tests pass.

### Task 2: Strict MCP Tools and Real Stdio Protocol

**Files:**
- Modify: `test/mcp-context.test.mjs`
- Create: `mcp/context-server.mjs`
- Create: `mcp/server.mjs`

- [ ] **Step 1: Add failing stdio protocol tests**

Start a fake loopback companion and use SDK `Client` + `StdioClientTransport` to spawn `node mcp/server.mjs`. Assert initialize succeeds, tools/list contains exactly the seven required names with closed object schemas, and tools/call returns both `structuredContent` and text.

Add success cases for current project, brief/search/get, idempotent publish replay, versioned update/archive, plus 404, version conflict, idempotency conflict, archived-state conflict, 401, and `REMOTE_UNAVAILABLE` cases. Seed sentinels in project paths, Authorization-like fields, password values, and environment variables; assert serialized MCP responses omit them.

- [ ] **Step 2: Verify RED**

Run: `node --test test/mcp-context.test.mjs`

Expected: FAIL because the server/tools are missing.

- [ ] **Step 3: Implement strict tools**

Register:

```text
taskboard_context_current_project
taskboard_context_brief
taskboard_context_search
taskboard_context_get
taskboard_context_publish
taskboard_context_update
taskboard_context_archive
```

Use strict Zod input/output schemas, read/write annotations, encoded HTTP paths/query parameters, required `idempotencyKey` for publish, and required positive `version` for update/archive. Return `{ok:true,...}` or `{ok:false,error:{status,code,category,action,details?}}` as structured content plus concise text; set `isError: true` on failures.

- [ ] **Step 4: Implement stdio entry**

Add a Node shebang, build the server, call the v2 dual-era `serveStdio` entry, close on SIGINT/SIGTERM, and send fatal startup errors to stderr only.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/mcp-context.test.mjs`

Expected: all initialize/list/call, error, idempotency, and leak tests pass.

### Task 3: Official Plugin and Marketplace

**Files:**
- Create: `test/plugin-structure.test.mjs`
- Create: `.codex-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `scripts/validate-plugin.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing structure tests**

Assert the plugin name matches the repo directory, the manifest points to `./skills/` and `./.mcp.json`, the MCP map invokes `dashi-taskboard-mcp`, the npm bin points at `mcp/server.mjs`, marketplace policy fields are present, local source is inside the repo root, and all referenced paths exist.

- [ ] **Step 2: Verify RED**

Run: `node --test test/plugin-structure.test.mjs`

Expected: FAIL because plugin files and validator do not exist.

- [ ] **Step 3: Create minimal valid artifacts**

Use plugin name `dashi-taskboard`, semver `0.1.0`, real repository/homepage/license metadata, `mcpServers: "./.mcp.json"`, `skills: "./skills/"`, read/write capabilities, and a repo marketplace entry with `AVAILABLE`, `ON_INSTALL`, and `Productivity`.

Add `plugin:validate` to run the repository validator, both Skill validators, and the plugin-creator validator documented in the developer workflow.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/plugin-structure.test.mjs`

Run: `npm run plugin:validate`

Expected: structure tests and validators pass without touching personal Codex config.

### Task 4: Update `manage-taskboard` Skill

**Files:**
- Modify: `test/manage-taskboard-skill.test.mjs`
- Modify: `skills/manage-taskboard/SKILL.md`
- Modify: `skills/manage-taskboard/agents/openai.yaml` only if generated metadata is stale

- [ ] **Step 1: Add failing workflow assertions**

Require current-project resolution, issue/comment reads before brief/search, title/label/description search terms, requirement/constraint/decision/risk enforcement, source-and-time conflict reporting, durable-only publication, stable idempotency key, sensitive-data opt-in, and agent source attribution.

- [ ] **Step 2: Verify RED**

Run: `node --test test/manage-taskboard-skill.test.mjs`

Expected: new assertions fail against the old Skill.

- [ ] **Step 3: Add the minimal shared-context workflow**

Preserve all existing taskctl claim/version/review rules. Reference the `shared-project-context` Skill as required for project-context operations and state that context tools, not taskctl, own shared context.

- [ ] **Step 4: Verify GREEN and validate**

Run: `node --test test/manage-taskboard-skill.test.mjs`

Run: `python3 <skill-creator>/scripts/quick_validate.py skills/manage-taskboard`

Expected: assertions and validation pass.

### Task 5: Add `shared-project-context` Skill

**Files:**
- Modify: `test/manage-taskboard-skill.test.mjs`
- Create: `skills/shared-project-context/SKILL.md`
- Create: `skills/shared-project-context/agents/openai.yaml`

- [ ] **Step 1: Add failing new-Skill assertions**

Require MCP-only reads/writes, current-project/brief/search/get order, source-time conflict reporting, publish allowlist, stable idempotency, versioned update/archive, explicit error actions, sensitive-data rules, agent attribution, and bans on direct DB/Codex-state access.

- [ ] **Step 2: Verify RED**

Run: `node --test test/manage-taskboard-skill.test.mjs`

Expected: FAIL because the new Skill is absent.

- [ ] **Step 3: Initialize and write the Skill**

Run the official `init_skill.py shared-project-context --path skills` with interface values, replace every generated placeholder using `apply_patch`, and keep only the concise workflow plus `agents/openai.yaml`.

- [ ] **Step 4: Verify GREEN and validate**

Run: `node --test test/manage-taskboard-skill.test.mjs`

Run: `python3 <skill-creator>/scripts/quick_validate.py skills/shared-project-context`

Expected: assertions and validation pass with no placeholder text.

### Task 6: User and Operations Documentation

**Files:**
- Create: `docs/shared-project-context.md`
- Modify: `README.md`
- Modify: `docs/cloud-collaboration.md`

- [ ] **Step 1: Document architecture and security**

Describe official plugin -> Skills/MCP -> loopback companion -> SQLite or Worker/D1, all tool-to-HTTP mappings, structured errors, project mapping, no fallback, no secrets/paths, Basic Auth limits, and `sourceThreadId` as provenance only.

- [ ] **Step 2: Document installation and two-device operation**

Give executable steps for `npm ci`, `npm link`, companion startup, local marketplace registration/plugin install, artifact validation, cloud login, per-device project mapping, restart/new thread, and troubleshooting by actual error code.

- [ ] **Step 3: Separate official plugin from optional CDP UI**

Make the plugin the primary Codex agent integration. Retitle existing injection instructions as optional UI compatibility and explicitly state that they do not constitute the official plugin.

- [ ] **Step 4: Check documentation references**

Run: `rg -n "official plugin|CDP|REMOTE_UNAVAILABLE|VERSION_CONFLICT|sourceThreadId|npm link" README.md docs/shared-project-context.md docs/cloud-collaboration.md`

Expected: each installation, boundary, and troubleshooting concept is present.

### Task 7: Final Verification and Handoff

**Files:**
- Review all changed files

- [ ] **Step 1: Run focused checks**

Run: `node --test test/mcp-context.test.mjs test/plugin-structure.test.mjs test/manage-taskboard-skill.test.mjs test/project-context.test.mjs test/cloud-project-context.test.mjs test/cloud-companion.test.mjs`

Expected: all new/focused tests pass except only the recorded pre-existing cloud `/api/meta` assertion if still present.

- [ ] **Step 2: Run plugin and build checks**

Run: `npm run plugin:validate`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all pass; build may retain the existing chunk-size warning.

- [ ] **Step 3: Compare the full suite to baseline**

Run: `npm run check`

Expected: no failures beyond the recorded baseline of 18 unrelated failures; all new tests pass.

- [ ] **Step 4: Review for leaks and accidental scope**

Run: `git diff --check`

Run: `git status --short`

Inspect the diff for secrets, absolute paths, internal Codex state access, database imports from `mcp/`, and unrelated changes.

- [ ] **Step 5: Commit, push, and open the linked PR**

Use an `ASH-48` title without `Closes`/`Fixes`/`Resolves`. Include actual verification output and the upstream error-code conflict in the PR description.

- [ ] **Step 6: Deliver through Multica**

Post exactly one ASH-48 comment with files, API/tool contract, migration/rollback, verification, operations impact, risks, PR URL, and next owner; then move ASH-48 to `in_review`.
