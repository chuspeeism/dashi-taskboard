---
name: manage-taskboard
description: Manage Codex Taskboard / e-taskboard work with taskctl. Use for taskboard issue IDs, status sync, comments, or taskctl cloud setup—not for unrelated product docs. Include MCP server support for universal AI integrations (Claude, OpenCode, Cursor, Gemini, VS Code Copilot, Devin, WorkBuddy, DeepSeek, CI).
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Select the CLI and active service

- Use the exact `taskctl` binary and Taskboard URL supplied by the task or injected runtime. Do not replace them with a global CLI, the default port, or another board.
- On macOS, when no binary is injected and the desktop app is installed, use `'/Applications/Codex Taskboard.app/Contents/Resources/bin/taskctl' issue get ID --json`. Keep the single quotes because the path contains a space. The packaged wrapper reads the active launcher runtime; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- If that exact command reaches a sandbox restriction on the loopback service, retry the same command with the required permission. Do not switch binaries or endpoints.
- When using AI agents (Claude, OpenCode, Cursor, Gemini, etc.), pass the agent's session identifier with `--thread-id` or set `TASKBOARD_THREAD_ID` environment variable. The default fallback is `CODEX_THREAD_ID`.

## Terminology: local companion

In this product, **companion** means the **device-local loopback HTTP service** that `taskctl` talks to in cloud mode. It applies Basic Authentication, stores device-only project path mappings, and keeps Codex/Git/Skill/MCP capabilities on the machine. It is not a chat persona and not a separate public “companion product API”.

When writing Chinese, keep the English word or use **本地 companion** / **本地配套服务** / **环回代理**. Never translate as **伴侣** or invent **伴侣 API**. Ordinary task/comment/attachment HTTP routes (`/api/tasks`, `/api/comments`, `/api/attachments`, …) are the **Taskboard HTTP API** (or local server API)—not "companion API".

## Core workflow (extends Codex rules)

1. For an existing issue, first run `issue get` and `comment list`. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status.
2. Treat `backlog` as not approved for execution. Unless the user explicitly authorizes that issue, do not claim it, move it to another status, or perform task work; its assignee alone is not authorization. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds. If it is already `in_progress`, continue only when it is bound to the current conversation. Never move an issue claimed by another conversation.
3. If the move conflicts because the `version` is stale, run `issue get` and `comment list` again. Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description and latest comments are unchanged. If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report. Never loop or take over another agent's claim.
4. For a new durable requirement, run `context current`. Treat its project as a workspace match only when `project.workspacePath` is the current directory or one of its ancestors. An unmatched `local` project is the documented fallback, not proof that the requirement belongs in the global project. If the user named a target project or the working directory identifies one, run `project list`, select that exact project by id or name, and stop to ask if the result is ambiguous. Search existing project issues before creating one in that confirmed project, then pass its explicit id to `issue create`. Update a matching issue instead of creating a duplicate. Use the fallback only when the user explicitly wants the global project. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## AI integrations

- **Claude Code**: Use `taskctl ... --thread-id <conversationId>` or set `TASKBOARD_THREAD_ID` environment variable.
- **OpenCode, Cursor, Gemini**: Set `TASKBOARD_THREAD_ID` to the session identifier. MCP server available for universal tool access.
- **Devin, WorkBuddy, DeepSeek**: Plugin available in each ecosystem; uses the same underlying `taskctl` CLI.
- **CI/CD**: Use `TASKBOARD_URL` environment variable to point to a shared board.

## MCP server

An MCP server is available in `mcp/` that exposes Taskboard operations as Tools. The MCP server automatically uses `TASKBOARD_THREAD_ID` or `CODEX_THREAD_ID` for conversation attribution.

## Non-Codex CLI usage

When working outside Codex, always pass `--thread-id <sessionId>` for operations that modify tasks or comments. For other CLI tools, you can also set the environment variable `TASKBOARD_THREAD_ID`.

## Bindings

### Codex conversation binding

Codex sets `CODEX_THREAD_ID` automatically. Other CLIs (including MCP) prioritize `TASKBOARD_THREAD_ID` over `CODEX_THREAD_ID`.

### Git/worktree binding

Use `--git-branch` or `--worktree-path`/`--worktree-branch` options when creating issues to associate development context.

### Cloud companion

Cloud mode uses the local companion loopback service with Basic Authentication. See `references/cli.md` for `cloud login`, `project map`, and related commands.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
