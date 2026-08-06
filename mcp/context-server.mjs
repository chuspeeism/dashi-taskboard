import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  CONTEXT_BODY_MAX_BYTES,
  CONTEXT_KINDS,
} from "../shared/project-context.mjs";
import {
  CompanionError,
  createCompanionClient,
  publicCompanionError,
} from "./companion-client.mjs";

const SERVER_INFO = Object.freeze({ name: "dashi-taskboard", version: "0.1.0" });
const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENTRY_FIELDS = Object.freeze([
  "id",
  "projectId",
  "kind",
  "title",
  "body",
  "tags",
  "sourceType",
  "sourceId",
  "sourceThreadId",
  "authorType",
  "authorId",
  "authorName",
  "pinned",
  "archivedAt",
  "version",
  "idempotencyKey",
  "createdAt",
  "updatedAt",
]);

const projectIdSchema = z.string().trim().min(1).max(64).regex(PROJECT_ID_PATTERN);
const entryIdSchema = z.string().trim().min(1).max(256);
const versionSchema = z.number().int().positive().safe();
const nullableStringSchema = z.string().nullable();
const tagSchema = z.string().trim().min(1).max(64);
const tagsSchema = z.array(tagSchema).max(20).refine(
  (tags) => new Set(tags).size === tags.length,
  { message: "Tags must be unique." },
);

const errorDetailsSchema = z.strictObject({
  expectedVersion: z.number().int().safe().optional(),
  actualVersion: z.number().int().safe().optional(),
});
const publicErrorSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  code: z.string(),
  category: z.string(),
  action: z.string(),
  details: errorDetailsSchema.optional(),
});
const projectSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  issueCount: z.number().int().nonnegative().optional(),
});
const entrySchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(CONTEXT_KINDS),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  sourceType: z.string(),
  sourceId: nullableStringSchema,
  sourceThreadId: nullableStringSchema,
  authorType: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  pinned: z.boolean(),
  archivedAt: nullableStringSchema,
  version: versionSchema,
  idempotencyKey: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

function outputSchema(properties) {
  return z.strictObject({
    ok: z.boolean(),
    ...Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => [name, schema.optional()]),
    ),
    error: publicErrorSchema.optional(),
  });
}

const currentProjectInputSchema = z.strictObject({});
const projectScopeShape = { projectId: projectIdSchema.optional() };
const briefInputSchema = z.strictObject(projectScopeShape);
const searchInputSchema = z.strictObject({
  ...projectScopeShape,
  query: z.string().max(256).optional(),
  kind: z.enum(CONTEXT_KINDS).optional(),
  tag: tagSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.enum(["false", "true", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(8_192).optional(),
});
const getInputSchema = z.strictObject({ id: entryIdSchema });
const publishInputSchema = z.strictObject({
  ...projectScopeShape,
  kind: z.enum(CONTEXT_KINDS),
  title: z.string().trim().min(1).max(240),
  body: z.string(),
  tags: tagsSchema.optional(),
  sourceId: z.string().trim().max(256).nullable().optional(),
  sourceThreadId: z.string().trim().max(256).nullable().optional(),
  pinned: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(1).max(256),
});
const updateInputSchema = z.strictObject({
  id: entryIdSchema,
  version: versionSchema,
  kind: z.enum(CONTEXT_KINDS).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().optional(),
  tags: tagsSchema.optional(),
  pinned: z.boolean().optional(),
}).refine(
  ({ id: _id, version: _version, ...changes }) => Object.values(changes).some(
    (value) => value !== undefined,
  ),
  { message: "At least one context field is required." },
);
const archiveInputSchema = z.strictObject({
  id: entryIdSchema,
  version: versionSchema,
});

const currentProjectOutputSchema = outputSchema({ project: projectSchema });
const briefOutputSchema = outputSchema({
  brief: z.string(),
  includedEntryIds: z.array(z.string()),
  truncated: z.boolean(),
});
const searchOutputSchema = outputSchema({
  entries: z.array(entrySchema),
  nextCursor: nullableStringSchema,
});
const entryOutputSchema = outputSchema({ entry: entrySchema });

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

function publicEntry(value) {
  const candidate = {};
  if (value && typeof value === "object") {
    for (const field of ENTRY_FIELDS) {
      if (Object.hasOwn(value, field)) candidate[field] = value[field];
    }
  }
  const parsed = entrySchema.safeParse(candidate);
  if (!parsed.success) throw invalidCompanionResponse();
  return parsed.data;
}

function invalidCompanionResponse() {
  return new CompanionError(
    502,
    "INVALID_COMPANION_RESPONSE",
    "Local taskboard companion returned an invalid response",
  );
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCompanionResponse();
  }
  return value;
}

function validateBodyBytes(body) {
  if (Buffer.byteLength(body, "utf8") > CONTEXT_BODY_MAX_BYTES) {
    throw new CompanionError(400, "INVALID_FIELD", "Context body is too large");
  }
}

function textResult(structuredContent, text, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function safeTool(handler, successText) {
  return async (args) => {
    try {
      const data = await handler(args);
      const structuredContent = { ok: true, ...data };
      return textResult(structuredContent, successText(data));
    } catch (error) {
      const safeError = publicCompanionError(error);
      return textResult(
        { ok: false, error: safeError },
        `${safeError.code}: ${safeError.action}`,
        true,
      );
    }
  };
}

async function projectIdFor(client, explicitProjectId) {
  if (explicitProjectId !== undefined) return explicitProjectId;
  return (await client.currentProject()).id;
}

function requireProject(value) {
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) throw invalidCompanionResponse();
  return parsed.data;
}

function requireBrief(value) {
  const payload = requireObject(value);
  if (
    typeof payload.brief !== "string"
    || !Array.isArray(payload.includedEntryIds)
    || payload.includedEntryIds.some((id) => typeof id !== "string")
    || typeof payload.truncated !== "boolean"
  ) {
    throw invalidCompanionResponse();
  }
  return {
    brief: payload.brief,
    includedEntryIds: payload.includedEntryIds,
    truncated: payload.truncated,
  };
}

function requireEntryPayload(value) {
  return { entry: publicEntry(requireObject(value).entry) };
}

export function createContextServer({ companionClient } = {}) {
  const client = companionClient ?? createCompanionClient();
  const server = new McpServer(SERVER_INFO);

  server.registerTool("taskboard_context_current_project", {
    title: "Current taskboard project",
    description: "Resolve the most-specific taskboard project mapped to this process working directory.",
    inputSchema: currentProjectInputSchema,
    outputSchema: currentProjectOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, safeTool(
    async () => ({ project: requireProject(await client.currentProject()) }),
    ({ project }) => `Current taskboard project: ${project.name} (${project.id}).`,
  ));

  server.registerTool("taskboard_context_brief", {
    title: "Shared project context brief",
    description: "Load the prioritized shared context brief for a taskboard project.",
    inputSchema: briefInputSchema,
    outputSchema: briefOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, safeTool(async ({ projectId }) => {
    const id = await projectIdFor(client, projectId);
    return requireBrief(await client.request(
      "GET",
      ["api", "projects", id, "context", "brief"],
    ));
  }, ({ includedEntryIds, truncated }) => (
    `Loaded ${includedEntryIds.length} shared context entries${truncated ? " (truncated)" : ""}.`
  )));

  server.registerTool("taskboard_context_search", {
    title: "Search shared project context",
    description: "Search and page through shared context entries for a taskboard project.",
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, safeTool(async ({ projectId, ...query }) => {
    const id = await projectIdFor(client, projectId);
    const payload = requireObject(await client.request(
      "GET",
      ["api", "projects", id, "context"],
      { query },
    ));
    if (!Array.isArray(payload.entries)) throw invalidCompanionResponse();
    if (payload.nextCursor !== null && typeof payload.nextCursor !== "string") {
      throw invalidCompanionResponse();
    }
    return {
      entries: payload.entries.map(publicEntry),
      nextCursor: payload.nextCursor,
    };
  }, ({ entries, nextCursor }) => (
    `Found ${entries.length} shared context ${entries.length === 1 ? "entry" : "entries"}${nextCursor ? "; more are available" : ""}.`
  )));

  server.registerTool("taskboard_context_get", {
    title: "Get shared context entry",
    description: "Get one shared context entry by identifier.",
    inputSchema: getInputSchema,
    outputSchema: entryOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, safeTool(async ({ id }) => requireEntryPayload(await client.request(
    "GET",
    ["api", "context", id],
  )), ({ entry }) => `Loaded shared context entry ${entry.id} at version ${entry.version}.`));

  server.registerTool("taskboard_context_publish", {
    title: "Publish shared project context",
    description: "Publish an agent-authored shared context entry with a stable idempotency key.",
    inputSchema: publishInputSchema,
    outputSchema: entryOutputSchema,
    annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
  }, safeTool(async ({ projectId, body, tags, pinned, ...input }) => {
    validateBodyBytes(body);
    const id = await projectIdFor(client, projectId);
    return requireEntryPayload(await client.request(
      "POST",
      ["api", "projects", id, "context"],
      {
        body: {
          ...input,
          body,
          tags: tags ?? [],
          sourceType: "agent",
          pinned: pinned ?? false,
        },
      },
    ));
  }, ({ entry }) => `Published shared context entry ${entry.id} at version ${entry.version}.`));

  server.registerTool("taskboard_context_update", {
    title: "Update shared context entry",
    description: "Update a shared context entry using optimistic version locking.",
    inputSchema: updateInputSchema,
    outputSchema: entryOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, safeTool(async ({ id, body, ...patch }) => {
    if (body !== undefined) validateBodyBytes(body);
    return requireEntryPayload(await client.request(
      "PATCH",
      ["api", "context", id],
      { body: { ...patch, ...(body === undefined ? {} : { body }) } },
    ));
  }, ({ entry }) => `Updated shared context entry ${entry.id} to version ${entry.version}.`));

  server.registerTool("taskboard_context_archive", {
    title: "Archive shared context entry",
    description: "Archive a shared context entry using optimistic version locking.",
    inputSchema: archiveInputSchema,
    outputSchema: entryOutputSchema,
    annotations: {
      ...WRITE_ANNOTATIONS,
      destructiveHint: true,
      idempotentHint: true,
    },
  }, safeTool(async ({ id, version }) => requireEntryPayload(await client.request(
    "POST",
    ["api", "context", id, "archive"],
    { body: { version } },
  )), ({ entry }) => `Archived shared context entry ${entry.id} at version ${entry.version}.`));

  return server;
}

