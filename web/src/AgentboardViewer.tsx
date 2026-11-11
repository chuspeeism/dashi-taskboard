import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  getAgentboardSession,
  createTask,
  updateTask,
  releaseTask,
  listAttachments,
  listTaskdockAgents,
  loginTaskdock,
  logoutTaskdock,
  listArtifacts,
  listComments,
  listProjects,
  listTaskActivities,
  listTasks,
  resolveTaskboardUrl,
  type TaskdockAgent,
} from "./api";
import { TASK_PRIORITIES, TASK_STATUSES, type Attachment, type ActorIdentity, type Artifact, type Comment, type Project, type Task, type TaskDraft, type TaskChangeActivity, type TaskStatus } from "./types";
import { TaskboardLanguageProvider, taskPriorityLabel, taskStatusLabel } from "./i18n";
import { MarkdownDocument } from "./components/MarkdownDocument";
import { PlusIcon, PriorityIcon, ProjectIcon, RefreshIcon, StatusIcon } from "./components/SemanticIcons";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { DashboardView } from "./components/DashboardView";
import { ProjectReadmeView } from "./components/ProjectReadmeView";
import { TaskdockSettings } from "./TaskdockSettings";
import { TaskdockPersonalView, TaskdockWork, readyForUser, taskExecutor } from "./TaskdockWork";
import { useTaskdockNavigation, type DetailSection, type TaskdockView } from "./taskdockNavigation";
import { TaskdockDialog } from "./components/TaskdockDialog";
import type { TaskCardPresentation } from "./taskConversations";
import "./AgentboardViewer.css";

type Detail = { comments: Comment[]; activities: TaskChangeActivity[]; artifacts: Artifact[]; attachments: Attachment[] };

function TaskdockTaskForm({ task, projects, projectId, onSave, onCancel }: {
  task: Task | null;
  projects: Project[];
  projectId: string | null;
  onSave: (projectId: string, draft: TaskDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [targetProject, setTargetProject] = useState(task?.projectId ?? projectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [priority, setPriority] = useState<TaskDraft["priority"]>(task?.priority ?? "none");
  const [labels, setLabels] = useState(task?.labels.join(", ") ?? "");
  const [executor, setExecutor] = useState<"user" | "agent">(task ? taskExecutor(task) : "agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError("请输入任务标题"); return; }
    setBusy(true);
    setError("");
    try {
      await onSave(targetProject, {
        title: title.trim(), description, status, priority, executor,
        labels: [...new Set(labels.split(/[,，]/).map((label) => label.trim()).filter(Boolean))],
        developmentContext: task?.developmentContext ?? null,
        startDate: task?.startDate ?? null, dueDate: task?.dueDate ?? null,
        recurrence: task?.recurrence ?? null,
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }

  return <TaskdockDialog className="agentboard-editor-backdrop" labelledBy="taskdock-editor-title" onClose={() => { if (!busy) onCancel(); }}><section className="agentboard-editor">
    <header><h2 id="taskdock-editor-title">{task ? "编辑任务" : "新建任务"}</h2><button type="button" aria-label="关闭编辑" onClick={onCancel} disabled={busy}>×</button></header>
    <form onSubmit={(event) => void submit(event)}>
      {!task && <label>项目<select value={targetProject} onChange={(event) => setTargetProject(event.target.value)} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
      <label>标题<input data-dialog-autofocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label>描述与验收标准<textarea rows={10} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="支持 Markdown、表格、代码和 Mermaid" /></label>
      <div className="taskdock-form-row"><label>状态<select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{TASK_STATUSES.map((value) => <option key={value} value={value}>{taskStatusLabel("zh", value)}</option>)}</select></label><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskDraft["priority"])}>{TASK_PRIORITIES.map((value) => <option key={value} value={value}>{taskPriorityLabel("zh", value)}</option>)}</select></label></div>
      <label>标签<input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="多个标签用逗号分隔" /></label>
      <label>执行者<select value={executor} onChange={(event) => setExecutor(event.target.value as "user" | "agent")}><option value="user">我做</option><option value="agent">Agent 做</option></select></label>
      {error && <p className="agentboard-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" disabled={busy || !targetProject}>{busy ? "保存中…" : "保存任务"}</button></footer>
    </form>
  </section></TaskdockDialog>;
}

const statusOrder = TASK_STATUSES;

function TaskdockAttachments({ attachments, emptyText }: { attachments: Attachment[]; emptyText?: string }) {
  if (!attachments.length) return emptyText ? <p>{emptyText}</p> : null;
  return <ul className="agentboard-attachments">{attachments.map((attachment) => <li key={attachment.id}>
    <span>{attachment.filename}<small>{Math.ceil(attachment.size / 1024)} KB</small></span>
    <a href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(attachment.id)}/content`)} target="_blank" rel="noopener noreferrer">查看</a>
    <a href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(attachment.id)}/download`)} download={attachment.filename}>下载</a>
  </li>)}</ul>;
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function activitySummary(activity: TaskChangeActivity): string {
  return activity.changes.map((change) => {
    if (change.field === "claim") return change.after ? "认领任务" : "释放任务";
    if (change.field === "artifact") return "提交任务产出";
    if (change.field === "attachment") return `添加素材：${(change.after as { filename: string }).filename}`;
    if (change.field === "assignee") return `执行者改为 ${(change.after as ActorIdentity).type === "user" ? "我" : "Agent"}`;
    if (change.field === "checklist") {
      const before = change.before as import("./types").ChecklistItem | null;
      const after = change.after as import("./types").ChecklistItem | null;
      if (!after) return `删除清单项：${before?.title}`;
      const result = after.status === "done" ? "已完成" : after.status === "issue" ? "有问题" : "未完成";
      return `${before ? "更新" : "添加"}清单项：${after.title}（${after.executor === "user" ? "我做" : "Agent 做"} · ${result} · ${after.ready ? "已就绪" : "尚未就绪"}）${after.note ? `\n\n${after.note}` : ""}`;
    }
    if (change.field === "status") return `状态变更为 ${taskStatusLabel("zh", String(change.after) as TaskStatus)}`;
    return `更新 ${change.field}`;
  }).join("、");
}

export function AgentboardViewer({ pollIntervalMs = 3000 }: { pollIntervalMs?: number }) {
  const [session, setSession] = useState<"loading" | "guest" | "authenticated">("loading");
  const [loginKey, setLoginKey] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<TaskdockAgent[]>([]);
  const { projectId, view, taskId, section: detailSection, status: statusFilter, navigate } = useTaskdockNavigation();
  const [hideEmpty, setHideEmpty] = useState(false);
  const setView = (next: TaskdockView) => navigate({ view: next, status: null, taskId: null });
  const selectProject = (next: string | null) => navigate({ projectId: next, view: "dashboard", status: null, taskId: null });
  const setSelectedTask = (task: Task | null, section?: DetailSection) => navigate({ taskId: task?.id ?? null, section: section ?? (task?.status === "in_review" ? "artifacts" : "description") });
  const [tasks, setTasks] = useState<Task[]>([]);
  const selectedTask = tasks.find((task) => task.id === taskId) ?? null;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editor, setEditor] = useState<{ task: Task | null } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [search, setSearch] = useState("");
  const [readmeRevision, setReadmeRevision] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(() => new Set(statusFilter ? [] : ["backlog", "done", "canceled"]));

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    return () => { delete document.documentElement.dataset.theme; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void getAgentboardSession(controller.signal).then(
      (result) => setSession(result.authenticated ? "authenticated" : "guest"),
      () => setSession("guest"),
    );
    return () => controller.abort();
  }, []);

  const reload = useCallback(async () => {
    const [nextProjects, nextTasks, nextAgents] = await Promise.all([listProjects(), listTasks(), listTaskdockAgents()]);
    setProjects(nextProjects);
    setTasks(nextTasks);
    setAgents(nextAgents);
    setReadmeRevision((current) => current + 1);
    setLoadError("");
  }, [session]);

  useEffect(() => {
    if (session !== "authenticated") return;
    let stopped = false;
    let timer: number;
    async function refresh() {
      try { await reload(); }
      catch (error) { if (!stopped) setLoadError(error instanceof Error ? error.message : "无法读取看板"); }
      if (!stopped) timer = window.setTimeout(() => void refresh(), pollIntervalMs);
    }
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session, reload, pollIntervalMs]);

  useEffect(() => { setReleaseError(""); }, [taskId]);

  useEffect(() => {
    if (!selectedTask) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    void Promise.all([
      listComments(selectedTask.id, controller.signal),
      listTaskActivities(selectedTask.id, controller.signal),
      listArtifacts(selectedTask.id, controller.signal),
      listAttachments(selectedTask.id, controller.signal),
    ]).then(
      ([comments, activities, artifacts, attachments]) => setDetail({ comments, activities, artifacts, attachments }),
      (error: unknown) => {
        if ((error as Error).name !== "AbortError") setLoadError(error instanceof Error ? error.message : "无法读取任务详情");
      },
    );
    return () => controller.abort();
  }, [selectedTask?.id, selectedTask?.activityKey]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await loginTaskdock(loginKey);
      setLoginKey("");
      setSession("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await logoutTaskdock();
    setSession("guest");
    navigate({ projectId: null, view: "dashboard", taskId: null, status: null });
    setEditor(null);
  }

  async function saveTask(targetProject: string, draft: TaskDraft) {
    const saved = editor?.task ? await updateTask(editor.task, draft) : await createTask(targetProject, draft);
    await reload();
    navigate({ projectId: saved.projectId, taskId: saved.id, section: "description" });
    setEditor(null);
  }

  function taskChanged(saved: Task) {
    setTasks((current) => current.map((task) => task.id === saved.id ? saved : task));
  }

  async function releaseClaim(task: Task) {
    if (releaseBusy) return;
    setReleaseBusy(true);
    setReleaseError("");
    try {
      const saved = await releaseTask(task);
      taskChanged(saved);
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : "释放认领失败");
    } finally {
      setReleaseBusy(false);
    }
  }

  if (session === "loading") return <div className="agentboard-login">正在连接 TaskDock…</div>;
  if (session === "guest") {
    return <main className="agentboard-login"><form onSubmit={(event) => void submitLogin(event)}>
      <div className="agentboard-brand"><TaskboardIcon name="panel" width={22} height={22} />TaskDock</div>
      <span className="agentboard-eyebrow">YOUR SHARED WORKSPACE</span>
      <h1>登录工作区</h1>
      <p>把任务交给 Agent，让进展清晰可见。<br />项目、协作与成果，都在同一个工作区。</p>
      <label htmlFor="taskdock-login-key">登录 Key</label>
      <input id="taskdock-login-key" type="password" autoComplete="current-password" value={loginKey} onChange={(event) => setLoginKey(event.target.value)} required />
      {loginError && <p role="alert" className="agentboard-error">{loginError}</p>}
      <button type="submit" disabled={loginBusy}>{loginBusy ? "登录中…" : "登录"}</button>
    </form></main>;
  }

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const navProjects = activeProjects.filter((project) => project.id !== "local" || project.issueCount > 0);
  const scopedTasks = tasks.filter((task) => activeProjects.some((project) => project.id === task.projectId) && (!projectId || task.projectId === projectId));
  const visibleTasks = scopedTasks.filter((task) => {
    if (projectId && task.projectId !== projectId) return false;
    if (statusFilter === "overdue") {
      if (!task.dueDate || ["done", "canceled"].includes(task.status) || task.dueDate.slice(0, 10) >= new Date().toLocaleDateString("en-CA")) return false;
    } else if (statusFilter && task.status !== statusFilter) return false;
    const needle = search.trim().toLocaleLowerCase();
    return !needle || `${task.identifier} ${task.title} ${task.description}`.toLocaleLowerCase().includes(needle);
  });
  const boardStatuses = statusFilter && statusFilter !== "overdue" ? [statusFilter]
    : statusFilter === "overdue" ? statusOrder.filter((status) => visibleTasks.some((task) => task.status === status))
    : statusOrder;
  const shownBoardStatuses = boardStatuses.filter((status) => !hideEmpty || visibleTasks.some((task) => task.status === status));
  const timeline = detail ? [
    ...detail.comments.map((comment) => ({ id: comment.id, at: comment.createdAt, actor: comment.authorName, label: "评论", body: comment.body, attachments: comment.attachments })),
    ...detail.activities.map((activity) => ({ id: activity.id, at: activity.createdAt, actor: activity.actorName, label: "操作", body: activitySummary(activity), attachments: [] as Attachment[] })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];

  const projectName = projectId ? activeProjects.find((project) => project.id === projectId)?.name ?? "项目" : "全局";
  const presentations: Record<string, TaskCardPresentation> = Object.fromEntries(scopedTasks.map((task) => [task.id, { conversations: [], processing: { running: task.status === "in_progress" && Boolean(task.claimedBy), completed: null, total: null, startedAt: null }, unread: false }]));
  const currentUser: ActorIdentity = { type: "user", id: "user", name: "你", avatarUrl: null };
  const dashboardSummary = `当前项目共有 ${scopedTasks.length} 个任务，${scopedTasks.filter((task) => task.status === "done").length} 个已完成，${scopedTasks.filter((task) => task.status === "in_progress").length} 个处理中，${scopedTasks.filter((task) => task.status === "blocked").length} 个阻塞。`;
  const taskCard = (task: Task) => <article key={task.id} className={`task-card status-${task.status} agentboard-readonly-card${selectedTask?.id === task.id ? " selected" : ""}`}>
    <button className="task-card-open" type="button" aria-label={`打开 ${task.identifier}: ${task.title}`} onClick={() => setSelectedTask(task)} />
    <div className="card-topline"><span className="card-reference"><span className="task-identifier">{task.identifier}</span></span>{task.priority !== "none" && <span className={`agentboard-priority priority-${task.priority}`}><PriorityIcon priority={task.priority} size={13} />{taskPriorityLabel("zh", task.priority)}</span>}</div>
    <h3>{task.title}</h3>
    {task.description && <p className="task-card-description">{task.description.replace(/[#*`>]/g, "").replace(/\n+/g, " ")}</p>}
    {task.labels.length > 0 && <div className="agentboard-card-labels">{task.labels.slice(0, 2).map((label) => <span key={label}>{label}</span>)}{task.labels.length > 2 && <span>+{task.labels.length - 2}</span>}</div>}
    <div className="agentboard-card-footer"><span className={task.claimedBy ? "agentboard-assigned" : ""}>{taskExecutor(task) === "user" ? "我做" : task.claimedBy?.name ?? "Agent 做 · 未认领"}{(task.checklist?.length ?? 0) > 0 && ` · ${task.checklist!.filter((item) => item.status === "done").length}/${task.checklist!.length}`}</span><time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</time></div>
  </article>;

  return <TaskboardLanguageProvider language="zh"><div className="app-shell agentboard-app">
    <aside className="agentboard-sidebar"><div className="agentboard-sidebar-brand"><span className="agentboard-brand-mark"><TaskboardIcon name="panel" width={19} height={19} /></span><div><strong>TaskDock</strong><span className="agentboard-brand-caption">人与 Agent 的协作空间</span></div></div><nav aria-label="项目导航">
      <button className={`agentboard-sidebar-item${!projectId && view !== "settings" ? " active" : ""}`} type="button" onClick={() => selectProject(null)}><TaskboardIcon name="home" width={18} height={18} /><span>全局概览</span><small>{tasks.length}</small></button>
      <div className="agentboard-sidebar-label">项目</div>
      {navProjects.map((project) => <button className={`agentboard-sidebar-item${projectId === project.id && view !== "settings" ? " active" : ""}`} type="button" key={project.id} onClick={() => selectProject(project.id)}><ProjectIcon size={17} /><span title={project.name}>{project.id === "local" ? "未分类任务" : project.name}</span><small>{project.issueCount}</small></button>)}
      {navProjects.length === 0 && <p className="agentboard-sidebar-empty">暂无项目，可在设置中创建。</p>}
    </nav><div className="agentboard-sidebar-footer"><span>协作工作区</span><strong>{activeProjects.length} 个项目 · {agents.length} 个 Agent</strong><p>每一次交接，都有迹可循。</p></div></aside><main className="workspace">
    <header className="workspace-header agentboard-workspace-header"><div className="agentboard-page-heading"><h1>{view === "settings" ? "管理设置" : projectId === "local" ? "未分类任务" : projectName}</h1>{view !== "settings" && <p>{projectId ? "查看该项目的任务和 Agent 进展" : "查看所有项目的任务和 Agent 进展"}</p>}</div><div className="workspace-drag-region" aria-hidden="true" /><button className={`taskdock-header-action${view === "settings" ? " active" : ""}`} type="button" onClick={() => setView("settings")}>设置</button><button className="taskdock-header-action" type="button" onClick={() => void logout()}>退出</button></header>
    {view !== "settings" && <div className="board-toolbar"><div className="view-tabs" aria-label="看板视图">
      <button className={`view-tab${view === "dashboard" ? " active" : ""}`} type="button" onClick={() => setView("dashboard")}>仪表盘</button>
      <button className={`view-tab${view === "board" ? " active" : ""}`} type="button" onClick={() => setView("board")}>任务看板</button>
      <button className={`view-tab${view === "list" ? " active" : ""}`} type="button" onClick={() => setView("list")}>列表视图</button>
      <button className={`view-tab${view === "personal" ? " active" : ""}`} type="button" onClick={() => setView("personal")}>等我处理 <span>{scopedTasks.filter(readyForUser).length}</span></button>
      {projectId && projectId !== "local" && <button className={`view-tab${view === "readme" ? " active" : ""}`} type="button" onClick={() => setView("readme")}>项目文档</button>}
    </div><div className="toolbar-tools">{(view === "board" || view === "list") && <div className={`search-field${search ? " has-value" : ""}`}><TaskboardIcon name="search" width={16} height={16} /><input type="search" aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>}{(view === "board" || view === "list") && <label className="taskdock-status-filter"><span className="sr-only">按任务状态筛选</span><select aria-label="按任务状态筛选" value={statusFilter ?? ""} onChange={(event) => { setCollapsed(new Set()); navigate({ status: (event.target.value || null) as typeof statusFilter }); }}><option value="">全部状态</option>{statusOrder.map((status) => <option key={status} value={status}>{taskStatusLabel("zh", status)}</option>)}<option value="overdue">已逾期</option></select></label>}<button className="agentboard-create-task" type="button" disabled={activeProjects.length === 0} onClick={() => setEditor({ task: null })}><PlusIcon size={15} />新建任务</button><button className="agentboard-refresh" type="button" onClick={() => void reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "刷新失败"))} aria-label="刷新"><RefreshIcon size={16} /></button></div></div>}
    {loadError && <div role="alert" className="agentboard-error">{loadError}</div>}
    {view === "personal" && <TaskdockPersonalView tasks={scopedTasks} onChanged={taskChanged} onOpen={setSelectedTask} />}
    {view === "dashboard" && <DashboardView projectId={projectId ?? "all"} projectCreatedAt={projectId ? projects.find((project) => project.id === projectId)?.createdAt ?? null : null} isAllProjects={!projectId} tasks={scopedTasks} presentations={presentations} currentUser={currentUser} animateSummary={false} onSummaryAnimationStart={() => undefined} onOpenTask={setSelectedTask} onOpenConversation={() => undefined} summaryOverride={dashboardSummary} onNavigateTasks={(status) => { setSearch(""); setCollapsed(new Set()); navigate({ view: "list", status, taskId: null }); }} taskdockMode />}
    {view === "readme" && projectId && projects.find((project) => project.id === projectId) && <ProjectReadmeView
      key={projectId}
      project={projects.find((project) => project.id === projectId)!}
      tasks={scopedTasks}
      referenceTasks={scopedTasks}
      revision={readmeRevision}
      onOpenTask={(reference) => setSelectedTask(tasks.find((task) => task.id === reference.id) ?? null)}
      onError={(error) => setLoadError(typeof error === "string" ? error : error?.[0] ?? "")}
    />}
    {view === "settings" && <TaskdockSettings projects={projects} agents={agents} reload={reload} />}
    {view === "board" ? <div className="issue-board-layout agentboard-board-layout">
      <div className="taskdock-board-options"><span>所有状态的任务均直接展示</span><label><input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />隐藏空列</label></div>
      <div className="board-scroll"><div className="board" style={{ "--taskdock-columns": Math.max(1, shownBoardStatuses.length) } as CSSProperties}>
        {shownBoardStatuses.map((status) => {
          const columnTasks = visibleTasks.filter((task) => task.status === status);
          return <section key={status} className={`board-column status-${status}`}><header className="column-header"><div className="column-heading"><span className="column-status-icon"><StatusIcon status={status} size={16} /></span><h2>{taskStatusLabel("zh", status)}</h2><span className="agentboard-column-count">{columnTasks.length}</span></div></header><div className="column-list">{columnTasks.map(taskCard)}{columnTasks.length === 0 && <div className="column-empty"><strong>暂无任务</strong><span>进入此状态的任务会显示在这里</span></div>}</div></section>;
        })}
        {shownBoardStatuses.length === 0 && <p className="taskdock-view-empty">没有符合条件的任务，可切换状态或取消隐藏空列。</p>}
      </div></div>
    </div> : view === "list" ? <div className="issue-list-view agentboard-list"><div className="issue-list-groups">
      {statusOrder.filter((status) => !statusFilter || statusFilter === "overdue" || status === statusFilter).map((status) => {
        const groupTasks = visibleTasks.filter((task) => task.status === status);
        const isCollapsed = collapsed.has(status);
        if (statusFilter === "overdue" && groupTasks.length === 0) return null;
        return <section className={`issue-list-group status-${status}`} key={status}><button className="issue-list-group-header" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(status)) next.delete(status); else next.add(status); return next; })}><span>{isCollapsed ? "›" : "⌄"}</span><span className="issue-list-status-icon"><StatusIcon status={status} size={14} /></span><strong>{taskStatusLabel("zh", status)}</strong><span>{groupTasks.length}</span></button>{!isCollapsed && <div className="issue-list-rows">{groupTasks.map((task) => <button className="issue-list-row agentboard-list-row" type="button" key={task.id} onClick={() => setSelectedTask(task)}><span className="issue-list-title-cell"><small>{task.identifier}</small><strong>{task.title}</strong></span><span className="agentboard-list-agent">{taskExecutor(task) === "user" ? "我做" : task.claimedBy?.name ?? "Agent 未认领"}</span><time dateTime={task.updatedAt}>{date(task.updatedAt)}</time></button>)}{groupTasks.length === 0 && <div className="issue-list-empty">暂无任务</div>}</div>}</section>;
      })}
      {statusFilter === "overdue" && visibleTasks.length === 0 && <p className="taskdock-view-empty">当前没有逾期任务。</p>}
    </div></div> : null}
  </main>
    {selectedTask && <TaskdockDialog className="agentboard-detail-backdrop" labelledBy="taskdock-detail-title" onClose={() => setSelectedTask(null)}><section className="agentboard-detail">
      <div className="agentboard-detail-head"><span>{selectedTask.identifier}</span><button type="button" onClick={() => setSelectedTask(null)} aria-label="关闭详情">×</button></div>
      <div className="agentboard-task-heading"><h2 id="taskdock-detail-title">{selectedTask.title}</h2><button className="agentboard-edit-task" type="button" onClick={() => setEditor({ task: selectedTask })}>编辑任务</button>{selectedTask.claimedBy && <button className="agentboard-edit-task" type="button" onClick={() => void releaseClaim(selectedTask)} disabled={releaseBusy}>{releaseBusy ? "释放中…" : "释放认领"}</button>}</div><div className="agentboard-properties"><span>状态：{taskStatusLabel("zh", selectedTask.status)}</span><span>优先级：{taskPriorityLabel("zh", selectedTask.priority)}</span>{taskExecutor(selectedTask) === "agent" && <span>认领 Agent：{selectedTask.claimedBy?.name ?? "未认领"}</span>}{selectedTask.labels.map((label) => <span key={label}>{label}</span>)}</div>
      {releaseError && <p className="agentboard-error" role="alert">{releaseError}</p>}
      <nav className="taskdock-detail-tabs" aria-label="任务详情分区">{([ ["description", "说明"], ["checklist", "清单"], ["artifacts", `成果${detail ? ` ${detail.artifacts.length}` : ""}`], ["history", "历史"] ] as [DetailSection, string][]).map(([section, title]) => <button type="button" key={section} aria-pressed={detailSection === section} onClick={() => navigate({ section })}>{title}</button>)}</nav>
      {detailSection === "description" && <section><h3>任务说明</h3><MarkdownDocument value={selectedTask.description || "暂无描述"} /></section>}
      {detailSection === "checklist" && <section><div className="taskdock-detail-executor">执行者：{taskExecutor(selectedTask) === "user" ? "我做" : "Agent 做"}</div><TaskdockWork task={selectedTask} onChanged={taskChanged} onViewHistory={() => navigate({ section: "history" })} /></section>}
      {detailSection === "description" && <section><h3>任务附件</h3>{!detail ? <p>加载中…</p> : <TaskdockAttachments attachments={detail.attachments.filter((attachment) => !attachment.commentId)} emptyText="暂无附件" />}</section>}
      {detailSection === "artifacts" && <section><h3>任务成果</h3>{!detail ? <p>加载中…</p> : detail.artifacts.length === 0 ? <p>暂无产出</p> : detail.artifacts.map((artifact) => {
        const href = artifact.attachmentId ? resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(artifact.attachmentId)}/download`) : safeUrl(artifact.url);
        return <article key={artifact.id} className="agentboard-artifact"><div><strong>{artifact.title}</strong><small>{artifact.type} · {artifact.agentName} · {date(artifact.createdAt)}</small></div>{artifact.content && <MarkdownDocument value={artifact.content} />}{href && <a href={href} target="_blank" rel="noopener noreferrer">查看产出 ↗</a>}</article>;
      })}</section>}
      {detailSection === "history" && <section><h3>完整操作历史与评论</h3>{!detail ? <p>加载中…</p> : timeline.length === 0 ? <p>暂无记录</p> : timeline.map((item) => <article className="agentboard-event" key={`${item.label}-${item.id}`}><small>{date(item.at)}</small><div><strong>{item.actor}</strong> · {item.label}</div><MarkdownDocument value={item.body} /><TaskdockAttachments attachments={item.attachments} /></article>)}</section>}
    </section></TaskdockDialog>}
    {editor && <TaskdockTaskForm task={editor.task} projects={activeProjects} projectId={projectId} onSave={saveTask} onCancel={() => setEditor(null)} />}
  </div></TaskboardLanguageProvider>;
}
