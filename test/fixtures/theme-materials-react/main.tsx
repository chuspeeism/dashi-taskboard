import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import "../../../web/src/styles.css";
import { TaskboardLanguageProvider } from "../../../web/src/i18n";
import { BoardColumn } from "../../../web/src/components/BoardColumn";
import { DashboardView } from "../../../web/src/components/DashboardView";
import { ProjectAutomationMenu } from "../../../web/src/components/ProjectAutomationMenu";
import { waitForDomSelector, waitForTimer } from "../../support/wait-for-dom.mjs";

const theme = new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;
document.documentElement.dataset.fixturePhase = "module-loaded";

const LazyWorkflowOverlay = lazy(async () => {
  await import("../../../web/src/components/workflow.css");
  const { WorkflowStepPicker } = await import("../../../web/src/components/WorkflowStepPicker");
  return {
    default: () => (
      <WorkflowStepPicker items={[]} onSelect={() => undefined} onClose={() => undefined} />
    ),
  };
});

const currentUser = {
  type: "user" as const,
  id: "integration-user",
  name: "Integration User",
  avatarUrl: null,
};

function BoardColumnFixture({ dropTarget }: { dropTarget: boolean }) {
  return (
    <BoardColumn
      scrollRef={() => undefined}
      status="todo"
      tasks={[]}
      presentations={{}}
      now={Date.now()}
      emptyMessage="No issues"
      isDropTarget={dropTarget}
      draggedTaskId={null}
      draggedTaskHeight={0}
      movingTaskId={null}
      settlingTaskId={null}
      contextMenuTaskId={null}
      availableLabels={[]}
      currentUser={currentUser}
      onCreateLabel={async () => undefined}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onUpdate={async (task) => task}
      onComplete={() => undefined}
      onContextMenu={() => undefined}
      onDragStart={() => undefined}
      onDragEnd={() => undefined}
      onDragEnter={() => undefined}
      onDrop={() => undefined}
      onOpenConversation={() => undefined}
    />
  );
}

function MaterialFixture() {
  return (
    <TaskboardLanguageProvider language="en">
      <main className="material-integration-fixture">
        <header className="workspace-header">
          <ProjectAutomationMenu
            automation={{
              enabledByUser: true,
              quotaAware: true,
              intervalMinutes: 5,
              model: "gpt-5.5",
              reasoningEffort: "high",
              status: "ACTIVE",
              quota: { state: "available", checkedAt: Date.now() },
            }}
            pending={false}
            error={null}
            unavailableReason={null}
            onOpen={() => undefined}
            onChange={() => undefined}
          />
        </header>

        <DashboardView
          projectId="local"
          projectCreatedAt={null}
          tasks={[]}
          presentations={{}}
          currentUser={currentUser}
          animateSummary={false}
          onSummaryAnimationStart={() => undefined}
          onOpenTask={() => undefined}
          onOpenConversation={() => undefined}
        />

        <div className="material-board-columns">
          <div data-column="normal"><BoardColumnFixture dropTarget={false} /></div>
          <div data-column="drop"><BoardColumnFixture dropTarget /></div>
        </div>

        <Suspense fallback={<div data-workflow-loading>Loading workflow overlay</div>}>
          <LazyWorkflowOverlay />
        </Suspense>
      </main>
    </TaskboardLanguageProvider>
  );
}

function snapshot(selector: string) {
  const element = document.querySelector<HTMLElement | SVGElement>(selector);
  if (!element) throw new Error(`Missing real React element: ${selector}`);
  const styles = getComputedStyle(element);
  return {
    background: styles.backgroundColor,
    backgroundImage: styles.backgroundImage,
    backdrop: styles.backdropFilter || styles.webkitBackdropFilter || "none",
    boxShadow: styles.boxShadow,
    color: styles.color,
    fill: styles.fill,
    outlineColor: styles.outlineColor,
    stroke: styles.stroke,
    textFill: styles.webkitTextFillColor,
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

async function captureMaterialContract() {
  document.documentElement.dataset.fixturePhase = "waiting-for-lazy-workflow";
  await waitForDomSelector(document, ".workflow-step-picker-backdrop");
  document.documentElement.dataset.fixturePhase = "opening-automation-portal";
  await waitForDomSelector(document, ".project-automation-trigger");
  (document.querySelector(".project-automation-trigger") as HTMLButtonElement).click();
  await waitForDomSelector(document, ".project-automation-menu");
  await waitForTimer(24);

  document.documentElement.dataset.fixturePhase = "capturing-computed-styles";
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify({
    theme,
    tokens: {
      accent: computedColorToken("--accent"),
      accentText: computedColorToken("--accent-text"),
      focusRing: computedColorToken("--focus-ring"),
      textTertiary: computedColorToken("--text-tertiary"),
      textQuaternary: computedColorToken("--text-quaternary"),
    },
    workflowBackdrop: snapshot(".workflow-step-picker-backdrop"),
    automationMenu: snapshot(".project-automation-menu"),
    automationSwitch: snapshot(".project-automation-switch"),
    automationField: snapshot(".project-automation-field"),
    automationQuota: snapshot(".project-automation-quota"),
    dashboardHero: snapshot(".dashboard-hero-value strong"),
    dashboardMutedSurface: snapshot(".dashboard-metric-meter"),
    dashboardStartedText: snapshot(".dashboard-progress-legend .tone-started"),
    dashboardStartedLine: snapshot(".dashboard-progress-line.tone-started"),
    normalColumn: snapshot('[data-column="normal"] .board-column'),
    dropColumn: snapshot('[data-column="drop"] .board-column'),
  }));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><MaterialFixture /></StrictMode>,
);
document.documentElement.dataset.fixturePhase = "react-render-requested";

try {
  await captureMaterialContract();
} catch (error) {
  const reportFixtureError = (window as Window & { reportFixtureError?: (value: unknown) => void }).reportFixtureError;
  if (reportFixtureError) reportFixtureError(error);
  else document.documentElement.dataset.result = encodeURIComponent(JSON.stringify({
    infrastructureError: String(error),
    phase: document.documentElement.dataset.fixturePhase,
  }));
}
