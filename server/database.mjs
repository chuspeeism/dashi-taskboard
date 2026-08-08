import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeTaskIntervention } from "./task-intervention.mjs";
import {
  deriveTaskPrefix,
  normalizeTaskPrefix,
  uniqueTaskPrefix,
} from "../shared/task-identifiers.mjs";

const OBSIDIAN_VAULT_PROJECT_NAME = "Obsidian Vault";
const COLLECTION_PROJECT_LABELS = new Map([
  ["idea-inbox", "灵感收件箱"],
  ["inbox-unclassified", "待归类需求"],
]);

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function isTaskHandoffComment(row) {
  if (row?.author_type !== "agent" || row.author_id !== "codex-agent") return false;
  try {
    return JSON.parse(row.body)?.type === "task_handoff";
  } catch {
    return false;
  }
}

function compactHandoffCommentText(value, limit) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length <= limit) return text;
  return [
    text.slice(0, limit).trimEnd(),
    "",
    "> 内容过长，已截取；完整内容保留在原评论或绑定对话中。",
  ].join("\n");
}

function effectiveTaskStatus(row) {
  return row.status === "done" && row.retrospective_status === "pending"
    ? "pending_retrospective"
    : row.status;
}

function storedTaskStatus(status) {
  return status === "pending_retrospective"
    ? { status: "done", retrospectiveStatus: "pending" }
    : { status, retrospectiveStatus: null };
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    previousIdentifiers: [],
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: effectiveTaskStatus(row),
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    reworkRound: row.rework_round ?? null,
    deliveredAt: row.delivered_at ?? null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: effectiveTaskStatus(row),
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    aiThreadId: row.ai_thread_id ?? null,
    intent: row.intent ?? "comment",
    action: row.action ?? (
      row.intent === "discussion"
        ? "discussion"
        : row.intent === "resume"
          ? row.ai_thread_id ? "development" : "review"
          : "comment"
    ),
    reworkRound: row.rework_round ?? null,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    taskPrefix: row.task_prefix,
    workspacePath: row.workspace_path,
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    dispatchKey: row.dispatch_key ?? null,
    retryJobId: row.retry_job_id ?? null,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    errorCode: row.error_code ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatRetryJobFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    sourceRunId: row.source_run_id,
    retryRunId: row.retry_run_id ?? null,
    state: row.state,
    errorCode: row.error_code,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    role: row.role,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceTier: row.service_tier,
    sandbox: row.sandbox,
    archivedAt: row.archived_at ?? null,
    version: row.version ?? 1,
    currentRun: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function normalizePlanEntries(plan) {
  const entries = Array.isArray(plan)
    ? plan
    : plan && typeof plan === "object"
      ? plan.children ?? plan.tasks ?? plan.plan
      : null;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) {
    throw new ApiError(400, "INVALID_TASK_PLAN", "Task plan must contain 1 to 100 child tasks");
  }

  const childKeys = new Set();
  const normalized = entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child ${index + 1} must be an object`);
    }
    const childKey = typeof entry.childKey === "string" ? entry.childKey.trim() : "";
    if (!childKey || childKey.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(childKey)) {
      throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child ${index + 1} has an invalid childKey`);
    }
    if (childKeys.has(childKey)) {
      throw new ApiError(400, "DUPLICATE_CHILD_KEY", `Plan childKey '${childKey}' is duplicated`);
    }
    childKeys.add(childKey);

    const textField = (key, maxLength) => {
      const value = typeof entry[key] === "string" ? entry[key].trim() : "";
      if (!value || value.length > maxLength) {
        throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child '${childKey}' has an invalid ${key}`);
      }
      return value;
    };
    const listField = (key, maxLength, itemMaxLength) => {
      if (!Array.isArray(entry[key]) || entry[key].length > maxLength) {
        throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child '${childKey}' has an invalid ${key}`);
      }
      const values = entry[key].map((value) => {
        if (typeof value !== "string" || !value.trim() || value.trim().length > itemMaxLength) {
          throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child '${childKey}' has an invalid ${key}`);
        }
        return value.trim();
      });
      if (new Set(values).size !== values.length) {
        throw new ApiError(400, "DUPLICATE_TASK_PLAN_VALUE", `Plan child '${childKey}' has duplicate ${key}`);
      }
      return values.sort();
    };

    const ownership = typeof entry.ownership === "string" ? entry.ownership.trim() : "";
    if (!ownership || ownership.length > 256) {
      throw new ApiError(400, "INVALID_TASK_PLAN", `Plan child '${childKey}' has invalid ownership`);
    }

    const files = listField("files", 200, 1024).map((file) => normalizeRelativePlanPath(file, childKey));
    const acceptance = listField("acceptance", 50, 2_000);
    const dependsOn = listField("dependsOn", 100, 128);
    return {
      childKey,
      title: textField("title", 240),
      description: textField("description", 100_000),
      acceptance,
      ownership,
      files,
      dependsOn,
    };
  });

  const knownKeys = new Set(normalized.map((entry) => entry.childKey));
  for (const entry of normalized) {
    for (const dependency of entry.dependsOn) {
      if (!knownKeys.has(dependency)) {
        throw new ApiError(
          400,
          "UNKNOWN_PLAN_DEPENDENCY",
          `Plan child '${entry.childKey}' depends on unknown childKey '${dependency}'`,
        );
      }
      if (dependency === entry.childKey) {
        throw new ApiError(400, "PLAN_CYCLE", `Plan child '${entry.childKey}' depends on itself`);
      }
    }
  }

  const visitState = new Map();
  const visit = (childKey) => {
    const state = visitState.get(childKey) ?? 0;
    if (state === 1) throw new ApiError(400, "PLAN_CYCLE", "Task plan dependencies contain a cycle");
    if (state === 2) return;
    visitState.set(childKey, 1);
    const entry = normalized.find((candidate) => candidate.childKey === childKey);
    for (const dependency of entry.dependsOn) visit(dependency);
    visitState.set(childKey, 2);
  };
  for (const entry of normalized) visit(entry.childKey);

  const ownershipOwners = new Map();
  const fileOwners = [];
  for (const entry of normalized) {
    const previousOwner = ownershipOwners.get(entry.ownership);
    if (previousOwner && previousOwner !== entry.childKey) {
      throw new ApiError(
        400,
        "OWNERSHIP_CONFLICT",
        `Ownership '${entry.ownership}' is assigned to both '${previousOwner}' and '${entry.childKey}'`,
      );
    }
    ownershipOwners.set(entry.ownership, entry.childKey);
    for (const file of entry.files) {
      fileOwners.push({ file, childKey: entry.childKey });
    }
  }
  fileOwners.sort((left, right) => left.file.localeCompare(right.file));
  for (let index = 1; index < fileOwners.length; index += 1) {
    const previous = fileOwners[index - 1];
    const current = fileOwners[index];
    if (
      current.file === previous.file
      || current.file.startsWith(`${previous.file}/`)
    ) {
      throw new ApiError(
        400,
        "OWNERSHIP_CONFLICT",
        `Files '${previous.file}' and '${current.file}' overlap between '${previous.childKey}' and '${current.childKey}'`,
      );
    }
  }
  return normalized;
}

function normalizeRelativePlanPath(value, childKey) {
  const candidate = String(value).replaceAll("\\", "/");
  if (
    candidate.includes("\0")
    || candidate.startsWith("/")
    || /^[A-Za-z]:/.test(candidate)
  ) {
    throw new ApiError(
      400,
      "INVALID_TASK_PLAN",
      `Plan child '${childKey}' has an unsafe relative file path`,
    );
  }
  const segments = [];
  for (const segment of candidate.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new ApiError(
          400,
          "INVALID_TASK_PLAN",
          `Plan child '${childKey}' escapes its workspace with a parent path`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_TASK_PLAN",
      `Plan child '${childKey}' has an empty relative file path`,
    );
  }
  return segments.join("/");
}

function canonicalPlan(entries) {
  return JSON.stringify([...entries].sort((left, right) => left.childKey.localeCompare(right.childKey)));
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function orchestrationFromRow(row) {
  return row
    ? {
        parentId: row.parent_task_id,
        status: row.status,
        plannerDispatchKey: row.planner_dispatch_key,
        plannerThreadId: row.planner_thread_id,
        plannerRunId: row.planner_run_id,
        plan: parseJsonColumn(row.plan_json, null),
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function orchestrationChildFromRow(row) {
  return {
    parentId: row.parent_task_id,
    childKey: row.child_key,
    taskId: row.task_id,
    title: row.title,
    description: row.description,
    acceptance: parseJsonColumn(row.acceptance_json, []),
    ownership: parseJsonColumn(row.ownership_json, null),
    files: parseJsonColumn(row.files_json, []),
    dependsOn: parseJsonColumn(row.depends_on_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskDispatchFromRow(row) {
  return row
    ? {
        dispatchKey: row.dispatch_key,
        parentId: row.parent_task_id,
        childKey: row.child_key,
        taskId: row.task_id,
        kind: row.kind,
        role: row.role,
        status: row.status,
        threadId: row.thread_id,
        runId: row.run_id,
        error: row.error,
        failureCommentId: row.failure_comment_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function taskHandoffFromRow(row) {
  return row
    ? {
        id: row.id,
        sourceKey: row.source_key,
        sourceKind: row.source_kind,
        parentId: row.parent_task_id,
        queueSeq: row.queue_seq,
        childKey: row.child_key,
        childTaskId: row.child_task_id,
        runId: row.run_id,
        status: row.child_status,
        taskStatus: row.task_status,
        sourceTaskVersion: row.source_task_version,
        sourceTaskStatus: row.source_task_status,
        sourceDispatchKey: row.source_dispatch_key,
        delivery: row.delivery_summary,
        blocker: row.blocker_summary,
        summary: row.delivery_summary ?? row.blocker_summary ?? "",
        latestComment: parseJsonColumn(row.latest_comment_json, null),
        aiThreadId: row.ai_thread_id,
        codexThreadId: row.codex_thread_id,
        commentId: row.comment_id,
        queueStatus: row.state,
        solution: parseJsonColumn(row.solution_json, null),
        solutionAction: row.solution_action,
        solDispatchKey: row.sol_dispatch_key,
        solRunId: row.sol_run_id,
        error: row.error,
        retryCount: row.retry_count ?? 0,
        lastError: row.last_error,
        attemptAction: row.attempt_action,
        workerAttemptDispatchKey: row.worker_attempt_dispatch_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function taskReadinessReviewFromRow(row) {
  return row
    ? {
        taskId: row.task_id,
        status: row.status,
        aiThreadId: row.ai_thread_id,
        codexThreadId: row.codex_thread_id ?? null,
        aiThreadTitle: row.ai_thread_title ?? null,
        aiModel: row.ai_model ?? null,
        aiReasoningEffort: row.ai_reasoning_effort ?? null,
        runId: row.run_id,
        round: row.round,
        sourceTaskVersion: row.source_task_version,
        sourceUserCommentCount: row.source_user_comment_count,
        decision: parseJsonColumn(row.decision_json, null),
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task_prefix TEXT UNIQUE,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        retrospective_status TEXT CHECK (
          retrospective_status IS NULL OR retrospective_status = 'pending'
        ),
        delivered_at TEXT,
        rework_round INTEGER CHECK (rework_round IS NULL OR rework_round > 0),
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        ai_thread_id TEXT,
        intent TEXT NOT NULL DEFAULT 'comment' CHECK (intent IN ('comment', 'resume', 'discussion')),
        action TEXT NOT NULL DEFAULT 'comment' CHECK (action IN ('comment', 'review', 'development', 'discussion')),
        rework_round INTEGER CHECK (rework_round IS NULL OR rework_round > 0),
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('planner', 'worker')),
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        service_tier TEXT,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        dispatch_key TEXT UNIQUE,
        retry_job_id TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS ai_chat_retry_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        source_run_id TEXT NOT NULL UNIQUE REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        retry_run_id TEXT UNIQUE REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'claimed', 'running', 'succeeded', 'exhausted', 'canceled'
        )),
        error_code TEXT NOT NULL,
        last_error TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_retry_jobs_due
        ON ai_chat_retry_jobs(state, next_attempt_at, created_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_retry_jobs_one_active_thread
        ON ai_chat_retry_jobs(thread_id)
        WHERE state IN ('pending', 'claimed', 'running');

      CREATE TABLE IF NOT EXISTS task_orchestrations (
        parent_task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('planning', 'planned', 'failed', 'canceled')),
        planner_dispatch_key TEXT NOT NULL UNIQUE,
        planner_thread_id TEXT,
        planner_run_id TEXT,
        plan_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_orchestration_children (
        parent_task_id TEXT NOT NULL REFERENCES task_orchestrations(parent_task_id) ON DELETE CASCADE,
        child_key TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        ownership_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (parent_task_id, child_key),
        UNIQUE (parent_task_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS task_orchestration_dispatches (
        dispatch_key TEXT PRIMARY KEY,
        parent_task_id TEXT REFERENCES task_orchestrations(parent_task_id) ON DELETE CASCADE,
        child_key TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('planner', 'worker')),
        status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'completed', 'failed', 'unknown')),
        thread_id TEXT,
        run_id TEXT,
        error TEXT,
        failure_comment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id)
      );

      CREATE INDEX IF NOT EXISTS task_orchestration_children_task
        ON task_orchestration_children(task_id);
      CREATE INDEX IF NOT EXISTS task_orchestration_dispatches_parent
        ON task_orchestration_dispatches(parent_task_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS task_handoffs (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_kind TEXT NOT NULL DEFAULT 'run' CHECK (source_kind IN ('run', 'task_status')),
        parent_task_id TEXT NOT NULL REFERENCES task_orchestrations(parent_task_id) ON DELETE CASCADE,
        queue_seq INTEGER NOT NULL,
        child_key TEXT NOT NULL,
        child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        child_status TEXT NOT NULL CHECK (child_status IN ('completed', 'failed', 'interrupted', 'canceled')),
        task_status TEXT NOT NULL CHECK (task_status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        source_task_version INTEGER NOT NULL,
        source_task_status TEXT NOT NULL CHECK (source_task_status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        source_dispatch_key TEXT,
        delivery_summary TEXT,
        blocker_summary TEXT,
        latest_comment_json TEXT,
        ai_thread_id TEXT,
        codex_thread_id TEXT,
        comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'processing', 'attempt_pending', 'resolved', 'stopped', 'failed', 'obsolete'
        )),
        solution_json TEXT,
        solution_action TEXT,
        sol_dispatch_key TEXT,
        sol_run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        last_error TEXT,
        attempt_action TEXT,
        worker_attempt_dispatch_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (parent_task_id, queue_seq)
      );

      CREATE INDEX IF NOT EXISTS task_handoffs_parent_fifo
        ON task_handoffs(parent_task_id, state, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_run
        ON task_handoffs(run_id) WHERE run_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_sol_dispatch
        ON task_handoffs(sol_dispatch_key) WHERE sol_dispatch_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS task_readiness_reviews (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_input', 'ready', 'failed')),
        ai_thread_id TEXT REFERENCES ai_chat_threads(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
        round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
        source_task_version INTEGER NOT NULL CHECK (source_task_version > 0),
        source_user_comment_count INTEGER NOT NULL DEFAULT 0 CHECK (source_user_comment_count >= 0),
        decision_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_readiness_reviews_thread
        ON task_readiness_reviews(ai_thread_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS task_intervention_overrides (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        view TEXT NOT NULL CHECK (view IN ('resolve', 'follow_up', 'comment')),
        mode TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, view)
      );

      CREATE INDEX IF NOT EXISTS task_intervention_overrides_updated
        ON task_intervention_overrides(updated_at, task_id);

    `);

    this.#migrateTaskHandoffs();

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const retrospectiveTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!retrospectiveTaskColumns.some((column) => column.name === "retrospective_status")) {
      this.database.exec(
        "ALTER TABLE tasks ADD COLUMN retrospective_status TEXT CHECK (retrospective_status IS NULL OR retrospective_status = 'pending')",
      );
    }
    if (!retrospectiveTaskColumns.some((column) => column.name === "delivered_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN delivered_at TEXT");
    }
    if (!retrospectiveTaskColumns.some((column) => column.name === "rework_round")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN rework_round INTEGER");
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';

      CREATE TABLE IF NOT EXISTS task_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
    `);

    const taskIdentifierProjectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!taskIdentifierProjectColumns.some((column) => column.name === "task_prefix")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN task_prefix TEXT");
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS projects_task_prefix
        ON projects(task_prefix) WHERE task_prefix IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_identifier_aliases (
        identifier TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_identifier_aliases_task
        ON task_identifier_aliases(task_id, created_at, identifier);
    `);

    const aiChatThreadColumns = this.database.prepare("PRAGMA table_info(ai_chat_threads)").all();
    if (!aiChatThreadColumns.some((column) => column.name === "role")) {
      this.database.exec(
        "ALTER TABLE ai_chat_threads ADD COLUMN role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('planner', 'worker'))",
      );
    }
    if (!aiChatThreadColumns.some((column) => column.name === "service_tier")) {
      this.database.exec("ALTER TABLE ai_chat_threads ADD COLUMN service_tier TEXT");
    }
    if (!aiChatThreadColumns.some((column) => column.name === "archived_at")) {
      this.database.exec("ALTER TABLE ai_chat_threads ADD COLUMN archived_at TEXT");
    }
    if (!aiChatThreadColumns.some((column) => column.name === "version")) {
      this.database.exec("ALTER TABLE ai_chat_threads ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)");
    }
    const aiChatRunColumns = this.database.prepare("PRAGMA table_info(ai_chat_runs)").all();
    if (!aiChatRunColumns.some((column) => column.name === "dispatch_key")) {
      this.database.exec("ALTER TABLE ai_chat_runs ADD COLUMN dispatch_key TEXT");
    }
    if (!aiChatRunColumns.some((column) => column.name === "error_code")) {
      this.database.exec("ALTER TABLE ai_chat_runs ADD COLUMN error_code TEXT");
    }
    if (!aiChatRunColumns.some((column) => column.name === "retry_job_id")) {
      this.database.exec("ALTER TABLE ai_chat_runs ADD COLUMN retry_job_id TEXT");
    }
    this.database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_dispatch_key ON ai_chat_runs(dispatch_key) WHERE dispatch_key IS NOT NULL",
    );
    this.database.exec("DROP INDEX IF EXISTS ai_chat_runs_retry_job");
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS ai_chat_runs_retry_job_history ON ai_chat_runs(retry_job_id, started_at, id) WHERE retry_job_id IS NOT NULL",
    );
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS ai_chat_threads_task_role_status
        ON ai_chat_threads(origin_issue_id, role, status)
    `);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS ai_chat_threads_archive_updated
        ON ai_chat_threads(archived_at, updated_at DESC, id)
    `);
    this.database.exec(`
      UPDATE ai_chat_threads
      SET
        role = CASE WHEN EXISTS (
          SELECT 1
          FROM tasks
          WHERE tasks.id = ai_chat_threads.origin_issue_id
            AND instr(tasks.labels, '"主任务"') > 0
            AND NOT EXISTS (
              SELECT 1
              FROM task_relations
              WHERE task_relations.relation_type = 'parent'
                AND task_relations.target_task_id = tasks.id
            )
        ) THEN 'planner' ELSE 'worker' END,
        sandbox = CASE WHEN EXISTS (
          SELECT 1
          FROM tasks
          WHERE tasks.id = ai_chat_threads.origin_issue_id
            AND instr(tasks.labels, '"主任务"') > 0
            AND NOT EXISTS (
              SELECT 1
              FROM task_relations
              WHERE task_relations.relation_type = 'parent'
                AND task_relations.target_task_id = tasks.id
            )
        ) THEN 'read-only' ELSE 'workspace-write' END
      WHERE origin_issue_id IS NOT NULL
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    if (!commentColumns.some((column) => column.name === "ai_thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN ai_thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "intent")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN intent TEXT NOT NULL DEFAULT 'comment'");
    }
    if (!commentColumns.some((column) => column.name === "action")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN action TEXT NOT NULL DEFAULT 'comment'");
    }
    if (!commentColumns.some((column) => column.name === "rework_round")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN rework_round INTEGER");
    }
    this.database.exec(`
      UPDATE comments
      SET action = CASE
        WHEN intent = 'discussion' THEN 'discussion'
        WHEN intent = 'resume' AND ai_thread_id IS NOT NULL THEN 'development'
        WHEN intent = 'resume' THEN 'review'
        ELSE 'comment'
      END
      WHERE action = 'comment' AND intent IN ('resume', 'discussion')
    `);
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks AS current_tasks
        SET thread_id = COALESCE(current_tasks.thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          WHERE task_threads.task_id = current_tasks.id
          ORDER BY
            CASE WHEN EXISTS (
              SELECT 1
              FROM comments
              WHERE comments.task_id = task_threads.task_id
                AND comments.thread_id = task_threads.thread_id
            ) THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE current_tasks.thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, task_prefix, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', 'Local', 'LOCAL', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.#migrateTaskIdentifiers();
  }

  close() {
    this.database.close();
  }

  #migrateTaskHandoffs() {
    const columns = this.database.prepare("PRAGMA table_info(task_handoffs)").all();
    const tableSql = this.database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'task_handoffs'",
    ).get()?.sql ?? "";
    const requiredColumns = [
      "source_kind",
      "queue_seq",
      "child_key",
      "source_task_version",
      "source_task_status",
      "source_dispatch_key",
      "retry_count",
      "last_error",
      "attempt_action",
      "worker_attempt_dispatch_key",
    ];
    const needsRebuild = requiredColumns.some(
      (name) => !columns.some((column) => column.name === name),
    ) || !tableSql.includes("'canceled'") || !tableSql.includes("'attempt_pending'");

    this.database.exec(`
      DROP INDEX IF EXISTS task_handoffs_parent_fifo;
      DROP INDEX IF EXISTS task_handoffs_run;
      DROP INDEX IF EXISTS task_handoffs_sol_dispatch;
      DROP INDEX IF EXISTS task_handoffs_source_task;
      DROP INDEX IF EXISTS task_handoffs_parent_processing;
    `);

    if (needsRebuild) {
      const legacyRows = this.database.prepare("SELECT * FROM task_handoffs ORDER BY created_at, id").all();
      this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      try {
        this.database.exec("ALTER TABLE task_handoffs RENAME TO task_handoffs_legacy");
        this.database.exec(`
          CREATE TABLE task_handoffs (
            id TEXT PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            source_kind TEXT NOT NULL DEFAULT 'run' CHECK (source_kind IN ('run', 'task_status')),
            parent_task_id TEXT NOT NULL REFERENCES task_orchestrations(parent_task_id) ON DELETE CASCADE,
            queue_seq INTEGER NOT NULL,
            child_key TEXT NOT NULL,
            child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
            child_status TEXT NOT NULL CHECK (child_status IN ('completed', 'failed', 'interrupted', 'canceled')),
            task_status TEXT NOT NULL CHECK (task_status IN (
              'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
            )),
            source_task_version INTEGER NOT NULL,
            source_task_status TEXT NOT NULL CHECK (source_task_status IN (
              'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
            )),
            source_dispatch_key TEXT,
            delivery_summary TEXT,
            blocker_summary TEXT,
            latest_comment_json TEXT,
            ai_thread_id TEXT,
            codex_thread_id TEXT,
            comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
            state TEXT NOT NULL CHECK (state IN (
              'pending', 'processing', 'attempt_pending', 'resolved', 'stopped', 'failed', 'obsolete'
            )),
            solution_json TEXT,
            solution_action TEXT,
            sol_dispatch_key TEXT,
            sol_run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE SET NULL,
            error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
            last_error TEXT,
            attempt_action TEXT,
            worker_attempt_dispatch_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (parent_task_id, queue_seq)
          );
        `);
        const nextSequence = new Map();
        const seenSources = new Set();
        const seenProcessingParents = new Set();
        const insert = this.database.prepare(`
          INSERT INTO task_handoffs (
            id, source_key, source_kind, parent_task_id, queue_seq, child_key, child_task_id, run_id,
            child_status, task_status, source_task_version, source_task_status, source_dispatch_key,
            delivery_summary, blocker_summary, latest_comment_json, ai_thread_id, codex_thread_id,
            comment_id, state, solution_json, solution_action, sol_dispatch_key, sol_run_id, error,
            retry_count, last_error, attempt_action, worker_attempt_dispatch_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of legacyRows) {
          const sequence = (nextSequence.get(row.parent_task_id) ?? 0) + 1;
          nextSequence.set(row.parent_task_id, sequence);
          const mapping = this.database.prepare(`
            SELECT child_key FROM task_orchestration_children
            WHERE parent_task_id = ? AND task_id = ?
          `).get(row.parent_task_id, row.child_task_id);
          const task = this.database.prepare("SELECT version, status FROM tasks WHERE id = ?").get(row.child_task_id);
          const dispatch = row.run_id
            ? this.database.prepare("SELECT dispatch_key FROM task_orchestration_dispatches WHERE run_id = ?").get(row.run_id)
            : null;
          const sourceKind = row.run_id ? "run" : "task_status";
          const sourceTaskStatus = task?.status ?? row.task_status ?? "blocked";
          const sourceTaskVersion = task?.version ?? 1;
          const sourceFingerprint = `${row.child_task_id}:${sourceTaskVersion}:${sourceTaskStatus}`;
          let state = row.state;
          if (["processing", "attempt_pending"].includes(state)) {
            if (seenProcessingParents.has(row.parent_task_id)) state = "pending";
            else seenProcessingParents.add(row.parent_task_id);
          }
          if (seenSources.has(sourceFingerprint)) state = "obsolete";
          else seenSources.add(sourceFingerprint);
          const childStatus = ["completed", "failed", "interrupted", "canceled"].includes(row.child_status)
            ? row.child_status
            : "failed";
          insert.run(
            row.id,
            row.source_key,
            sourceKind,
            row.parent_task_id,
            sequence,
            mapping?.child_key ?? row.child_key ?? row.child_task_id,
            row.child_task_id,
            row.run_id ?? null,
            childStatus,
            row.task_status,
            sourceTaskVersion,
            sourceTaskStatus,
            dispatch?.dispatch_key ?? null,
            row.delivery_summary ?? null,
            row.blocker_summary ?? null,
            row.latest_comment_json ?? null,
            row.ai_thread_id ?? null,
            row.codex_thread_id ?? null,
            row.comment_id ?? null,
            state,
            row.solution_json ?? null,
            row.solution_action ?? null,
            row.sol_dispatch_key ?? null,
            row.sol_run_id ?? null,
            row.error ?? null,
            row.retry_count ?? 0,
            row.last_error ?? row.error ?? null,
            row.attempt_action ?? null,
            row.worker_attempt_dispatch_key ?? null,
            row.created_at,
            row.updated_at,
          );
        }
        this.database.exec("DROP TABLE task_handoffs_legacy");
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      } finally {
        this.database.exec("PRAGMA foreign_keys = ON");
      }
    }

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS task_handoffs_parent_fifo
        ON task_handoffs(parent_task_id, queue_seq, state);
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_run
        ON task_handoffs(run_id) WHERE run_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_sol_dispatch
        ON task_handoffs(sol_dispatch_key) WHERE sol_dispatch_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_source_task
        ON task_handoffs(child_task_id, source_task_version, source_task_status)
        WHERE state <> 'obsolete';
      CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_parent_processing
        ON task_handoffs(parent_task_id)
        WHERE state IN ('processing', 'attempt_pending');
      CREATE UNIQUE INDEX IF NOT EXISTS task_orchestration_worker_attempt_active
        ON task_orchestration_dispatches(task_id)
        WHERE kind = 'worker_attempt' AND status IN ('claimed', 'running');
    `);
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  #migrateTaskIdentifiers() {
    const pendingProjects = this.database.prepare(`
      SELECT id, name FROM projects WHERE task_prefix IS NULL ORDER BY created_at, id
    `).all();
    if (pendingProjects.length === 0) return;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const reserved = new Set(this.database.prepare(`
        SELECT task_prefix FROM projects WHERE task_prefix IS NOT NULL
      `).all().map((row) => row.task_prefix));
      for (const project of pendingProjects) {
        const taskPrefix = uniqueTaskPrefix(deriveTaskPrefix(project), reserved);
        reserved.add(taskPrefix);
        this.database.prepare("UPDATE projects SET task_prefix = ? WHERE id = ?")
          .run(taskPrefix, project.id);
      }
      for (const project of this.database.prepare(`
        SELECT id, task_prefix FROM projects ORDER BY created_at, id
      `).all()) {
        this.#renumberProjectTasksNoTransaction(project.id, project.task_prefix);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #renumberProjectTasksNoTransaction(projectId, taskPrefix) {
    const tasks = this.database.prepare(`
      SELECT id, identifier FROM tasks
      WHERE project_id = ?
      ORDER BY created_at, id
    `).all(projectId);
    const timestamp = now();
    const updateIdentifier = this.database.prepare("UPDATE tasks SET identifier = ? WHERE id = ?");
    const saveAlias = this.database.prepare(`
      INSERT INTO task_identifier_aliases (identifier, task_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(identifier) DO NOTHING
    `);

    for (const task of tasks) {
      updateIdentifier.run(`MIGRATION-${task.id}`, task.id);
    }
    tasks.forEach((task, index) => {
      const identifier = `${taskPrefix}-${index + 1}`;
      if (task.identifier !== identifier) saveAlias.run(task.identifier, task.id, timestamp);
      updateIdentifier.run(identifier, task.id);
      this.database.prepare(`
        UPDATE ai_chat_threads SET origin_issue_identifier = ? WHERE origin_issue_id = ?
      `).run(identifier, task.id);
    });
    this.database.prepare(`
      UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?
    `).run(tasks.length + 1, timestamp, projectId);
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.task_prefix,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.task_prefix,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    const requestedPrefix = input.taskPrefix === undefined ? null : normalizeTaskPrefix(input.taskPrefix);
    if (input.taskPrefix !== undefined && !requestedPrefix) {
      throw new ApiError(400, "INVALID_TASK_PREFIX", "Task prefix must contain 2-6 uppercase letters or numbers and start with a letter");
    }
    const reserved = new Set(this.database.prepare("SELECT task_prefix FROM projects").all().map((row) => row.task_prefix));
    const taskPrefix = requestedPrefix ?? uniqueTaskPrefix(deriveTaskPrefix(input), reserved);
    if (requestedPrefix && reserved.has(requestedPrefix)) {
      throw new ApiError(409, "TASK_PREFIX_EXISTS", `Task prefix '${requestedPrefix}' already exists`);
    }
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, task_prefix, workspace_path, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(input.id, input.name, taskPrefix, input.workspacePath, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.task_prefix,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.task_prefix,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  updateProjectWorkspace(id, workspacePath) {
    const current = this.getProject(id);
    if (!current) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE projects
      SET workspace_path = ?, updated_at = ?
      WHERE id = ?
    `).run(workspacePath, timestamp, id);
    return this.getProject(id);
  }

  updateProjectTaskPrefix(id, taskPrefix) {
    const normalized = normalizeTaskPrefix(taskPrefix);
    if (!normalized) {
      throw new ApiError(400, "INVALID_TASK_PREFIX", "Task prefix must contain 2-6 uppercase letters or numbers and start with a letter");
    }
    const current = this.getProject(id);
    if (!current) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    const conflict = this.database.prepare("SELECT id FROM projects WHERE task_prefix = ? AND id <> ?").get(normalized, id);
    if (conflict) throw new ApiError(409, "TASK_PREFIX_EXISTS", `Task prefix '${normalized}' already exists`);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE projects SET task_prefix = ? WHERE id = ?").run(normalized, id);
      this.#renumberProjectTasksNoTransaction(id, normalized);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(id);
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listAiChatThreads(filters = {}) {
    const archived = typeof filters === "string" ? filters : filters.archived ?? "false";
    if (!new Set(["false", "true", "all"]).has(archived)) {
      throw new ApiError(400, "INVALID_ARCHIVED_FILTER", "Archived filter must be false, true, or all");
    }
    const where = archived === "all"
      ? ""
      : archived === "true" ? "WHERE archived_at IS NOT NULL" : "WHERE archived_at IS NULL";
    return this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ${where}
      ORDER BY updated_at DESC, id
    `).all().map((row) => this.#aiChatThreadWithCurrentRun(row));
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  findRunningAiChatThread(issueId, role, excludeThreadId = null) {
    const row = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      WHERE origin_issue_id = ?
        AND role = ?
        AND archived_at IS NULL
        AND status = 'running'
        AND (? IS NULL OR id <> ?)
      ORDER BY updated_at DESC, id
      LIMIT 1
    `).get(issueId, role, excludeThreadId, excludeThreadId);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  findReusableAiChatThread(issueId, role) {
    const row = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      WHERE origin_issue_id = ?
        AND role = ?
        AND archived_at IS NULL
        AND status IN ('idle', 'running', 'failed')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC, id
      LIMIT 1
    `).get(issueId, role);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  createOrReuseTaskAiChatThread(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertTaskActiveNoTransaction(input.origin.issueId);
      const existing = this.findReusableAiChatThread(input.origin.issueId, input.role);
      if (existing) {
        this.database.exec("COMMIT");
        return existing;
      }
      const thread = this.createAiChatThread(input);
      this.database.exec("COMMIT");
      return thread;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createAiChatThread(input) {
    if (input.origin?.issueId) {
      this.#assertTaskActiveNoTransaction(input.origin.issueId, { allowMissing: true });
    }
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, role, model, reasoning_effort, service_tier, sandbox,
        archived_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.role ?? "worker",
      input.model,
      input.reasoningEffort,
      input.serviceTier ?? null,
      input.sandbox,
      input.archivedAt ?? null,
      input.version ?? 1,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.#assertAiChatThreadWritable(current);
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      role: "role",
      model: "model",
      reasoningEffort: "reasoning_effort",
      serviceTier: "service_tier",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    return this.archiveAiChatThread(id, current.version);
  }

  archiveAiChatThread(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
      if (!current) {
        throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
      }
      this.#assertStandaloneAiChatThread(current);
      this.#assertVersion(current.version, version, "AI_CHAT_THREAD_VERSION_CONFLICT", "AI chat thread");
      if (current.archived_at !== null) {
        throw new ApiError(409, "AI_CHAT_THREAD_ALREADY_ARCHIVED", "AI chat thread is already archived");
      }
      const running = this.database.prepare(`
        SELECT 1 FROM ai_chat_runs WHERE thread_id = ? AND status = 'running' LIMIT 1
      `).get(id);
      if (running) {
        throw new ApiError(409, "AI_CHAT_THREAD_BUSY", "A running AI chat thread cannot be archived");
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE ai_chat_threads
        SET archived_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND archived_at IS NULL
      `).run(timestamp, timestamp, id, version);
      if (result.changes !== 1) {
        throw new ApiError(409, "AI_CHAT_THREAD_VERSION_CONFLICT", "AI chat thread was changed by another client");
      }
      this.database.exec("COMMIT");
      return this.getAiChatThread(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  restoreAiChatThread(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
      if (!current) {
        throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
      }
      this.#assertStandaloneAiChatThread(current);
      this.#assertVersion(current.version, version, "AI_CHAT_THREAD_VERSION_CONFLICT", "AI chat thread");
      if (current.archived_at === null) {
        throw new ApiError(409, "AI_CHAT_THREAD_NOT_ARCHIVED", "Only an archived AI chat thread can be restored");
      }
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE ai_chat_threads
        SET archived_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND archived_at IS NOT NULL
      `).run(timestamp, id, version);
      if (result.changes !== 1) {
        throw new ApiError(409, "AI_CHAT_THREAD_VERSION_CONFLICT", "AI chat thread was changed by another client");
      }
      this.database.exec("COMMIT");
      return this.getAiChatThread(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    return this.createAiChatRunIdempotently(input).run;
  }

  createAiChatRunIdempotently(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.database.prepare(
        "SELECT * FROM ai_chat_threads WHERE id = ?",
      ).get(input.threadId);
      if (!thread) {
        throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${input.threadId}' does not exist`);
      }
      this.#assertAiChatThreadActiveNoTransaction(thread);
      if (thread.origin_issue_id) {
        this.#assertTaskActiveNoTransaction(thread.origin_issue_id, { allowMissing: true });
      }
      if (input.dispatchKey !== undefined && input.dispatchKey !== null) {
        const dispatch = this.database.prepare(`
          SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
        `).get(input.dispatchKey);
        if (!dispatch) {
          throw new ApiError(409, "DISPATCH_NOT_CLAIMED", "The dispatch key was not claimed by the server");
        }
        if (dispatch.thread_id !== null && dispatch.thread_id !== input.threadId) {
          throw new ApiError(409, "DISPATCH_KEY_CONFLICT", "The dispatch key is bound to a different thread");
        }
        if (dispatch.run_id) {
          const existingRun = this.database.prepare(
            "SELECT * FROM ai_chat_runs WHERE id = ?",
          ).get(dispatch.run_id);
          if (!existingRun || existingRun.thread_id !== input.threadId) {
            throw new ApiError(409, "DISPATCH_KEY_CONFLICT", "The dispatch key is bound to a different run thread");
          }
          this.database.exec("COMMIT");
          return { run: aiChatRunFromRow(existingRun), created: false };
        }
        if (dispatch.status !== "claimed") {
          throw new ApiError(409, "DISPATCH_NOT_REUSABLE", `Dispatch '${input.dispatchKey}' is already terminal`);
        }
      }
      if (input.retryJobId !== undefined && input.retryJobId !== null) {
        const retryJob = this.database.prepare(
          "SELECT * FROM ai_chat_retry_jobs WHERE id = ?",
        ).get(input.retryJobId);
        if (!retryJob || retryJob.thread_id !== input.threadId) {
          throw new ApiError(409, "AI_RETRY_JOB_CONFLICT", "The retry job does not belong to this thread");
        }
        if (retryJob.retry_run_id) {
          const existingRun = this.database.prepare(
            "SELECT * FROM ai_chat_runs WHERE id = ?",
          ).get(retryJob.retry_run_id);
          if (existingRun) {
            this.database.exec("COMMIT");
            return { run: aiChatRunFromRow(existingRun), created: false };
          }
        }
        if (retryJob.state !== "claimed" || retryJob.attempt_count >= retryJob.max_attempts) {
          throw new ApiError(409, "AI_RETRY_JOB_NOT_CLAIMED", "The retry job is not ready to start");
        }
      }
      if ((input.status ?? "running") === "running") {
        const sameThreadRun = this.database.prepare(`
          SELECT id
          FROM ai_chat_runs
          WHERE thread_id = ? AND status = 'running'
          LIMIT 1
        `).get(input.threadId);
        if (sameThreadRun) {
          throw new ApiError(
            409,
            "AI_CHAT_THREAD_BUSY",
            "A running AI chat turn already exists for this thread",
          );
        }
        const duplicate = this.database.prepare(`
          SELECT id
          FROM ai_chat_threads
          WHERE origin_issue_id IS NOT NULL
            AND origin_issue_id = (
              SELECT origin_issue_id FROM ai_chat_threads WHERE id = ?
            )
            AND role = (
              SELECT role FROM ai_chat_threads WHERE id = ?
            )
            AND archived_at IS NULL
            AND status = 'running'
            AND id <> ?
          LIMIT 1
        `).get(input.threadId, input.threadId, input.threadId);
        if (duplicate) {
          throw new ApiError(
            409,
            "TASK_THREAD_BUSY",
            "This task already has a running thread for the same role",
          );
        }
      }
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, dispatch_key, retry_job_id, status,
          exit_code, error, error_code, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.dispatchKey ?? null,
        input.retryJobId ?? null,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        input.errorCode ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      if (input.dispatchKey !== undefined && input.dispatchKey !== null) {
        const bound = this.database.prepare(`
          UPDATE task_orchestration_dispatches
          SET thread_id = ?, run_id = ?, status = 'running', updated_at = ?
          WHERE dispatch_key = ?
            AND status = 'claimed'
            AND run_id IS NULL
            AND (thread_id IS NULL OR thread_id = ?)
        `).run(input.threadId, id, timestamp, input.dispatchKey, input.threadId);
        if (bound.changes !== 1) {
          const currentDispatch = this.database.prepare(
            "SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?",
          ).get(input.dispatchKey);
          if (currentDispatch?.run_id !== id) {
            throw new ApiError(409, "DISPATCH_KEY_CONFLICT", "The dispatch could not be bound with compare-and-set semantics");
          }
        }
        this.database.prepare(`
          UPDATE task_handoffs
          SET sol_run_id = ?, updated_at = ?
          WHERE sol_dispatch_key = ?
        `).run(id, timestamp, input.dispatchKey);
      }
      if (input.retryJobId !== undefined && input.retryJobId !== null) {
        const bound = this.database.prepare(`
          UPDATE ai_chat_retry_jobs
          SET state = 'running', retry_run_id = ?, attempt_count = attempt_count + 1,
              next_attempt_at = NULL, updated_at = ?
          WHERE id = ? AND thread_id = ? AND state = 'claimed'
            AND retry_run_id IS NULL AND attempt_count < max_attempts
        `).run(id, timestamp, input.retryJobId, input.threadId);
        if (bound.changes !== 1) {
          throw new ApiError(409, "AI_RETRY_JOB_CONFLICT", "The retry job could not be bound to the run");
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { run: this.getAiChatRun(id), created: true };
  }

  settleAiChatRun(id, changes = {}) {
    const initial = this.getAiChatRun(id);
    if (!initial) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const terminalStatuses = new Set(["completed", "failed", "interrupted"]);
    const requestedStatus = changes.status ?? initial.status;
    if (!terminalStatuses.has(requestedStatus)) {
      throw new ApiError(400, "INVALID_RUN_STATUS", "A settled AI chat run must be terminal");
    }

    let handoffResult = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
      if (!currentRow) {
        throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
      }
      const current = aiChatRunFromRow(currentRow);
      const status = current.status === "running" ? requestedStatus : current.status;
      if (current.status === "running") {
        const finishedAt = changes.finishedAt ?? now();
        this.database.prepare(`
          UPDATE ai_chat_runs
          SET status = ?, exit_code = ?, error = ?, error_code = ?, finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run(
          status,
          changes.exitCode ?? null,
          changes.error ?? null,
          changes.errorCode ?? null,
          finishedAt,
          id,
        );
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, finishedAt, current.threadId, current.threadId);
        if (current.dispatchKey) {
          const dispatchStatus = status === "completed" ? "completed" : "failed";
          this.database.prepare(`
            UPDATE task_orchestration_dispatches
            SET status = ?, error = ?, updated_at = ?
            WHERE dispatch_key = ?
          `).run(
            dispatchStatus,
            status === "completed" ? changes.error ?? null : changes.error ?? status,
            finishedAt,
            current.dispatchKey,
          );
          this.database.prepare(`
            UPDATE task_handoffs
            SET sol_run_id = ?, updated_at = ?
            WHERE sol_dispatch_key = ?
          `).run(id, finishedAt, current.dispatchKey);
        }
      }

      handoffResult = this.#createTaskHandoffNoTransaction({
        runId: id,
        status,
        assistantText: changes.assistantText,
        error: changes.error,
      });
      if (current.dispatchKey) {
        const workerAttempt = this.database.prepare(`
          SELECT kind FROM task_orchestration_dispatches WHERE dispatch_key = ?
        `).get(current.dispatchKey);
        if (workerAttempt?.kind === "worker_attempt") {
          this.database.prepare(`
            UPDATE task_handoffs
            SET state = 'resolved', error = NULL, last_error = NULL, updated_at = ?
            WHERE worker_attempt_dispatch_key = ? AND state = 'attempt_pending'
          `).run(changes.finishedAt ?? now(), current.dispatchKey);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const run = this.getAiChatRun(id);
    const handoff = handoffResult?.handoffId
      ? this.getTaskHandoff(handoffResult.handoffId)
      : null;
    const task = handoff ? this.getTask(handoff.childTaskId) : null;
    const comment = handoff?.commentId ? this.getComment(handoff.commentId) : null;
    return {
      run,
      handoff,
      task,
      comment,
      handoffCreated: Boolean(handoffResult?.created),
    };
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      errorCode: "error_code",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      if (current.dispatchKey) {
        const dispatchStatus = status === "completed" ? "completed" : status === "running" ? "running" : "failed";
        this.database.prepare(`
          UPDATE task_orchestration_dispatches
          SET status = ?, error = ?, updated_at = ?
          WHERE dispatch_key = ?
        `).run(
          dispatchStatus,
          status === "completed" ? null : changes.error ?? current.error ?? status,
          changes.finishedAt ?? now(),
          current.dispatchKey,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  recoverAbandonedAiChatRuns() {
    const runs = this.database.prepare(`
      SELECT id FROM ai_chat_runs WHERE status = 'running' ORDER BY started_at, id
    `).all();
    let count = 0;
    for (const run of runs) {
      const settled = this.settleAiChatRun(run.id, {
        status: "interrupted",
        error: "Taskboard service restarted",
        finishedAt: now(),
      });
      if (settled.run.status === "interrupted") count += 1;
    }
    return count;
  }

  getAiChatRetryJob(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_retry_jobs WHERE id = ?").get(id);
    return row ? aiChatRetryJobFromRow(row) : null;
  }

  getAiChatRetryJobByRun(runId) {
    const row = this.database.prepare(`
      SELECT * FROM ai_chat_retry_jobs
      WHERE source_run_id = ? OR retry_run_id = ?
      ORDER BY CASE WHEN retry_run_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(runId, runId, runId);
    return row ? aiChatRetryJobFromRow(row) : null;
  }

  listAiChatRetryJobs(states = null) {
    if (!states || states.length === 0) {
      return this.database.prepare(`
        SELECT * FROM ai_chat_retry_jobs ORDER BY created_at, id
      `).all().map(aiChatRetryJobFromRow);
    }
    const allowed = new Set(["pending", "claimed", "running", "succeeded", "exhausted", "canceled"]);
    if (states.some((state) => !allowed.has(state))) {
      throw new ApiError(400, "INVALID_AI_RETRY_STATE", "Unknown AI retry state");
    }
    const placeholders = states.map(() => "?").join(", ");
    return this.database.prepare(`
      SELECT * FROM ai_chat_retry_jobs
      WHERE state IN (${placeholders})
      ORDER BY next_attempt_at, created_at, id
    `).all(...states).map(aiChatRetryJobFromRow);
  }

  aiChatRunHasAttachments(runId) {
    const rows = this.database.prepare(`
      SELECT data FROM ai_chat_events
      WHERE run_id = ? AND role = 'user'
      ORDER BY created_at, id
    `).all(runId);
    return rows.some((row) => {
      const data = parseJsonColumn(row.data, {});
      return Array.isArray(data.attachments) && data.attachments.length > 0;
    });
  }

  enqueueAiChatRetryJob(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM ai_chat_retry_jobs WHERE source_run_id = ?
      `).get(input.sourceRunId);
      if (existing) {
        this.database.exec("COMMIT");
        return { job: aiChatRetryJobFromRow(existing), created: false };
      }
      const active = this.database.prepare(`
        SELECT * FROM ai_chat_retry_jobs
        WHERE thread_id = ? AND state IN ('pending', 'claimed', 'running')
        ORDER BY created_at, id LIMIT 1
      `).get(input.threadId);
      if (active) {
        this.database.exec("COMMIT");
        return { job: aiChatRetryJobFromRow(active), created: false };
      }
      const run = this.database.prepare(`
        SELECT * FROM ai_chat_runs WHERE id = ? AND thread_id = ?
      `).get(input.sourceRunId, input.threadId);
      if (!run || run.status !== "failed" || run.dispatch_key !== null || run.retry_job_id !== null) {
        throw new ApiError(409, "AI_RUN_NOT_RETRYABLE", "The AI run is not eligible for automatic retry");
      }
      const id = input.id ?? randomUUID();
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO ai_chat_retry_jobs (
          id, thread_id, source_run_id, retry_run_id, state, error_code, last_error,
          attempt_count, max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'pending', ?, ?, 0, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.sourceRunId,
        input.errorCode,
        String(input.error ?? "Codex turn failed").slice(0, 65_536),
        input.maxAttempts ?? 2,
        input.nextAttemptAt,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return { job: this.getAiChatRetryJob(id), created: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimDueAiChatRetryJob(at = now()) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT * FROM ai_chat_retry_jobs
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, created_at, id
        LIMIT 1
      `).get(at);
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      const result = this.database.prepare(`
        UPDATE ai_chat_retry_jobs
        SET state = 'claimed', updated_at = ?
        WHERE id = ? AND state = 'pending' AND next_attempt_at = ?
      `).run(at, row.id, row.next_attempt_at);
      if (result.changes !== 1) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.exec("COMMIT");
      return this.getAiChatRetryJob(row.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  nextAiChatRetryAt() {
    return this.database.prepare(`
      SELECT MIN(next_attempt_at) AS next_attempt_at
      FROM ai_chat_retry_jobs WHERE state = 'pending'
    `).get().next_attempt_at ?? null;
  }

  settleAiChatRetryJobForRun(runId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT * FROM ai_chat_retry_jobs WHERE retry_run_id = ?
      `).get(runId);
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      if (row.state !== "running") {
        this.database.exec("COMMIT");
        return aiChatRetryJobFromRow(row);
      }
      const succeeded = input.status === "completed";
      const exhausted = !succeeded && row.attempt_count >= row.max_attempts;
      const state = succeeded ? "succeeded" : exhausted ? "exhausted" : "pending";
      const nextAttemptAt = state === "pending" ? input.nextAttemptAt : null;
      this.database.prepare(`
        UPDATE ai_chat_retry_jobs
        SET state = ?, retry_run_id = CASE WHEN ? = 'pending' THEN NULL ELSE retry_run_id END,
            last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND retry_run_id = ?
      `).run(
        state,
        state,
        succeeded ? row.last_error : String(input.error ?? input.status).slice(0, 65_536),
        nextAttemptAt,
        now(),
        row.id,
        runId,
      );
      this.database.exec("COMMIT");
      return this.getAiChatRetryJob(row.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failClaimedAiChatRetryJob(id, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM ai_chat_retry_jobs WHERE id = ?").get(id);
      if (!row || row.state !== "claimed") {
        this.database.exec("COMMIT");
        return row ? aiChatRetryJobFromRow(row) : null;
      }
      const attemptCount = row.attempt_count + 1;
      const exhausted = attemptCount >= row.max_attempts;
      this.database.prepare(`
        UPDATE ai_chat_retry_jobs
        SET state = ?, attempt_count = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'claimed'
      `).run(
        exhausted ? "exhausted" : "pending",
        attemptCount,
        String(input.error ?? "Automatic retry could not start").slice(0, 65_536),
        exhausted ? null : input.nextAttemptAt,
        now(),
        id,
      );
      this.database.exec("COMMIT");
      return this.getAiChatRetryJob(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  cancelAiChatRetryJob(id, reason = "Automatic retry canceled") {
    this.database.prepare(`
      UPDATE ai_chat_retry_jobs
      SET state = 'canceled', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND state IN ('pending', 'claimed')
    `).run(String(reason).slice(0, 65_536), now(), id);
    return this.getAiChatRetryJob(id);
  }

  resolveAiChatRetryJobsForThread(threadId) {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE ai_chat_retry_jobs
      SET state = 'succeeded', next_attempt_at = NULL, updated_at = ?
      WHERE thread_id = ? AND state IN ('pending', 'claimed', 'exhausted')
    `).run(timestamp, threadId);
    return result.changes;
  }

  recoverAiChatRetryJobs() {
    const timestamp = now();
    this.database.prepare(`
      UPDATE ai_chat_retry_jobs
      SET state = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE state = 'claimed' AND retry_run_id IS NULL
    `).run(timestamp, timestamp);
    const running = this.database.prepare(`
      SELECT jobs.id, jobs.retry_run_id, runs.status, runs.error
      FROM ai_chat_retry_jobs jobs
      LEFT JOIN ai_chat_runs runs ON runs.id = jobs.retry_run_id
      WHERE jobs.state = 'running'
    `).all();
    for (const row of running) {
      if (!row.retry_run_id || row.status === "running") continue;
      this.settleAiChatRetryJobForRun(row.retry_run_id, {
        status: row.status ?? "interrupted",
        error: row.error ?? "Taskboard service restarted",
        nextAttemptAt: timestamp,
      });
    }
    return this.listAiChatRetryJobs(["pending", "claimed", "running"]);
  }

  interruptAbandonedAiChatRuns() {
    return this.recoverAbandonedAiChatRuns();
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      const stored = storedTaskStatus(filters.status);
      where.push("status = ?");
      values.push(stored.status);
      if (filters.status === "pending_retrospective") {
        where.push("retrospective_status = 'pending'");
      } else if (filters.status === "done") {
        where.push("retrospective_status IS NULL");
      }
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'done' THEN CASE WHEN retrospective_status = 'pending' THEN 5 ELSE 6 END
          WHEN 'blocked' THEN 7
          WHEN 'canceled' THEN 8
        END,
        sort_order,
        created_at,
        id
    `;
    return this.database.prepare(sql).all(...values).map((row) => this.#taskWithRelations(row));
  }

  setTaskInterventionOverride(id, version, view, mode) {
    if (!['resolve', 'follow_up', 'comment'].includes(view)) {
      throw new ApiError(400, "INVALID_INTERVENTION_VIEW", "Unknown task intervention view");
    }
    if (!['auto', 'include', 'exclude'].includes(mode)) {
      throw new ApiError(400, "INVALID_INTERVENTION_MODE", "Unknown task intervention mode");
    }
    let taskId;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      taskId = current.id;
      this.#assertTaskWritable(current);
      this.#requireVersion(current, version);
      if (mode === "auto") {
        this.database.prepare(`
          DELETE FROM task_intervention_overrides
          WHERE task_id = ? AND view = ?
        `).run(current.id, view);
      } else {
        this.database.prepare(`
          INSERT INTO task_intervention_overrides (task_id, view, mode, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(task_id, view) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
        `).run(current.id, view, mode, now());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(taskId);
  }

  getTask(id) {
    const row = this.database.prepare(`
      SELECT tasks.* FROM tasks
      LEFT JOIN task_identifier_aliases aliases ON aliases.task_id = tasks.id
      WHERE tasks.id = ? OR tasks.identifier = ? OR aliases.identifier = ?
      LIMIT 1
    `).get(id, id, id);
    return row ? this.#taskWithRelations(row) : null;
  }

  getTaskReadinessReview(taskId) {
    const row = this.database.prepare(`
      SELECT reviews.*, threads.codex_thread_id,
        threads.title AS ai_thread_title,
        threads.model AS ai_model,
        threads.reasoning_effort AS ai_reasoning_effort
      FROM task_readiness_reviews reviews
      LEFT JOIN ai_chat_threads threads ON threads.id = reviews.ai_thread_id
      WHERE reviews.task_id = ?
    `).get(taskId);
    return taskReadinessReviewFromRow(row);
  }

  getTaskReadinessReviewByThread(threadId) {
    const row = this.database.prepare(`
      SELECT reviews.*, threads.codex_thread_id,
        threads.title AS ai_thread_title,
        threads.model AS ai_model,
        threads.reasoning_effort AS ai_reasoning_effort
      FROM task_readiness_reviews reviews
      LEFT JOIN ai_chat_threads threads ON threads.id = reviews.ai_thread_id
      WHERE reviews.ai_thread_id = ?
    `).get(threadId);
    return taskReadinessReviewFromRow(row);
  }

  listTaskReadinessReviews(statuses = null) {
    const allowed = new Set(["running", "awaiting_input", "ready", "failed"]);
    if (statuses && statuses.some((status) => !allowed.has(status))) {
      throw new ApiError(400, "INVALID_READINESS_STATUS", "Unknown task readiness status");
    }
    const where = statuses?.length
      ? `WHERE reviews.status IN (${statuses.map(() => "?").join(", ")})`
      : "";
    return this.database.prepare(`
      SELECT reviews.*, threads.codex_thread_id,
        threads.title AS ai_thread_title,
        threads.model AS ai_model,
        threads.reasoning_effort AS ai_reasoning_effort
      FROM task_readiness_reviews reviews
      LEFT JOIN ai_chat_threads threads ON threads.id = reviews.ai_thread_id
      ${where}
      ORDER BY reviews.updated_at, reviews.task_id
    `).all(...(statuses ?? [])).map(taskReadinessReviewFromRow);
  }

  countUserComments(taskId) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM comments
      WHERE task_id = ? AND author_type = 'user'
    `).get(taskId).count);
  }

  countReadinessInputComments(taskId) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM comments
      WHERE task_id = ? AND author_type = 'user' AND intent = 'resume'
    `).get(taskId).count);
  }

  beginTaskReadinessReview(taskId, input) {
    const task = this.#requireTask(taskId);
    this.#assertTaskWritable(task);
    const current = this.getTaskReadinessReview(task.id);
    const timestamp = now();
    const round = (current?.round ?? 0) + 1;
    this.database.prepare(`
      INSERT INTO task_readiness_reviews (
        task_id, status, ai_thread_id, run_id, round, source_task_version,
        source_user_comment_count, decision_json, error, created_at, updated_at
      ) VALUES (?, 'running', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        status = 'running',
        ai_thread_id = excluded.ai_thread_id,
        run_id = NULL,
        round = excluded.round,
        source_task_version = excluded.source_task_version,
        source_user_comment_count = excluded.source_user_comment_count,
        decision_json = NULL,
        error = NULL,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      input.aiThreadId,
      round,
      task.version,
      this.countReadinessInputComments(task.id),
      current?.createdAt ?? timestamp,
      timestamp,
    );
    return this.getTaskReadinessReview(task.id);
  }

  bindTaskReadinessRun(taskId, round, runId) {
    const result = this.database.prepare(`
      UPDATE task_readiness_reviews
      SET run_id = ?, updated_at = ?
      WHERE task_id = ? AND round = ? AND status = 'running' AND run_id IS NULL
    `).run(runId, now(), taskId, round);
    if (result.changes !== 1) {
      throw new ApiError(409, "READINESS_REVIEW_CHANGED", "Task readiness review changed before its run was bound");
    }
    return this.getTaskReadinessReview(taskId);
  }

  settleTaskReadinessReview(taskId, round, input) {
    const status = input.status;
    if (!["awaiting_input", "ready", "failed"].includes(status)) {
      throw new ApiError(400, "INVALID_READINESS_STATUS", "Task readiness review cannot settle to that status");
    }
    const result = this.database.prepare(`
      UPDATE task_readiness_reviews
      SET status = ?, decision_json = ?, error = ?, updated_at = ?
      WHERE task_id = ? AND round = ? AND status = 'running'
    `).run(
      status,
      input.decision === undefined || input.decision === null ? null : JSON.stringify(input.decision),
      input.error ?? null,
      now(),
      taskId,
      round,
    );
    if (result.changes !== 1) return this.getTaskReadinessReview(taskId);
    return this.getTaskReadinessReview(taskId);
  }

  createTask(input) {
    return this.createTaskIdempotently(input, null).task;
  }

  createTaskIdempotently(input, idempotencyKey) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#createTaskIdempotentlyNoTransaction(input, idempotencyKey);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #createTaskIdempotentlyNoTransaction(input, idempotencyKey) {
    if (idempotencyKey !== null) {
      const existing = this.database.prepare(`
        SELECT task_id FROM task_idempotency_keys WHERE idempotency_key = ?
      `).get(idempotencyKey);
      if (existing) {
        return { task: this.getTask(existing.task_id), created: false };
      }
    }

    const collectionLabel = COLLECTION_PROJECT_LABELS.get(input.projectId) ?? null;
    const project = this.database.prepare(`
      SELECT id, task_prefix, next_task_number FROM projects WHERE id = ?
    `).get(input.projectId);
    const routedProject = collectionLabel
      ? this.database.prepare(`
          SELECT id, task_prefix, next_task_number
          FROM projects
          WHERE name = ?
          ORDER BY created_at ASC
          LIMIT 1
        `).get(OBSIDIAN_VAULT_PROJECT_NAME)
      : project;
    const projectId = routedProject?.id ?? input.projectId;
    const labels = collectionLabel
      ? [...new Set([
          ...input.labels.filter((label) => label !== "主任务"),
          collectionLabel,
        ])]
      : input.labels;
    if (!routedProject) {
      const code = collectionLabel ? "PROJECT_ALIAS_TARGET_MISSING" : "PROJECT_NOT_FOUND";
      throw new ApiError(404, code, collectionLabel
        ? `Project '${OBSIDIAN_VAULT_PROJECT_NAME}' does not exist`
        : `Project '${input.projectId}' does not exist`);
    }

    let number = routedProject.next_task_number;
    let identifier = `${routedProject.task_prefix}-${number}`;
    while (this.database.prepare(`
      SELECT 1 FROM tasks WHERE identifier = ?
      UNION ALL
      SELECT 1 FROM task_identifier_aliases WHERE identifier = ?
      LIMIT 1
    `).get(identifier, identifier)) {
      number += 1;
      identifier = `${project.task_prefix}-${number}`;
    }
    const id = randomUUID();
    const timestamp = now();
    const stored = storedTaskStatus(input.status);
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ?
          AND COALESCE(retrospective_status, '') = COALESCE(?, '')
          AND archived_at IS NULL
      `).get(projectId, stored.status, stored.retrospectiveStatus);
      sortOrder = row.maximum + 1000;
    }

    this.database.prepare(`
      UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?
    `).run(number + 1, timestamp, projectId);
    this.database.prepare(`
      INSERT INTO tasks (
        id, identifier, project_id, title, description, status, priority, labels,
        sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
        assignee_type, assignee_id, assignee_name, assignee_avatar_url,
        workflow_id, git_branch, worktree_path, worktree_branch,
        due_date, recurrence_interval, recurrence_unit,
        retrospective_status, delivered_at, archived_at, version, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?
      )
    `).run(
      id,
      identifier,
      projectId,
      input.title,
      input.description,
      stored.status,
      input.priority,
      JSON.stringify(labels),
      sortOrder,
      input.threadId ?? null,
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      input.assignee.type,
      input.assignee.id,
      input.assignee.name,
      input.assignee.avatarUrl,
      input.workflowId,
      input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
      input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
      input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
      input.dueDate,
      input.recurrence?.interval ?? null,
      input.recurrence?.unit ?? null,
      stored.retrospectiveStatus,
      input.status === "pending_retrospective" ? timestamp : null,
      timestamp,
      timestamp,
    );
    if (idempotencyKey !== null) {
      this.database.prepare(`
        INSERT INTO task_idempotency_keys (idempotency_key, task_id, created_at)
        VALUES (?, ?, ?)
      `).run(idempotencyKey, id, timestamp);
    }
    return { task: this.getTask(id), created: true };
  }

  updateTask(id, version, changes, threadId) {
    const current = this.#requireTask(id);
    this.#assertTaskWritable(current);
    this.#requireVersion(current, version);
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    const timestamp = now();
    for (const [key, value] of Object.entries(changes)) {
      if (key === "status") {
        const stored = storedTaskStatus(value);
        assignments.push("status = ?", "retrospective_status = ?");
        values.push(stored.status, stored.retrospectiveStatus);
        if (current.status !== value && value === "pending_retrospective") {
          assignments.push("delivered_at = ?");
          values.push(timestamp);
        }
        if (["pending_retrospective", "done", "canceled"].includes(value)) {
          assignments.push("rework_round = NULL");
        }
        continue;
      }
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(threadId);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      const nextStatus = changes.status;
      if (
        current.status !== nextStatus
        && ["in_review", "blocked", "canceled"].includes(nextStatus)
      ) {
        this.#createTaskStatusHandoffNoTransaction({
          taskId: current.id,
          summary: "Task entered " + nextStatus + " through an explicit task update",
        });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId) {
    const current = this.#requireTask(id);
    this.#assertTaskWritable(current);
    this.#requireVersion(current, version);
    const stored = storedTaskStatus(status);
    if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ?
          AND COALESCE(retrospective_status, '') = COALESCE(?, '')
          AND archived_at IS NULL AND id != ?
      `).get(current.projectId, stored.status, stored.retrospectiveStatus, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, retrospective_status = ?, delivered_at = ?,
            rework_round = ?, sort_order = ?, thread_id = COALESCE(?, thread_id),
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        stored.status,
        stored.retrospectiveStatus,
        current.status !== status && status === "pending_retrospective" ? timestamp : current.deliveredAt,
        ["pending_retrospective", "done", "canceled"].includes(status) ? null : current.reworkRound,
        sortOrder,
        threadId ?? null,
        timestamp,
        current.id,
        version,
      );
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (current.status !== status && ["in_review", "blocked", "canceled"].includes(status)) {
        this.#createTaskStatusHandoffNoTransaction({
          taskId: current.id,
          summary: "Task entered " + status + " through an explicit move",
        });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  reassignTask(id, version, projectId, threadId) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#assertTaskWritable(current);
      this.#requireVersion(current, version);
      const target = this.database.prepare(`
        SELECT id, task_prefix, next_task_number FROM projects WHERE id = ?
      `).get(projectId);
      if (!target) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(projectId, current.status, current.id);
      const sortOrder = row.maximum + 1000;
      let number = target.next_task_number;
      let identifier = `${target.task_prefix}-${number}`;
      while (this.database.prepare(`
        SELECT 1 FROM tasks WHERE identifier = ?
        UNION ALL
        SELECT 1 FROM task_identifier_aliases WHERE identifier = ?
        LIMIT 1
      `).get(identifier, identifier)) {
        number += 1;
        identifier = `${target.task_prefix}-${number}`;
      }
      this.database.prepare(`
        INSERT INTO task_identifier_aliases (identifier, task_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(identifier) DO NOTHING
      `).run(current.identifier, current.id, timestamp);
      const result = this.database.prepare(`
        UPDATE tasks
        SET project_id = ?, identifier = ?, sort_order = ?, thread_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        projectId,
        identifier,
        sortOrder,
        threadId ?? current.threadId ?? null,
        timestamp,
        current.id,
        version,
      );
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?
      `).run(number + 1, timestamp, projectId);
      this.database.prepare(`
        UPDATE ai_chat_threads SET origin_project_id = ?, origin_issue_identifier = ?
        WHERE origin_issue_id = ?
      `).run(projectId, identifier, current.id);
      const task = this.getTask(current.id);
      this.database.exec("COMMIT");
      return task;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  archiveTask(id, version, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt !== null) {
        throw new ApiError(409, "TASK_ALREADY_ARCHIVED", "Task is already archived");
      }
      const affectedTaskIds = this.#archiveAffectedTaskIdsNoTransaction(current.id);
      this.#assertArchiveAllowedNoTransaction(affectedTaskIds);
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.prepare(`
        UPDATE ai_chat_threads
        SET archived_at = ?, version = version + 1, updated_at = ?
        WHERE origin_issue_id = ? AND archived_at IS NULL
      `).run(timestamp, timestamp, current.id);
      this.database.exec("COMMIT");
      return this.getTask(current.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  restoreTask(id, version, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
      }
      const archivedAt = current.archivedAt;
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.prepare(`
        UPDATE ai_chat_threads
        SET archived_at = NULL, version = version + 1, updated_at = ?
        WHERE origin_issue_id = ? AND archived_at = ?
      `).run(timestamp, current.id, archivedAt);
      this.database.exec("COMMIT");
      return this.getTask(current.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#assertTaskWritable(task);
      this.#assertTaskWritable(relatedTask);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, now());
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#assertTaskWritable(task);
      this.#assertTaskWritable(relatedTask);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskOrchestration(parentId) {
    const row = this.database.prepare(`
      SELECT * FROM task_orchestrations WHERE parent_task_id = ?
    `).get(parentId);
    if (!row) return null;
    return {
      ...orchestrationFromRow(row),
      children: this.listTaskOrchestrationChildren(parentId),
    };
  }

  getTaskExecutionOverview(parentId) {
    const rows = this.database.prepare(`
      WITH parent AS (
        SELECT id
        FROM tasks
        WHERE id = ? OR identifier = ? OR id = (
          SELECT task_id FROM task_identifier_aliases WHERE identifier = ?
        )
        LIMIT 1
      ),
      child_candidates AS (
        SELECT
          relations.target_task_id AS task_id,
          0 AS source_rank,
          relations.created_at AS source_created_at
        FROM task_relations AS relations
        JOIN parent ON parent.id = relations.source_task_id
        WHERE relations.relation_type = 'parent'
        UNION ALL
        SELECT
          orchestration_children.task_id,
          1 AS source_rank,
          orchestration_children.created_at AS source_created_at
        FROM task_orchestration_children AS orchestration_children
        JOIN parent ON parent.id = orchestration_children.parent_task_id
      ),
      child_ids AS (
        SELECT
          task_id,
          MIN(source_rank) AS source_rank,
          MIN(source_created_at) AS source_created_at
        FROM child_candidates
        GROUP BY task_id
      ),
      latest_handoffs AS (
        SELECT
          handoffs.*,
          ROW_NUMBER() OVER (
            PARTITION BY handoffs.child_task_id
            ORDER BY handoffs.queue_seq DESC, handoffs.id DESC
          ) AS handoff_rank
        FROM task_handoffs AS handoffs
        JOIN parent ON parent.id = handoffs.parent_task_id
      ),
      latest_worker_dispatches AS (
        SELECT
          dispatches.task_id,
          dispatches.thread_id,
          threads.codex_thread_id,
          ROW_NUMBER() OVER (
            PARTITION BY dispatches.task_id
            ORDER BY dispatches.created_at DESC, dispatches.updated_at DESC, dispatches.dispatch_key DESC
          ) AS dispatch_rank
        FROM task_orchestration_dispatches AS dispatches
        JOIN parent ON parent.id = dispatches.parent_task_id
        LEFT JOIN ai_chat_threads AS threads ON threads.id = dispatches.thread_id
        WHERE dispatches.task_id IS NOT NULL
          AND dispatches.role = 'worker'
          AND dispatches.kind IN ('worker', 'worker_attempt')
          AND dispatches.thread_id IS NOT NULL
      )
      SELECT
        parents.id AS parent_id,
        parents.identifier AS parent_identifier,
        parents.project_id AS parent_project_id,
        parents.title AS parent_title,
        parents.status AS parent_status,
        parents.priority AS parent_priority,
        parents.archived_at AS parent_archived_at,
        orchestrations.parent_task_id AS orchestration_parent_task_id,
        orchestrations.status AS orchestration_status,
        orchestrations.planner_dispatch_key AS orchestration_planner_dispatch_key,
        orchestrations.planner_thread_id AS orchestration_planner_thread_id,
        orchestrations.planner_run_id AS orchestration_planner_run_id,
        orchestrations.plan_json AS orchestration_plan_json,
        orchestrations.error AS orchestration_error,
        orchestrations.created_at AS orchestration_created_at,
        orchestrations.updated_at AS orchestration_updated_at,
        children.id AS child_id,
        children.identifier AS child_identifier,
        children.title AS child_title,
        children.status AS child_status,
        children.priority AS child_priority,
        children.archived_at AS child_archived_at,
        children.version AS child_version,
        handoffs.id AS handoff_id,
        handoffs.queue_seq AS handoff_queue_seq,
        handoffs.delivery_summary AS handoff_delivery,
        handoffs.blocker_summary AS handoff_blocker,
        handoffs.latest_comment_json AS handoff_latest_comment_json,
        handoffs.source_kind AS handoff_source_kind,
        handoffs.state AS handoff_state,
        worker_dispatches.thread_id AS worker_ai_thread_id,
        worker_dispatches.codex_thread_id AS worker_codex_thread_id
      FROM tasks AS parents
      JOIN parent ON parent.id = parents.id
      LEFT JOIN task_orchestrations AS orchestrations
        ON orchestrations.parent_task_id = parents.id
      LEFT JOIN child_ids
        ON TRUE
      LEFT JOIN tasks AS children
        ON children.id = child_ids.task_id
      LEFT JOIN latest_handoffs AS handoffs
        ON handoffs.child_task_id = children.id
        AND handoffs.handoff_rank = 1
      LEFT JOIN latest_worker_dispatches AS worker_dispatches
        ON worker_dispatches.task_id = children.id
        AND worker_dispatches.dispatch_rank = 1
      ORDER BY child_ids.source_rank, child_ids.source_created_at, children.identifier
    `).all(parentId, parentId, parentId);

    if (rows.length === 0) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${parentId}' does not exist`);
    }

    const first = rows[0];
    const overview = {
      parent: {
        id: first.parent_id,
        identifier: first.parent_identifier,
        projectId: first.parent_project_id,
        title: first.parent_title,
        status: first.parent_status,
        priority: first.parent_priority,
        archivedAt: first.parent_archived_at,
      },
      orchestration: first.orchestration_parent_task_id
        ? {
            parentId: first.orchestration_parent_task_id,
            status: first.orchestration_status,
            plannerDispatchKey: first.orchestration_planner_dispatch_key,
            plannerThreadId: first.orchestration_planner_thread_id,
            plannerRunId: first.orchestration_planner_run_id,
            plan: parseJsonColumn(first.orchestration_plan_json, null),
            error: first.orchestration_error,
            createdAt: first.orchestration_created_at,
            updatedAt: first.orchestration_updated_at,
          }
        : null,
      children: rows
        .filter((row) => row.child_id !== null)
        .map((row) => ({
          id: row.child_id,
          identifier: row.child_identifier,
          title: row.child_title,
          status: row.child_status,
          priority: row.child_priority,
          archivedAt: row.child_archived_at,
          version: row.child_version,
          handoff: row.handoff_id
            ? {
                id: row.handoff_id,
                queueSeq: row.handoff_queue_seq,
                delivery: row.handoff_delivery,
                blocker: row.handoff_blocker,
                summary: row.handoff_delivery ?? row.handoff_blocker ?? "",
                latestComment: parseJsonColumn(row.handoff_latest_comment_json, null),
                sourceKind: row.handoff_source_kind,
                state: row.handoff_state,
              }
            : null,
          aiThreadId: row.worker_ai_thread_id ?? null,
          codexThreadId: row.worker_codex_thread_id ?? null,
        })),
    };
    return overview;
  }

  listTaskOrchestrations() {
    return this.database.prepare(`
      SELECT * FROM task_orchestrations
      ORDER BY created_at, parent_task_id
    `).all().map((row) => ({
      ...orchestrationFromRow(row),
      children: this.listTaskOrchestrationChildren(row.parent_task_id),
    }));
  }

  listTaskOrchestrationChildren(parentId) {
    return this.database.prepare(`
      SELECT * FROM task_orchestration_children
      WHERE parent_task_id = ?
      ORDER BY child_key
    `).all(parentId).map(orchestrationChildFromRow);
  }

  getTaskOrchestrationChildByTask(taskId) {
    const row = this.database.prepare(`
      SELECT * FROM task_orchestration_children WHERE task_id = ?
    `).get(taskId);
    return row ? orchestrationChildFromRow(row) : null;
  }

  beginTaskOrchestration(parentId, plannerDispatchKey) {
    if (typeof plannerDispatchKey !== "string" || !plannerDispatchKey.trim()) {
      throw new ApiError(400, "INVALID_DISPATCH_KEY", "A planner dispatch key is required");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM task_orchestrations WHERE parent_task_id = ?
      `).get(parentId);
      if (existing) {
        this.database.exec("COMMIT");
        return this.getTaskOrchestration(parentId);
      }
      const task = this.#requireTask(parentId);
      if (task.archivedAt !== null || task.relations.parent !== null || !task.labels.includes("主任务")) {
        throw new ApiError(
          409,
          "TASK_NOT_ELIGIBLE_FOR_ORCHESTRATION",
          "Only active top-level tasks labelled 主任务 can enter orchestration",
        );
      }
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO task_orchestrations (
          parent_task_id, status, planner_dispatch_key, created_at, updated_at
        ) VALUES (?, 'planning', ?, ?, ?)
      `).run(parentId, plannerDispatchKey, timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO task_orchestration_dispatches (
          dispatch_key, parent_task_id, task_id, kind, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'planner', 'planner', 'claimed', ?, ?)
      `).run(plannerDispatchKey, parentId, parentId, timestamp, timestamp);
      this.database.exec("COMMIT");
      return this.getTaskOrchestration(parentId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  retryTaskOrchestration(parentId, plannerDispatchKey) {
    if (typeof plannerDispatchKey !== "string" || !plannerDispatchKey.trim()) {
      throw new ApiError(400, "INVALID_DISPATCH_KEY", "A planner retry dispatch key is required");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertTaskActiveNoTransaction(parentId);
      const current = this.database.prepare(`
        SELECT * FROM task_orchestrations WHERE parent_task_id = ?
      `).get(parentId);
      if (!current) {
        throw new ApiError(404, "TASK_ORCHESTRATION_NOT_FOUND", `Orchestration for '${parentId}' does not exist`);
      }
      if (current.status !== "failed") {
        this.database.exec("COMMIT");
        return { orchestration: this.getTaskOrchestration(parentId), created: false };
      }
      const existingDispatch = this.database.prepare(`
        SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
      `).get(plannerDispatchKey);
      if (existingDispatch) {
        this.#assertDispatchFingerprint(existingDispatch, {
          parentId,
          taskId: parentId,
          kind: "planner",
          role: "planner",
        });
        this.database.exec("COMMIT");
        return { orchestration: this.getTaskOrchestration(parentId), created: false };
      }
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO task_orchestration_dispatches (
          dispatch_key, parent_task_id, task_id, kind, role, status, thread_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'planner', 'planner', 'claimed', ?, ?, ?)
      `).run(
        plannerDispatchKey,
        parentId,
        parentId,
        current.planner_thread_id,
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        UPDATE task_orchestrations
        SET status = 'planning', planner_dispatch_key = ?, planner_run_id = NULL,
            error = NULL, updated_at = ?
        WHERE parent_task_id = ? AND status = 'failed'
      `).run(plannerDispatchKey, timestamp, parentId);
      this.database.exec("COMMIT");
      return { orchestration: this.getTaskOrchestration(parentId), created: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTaskOrchestration(parentId, changes) {
    this.#assertTaskActiveNoTransaction(parentId);
    const columns = {
      status: "status",
      plannerThreadId: "planner_thread_id",
      plannerRunId: "planner_run_id",
      plan: "plan_json",
      error: "error",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(key === "plan" && changes[key] !== null
        ? JSON.stringify(changes[key])
        : changes[key]);
    }
    if (assignments.length === 0) return this.getTaskOrchestration(parentId);
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), parentId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE task_orchestrations SET ${assignments.join(", ")} WHERE parent_task_id = ?
      `).run(...values);
      if (result.changes !== 1) {
        throw new ApiError(404, "TASK_ORCHESTRATION_NOT_FOUND", `Orchestration for '${parentId}' does not exist`);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTaskOrchestration(parentId);
  }

  getTaskDispatch(dispatchKey) {
    const row = this.database.prepare(`
      SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
    `).get(dispatchKey);
    return taskDispatchFromRow(row);
  }

  findTaskDispatchForTask(taskId, role) {
    const row = this.database.prepare(`
      SELECT * FROM task_orchestration_dispatches
      WHERE task_id = ? AND role = ?
      ORDER BY created_at DESC, dispatch_key DESC
      LIMIT 1
    `).get(taskId, role);
    return taskDispatchFromRow(row);
  }

  findOpenTaskDispatch(taskId, role) {
    const dispatch = this.findTaskDispatchForTask(taskId, role);
    return dispatch && ["claimed", "running"].includes(dispatch.status) ? dispatch : null;
  }

  listTaskDispatches(parentId) {
    return this.database.prepare(`
      SELECT * FROM task_orchestration_dispatches
      WHERE parent_task_id = ?
      ORDER BY created_at, dispatch_key
    `).all(parentId).map(taskDispatchFromRow);
  }

  #assertDispatchFingerprint(current, expected) {
    const actual = {
      parentId: current.parent_task_id ?? null,
      childKey: current.child_key ?? null,
      taskId: current.task_id ?? null,
      kind: current.kind ?? null,
      role: current.role ?? null,
    };
    for (const key of ["parentId", "childKey", "taskId", "kind", "role"]) {
      if (actual[key] !== (expected[key] ?? null)) {
        throw new ApiError(
          409,
          "DISPATCH_KEY_CONFLICT",
          `Dispatch key fingerprint mismatch for '${key}'`,
        );
      }
    }
  }

  getTaskHandoff(id) {
    const row = this.database.prepare("SELECT * FROM task_handoffs WHERE id = ?").get(id);
    return taskHandoffFromRow(row);
  }

  getTaskHandoffByRun(runId) {
    const row = this.database.prepare("SELECT * FROM task_handoffs WHERE run_id = ?").get(runId);
    return taskHandoffFromRow(row);
  }

  getTaskHandoffBySolDispatch(dispatchKey) {
    const row = this.database.prepare(
      "SELECT * FROM task_handoffs WHERE sol_dispatch_key = ?",
    ).get(dispatchKey);
    return taskHandoffFromRow(row);
  }

  listTaskHandoffs(parentId, states = null) {
    const values = [parentId];
    let stateClause = "";
    if (Array.isArray(states) && states.length > 0) {
      stateClause = `AND state IN (${states.map(() => "?").join(", ")})`;
      values.push(...states);
    }
    return this.database.prepare(`
      SELECT * FROM task_handoffs
      WHERE parent_task_id = ? ${stateClause}
      ORDER BY queue_seq, id
    `).all(...values).map(taskHandoffFromRow);
  }

  requeueStaleTaskHandoffs(parentId = null) {
    const values = [];
    const parentClause = parentId === null ? "" : "AND parent_task_id = ?";
    if (parentId !== null) values.push(parentId);
    const rows = this.database.prepare(`
      SELECT task_handoffs.id, task_handoffs.sol_dispatch_key,
             task_orchestration_dispatches.status AS dispatch_status,
             ai_chat_runs.status AS run_status
      FROM task_handoffs
      JOIN tasks AS child_tasks ON child_tasks.id = task_handoffs.child_task_id
      JOIN tasks AS parent_tasks ON parent_tasks.id = task_handoffs.parent_task_id
      LEFT JOIN task_orchestration_dispatches
        ON task_orchestration_dispatches.dispatch_key = task_handoffs.sol_dispatch_key
      LEFT JOIN ai_chat_runs
        ON ai_chat_runs.id = task_orchestration_dispatches.run_id
      WHERE task_handoffs.state = 'processing'
        AND child_tasks.archived_at IS NULL
        AND parent_tasks.archived_at IS NULL
        ${parentClause}
    `).all(...values);
    let count = 0;
    for (const row of rows) {
      if (row.dispatch_status === "completed" && row.run_status === "completed") continue;
      if (row.dispatch_status === "running" && row.run_status === "running") continue;
      const result = this.retryTaskHandoff(row.id, "Recovered stale planner handoff after server restart");
      if (result.retried || result.exhausted) count += 1;
    }
    return count;
  }

  failTaskHandoff(handoffId, errorMessage) {
    return this.retryTaskHandoff(handoffId, errorMessage);
  }

  retryTaskHandoff(handoffId, errorMessage) {
    const message = String(errorMessage || "Planner handoff coordination failed").slice(0, 65_536);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(
        "SELECT * FROM task_handoffs WHERE id = ?",
      ).get(handoffId);
      if (!current) {
        throw new ApiError(404, "TASK_HANDOFF_NOT_FOUND", `Task handoff '${handoffId}' does not exist`);
      }
      if (!["resolved", "stopped", "failed", "obsolete"].includes(current.state)) {
        this.#assertTaskActiveNoTransaction(current.parent_task_id);
        this.#assertTaskActiveNoTransaction(current.child_task_id);
        const timestamp = now();
        const retryCount = current.retry_count + 1;
        const exhausted = retryCount > 3;
        this.database.prepare(`
          UPDATE task_handoffs
          SET state = ?, retry_count = ?, error = ?, last_error = ?,
              sol_dispatch_key = CASE WHEN ? THEN sol_dispatch_key ELSE NULL END,
              sol_run_id = CASE WHEN ? THEN sol_run_id ELSE NULL END,
              updated_at = ?
          WHERE id = ?
        `).run(
          exhausted ? "failed" : "pending",
          retryCount,
          message,
          message,
          exhausted ? 1 : 0,
          exhausted ? 1 : 0,
          timestamp,
          handoffId,
        );
        if (current.sol_dispatch_key) {
          this.database.prepare(`
            UPDATE task_orchestration_dispatches
            SET status = 'failed', error = ?, updated_at = ?
            WHERE dispatch_key = ? AND status IN ('claimed', 'running')
            `).run(message, timestamp, current.sol_dispatch_key);
        }
        if (exhausted) {
          const body = JSON.stringify({
            type: "task_handoff_retry_exhausted",
            handoffId,
            retryCount,
            error: message,
          });
          const commentId = randomUUID();
          this.database.prepare(`
            INSERT INTO comments (
              id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
              version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'agent', 'codex-agent', 'Codex Agent', NULL, 1, ?, ?)
        `).run(commentId, current.child_task_id, body, current.codex_thread_id ?? null, timestamp, timestamp);
        }
        this.database.exec("COMMIT");
        return {
          handoff: this.getTaskHandoff(handoffId),
          retried: !exhausted,
          exhausted,
          comment: exhausted ? this.listComments(current.child_task_id).at(-1) : null,
        };
      }
      this.database.exec("COMMIT");
      return { handoff: this.getTaskHandoff(handoffId), retried: false, exhausted: false, comment: null };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextTaskHandoff(parentId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId);
      if (!parent || parent.archived_at !== null) {
        this.database.exec("COMMIT");
        return { created: false, handoff: null, dispatch: null, reason: "ARCHIVED" };
      }
      const processing = this.database.prepare(`
        SELECT * FROM task_handoffs
        WHERE parent_task_id = ? AND state IN ('processing', 'attempt_pending')
        ORDER BY queue_seq, id LIMIT 1
      `).get(parentId);
      if (processing) {
        const child = this.database.prepare("SELECT archived_at FROM tasks WHERE id = ?").get(processing.child_task_id);
        if (!child || child.archived_at !== null) {
          this.database.exec("COMMIT");
          return { created: false, handoff: null, dispatch: null, reason: "ARCHIVED" };
        }
        const dispatch = processing.sol_dispatch_key
          ? this.database.prepare(`
              SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
            `).get(processing.sol_dispatch_key)
          : processing.worker_attempt_dispatch_key
            ? this.database.prepare(`
                SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
              `).get(processing.worker_attempt_dispatch_key)
            : null;
        this.database.exec("COMMIT");
        return {
          created: false,
          handoff: taskHandoffFromRow(processing),
          dispatch: taskDispatchFromRow(dispatch),
        };
      }
      const current = this.database.prepare(
        `SELECT * FROM task_handoffs
         WHERE parent_task_id = ? AND state = 'pending'
         ORDER BY queue_seq, id LIMIT 1`,
      ).get(parentId);
      if (!current) {
        this.database.exec("COMMIT");
        return { created: false, handoff: null, dispatch: null };
      }
      const child = this.database.prepare("SELECT archived_at FROM tasks WHERE id = ?").get(current.child_task_id);
      if (!child || child.archived_at !== null) {
        this.database.exec("COMMIT");
        return { created: false, handoff: null, dispatch: null, reason: "ARCHIVED" };
      }
      const attempt = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM task_orchestration_dispatches
        WHERE parent_task_id = ? AND kind = 'handoff'
      `).get(current.parent_task_id).count + 1;
      const dispatchKey = `task-orchestration:${current.parent_task_id}:handoff:${current.id}:sol:${attempt}`;
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO task_orchestration_dispatches (
          dispatch_key, parent_task_id, task_id, kind, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'handoff', 'planner', 'claimed', ?, ?)
      `).run(dispatchKey, current.parent_task_id, current.child_task_id, timestamp, timestamp);
      this.database.prepare(`
        UPDATE task_handoffs
        SET state = 'processing', sol_dispatch_key = ?, sol_run_id = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(dispatchKey, timestamp, current.id);
      this.database.exec("COMMIT");
      return {
        created: true,
        handoff: this.getTaskHandoff(current.id),
        dispatch: this.getTaskDispatch(dispatchKey),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  applyTaskHandoffSolution(handoffId, solution) {
    const aliases = { confirm_delivery: "acknowledge" };
    const action = aliases[solution?.action] ?? solution?.action;
    const actions = new Set([
      "acknowledge",
      "request_evidence",
      "resume",
      "revise",
      "create_remediation",
      "stop",
    ]);
    if (!actions.has(action)) {
      throw new ApiError(400, "INVALID_HANDOFF_SOLUTION", "Planner returned an unsupported handoff action");
    }
    const serializedSolution = JSON.stringify({ ...solution, action });
    if (serializedSolution.length > 100_000) {
      throw new ApiError(400, "INVALID_HANDOFF_SOLUTION", "Handoff solution is too large");
    }

    let workerDispatch = null;
    let remediation = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(
        "SELECT * FROM task_handoffs WHERE id = ?",
      ).get(handoffId);
      if (!current) {
        throw new ApiError(404, "TASK_HANDOFF_NOT_FOUND", `Task handoff '${handoffId}' does not exist`);
      }
      if (current.state !== "processing") {
        this.database.exec("COMMIT");
        return {
          handoff: this.getTaskHandoff(handoffId),
          task: this.getTask(current.child_task_id),
          workerDispatch: null,
          remediation: null,
          created: false,
        };
      }
      this.#assertTaskActiveNoTransaction(current.parent_task_id);
      this.#assertTaskActiveNoTransaction(current.child_task_id);

      if (
        typeof solution?.handoffId !== "string"
        || !Number.isInteger(solution?.sourceTaskVersion)
        || typeof solution?.sourceTaskStatus !== "string"
      ) {
        throw new ApiError(
          400,
          "INVALID_HANDOFF_SOLUTION",
          "Planner must return handoffId, sourceTaskVersion, and sourceTaskStatus",
        );
      }
      const sourceTask = this.database.prepare(
        "SELECT version, status FROM tasks WHERE id = ?",
      ).get(current.child_task_id);
      if (
        solution.handoffId !== current.id
        || solution.sourceTaskVersion !== current.source_task_version
        || solution.sourceTaskStatus !== current.source_task_status
        || sourceTask?.version !== current.source_task_version
        || sourceTask?.status !== current.source_task_status
      ) {
        const timestamp = now();
        this.database.prepare(`
          UPDATE task_handoffs
          SET state = 'obsolete', error = ?, last_error = ?, updated_at = ?
          WHERE id = ? AND state = 'processing'
        `).run("The planner handoff solution is obsolete", "The source task changed before solution application", timestamp, handoffId);
        this.database.exec("COMMIT");
        return {
          handoff: this.getTaskHandoff(handoffId),
          task: this.getTask(current.child_task_id),
          workerDispatch: null,
          remediation: null,
          created: false,
          obsolete: true,
        };
      }

      const allowedActions = current.child_status === "completed"
        ? new Set(["acknowledge", "request_evidence"])
        : current.child_status === "canceled"
          ? new Set(["acknowledge", "stop"])
        : new Set(["acknowledge", "resume", "revise", "create_remediation", "stop"]);
      if (!allowedActions.has(action)) {
        throw new ApiError(
          400,
          "INVALID_HANDOFF_SOLUTION",
          `Handoff action '${action}' is not valid for a ${current.child_status} handoff`,
        );
      }

      if (["request_evidence", "resume", "revise"].includes(action)) {
        workerDispatch = this.#claimWorkerAttemptNoTransaction({
          parentId: current.parent_task_id,
          taskId: current.child_task_id,
          dispatchKey: `task-orchestration:${current.parent_task_id}:handoff:${current.id}:worker:${action}`,
          action,
        });
      } else if (action === "create_remediation") {
        remediation = this.#createRemediationNoTransaction(current, solution.remediation);
      }

      const timestamp = now();
      this.database.prepare(`
        UPDATE task_handoffs
        SET state = ?, solution_json = ?, solution_action = ?, attempt_action = ?,
            worker_attempt_dispatch_key = ?, error = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'processing'
      `).run(
        ["request_evidence", "resume", "revise"].includes(action)
          ? "attempt_pending"
          : action === "stop" ? "stopped" : "resolved",
        serializedSolution,
        action,
        ["request_evidence", "resume", "revise"].includes(action) ? action : null,
        workerDispatch?.dispatch.dispatchKey ?? null,
        timestamp,
        handoffId,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const handoff = this.getTaskHandoff(handoffId);
    return {
      handoff,
      task: this.getTask(handoff.childTaskId),
      workerDispatch: workerDispatch?.dispatch ?? null,
      remediation: remediation?.task ?? null,
      remediationCreated: Boolean(remediation?.created),
      created: true,
    };
  }

  claimTaskDispatch(input) {
    if (typeof input.dispatchKey !== "string" || !input.dispatchKey.trim()) {
      throw new ApiError(400, "INVALID_DISPATCH_KEY", "A dispatch key is required");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
      `).get(input.dispatchKey);
      if (existing) {
        this.#assertDispatchFingerprint(existing, {
          parentId: input.parentId ?? null,
          childKey: input.childKey ?? null,
          taskId: input.taskId ?? null,
          kind: input.kind ?? input.role,
          role: input.role ?? null,
        });
        const task = existing.task_id
          ? this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.task_id)
          : null;
        const parent = existing.parent_task_id
          ? this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.parent_task_id)
          : null;
        if (task?.archived_at != null) this.#assertTaskActiveNoTransaction(task.id);
        if (parent?.archived_at != null) this.#assertTaskActiveNoTransaction(parent.id);
        this.database.exec("COMMIT");
        return { dispatch: taskDispatchFromRow(existing), created: false };
      }
      if (input.taskId) this.#assertTaskActiveNoTransaction(input.taskId);
      if (input.parentId) this.#assertTaskActiveNoTransaction(input.parentId);
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO task_orchestration_dispatches (
          dispatch_key, parent_task_id, child_key, task_id, kind, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)
      `).run(
        input.dispatchKey,
        input.parentId ?? null,
        input.childKey ?? null,
        input.taskId ?? null,
        input.kind ?? input.role,
        input.role,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return { dispatch: this.getTaskDispatch(input.dispatchKey), created: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  bindTaskDispatch(dispatchKey, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
      `).get(dispatchKey);
      if (!current) {
        throw new ApiError(404, "DISPATCH_NOT_FOUND", `Dispatch '${dispatchKey}' does not exist`);
      }
      if (current.parent_task_id) this.#assertTaskActiveNoTransaction(current.parent_task_id);
      if (current.task_id) this.#assertTaskActiveNoTransaction(current.task_id);
      if (current.thread_id) {
        const boundThread = this.database.prepare(
          "SELECT * FROM ai_chat_threads WHERE id = ?",
        ).get(current.thread_id);
        if (boundThread) this.#assertAiChatThreadActiveNoTransaction(boundThread);
      }
      const requestedThreadId = input.threadId ?? current.thread_id ?? null;
      if (current.thread_id && requestedThreadId !== current.thread_id) {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The dispatch is bound to a different thread");
      }
      if (current.run_id && input.runId && current.run_id !== input.runId) {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The dispatch is bound to a different run");
      }
      if (input.runId) {
        const run = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(input.runId);
        if (!run || run.thread_id !== requestedThreadId) {
          throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The run does not belong to the dispatch thread");
        }
        if (run.dispatch_key !== null && run.dispatch_key !== dispatchKey) {
          throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The run is already bound to another dispatch");
        }
      }
      const isExactReplay = current.status !== "claimed"
        && current.thread_id === requestedThreadId
        && (!input.runId || current.run_id === input.runId)
        && (!input.status || current.status === input.status);
      if (isExactReplay) {
        this.database.exec("COMMIT");
        return taskDispatchFromRow(current);
      }
      if (current.status !== "claimed") {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "Only a claimed dispatch with an empty binding can be bound");
      }
      const timestamp = now();
      if (input.runId) {
        const runBinding = this.database.prepare(`
          UPDATE ai_chat_runs
          SET dispatch_key = ?
          WHERE id = ? AND (dispatch_key IS NULL OR dispatch_key = ?)
        `).run(dispatchKey, input.runId, dispatchKey);
        if (runBinding.changes !== 1) {
          throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The run dispatch binding compare-and-set failed");
        }
        this.database.prepare(`
          UPDATE task_handoffs
          SET sol_run_id = ?, updated_at = ?
          WHERE sol_dispatch_key = ?
        `).run(input.runId, timestamp, dispatchKey);
      }
      const status = input.status ?? (input.runId ? "running" : current.status);
      const result = this.database.prepare(`
        UPDATE task_orchestration_dispatches
        SET thread_id = COALESCE(?, thread_id), run_id = COALESCE(?, run_id), status = ?, updated_at = ?
        WHERE dispatch_key = ?
          AND status = 'claimed'
          AND (thread_id IS NULL OR thread_id = ?)
          AND (run_id IS NULL OR run_id = ?)
      `).run(input.threadId ?? null, input.runId ?? null, status, timestamp, dispatchKey, requestedThreadId, input.runId ?? null);
      if (result.changes !== 1) {
        throw new ApiError(409, "DISPATCH_BIND_CONFLICT", "The dispatch binding compare-and-set failed");
      }
      this.database.exec("COMMIT");
      return this.getTaskDispatch(dispatchKey);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimReadyWorkerDispatch(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
      `).get(input.dispatchKey);
      if (existing) {
        this.#assertDispatchFingerprint(existing, {
          parentId: input.parentId,
          childKey: input.childKey,
          taskId: input.taskId,
          kind: "worker",
          role: "worker",
        });
        const task = existing.task_id
          ? this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.task_id)
          : null;
        const parent = existing.parent_task_id
          ? this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.parent_task_id)
          : null;
        if (task?.archived_at != null || parent?.archived_at != null) {
          this.database.exec("COMMIT");
          return {
            ready: false,
            created: false,
            reason: "ARCHIVED",
            dispatch: taskDispatchFromRow(existing),
            task: task ? taskFromRow(task) : null,
          };
        }
        this.database.exec("COMMIT");
        return {
          ready: true,
          created: false,
          dispatch: taskDispatchFromRow(existing),
          task: this.getTask(input.taskId),
        };
      }
      const task = this.#requireTask(input.taskId);
      const parent = this.#requireTask(input.parentId);
      this.#assertTaskWritable(parent);
      const mapping = this.database.prepare(`
        SELECT 1 FROM task_orchestration_children
        WHERE parent_task_id = ? AND child_key = ? AND task_id = ?
      `).get(input.parentId, input.childKey, input.taskId);
      if (!mapping) {
        throw new ApiError(409, "ORCHESTRATION_CHILD_NOT_FOUND", "The orchestration child mapping does not exist");
      }
      if (task.archivedAt !== null) {
        this.database.exec("COMMIT");
        return { ready: false, created: false, reason: "ARCHIVED", dispatch: null, task };
      }
      if (!["backlog", "todo", "in_progress"].includes(task.status)) {
        this.database.exec("COMMIT");
        return { ready: false, created: false, reason: "TASK_NOT_DISPATCHABLE", dispatch: null, task };
      }
      const unsatisfied = this.database.prepare(`
        SELECT tasks.status, tasks.archived_at
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.source_task_id
        WHERE task_relations.relation_type = 'blocks'
          AND task_relations.target_task_id = ?
          AND (tasks.archived_at IS NOT NULL OR tasks.status NOT IN ('in_review', 'done'))
        LIMIT 1
      `).get(task.id);
      if (unsatisfied) {
        this.database.exec("COMMIT");
        return { ready: false, created: false, reason: "DEPENDENCY_NOT_SATISFIED", dispatch: null, task };
      }

      const timestamp = now();
      this.database.prepare(`
        INSERT INTO task_orchestration_dispatches (
          dispatch_key, parent_task_id, child_key, task_id, kind, role, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'worker', 'worker', 'claimed', ?, ?)
      `).run(input.dispatchKey, input.parentId, input.childKey, task.id, timestamp, timestamp);
      if (task.status === "backlog") {
        this.database.prepare(`
          UPDATE tasks SET status = 'todo', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'backlog' AND archived_at IS NULL
        `).run(timestamp, task.id);
      }
      if (task.status === "backlog" || task.status === "todo") {
        this.database.prepare(`
          UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'todo' AND archived_at IS NULL
        `).run(timestamp, task.id);
      }
      this.database.exec("COMMIT");
      return {
        ready: true,
        created: true,
        dispatch: this.getTaskDispatch(input.dispatchKey),
        task: this.getTask(task.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  applyTaskPlan(parentId, plan) {
    const entries = normalizePlanEntries(plan);
    const nextPlanJson = canonicalPlan(entries);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const orchestration = this.database.prepare(`
        SELECT * FROM task_orchestrations WHERE parent_task_id = ?
      `).get(parentId);
      if (!orchestration) {
        throw new ApiError(404, "TASK_ORCHESTRATION_NOT_FOUND", `Orchestration for '${parentId}' does not exist`);
      }
      if (["failed", "canceled"].includes(orchestration.status)) {
        throw new ApiError(409, "TASK_ORCHESTRATION_TERMINAL", "The task orchestration is already terminal");
      }
      if (orchestration.plan_json && canonicalPlan(normalizePlanEntries(parseJsonColumn(orchestration.plan_json, []))) !== nextPlanJson) {
        throw new ApiError(409, "PLAN_CONFLICT", "A different task plan is already persisted for this parent");
      }
      const parent = this.#requireTask(parentId);
      this.#assertTaskWritable(parent);
      const taskByKey = new Map();
      const createdTaskIds = [];
      const adoptedTaskIds = [];
      for (const entry of entries) {
        const existingMapping = this.database.prepare(`
          SELECT * FROM task_orchestration_children
          WHERE parent_task_id = ? AND child_key = ?
        `).get(parentId, entry.childKey);
        let result;
        if (existingMapping) {
          result = { task: this.#requireTask(existingMapping.task_id), created: false, adopted: false };
        } else {
          const adoptable = this.database.prepare(`
            SELECT tasks.*
            FROM tasks
            JOIN task_relations
              ON task_relations.relation_type = 'parent'
              AND task_relations.source_task_id = ?
              AND task_relations.target_task_id = tasks.id
            WHERE tasks.identifier = ?
              AND tasks.project_id = ?
              AND tasks.archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM task_orchestration_children
                WHERE task_orchestration_children.task_id = tasks.id
              )
            LIMIT 1
          `).get(parentId, entry.childKey, parent.projectId);
          if (adoptable) {
            result = { task: taskFromRow(adoptable), created: false, adopted: true };
          } else {
            const idempotencyKey = `task-orchestration:${parentId}:${entry.childKey}`;
            result = this.#createTaskIdempotentlyNoTransaction({
              projectId: parent.projectId,
              title: entry.title,
              description: entry.description,
              status: "backlog",
              priority: parent.priority,
              labels: [],
              actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
              assignee: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
              workflowId: null,
              developmentContext: null,
              dueDate: null,
              recurrence: null,
            }, idempotencyKey);
          }
        }
        if (result.created) createdTaskIds.push(result.task.id);
        if (result.adopted) adoptedTaskIds.push(result.task.id);
        const mappingValues = [
          parentId,
          entry.childKey,
          result.task.id,
          entry.title,
          entry.description,
          JSON.stringify(entry.acceptance),
          JSON.stringify(entry.ownership),
          JSON.stringify(entry.files),
          JSON.stringify(entry.dependsOn),
        ];
        if (existingMapping) {
          const existingFingerprint = JSON.stringify([
            existingMapping.task_id,
            existingMapping.title,
            existingMapping.description,
            parseJsonColumn(existingMapping.acceptance_json, []),
            parseJsonColumn(existingMapping.ownership_json, null),
            parseJsonColumn(existingMapping.files_json, []),
            parseJsonColumn(existingMapping.depends_on_json, []),
          ]);
          const nextFingerprint = JSON.stringify([
            result.task.id,
            entry.title,
            entry.description,
            entry.acceptance,
            entry.ownership,
            entry.files,
            entry.dependsOn,
          ]);
          if (existingFingerprint !== nextFingerprint) {
            throw new ApiError(409, "PLAN_CONFLICT", `Plan child '${entry.childKey}' conflicts with persisted mapping`);
          }
        } else {
          const timestamp = now();
          this.database.prepare(`
            INSERT INTO task_orchestration_children (
              parent_task_id, child_key, task_id, title, description,
              acceptance_json, ownership_json, files_json, depends_on_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(...mappingValues, timestamp, timestamp);
        }
        taskByKey.set(entry.childKey, result.task.id);
      }

      for (const entry of entries) {
        const childTaskId = taskByKey.get(entry.childKey);
        this.#ensurePlanRelationNoTransaction("parent", parent.id, childTaskId);
        for (const dependency of entry.dependsOn) {
          this.#ensurePlanRelationNoTransaction("blocks", taskByKey.get(dependency), childTaskId);
        }
      }
      for (const taskId of adoptedTaskIds) {
        this.#createTaskStatusHandoffNoTransaction({
          taskId,
          summary: "Existing child task was adopted into the orchestration plan",
        });
      }
      const timestamp = now();
      this.database.prepare(`
        UPDATE task_orchestrations
        SET status = 'planned', plan_json = ?, error = NULL, updated_at = ?
        WHERE parent_task_id = ?
      `).run(nextPlanJson, timestamp, parentId);
      this.database.exec("COMMIT");
      return { ...this.getTaskOrchestration(parentId), createdTaskIds, adoptedTaskIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markTaskDispatchFailed(dispatchKey, errorMessage, options = {}) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
      `).get(dispatchKey);
      if (!current) {
        throw new ApiError(404, "DISPATCH_NOT_FOUND", `Dispatch '${dispatchKey}' does not exist`);
      }
      if (current.parent_task_id) this.#assertTaskActiveNoTransaction(current.parent_task_id);
      if (current.task_id) this.#assertTaskActiveNoTransaction(current.task_id);
      if (
        (current.status === "completed" && options.allowCompleted !== true)
        || (current.status === "failed" && current.failure_comment_id)
      ) {
        this.database.exec("COMMIT");
        return taskDispatchFromRow(current);
      }
      if (current.run_id) {
        const run = this.database.prepare("SELECT status FROM ai_chat_runs WHERE id = ?").get(current.run_id);
        if (run?.status === "running") {
          this.database.exec("COMMIT");
          return taskDispatchFromRow(current);
        }
      }
      const timestamp = now();
      const message = String(errorMessage || "Codex dispatch failed").slice(0, 65_536);
      const taskBefore = current.task_id
        ? this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(current.task_id)
        : null;
      let failureCommentId = current.failure_comment_id;
      if (!failureCommentId && current.task_id) {
        failureCommentId = randomUUID();
        const codexThreadId = current.thread_id
          ? this.database.prepare(
              "SELECT codex_thread_id FROM ai_chat_threads WHERE id = ?",
            ).get(current.thread_id)?.codex_thread_id ?? null
          : null;
        this.database.prepare(`
          INSERT INTO comments (
            id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'agent', 'codex-agent', 'Codex Agent', NULL, 1, ?, ?)
        `).run(
          failureCommentId,
          current.task_id,
          `任务编排启动失败：${message}`,
          codexThreadId,
          timestamp,
          timestamp,
        );
      }
      this.database.prepare(`
        UPDATE task_orchestration_dispatches
        SET status = ?, error = ?, failure_comment_id = ?, updated_at = ?
        WHERE dispatch_key = ?
      `).run(
        current.status === "completed" ? "completed" : "failed",
        message,
        failureCommentId,
        timestamp,
        dispatchKey,
      );
      if (current.task_id) {
        this.database.prepare(`
          UPDATE tasks
          SET status = CASE WHEN status IN ('backlog', 'todo', 'in_progress') THEN 'blocked' ELSE status END,
              version = CASE WHEN status IN ('backlog', 'todo', 'in_progress') THEN version + 1 ELSE version END,
              updated_at = ?
          WHERE id = ? AND archived_at IS NULL
        `).run(timestamp, current.task_id);
        const taskAfter = this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(current.task_id);
        if (
          ["backlog", "todo", "in_progress"].includes(taskBefore?.status)
          && taskAfter?.status === "blocked"
        ) {
          this.#createTaskStatusHandoffNoTransaction({
            taskId: current.task_id,
            summary: `Dispatch failed: ${message}`,
            sourceDispatchKey: dispatchKey,
          });
        }
      }
      this.database.exec("COMMIT");
      return this.getTaskDispatch(dispatchKey);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markTaskOrchestrationFailed(parentId, errorMessage) {
    const orchestration = this.getTaskOrchestration(parentId);
    if (!orchestration) throw new ApiError(404, "TASK_ORCHESTRATION_NOT_FOUND", `Orchestration for '${parentId}' does not exist`);
    this.#assertTaskActiveNoTransaction(parentId);
    const dispatch = this.getTaskDispatch(orchestration.plannerDispatchKey);
    if (dispatch) {
      this.markTaskDispatchFailed(
        orchestration.plannerDispatchKey,
        errorMessage,
        { allowCompleted: dispatch.status === "completed" },
      );
    }
    return this.updateTaskOrchestration(parentId, {
      status: "failed",
      error: String(errorMessage || "Task plan failed").slice(0, 65_536),
    });
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.#assertTaskWritable(task);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, ai_thread_id, intent, action,
        author_type, author_id, author_name, author_avatar_url, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      task.id,
      input.body,
      input.threadId ?? null,
      input.aiThreadId ?? null,
      input.intent ?? "comment",
      input.action ?? "comment",
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
      timestamp,
    );
    return this.getComment(id);
  }

  startTaskRework(taskId, version, commentId, aiThreadId) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      this.#assertTaskWritable(task);
      this.#requireVersion(task, version);
      if (task.status !== "in_review") {
        throw new ApiError(409, "TASK_NOT_IN_REVIEW", "Only a task in delivery review can start rework");
      }
      const comment = this.#requireComment(commentId);
      if (comment.taskId !== task.id || comment.authorType !== "user") {
        throw new ApiError(400, "INVALID_REWORK_COMMENT", "Rework must use a user comment from this task");
      }
      if (comment.reworkRound !== null) {
        throw new ApiError(409, "REWORK_ALREADY_STARTED", "This comment already started rework");
      }
      const latestRound = Number(this.database.prepare(`
        SELECT COALESCE(MAX(rework_round), 0) AS round
        FROM comments
        WHERE task_id = ?
      `).get(task.id).round);
      const reworkRound = latestRound + 1;
      const commentResult = this.database.prepare(`
        UPDATE comments
        SET intent = 'resume', action = 'review', rework_round = ?,
            ai_thread_id = COALESCE(?, ai_thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND rework_round IS NULL
      `).run(reworkRound, aiThreadId ?? null, timestamp, comment.id);
      if (commentResult.changes !== 1) {
        throw new ApiError(409, "REWORK_COMMENT_CHANGED", "The rework comment changed before it was submitted");
      }
      const maximum = Number(this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = 'todo' AND archived_at IS NULL AND id != ?
      `).get(task.projectId, task.id).maximum);
      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET status = 'todo', retrospective_status = NULL, rework_round = ?,
            sort_order = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(reworkRound, maximum + 1000, timestamp, task.id, version);
      if (taskResult.changes !== 1) {
        this.#throwMissingOrConflict(task.id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      task: this.getTask(taskId),
      comment: this.getComment(commentId),
    };
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  getReviewRequestCommentByAiThread(aiThreadId) {
    const row = this.database.prepare(`
      SELECT * FROM comments
      WHERE ai_thread_id = ?
        AND author_type = 'user'
        AND intent = 'discussion'
        AND action = 'review'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(aiThreadId);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, aiThreadId) {
    const current = this.#requireComment(id);
    this.#assertTaskWritable(this.#requireTask(current.taskId));
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      UPDATE comments
      SET body = ?,
        thread_id = COALESCE(?, thread_id),
        ai_thread_id = COALESCE(?, ai_thread_id),
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND version = ?
    `).run(body, threadId ?? null, aiThreadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#assertTaskWritable(this.#requireTask(current.taskId));
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.#assertTaskWritable(task);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.#assertTaskWritable(this.#requireTask(comment.taskId));
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const attachment = this.getAttachment(id);
      if (!attachment) {
        throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
      }
      this.#assertTaskWritable(this.#requireTask(attachment.taskId));
      const result = this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
      if (result.changes !== 1) {
        throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
      }
      this.database.exec("COMMIT");
      return attachment;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #insertTaskHandoffNoTransaction({
    sourceKey,
    sourceKind,
    parentId,
    childKey,
    childTaskId,
    runId,
    childStatus,
    taskStatus,
    sourceTaskVersion,
    sourceTaskStatus,
    sourceDispatchKey,
    delivery,
    blocker,
    acceptance = [],
    aiThreadId,
    codexThreadId,
  }) {
    const existing = this.database.prepare(`
      SELECT * FROM task_handoffs
      WHERE source_key = ?
         OR (
           child_task_id = ?
           AND source_task_version = ?
           AND source_task_status = ?
           AND state <> 'obsolete'
         )
      ORDER BY CASE WHEN source_key = ? THEN 0 ELSE 1 END, queue_seq
      LIMIT 1
    `).get(sourceKey, childTaskId, sourceTaskVersion, sourceTaskStatus, sourceKey);
    if (existing) return { handoffId: existing.id, created: false };

    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(childTaskId);
    if (!task) return null;
    const latestCommentRow = this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all(childTaskId).find((row) => !isTaskHandoffComment(row));
    const latestComment = latestCommentRow
      ? this.#commentWithAttachments(latestCommentRow)
      : null;
    if (latestComment?.body?.length > 16_384) latestComment.body = latestComment.body.slice(0, 16_384);
    const queueSeq = this.database.prepare(`
      SELECT COALESCE(MAX(queue_seq), 0) + 1 AS next_seq
      FROM task_handoffs WHERE parent_task_id = ?
    `).get(parentId).next_seq;
    const handoffId = randomUUID();
    const commentId = randomUUID();
    const timestamp = now();
    const commentLatest = latestComment
      ? {
          ...latestComment,
          body: compactHandoffCommentText(latestComment.body, 8_000),
        }
      : null;
    const body = JSON.stringify({
      type: "task_handoff",
      handoffId,
      sourceKey,
      sourceKind,
      queueSeq,
      childKey,
      childTaskId: task.id,
      childIdentifier: task.identifier,
      status: childStatus,
      taskStatus,
      sourceTaskVersion,
      sourceTaskStatus,
      sourceDispatchKey: sourceDispatchKey ?? null,
      delivery: compactHandoffCommentText(delivery, 12_000),
      blocker: compactHandoffCommentText(blocker, 12_000),
      acceptance: Array.isArray(acceptance) ? acceptance : [],
      latestComment: commentLatest,
      aiThreadId: aiThreadId ?? null,
      codexThreadId: codexThreadId ?? null,
      runId: runId ?? null,
    });
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'agent', 'codex-agent', 'Codex Agent', NULL, 1, ?, ?)
    `).run(commentId, task.id, body, codexThreadId ?? null, timestamp, timestamp);
    this.database.prepare(`
      INSERT INTO task_handoffs (
        id, source_key, source_kind, parent_task_id, queue_seq, child_key, child_task_id, run_id,
        child_status, task_status, source_task_version, source_task_status, source_dispatch_key,
        delivery_summary, blocker_summary, latest_comment_json, ai_thread_id, codex_thread_id,
        comment_id, state, solution_json, solution_action, sol_dispatch_key, sol_run_id, error,
        retry_count, last_error, attempt_action, worker_attempt_dispatch_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?)
    `).run(
      handoffId,
      sourceKey,
      sourceKind,
      parentId,
      queueSeq,
      childKey,
      task.id,
      runId ?? null,
      childStatus,
      taskStatus,
      sourceTaskVersion,
      sourceTaskStatus,
      sourceDispatchKey ?? null,
      delivery ?? null,
      blocker ?? null,
      latestComment ? JSON.stringify(latestComment) : null,
      aiThreadId ?? null,
      codexThreadId ?? null,
      commentId,
      timestamp,
      timestamp,
    );
    return { handoffId, created: true };
  }

  #createTaskHandoffNoTransaction({ runId, status, assistantText, error }) {
    const run = this.database.prepare(`
      SELECT ai_chat_runs.*, ai_chat_threads.codex_thread_id
      FROM ai_chat_runs
      JOIN ai_chat_threads ON ai_chat_threads.id = ai_chat_runs.thread_id
      WHERE ai_chat_runs.id = ?
    `).get(runId);
    if (!run) return null;
    const dispatch = this.database.prepare(`
      SELECT dispatch_key, task_id, kind, role, thread_id
      FROM task_orchestration_dispatches
      WHERE run_id = ?
      LIMIT 1
    `).get(runId);
    if (!dispatch || dispatch.role !== "worker" || !["worker", "worker_attempt"].includes(dispatch.kind)) {
      return null;
    }
    const mapping = this.database.prepare(`
      SELECT parent_task_id, child_key, acceptance_json
      FROM task_orchestration_children
      WHERE task_id = ?
      LIMIT 1
    `).get(dispatch.task_id);
    if (!mapping) return null;
    const existing = this.database.prepare(
      "SELECT * FROM task_handoffs WHERE source_key = ?",
    ).get(runId);
    if (existing) return { handoffId: existing.id, created: false };
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(dispatch.task_id);
    if (!task || task.archived_at !== null || !["backlog", "todo", "in_progress"].includes(task.status)) {
      return null;
    }
    const targetStatus = status === "completed" ? "in_review" : "blocked";
    const timestamp = now();
    const updated = this.database.prepare(`
      UPDATE tasks
      SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND archived_at IS NULL
        AND status IN ('backlog', 'todo', 'in_progress')
    `).run(targetStatus, timestamp, task.id, task.version);
    if (updated.changes !== 1) return null;
    const sourceTask = this.database.prepare("SELECT version, status FROM tasks WHERE id = ?").get(task.id);
    const assistant = typeof assistantText === "string" ? assistantText.trim() : "";
    const fallback = typeof error === "string" ? error.trim() : "";
    const summary = (assistant || fallback || (
      status === "completed"
        ? "Worker completed without a delivery summary"
        : "Worker did not provide a blocker summary"
    )).slice(0, 65_536);
    const thread = this.database.prepare(
      "SELECT codex_thread_id FROM ai_chat_threads WHERE id = ?",
    ).get(run.thread_id);
    return this.#insertTaskHandoffNoTransaction({
      sourceKey: runId,
      sourceKind: "run",
      parentId: mapping.parent_task_id,
      childKey: mapping.child_key,
      childTaskId: task.id,
      runId,
      childStatus: status,
      taskStatus: sourceTask.status,
      sourceTaskVersion: sourceTask.version,
      sourceTaskStatus: sourceTask.status,
      sourceDispatchKey: dispatch.dispatch_key,
      delivery: status === "completed" ? summary : null,
      blocker: status === "completed" ? null : summary,
      acceptance: parseJsonColumn(mapping.acceptance_json, []),
      aiThreadId: run.thread_id,
      codexThreadId: thread?.codex_thread_id ?? run.codex_thread_id ?? null,
    });
  }

  #createTaskStatusHandoffNoTransaction({ taskId, summary, sourceDispatchKey = null }) {
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task || !["in_review", "blocked", "canceled"].includes(task.status)) return null;
    const childStatus = task.status === "in_review"
      ? "completed"
      : task.status === "blocked" ? "failed" : "canceled";
    const mapping = this.database.prepare(`
      SELECT parent_task_id, child_key, acceptance_json
      FROM task_orchestration_children WHERE task_id = ? LIMIT 1
    `).get(taskId);
    if (!mapping) return null;
    const workerDispatchWhere = `
      task_id = ?
      AND role = 'worker'
      AND kind IN ('worker', 'worker_attempt')
      AND thread_id IS NOT NULL
    `;
    const dispatch = sourceDispatchKey
      ? this.database.prepare(`
          SELECT dispatch_key, thread_id
          FROM task_orchestration_dispatches
          WHERE dispatch_key = ? AND ${workerDispatchWhere}
        `).get(sourceDispatchKey, taskId)
      : this.database.prepare(`
          SELECT dispatch_key, thread_id
          FROM task_orchestration_dispatches
          WHERE ${workerDispatchWhere}
          ORDER BY updated_at DESC, dispatch_key DESC LIMIT 1
        `).get(taskId);
    const threadId = dispatch?.thread_id ?? null;
    const thread = threadId
      ? this.database.prepare("SELECT codex_thread_id FROM ai_chat_threads WHERE id = ?").get(threadId)
      : null;
    const clipped = String(summary ?? `Task entered ${task.status}`).slice(0, 65_536);
    return this.#insertTaskHandoffNoTransaction({
      sourceKey: `task-status:${task.id}:${task.version}:${task.status}`,
      sourceKind: "task_status",
      parentId: mapping.parent_task_id,
      childKey: mapping.child_key,
      childTaskId: task.id,
      runId: null,
      childStatus,
      taskStatus: task.status,
      sourceTaskVersion: task.version,
      sourceTaskStatus: task.status,
      sourceDispatchKey: dispatch?.dispatch_key ?? null,
      delivery: childStatus === "completed" ? clipped : null,
      blocker: childStatus === "completed" ? null : clipped,
      acceptance: parseJsonColumn(mapping.acceptance_json, []),
      aiThreadId: threadId,
      codexThreadId: thread?.codex_thread_id ?? null,
    });
  }

  #claimWorkerAttemptNoTransaction({ parentId, taskId, dispatchKey, action }) {
    const mapping = this.database.prepare(`
      SELECT child_key
      FROM task_orchestration_children
      WHERE parent_task_id = ? AND task_id = ?
      LIMIT 1
    `).get(parentId, taskId);
    if (!mapping) {
      throw new ApiError(409, "ORCHESTRATION_CHILD_NOT_FOUND", "The handoff child mapping does not exist");
    }
    const existing = this.database.prepare(`
      SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
    `).get(dispatchKey);
    if (existing) {
      this.#assertDispatchFingerprint(existing, {
        parentId,
        childKey: mapping.child_key,
        taskId,
        kind: "worker_attempt",
        role: "worker",
      });
      let replay = existing;
      if (["failed", "unknown"].includes(existing.status) && !existing.run_id) {
        const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
        if (!task || task.archived_at !== null || ["done", "canceled"].includes(task.status)) {
          throw new ApiError(409, "TASK_NOT_RETRYABLE", "An archived, missing, completed, or canceled child task cannot be resumed");
        }
        const activeAttempt = this.database.prepare(`
          SELECT dispatch_key FROM task_orchestration_dispatches
          WHERE task_id = ? AND kind = 'worker_attempt'
            AND status IN ('claimed', 'running') AND dispatch_key <> ?
          LIMIT 1
        `).get(task.id, dispatchKey);
        if (activeAttempt) {
          throw new ApiError(409, "WORKER_ATTEMPT_BUSY", "This child already has a non-terminal worker attempt");
        }
        this.database.prepare(`
          UPDATE task_orchestration_dispatches
          SET status = 'claimed', error = NULL, updated_at = ?
          WHERE dispatch_key = ? AND status IN ('failed', 'unknown') AND run_id IS NULL
        `).run(now(), dispatchKey);
        if (task.status !== "in_progress") {
          const updatedTask = this.database.prepare(`
            UPDATE tasks
            SET status = 'in_progress', version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND status NOT IN ('done', 'canceled') AND archived_at IS NULL
          `).run(now(), task.id, task.version);
          if (updatedTask.changes !== 1) {
            throw new ApiError(409, "TASK_VERSION_CONFLICT", "The child task changed before the worker attempt could resume");
          }
        }
        replay = this.database.prepare(`
          SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?
        `).get(dispatchKey);
      }
      return { dispatch: taskDispatchFromRow(replay), task: this.getTask(taskId), created: false };
    }
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task || task.archived_at !== null) {
      throw new ApiError(409, "TASK_NOT_RETRYABLE", "An archived or missing child task cannot be resumed");
    }
    if (["done", "canceled"].includes(task.status)) {
      throw new ApiError(409, "TASK_NOT_RETRYABLE", "A completed or canceled child task cannot be resumed");
    }
    const activeAttempt = this.database.prepare(`
      SELECT dispatch_key FROM task_orchestration_dispatches
      WHERE task_id = ? AND kind = 'worker_attempt' AND status IN ('claimed', 'running')
      LIMIT 1
    `).get(task.id);
    if (activeAttempt) {
      throw new ApiError(409, "WORKER_ATTEMPT_BUSY", "This child already has a non-terminal worker attempt");
    }
    const unsatisfied = this.database.prepare(`
      SELECT tasks.status, tasks.archived_at
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
        AND (tasks.archived_at IS NOT NULL OR tasks.status NOT IN ('in_review', 'done'))
      LIMIT 1
    `).get(task.id);
    if (unsatisfied) {
      throw new ApiError(409, "DEPENDENCY_NOT_SATISFIED", "The child task still has an unresolved dependency");
    }
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO task_orchestration_dispatches (
        dispatch_key, parent_task_id, child_key, task_id, kind, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'worker_attempt', 'worker', 'claimed', ?, ?)
    `).run(dispatchKey, parentId, mapping.child_key, task.id, timestamp, timestamp);
    if (task.status !== "in_progress") {
      this.database.prepare(`
        UPDATE tasks
        SET status = 'in_progress', version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(timestamp, task.id);
    }
    return {
      dispatch: this.getTaskDispatch(dispatchKey),
      task: this.getTask(task.id),
      created: true,
      action,
    };
  }

  claimManualWorkerAttempt(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#claimWorkerAttemptNoTransaction({
        parentId: input.parentId,
        taskId: input.taskId,
        dispatchKey: input.dispatchKey,
        action: "manual_resume",
      });
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listWorkerAttemptDispatches(parentId) {
    return this.database.prepare(`
      SELECT task_orchestration_dispatches.*
      FROM task_orchestration_dispatches
      JOIN task_handoffs
        ON task_handoffs.worker_attempt_dispatch_key = task_orchestration_dispatches.dispatch_key
      WHERE task_orchestration_dispatches.parent_task_id = ?
        AND task_orchestration_dispatches.kind = 'worker_attempt'
        AND task_handoffs.state = 'attempt_pending'
      ORDER BY task_orchestration_dispatches.created_at, task_orchestration_dispatches.dispatch_key
    `).all(parentId).map(taskDispatchFromRow);
  }

  completeTaskHandoffAttempt(handoffId, dispatchKey, runId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const handoff = this.database.prepare(
        "SELECT * FROM task_handoffs WHERE id = ?",
      ).get(handoffId);
      if (!handoff) throw new ApiError(404, "TASK_HANDOFF_NOT_FOUND", `Task handoff '${handoffId}' does not exist`);
      if (handoff.state === "resolved") {
        this.database.exec("COMMIT");
        return this.getTaskHandoff(handoffId);
      }
      if (handoff.state !== "attempt_pending" || handoff.worker_attempt_dispatch_key !== dispatchKey) {
        throw new ApiError(409, "WORKER_ATTEMPT_CONFLICT", "The handoff is no longer waiting for this worker attempt");
      }
      this.#assertTaskActiveNoTransaction(handoff.parent_task_id);
      this.#assertTaskActiveNoTransaction(handoff.child_task_id);
      const dispatch = this.database.prepare(
        "SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?",
      ).get(dispatchKey);
      const run = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(runId);
      if (!dispatch || dispatch.kind !== "worker_attempt" || dispatch.run_id !== runId || !run || run.thread_id !== dispatch.thread_id) {
        throw new ApiError(409, "WORKER_ATTEMPT_CONFLICT", "The worker attempt is not bound to the expected run");
      }
      const timestamp = now();
      this.database.prepare(`
        UPDATE task_handoffs
        SET state = 'resolved', error = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'attempt_pending' AND worker_attempt_dispatch_key = ?
      `).run(timestamp, handoffId, dispatchKey);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTaskHandoff(handoffId);
  }

  requeueTaskHandoffAttempt(handoffId, dispatchKey, errorMessage) {
    const message = String(errorMessage || "Worker attempt did not start").slice(0, 65_536);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const handoff = this.database.prepare(
        "SELECT * FROM task_handoffs WHERE id = ?",
      ).get(handoffId);
      if (!handoff) throw new ApiError(404, "TASK_HANDOFF_NOT_FOUND", `Task handoff '${handoffId}' does not exist`);
      if (handoff.state !== "attempt_pending" || handoff.worker_attempt_dispatch_key !== dispatchKey) {
        this.database.exec("COMMIT");
        return this.getTaskHandoff(handoffId);
      }
      this.#assertTaskActiveNoTransaction(handoff.parent_task_id);
      this.#assertTaskActiveNoTransaction(handoff.child_task_id);
      const dispatch = this.database.prepare(
        "SELECT * FROM task_orchestration_dispatches WHERE dispatch_key = ?",
      ).get(dispatchKey);
      if (dispatch?.status === "running" && dispatch.run_id) {
        const run = this.database.prepare("SELECT status FROM ai_chat_runs WHERE id = ?").get(dispatch.run_id);
        if (run?.status === "running") {
          this.database.exec("COMMIT");
          return this.getTaskHandoff(handoffId);
        }
      }
      const timestamp = now();
      if (dispatch && dispatch.status !== "completed") {
        this.database.prepare(`
          UPDATE task_orchestration_dispatches
          SET status = 'failed', error = ?, updated_at = ?
          WHERE dispatch_key = ? AND status <> 'completed'
        `).run(message, timestamp, dispatchKey);
      }
      const task = handoff.child_task_id
        ? this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(handoff.child_task_id)
        : null;
      const sourceStatus = handoff.source_task_status;
      const sourceVersion = handoff.source_task_version;
      const canRestore = task
        && task.status === "in_progress"
        && task.archived_at === null;
      let restoredVersion = task?.version ?? sourceVersion;
      let obsolete = !task || !canRestore;
      if (canRestore) {
        if (sourceStatus !== "in_progress") {
          const restored = this.database.prepare(`
            UPDATE tasks
            SET status = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND status = 'in_progress' AND archived_at IS NULL
          `).run(sourceStatus, timestamp, task.id, task.version);
          if (restored.changes !== 1) {
            obsolete = true;
          } else {
            restoredVersion = task.version + 1;
          }
        }
      }
      if (obsolete) {
        this.database.prepare(`
          UPDATE task_handoffs
          SET state = 'obsolete', error = ?, last_error = ?, solution_json = NULL,
              solution_action = NULL, attempt_action = NULL, worker_attempt_dispatch_key = NULL,
              updated_at = ?
          WHERE id = ? AND state = 'attempt_pending' AND worker_attempt_dispatch_key = ?
        `).run(
          `${message}; child status changed before the failed attempt could be recovered`,
          message,
          timestamp,
          handoffId,
          dispatchKey,
        );
      } else {
        this.database.prepare(`
          UPDATE task_handoffs
          SET state = 'pending', task_status = ?, source_task_version = ?, source_task_status = ?,
              error = ?, last_error = ?, solution_json = NULL, solution_action = NULL,
              attempt_action = NULL, worker_attempt_dispatch_key = NULL, updated_at = ?
          WHERE id = ? AND state = 'attempt_pending' AND worker_attempt_dispatch_key = ?
        `).run(
          sourceStatus,
          restoredVersion,
          sourceStatus,
          message,
          message,
          timestamp,
          handoffId,
          dispatchKey,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      handoff: this.getTaskHandoff(handoffId),
      task: this.getTask(this.getTaskHandoff(handoffId)?.childTaskId),
    };
  }

  #createRemediationNoTransaction(handoff, rawRemediation) {
    if (!rawRemediation || typeof rawRemediation !== "object" || Array.isArray(rawRemediation)) {
      throw new ApiError(400, "INVALID_HANDOFF_SOLUTION", "create_remediation requires a remediation task");
    }
    const orchestration = this.database.prepare(`
      SELECT * FROM task_orchestrations WHERE parent_task_id = ?
    `).get(handoff.parent_task_id);
    const parent = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(handoff.parent_task_id);
    if (!orchestration || !parent) {
      throw new ApiError(409, "TASK_ORCHESTRATION_NOT_FOUND", "The handoff parent orchestration no longer exists");
    }
    const childKey = typeof rawRemediation.childKey === "string" && rawRemediation.childKey.trim()
      ? rawRemediation.childKey.trim()
      : `remediation-${handoff.id}`;
    const dependsOn = Array.isArray(rawRemediation.dependsOn)
      ? rawRemediation.dependsOn.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const entry = normalizePlanEntries({
      children: [{
        childKey,
        title: rawRemediation.title,
        description: rawRemediation.description,
        acceptance: rawRemediation.acceptance,
        ownership: rawRemediation.ownership,
        files: rawRemediation.files,
        dependsOn: [],
      }],
    })[0];
    const children = this.database.prepare(`
      SELECT * FROM task_orchestration_children WHERE parent_task_id = ?
    `).all(handoff.parent_task_id);
    if (children.some((child) => child.child_key === childKey)) {
      throw new ApiError(409, "REMEDIATION_CONFLICT", `Remediation childKey '${childKey}' already exists`);
    }
    const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    const childByKey = new Map(children.map((child) => [child.child_key, child]));
    const rawScopeTransfer = rawRemediation.scopeTransfer;
    let scopeTransfer = null;
    if (rawScopeTransfer !== undefined) {
      if (
        !rawScopeTransfer
        || typeof rawScopeTransfer !== "object"
        || Array.isArray(rawScopeTransfer)
        || typeof rawScopeTransfer.fromChildKey !== "string"
        || !Array.isArray(rawScopeTransfer.files)
        || rawScopeTransfer.files.length === 0
      ) {
        throw new ApiError(400, "INVALID_HANDOFF_SOLUTION", "scopeTransfer must identify a blocked child and files");
      }
      const sourceChild = childByKey.get(rawScopeTransfer.fromChildKey);
      const sourceTask = sourceChild
        ? this.database.prepare("SELECT status FROM tasks WHERE id = ?").get(sourceChild.task_id)
        : null;
      if (!sourceChild || !["blocked", "canceled"].includes(sourceTask?.status)) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "Only a blocked or canceled child can transfer scope");
      }
      const transferFiles = rawScopeTransfer.files.map((file) => normalizeRelativePlanPath(file, childKey));
      const sourceFiles = parseJsonColumn(sourceChild.files_json, []);
      const sourceOwnership = parseJsonColumn(sourceChild.ownership_json, null);
      if (sourceOwnership === entry.ownership) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "A scope transfer must move responsibility to a different owner");
      }
      if (new Set(transferFiles).size !== transferFiles.length) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "scopeTransfer files must be unique");
      }
      if (transferFiles.some((file) => !sourceFiles.includes(file))) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "scopeTransfer files must exactly match atomic files owned by the blocked child");
      }
      if (
        entry.files.length !== transferFiles.length
        || entry.files.some((file) => !transferFiles.includes(file))
      ) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "remediation files must exactly match the transferred scope");
      }
      if (
        rawScopeTransfer.ownership !== undefined
        && rawScopeTransfer.ownership !== entry.ownership
      ) {
        throw new ApiError(409, "SCOPE_TRANSFER_CONFLICT", "scopeTransfer ownership must match the remediation ownership");
      }
      scopeTransfer = {
        child: sourceChild,
        files: transferFiles,
        ownership: rawScopeTransfer.ownership ?? null,
      };
    }
    for (const child of children) {
      const isTransferSource = scopeTransfer?.child.child_key === child.child_key;
      if (
        parseJsonColumn(child.ownership_json, null) === entry.ownership
        && (!isTransferSource || scopeTransfer?.ownership !== entry.ownership)
      ) {
        throw new ApiError(409, "OWNERSHIP_CONFLICT", `Ownership '${entry.ownership}' is already assigned`);
      }
      for (const existingFile of parseJsonColumn(child.files_json, [])) {
        for (const file of entry.files) {
          if (overlaps(existingFile, file)) {
            const authorizedTransfer = isTransferSource
              && scopeTransfer.files.some((scopeFile) => scopeFile === existingFile && scopeFile === file);
            if (!authorizedTransfer) {
              throw new ApiError(409, "OWNERSHIP_CONFLICT", `Remediation file '${file}' overlaps '${existingFile}'`);
            }
          }
        }
      }
    }
    for (const dependency of dependsOn) {
      if (!childByKey.has(dependency) || dependency === childKey) {
        throw new ApiError(409, "INVALID_HANDOFF_SOLUTION", `Unknown remediation dependency '${dependency}'`);
      }
    }
    const idempotencyKey = `task-remediation:${handoff.id}`;
    const result = this.#createTaskIdempotentlyNoTransaction({
      projectId: parent.project_id,
      title: entry.title,
      description: entry.description,
      status: "backlog",
      priority: parent.priority,
      labels: ["补救任务"],
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
      assignee: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
      workflowId: null,
      developmentContext: null,
      dueDate: null,
      recurrence: null,
    }, idempotencyKey);
    if (!result.created && (
      result.task.projectId !== parent.project_id
      || result.task.title !== entry.title
      || result.task.description !== entry.description
    )) {
      throw new ApiError(409, "REMEDIATION_CONFLICT", "The remediation idempotency key has different task content");
    }
    this.#ensurePlanRelationNoTransaction("parent", parent.id, result.task.id);
    this.#ensurePlanRelationNoTransaction("blocks", result.task.id, handoff.child_task_id);
    for (const dependency of dependsOn) {
      this.#ensurePlanRelationNoTransaction("blocks", childByKey.get(dependency).task_id, result.task.id);
    }
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO task_orchestration_children (
        parent_task_id, child_key, task_id, title, description,
        acceptance_json, ownership_json, files_json, depends_on_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.parent_task_id,
      entry.childKey,
      result.task.id,
      entry.title,
      entry.description,
      JSON.stringify(entry.acceptance),
      JSON.stringify(entry.ownership),
      JSON.stringify(entry.files),
      JSON.stringify(dependsOn),
      timestamp,
      timestamp,
    );
    const existingPlan = orchestration.plan_json
      ? parseJsonColumn(orchestration.plan_json, { children: [] })
      : { children: children.map((child) => ({
          childKey: child.child_key,
          title: child.title,
          description: child.description,
          acceptance: parseJsonColumn(child.acceptance_json, []),
          ownership: parseJsonColumn(child.ownership_json, null),
          files: parseJsonColumn(child.files_json, []),
          dependsOn: parseJsonColumn(child.depends_on_json, []),
        })) };
    const existingEntries = Array.isArray(existingPlan)
      ? existingPlan
      : existingPlan.children ?? existingPlan.tasks ?? existingPlan.plan ?? [];
    const mergedEntries = existingEntries.map((existingEntry) => {
      if (existingEntry.childKey !== scopeTransfer?.child.child_key) return existingEntry;
      return {
        ...existingEntry,
        files: existingEntry.files.filter((file) => !scopeTransfer.files.includes(file)),
      };
    });
    if (scopeTransfer) {
      const remainingFiles = parseJsonColumn(scopeTransfer.child.files_json, [])
        .filter((file) => !scopeTransfer.files.includes(file));
      this.database.prepare(`
        UPDATE task_orchestration_children
        SET files_json = ?, updated_at = ?
        WHERE parent_task_id = ? AND child_key = ?
      `).run(
        JSON.stringify(remainingFiles),
        timestamp,
        handoff.parent_task_id,
        scopeTransfer.child.child_key,
      );
    }
    const mergedPlan = normalizePlanEntries({ children: [...mergedEntries, { ...entry, dependsOn }] });
    this.database.prepare(`
      UPDATE task_orchestrations
      SET plan_json = ?, updated_at = ?
      WHERE parent_task_id = ?
    `).run(canonicalPlan(mergedPlan), timestamp, handoff.parent_task_id);
    return { task: this.getTask(result.task.id), created: result.created };
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    if (thread.origin.issueId) {
      const issue = this.database.prepare(`
        SELECT identifier, title FROM tasks WHERE id = ?
      `).get(thread.origin.issueId);
      if (issue) {
        thread.origin.issueIdentifier = issue.identifier;
        thread.origin.issueTitle = issue.title;
      }
    }
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const retryJob = this.database.prepare(`
      SELECT * FROM ai_chat_retry_jobs
      WHERE thread_id = ? AND state IN ('pending', 'claimed', 'running', 'exhausted')
      ORDER BY
        CASE state WHEN 'running' THEN 0 WHEN 'claimed' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        updated_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.retryJob = retryJob ? aiChatRetryJobFromRow(retryJob) : null;
    return thread;
  }

  #assertVersion(actualVersion, expectedVersion, code, label) {
    if (actualVersion !== expectedVersion) {
      throw new ApiError(409, code, `${label} was changed by another client`, {
        expectedVersion,
        actualVersion,
      });
    }
  }

  #assertTaskWritable(task) {
    if (task.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks are read-only");
    }
  }

  #assertTaskActiveNoTransaction(id, { allowMissing = false } = {}) {
    if (!id) return;
    const task = this.database.prepare("SELECT id, archived_at FROM tasks WHERE id = ?").get(id);
    if (!task && allowMissing) return;
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    if (task.archived_at !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks are read-only");
    }
  }

  #assertAiChatThreadWritable(thread) {
    if (thread.archivedAt !== null) {
      throw new ApiError(409, "AI_CHAT_THREAD_ARCHIVED", "Archived AI chat threads are read-only");
    }
  }

  #assertAiChatThreadActiveNoTransaction(thread) {
    if (thread.archived_at !== null) {
      throw new ApiError(409, "AI_CHAT_THREAD_ARCHIVED", "Archived AI chat threads are read-only");
    }
  }

  #assertStandaloneAiChatThread(thread) {
    if (thread.origin_issue_id) {
      throw new ApiError(
        409,
        "TASK_BOUND_THREAD_LIFECYCLE",
        "Task-bound AI chat threads are archived and restored with their task",
      );
    }
  }

  #archiveAffectedTaskIdsNoTransaction(taskId) {
    const ids = new Set([taskId]);
    const children = this.database.prepare(`
      SELECT task_id FROM task_orchestration_children WHERE parent_task_id = ?
    `).all(taskId);
    for (const child of children) ids.add(child.task_id);
    return [...ids];
  }

  #assertArchiveAllowedNoTransaction(taskIds) {
    if (taskIds.length === 0) return;
    const taskPlaceholders = taskIds.map(() => "?").join(", ");
    const childTaskIds = this.database.prepare(`
      SELECT task_id
      FROM task_orchestration_children
      WHERE task_id IN (${taskPlaceholders})
      ORDER BY task_id
    `).all(...taskIds).map((row) => row.task_id);
    const runningPlaceholders = taskIds.map(() => "?").join(", ");
    const runs = this.database.prepare(`
      SELECT ai_chat_runs.id, ai_chat_runs.thread_id
      FROM ai_chat_runs
      JOIN ai_chat_threads ON ai_chat_threads.id = ai_chat_runs.thread_id
      WHERE ai_chat_threads.origin_issue_id IN (${runningPlaceholders})
        AND ai_chat_threads.archived_at IS NULL
        AND ai_chat_runs.status = 'running'
      ORDER BY ai_chat_runs.id
    `).all(...taskIds);
    let dispatches = [];
    let handoffs = [];
    if (childTaskIds.length > 0) {
      const placeholders = childTaskIds.map(() => "?").join(", ");
      dispatches = this.database.prepare(`
        SELECT dispatch_key, task_id, kind, status
        FROM task_orchestration_dispatches
        WHERE task_id IN (${placeholders})
          AND status IN ('claimed', 'running')
        ORDER BY dispatch_key
      `).all(...childTaskIds);
      handoffs = this.database.prepare(`
        SELECT id, child_task_id, state
        FROM task_handoffs
        WHERE child_task_id IN (${placeholders})
          AND state IN ('pending', 'processing', 'attempt_pending')
        ORDER BY id
      `).all(...childTaskIds);
    }
    if (dispatches.length === 0 && runs.length === 0 && handoffs.length === 0) return;
    throw new ApiError(
      409,
      "TASK_ARCHIVE_BLOCKED",
      "Task archive is blocked by active child execution",
      {
        dispatches: dispatches.map((row) => ({
          dispatchKey: row.dispatch_key,
          taskId: row.task_id,
          kind: row.kind,
          status: row.status,
        })),
        runs: runs.map((row) => ({ id: row.id, threadId: row.thread_id })),
        handoffs: handoffs.map((row) => ({ id: row.id, taskId: row.child_task_id, state: row.state })),
      },
    );
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #ensurePlanRelationNoTransaction(type, sourceTaskId, targetTaskId) {
    if (sourceTaskId === targetTaskId) {
      throw new ApiError(400, "RELATION_CYCLE", "A task cannot depend on itself");
    }
    if (type === "parent") {
      const existingParent = this.database.prepare(`
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
      `).get(targetTaskId);
      if (existingParent && existingParent.source_task_id !== sourceTaskId) {
        throw new ApiError(409, "RELATION_CONFLICT", "A child task already has a different parent");
      }
    }
    const result = this.database.prepare(`
      INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(relation_type, source_task_id, target_task_id) DO NOTHING
    `).run(type, sourceTaskId, targetTaskId, now());
    if (result.changes === 1) {
      this.database.prepare(`
        UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?
      `).run(now(), targetTaskId);
    }
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    task.previousIdentifiers = this.database.prepare(`
      SELECT identifier FROM task_identifier_aliases
      WHERE task_id = ? ORDER BY created_at, identifier
    `).all(task.id).map((alias) => alias.identifier);
    task.readinessReview = this.getTaskReadinessReview(task.id);
    task.intervention = this.#taskInterventionForTask(task);
    return task;
  }

  #taskInterventionForTask(task) {
    const comments = this.database.prepare(`
      SELECT id, author_type, created_at, updated_at
      FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => ({
      id: row.id,
      authorType: row.author_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const handoffs = this.database.prepare(`
      SELECT id, state, blocker_summary, delivery_summary, comment_id, error,
             last_error, created_at, updated_at
      FROM task_handoffs
      WHERE child_task_id = ?
      ORDER BY updated_at, id
    `).all(task.id).map((row) => ({
      id: row.id,
      queueStatus: row.state,
      blocker: row.blocker_summary,
      summary: row.delivery_summary ?? row.blocker_summary ?? "",
      commentId: row.comment_id,
      error: row.error,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const dispatches = this.database.prepare(`
      SELECT dispatch_key, kind, role, status, error, failure_comment_id, created_at, updated_at
      FROM task_orchestration_dispatches
      WHERE task_id = ?
      ORDER BY updated_at, dispatch_key
    `).all(task.id).map((row) => ({
      dispatchKey: row.dispatch_key,
      kind: row.kind,
      role: row.role,
      status: row.status,
      error: row.error,
      failureCommentId: row.failure_comment_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const aiRuns = this.database.prepare(`
      SELECT runs.thread_id, runs.dispatch_key, runs.status, runs.error,
             runs.started_at, runs.finished_at, threads.role AS thread_role
      FROM ai_chat_runs runs
      JOIN ai_chat_threads threads ON threads.id = runs.thread_id
      WHERE threads.origin_issue_id = ?
      ORDER BY COALESCE(runs.finished_at, runs.started_at), runs.id
    `).all(task.id).map((row) => ({
      threadId: row.thread_id,
      dispatchKey: row.dispatch_key,
      threadRole: row.thread_role,
      status: row.status,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
    const retryJobs = this.database.prepare(`
      SELECT jobs.state, jobs.updated_at
      FROM ai_chat_retry_jobs jobs
      JOIN ai_chat_threads threads ON threads.id = jobs.thread_id
      WHERE threads.origin_issue_id = ?
      ORDER BY jobs.updated_at, jobs.id
    `).all(task.id).map((row) => ({
      state: row.state,
      updatedAt: row.updated_at,
    }));
    const orchestrationActivity = this.database.prepare(`
      SELECT updated_at
      FROM task_orchestrations
      WHERE parent_task_id = ?
      UNION ALL
      SELECT children.updated_at
      FROM task_orchestration_children children
      WHERE children.task_id = ?
      UNION ALL
      SELECT dispatches.updated_at
      FROM task_orchestration_dispatches dispatches
      WHERE dispatches.parent_task_id = ?
    `).all(task.id, task.id, task.id).map((row) => row.updated_at);
    const childActivities = this.database.prepare(`
      SELECT children.task_id, reviews.updated_at
      FROM task_orchestration_children children
      JOIN task_readiness_reviews reviews ON reviews.task_id = children.task_id
      WHERE children.parent_task_id = ? AND reviews.status = 'running'
      UNION ALL
      SELECT dispatches.task_id, dispatches.updated_at
      FROM task_orchestration_dispatches dispatches
      WHERE dispatches.parent_task_id = ?
        AND dispatches.task_id <> ?
        AND dispatches.status IN ('claimed', 'running')
      UNION ALL
      SELECT handoffs.child_task_id AS task_id, handoffs.updated_at
      FROM task_handoffs handoffs
      WHERE handoffs.parent_task_id = ?
        AND handoffs.state IN ('pending', 'processing', 'attempt_pending')
      UNION ALL
      SELECT threads.origin_issue_id AS task_id, runs.started_at AS updated_at
      FROM ai_chat_runs runs
      JOIN ai_chat_threads threads ON threads.id = runs.thread_id
      JOIN task_orchestration_children children ON children.task_id = threads.origin_issue_id
      WHERE children.parent_task_id = ?
        AND threads.role = 'worker'
        AND runs.status IN ('pending', 'running')
      UNION ALL
      SELECT threads.origin_issue_id AS task_id, jobs.updated_at
      FROM ai_chat_retry_jobs jobs
      JOIN ai_chat_threads threads ON threads.id = jobs.thread_id
      JOIN task_orchestration_children children ON children.task_id = threads.origin_issue_id
      WHERE children.parent_task_id = ?
        AND threads.role = 'worker'
        AND jobs.state IN ('pending', 'claimed', 'running')
      ORDER BY updated_at
    `).all(task.id, task.id, task.id, task.id, task.id, task.id).map((row) => ({
      taskId: row.task_id,
      updatedAt: row.updated_at,
    }));
    const manualOverrides = this.database.prepare(`
      SELECT view, mode, updated_at
      FROM task_intervention_overrides
      WHERE task_id = ?
    `).all(task.id).map((row) => ({
      view: row.view,
      mode: row.mode,
      updatedAt: row.updated_at,
    }));

    return computeTaskIntervention({
      task,
      comments,
      readinessReview: task.readinessReview,
      handoffs,
      dispatches,
      aiRuns,
      retryJobs,
      orchestrationActivity,
      childActivities,
      manualOverrides,
    });
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #touchTask(id, version, threadId) {
    const result = this.database.prepare(`
      UPDATE tasks
      SET thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
