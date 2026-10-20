import { useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { analysisReportUrl } from "../api";
import { useTaskboardI18n } from "../i18n";
import { MarkdownDocument } from "./MarkdownDocument";

const PREVIEW_LENGTH = 600;

// Keeps events inside the portal from reaching the card (open, drag, context menu).
const stop = (event: SyntheticEvent) => event.stopPropagation();

export function AnalysisReportLink({ task }: { task: { id: string; externalKey?: string | null; analysisReport?: string | null } }) {
  const { text } = useTaskboardI18n();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const url = analysisReportUrl(task);

  function load() {
    if (content !== null || error) return;
    fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then(setContent)
      .catch(() => setError(true));
  }

  const body = error
    ? text("无法读取报告", "Cannot read the report")
    : content ?? text("加载中…", "Loading…");

  return (
    <>
      <a
        href={url}
        onMouseEnter={(event) => {
          load();
          const rect = event.currentTarget.getBoundingClientRect();
          setPreview({ x: rect.left, y: rect.bottom + 6 });
        }}
        onMouseLeave={() => setPreview(null)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          load();
          setPreview(null);
          setModalOpen(true);
        }}
      >
        {text("查看报告", "View report")}
      </a>
      {preview && !modalOpen && createPortal(
        <div
          className="analysis-report-preview"
          role="tooltip"
          style={{ left: Math.min(preview.x, window.innerWidth - 376), top: preview.y }}
        >
          {content && content.length > PREVIEW_LENGTH ? `${content.slice(0, PREVIEW_LENGTH)}…` : body}
        </div>,
        document.body,
      )}
      {modalOpen && createPortal(
        <div
          className="delete-backdrop"
          onClick={stop}
          onContextMenu={stop}
          onDragStart={stop}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setModalOpen(false);
          }}
        >
          <div
            className="analysis-report-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`analysis-report-${task.id}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") setModalOpen(false);
            }}
          >
            <header>
              <h2 id={`analysis-report-${task.id}`}>
                {task.externalKey ? `${task.externalKey} · ` : ""}{text("分析报告", "Analysis report")}
              </h2>
              <a className="button secondary" href={url} target="_blank" rel="noreferrer">
                {text("在新标签页查看", "View in new tab")}
              </a>
              <button className="button secondary" type="button" autoFocus onClick={() => setModalOpen(false)}>
                {text("关闭", "Close")}
              </button>
            </header>
            <div className="analysis-report-body">
              {content ? <MarkdownDocument value={content} /> : <p>{body}</p>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
