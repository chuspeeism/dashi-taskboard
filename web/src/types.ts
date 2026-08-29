export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";
export type IssueRelationOrigin = "manual" | "mention";

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
  realtime?:
    | { transport: "poll"; intervalMs: number }
    | { transport: "websocket"; endpoint: string };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

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

export const COMPOSER_CONTRACT_VERSION = "composer.v1" as const;

export type ComposerTrigger = "@" | "/";
export type ComposerSurface = "ai-chat" | "issue-description" | "comment";

export type ComposerSourceKind =
  | "skills"
  | "slash"
  | "apps"
  | "files"
  | "agents"
  | "plugins"
  | "customPrompts";

export type ComposerSourceReasonCode =
  | "SOURCE_UNAVAILABLE"
  | "NO_STABLE_CATALOG"
  | "ACTION_UNVERIFIED"
  | "INVOCATION_NAME_UNAVAILABLE"
  | "ENCODER_UNSUPPORTED"
  | "EXPERIMENTAL_SOURCE_NOT_ALLOWED";

export interface ComposerSourceState {
  kind: ComposerSourceKind;
  state: "available" | "unavailable" | "unsupported";
  reasonCode: ComposerSourceReasonCode | null;
}

interface ComposerCandidateBase {
  candidateRef: string;
  label: string;
  description: string | null;
  group: string;
  groupOrder: number;
  itemOrder: number;
  selectable: true;
  insertionText?: string;
}

export interface ComposerReferencePersistence {
  format: "taskboard.composer-reference.v1";
  kind: "skill" | "agent";
  referenceKey: string;
  markdown: string;
}

export interface ComposerInsertTextSelection {
  type: "insertText";
  text: string;
}

export interface ComposerSkillCandidate extends ComposerCandidateBase {
  kind: "skill";
  trigger: "@" | "/";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerAgentCandidate extends ComposerCandidateBase {
  kind: "agent";
  trigger: "@";
  persistence?: ComposerReferencePersistence;
}

export interface ComposerSlashActionCandidate extends ComposerCandidateBase {
  kind: "slashAction";
  trigger: "/";
  command: string;
  dispatch: {
    type: "client" | "server";
    handlerId: string;
  };
  selection?: ComposerInsertTextSelection;
}

export type ComposerCandidate =
  | ComposerSkillCandidate
  | ComposerAgentCandidate
  | ComposerSlashActionCandidate;

export interface ComposerCandidatesQuery {
  projectId?: string;
  threadId?: string;
  surface?: ComposerSurface;
  trigger: ComposerTrigger;
  query: string;
  codexProjectId?: string;
  codexProjectKind?: "local" | "remote";
  codexHostId?: string;
  workspacePath?: string;
}

export interface ComposerCandidatesResponse {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  candidates: ComposerCandidate[];
  sources: ComposerSourceState[];
}

export interface ComposerTextNode {
  type: "text";
  text: string;
}

export interface ComposerSkillNode {
  type: "skill";
  candidateRef: string;
  label: string;
}

export interface ComposerAgentNode {
  type: "agent";
  candidateRef: string;
  label: string;
}

export type ComposerNode = ComposerTextNode | ComposerSkillNode | ComposerAgentNode;

export interface ComposerPersistedReferenceNode {
  type: "persistedReference";
  referenceKind: "skill" | "agent";
  referenceKey: string;
  label: string;
}

export interface ComposerUnsupportedReferenceNode {
  type: "unsupportedReference";
  referenceUri: string;
  label: string;
}

export interface ComposerPersistedDocument {
  version: 1;
  nodes: Array<ComposerTextNode | ComposerPersistedReferenceNode | ComposerUnsupportedReferenceNode>;
}

export interface ComposerDocument {
  version: 1;
  nodes: ComposerNode[];
}

export interface ComposerRebindRequest {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  projectId: string;
  threadId?: string;
  document: ComposerPersistedDocument;
}

export interface ComposerRebindBinding {
  nodeIndex: number;
  status: "resolved" | "unavailable";
  referenceKind: "skill" | "agent" | "unsupported";
  label?: string;
  reasonCode?:
    | "SOURCE_UNAVAILABLE"
    | "REFERENCE_NOT_FOUND"
    | "REFERENCE_AMBIGUOUS"
    | "REFERENCE_KIND_UNSUPPORTED"
    | "REFERENCE_FORMAT_UNSUPPORTED";
}

export type ComposerRebindResponse = {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  bindings: ComposerRebindBinding[];
  sources: ComposerSourceState[];
  diagnostics: unknown[];
} & (
  | { ready: true; document: ComposerDocument }
  | { ready: false; document?: never }
);

export interface ComposerTurnInput {
  contractVersion: typeof COMPOSER_CONTRACT_VERSION;
  revision: string;
  document: ComposerDocument;
  dangerFullAccessConfirmed?: boolean;
  attachments?: AiChatAttachmentInput[];
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
  codexProjectId?: string;
  codexProjectKind?: "local" | "remote";
  codexHostId?: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatTodoProgress {
  completed: number;
  total: number;
  eventId: string;
  updatedAt: string;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
  latestTodo?: AiChatTodoProgress | null;
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

export interface CodexProjectIdentity {
  codexProjectId: string;
  codexProjectKind: "local" | "remote";
  codexHostId: string;
  workspacePath: string;
}

export interface CodexThreadBinding extends CodexProjectIdentity {
  threadId: string;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  source: "local" | "jira";
  labels: string[];
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  projectId: string;
  summary: string | null;
  updatedAt: string | null;
  refreshing: boolean;
  error: string | null;
}

export interface ProjectReadme {
  projectId: string;
  content: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectReadmeAttachment {
  id: string;
  projectId: string;
  kind: "inline";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  externalKey?: string | null;
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

interface TaskConversationRefBase {
  source: "task" | "comment";
  sourceId: string;
  title: string;
  updatedAt: string;
}

export type TaskConversationRef = TaskConversationRefBase & (
  | (CodexThreadBinding & { legacyLocal?: false })
  | { threadId: string; legacyLocal: true }
);

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
  conversationRefs: TaskConversationRef[];
  participants: ActorIdentity[];
  previewImage: Attachment | null;
  activityKey: string;
  activityUpdatedAt: string;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  source: "local" | "jira";
  externalOrigin?: string | null;
  externalKey?: string | null;
  externalUrl: string | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface JiraConnection {
  configured: boolean;
  baseUrl: string | null;
  username: string | null;
  displayName: string | null;
  projects: string[];
  projectId: string;
  lastSyncedAt: string | null;
  insecureHttp: boolean;
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
  threadBinding: CodexThreadBinding | null;
  legacyLocalThreadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface TaskChangeActivity {
  id: string;
  taskId: string;
  actorType: ActorType;
  actorId: string;
  actorName: string;
  actorAvatarUrl: string | null;
  changes: TaskActivityChange[];
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  kind: "inline" | "attachment";
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  language?: string;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{
    id: string;
    name: string;
    projectKind?: "local" | "remote";
    workspacePath?: string;
    hostId?: string;
  }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
  threadRunning?: boolean;
  threadTodoProgress?: {
    completed: number;
    total: number;
  };
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  developmentContext: DevelopmentContext | null;
  startDate: string | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
