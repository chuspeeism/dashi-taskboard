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
  getProjectAutomation,
  getTaskboardMetadata,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  setCurrentUserActor,
  uploadAttachment,
  updateTask as updateTaskRequest,
  upsertProjectAutomation,
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
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
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
  TASK_STATUSES,
  type ActorIdentity,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
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

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
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
type AutomationIntervalSeconds = 5 | 300 | 600 | 900 | 1800 | 3600;

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
  intervalSeconds: AutomationIntervalSeconds;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalSeconds: 300,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
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
      const intervalSeconds = candidate.intervalSeconds
        ?? ((candidate as Partial<ProjectAutomationRecord> & { intervalMinutes?: number }).intervalMinutes ?? 5) * 60;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalSeconds(intervalSeconds)
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
        intervalSeconds,
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

function isAutomationIntervalSeconds(value: unknown): value is AutomationIntervalSeconds {
  return value === 5 || value === 300 || value === 600 || value === 900 || value === 1800 || value === 3600;
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
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
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
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
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
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [showEmptyColumns, setShowEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
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

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    if (!embedded || window.parent === window) {
      return { unavailableReason: "仅可在 Codex App 中使用" };
    }
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!selectedProject) return { unavailableReason: "请先选择项目" };

    const directCodexProject = hostContext?.projects?.some(
      (project) => project.id === selectedProject.id,
    );
    const workspacePath = deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === selectedProject.id
          ? hostContext.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? selectedProject.id
      : hostContext?.projects?.find(
        (project) => deviceWorkspacePaths[project.id] === workspacePath,
      )?.id;

    if (!workspacePath || !codexProjectId) {
      return { unavailableReason: "请先在 Codex 中添加并映射该项目目录" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    return { workspacePath, codexProjectId, unavailableReason: null };
  }, [
    deviceWorkspacePaths,
    embedded,
    hostContext,
    manageTaskboardSkillPath,
    selectedProject,
  ]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
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
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
      });
    }
    return choices.sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [favoriteProjectIds, hostContext?.projects, projects]);
  const projectsWithIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount > 0),
    [projectChoices],
  );
  const projectsWithoutIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount === 0),
    [projectChoices],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        (!record && !(projectId in current))
        || (
          record
          && current[projectId]?.automationId === record.automationId
          && current[projectId]?.codexProjectId === record.codexProjectId
          && current[projectId]?.status === record.status
          && current[projectId]?.enabledByUser === record.enabledByUser
          && current[projectId]?.quotaAware === record.quotaAware
          && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
          && current[projectId]?.intervalSeconds === record.intervalSeconds
          && current[projectId]?.model === record.model
          && current[projectId]?.reasoningEffort === record.reasoningEffort
        )
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

  const reconcileProjectAutomation = useCallback(async () => {
    if (!selectedProjectId || automationRequestInFlightRef.current) return;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const config = await getProjectAutomation(selectedProjectId);
      if (!config) {
        writeProjectAutomation(selectedProjectId, null);
        return;
      }
      writeProjectAutomation(selectedProjectId, {
        automationId: config.taskboardProjectId,
        codexProjectId: automationProjectContext.codexProjectId ?? config.codexProjectId,
        status: config.enabledByUser ? "ACTIVE" : "PAUSED",
        enabledByUser: config.enabledByUser,
        quotaAware: config.quotaAware,
        ...(config.quota ? { quota: config.quota } : {}),
        intervalSeconds: config.intervalSeconds as AutomationIntervalSeconds,
        model: config.model as AutomationModel,
        reasoningEffort: config.reasoningEffort as AutomationReasoningEffort,
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
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalSeconds: AutomationIntervalSeconds;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  }) => {
    const stored = projectAutomations[selectedProjectId];
    if (
      !selectedProjectId
      || !selectedProject
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
      || automationRequestInFlightRef.current
    ) return;
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      await upsertProjectAutomation(selectedProjectId, {
        codexProjectId: automationProjectContext.codexProjectId,
        projectName: selectedProject.name,
        workspacePath: automationProjectContext.workspacePath,
        skillPath: manageTaskboardSkillPath,
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalSeconds: options.intervalSeconds,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
      writeProjectAutomation(selectedProjectId, {
        automationId: selectedProjectId,
        codexProjectId: automationProjectContext.codexProjectId,
        status: options.enabledByUser ? "ACTIVE" : "PAUSED",
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalSeconds: options.intervalSeconds,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
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
    manageTaskboardSkillPath,
    projectAutomations,
    selectedProject,
    selectedProjectId,
    writeProjectAutomation,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(window.location.href, task.projectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(window.location.href, selectedProjectId || null, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? "";
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
      if (routeProjectId === selectedProjectId) return;
      setBoardView("issues");
      setSelectedProjectId(routeProjectId);
      if (routeProjectId) window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectId);
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [selectedProjectId]);

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
    };
  }, [embedded]);

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
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        if (remembered && nextProjects.some((project) => project.id === remembered)) return remembered;
        return "";
      });
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

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await listTasks(projectId, options.signal);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectId]);

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
    const codexProjectId = selectedProjectId === "local" ? hostContext?.projectId : selectedProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(selectedProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
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
    selectedProjectId,
    selectedDeviceWorkspacePath,
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
        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          void refreshTasks(projectId, { quiet: true });
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
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
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
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search) && matchesTaskFilters(task, filters),
    );
  }, [filters, search, tasks]);

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
        void refreshTasks(selectedProjectId, { quiet: true });
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

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
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
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
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
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
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
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
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
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
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

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
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
      ?? selectedDeviceWorkspacePath
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
    const codexProject = hostContext?.projects?.find((project) => project.id === selectedProject?.id);
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
        codexProjectId: codexProject?.id ?? (selectedProject?.id === "local" ? hostContext?.projectId : selectedProject?.id),
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId("");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
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

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = selectedProject?.name ?? "任务面板";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
        />
      )}
      {!embedded && (
        <aside className="app-nav" aria-label="Taskboard navigation">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>任务面板</span>
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
            <span className="nav-label">项目</span>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                onClick={() => changeProject(project.id)}
              >
                <span className="project-dot" aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
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
      )}

      <main className="workspace">
        {selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
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
              {selectedProjectId && (
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
              {selectedProjectId && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
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
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {selectedProjectId && (
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
              {selectedProjectId && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && (
              <ProjectAutomationMenu
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
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {selectedProjectId && <div className="board-toolbar">
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
          {boardView === "issues" && <div className="toolbar-tools">
            <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">搜索议题</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索议题…"
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
            {(search || activeFilterCount > 0) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="清除筛选"
                title="清除筛选"
                onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
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
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                else void loadProjectList();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!selectedProjectId ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>任务面板</span>
              <h1>选择项目</h1>
              <p>从 Codex 项目开始，或继续使用之前保存的项目。</p>
            </div>
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {[
                  { id: "with-issues", title: "已有议题", projects: projectsWithIssues },
                  { id: "without-issues", title: "尚未添加议题", projects: projectsWithoutIssues },
                ].map((group) => (
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
                              onClick={() => void selectProject(project)}
                            >
                              <span className="project-card-avatar" aria-hidden="true">
                                {project.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="project-card-copy">
                                <strong>{project.name}</strong>
                                <span>
                                  {project.inCodex ? "Codex 项目" : "已保存的项目"}
                                  {project.issueCount > 0 ? ` · ${project.issueCount} 个议题` : ""}
                                </span>
                              </span>
                              {favoriteProjectIds.has(project.id) && <span className="project-card-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                              <span className="project-card-action" aria-hidden="true">
                                {openingProjectId === project.id ? "正在打开…" : <LinearIcon name="chevronRight" />}
                              </span>
                            </button>
                            <label className="project-card-directory">
                              <LinearIcon name="folder" />
                              <input
                                key={deviceWorkspacePaths[project.id] ?? ""}
                                type="text"
                                defaultValue={deviceWorkspacePaths[project.id] ?? ""}
                                placeholder="设置此设备的项目目录"
                                aria-label={`${project.name} 在此设备上的项目目录`}
                                onBlur={(event) => rememberDeviceWorkspacePath(project.id, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                              />
                            </label>
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
          <div className="board-scroll" aria-label="Issue board">
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && !showEmptyColumns && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
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

      {detailTask && selectedProject && (
        <div
          className="issue-detail-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeTaskDetail();
          }}
        >
          <section
            className="issue-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="issue-detail-dialog-title"
          >
            <header className="issue-detail-dialog-header">
              <div>
                <strong id="issue-detail-dialog-title">{detailTask.identifier}</strong>
                <span>议题详情</span>
              </div>
              <button
                className="icon-button issue-detail-dialog-close"
                type="button"
                aria-label="关闭详情并返回看板"
                title="关闭详情并返回看板 (Esc)"
                onClick={closeTaskDetail}
                autoFocus
              >
                <LinearIcon name="close" />
              </button>
            </header>
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
              onUpdate={(current, changes) => updateTaskProperties(current, changes)}
              onOpenTask={openTaskDetail}
              onAddRelation={(current, type, relatedTaskId) => (
                mutateTaskRelation("add", current, type, relatedTaskId)
              )}
              onRemoveRelation={(current, type, relatedTaskId) => (
                mutateTaskRelation("remove", current, type, relatedTaskId)
              )}
              onOpenThread={openThread}
              onOpenInThread={openTaskInThread}
              openingThread={openingThreadTaskId === detailTask.id}
              onError={setActionError}
              onAnnounce={setAnnouncement}
            />
          </section>
        </div>
      )}

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
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        projectId={selectedProjectId || null}
        issueId={detailTaskId}
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
