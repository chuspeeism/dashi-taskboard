import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  getTaskboardRevision,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  reassignTask as reassignTaskRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  restoreTaskByVersion,
  setCurrentUserActor,
  setTaskInterventionOverride,
  uploadAttachment,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { AiChat } from "./components/AiChat";
import { BoardSettingsMenu } from "./components/BoardSettingsMenu";
import { HiddenColumns } from "./components/HiddenColumns";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { TaskProjectReassignDialog } from "./components/TaskProjectReassignDialog";
import { buildIssueUrl, readIssueIdentifier, readSelectedProjectIds } from "./issueRoute";
import { DEFAULT_LABELS } from "./labels";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_INTERVENTION_VIEW_DETAILS,
  TASK_INTERVENTION_VIEWS,
  readTaskInterventionView,
  taskIntervention,
  writeTaskInterventionView,
} from "./taskIntervention";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatRole,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskInterventionManualMode,
  type TaskInterventionView,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, getRevisionPollingInterval } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "issues" | "workflow";
const SHOW_WORKFLOW_BOARD_ENTRY = false;

function taskAiRole(task: Task): AiChatRole {
  return task.labels.includes("主任务") && !task.relations.parent ? "planner" : "worker";
}

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
}

interface DetailQueueSnapshot {
  label: string;
  taskIds: string[];
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  workspacePath: string | null;
  category: "project" | "inbox" | "program";
}

const INBOX_PROJECT_IDS = new Set(["idea-inbox", "inbox-unclassified"]);
const PROGRAM_PROJECT_IDS = new Set(["feishu-taskboard-sync"]);

function projectCategory(projectId: string): ProjectChoice["category"] {
  if (INBOX_PROJECT_IDS.has(projectId)) return "inbox";
  if (PROGRAM_PROJECT_IDS.has(projectId)) return "program";
  return "project";
}

function normalizedWorkspacePath(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || "/";
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ColumnVisibilityByProject = Record<string, Partial<Record<TaskStatus, boolean>>>;
type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalMinutes: AutomationIntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const HIDDEN_PROJECTS_KEY = "taskboard.hiddenProjectIds.v1";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const TASK_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.reassigned",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "task.execution.updated",
  "task.intervention.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "project.updated",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readHiddenProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readShowEmptyColumns(): boolean {
  return window.localStorage.getItem(SHOW_EMPTY_COLUMNS_KEY) === "true";
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function readColumnVisibilityByProject(): ColumnVisibilityByProject {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ColumnVisibilityByProject = {};
    for (const [projectId, visibilityValue] of Object.entries(value)) {
      if (!visibilityValue || typeof visibilityValue !== "object" || Array.isArray(visibilityValue)) continue;
      const visibility: Partial<Record<TaskStatus, boolean>> = {};
      for (const status of TASK_STATUSES) {
        const visible = (visibilityValue as Record<string, unknown>)[status];
        if (typeof visible === "boolean") visibility[status] = visible;
      }
      result[projectId] = visibility;
    }
    return result;
  } catch {
    return {};
  }
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  selectedProjectIds: string[];
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectIds: string[],
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<boolean>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setExecutionOverviewRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  selectedProjectIds,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setExecutionOverviewRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;
    let refreshExecutionOverviewPending = false;

    const scheduleRefresh = (options: {
      projects?: boolean;
      tasks?: boolean;
      executionOverview?: boolean;
    }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      refreshExecutionOverviewPending ||= options.executionOverview === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectIds.length > 0) {
          void refreshTasks(selectedProjectIds, { quiet: true });
        }
        if (refreshExecutionOverviewPending) {
          setExecutionOverviewRevision((current) => current + 1);
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
        refreshExecutionOverviewPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; previousProjectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as {
          projectId?: string;
          previousProjectId?: string;
          taskId?: string;
        };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = selectedProjectIds.length > 0
        && (
          !payload.projectId
          || selectedProjectIds.includes(payload.projectId)
          || Boolean(payload.previousProjectId && selectedProjectIds.includes(payload.previousProjectId))
        );
      if (event.type.startsWith("project.")) {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({
          projects: true,
          tasks: affectsSelectedProject,
          executionOverview: Boolean(detailTaskId && affectsSelectedProject),
        });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({
          tasks: true,
          executionOverview: Boolean(detailTaskId),
        });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ executionOverview: Boolean(detailTaskId) });
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: selectedProjectIds.length > 0 });
      if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    selectedProjectIds,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
    setExecutionOverviewRevision,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const embedded = query.get("host") === "codex";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [manualRefreshActive, setManualRefreshActive] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [interventionView, setInterventionView] = useState<TaskInterventionView | null>(
    () => readTaskInterventionView(),
  );
  const [showEmptyColumns, setShowEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [detailQueueSnapshot, setDetailQueueSnapshot] = useState<DetailQueueSnapshot | null>(null);
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [executionOverviewRevision, setExecutionOverviewRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [reassigningTask, setReassigningTask] = useState<Task | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [taskboardSidebarOpen, setTaskboardSidebarOpen] = useState(false);
  const [projectVisibilityEditing, setProjectVisibilityEditing] = useState(false);
  const [hiddenProjectIds, setHiddenProjectIds] = useState(readHiddenProjectIds);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksLoadingRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const projectVisibilityInitializedRef = useRef(
    window.localStorage.getItem(HIDDEN_PROJECTS_KEY) !== null,
  );
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedProjectIdsRef = useRef(selectedProjectIds);
  selectedProjectIdRef.current = selectedProjectId;
  selectedProjectIdsRef.current = selectedProjectIds;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const automationRequestInFlightRef = useRef(false);
  const projectAutomationsRef = useRef(projectAutomations);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const hasSelectedProjects = selectedProjectIds.length > 0;
  const isMultiProjectView = selectedProjectIds.length > 1;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const selectedProjectCategory = selectedProject ? projectCategory(selectedProject.id) : null;
  const selectedWorkspacePath = selectedProjectCategory === "program"
    ? undefined
    : selectedDeviceWorkspacePath
      ?? selectedProject?.workspacePath
      ?? (
        hostContext?.projectId === selectedProject?.id
          ? hostContext?.workspacePath
          : undefined
      );
  const selectedCodexProjectId = selectedProject?.id === "local"
    ? hostContext?.projectId
    : (
      hostContext?.projects?.find((project) => project.id === selectedProject?.id)?.id
      ?? hostContext?.projects?.find(
        (project) => deviceWorkspacePaths[project.id] === selectedWorkspacePath,
      )?.id
    );
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    if (!embedded || window.parent === window) {
      return { unavailableReason: "仅可在 Codex App 中使用" };
    }
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!selectedProject) return { unavailableReason: "请先选择项目" };

    if (!selectedWorkspacePath || !selectedCodexProjectId) {
      return { unavailableReason: "请先在 Codex 中添加并映射该项目目录" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    return {
      workspacePath: selectedWorkspacePath,
      codexProjectId: selectedCodexProjectId,
      unavailableReason: null,
    };
  }, [
    embedded,
    manageTaskboardSkillPath,
    selectedProject,
    selectedCodexProjectId,
    selectedWorkspacePath,
  ]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => (
      task.identifier === detailTaskIdentifier
      || task.previousIdentifiers?.includes(detailTaskIdentifier)
    )) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const localExecutionOverviewAvailable = localAiChatAvailable && taskboardMetadata?.mode !== "cloud";
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const persistedByWorkspace = new Map<string, Project[]>();
    for (const project of projects) {
      const workspacePath = normalizedWorkspacePath(project.workspacePath);
      if (!workspacePath) continue;
      const matches = persistedByWorkspace.get(workspacePath) ?? [];
      matches.push(project);
      persistedByWorkspace.set(workspacePath, matches);
    }
    const seenPersistedIds = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name) continue;
      const hostWorkspacePath = normalizedWorkspacePath(deviceWorkspacePaths[project.id]);
      const workspaceMatches = hostWorkspacePath
        ? persistedByWorkspace.get(hostWorkspacePath) ?? []
        : [];
      const canonical = [...workspaceMatches].sort((left, right) => (
        right.issueCount - left.issueCount
        || Number(right.id === project.id) - Number(left.id === project.id)
      ))[0] ?? persistedById.get(project.id) ?? null;
      for (const match of workspaceMatches) seenPersistedIds.add(match.id);
      if (persistedById.has(project.id)) seenPersistedIds.add(project.id);
      if (canonical) seenPersistedIds.add(canonical.id);
      const canonicalId = canonical?.id ?? project.id;
      choices.push({
        id: canonicalId,
        name: canonical?.name ?? project.name,
        issueCount: canonical?.issueCount ?? 0,
        inCodex: true,
        persisted: Boolean(canonical),
        workspacePath: hostWorkspacePath ?? canonical?.workspacePath ?? null,
        category: projectCategory(canonicalId),
      });
    }
    for (const project of projects) {
      if (seenPersistedIds.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        workspacePath: deviceWorkspacePaths[project.id] ?? project.workspacePath,
        category: projectCategory(project.id),
      });
    }
    return choices
      .filter((project) => (
        !INBOX_PROJECT_IDS.has(project.id)
        && (project.inCodex || project.issueCount > 0)
      ))
      .sort((left, right) => (
        Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
      ));
  }, [deviceWorkspacePaths, favoriteProjectIds, hostContext?.projects, projects]);
  const projectNamesById = useMemo(
    () => new Map(projectChoices.map((project) => [project.id, project.name])),
    [projectChoices],
  );
  const projectGroups = useMemo(() => ([
    {
      id: "projects",
      title: "正式项目",
      projects: projectChoices.filter((project) => project.category === "project"),
    },
    {
      id: "inboxes",
      title: "收件箱",
      projects: projectChoices.filter((project) => project.category === "inbox"),
    },
    {
      id: "programs",
      title: "跨项目任务组",
      projects: projectChoices.filter((project) => project.category === "program"),
    },
  ].filter((group) => group.projects.length > 0)), [projectChoices]);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      window.localStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: Pick<
      ProjectAutomationRecord,
      "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort"
    >,
    automationId?: string,
  ) => {
    if (
      !selectedProject
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
    ) {
      return Promise.reject(new Error(
        automationProjectContext.unavailableReason ?? "无法读取项目自动化信息",
      ));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error("Codex 自动化没有响应，请稍后重试"));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    window.parent.postMessage({
      type: "taskboard:automation-request",
      payload: {
        requestId,
        operation,
        taskboardProjectId: selectedProjectId,
        codexProjectId: automationProjectContext.codexProjectId,
        projectName: selectedProject.name,
        workspacePath: automationProjectContext.workspacePath,
        skillPath: manageTaskboardSkillPath,
        ...(automationId ? { automationId } : {}),
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
    }, "*");
    return response;
  }, [
    automationProjectContext,
    manageTaskboardSkillPath,
    selectedProject,
    selectedProjectId,
  ]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (automationProjectContext.unavailableReason) {
      setAutomationError(null);
      return;
    }
    if (!selectedProjectId || !automationProjectContext.codexProjectId || automationRequestInFlightRef.current) return;
    const stored = projectAutomationsRef.current[selectedProjectId];
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      const response = await sendAutomationRequest("list", options, stored?.automationId);
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
      const item = items.find((candidate) => (
        candidate.id === (stored?.automationId ?? policy?.automationId)
      ))
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored || policy) {
          writeProjectAutomation(selectedProjectId, {
            automationId: undefined,
            codexProjectId: automationProjectContext.codexProjectId,
            status: "PAUSED",
            enabledByUser: false,
            quotaAware: false,
            intervalMinutes: policy?.intervalMinutes
              ?? stored?.intervalMinutes
              ?? DEFAULT_AUTOMATION_OPTIONS.intervalMinutes,
            model: policy?.model ?? stored?.model ?? DEFAULT_AUTOMATION_OPTIONS.model,
            reasoningEffort: policy?.reasoningEffort
              ?? stored?.reasoningEffort
              ?? DEFAULT_AUTOMATION_OPTIONS.reasoningEffort,
          });
        }
        return;
      }
      const intervalMinutes = intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(selectedProjectId, {
        automationId: item.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item.status,
        enabledByUser: item.status === "ACTIVE",
        quotaAware: false,
        intervalMinutes,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "无法读取自动化状态");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  useEffect(() => {
    if (!selectedProjectId || automationProjectContext.unavailableReason) return;
    void reconcileProjectAutomation();
  }, [
    automationProjectContext.unavailableReason,
    reconcileProjectAutomation,
    selectedProjectId,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  }) => {
    const stored = projectAutomations[selectedProjectId];
    if (
      !selectedProjectId
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const normalizedOptions = { ...options, quotaAware: false };
      const operation = normalizedOptions.enabledByUser ? "ensure-active" : "pause";
      const response = await sendAutomationRequest(
        operation,
        normalizedOptions,
        stored?.automationId,
      );
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(selectedProjectId, {
        automationId: item?.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: item?.status === "ACTIVE",
        quotaAware: false,
        intervalMinutes: normalizedOptions.intervalMinutes,
        model: normalizedOptions.model,
        reasoningEffort: normalizedOptions.reasoningEffort,
      });
    } catch (error) {
      writeProjectAutomation(selectedProjectId, previousRecord);
      setAutomationError(error instanceof Error ? error.message : "无法更新自动化");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  function captureDetailQueue(task: Task, sourceTasks = tasksRef.current): DetailQueueSnapshot {
    const orderedTasks = TASK_STATUSES.flatMap((status) => sourceTasks.filter(
      (candidate) => candidate.status === status
        && matchesTaskSearch(candidate, search)
        && matchesTaskFilters(candidate, filters),
    ));
    const queueTasks = interventionView
      ? orderedTasks.filter((candidate) => taskIntervention(candidate).views.includes(interventionView))
      : orderedTasks.filter((candidate) => candidate.status === task.status);
    return {
      label: interventionView
        ? TASK_INTERVENTION_VIEW_DETAILS[interventionView].label
        : STATUS_DETAILS[task.status].label,
      taskIds: queueTasks.map((candidate) => candidate.id),
    };
  }

  function showTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    const detailProjectIds = selectedProjectIds.includes(task.projectId)
      ? selectedProjectIds
      : [task.projectId];
    setSelectedProjectId(task.projectId);
    setSelectedProjectIds(detailProjectIds);
    setDetailTaskIdentifier(task.identifier);
    const detailUrl = buildIssueUrl(
      window.location.href,
      task.projectId,
      task.identifier,
      detailProjectIds,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    const selectedTask = tasksRef.current.find((candidate) => (
      candidate.projectId === task.projectId
      && (
        candidate.identifier === task.identifier
        || candidate.previousIdentifiers?.includes(task.identifier)
      )
    ));
    setDetailQueueSnapshot(selectedTask ? captureDetailQueue(selectedTask) : null);
    showTaskDetail(task);
  }

  function openTaskFromDetailQueue(task: Pick<Task, "identifier" | "projectId">) {
    showTaskDetail(task);
  }

  function closeTaskDetail() {
    const projectId = selectedProjectIds.length === 1 ? selectedProjectIds[0] : "";
    setDetailQueueSnapshot(null);
    setDetailTaskIdentifier(null);
    setSelectedProjectId(projectId);
    const url = buildIssueUrl(window.location.href, projectId || null, null, selectedProjectIds);
    window.history.replaceState(window.history.state, "", url);
  }

  function selectInterventionView(view: TaskInterventionView | null) {
    setInterventionView((current) => {
      const next = current === view ? null : view;
      writeTaskInterventionView(next);
      return next;
    });
  }

  function clearInterventionView() {
    setInterventionView(null);
    writeTaskInterventionView(null);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectIds = readSelectedProjectIds(url.search);
      const routeProjectId = url.searchParams.get("project")
        ?? (routeProjectIds.length === 1 ? routeProjectIds[0] : "");
      setDetailQueueSnapshot(null);
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
      setInterventionView(readTaskInterventionView(url.search));
      setBoardView("issues");
      setSelectedProjectIds(routeProjectIds);
      setSelectedProjectId(routeProjectId);
      if (routeProjectIds.length === 1) {
        window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectIds[0]);
      }
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!detailTask) {
      if (detailQueueSnapshot) setDetailQueueSnapshot(null);
      return;
    }
    if (!detailQueueSnapshot) {
      setDetailQueueSnapshot(captureDetailQueue(detailTask, tasks));
    }
  }, [detailTask?.id, detailQueueSnapshot, tasks]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "Codex 无法更新自动化",
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "无法在 Codex 中创建对话。");
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingAutomationRequestsRef.current.clear();
    };
  }, [embedded]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({
      type: "taskboard:route",
      payload: { href: window.location.href },
    }, "*");
  }, [detailTaskIdentifier, embedded, interventionView, selectedProjectIds]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      const availableProjectIds = new Set(nextProjects.map((project) => project.id));
      const fromQuery = readSelectedProjectIds(window.location.search)
        .filter((projectId) => availableProjectIds.has(projectId));
      const current = selectedProjectIdsRef.current
        .filter((projectId) => availableProjectIds.has(projectId));
      const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
      const nextSelection = fromQuery.length > 0
        ? fromQuery
        : current.length > 0
          ? current
          : remembered && availableProjectIds.has(remembered)
            ? [remembered]
            : [];
      const routeProjectId = new URLSearchParams(window.location.search).get("project");
      const focusedProjectId = routeProjectId && availableProjectIds.has(routeProjectId)
        ? routeProjectId
        : nextSelection.length === 1
          ? nextSelection[0]
          : "";
      setSelectedProjectIds(nextSelection);
      setSelectedProjectId(focusedProjectId);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  useEffect(() => {
    if (projectsLoading || projectVisibilityInitializedRef.current) return;
    projectVisibilityInitializedRef.current = true;
    const next = new Set(projects.filter((project) => project.issueCount === 0).map((project) => project.id));
    setHiddenProjectIds(next);
    window.localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...next]));
  }, [projects, projectsLoading]);

  useEffect(() => {
    if (!taskboardSidebarOpen) return;
    function closeSidebar(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTaskboardSidebarOpen(false);
        setProjectVisibilityEditing(false);
      }
    }
    window.addEventListener("keydown", closeSidebar);
    return () => window.removeEventListener("keydown", closeSidebar);
  }, [taskboardSidebarOpen]);

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectIds: string[],
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TASK_REFRESH_TIMEOUT_MS);
    if (!options.quiet) {
      tasksLoadingRequestRef.current = requestId;
      setTasksLoading(true);
    }
    setLoadError(null);
    try {
      const uniqueProjectIds = [...new Set(projectIds)];
      const nextTasks = await listTasks(
        uniqueProjectIds.length === 1 ? uniqueProjectIds[0] : undefined,
        controller.signal,
      );
      if (requestId !== tasksRequestRef.current) return false;
      const selectedProjectIdSet = new Set(uniqueProjectIds);
      setTasks(sortTasks(nextTasks.filter((task) => selectedProjectIdSet.has(task.projectId))));
      setHasLoadedTasks(true);
      return true;
    } catch (error) {
      if (timedOut && !options.quiet) {
        setLoadError("刷新超时，请点击“重载”重新连接任务面板。");
      } else if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
      return false;
    } finally {
      window.clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (!options.quiet && requestId === tasksLoadingRequestRef.current) setTasksLoading(false);
    }
  }, []);

  async function refreshBoard() {
    if (manualRefreshActive) return;
    setManualRefreshActive(true);
    let succeeded = false;
    try {
      [succeeded] = await Promise.all([
        refreshTasks(selectedProjectIds),
        new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
      ]);
    } finally {
      setManualRefreshActive(false);
    }
    if (succeeded) setAnnouncement("看板已刷新。");
  }

  function reloadLatestInterface() {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: "taskboard:reload-frame" }, "*");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("__codex_taskboard_refresh", Date.now().toString(36));
    window.location.replace(url.href);
  }

  useEffect(() => {
    if (selectedProjectIds.length === 0) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectIds, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectIds]);

  useEffect(() => {
    if (selectedProjectIds.length === 0) return;
    const timer = window.setInterval(() => {
      void refreshTasks(selectedProjectIds, { quiet: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshTasks, selectedProjectIds]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [refreshWorkflowOptions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = selectedCodexProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(selectedProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    selectedCodexProjectId,
    selectedProjectId,
    selectedWorkspacePath,
  ]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: () => {
        void refreshProjectList();
        const projectIds = selectedProjectIdsRef.current;
        const projectId = selectedProjectIdRef.current;
        if (projectIds.length > 0) {
          void refreshTasks(projectIds, { quiet: true });
        }
        if (projectId) {
          void refreshWorkflowOptions(projectId).catch(() => {});
        }
        setWorkflowRevision((current) => current + 1);
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      },
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "backlog" });
      }
      if (event.key === "/" && !detailTaskId && hasSelectedProjects && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, hasSelectedProjects, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search)
        && matchesTaskFilters(task, filters)
        && (!interventionView || taskIntervention(task).views.includes(interventionView)),
    );
  }, [filters, interventionView, search, tasks]);

  const detailQueueNavigation = useMemo(() => {
    if (!detailTask) return { label: "议题", previousTask: null, nextTask: null };
    const snapshot = detailQueueSnapshot ?? captureDetailQueue(detailTask, tasks);
    const currentIndex = snapshot.taskIds.indexOf(detailTask.id);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const previousTask = currentIndex > 0
      ? snapshot.taskIds
        .slice(0, currentIndex)
        .reverse()
        .map((taskId) => taskById.get(taskId))
        .find((task): task is Task => Boolean(task)) ?? null
      : null;
    const nextTask = currentIndex >= 0
      ? snapshot.taskIds
        .slice(currentIndex + 1)
        .map((taskId) => taskById.get(taskId))
        .find((task): task is Task => Boolean(task)) ?? null
      : null;
    return { label: snapshot.label, previousTask, nextTask };
  }, [detailQueueSnapshot, detailTask?.id, tasks]);

  const interventionCounts = useMemo(() => (
    Object.fromEntries(
      TASK_INTERVENTION_VIEWS.map((view) => [
        view,
        tasks.filter((task) => taskIntervention(task).views.includes(view)).length,
      ]),
    ) as Record<TaskInterventionView, number>
  ), [tasks]);

  const activeFilterCount = taskFilterCount(filters);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const columnVisibility = columnVisibilityByProject[selectedProjectId];

  const visibleStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? showEmptyColumns
        : (columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  const hiddenStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? !showEmptyColumns
        : !(columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  function updateShowEmptyColumns(show: boolean) {
    window.localStorage.setItem(SHOW_EMPTY_COLUMNS_KEY, String(show));
    setShowEmptyColumns(show);
  }

  function updateColumnVisibility(status: TaskStatus, visible: boolean) {
    if (!selectedProjectId || tasksByStatus[status].length === 0) return;
    setColumnVisibilityByProject((current) => {
      const next = {
        ...current,
        [selectedProjectId]: {
          ...current[selectedProjectId],
          [status]: visible,
        },
      };
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setBoardView(view);
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!selectedProjectId || !editor) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(selectedProjectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === selectedProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} 已更新。`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectIds, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => (
      candidate.projectId === task.projectId
      && candidate.status === status
      && candidate.id !== task.id
    ));
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status
    ));
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? `${task.identifier} 排序已调整。`
        : `${task.identifier} 已移至${STATUS_DETAILS[status].label}。`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
      if (["backlog", "blocked"].includes(task.status) && status === "todo") {
        const parent = task.relations.parent
          ? tasksRef.current.find((candidate) => candidate.id === task.relations.parent?.id)
          : null;
        setAnnouncement(parent && taskAiRole(parent) === "planner"
          ? `${task.identifier} 已进入待开发，${parent.identifier} 的 Sol Max 正在进行派发审核。`
          : `${task.identifier} 已进入待开发，Sol X-High 正在进行需求审核。`);
      }
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  async function reassignTask(task: Task, projectId: string) {
    setActionError(null);
    try {
      const reassigned = await reassignTaskRequest(task, projectId);
      const targetProject = projects.find((project) => project.id === reassigned.projectId);
      setReassigningTask(null);
      setProjectMenuOpen(false);
      setBoardView("issues");
      setSelectedProjectIds([reassigned.projectId]);
      setSelectedProjectId(reassigned.projectId);
      window.localStorage.setItem(LAST_PROJECT_KEY, reassigned.projectId);
      setSearch("");
      setFilters(EMPTY_TASK_FILTERS);
      clearInterventionView();
      setDetailQueueSnapshot(null);
      setDetailTaskIdentifier(reassigned.identifier);
      window.history.replaceState(
        window.history.state,
        "",
        buildIssueUrl(window.location.href, reassigned.projectId, reassigned.identifier, [reassigned.projectId]),
      );
      setTasks([reassigned]);
      void refreshProjectList();
      setAnnouncement(`${reassigned.identifier} 已切换到${targetProject?.name ?? "目标项目"}，状态保持不变。`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT" && selectedProjectId) {
        void refreshTasks(selectedProjectIds, { quiet: true });
      }
      throw error;
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} 已更新。`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
      throw error;
    }
  }

  async function updateTaskInterventionOverride(
    task: Task,
    view: TaskInterventionView,
    mode: TaskInterventionManualMode | "auto",
  ) {
    setActionError(null);
    try {
      const updated = await setTaskInterventionOverride(task, view, mode);
      setTasks((current) => sortTasks(current.map((candidate) => (
        candidate.id === updated.id ? updated : candidate
      ))));
      setAnnouncement(`${task.identifier} 的${TASK_INTERVENTION_VIEW_DETAILS[view].label}已${
        mode === "auto" ? "恢复自动判断" : mode === "include" ? "强制加入" : "暂时移出"
      }。`);
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} 副本已创建。`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      pushUndo(`${task.identifier} 已归档。`, async () => {
        const restored = await restoreTaskRequest(archived);
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
    }
  }

  async function restoreArchivedTask(taskId: string, version: number) {
    setActionError(null);
    try {
      const restored = await restoreTaskByVersion(taskId, version);
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      if (selectedProjectIds.length > 0) await refreshTasks(selectedProjectIds, { quiet: true });
      await refreshProjectList();
      setExecutionOverviewRevision((current) => current + 1);
      setAnnouncement(`${restored.identifier} 已恢复。`);
    } catch (error) {
      setActionError(error instanceof ApiError && error.status === 409
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds, { quiet: true });
      void refreshProjectList();
      setExecutionOverviewRevision((current) => current + 1);
      throw error;
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
    } catch {
      setActionError("无法写入剪贴板。");
    }
  }

  function openThread(threadId: string) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: "taskboard:open-thread", payload: { threadId } }, "*");
      return;
    }

    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function openAiThread(threadId: string) {
    window.dispatchEvent(new CustomEvent("taskboard:ai-thread-open", {
      detail: { threadId },
    }));
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function closeTaskboardSidebar() {
    setTaskboardSidebarOpen(false);
    setProjectVisibilityEditing(false);
  }

  function openTaskInThread(task: Task) {
    if (!manageTaskboardSkillPath) {
      setActionError("任务面板还没有读取到 manage-taskboard Skill 路径，请刷新后重试。");
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const workspacePath = worktreePath
      ?? selectedWorkspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `e-taskboard Addressing the issues mentioned in ${task.identifier}`;
    const prompt = `[$manage-taskboard](${manageTaskboardSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find(
      (project) => project.id === selectedCodexProjectId,
    );
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        skillName: "manage-taskboard",
        skillDisplayName: "Manage Taskboard",
        skillPath: manageTaskboardSkillPath,
        codexProjectId: codexProject?.id ?? selectedCodexProjectId,
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    closeTaskboardSidebar();
    setDetailTaskIdentifier(null);
      setBoardView("issues");
    setSelectedProjectIds([projectId]);
      setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
      setSearch("");
      setFilters(EMPTY_TASK_FILTERS);
      clearInterventionView();
      setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null, [projectId]);
    window.history.replaceState(null, "", url);
  }

  function applyProjectSelection(projectIds: string[]) {
    const nextProjectIds = [...new Set(projectIds)];
    const projectId = nextProjectIds.length === 1 ? nextProjectIds[0] : "";
    closeContextMenu();
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setSelectedProjectIds(nextProjectIds);
    setSelectedProjectId(projectId);
    if (projectId) window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    else if (nextProjectIds.length === 0) window.localStorage.removeItem(LAST_PROJECT_KEY);
    clearInterventionView();
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId || null, null, nextProjectIds);
    window.history.replaceState(null, "", url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectIds([]);
    setSelectedProjectId("");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    clearInterventionView();
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, null, null);
    window.history.replaceState(null, "", url);
    void loadProjectList();
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    const shouldFavorite = !favoriteProjectIds.has(selectedProjectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(selectedProjectId);
      else next.delete(selectedProjectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${selectedProject?.name ?? "项目"}${shouldFavorite ? "已收藏。" : "已取消收藏。"}`);
  }

  function toggleProjectVisibility(projectId: string) {
    setHiddenProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      window.localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  async function ensureProject(choice: ProjectChoice): Promise<Project> {
    let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
    if (project) return project;
    try {
      project = await createProjectRequest({
        id: choice.id,
        name: choice.name,
        workspacePath: null,
      });
      setProjects((current) => [...current, project!]);
      return project;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
      const nextProjects = await listProjects();
      setProjects(nextProjects);
      project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) throw error;
      return project;
    }
  }

  async function openProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      const project = await ensureProject(choice);
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  async function toggleProjectSelection(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      const project = await ensureProject(choice);
      const nextProjectIds = selectedProjectIds.includes(project.id)
        ? selectedProjectIds.filter((projectId) => projectId !== project.id)
        : [...selectedProjectIds, project.id];
      applyProjectSelection(nextProjectIds);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = isMultiProjectView && !detailTask
    ? `已选 ${selectedProjectIds.length} 个项目`
    : selectedProject?.name ?? "任务面板";
  const headerProjectAvatar = isMultiProjectView && !detailTask
    ? String(selectedProjectIds.length)
    : headerProjectName.slice(0, 1).toUpperCase();
  const standaloneProjects = projects.filter((project) => !INBOX_PROJECT_IDS.has(project.id));
  const hiddenProjectCount = standaloneProjects
    .filter((project) => hiddenProjectIds.has(project.id)).length;
  const sidebarProjects = projectVisibilityEditing
    ? standaloneProjects
    : standaloneProjects.filter((project) => !hiddenProjectIds.has(project.id));
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          selectedProjectIds={selectedProjectIds}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setExecutionOverviewRevision={setExecutionOverviewRevision}
        />
      )}
      {embedded && taskboardSidebarOpen && (
        <button
          className="taskboard-sidebar-backdrop"
          type="button"
          aria-label="收起任务面板侧栏"
          onClick={closeTaskboardSidebar}
        />
      )}
      <aside
        className={`app-nav${embedded ? ` taskboard-drawer${taskboardSidebarOpen ? " is-open" : ""}` : ""}`}
        aria-label="Taskboard navigation"
        aria-hidden={embedded && !taskboardSidebarOpen}
        inert={embedded && !taskboardSidebarOpen ? true : undefined}
      >
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>任务面板</span>
            {embedded && (
              <button
                className="app-nav-close"
                type="button"
                aria-label="收起任务面板侧栏"
                onClick={closeTaskboardSidebar}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">工作区</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="project-nav">
            <div className="project-nav-heading">
              <span className="nav-label">项目</span>
              <button
                className="project-nav-edit"
                type="button"
                onClick={() => setProjectVisibilityEditing((current) => !current)}
              >
                {projectVisibilityEditing ? "完成" : "编辑"}
              </button>
            </div>
            {sidebarProjects.map((project) => {
              const hidden = hiddenProjectIds.has(project.id);
              return projectVisibilityEditing ? (
                <button
                  key={project.id}
                  type="button"
                  className={`project-nav-item project-visibility-item${hidden ? " is-hidden" : ""}`}
                  aria-pressed={!hidden}
                  onClick={() => toggleProjectVisibility(project.id)}
                >
                  <span className="project-visibility-check" aria-hidden="true">
                    {!hidden && <LinearIcon name="check" />}
                  </span>
                  <span>{project.name}</span>
                  <span className="project-nav-count">{project.issueCount}</span>
                </button>
              ) : (
                <button
                  key={project.id}
                  type="button"
                  className={`project-nav-item${selectedProjectIds.includes(project.id) ? " active" : ""}`}
                  onClick={() => changeProject(project.id)}
                >
                  <span className="project-dot" aria-hidden="true" />
                  <span>{project.name}</span>
                  <span className="project-nav-count">{project.issueCount}</span>
                </button>
              );
            })}
            {!projectVisibilityEditing && hiddenProjectCount > 0 && (
              <button
                className="project-hidden-summary"
                type="button"
                onClick={() => setProjectVisibilityEditing(true)}
              >
                {hiddenProjectCount} 个项目已隐藏
              </button>
            )}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "实时同步" : "正在重新连接…"}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>

      <main className="workspace">
        {hasSelectedProjects ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {embedded && (
                <button
                  className="detail-back-button taskboard-sidebar-trigger"
                  type="button"
                  aria-label="展开任务面板侧栏"
                  title="展开任务面板侧栏"
                  aria-expanded={taskboardSidebarOpen}
                  onClick={() => setTaskboardSidebarOpen(true)}
                >
                  <LinearIcon name="panel" />
                </button>
              )}
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label="返回议题看板"
                  title="返回议题看板 (Esc)"
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="展开 Codex 侧边栏"
                  title="展开侧边栏"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {hasSelectedProjects && (
                <button
                  className="detail-back-button project-home-button"
                  type="button"
                  aria-label="返回项目首页"
                  title="返回项目首页"
                  onClick={returnToProjectHome}
                >
                  <LinearIcon name="home" />
                  <span>首页</span>
                </button>
              )}
              {hasSelectedProjects && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {hasSelectedProjects ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="选择项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectAvatar}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>选择项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selectedProjectIds.includes(project.id)}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => void toggleProjectSelection(project)}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {selectedProjectIds.includes(project.id) && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {!hasSelectedProjects && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProjectId && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProjectId && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && (
              <ProjectAutomationMenu
                projectName={headerProjectName}
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
              />
            )}
            {selectedProjectId && boardView === "issues" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "backlog" })}
                aria-label="新建议题"
                title="新建议题 (C)"
              >
                <LinearIcon name="plus" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <>
            <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
            {embedded && (
              <button
                className="taskboard-sidebar-trigger home-sidebar-trigger"
                type="button"
                aria-label="展开任务面板侧栏"
                title="展开任务面板侧栏"
                aria-expanded={taskboardSidebarOpen}
                onClick={() => setTaskboardSidebarOpen(true)}
              >
                <LinearIcon name="panel" />
              </button>
            )}
          </>
        )}

        {hasSelectedProjects && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              议题看板
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                节点模式
              </button>
            )}
          </div>
          {isMultiProjectView && (
            <span className="multi-project-mode-note">聚合查看模式 · 打开任务后可编辑</span>
          )}
          {boardView === "issues" && (
            <div className="intervention-view-strip" aria-label="待我介入快捷筛选">
              {TASK_INTERVENTION_VIEWS.map((view) => {
                const details = TASK_INTERVENTION_VIEW_DETAILS[view];
                const active = interventionView === view;
                return (
                  <button
                    className={`intervention-view-button${active ? " active" : ""}`}
                    key={view}
                    type="button"
                    aria-pressed={active}
                    title={details.description}
                    onClick={() => selectInterventionView(view)}
                  >
                    <span>{details.label}</span>
                    <strong>{interventionCounts[view]}</strong>
                  </button>
                );
              })}
            </div>
          )}
          {boardView === "issues" && <div className="toolbar-tools">
            <button
              className={`icon-button board-refresh-button${tasksLoading || manualRefreshActive ? " is-loading" : ""}`}
              type="button"
              disabled={tasksLoading || manualRefreshActive}
              aria-label={tasksLoading || manualRefreshActive ? "正在刷新看板" : "刷新看板"}
              title={tasksLoading || manualRefreshActive ? "正在刷新看板" : "刷新看板"}
              onClick={() => void refreshBoard()}
            >
              <LinearIcon name="refresh" />
            </button>
            <button
              className="icon-button interface-reload-button"
              type="button"
              aria-label="加载最新界面"
              title="加载最新界面（获取最新代码）"
              onClick={reloadLatestInterface}
            >
              <LinearIcon name="refresh" />
              <span>重载</span>
            </button>
            <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">搜索议题</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索议题或 #编号…"
              />
              {!search && <kbd>/</kbd>}
            </label>
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            <BoardSettingsMenu
              showEmptyColumns={showEmptyColumns}
              onShowEmptyColumnsChange={updateShowEmptyColumns}
            />
            {(search || activeFilterCount > 0 || interventionView) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="清除筛选"
                title="清除筛选"
                onClick={() => {
                  setSearch("");
                  setFilters(EMPTY_TASK_FILTERS);
                  clearInterventionView();
                }}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>Taskboard needs attention</strong><p>{actionError ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectIds.length > 0) void refreshTasks(selectedProjectIds);
                else void loadProjectList();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!hasSelectedProjects ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>任务面板</span>
              <h1>选择项目</h1>
              <p>按正式项目、收件箱和跨项目任务组查看。</p>
            </div>
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {projectGroups.map((group) => (
                  <section className="project-home-group" key={group.id} aria-labelledby={`project-group-${group.id}`}>
                    <div className="project-group-heading">
                      <h2 id={`project-group-${group.id}`}>{group.title}</h2>
                      <span>{group.projects.length}</span>
                    </div>
                    {group.projects.length > 0 ? (
                      <div className="project-grid">
                        {group.projects.map((project) => (
                          <div className="project-card" key={project.id}>
                            <button
                              className="project-card-open"
                              type="button"
                              disabled={openingProjectId !== null}
                              onClick={() => void openProject(project)}
                            >
                              <span className="project-card-avatar" aria-hidden="true">
                                {project.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="project-card-copy">
                                <strong>{project.name}</strong>
                                <span>
                                  {project.category === "inbox"
                                    ? "收件箱"
                                    : project.category === "program"
                                      ? "workflow-bridge · 跨项目任务组"
                                      : project.inCodex ? "Codex 项目" : "已保存的项目"}
                                  {project.issueCount > 0 ? ` · ${project.issueCount} 个议题` : ""}
                                </span>
                              </span>
                              {favoriteProjectIds.has(project.id) && <span className="project-card-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                              <span className="project-card-action" aria-hidden="true">
                                {openingProjectId === project.id ? "正在打开…" : <LinearIcon name="chevronRight" />}
                              </span>
                            </button>
                            {project.category !== "project" ? (
                              <div className="project-card-directory is-static">
                                <LinearIcon name="folder" />
                                <span>{project.category === "inbox"
                                  ? "不绑定开发目录"
                                  : "跨仓库任务组，不绑定单一目录"}</span>
                              </div>
                            ) : (
                              <label className="project-card-directory">
                                <LinearIcon name="folder" />
                                <input
                                  key={project.workspacePath ?? ""}
                                  type="text"
                                  defaultValue={project.workspacePath ?? ""}
                                  placeholder="设置此设备的项目目录"
                                  aria-label={`${project.name} 在此设备上的项目目录`}
                                  onBlur={(event) => rememberDeviceWorkspacePath(project.id, event.currentTarget.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") event.currentTarget.blur();
                                  }}
                                />
                              </label>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="project-group-empty">暂无项目</p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <div className="project-home-empty">
                <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
                <h2>还没有项目</h2>
                <p>在 Codex 中创建项目后，再打开任务面板。</p>
              </div>
            )}
          </section>
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            executionOverviewRevision={executionOverviewRevision}
            localAiChatAvailable={localExecutionOverviewAvailable}
            queueNavigation={detailQueueNavigation}
            onNavigateQueue={openTaskFromDetailQueue}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onReassign={(task) => setReassigningTask(task)}
            onRestoreArchivedTask={restoreArchivedTask}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenAiThread={openAiThread}
            onOpenInThread={openTaskInThread}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开节点模式…</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {TASK_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : (
          <div className={`board-scroll${manualRefreshActive ? " is-refreshing" : ""}`} aria-label="Issue board">
            {manualRefreshActive && (
              <div className="board-refresh-feedback" role="status">
                <LinearIcon name="refresh" />
                正在刷新看板…
              </div>
            )}
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && !showEmptyColumns && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFilters(EMPTY_TASK_FILTERS);
                      clearInterventionView();
                    }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {visibleStatuses.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  statusIndex={TASK_STATUSES.indexOf(status)}
                  tasks={tasksByStatus[status]}
                  allTasks={tasks}
                  interventionView={interventionView}
                  projectNames={isMultiProjectView ? projectNamesById : null}
                  allowBoardActions
                  allowColumnActions={!isMultiProjectView}
                  isDropTarget={dropTarget === status}
                  draggedTaskId={draggedTaskId}
                  draggedTaskHeight={draggedTaskHeight}
                  movingTaskId={movingTaskId}
                  settlingTaskId={settlingTaskId}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                  onEdit={openTaskDetail}
                  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                  onMove={(task, destination) => void moveTask(task, destination)}
                  onDragStart={(task, height) => {
                    setDraggedTaskId(task.id);
                    setDraggedTaskHeight(height);
                    setDropTarget(task.status);
                  }}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setDraggedTaskHeight(0);
                    setDropTarget(null);
                  }}
                  onDragEnter={setDropTarget}
                  onDrop={finishTaskDrop}
                  onOpenThread={openThread}
                  onHide={(hiddenStatus) => updateColumnVisibility(hiddenStatus, false)}
                />
              ))}
              {hiddenStatuses.length > 0 && (
                <HiddenColumns
                  statuses={hiddenStatuses}
                  counts={Object.fromEntries(
                    TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
                  ) as Record<TaskStatus, number>}
                  dropTarget={dropTarget}
                  onDragTargetChange={setDropTarget}
                  onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
                  onShow={(shownStatus) => updateColumnVisibility(shownStatus, true)}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      {reassigningTask && (
        <TaskProjectReassignDialog
          task={reassigningTask}
          projects={projects}
          onCancel={() => setReassigningTask(null)}
          onConfirm={(projectId) => reassignTask(reassigningTask, projectId)}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} 优先级已更新。`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} 标签已更新。`,
          ).catch(() => {})}
          onInterventionOverride={(task, view, mode) => void updateTaskInterventionOverride(task, view, mode)}
          onReassign={(task) => setReassigningTask(task)}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        allowLocalArchiveRestore={localAiChatAvailable && taskboardMetadata?.mode !== "cloud"}
        projectId={selectedProjectId || null}
        issueId={detailTaskId}
        preferredThreadId={detailTask?.readinessReview
          && ["running", "awaiting_input", "failed"].includes(detailTask.readinessReview.status)
          ? detailTask.readinessReview.aiThreadId
          : null}
        issueRole={detailTask ? taskAiRole(detailTask) : null}
        onOpenTask={openTaskDetail}
      />

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
  );
}
