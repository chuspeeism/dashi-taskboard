import { useEffect, useMemo, useState } from "react";
import { listCodexSessions } from "../api";
import {
  TASK_STATUSES,
  type CodexLiveSession,
  type CodexProject,
  type CodexSession,
  type Project,
  type TaskStatus,
} from "../types";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";

interface SessionProject {
  id: string;
  name: string;
  workspacePath: string;
  threadIds: string[];
}

interface DisplaySession extends CodexSession {
  projectId: string;
  projectName: string;
  unread: boolean;
}

interface CodexSessionBoardProps {
  liveSessions: CodexLiveSession[];
  projects: Project[];
  codexProjects: CodexProject[];
  deviceWorkspacePaths: Record<string, string>;
  onOpenThread: (threadId: string) => void;
  onOpenProject: (projectId: string) => void;
}

function isInsideWorkspace(cwd: string, workspacePath: string) {
  const path = workspacePath.replace(/\/+$/, "");
  return cwd === path || cwd.startsWith(`${path}/`);
}

function projectForSession(session: CodexSession, projects: SessionProject[]) {
  const explicit = projects.find((project) => project.threadIds.includes(session.id));
  if (explicit) return explicit;
  const mapped = projects
    .filter((project) => project.workspacePath && isInsideWorkspace(session.cwd, project.workspacePath))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length)[0];
  if (mapped) return mapped;
  const folder = session.cwd.replace(/\/+$/, "").split("/").filter(Boolean).pop()?.toLowerCase();
  return folder ? projects.find((project) => project.name.toLowerCase() === folder) : undefined;
}

function formatUpdatedAt(timestamp: number) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export function CodexSessionBoard({
  liveSessions,
  projects,
  codexProjects,
  deviceWorkspacePaths,
  onOpenThread,
  onOpenProject,
}: CodexSessionBoardProps) {
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        setSessions(await listCodexSessions(controller.signal));
        setError("");
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const sessionProjects = useMemo<SessionProject[]>(() => {
    const persisted = new Map(projects.map((project) => [project.id, project]));
    return codexProjects.map((project) => ({
      ...project,
      name: persisted.get(project.id)?.name ?? project.name,
      workspacePath: project.workspacePath
        ?? deviceWorkspacePaths[project.id]
        ?? persisted.get(project.id)?.workspacePath
        ?? "",
      threadIds: project.threadIds ?? [],
    }));
  }, [codexProjects, deviceWorkspacePaths, projects]);

  const displaySessions = useMemo<DisplaySession[]>(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const live of liveSessions) {
      const stored = byId.get(live.id);
      byId.set(live.id, {
        id: live.id,
        title: live.title || stored?.title || "未命名会话",
        cwd: stored?.cwd || live.cwd || "",
        status: live.status,
        nativeStatus: live.nativeStatus,
        activeFlags: stored?.activeFlags ?? [],
        pinned: live.pinned || stored?.pinned === true,
        createdAt: stored?.createdAt ?? 0,
        updatedAt: stored?.updatedAt ?? 0,
      });
    }
    return [...byId.values()].map((session) => {
      const live = liveSessions.find((candidate) => candidate.id === session.id);
      const project = sessionProjects.find((candidate) => candidate.id === live?.projectId)
        ?? projectForSession(session, sessionProjects);
      return {
        ...session,
        projectId: project?.id ?? "",
        projectName: project?.name ?? "未归类",
        unread: live?.unread === true,
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt);
  }, [liveSessions, sessionProjects, sessions]);

  const projectOptions = sessionProjects.map((project) => ({ id: project.id, name: project.name }));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSessions = displaySessions.filter((session) => (
    (!projectFilter || session.projectId === projectFilter)
    && (!normalizedSearch || `${session.title} ${session.projectName}`.toLowerCase().includes(normalizedSearch))
  ));
  const sessionsByStatus = Object.fromEntries(TASK_STATUSES.map((status) => [
    status,
    filteredSessions.filter((session) => session.status === status),
  ])) as Record<TaskStatus, DisplaySession[]>;
  const visibleStatuses = TASK_STATUSES.filter((status) => sessionsByStatus[status].length > 0);

  return (
    <>
      <div className="board-toolbar session-board-toolbar">
        <div className="session-board-summary">
          <strong>会话看板</strong>
          <span>{displaySessions.length} 个 Codex 会话 · 按实时状态自动归类</span>
        </div>
        <div className="toolbar-tools">
          <label className="session-project-filter">
            <span className="sr-only">按项目筛选</span>
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="">全部项目</option>
              {projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className={`search-field${search ? " has-value" : ""}`}>
            <LinearIcon className="search-icon" name="search" />
            <span className="sr-only">搜索会话</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话…" />
          </label>
        </div>
      </div>
      {error && <div className="session-board-notice" role="alert">{error}</div>}
      {loading && displaySessions.length === 0 ? (
        <div className="workflow-board-loading">正在读取 Codex 会话…</div>
      ) : (
        <div className="board-scroll session-board-scroll" aria-label="Codex 会话看板">
          <div className="board session-board">
            {visibleStatuses.map((status) => {
              const details = STATUS_DETAILS[status];
              return (
                <section className={`board-column status-${status}`} key={status}>
                  <header className="column-header">
                    <div className="column-heading">
                      <span className={`status-icon status-icon-${details.tone}`}><StatusIcon status={status} /></span>
                      <h2>{details.label}</h2>
                      <span className="task-count">{sessionsByStatus[status].length}</span>
                    </div>
                  </header>
                  <div className="column-list">
                    {sessionsByStatus[status].map((session) => (
                      <article className="task-card session-card" key={session.id}>
                        <button className="session-card-open" type="button" onClick={() => onOpenThread(session.id)}>
                          <span className="session-card-id">{session.id.slice(0, 8)}</span>
                          <strong>{session.title}</strong>
                        </button>
                        <span className="session-card-meta">
                          {session.projectId ? (
                            <button className="session-project-link" type="button" onClick={() => onOpenProject(session.projectId)}>{session.projectName}</button>
                          ) : <span>{session.projectName}</span>}
                          <span>{formatUpdatedAt(session.updatedAt)}</span>
                        </span>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
            {visibleStatuses.length === 0 && (
              <section className="page-empty filter-empty board-filter-empty">
                <h2>没有匹配的会话</h2>
                <p>调整项目或搜索条件。</p>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}
