export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "pending_retrospective",
  "done",
  "blocked",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskInterventionView = "resolve" | "follow_up" | "comment";
export type TaskInterventionManualMode = "include" | "exclude";
export type ActorType = "user" | "agent";
export type CommentIntent = "comment" | "resume" | "discussion";
export type CommentAction = "comment" | "review" | "development" | "discussion";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  manageTaskboardSkillPath?: string;
  capabilities?: TaskboardCapabilities;
  mode?: "local" | "cloud";
  realtime?: {
    transport: "poll";
    intervalMs: number;
  };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatRole = "planner" | "worker";
export type AiChatServiceTier = string;
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";
export type AiChatRetryState = "pending" | "claimed" | "running" | "succeeded" | "exhausted" | "canceled";

export interface AiChatModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface AiChatCatalog {
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  retryJobId?: string | null;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  errorCode?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatRetryJob {
  id: string;
  threadId: string;
  sourceRunId: string;
  retryRunId: string | null;
  state: AiChatRetryState;
  errorCode: string;
  lastError: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  role: AiChatRole;
  model: string;
  reasoningEffort: string;
  serviceTier: AiChatServiceTier | null;
  sandbox: AiChatSandbox;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
  retryJob?: AiChatRetryJob | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  taskPrefix: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export interface Task {
  id: string;
  identifier: string;
  previousIdentifiers: string[];
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  reworkRound: number | null;
  readinessReview: TaskReadinessReview | null;
  intervention: TaskIntervention;
  deliveredAt: string | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReadinessReview {
  taskId: string;
  status: "running" | "awaiting_input" | "ready" | "failed";
  aiThreadId: string | null;
  codexThreadId: string | null;
  aiThreadTitle: string | null;
  aiModel: string | null;
  aiReasoningEffort: string | null;
  runId: string | null;
  round: number;
  sourceTaskVersion: number;
  sourceUserCommentCount: number;
  decision: {
    decision: "ready" | "needs_confirmation";
    summary: string;
    confirmed: string[];
    assumptions: string[];
    questions: Array<{
      id: string;
      question: string;
      why: string;
      blocking: boolean;
    }>;
  } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInterventionTarget {
  kind: "task" | "comment" | "readiness" | "execution";
  taskId: string;
  commentId?: string;
  aiThreadId?: string | null;
}

export type TaskInterventionReasonCode =
  | "awaiting_confirmation"
  | "readiness_failed"
  | "execution_failed"
  | "awaiting_acceptance"
  | "stalled"
  | "manual_include";

export interface TaskInterventionReason {
  view: TaskInterventionView;
  code: TaskInterventionReasonCode;
  label: string;
  action: string;
  evidenceAt: string | null;
  target: TaskInterventionTarget;
}

export interface TaskIntervention {
  views: TaskInterventionView[];
  reasons: TaskInterventionReason[];
  primary: TaskInterventionReason | null;
  progress: {
    code: "reviewing" | "planning" | "executing" | "coordinating" | "retrying" | "conversing";
    label: string;
    action: string;
    evidenceAt: string | null;
  } | null;
  lastActivityAt: string | null;
  manual: Partial<Record<TaskInterventionView, TaskInterventionManualMode>>;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  aiThreadId: string | null;
  intent: CommentIntent;
  action: CommentAction;
  reworkRound: number | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskExecutionHandoffSourceKind = "run" | "task_status";
export type TaskExecutionHandoffState =
  | "pending"
  | "processing"
  | "attempt_pending"
  | "resolved"
  | "stopped"
  | "failed"
  | "obsolete";

export interface TaskExecutionOverviewHandoff {
  id: string;
  queueSeq: number;
  delivery: string | null;
  blocker: string | null;
  summary: string;
  latestComment: Comment | null;
  sourceKind: TaskExecutionHandoffSourceKind;
  state: TaskExecutionHandoffState;
}

export interface TaskExecutionOverviewChild {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  archivedAt: string | null;
  version: number;
  handoff: TaskExecutionOverviewHandoff | null;
  aiThreadId: string | null;
  codexThreadId: string | null;
}

export interface TaskExecutionOverviewOrchestration {
  parentId: string;
  status: "planning" | "planned" | "failed" | "canceled";
  plannerDispatchKey: string;
  plannerThreadId: string | null;
  plannerRunId: string | null;
  plan: unknown[] | Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecutionOverview {
  parent: Pick<Task, "id" | "identifier" | "projectId" | "title" | "status" | "priority" | "archivedAt">;
  orchestration: TaskExecutionOverviewOrchestration | null;
  children: TaskExecutionOverviewChild[];
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  previousProjectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
