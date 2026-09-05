# Codex Taskboard MCP Server

This MCP server exposes Codex Taskboard operations as Tools, enabling universal AI integrations (Claude, OpenCode, Cursor, Gemini, VS Code Copilot, Devin, WorkBuddy, DeepSeek, CI) to work with Taskboard issues and projects.

## Features

- **Universal AI Integration**: Works with any AI platform that supports MCP
- **Automatic thread attribution**: Uses `TASKBOARD_THREAD_ID`, `CODEX_THREAD_ID`, or explicit `--thread-id` for conversation tracking
- **Full API coverage**: All taskctl commands as MCP tools (projects, issues, comments, attachments, cloud operations)
- **Session-aware**: Automatically handles conversation binding for proper issue claiming and status tracking

## Quick Start

### Installation

```bash
npm install
cd mcp
```

### Start the MCP server

```bash
node index.mjs
```

The server runs on standard input/output and is ready to accept MCP tool calls.

## Tools

### Project operations

- `list_projects`: List all projects
- `get_project`: Get project by ID  
- `create_project`: Create a new project

### Issue operations

- `list_issues`: List issues in a project with filtering (status, archived)
- `get_issue`: Get issue by ID
- `create_issue`: Create a new issue with full support for Git/worktree development context
- `update_issue`: Update an existing issue
- `move_issue`: Move issue (change status, claim, or review)
- `archive_issue`: Archive or restore an issue

### Comment and attachment operations

- `add_comment`: Add a comment to an issue
- `upload_attachment`: Upload an attachment to tasks or comments

### Utility operations

- `list_projects`: List all available projects

## Configuration

### Thread attribution

The MCP server automatically uses the following priority for conversation attribution:

1. Explicit `threadId` parameter passed with the tool call
2. `TASKBOARD_THREAD_ID` environment variable
3. `CODEX_THREAD_ID` environment variable
4. Default to "default-thread-id" if none are set

**Example with Claude Code:**
```bash
export TASKBOARD_THREAD_ID=claude-conversation-123
```

### Connecting to Taskboard service

The server communicates with the Taskboard service via the `taskctl` CLI. It automatically:

- Reads the Taskboard URL from the active runtime file (`.data/launcher-runtime.json`) or `CODEX_TASKBOARD_URL` environment variable
- For cloud mode, reads from the local companion service
- Handles thread attribution for all API calls

## MCP Client Configuration

### Claude Desktop

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

### OpenCode

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

### Cursor

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

## Advanced Usage

### Working with Git/worktree development context

When creating or updating issues, the MCP server supports the full development context:

- `--git-branch`: Associate issue with a specific Git branch
- `--worktree-path`: Associate with a worktree
- `--worktree-branch`: Use a specific worktree branch

**Example tool call:**
```json
{
  "name": "create_issue",
  "arguments": {
    "project": "my-project",
    "title": "Implement feature",
    "description": "Add new user dashboard",
    "gitBranch": "feature/user-dashboard",
    "threadId": "conversation-123"
  }
}
```

### Cloud collaboration

For shared Taskboard instances, the MCP server automatically uses the cloud companion endpoint when configured via `cloud login`.

## Development

### Testing tools

```bash
# Test the MCP server locally
npm test
```

### Type checking

```bash
# TypeScript type checking
npm run typecheck
```

## Troubleshooting

### "Cannot connect to Taskboard service"

1. Ensure the Taskboard service is running: `npm start`
2. Check `CODEX_TASKBOARD_URL` environment variable
3. Verify the runtime file is valid: `.data/launcher-runtime.json`

### "Thread ID required"

The server cannot find a thread identifier. Set `TASKBOARD_THREAD_ID` or `CODEX_THREAD_ID` environment variable:

```bash
export TASKBOARD_THREAD_ID=your-session-id
```

## Security

- All API calls use the same authentication as the Taskboard service
- Thread attribution ensures proper conversation isolation
- The MCP server runs with the same permissions as the Taskboard CLI

## License

Apache-2.0
