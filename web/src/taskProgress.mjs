export function presentTaskProgress(processing) {
  if (
    !processing
    || !Number.isFinite(processing.completed)
    || !Number.isFinite(processing.total)
    || processing.total <= 0
  ) {
    return null;
  }

  const completed = Math.max(0, Math.min(processing.completed, processing.total));
  const complete = completed === processing.total;
  const percent = complete ? 100 : Math.floor((completed / processing.total) * 100);
  const phase = complete
    ? "complete"
    : percent >= 80
      ? "finishing"
      : percent >= 50
        ? "verifying"
        : percent >= 25
          ? "implementing"
          : "analyzing";

  return {
    percent,
    completed,
    total: processing.total,
    remaining: processing.total - completed,
    phase,
    running: processing.running === true,
  };
}

export function displayTaskProgressPhase(progress) {
  if (!progress) return null;
  return progress.running ? progress.phase : "paused";
}

export function taskProgressRemainingLabel(remaining, language) {
  if (remaining === 0) return language === "zh" ? "步骤已完成" : "Steps complete";
  if (language === "zh") return `剩余 ${remaining} 步`;
  return remaining === 1 ? "1 step remaining" : `${remaining} steps remaining`;
}

export function presentTaskElapsed(startedAt, now) {
  if (!startedAt || !Number.isFinite(now)) return "";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m${elapsed % 60 ? `${elapsed % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}
