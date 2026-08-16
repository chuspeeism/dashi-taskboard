import { useTaskboardI18n } from "../i18n";
import type { TaskProcessingPresentation } from "../taskConversations";
import {
  displayTaskProgressPhase,
  presentTaskProgress,
  taskProgressRemainingLabel,
  type TaskProgressDisplayPhase,
} from "../taskProgress.mjs";

function phaseLabel(
  phase: TaskProgressDisplayPhase,
  text: (chinese: string, english: string) => string,
) {
  const labels: Record<TaskProgressDisplayPhase, readonly [string, string]> = {
    analyzing: ["分析中", "Analyzing"],
    implementing: ["实现中", "Implementing"],
    verifying: ["验证中", "Verifying"],
    finishing: ["收尾中", "Finishing"],
    complete: ["已完成", "Complete"],
    paused: ["已暂停", "Paused"],
  };
  return text(...labels[phase]);
}

export function TaskProgressSummary({
  processing,
}: {
  processing: TaskProcessingPresentation;
}) {
  const { language, text } = useTaskboardI18n();
  const progress = presentTaskProgress(processing);
  if (!progress) return null;

  const displayPhase = displayTaskProgressPhase(progress);
  if (!displayPhase) return null;
  const phase = phaseLabel(displayPhase, text);
  const remaining = taskProgressRemainingLabel(progress.remaining, language);
  const accessibleLabel = `${progress.percent}% · ${phase} · ${remaining}`;

  return (
    <div className="task-progress-summary" aria-label={accessibleLabel}>
      <div className="task-progress-copy">
        <strong>{progress.percent}%</strong>
        <span>{phase} · {remaining}</span>
      </div>
      <progress
        value={progress.completed}
        max={progress.total}
        aria-label={accessibleLabel}
      />
    </div>
  );
}
