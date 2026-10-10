import { useEffect, useState } from "react";

import { getLinearPlanning } from "../api";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { LinearPlanning } from "../types";

// Read-only sprint planning: pick candidates and compare against capacity.
// Nothing is written back to Linear.
export function LinearPlanningPanel({ onClose }: { onClose: () => void }) {
  const { language, text } = useTaskboardI18n();
  const [planning, setPlanning] = useState<LinearPlanning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();
    getLinearPlanning(controller.signal)
      .then(setPlanning)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, []);

  const selectedPoints = planning?.candidates
    .filter((candidate) => selected.has(candidate.externalKey))
    .reduce((sum, candidate) => sum + (candidate.estimate ?? 0), 0) ?? 0;
  const plannedPoints = (planning?.currentScope.total ?? 0) + selectedPoints;
  const overCapacity = planning !== null && plannedPoints > planning.capacity;

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="delete-dialog linear-planning-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="linear-planning-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2 id="linear-planning-title">{text("周期规划", "Sprint planning")}</h2>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        {!planning && !error && <p>{text("加载中…", "Loading…")}</p>}
        {planning && (
          <>
            <p>
              {text(`容量 ${planning.capacity} 点`, `Capacity ${planning.capacity} pts`)}
              {planning.previousCycles.length > 0 && ` (${planning.previousCycles
                .map((cycle) => `${cycle.name ?? `#${cycle.number}`}: ${cycle.completedPoints}`)
                .join(" · ")})`}
            </p>
            <ul className="linear-planning-candidates">
              {planning.candidates.length === 0 && (
                <li>{text("没有未排入周期的议题", "No issues without a cycle")}</li>
              )}
              {planning.candidates.map((candidate) => (
                <li key={candidate.externalKey}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.externalKey)}
                      onChange={() => toggle(candidate.externalKey)}
                    />
                    <span className="linear-planning-key">{candidate.externalKey}</span>
                    <span className="linear-planning-title" title={candidate.title}>{candidate.title}</span>
                    <span className="linear-planning-status">{taskStatusLabel(language, candidate.status)}</span>
                    <span className="linear-planning-estimate">{candidate.estimate ?? "–"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className={`linear-planning-total${overCapacity ? " over" : ""}`} aria-live="polite">
              {text(
                `当前范围 ${planning.currentScope.total}（已完成 ${planning.currentScope.completed}）+ 已选 ${selectedPoints} = ${plannedPoints} / 容量 ${planning.capacity}`,
                `Current scope ${planning.currentScope.total} (${planning.currentScope.completed} done) + selected ${selectedPoints} = ${plannedPoints} / capacity ${planning.capacity}`,
              )}
              {overCapacity && text("，超出容量", " · over capacity")}
            </p>
          </>
        )}
        <div>
          <button className="button secondary" type="button" autoFocus onClick={onClose}>
            {text("关闭", "Close")}
          </button>
        </div>
      </div>
    </div>
  );
}
