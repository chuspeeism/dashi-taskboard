import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Task } from "../types";
import { LinearIcon } from "./LinearIcon";

interface TaskProjectReassignDialogProps {
  task: Task;
  projects: Project[];
  onCancel: () => void;
  onConfirm: (projectId: string) => Promise<void>;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "切换项目未完成，请重试。";
}

export function TaskProjectReassignDialog({
  task,
  projects,
  onCancel,
  onConfirm,
}: TaskProjectReassignDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const targets = useMemo(
    () => projects.filter((project) => project.id !== task.projectId),
    [projects, task.projectId],
  );
  const [projectId, setProjectId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((project) => project.id === projectId) ?? null;

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, []);

  async function confirm() {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(target.id);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="task-reassign-dialog"
      aria-labelledby="task-reassign-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <header className="dialog-header">
        <div className="dialog-context">
          <strong id="task-reassign-dialog-title">切换项目</strong>
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          aria-label="关闭"
          disabled={saving}
          onClick={onCancel}
        >
          <LinearIcon name="close" />
        </button>
      </header>

      {!confirming ? (
        <div className="task-reassign-dialog-body">
          <p>选择 {task.identifier} 要切换到的目标项目。</p>
          <label className="task-reassign-target">
            <span>目标项目</span>
            <select
              value={projectId}
              disabled={saving || targets.length === 0}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="" disabled>选择项目…</option>
              {targets.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          {targets.length === 0 && <p className="task-reassign-dialog-error">没有可切换的其他项目。</p>}
          <footer className="dialog-footer">
            <button className="button secondary" type="button" onClick={onCancel}>取消</button>
            <button
              className="button primary"
              type="button"
              disabled={!target || saving}
              onClick={() => setConfirming(true)}
            >
              继续
            </button>
          </footer>
        </div>
      ) : (
        <div className="task-reassign-dialog-body">
          <p>确认将 {task.identifier} 切换到“{target?.name}”。</p>
          <p className="task-reassign-confirmation">切换后保留当前状态，不会自动开始或重新启动开发。</p>
          {error && <p className="task-reassign-dialog-error" role="alert">{error}</p>}
          <footer className="dialog-footer">
            <button className="button secondary" type="button" disabled={saving} onClick={() => setConfirming(false)}>返回</button>
            <button className="button primary" type="button" disabled={saving} onClick={() => void confirm()}>
              {saving ? "切换中…" : "确认切换项目"}
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
