// Core implementation of MCP server

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";

import { spawnTaskctl } from "./taskctl-runner.js";

// Tool schemas
toolSchemas = {
  list_projects: {
    description: "List all projects",
    parameters: z.object({}).strict(),
  },
  get_project: {
    description: "Get project by ID",
    parameters: z.object({
      id: z.string().describe("Project ID"),
    }).strict(),
  },
  create_project: {
    description: "Create a new project",
    parameters: z.object({
      name: z.string().describe("Project name"),
      id: z.string().optional().describe("Project ID (auto-generated if not provided)"),
      workspacePath: z.string().optional().describe("Local workspace path"),
    }).strict(),
  },
  list_issues: {
    description: "List issues in a project",
    parameters: z.object({
      project: z.string().describe("Project ID"),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]).optional(),
      archived: z.enum(["true", "false", "all"]).optional(),
    }).strict(),
  },
  get_issue: {
    description: "Get issue by ID",
    parameters: z.object({
      id: z.string().describe("Issue ID"),
    }).strict(),
  },
  create_issue: {
    description: "Create a new issue",
    parameters: z.object({
      project: z.string().describe("Project ID"),
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description"),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]).optional().describe("Issue status (defaults to 'backlog')"),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("Issue priority"),
      labels: z.string().optional().describe("Comma-separated labels"),
      threadId: z.string().optional().describe("Codex conversation ID (defaults to TASKBOARD_THREAD_ID)"),
      gitBranch: z.string().optional().describe("Git branch for development context"),
      worktreePath: z.string().optional().describe("Worktree path for development context"),
      worktreeBranch: z.string().optional().describe("Worktree branch for development context"),
    }).strict(),
  },
  update_issue: {
    description: "Update an issue",
    parameters: z.object({
      id: z.string().describe("Issue ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]).optional().describe("New status"),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("New priority"),
      labels: z.string().optional().describe("New comma-separated labels"),
      threadId: z.string().optional().describe("Codex conversation ID"),
    }).strict(),
  },
  move_issue: {
    description: "Move issue (change status)",
    parameters: z.object({
      id: z.string().describe("Issue ID"),
      status: z.enum(["todo", "in_progress", "in_review", "blocked", "done", "canceled"]).describe("New status"),
      threadId: z.string().optional().describe("Codex conversation ID (defaults to TASKBOARD_THREAD_ID)"),
    }).strict(),
  },
  archive_issue: {
    description: "Archive or restore an issue",
    parameters: z.object({
      id: z.string().describe("Issue ID"),
      action: z.enum(["archive", "restore"]).describe("Action to perform"),
      threadId: z.string().optional().describe("Codex conversation ID (defaults to TASKBOARD_THREAD_ID)"),
    }).strict(),
  },
  add_comment: {
    description: "Add a comment to an issue",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
      body: z.string().describe("Comment content"),
      threadId: z.string().optional().describe("Codex conversation ID (defaults to TASKBOARD_THREAD_ID)"),
    }).strict(),
  },
  upload_attachment: {
    description: "Upload an attachment to a task or comment",
    parameters: z.object({
      target: z.enum(["task", "comment"]).describe("Target type"),
      targetId: z.string().describe("Task or comment ID"),
      filePath: z.string().describe("Local file path"),
      contentType: z.string().optional().describe("MIME type"),
      kind: z.enum(["inline", "attachment"]).optional().describe("Attachment kind"),
    }).strict(),
  },
};

async function main() {
  const server = new Server(
    {
      name: "codex-taskboard-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register all tools
  Object.entries(toolSchemas).forEach(([name, schema]) => {
    server.setRequestHandler("tools/call", async (request) => {
      if (request.params.name === name) {
        const { arguments: params } = request.params;
        const validatedParams = schema.parameters.parse(params);
        return await executeTool(name, validatedParams);
      }

      return null;
    });

    server.setRequestHandler("tools/list", async () => {
      return {
        tools: [
          {
            name,
            description: schema.description,
            inputSchema: schema.parameters.shape,
          },
        ],
      };
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Codex Taskboard MCP server running on stdio");
}

async function executeTool(name, params) {
  const threadId = params.threadId || process.env.TASKBOARD_THREAD_ID || process.env.CODEX_THREAD_ID || "default-thread-id";

  try {
    switch (name) {
      case "list_projects":
        return await spawnTaskctl(["project", "list", "--json"], { threadId });
      case "get_project":
        return await spawnTaskctl(["project", "get", params.id, "--json"], { threadId });
      case "create_project":
        const createArgs = ["project", "create", "--name", params.name, "--json"];
        if (params.id) createArgs.push("--id", params.id);
        if (params.workspacePath) createArgs.push("--workspace-path", params.workspacePath);
        return await spawnTaskctl(createArgs, { threadId });
      case "list_issues":
        const listArgs = ["issue", "list", "--project", params.project, "--json"];
        if (params.status) listArgs.push("--status", params.status);
        if (params.archived) listArgs.push("--archived", params.archived);
        return await spawnTaskctl(listArgs, { threadId });
      case "get_issue":
        return await spawnTaskctl(["issue", "get", params.id, "--json"], { threadId });
      case "create_issue":
        const issueArgs = [
          "issue", "create",
          "--project", params.project,
          "--title", params.title,
          "--json"
        ];
        if (params.description) {
          issueArgs.push("--description", params.description);
        }
        if (params.status) issueArgs.push("--status", params.status);
        if (params.priority) issueArgs.push("--priority", params.priority);
        if (params.labels) issueArgs.push("--labels", params.labels);
        if (params.threadId) issueArgs.push("--thread-id", params.threadId);
        if (params.gitBranch) issueArgs.push("--git-branch", params.gitBranch);
        if (params.worktreePath) issueArgs.push("--worktree-path", params.worktreePath);
        if (params.worktreeBranch) issueArgs.push("--worktree-branch", params.worktreeBranch);
        return await spawnTaskctl(issueArgs, { threadId });
      case "update_issue":
        const updateArgs = ["issue", "update", params.id, "--json"];
        if (params.title) updateArgs.push("--title", params.title);
        if (params.description) updateArgs.push("--description", params.description);
        if (params.status) updateArgs.push("--status", params.status);
        if (params.priority) updateArgs.push("--priority", params.priority);
        if (params.labels) updateArgs.push("--labels", params.labels);
        if (params.threadId) updateArgs.push("--thread-id", params.threadId);
        return await spawnTaskctl(updateArgs, { threadId });
      case "move_issue":
        const moveArgs = ["issue", "move", params.id, "--status", params.status, "--json"];
        if (params.threadId) moveArgs.push("--thread-id", params.threadId);
        return await spawnTaskctl(moveArgs, { threadId });
      case "archive_issue":
        return await spawnTaskctl(
          ["issue", params.action, params.id, "--json"],
          { threadId }
        );
      case "add_comment":
        return await spawnTaskctl(
          ["comment", "add", params.issueId, "--body", params.body, "--json"],
          { threadId }
        );
      case "upload_attachment":
        const attachmentArgs = [
          "attachment", "upload",
          params.target === "task" ? "--task" : "--comment",
          params.targetId,
          "--file", params.filePath,
          "--json"
        ];
        if (params.contentType) attachmentArgs.push("--content-type", params.contentType);
        if (params.kind) attachmentArgs.push("--kind", params.kind);
        return await spawnTaskctl(attachmentArgs, { threadId });

      default:
        throw new Error(`Tool ${name} not implemented`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

function getEnv(threadId) {
  const env = { ...process.env };
  env.TASKBOARD_THREAD_ID = threadId;
  return env;
}

async function spawnTaskctl(args, { threadId }) {
  const { spawn } = await import("node:child_process");

  const taskctlPath = require.resolve("./cli/taskctl.mjs");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [taskctlPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: getEnv(threadId),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to spawn taskctl: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        try {
          const errorJson = JSON.parse(stderr);
          reject(new Error(errorJson.error.message));
        } catch {
          reject(new Error(`taskctl exited with code ${code}: ${stderr}`));
        }
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        reject(new Error(`Invalid JSON from taskctl: ${stdout}`));
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { main };