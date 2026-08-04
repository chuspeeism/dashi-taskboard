import { useEffect, useRef, useState, type FormEvent } from "react";
import { LinearIcon } from "./LinearIcon";

interface ProjectCreatorProps {
  onCancel: () => void;
  onCreate: (name: string, workspacePath: string) => Promise<void>;
  onSelectDirectory: () => Promise<string | null>;
}

export function ProjectCreator({ onCancel, onCreate, onSelectDirectory }: ProjectCreatorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    nameRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanWorkspacePath = workspacePath.trim();
    if (!cleanName) {
      setError("请填写项目名称。");
      nameRef.current?.focus();
      return;
    }
    if (!cleanWorkspacePath) {
      setError("请填写项目目录。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onCreate(cleanName, cleanWorkspacePath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法创建项目。");
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectDirectory() {
    setSelectingDirectory(true);
    setError(null);
    try {
      const selectedPath = await onSelectDirectory();
      if (selectedPath) setWorkspacePath(selectedPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法选择项目目录。");
    } finally {
      setSelectingDirectory(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="project-create-dialog"
      aria-labelledby="project-create-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <form className="project-create-form" onSubmit={handleSubmit}>
        <header className="dialog-header">
          <div className="dialog-context">
            <strong id="project-create-title">新建项目</strong>
          </div>
          <div className="dialog-header-actions">
            <button
              type="button"
              className="icon-button dialog-close"
              onClick={onCancel}
              disabled={saving}
              aria-label="关闭新建项目"
            >
              <LinearIcon name="close" />
            </button>
          </div>
        </header>

        <div className="project-create-body">
          <label className="project-create-field">
            <span>项目名称</span>
            <div className="project-create-input">
              <LinearIcon name="project" />
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="输入项目名称"
                maxLength={120}
                autoComplete="off"
              />
            </div>
          </label>

          <label className="project-create-field">
            <span>项目目录</span>
            <div className="project-create-input">
              <button
                className="project-create-folder-button"
                type="button"
                onClick={() => void handleSelectDirectory()}
                disabled={saving || selectingDirectory}
                aria-label="选择项目文件夹"
                title="选择项目文件夹"
              >
                <LinearIcon name="folder" />
              </button>
              <input
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="输入项目文件夹路径"
                maxLength={4096}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <small>选择或输入本机项目文件夹。</small>
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}
        </div>

        <footer className="dialog-footer project-create-footer">
          <div className="dialog-actions">
            <button className="button secondary" type="button" onClick={onCancel} disabled={saving}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? "正在创建…" : "创建项目"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
