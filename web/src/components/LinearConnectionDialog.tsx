import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { LinearConnection } from "../types";

interface LinearConnectionDialogProps {
  connection: LinearConnection | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: { apiKey: string; teamKey: string }) => Promise<void>;
}

export function LinearConnectionDialog({
  connection,
  saving,
  error,
  onClose,
  onSave,
}: LinearConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [teamKey, setTeamKey] = useState(connection?.teamKey ?? "MM7");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setTeamKey(connection?.teamKey ?? "MM7");
    setApiKey("");
  }, [connection]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({ apiKey: apiKey.trim(), teamKey: teamKey.trim() });
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
        aria-labelledby="linear-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="linear-connection-title">
          {connection?.configured ? text("Linear 设置", "Linear settings") : text("连接 Linear", "Connect Linear")}
        </h2>
        <label>
          <span>{text("Linear 团队 Key", "Linear team key")}</span>
          <input
            autoFocus
            required
            maxLength={32}
            placeholder="MM7"
            value={teamKey}
            onChange={(event) => setTeamKey(event.target.value)}
          />
        </label>
        <label>
          <span>{text("个人 API Key", "Personal API key")}</span>
          <input
            required={!connection?.configured}
            type="password"
            autoComplete="off"
            maxLength={4096}
            placeholder={connection?.configured ? text("留空则保持不变", "Leave blank to keep unchanged") : "lin_api_…"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <p>
          {text(
            "在 Linear 的 Settings → Security & access → Personal API keys 中创建。",
            "Create one in Linear under Settings → Security & access → Personal API keys.",
          )}
        </p>
        {connection?.configured && connection.displayName && (
          <p>{text("当前账号：", "Current account: ")}{connection.displayName}</p>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || !teamKey.trim() || (!apiKey.trim() && !connection?.configured)}
          >
            {saving
              ? text("连接中…", "Connecting…")
              : connection?.configured
                ? text("保存并同步", "Save and sync")
                : text("连接并同步", "Connect and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
