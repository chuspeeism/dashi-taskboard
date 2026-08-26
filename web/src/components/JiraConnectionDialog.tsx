import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { JiraConnection } from "../types";

interface JiraConnectionDialogProps {
  connection: JiraConnection | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: {
    baseUrl: string;
    username: string;
    password: string;
    projects: string[];
  }) => Promise<void>;
}

export function JiraConnectionDialog({
  connection,
  saving,
  error,
  onClose,
  onSave,
}: JiraConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "http://");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [projectsText, setProjectsText] = useState(connection?.projects.join(", ") ?? "");

  useEffect(() => {
    setBaseUrl(connection?.baseUrl ?? "http://");
    setUsername(connection?.username ?? "");
    setPassword("");
    setProjectsText(connection?.projects.join(", ") ?? "");
  }, [connection]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      baseUrl: baseUrl.trim(),
      username: username.trim(),
      password,
      projects: projectsText
        .split(/[,，\n]+/)
        .map((project) => project.trim())
        .filter(Boolean),
    });
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog jira-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jira-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="jira-connection-title">
          {connection?.configured ? text("Jira 設定", "Jira settings") : text("連線 Jira", "Connect Jira")}
        </h2>
        <label>
          <span>{text("Jira 地址", "Jira URL")}</span>
          <input
            autoFocus
            required
            inputMode="url"
            maxLength={2048}
            placeholder="http://jira.internal"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        {/^http:\/\//i.test(baseUrl.trim()) && (
          <p className="jira-http-warning">
            {text(
              "HTTP 會在內網中以可讀取形式傳輸帳號密碼。",
              "HTTP sends the username and password in cleartext over the network.",
            )}
          </p>
        )}
        <label>
          <span>{text("Jira 專案（名稱或 Key，可多選）", "Jira projects (name or key, multiple allowed)")}</span>
          <input
            maxLength={2600}
            placeholder="DMARTECH, JP"
            value={projectsText}
            onChange={(event) => setProjectsText(event.target.value)}
          />
        </label>
        <label>
          <span>{text("使用者名稱", "Username")}</span>
          <input
            required={!connection?.configured}
            autoComplete="username"
            maxLength={254}
            placeholder={connection?.configured ? text("留空則保持不變", "Leave blank to keep unchanged") : ""}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          <span>{text("密碼", "Password")}</span>
          <input
            required={!connection?.configured}
            type="password"
            autoComplete="current-password"
            maxLength={4096}
            placeholder={connection?.configured ? text("留空則保持不變", "Leave blank to keep unchanged") : ""}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {connection?.configured && connection.displayName && (
          <p>{text("目前帳號：", "Current account: ")}{connection.displayName}</p>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              saving
              || !baseUrl.trim()
              || (!username.trim() && !connection?.configured)
              || (!password && !connection?.configured)
            }
          >
            {saving
              ? text("連線中…", "Connecting…")
              : connection?.configured
                ? text("儲存並同步", "Save and sync")
                : text("連線並同步", "Connect and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
