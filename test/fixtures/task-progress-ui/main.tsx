import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "../../../web/src/styles.css";
import { TaskboardLanguageProvider, type TaskboardLanguage } from "../../../web/src/i18n";
import { TaskCard } from "../../../web/src/components/TaskCard";
import { TaskDetail } from "../../../web/src/components/TaskDetail";
import { taskCardPresentation, type TaskCardPresentation } from "../../../web/src/taskConversations";
import type { AiChatThread, Task } from "../../../web/src/types";
import { waitForDomSelector, waitForTimer } from "../../support/wait-for-dom.mjs";

const query = new URLSearchParams(window.location.search);
const theme = query.get("theme") === "dark" ? "dark" : "light";
const language: TaskboardLanguage = query.get("language") === "zh" ? "zh" : "en";
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;
document.documentElement.dataset.fixturePhase = "module-loaded";

const currentUser = {
  type: "user" as const,
  id: "integration-user",
  name: "Integration User",
  avatarUrl: null,
};

const primaryThreadId = "codex-progress-primary";

const task: Task = {
  id: "task-progress-1",
  identifier: "DASH-70",
  projectId: "local",
  title: "Ship the real Codex progress treatment",
  description: "Uses the real todo counts without a time estimate.",
  status: "in_progress",
  priority: "high",
  labels: ["feature"],
  sortOrder: 0,
  threadId: primaryThreadId,
  conversationRefs: [{
    threadId: primaryThreadId,
    source: "task",
    sourceId: "task-progress-1",
    title: "Primary host progress",
    updatedAt: "2026-08-15T10:00:00.000Z",
  }],
  participants: [],
  previewImage: null,
  activityKey: "progress-fixture",
  activityUpdatedAt: "2026-08-15T10:00:00.000Z",
  creatorType: "user",
  creatorId: currentUser.id,
  creatorName: currentUser.name,
  creatorAvatarUrl: null,
  assignee: currentUser,
  workflowId: null,
  developmentContext: null,
  startDate: null,
  dueDate: null,
  recurrence: null,
  source: "local",
  externalUrl: null,
  archivedAt: null,
  relations: {
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocks: [],
    related: [],
  },
  version: 1,
  createdAt: "2026-08-15T09:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};

const boundaryTask: Task = {
  ...task,
  id: "task-progress-boundary",
  identifier: "DASH-99",
  title: "Keep incomplete work below one hundred percent",
  threadId: null,
  conversationRefs: [],
  activityKey: "progress-boundary-fixture",
};

const boundaryAiThread: AiChatThread = {
  id: "ai-progress-boundary",
  title: "Boundary progress",
  status: "running",
  origin: {
    projectId: boundaryTask.projectId,
    projectName: "Local",
    workspacePath: "/tmp/taskboard-progress-fixture",
    issueId: boundaryTask.id,
    issueIdentifier: boundaryTask.identifier,
  },
  codexThreadId: "codex-progress-boundary",
  model: "gpt-5.5",
  reasoningEffort: "high",
  sandbox: "workspace-write",
  createdAt: "2026-08-15T09:58:45.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
  currentRun: {
    id: "run-progress-boundary",
    threadId: "ai-progress-boundary",
    status: "running",
    startedAt: "2026-08-15T09:58:45.000Z",
  },
  latestTodo: {
    completed: 199,
    total: 200,
    eventId: "todo-progress-boundary",
    updatedAt: "2026-08-15T10:00:00.000Z",
  },
};

function ProgressFixture() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const presentations: Record<string, TaskCardPresentation> = {
    [task.id]: taskCardPresentation(
      task,
      [],
      false,
      running ? primaryThreadId : null,
      running ? { completed: 7, total: 10 } : null,
      running ? undefined : { completed: 7, total: 10, running: false },
    ),
    [boundaryTask.id]: taskCardPresentation(boundaryTask, [boundaryAiThread], false),
  };
  const tasks = [task, boundaryTask];
  const selectedTask = tasks.find((candidate) => candidate.id === selectedTaskId) ?? null;
  const now = new Date("2026-08-15T10:00:00.000Z").getTime();

  return (
    <TaskboardLanguageProvider language={language}>
      <main className="task-progress-fixture">
        <button data-fixture-pause type="button" onClick={() => setRunning(false)}>Pause fixture</button>
        {tasks.map((candidate) => (
          <TaskCard
            key={candidate.id}
            task={candidate}
            presentation={presentations[candidate.id]}
            now={now}
            isDragging={false}
            dragShift={0}
            isMoving={false}
            isSettling={false}
            isContextMenuOpen={false}
            availableLabels={[]}
            currentUser={currentUser}
            onCreateLabel={async () => undefined}
            onEdit={(selected) => setSelectedTaskId(selected.id)}
            onUpdate={async (current) => current}
            onContextMenu={() => undefined}
            onDragStart={() => undefined}
            onDragEnd={() => undefined}
            onOpenConversation={() => undefined}
          />
        ))}
        {selectedTask && (
          <TaskDetail
            presentation={presentations[selectedTask.id]}
            task={selectedTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={[]}
            developmentScan={{ workspacePath: null, contexts: [] }}
            developmentScanLoading={false}
            commentsRevision={0}
            attachmentsRevision={0}
            onCreateLabel={async () => undefined}
            onDeleteLabel={async () => undefined}
            onUpdate={async (current) => current}
            onOpenTask={() => undefined}
            onAddRelation={async () => ({ task: selectedTask, relatedTask: selectedTask })}
            onRemoveRelation={async () => ({ task: selectedTask, relatedTask: selectedTask })}
            onOpenThread={() => undefined}
            onOpenInThread={() => undefined}
            onCopy={() => undefined}
            openingThread={false}
            onError={() => undefined}
          />
        )}
      </main>
    </TaskboardLanguageProvider>
  );
}

function visibleProgress(container: string) {
  const root = document.querySelector<HTMLElement>(container);
  if (!root) throw new Error(`Missing real React progress container: ${container}`);
  const summary = root.querySelector<HTMLElement>(".task-progress-summary");
  if (!summary) throw new Error(`Missing real React progress summary in ${container}`);
  const progress = summary.querySelector<HTMLProgressElement>("progress");
  if (!progress) throw new Error(`Missing native progress element in ${container}`);
  const styles = getComputedStyle(progress);
  return {
    value: progress.value,
    max: progress.max,
    text: summary.innerText.replace(/\s+/g, " ").trim(),
    accessibleLabel: summary.getAttribute("aria-label"),
    accentColor: styles.accentColor,
    trackBackground: styles.backgroundColor,
  };
}

function computedColorToken(name: string) {
  const sentinel = document.createElement("span");
  sentinel.style.color = `var(${name})`;
  sentinel.style.position = "fixed";
  sentinel.style.pointerEvents = "none";
  sentinel.style.opacity = "0";
  document.body.append(sentinel);
  const value = getComputedStyle(sentinel).color;
  sentinel.remove();
  return value;
}

function readableText(container: string) {
  const root = document.querySelector<HTMLElement>(container);
  if (!root) throw new Error(`Missing real React readable container: ${container}`);
  return root.innerText.replace(/\s+/g, " ").trim();
}

async function captureProgressContract() {
  document.documentElement.dataset.fixturePhase = "waiting-for-card";
  const primarySelector = `[data-task-id="${task.id}"]`;
  const boundarySelector = `[data-task-id="${boundaryTask.id}"]`;
  await waitForDomSelector(document, primarySelector);
  await waitForDomSelector(document, boundarySelector);
  const cardOpen = document.querySelector<HTMLButtonElement>(`${primarySelector} .task-card-open`);
  if (!cardOpen) throw new Error("Missing real TaskCard open control");

  const runningCard = visibleProgress(primarySelector);
  const boundaryCard = visibleProgress(boundarySelector);
  const boundaryCardText = readableText(boundarySelector);
  cardOpen.click();
  document.documentElement.dataset.fixturePhase = "waiting-for-detail";
  await waitForDomSelector(document, ".issue-detail");
  await waitForTimer(24);
  const runningDetail = visibleProgress(".issue-detail");

  document.querySelector<HTMLButtonElement>("[data-fixture-pause]")?.click();
  await waitForTimer(24);
  const pausedCard = visibleProgress(primarySelector);
  const pausedDetail = visibleProgress(".issue-detail");
  const pausedCardText = readableText(primarySelector);
  const pausedDetailText = readableText(".issue-detail");

  document.documentElement.dataset.fixturePhase = "capturing-progress-contract";
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify({
    theme,
    language,
    accent: computedColorToken("--progress-accent"),
    runningCard,
    runningDetail,
    boundaryCard,
    boundaryCardText,
    pausedCard,
    pausedDetail,
    pausedCardText,
    pausedDetailText,
  }));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ProgressFixture /></StrictMode>,
);
document.documentElement.dataset.fixturePhase = "react-render-requested";

try {
  await captureProgressContract();
} catch (error) {
  const reportFixtureError = (window as Window & { reportFixtureError?: (value: unknown) => void }).reportFixtureError;
  if (reportFixtureError) reportFixtureError(error);
  else document.documentElement.dataset.result = encodeURIComponent(JSON.stringify({
    infrastructureError: String(error),
    phase: document.documentElement.dataset.fixturePhase,
  }));
}
