const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_SUPPORTED_VERSIONS = new Set([
  "2025-03-26",
  "2025-06-18",
  MCP_PROTOCOL_VERSION,
  "2026-07-28",
]);
const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
const TOOLS = [
  {
    name: "taskboard_get_dashboard_url",
    description: "Get the HTTPS URL for opening the Taskboard visual panel in a separate browser page.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "taskboard_list_projects",
    description: "List Taskboard projects and their identifiers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "taskboard_list_issues",
    description: "List Taskboard issues. Use an exact project identifier when filtering by project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Exact Taskboard project ID." },
        status: { type: "string", enum: TASK_STATUSES },
        archived: { type: "string", enum: ["true", "false", "all"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_get_issue",
    description: "Get one Taskboard issue by its exact identifier or ID.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_list_comments",
    description: "List comments for one Taskboard issue. The response includes a nextCursor for incremental reads.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        after: { type: "string", description: "Optional cursor from an earlier response." },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_move_issue",
    description: "Move a Taskboard issue to a new status. Read the issue first and pass its current version to avoid overwriting concurrent changes.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        version: { type: "integer", minimum: 1 },
      },
      required: ["issueId", "status", "version"],
      additionalProperties: false,
    },
  },
  {
    name: "taskboard_add_comment",
    description: "Add a comment to a Taskboard issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        body: { type: "string", description: "Comment text." },
      },
      required: ["issueId", "body"],
      additionalProperties: false,
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const MCP_JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: MCP_JSON_HEADERS,
  });
}
function rpcResult(id, result) {
  return response(200, { jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, data) {
  return response(200, {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}
function containsMediaType(header, mediaType) {
  return (header ?? "")
    .split(",")
    .some((value) => value.trim().split(";", 1)[0].trim().toLowerCase() === mediaType);
}
function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (origin === new URL(request.url).origin) return true;
  const configuredOrigins = String(env.TASKBOARD_MANUS_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configuredOrigins.includes(origin);
}
function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}
function toolError(error) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    }],
  };
}
function taskPath(issueId, suffix = "") {
  if (typeof issueId !== "string" || issueId.trim() === "" || issueId.length > 128) {
    throw new Error("issueId must be a non-empty Taskboard issue identifier");
  }
  return `/api/tasks/${encodeURIComponent(issueId)}${suffix}`;
}
async function invokeTool(name, args, invokeApi, onMutation, dashboardUrl) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  switch (name) {
    case "taskboard_get_dashboard_url":
      return { url: dashboardUrl, opensSeparately: true };
    case "taskboard_list_projects":
      return invokeApi("GET", "/api/projects");
    case "taskboard_list_issues": {
      const query = new URLSearchParams();
      for (const [key, parameter] of [["projectId", "projectId"], ["status", "status"], ["archived", "archived"]]) {
        if (args[key] !== undefined) query.set(parameter, String(args[key]));
      }
      return invokeApi("GET", `/api/tasks${query.size ? `?${query}` : ""}`);
    }
    case "taskboard_get_issue":
      return invokeApi("GET", taskPath(args.issueId));
    case "taskboard_list_comments": {
      const query = new URLSearchParams();
      if (args.after !== undefined) query.set("after", String(args.after));
      return invokeApi(
        "GET",
        `${taskPath(args.issueId, "/comments")}${query.size ? `?${query}` : ""}`,
      );
    }
    case "taskboard_move_issue": {
      if (!Number.isSafeInteger(args.version) || args.version < 1) {
        throw new Error("version must be the current positive issue version");
      }
      if (!TASK_STATUSES.includes(args.status)) {
        throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
      }
      const result = await invokeApi("POST", taskPath(args.issueId, "/move"), {
        version: args.version,
        status: args.status,
      });
      await onMutation();
      return result;
    }
    case "taskboard_add_comment": {
      if (typeof args.body !== "string") throw new Error("body must be a string");
      const result = await invokeApi("POST", taskPath(args.issueId, "/comments"), {
        body: args.body,
      });
      await onMutation();
      return result;
    }
    default:
      throw new Error(`Unknown Taskboard tool '${name}'`);
  }
}

export async function handleManusMcpRequest(request, env, {
  invokeApi,
  onMutation = async () => {},
} = {}) {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  if (!originAllowed(request, env)) {
    return response(403, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Origin is not allowed for the Taskboard MCP endpoint" },
    });
  }
  if (!containsMediaType(request.headers.get("content-type"), "application/json")) {
    return response(415, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Content-Type must be application/json" },
    });
  }
  const accept = request.headers.get("accept");
  if (!containsMediaType(accept, "application/json") || !containsMediaType(accept, "text/event-stream")) {
    return response(406, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Accept must include application/json and text/event-stream" },
    });
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && !MCP_SUPPORTED_VERSIONS.has(headerVersion)) {
    return response(400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32602,
        message: "Unsupported MCP protocol version",
        data: { supported: [...MCP_SUPPORTED_VERSIONS] },
      },
    });
  }
  let message;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1024 * 1024) {
      return response(413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP request body cannot exceed 1 MiB" },
      });
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
      return response(413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP request body cannot exceed 1 MiB" },
      });
    }
    message = JSON.parse(text);
  } catch {
    return response(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    });
  }
  if (
    message === null
    || typeof message !== "object"
    || message.jsonrpc !== "2.0"
    || typeof message.method !== "string"
  ) {
    return response(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    });
  }
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
    }
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const id = message.id;
  if (message.method === "initialize") {
    const requestedVersion = message.params?.protocolVersion;
    if (!MCP_SUPPORTED_VERSIONS.has(requestedVersion)) {
      return rpcError(id, -32602, "Unsupported MCP protocol version", {
        supported: [...MCP_SUPPORTED_VERSIONS],
      });
    }
    return rpcResult(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codex-taskboard-manus", version: "1.0.0" },
      instructions: "Use Taskboard tools with exact project and issue identifiers. Read the current issue version before moving it. Call taskboard_get_dashboard_url to provide the HTTPS visual panel entry; it opens separately and is not embedded in the Manus chat.",
    });
  }
  const metadataVersion = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (headerVersion && metadataVersion && headerVersion !== metadataVersion) {
    return rpcError(id, -32600, "MCP-Protocol-Version header does not match request metadata");
  }
  if (message.method === "ping") return rpcResult(id, {});
  if (message.method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return rpcError(id, -32602, `Unknown tool '${String(name)}'`);
    try {
      const value = await invokeTool(
        name,
        message.params?.arguments ?? {},
        invokeApi,
        onMutation,
        new URL("/", request.url).href,
      );
      return rpcResult(id, toolResult(value));
    } catch (error) {
      return rpcResult(id, toolError(error));
    }
  }
  return rpcError(id, -32601, `Method not found: ${message.method}`);
}

export function manusMcpActor() {
  return {
    type: "agent",
    id: "taskboard-manus-agent",
    name: "Manus Agent",
    avatarUrl: null,
    username: "Manus Agent",
  };
}
