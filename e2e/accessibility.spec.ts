import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const PROJECT_ID = "temp-e2e-accessibility";
const PROGRESS_TITLE = "Accessibility progress 7 of 10";
const PROGRESS_THREAD_ID = "019ffb43-b064-7ed0-89e0-48b4a43d95f3";
const FIRST_USE_COMPLETE_KEY = "taskboard.first-use-complete.v1";

interface SeededTask {
  id: string;
  identifier: string;
  title: string;
  version: number;
}

async function expectApiOk(response: APIResponse, operation: string) {
  if (!response.ok()) {
    throw new Error(`${operation}: ${response.status()} ${await response.text()}`);
  }
}

async function removeProjectFixture(request: APIRequestContext) {
  const active = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(active, "list active a11y tasks");
  for (const task of (await active.json()).tasks as SeededTask[]) {
    const archived = await request.post(`/api/tasks/${task.id}/archive`, {
      data: { version: task.version },
    });
    await expectApiOk(archived, `archive ${task.identifier}`);
    const archivedTask = (await archived.json()).task as SeededTask;
    const deleted = await request.delete(`/api/tasks/${task.id}`, {
      data: { version: archivedTask.version },
    });
    await expectApiOk(deleted, `delete ${task.identifier}`);
  }

  const archived = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=true`);
  await expectApiOk(archived, "list archived a11y tasks");
  for (const task of (await archived.json()).tasks as SeededTask[]) {
    const deleted = await request.delete(`/api/tasks/${task.id}`, {
      data: { version: task.version },
    });
    await expectApiOk(deleted, `delete archived ${task.identifier}`);
  }

  const projects = await request.get("/api/projects");
  await expectApiOk(projects, "list projects");
  const exists = ((await projects.json()).projects as Array<{ id: string }>).some(
    (project) => project.id === PROJECT_ID,
  );
  if (exists) {
    const deleted = await request.delete(`/api/projects/${PROJECT_ID}`);
    await expectApiOk(deleted, "delete a11y project");
  }
}

async function createTask(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/tasks", {
    data: { projectId: PROJECT_ID, ...body },
  });
  await expectApiOk(response, `create ${String(body.title)}`);
  return (await response.json()).task as SeededTask;
}

async function seedProjectFixture(request: APIRequestContext) {
  await removeProjectFixture(request);
  const project = await request.post("/api/projects", {
    data: {
      id: PROJECT_ID,
      name: "Accessibility QA",
      workspacePath: "/tmp/codex-taskboard-e2e-accessibility",
    },
  });
  await expectApiOk(project, "create a11y project");
  await createTask(request, {
    title: PROGRESS_TITLE,
    description: "A real seven-of-ten progress fixture.",
    status: "in_progress",
    priority: "high",
    labels: ["accessibility"],
    threadId: PROGRESS_THREAD_ID,
  });
  await createTask(request, {
    title: "Review keyboard focus",
    status: "in_review",
    priority: "urgent",
  });
  const archived = await createTask(request, {
    title: "Archived accessibility requirement",
    status: "done",
    priority: "low",
  });
  const archiveResponse = await request.post(`/api/tasks/${archived.id}/archive`, {
    data: { version: archived.version },
  });
  await expectApiOk(archiveResponse, `archive ${archived.identifier}`);
}

async function preparePage(page: Page) {
  await page.addInitScript((key) => window.localStorage.setItem(key, "true"), FIRST_USE_COMPLETE_KEY);
}

async function publishSevenOfTen(request: APIRequestContext) {
  const response = await request.put("/api/local/host-runtime", {
    data: {
      threadId: PROGRESS_THREAD_ID,
      threadRunning: true,
      threadTodoProgress: { completed: 7, total: 10 },
    },
  });
  await expectApiOk(response, "publish a11y host progress");
}

function boardPath(theme: "light" | "dark") {
  return `/?project=${PROJECT_ID}&lang=en&theme=${theme}`;
}

async function openBoard(page: Page, theme: "light" | "dark") {
  await preparePage(page);
  await page.goto(boardPath(theme));
  await expect(page.locator('.board-scroll[aria-label="Issue board"]')).toBeVisible();
  await expect(page.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`)).toBeVisible();
}

async function expectNoSeriousOrCritical(page: Page, surface: string) {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(violations, `${surface} serious/critical axe violations`).toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await seedProjectFixture(request);
});

test.afterEach(async ({ request }) => {
  await removeProjectFixture(request);
});

test("light board, detail, automation, archive, and modal have no serious or critical axe findings", async ({ page }) => {
  await openBoard(page, "light");
  await expectNoSeriousOrCritical(page, "light board");

  await page.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`).click();
  await expect(page.getByRole("region", { name: /issue details/ })).toBeVisible();
  await expectNoSeriousOrCritical(page, "light task detail");

  await page.getByRole("button", { name: "Back to issue board" }).click();
  await page.getByRole("button", { name: "Automation" }).click();
  await expect(page.getByRole("dialog", { name: "Auto-claim settings" })).toBeVisible();
  await expectNoSeriousOrCritical(page, "light automation dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open archive" }).click();
  await expect(page.getByText("Archived accessibility requirement", { exact: true })).toBeVisible();
  await expectNoSeriousOrCritical(page, "light archive panel");

  await page.getByRole("button", { name: "Close archive" }).click();
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New issue" })).toBeVisible();
  await expectNoSeriousOrCritical(page, "light create-issue modal");
});

test("dark board and detail have no serious or critical axe findings", async ({ page, request }) => {
  await publishSevenOfTen(request);
  await openBoard(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoSeriousOrCritical(page, "dark board");

  await page.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`).click();
  await expect(page.getByRole("region", { name: /issue details/ })).toBeVisible();
  await expectNoSeriousOrCritical(page, "dark task detail");
});
