import { useState, type FormEvent } from "react";
import {
  archiveTaskdockProject, createProject, createTaskdockAgent, deleteProject, deleteTaskdockAgent,
  issueTaskdockKey, restoreTaskdockProject, revokeTaskdockKey, updateTaskdockAgent,
  type TaskdockAgent,
} from "./api";
import type { Project } from "./types";
import { PlusIcon, ProjectIcon } from "./components/SemanticIcons";

import { TaskdockDialog } from "./components/TaskdockDialog";
import "./TaskdockSettings.css";

interface Props {
  projects: Project[];
  agents: TaskdockAgent[];
  reload: () => Promise<void>;
}

export function TaskdockSettings({ projects, agents, reload }: Props) {
  const [category, setCategory] = useState<"projects" | "agents" | "connection">("projects");
  const [form, setForm] = useState<"project" | "agent" | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ agent: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installCopied, setInstallCopied] = useState(false);
  const [promptMode, setPromptMode] = useState<"install" | "update">("install");
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const serverUrl = window.location.origin;
  const installPrompt = `请安装 TaskDock 协作 Skill，并在我指定的项目任务中使用它。\n\nSkill 文件：${serverUrl}/skills/taskdock-collaboration/SKILL.md\nTaskDock API 地址：${serverUrl}\n远程 MCP 地址：${serverUrl}/mcp\n\n请下载 SKILL.md，按你当前 Agent 客户端的 Skill 安装方式保存为 taskdock-collaboration/SKILL.md 并启用。如果客户端不支持安装 Skill，请先阅读该文件并遵循其中的协作流程。\n\n每个独立执行者使用独立 Agent 身份和 Key，不与其他并行执行者共用身份。显示名称可修改，内部 ID 由系统生成并保持稳定。\n\nAPI Key 由我自行在你的凭据或环境配置中设置，不会放在这段文字里。使用 REST 或 MCP 时以 Authorization: Bearer <API Key> 认证。不要把 Key 写入聊天、Skill 文件、任务、评论或日志。配置完成后，先只读调用 GET /api/projects 验证连接，再等待我指定任务。`;

  const updatePrompt = `请更新你已安装的 TaskDock 协作 Skill，并在后续 TaskDock 工作中使用最新版。\n\nSkill 文件：${serverUrl}/skills/taskdock-collaboration/SKILL.md\nTaskDock API 地址：${serverUrl}\n远程 MCP 地址：${serverUrl}/mcp\n\n请从以上地址重新下载最新版 SKILL.md，找到当前客户端已安装的 taskdock-collaboration/SKILL.md 并覆盖旧版，然后重新读取、核对安装内容与服务器一致，并遵循其中的协作流程。如果客户端不支持安装 Skill，请直接阅读最新版并遵循其中流程。\n\n保留现有服务器地址、Agent 身份和 API Key 配置，不要重新创建身份或重置 Key，也不要输出 Key。使用远程 MCP 时请刷新工具列表；若客户端没有刷新入口，请重新连接 TaskDock MCP。\n\n更新后请报告 Skill 的安装位置、内容核对和 MCP 刷新结果，再等待我指定任务。`;
  const activePrompt = promptMode === "install" ? installPrompt : updatePrompt;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function startEdit(agent: TaskdockAgent) {
    setForm("agent");
    setEditing(agent.id);
    setAgentName(agent.name);
    setIssuedKey(null);
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      await createProject({ id: projectId.trim(), name: projectName.trim(), workspacePath: null });
      setForm(null); setProjectId(""); setProjectName(""); setNotice("项目已创建");
    });
  }

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const input = { name: agentName.trim() };
      if (editing) await updateTaskdockAgent({ ...input, id: editing });
      else {
        const result = await createTaskdockAgent(input);
        setIssuedKey({ agent: result.agent.name, key: result.key });
      }
      setForm(null); setEditing(null); setAgentName("");
      setNotice(editing ? "Agent 已更新" : "Agent 与 API Key 已创建");
    });
  }

  async function copyInstallPrompt() {
    try { await navigator.clipboard.writeText(activePrompt); setInstallCopied(true); }
    catch { setError("复制失败，请手动选择下面的文字复制"); }
  }

  function closeForm() { setForm(null); setEditing(null); setAgentName(""); setError(""); }

  const shownProjects = projects.filter((project) => project.id !== "local" || project.issueCount > 0);
  return <div className="taskdock-settings settings-layout"><div className="settings-page">
    <nav className="settings-navigation" aria-label="设置分类">
      {([ ["projects", "项目"], ["agents", "Agent 身份"], ["connection", "接入说明"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>{label}{value !== "connection" && <span>{value === "projects" ? shownProjects.length : agents.length}</span>}</button>)}
    </nav>
    {error && !form && <div className="agentboard-error" role="alert">{error}</div>}
    {notice && <div className="taskdock-notice" role="status">{notice}</div>}
    <section className="settings-section" aria-label={category === "projects" ? "项目管理" : category === "agents" ? "Agent 身份管理" : "Agent 接入说明"}>
      <header className="settings-section-heading">
        <div><h2>{category === "projects" ? "项目" : category === "agents" ? "Agent 身份" : "Agent 接入说明"}</h2><p>{category === "projects" ? "管理工作区中的项目，查看任务数量与归档状态。" : category === "agents" ? "每个独立执行者使用自己的身份和 API Key。" : "将 TaskDock 协作 Skill 接入你的 Agent 客户端。"}</p></div>
        {category !== "connection" && <button type="button" className="settings-primary" disabled={busy} onClick={() => { setError(""); setEditing(null); setAgentName(""); setForm(category === "projects" ? "project" : "agent"); }}><PlusIcon size={16} />{category === "projects" ? "新建项目" : "新建 Agent"}</button>}
      </header>
      {category === "projects" && <table className="settings-table settings-project-table"><thead><tr><th>项目名称</th><th>状态</th><th>任务数</th><th>操作</th></tr></thead><tbody>
        {shownProjects.map((project) => <tr key={project.id} className={project.archivedAt ? "is-archived" : ""}>
          <td><div className="settings-identity"><span className="settings-symbol" aria-hidden="true"><ProjectIcon size={18} /></span><div><strong>{project.id === "local" ? "未分类任务" : project.name}</strong><small>{project.id}</small></div></div></td>
          <td><span className={project.archivedAt ? "settings-status archived" : "settings-status"}>{project.archivedAt ? "已归档" : "活跃"}</span></td>
          <td className="settings-task-count">{project.issueCount}</td><td><div className="taskdock-item-actions">{project.id !== "local" && <><button type="button" disabled={busy} onClick={() => void run(async () => { if (project.archivedAt) await restoreTaskdockProject(project.id); else await archiveTaskdockProject(project.id); setNotice(project.archivedAt ? "项目已恢复" : "项目已归档"); })}>{project.archivedAt ? "恢复" : "归档"}</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除空项目「${project.name}」？此操作无法撤销。`)) void run(async () => { await deleteProject(project.id); setNotice("项目已删除"); }); }}>删除</button></>}</div></td>
        </tr>)}
      </tbody></table>}
      {category === "agents" && <>
        {issuedKey && <div className="taskdock-issued-key" role="status"><strong>{issuedKey.agent} 的新 API Key</strong><p>请现在复制保存；离开此页后无法再次查看。</p><code>{issuedKey.key}</code><button type="button" onClick={() => void navigator.clipboard.writeText(issuedKey.key)}>复制 Key</button></div>}
        <table className="settings-table settings-agent-table"><thead><tr><th>Agent</th><th>API Key</th><th>操作</th></tr></thead><tbody>{agents.map((agent) => <tr key={agent.id}>
          <td><div className="settings-identity"><span className="settings-symbol" aria-hidden="true">{Array.from(agent.name)[0]?.toLocaleUpperCase()}</span><div><strong>{agent.name}</strong><small>{agent.id}</small><small>所有项目</small></div></div></td>
          <td><div className="settings-keys">{agent.keys.filter((key) => !key.revokedAt).map((key) => <div className="taskdock-key-row" key={key.id}><span><span className="taskdock-key-dot" aria-hidden="true" />当前 Key · {new Date(key.createdAt).toLocaleDateString()}</span><button type="button" disabled={busy} onClick={() => { if (window.confirm(`撤销 ${agent.name} 的 API Key？`)) void run(async () => { await revokeTaskdockKey(agent.id, key.id); setNotice("Key 已撤销"); }); }}>撤销</button></div>)}</div>{!agent.keys.some((key) => !key.revokedAt) && <span className="settings-muted">无有效 Key</span>}</td>
          <td><div className="taskdock-item-actions"><button type="button" onClick={() => startEdit(agent)}>编辑</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`重置 ${agent.name} 的 API Key？原 Key 会立即失效。`)) void run(async () => { const result = await issueTaskdockKey(agent.id); setIssuedKey({ agent: agent.name, key: result.key }); }); }}>重置 Key</button><button type="button" className="taskdock-danger" disabled={busy} onClick={() => { if (window.confirm(`删除 Agent「${agent.name}」及其 API Key？它认领的任务将回到待办，历史记录保留。`)) void run(async () => { await deleteTaskdockAgent(agent.id); if (editing === agent.id) { setEditing(null); setAgentName(""); } setIssuedKey(null); setNotice("Agent 和 API Key 已删除"); }); }}>删除</button></div></td>
        </tr>)}</tbody></table>
      </>}
      {category === "connection" && <div className="settings-connection"><div className="taskdock-onboarding-content"><div className="taskdock-prompt-options" role="group" aria-label="Skill 提示词用途">{(["install", "update"] as const).map((mode) => <button key={mode} type="button" aria-pressed={promptMode === mode} onClick={() => { setPromptMode(mode); setInstallCopied(false); }}>{mode === "install" ? "安装 Skill" : "更新 Skill"}</button>)}</div><div className="taskdock-onboarding-head"><p>{promptMode === "install" ? "复制这段文字发给 Agent，让它安装 Skill。API Key 由你在 Agent 环境中设置。" : "发给已安装 Skill 的 Agent，让它更新到服务器最新版，并保留现有身份和 Key 配置。"}</p><button type="button" onClick={() => void copyInstallPrompt()}>{installCopied ? "已复制" : promptMode === "install" ? "复制给 Agent" : "复制更新提示词"}</button></div><textarea aria-label={promptMode === "install" ? "发给 Agent 的 Skill 安装说明" : "发给 Agent 的 Skill 更新说明"} readOnly value={activePrompt} rows={10} /><a href={`${serverUrl}/skills/taskdock-collaboration/SKILL.md`} target="_blank" rel="noopener noreferrer">查看 Skill 文件 ↗</a></div></div>}
    </section>
    {form && <TaskdockDialog className="agentboard-editor-backdrop settings-dialog-backdrop" labelledBy="settings-form-title" onClose={() => { if (!busy) closeForm(); }}><section className="agentboard-editor settings-dialog">
      <header><h2 id="settings-form-title">{form === "project" ? "新建项目" : editing ? "编辑 Agent" : "新建 Agent"}</h2><button type="button" aria-label="关闭表单" disabled={busy} onClick={closeForm}>×</button></header>
      <form onSubmit={(event) => void (form === "project" ? submitProject(event) : submitAgent(event))}>
        {form === "project" ? <><label>项目名称<input data-dialog-autofocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：官网改版" required /></label><label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="website" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></label></> : <label>Agent 名称<input data-dialog-autofocus value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="例如：Claude" required /></label>}
        {error && <div className="agentboard-error" role="alert">{error}</div>}
        <footer><button type="button" disabled={busy} onClick={closeForm}>取消</button><button type="submit" disabled={busy}>{busy ? "保存中…" : form === "project" ? "创建项目" : editing ? "保存 Agent" : "创建 Agent 并生成 Key"}</button></footer>
      </form>
    </section></TaskdockDialog>}
  </div></div>;
}
