import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_LABEL_NAMES, JIRA_PROJECT_ID } from "../shared/domain.mjs";

const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const TASK_TREE_MAX_NODES = 1_000;

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

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function storedThreadBindingForExisting(current, threadBinding, threadId) {
  if (
    threadBinding === undefined
    && current?.threadBinding
    && current.threadBinding.threadId === threadId
  ) {
    return storedThreadBinding(current.threadBinding, threadId);
  }
  return storedThreadBinding(threadBinding, threadId);
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
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
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
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
    developmentContext,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    source: row.external_source === "jira" ? "jira" : "local",
    externalOrigin: row.external_origin ?? null,
    externalKey: row.external_key ?? null,
    externalUrl: row.external_url ?? null,
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
    externalKey: row.external_key ?? null,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
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

function taskTreeNode(row, parentId, depth, path) {
  return {
    id: row.id,
    parentId,
    depth,
    path,
    summary: {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      archivedAt: row.archived_at,
    },
  };
}

function commentFromRow(row) {
  const comment = {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(comment, "changeRevision", { value: row.change_revision });
  return comment;
}

function attachmentFromRow(row) {
  const attachment = {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
  Object.defineProperty(attachment, "changeRevision", { value: row.change_revision });
  return attachment;
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    source: row.id === JIRA_PROJECT_ID ? "jira" : "local",
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
  };
}

function projectReadmeFromRow(row, projectId) {
  return {
    projectId: row.project_id ?? projectId,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
      ...(row.origin_codex_project_id ? { codexProjectId: row.origin_codex_project_id } : {}),
      ...(row.origin_codex_project_kind ? { codexProjectKind: row.origin_codex_project_kind } : {}),
      ...(row.origin_codex_host_id ? { codexHostId: row.origin_codex_host_id } : {}),
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    latestTodo: null,
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

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && /^[A-Z0-9]+$/i.test(existingPrefix) && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = project.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 3);
  return namePrefix || idPrefix.slice(0, 3);
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
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
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
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
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS comment_attachment_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      );

      CREATE TABLE IF NOT EXISTS project_readmes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_readme_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_codex_project_id TEXT,
        origin_codex_project_kind TEXT,
        origin_codex_host_id TEXT,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
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

    `);

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const aiChatThreadColumns = this.database.prepare("PRAGMA table_info(ai_chat_threads)").all();
    for (const column of [
      "origin_codex_project_id",
      "origin_codex_project_kind",
      "origin_codex_host_id",
    ]) {
      if (!aiChatThreadColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE ai_chat_threads ADD COLUMN ${column} TEXT`);
      }
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasWorkflowId = taskColumns.some((column) => column.name === "workflow_id");
    if (hasWorkflowId) {
      this.database.exec("ALTER TABLE tasks DROP COLUMN workflow_id");
    }
    this.database.exec("DROP TABLE IF EXISTS workflow_workspaces");
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!taskColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
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
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
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
    if (!migratedTaskColumns.some((column) => column.name === "external_source")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_origin")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_origin TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_key")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_key TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_url TEXT");
    }
    this.database.exec(`
      DROP INDEX IF EXISTS tasks_external_source_id;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id
      ON tasks(external_source, external_origin, external_id)
      WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL
    `);
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
    if (!projectColumns.some((column) => column.name === "labels")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE projects
          ADD COLUMN labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}'
        `);
        const labelsByProject = new Map(
          this.database.prepare("SELECT id FROM projects").all().map((project) => (
            [project.id, [...DEFAULT_LABEL_NAMES]]
          )),
        );
        for (const task of this.database.prepare(`
          SELECT project_id, labels
          FROM tasks
          ORDER BY created_at, id
        `).all()) {
          const projectLabels = labelsByProject.get(task.project_id);
          if (!projectLabels) continue;
          for (const label of JSON.parse(task.labels)) {
            if (!projectLabels.includes(label)) projectLabels.push(label);
          }
        }
        const updateProjectLabels = this.database.prepare(`
          UPDATE projects SET labels = ? WHERE id = ?
        `);
        for (const [projectId, labels] of labelsByProject) {
          updateProjectLabels.run(JSON.stringify(labels), projectId);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
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
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
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

      CREATE TRIGGER IF NOT EXISTS task_relations_require_same_project
      BEFORE INSERT ON task_relations
      BEGIN
        SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION')
        WHERE EXISTS (
          SELECT 1
          FROM tasks AS source
          JOIN tasks AS target ON target.id = NEW.target_task_id
          WHERE source.id = NEW.source_task_id
            AND source.project_id != target.project_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS task_relations_prevent_parent_cycle
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'RELATION_CYCLE')
        WHERE EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT source_task_id
            FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = NEW.source_task_id
            UNION
            SELECT task_relations.source_task_id
            FROM task_relations
            JOIN ancestors ON task_relations.target_task_id = ancestors.id
            WHERE task_relations.relation_type = 'parent'
          )
          SELECT 1 FROM ancestors WHERE id = NEW.target_task_id
        );
      END;
    `);

    const taskRelationColumns = this.database.prepare("PRAGMA table_info(task_relations)").all();
    if (!taskRelationColumns.some((column) => column.name === "origin")) {
      this.database.exec(`
        ALTER TABLE task_relations
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual', 'mention'))
      `);
    }

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!commentColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      }
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    if (!commentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
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
        UPDATE tasks AS migrated_task
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = migrated_task.id
          ORDER BY
            CASE WHEN comments.id IS NOT NULL THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    if (!attachmentColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('inline', 'attachment'))");
      this.database.exec(`
        UPDATE attachments
        SET kind = 'inline'
        WHERE content_type LIKE 'image/%'
          AND (
            (
              comment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE tasks.id = attachments.task_id
                  AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
            OR (
              comment_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM comments
                WHERE comments.id = attachments.comment_id
                  AND instr(comments.body, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
          )
      `);
    }
    if (!attachmentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS comments_task_change_revision ON comments(task_id, change_revision)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_task_change_revision ON attachments(task_id, change_revision) WHERE comment_id IS NULL");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_change_revision ON attachments(comment_id, change_revision) WHERE comment_id IS NOT NULL");
    const maxChangeRevision = this.database.prepare(`
      SELECT MAX(change_revision) AS value
      FROM (
        SELECT change_revision FROM comments
        UNION ALL
        SELECT change_revision FROM attachments
      )
    `).get().value ?? 0;
    this.database.prepare(`
      INSERT INTO comment_attachment_revision (id, value)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value = MAX(value, excluded.value)
    `).run(maxChangeRevision);

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.database.prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
  }

  close() {
    this.database.close();
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
          thread_codex_project_id TEXT,
          thread_codex_project_kind TEXT,
          thread_codex_host_id TEXT,
          thread_workspace_path TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
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
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
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

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
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
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, workspace_path, labels, next_task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.name,
        input.workspacePath,
        DEFAULT_PROJECT_LABELS_JSON,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES (?, ?, NULL, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(JIRA_PROJECT_ID, name, timestamp, timestamp);
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY projects.id
    `).get(JIRA_PROJECT_ID);
  }

  syncJiraTasks(issues, { archiveMissing = true, projectName, legacyIdentity = null } = {}) {
    const timestamp = now();
    const seenTaskIds = new Set();
    const projectLabels = JSON.stringify([
      ...new Set(issues.flatMap((issue) => issue.labels)),
    ]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `).run(JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      const findExisting = this.database.prepare(`
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      `);
      const migrateLegacyIdentity = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      `);
      if (legacyIdentity) {
        const legacyTasks = this.database.prepare(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        `).all(JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          migrateLegacyIdentity.run(
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }
      const insertTask = this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          NULL, 1, ?, ?
        )
      `);
      const updateTask = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          archived_at = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ?
      `);

      for (const issue of issues) {
        const existing = findExisting.get(issue.externalOrigin, issue.externalId);
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        if (!existing) {
          insertTask.run(
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            issue.status,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.createdAt,
            issue.updatedAt,
          );
          continue;
        }

        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== issue.status
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.archived_at !== null;
        if (!changed) continue;
        updateTask.run(
          issue.identifier,
          issue.title,
          issue.description,
          issue.status,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          issue.updatedAt,
          existing.id,
        );
      }

      if (archiveMissing) {
        const existingTasks = this.database.prepare(`
          SELECT id FROM tasks
          WHERE project_id = ? AND external_source = 'jira' AND archived_at IS NULL
        `).all(JIRA_PROJECT_ID);
        const archiveTask = this.database.prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `);
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id)) {
            archiveTask.run(timestamp, timestamp, task.id);
          }
        }
      }
      this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(timestamp, JIRA_PROJECT_ID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = this.database.prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `).run(id, id);
    if (result.changes !== 1) {
      const issueCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
      `).get(id).issue_count);
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    return project;
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
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
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  addProjectLabel(projectId, label) {
    const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const labels = JSON.parse(project.labels);
    if (!labels.includes(label)) {
      this.database.prepare(`
        UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...labels, label]), now(), projectId);
    }
    return this.getProject(projectId);
  }

  deleteProjectLabel(projectId, label) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = now();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const updateTask = this.database.prepare(`
        UPDATE tasks
        SET labels = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const task of this.database.prepare(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `).all(projectId)) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          updateTask.run(
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(projectId);
  }

  getProjectSummary(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getProjectReadme(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, content, version, created_at, updated_at
      FROM project_readmes
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? projectReadmeFromRow(row, projectId)
      : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
  }

  saveProjectReadme(projectId, content, expectedVersion) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).get(projectId);
      if (expectedVersion !== undefined) {
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
            expectedVersion,
            actualVersion,
          });
        }
      }
      if (current) {
        const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
        const params = expectedVersion !== undefined
          ? [content, timestamp, projectId, expectedVersion]
          : [content, timestamp, projectId];
        this.database.prepare(`
          UPDATE project_readmes
          SET content = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?${versionCondition}
        `).run(...params);
      } else {
        this.database.prepare(`
          INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(projectId, content, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProjectReadme(projectId);
  }

  createProjectReadmeAttachment(projectId, input) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    this.database.prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      projectId,
      input.filename,
      input.contentType,
      input.size,
      now(),
    );
    return this.getProjectReadmeAttachment(input.id);
  }

  getProjectReadmeAttachment(id) {
    const row = this.database.prepare(`
      SELECT * FROM project_readme_attachments WHERE id = ?
    `).get(id);
    return row ? projectReadmeAttachmentFromRow(row) : null;
  }

  listAiChatThreads() {
    const rows = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_codex_project_id, origin_codex_project_kind, origin_codex_host_id,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.codexProjectId ?? null,
      input.origin.codexProjectKind ?? null,
      input.origin.codexHostId ?? null,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
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
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
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
    assignments.push("updated_at = ?");
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
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
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
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
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
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
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

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
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
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.database.prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return rows.map((row) => attachTaskActivity(
      this.#taskWithRelations(row),
      commentsByTask.get(row.id) ?? [],
      activitiesByTask.get(row.id) ?? [],
      previewImagesByTask.get(row.id) ?? null,
    ));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    return attachTaskActivity(task, comments, activities, previewImage);
  }

  getTaskTree(id, direction, depth) {
    const root = this.database.prepare(
      "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
    ).get(id, id);
    if (!root) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);

    const nodes = [taskTreeNode(root, null, 0, [root.id])];
    const seen = new Set([root.id]);
    let frontier = [nodes[0]];
    const relationJoin = direction === "descendants"
      ? `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.target_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.source_task_id IN (%PLACEHOLDERS%)
      `
      : `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.source_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.target_task_id IN (%PLACEHOLDERS%)
      `;
    const parentColumn = direction === "descendants"
      ? "task_relations.source_task_id"
      : "task_relations.target_task_id";

    for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
      const placeholders = frontier.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT tasks.*, ${parentColumn} AS tree_parent_id
        ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      `).all(...frontier.map((node) => node.id));
      const rowsByParent = new Map();
      for (const row of rows) {
        const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
        siblings.push(row);
        rowsByParent.set(row.tree_parent_id, siblings);
      }
      const next = [];
      for (const parent of frontier) {
        for (const row of rowsByParent.get(parent.id) ?? []) {
          if (seen.has(row.id)) continue;
          if (nodes.length >= TASK_TREE_MAX_NODES) {
            throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
          }
          const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
          nodes.push(node);
          next.push(node);
          seen.add(row.id);
        }
      }
      frontier = next;
    }

    return {
      rootId: root.id,
      direction,
      depth,
      nodeCount: nodes.length,
      nodes,
    };
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT
          projects.id,
          projects.name,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = projectPrefix(project);
      const maximum = this.database.prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `).run(
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.database.prepare("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      const relation = this.database.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
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
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    if (storedBinding && !Object.hasOwn(changes, "projectId")) {
      assignments.push(
        "thread_id = ?",
        "thread_codex_project_id = ?",
        "thread_codex_project_kind = ?",
        "thread_codex_host_id = ?",
        "thread_workspace_path = ?",
      );
      values.push(...storedBinding);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.database.prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = this.database.prepare(`
        SELECT labels FROM projects WHERE id = ?
      `).get(destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const attachmentIds = this.database.prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const result = this.database.prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin = "manual") {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
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

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, origin, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, origin, timestamp);
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
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

  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const relation = this.database.prepare(`
        SELECT origin
        FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).get(relationType, sourceTaskId, targetTaskId);
      if (!relation) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      if (origin && relation.origin !== origin) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      let deleted;
      if (origin === "mention" && relationType === "related") {
        const taskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: relatedTask.identifier,
        })})`;
        const relatedTaskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: task.identifier,
        })})`;
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
            AND origin = 'mention'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks
              WHERE (id = ? AND instr(description, ?) > 0)
                OR (id = ? AND instr(description, ?) > 0)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM comments
              WHERE (task_id = ? AND instr(body, ?) > 0)
                OR (task_id = ? AND instr(body, ?) > 0)
            )
        `).run(
          relationType,
          sourceTaskId,
          targetTaskId,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
        );
      } else {
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).run(relationType, sourceTaskId, targetTaskId);
      }
      if (origin === "mention" && relationType === "related" && deleted.changes === 0) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
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

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  listCommentsAfter(taskId, after) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).all(task.id, after.revision)
      .map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const id = randomUUID();
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, threadBinding) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireComment(id);
      this.#requireCommentVersion(current, version);
      const changeRevision = this.#nextCommentAttachmentRevision();
      const result = this.database.prepare(`
        UPDATE comments
        SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?,
          change_revision = ?
        WHERE id = ? AND version = ?
      `).run(body, ...(storedBinding ?? []), now(), changeRevision, id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId, after = null) {
    const task = this.#requireTask(taskId);
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE task_id = ? AND comment_id IS NULL
          AND change_revision > ?
        ORDER BY change_revision
      `).all(task.id, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        task.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId, after = null) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId, after);
  }

  createCommentAttachment(commentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const comment = this.#requireComment(commentId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        comment.taskId,
        comment.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT attachments.*
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        WHERE attachments.task_id IN (${placeholders})
          AND attachments.comment_id IS NULL
          AND attachments.content_type LIKE 'image/%'
          AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
        ORDER BY attachments.task_id, attachments.created_at, attachments.id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId, after = null) {
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE comment_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `).all(commentId, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #nextCommentAttachmentRevision() {
    return this.database.prepare(`
      UPDATE comment_attachment_revision
      SET value = value + 1
      WHERE id = 1
      RETURNING value
    `).get().value;
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
    return task;
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

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, threadBinding, timestamp) {
    const current = this.#requireTask(id);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.database.prepare(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(...(storedBinding ?? []), timestamp, id, version);
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
