# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.

# Taskboard Delivery Workflow

Use this workflow when the user asks to process Taskboard work.

## 1. Read and claim work

- Read only the Taskboard states that the user asked to process. For the normal development flow, claim `todo` items and continue unfinished `in_progress` items.
- Never assign `backlog` items. Leave an item unclaimed when its description or latest comment explicitly requires waiting.
- Read the full issue description, attachments, and all comments before routing or changing it.
- GitHub Issue and PR synchronization is not a default step. Read or synchronize GitHub Issue/PR data only when the user explicitly requests it.
- Use the packaged or injected `taskctl` and the exact active Taskboard runtime. Do not fall back to a global CLI, a guessed port, or another data source.

## 2. Route for efficiency

- Do not force one issue into one conversation or one worktree.
- Group closely related issues in one conversation and worktree when they share the same feature chain and this reduces duplicate work or merge conflicts.
- Run independent work in parallel when the paths do not conflict. Queue conflict-prone work and keep it visible.
- Research, triage, replies, and other work that does not change code normally do not need a worktree.
- For code changes, start from verified current `origin/main`, create a feature branch, and use a worktree. Never implement directly on `main`.
- Keep task conversations visible and traceable. Do not pin newly created task conversations. Do not pass this no-pin rule, or restrictions on subagents, into the delegated task prompt unless the user requests it for that task.
- For every newly dispatched task conversation, explicitly use the same model and reasoning level as the coordinating conversation. Do not substitute a skill default, cheaper model, or lower reasoning level. Existing conversations do not need to be recreated when this rule is added later.
- Bind each claimed issue to the actual conversation, branch, and worktree used for it, and record the grouping decision in the issue.

## 3. Follow E3

1. **Estimate**: estimate the context, steps, overlap, and risk.
2. **Execute**: prove and implement the smallest viable real path.
3. **Expand**: read or change more only when direct verification fails.

Before editing, record the real path in the issue:

`entry point -> user or agent action -> component/API/data change -> observable result`

Make the smallest root-cause change. Do not add unrelated refactors, abstractions, state machines, compatibility layers, speculative fallbacks, guardrails, or tests. Add targeted protection or tests only when the user explicitly requests them or reports a concrete failure that requires them.

## 4. Preserve external contributions

- When an issue already has an external contributor PR, review and improve that PR before creating a replacement.
- Preserve the contributor's commits and authorship. Use a normal merge; do not squash, rebase, force-push, or rewrite the contributor's commits.
- If a PR contains a usable subset, merge that subset and put remaining work in a later PR.
- Close and replace an external PR only when it is abandoned, has the wrong direction, or cannot be maintained. Explain the reason first.
- When there is only an issue and no corresponding PR, create a new branch, worktree, and PR.
- Before final cleanup, verify that merged external authors are retained in repository history and Contributors.

## 5. Implement, verify, and report

- Keep the issue `in_progress` during implementation.
- Verify the direct user path. For changes on a UI surface, use the real browser/App surface. Capture visual evidence when the result has visual impact; this evidence supports review and does not by itself require a separate user UI confirmation.
- Report changed files, commit, exact head SHA, direct verification, PR, CI state, review complexity decision, review result, and remaining limitations in the issue.
- Show ongoing status in the Taskboard opened through the injected Codex App.
- Execution conversations do not merge, release, mark `done`, or claim user acceptance.

## 6. Review by risk

- Each dispatched execution conversation decides the review complexity for its own implementation after direct-path verification. The coordinating conversation does not make this complexity decision or perform the code review.
- For lower-complexity work, the dispatched execution Agent performs the code review. It checks implementation correctness, the requested path, scope, and real bugs without sending the PR to ChatGPT web Pro.
- For complex or risky work, the corresponding dispatched execution conversation opens ChatGPT web Pro itself and submits the PR URL and exact head SHA for review. It asks Pro to review only implementation correctness and real bugs.
- Development and review must avoid over-design and over-defensive recommendations. Do not request or add hypothetical guardrails, unrelated refactors, compatibility layers, style preferences, or scope expansion.
- Independent dispatched conversations run their required reviews in parallel. Do not serialize independent Agent or Pro reviews through the coordinating conversation.
- For Pro review, wait for the complete answer. Do not use an instant-answer result. Check at approximately five-minute intervals when necessary; a complete review can take more than 30 minutes.
- Fix actionable blockers in the same PR. The dispatched execution conversation decides whether the changed complexity warrants another Pro review; trivial targeted follow-up edits can use its normal Agent review.
- Before accepting a handoff, the coordinating conversation checks that the execution evidence, scope, CI state, complexity decision, and required review result are present. It does not repeat the code review.
- Decide the UI confirmation gate from the actual visual impact and risk. Do not trigger it mechanically because code is in a UI component or changes a UI file.
- Logic-only changes on a UI surface do not need separate user UI confirmation when they do not cause a meaningful visual change. This includes interaction logic, data behavior, toggle behavior, popover close conditions, and copy-and-paste behavior.
- Small, low-risk, and visually unambiguous changes can skip user UI confirmation after the coordinator checks the real path and visual evidence. Examples include a local font-size, spacing, alignment, or color adjustment.
- Require user UI confirmation before merge when the change adds UI, meaningfully changes layout, information hierarchy, or the presentation of a core interaction, has multiple reasonable visual choices, or the user explicitly asks to confirm the style.
- User UI confirmation is a final acceptance gate, not an intermediate development checkpoint. For work that requires it, ask only after the full function is complete, direct verification passes, and any complexity-based Pro review passes. Never ask the user to confirm a partially implemented UI.
- After Pro approval, visual-only adjustments made from the user's final UI feedback do not require another Pro review. The coordinator checks that the delta is limited to the requested visual change, reruns the real path, and can then proceed to merge. If the adjustment changes functional logic or introduces new complex risk, reassess whether code review or Pro review is required.
- The dispatched execution conversation closes its temporary review browser tabs after review finishes.

## 7. Acceptance and issue status

- Reviewer approval means ready for user inspection, not user acceptance.
- When work meets the UI confirmation gate, put the complete reviewed function into the Taskboard-launched Codex App and ask the user to confirm the final visual style only after implementation and any required Pro review are complete.
- Do not merge work that meets the UI confirmation gate until the user confirms its style. After visual-only feedback is applied and directly verified, the change can proceed without repeating Pro review.
- UI-surface work that does not meet the confirmation gate can proceed after the coordinator verifies the real path, visual impact, scope, and required review without a separate user UI pause.
- After implementation and required review pass, move the issue to `in_review`.
- Never move an issue to `done` unless the user explicitly accepts it or asks for completion.
- If the user explicitly authorizes finishing and releasing the whole batch without another pause, that instruction authorizes the remaining review, merge, and release steps, but still does not authorize marking issues `done`.

## 8. Merge and clean up

- Merge only reviewed and authorized PRs into `main`. Do not merge unrelated open PRs.
- Confirm the accepted commit is present on remote `main`.
- After merge, remove the merged worktree, local feature branch, remote feature branch, and disposable files from that task.
- Preserve all task conversations for traceability. Do not archive or delete them.
- Do not touch unrelated dirty worktrees, branches, files, or active sessions.

## 9. Release

- Release only when the user requests it or explicitly includes release in the task.
- Merge all included product PRs first. Use a minimal version PR for the required version fields; do not alter release infrastructure without a separate requirement.
- Use a short tag such as `v1.0.7`. Release notes contain product changes only.
- Keep the DMG as the first release asset.
- Record live build, signing, notarization, upload, and publication progress in the Taskboard.
- Verify the tag target, release target, workflow result, asset order, and updater metadata.
- Do not overwrite the App in `/Applications`; leave the installed version available for update-check verification.

## 10. Batch completion

A requested batch is complete only when:

- all eligible `todo` items are handled;
- no item is unexpectedly left in `in_progress`;
- explicit waiting items are reported;
- included PRs are reviewed and merged into `main`;
- changed issues are in `in_review`, not `done`;
- the injected Codex App shows the latest status;
- merged worktrees and feature branches are cleaned up;
- task conversations remain available; and
- any requested release is published and verified.

# Setup

This repository follows standard agent skill setup:

## Agent Skills

Skills are loaded from `~/.agents/skills/` (base platform) or IDE-specific locations like `~/.claude/skills/`, `~/.devin/skills/`, `~/.opencode/skills/`, etc.

### Skill installation

Copy or symlink `skills/manage-taskboard` to the appropriate IDE skill directory:

```bash
# Claude Code
ln -s /path/to/dashi-taskboard/skills/manage-taskboard ~/.claude/skills/manage-taskboard

# OpenCode
ln -s /path/to/dashi-taskboard/skills/manage-taskboard ~/.opencode/skills/manage-taskboard

# Devin
ln -s /path/to/dashi-taskboard/skills/manage-taskboard ~/.devin/skills/manage-taskboard
```

## MCP registration

The repository includes an MCP server in `mcp/` that provides Taskboard access via Model Context Protocol. Install it using the MCP registry or manually in your IDE configuration.

### Configuration examples

**Claude Desktop:**
```json
{
  "mcpServers": {
    "codex-taskboard": {
      "command": "node",
      "args": ["/path/to/dashi-taskboard/mcp/index.mjs"],
      "cwd": "/path/to/dashi-taskboard/mcp"
    }
  }
}
```

**OpenCode:**
```json
{
  "mcp": {
    "servers": {
      "codex-taskboard": {
        "command": "npx",
        "args": ["mcp", "--server", "index.mjs"],
        "cwd": "/path/to/dashi-taskboard/mcp"
      }
    }
  }
}
```

**Cursor:**
```json
{
  "mcpServers": {
    "codex-taskboard": {
      "command": "node",
      "args": ["/path/to/dashi-taskboard/mcp/index.mjs"],
      "cwd": "/path/to/dashi-taskboard/mcp"
    }
  }
}
```

## Runtime setup

### Local development

1. Clone the repository:
   ```bash
   git clone https://github.com/afonsoft/dashi-taskboard
   cd dashi-taskboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build and start the service:
   ```bash
   npm run build
   npm start
   ```

4. Access the Taskboard UI at <http://127.0.0.1:47823>

5. Use the CLI from the project root or install it globally:
   ```bash
   npm link
   taskctl project create --id my-project --name "My Project" --workspace-path /absolute/path/to/repository
   ```

### Integration with AI agents

#### Claude Code

Claude Code automatically uses the Taskboard skill if it's installed in `~/.claude/skills/manage-taskboard`. The skill will claim issues from `todo` status and work in the bound issue's branch/worktree.

For manual thread attribution, set the environment variable:
```bash
export TASKBOARD_THREAD_ID=<conversation-id>
```

#### OpenCode

OpenCode follows the same pattern. Install the skill in `~/.opencode/skills/manage-taskboard` and set `TASKBOARD_THREAD_ID` in your agent configuration.

#### Cursor

Cursor reads MCP configurations from `~/.cursor/mcp.json`. The MCP server provides unified access to Taskboard operations across all AI platforms.

#### Gemini

Gemini CLI reads MCP configurations from `~/.gemini/mcp.json` or supports direct MCP server connections.

#### Devin

Devin reads skills from `~/.devin/skills/` and follows the same issue processing workflow.

## Cloud collaboration

Set up cloud mode for shared access:

```bash
taskctl cloud login --url https://your-cloud-domain.com --actor-name "Team Member"
```

Configure the project mapping for local workspace:

```bash
taskctl project map my-project --workspace-path /absolute/path/to/repository
```

See `server/cloud-config.mjs` for authentication details and `wrangler.jsonc` for Cloudflare deployment configuration.
