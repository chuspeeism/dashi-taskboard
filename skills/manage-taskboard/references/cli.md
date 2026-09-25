# taskctl CLI

`taskctl` emits JSON for normal commands. Add `--json` when making the output contract explicit. Built-in help is the only successful stdout exception: it writes plain text, exits with code `0`, and does not request the Taskboard service.

Use built-in help for the current command tree or a specific supported level:

```bash
taskctl --help
taskctl issue --help
taskctl comment list --help
taskctl comment add --help
taskctl comment update --help
```

## Terminology: local companion

**Companion** here is a product term for the **device-local loopback HTTP service** that `taskctl` talks to in cloud mode. It applies Basic Authentication, stores device-only project path mappings, and keeps Codex/Git/Skill/MCP capabilities on the machine. It is not a chat persona and not a separate public “companion product API”.

| English | Prefer in Chinese | Do not use |
| --- | --- | --- |
| local companion / loopback companion | 本地 companion、本地配套服务、环回代理 | 伴侣、伴侣 API |
| Taskboard HTTP API (`/api/tasks`, `/api/comments`, `/api/attachments`, …) | Taskboard HTTP API、本地服务 API、附件上传接口 | companion API、伴侣 API |

Env and files that refer to this service: `CODEX_TASKBOARD_COMPANION_URL`, `CODEX_TASKBOARD_URL` (loopback origin), `.data/cloud-companion.json`. Error code `LOCAL_COMPANION_REQUIRED` means a capability needs that **local loopback service**, not a different API surface.

## Context and projects

```bash
taskctl context current [--cwd PATH] [--json]
taskctl project list [--json]
taskctl project create --name NAME [--id ID] [--workspace-path PATH] [--json]
taskctl project map PROJECT_ID --workspace-path PATH [--json]
taskctl project readme get [PROJECT_ID] [--json]
taskctl project readme set [PROJECT_ID] (--content TEXT | --file PATH) [--if-version N] [--json]
```

Use `--workspace-path` to associate a project with a local repository. `context current` chooses the most specific project whose workspace contains the current directory, then falls back to the `local` project.

Use `project readme get` and `project readme set` to read and update the project's single root README document. Detailed multi-page documentation belongs in the project's local `docs/` folder.

Set `CODEX_TASKBOARD_URL` to override the default local API origin, `http://127.0.0.1:47823`.

For a shared cloud board, keep `taskctl` pointed at the **loopback companion** (local loopback service; see Terminology above) and configure the upstream HTTPS origin through it:

```bash
taskctl cloud login --url HTTPS_ORIGIN --actor-name NAME [--json]
taskctl cloud status [--json]
taskctl project list [--json]
taskctl project map PROJECT_ID --workspace-path /absolute/local/path [--json]
taskctl cloud logout [--json]
```

`cloud login` reads the shared password from a private `Shared key:` prompt. The actor name is the display attribution sent through Basic Authentication. The local companion stores its configuration with mode `0600`; project mappings stay on the current device and can differ between collaborators. In cloud mode, failed upstream writes fail rather than falling back to or double-writing the local SQLite database.

Every issue or comment write requires conversation attribution. For Codex, `taskctl` reads `CODEX_THREAD_ID` or accepts explicit `--thread-id ID` (which takes precedence). For Claude Code, Pi, Google Antigravity CLI (AGY), and xAI Grok CLI, pass **both** `--agent-platform claude|pi|agy|grok` and `--session-id ID`. External attribution ignores `CODEX_THREAD_ID` and cannot be combined with `--thread-id`. No external session environment variables are inferred. Read commands do not require a conversation ID.

Except for built-in help, every successful command writes one JSON object with `schemaVersion` to stdout. The current schema version is `2`. Errors write one JSON object to stderr. Exit codes are `0` for success, `2` for invalid input, `3` when the service is unavailable, `4` for API or response errors, and `5` for conflicts.

## External tool/session traceability

Use the original tool and its full session ID. For Pi, `--session-id` also accepts the full session-file path; prefer an absolute path when copying between working directories. This is stored metadata plus a copy action, not tool launch, authentication, an Agent runtime, or native Codex ownership.

```bash
taskctl issue create --project local --title "Session traceability" \
  --agent-platform claude --session-id '<claude-session-id>' --json

taskctl issue update ISSUE_ID --if-version N \
  --agent-platform pi --session-id '/absolute/session path/session.jsonl' --json

taskctl comment add ISSUE_ID --body 'Implementation notes' \
  --agent-platform agy --session-id '<conversation-id>' --json

taskctl comment update COMMENT_ID --body 'Updated implementation notes' --if-version N \
  --agent-platform grok --session-id '<grok-session-id>' --json
```

The same two options are accepted by `issue move`, `issue archive`, `issue restore`, `issue relation add|remove`, and `comment delete`. A metadata-only `issue update` is supported. Read back with `issue get` and `comment list` (omit `--after` for a full reread). Deleting a comment deletes its metadata; it does not attach that session to another record.

Task/comment JSON exposes `agentSession: { "platform": "pi", "sessionId": "..." }` or `null`. Local SQLite and cloud D1 both store it in nullable `agent_session` TEXT on `tasks` and `comments`. The cloud deployment must apply `0012_agent_sessions.sql` before serving the new worker. Omitting `agentSession` preserves the saved value; supplying a new object replaces the record's external session metadata; HTTP `agentSession: null` clears only that metadata. This field is not an append-only session history. Task `conversationRefs` includes separate external references from the task and its comments.

External attribution never writes to Codex `threadId` or the native five-field `threadBinding`. Existing native bindings remain intact. `issue move` and `comment add` still accept explicit, independent Codex `--binding-*` options; they must describe a real native Codex session, not the external controller. When both metadata and a native binding are present, the UI shows separate entries rather than relabeling a Codex session. Existing author/assignee identities are unchanged; the original tool is identified by the session metadata badge, not inferred from an actor name.

The detail view shows the original tool, ID/path, and copy button for both tasks and comments. The card conversation action copies for external sessions; it never sends them to `codex://` or the embedded Codex host. Copied commands use these fixed official entry points:

| Tool | Command |
| --- | --- |
| Claude Code | `claude --resume <session-id>` |
| Pi coding agent | `pi --session <path-or-id>` |
| Google Antigravity CLI (AGY) | `agy --conversation <conversation-id>` |
| xAI Grok CLI | `grok --resume <id>` |
| Existing Codex | `codex resume <thread-id>` |

The full original value is preserved without trimming or Codex prefix normalization. IDs are limited to 256 characters, or 4096 for Pi paths/IDs. Empty/blank values, control characters, and a leading option dash are rejected. Copying quotes shell metacharacters and apostrophes as **one POSIX-shell argument** for sh/bash/zsh; this is not a PowerShell/cmd quoting mode. Run in the original tool's environment with the original session files, workspace, and credentials available. An ID or a syntactically correct command alone is not evidence of a restored session.

Official syntax evidence (checked 2026-09-17): [Claude sessions](https://code.claude.com/docs/en/sessions), [Pi session management](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [AGY resume](https://antigravity.google/docs/cli/commands/resume), [AGY headless](https://antigravity.google/docs/cli/headless/), [Grok CLI reference](https://docs.x.ai/build/cli/reference). Do not substitute `pi resume`, `agy resume`, or `grok resume`. Actual client continuation must be verified independently in an available real client; a clipboard/string check does not verify continuation.

## Read issues

```bash
taskctl issue list [--project PROJECT_ID] [--status STATUS] [--archived true|false|all] [--json]
taskctl issue get ID [--json]
taskctl issue tree ID --direction descendants|ancestors --depth N [--json]
```

`issue tree` is a bounded structural read. `--depth 1` returns only direct children or the direct parent; larger values include that many levels, up to 25. The response is flat and deterministic: every node carries `id`, traversal `parentId`, `depth`, and `path` (usable as a breadcrumb), plus a small task summary. It never calculates status rollups or changes issues.

## Create issues

```bash
taskctl issue create \
  --project PROJECT_ID \
  --title TITLE \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--json]
```

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, and `canceled`. Priorities are `none`, `urgent`, `high`, `medium`, and `low`.

Issues created through `taskctl` are assigned to Codex Agent by default. Other CLI writes preserve the existing assignee.

## Update issues

Read the issue immediately before a write and pass its `version` with `--if-version`.

```bash
taskctl issue update ID \
  [--project PROJECT_ID] \
  [--title TITLE] \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--if-version N] \
  [--json]

taskctl issue move ID --status STATUS \
  [--thread-id ID] \
  [--binding-thread-id ID \
    [--binding-codex-project-id PROJECT_ID \
     --binding-codex-project-kind local|remote \
     --binding-codex-host-id HOST_ID \
     --binding-workspace-path PATH] \
   | --clear-binding-thread] \
  [--if-version N] [--json]
taskctl issue archive ID [--thread-id ID] [--if-version N] [--json]
taskctl issue restore ID [--thread-id ID] [--if-version N] [--json]
```

Use `issue move` to set `in_progress` before implementation and `in_review` after implementation and self-verification. Codex must not move work directly from `in_progress` to `done`; use `done` only after the user explicitly confirms acceptance or explicitly asks to mark the issue complete. Use `blocked` when work cannot continue and `canceled` when it will not continue. On a version conflict, fetch the issue again and reconcile before retrying.

`--thread-id` records the conversation performing the mutation; it does not create a complete task binding. `--binding-thread-id` can stand alone to preserve a legacy local binding. If any binding identity option is present, all four identity options are required. `--clear-binding-thread` conflicts with every `--binding-*` option. A conversation that claims or continues an issue must pass all five `--binding-*` options together. Reuse an existing complete binding exactly. For an unbound local issue launched with injected Taskboard context, use the current conversation id, injected project id and workspace path, `local` project kind, and `local` host id. Never leave an active issue with only a legacy local `threadId`. Use `--clear-binding-thread` only when the workflow explicitly requires an unbound issue.

Use either `--git-branch` or `--worktree-path`/`--worktree-branch`; an issue has only one development context. Issue JSON stores it as `developmentContext`, either `{ "type": "branch", "branch": "..." }` or `{ "type": "worktree", "path": "...", "branch": "..." }`. Its singular `threadId` retains the existing native Codex meaning; external sessions are stored separately in `agentSession`. Recurrence requires a due date.

Changing only `--project` preserves the issue's existing linked conversation.

## Issue relations

Read the anchor issue immediately before adding or removing a relation and use its current version. Relation writes require Codex conversation attribution like every other issue write.

```bash
taskctl issue relation add ISSUE_ID \
  --type parent \
  --issue PARENT_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

taskctl issue relation add ISSUE_ID \
  --type blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

taskctl issue relation remove ISSUE_ID \
  --type parent|blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]
```

For `--type parent`, `ISSUE_ID` is the child and `PARENT_ISSUE_ID` is its parent. Adding another parent replaces the child's current parent atomically. To add an existing issue as a sub-issue, anchor the command on the child and pass the exact parent identifier with `--issue PARENT_ISSUE_ID`.

For `blocks`, the anchor issue blocks the related issue. For `blocked_by`, the related issue blocks the anchor. `related` is symmetric. Self-relations, duplicates, and parent cycles are rejected. For compatibility, relation writes between different projects remain rejected for now; this is a temporary boundary, not the final hierarchy contract.

## Issue comments

Use the issue id to read or append comments. Comment updates and deletes require the latest comment `version` returned by `comment list`.

```bash
taskctl comment list ISSUE_ID [--after CURSOR] [--json]
taskctl comment add ISSUE_ID (--body TEXT | --body-file FILE) [--thread-id ID] [--json]
taskctl comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID] [--json]
taskctl comment delete COMMENT_ID --if-version N [--thread-id ID] [--json]
```

Without `--after`, `comment list` returns the full list. Its response includes `nextCursor`; keep that value and pass it to the next read of the same issue to return only comments created or modified after that cursor. `--body-file` reads the UTF-8 file and passes its contents directly to the existing comment write path.

Each comment JSON object independently records the most recent conversation that created or changed that comment as `threadId`. Comment operations never change the parent issue's `threadId`.

## Attachments

Issue descriptions and comments may contain inline images at exact positions in their Markdown:

```markdown
![alt text](api/attachments/ATTACHMENT_ID/content)
```

Upload a local file to a task or a comment. Provide exactly one of `--task` or `--comment`:

```bash
taskctl attachment list (--task TASK_ID | --comment COMMENT_ID) [--after CURSOR] [--json]
taskctl attachment upload --task TASK_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
taskctl attachment upload --comment COMMENT_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
```

Without `--after`, `attachment list` returns the full list for that task or comment. Its response includes `nextCursor`; keep a separate cursor for every attachment list target and pass it to the next read to return only later attachments.

The command sends the file bytes to:

- `POST /api/tasks/:id/attachments`, or
- `POST /api/comments/:id/attachments`

with the same headers as the web UI (`Content-Type`, `X-Taskboard-Filename`, `X-Taskboard-Attachment-Kind`). If `--content-type` is omitted, the CLI guesses from the file extension and falls back to `application/octet-stream`. If `--kind` is omitted, images use `inline` and other files use `attachment`. Use `--kind attachment` for an image that must appear in the attachment list. An inline upload returns the attachment id; use that id in the task description or comment Markdown at the required position.

Download an attachment to an explicit local path:

```bash
taskctl attachment download ATTACHMENT_ID --output PATH [--json]
```

The command writes the response body as binary data and returns the absolute output path, content type, and size in its JSON result. Choose the output filename yourself; `taskctl` does not infer or append an extension.
