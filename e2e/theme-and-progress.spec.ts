import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Frame,
  type Page,
} from "@playwright/test";

const PROJECT_ID = "temp-e2e-theme-progress";
const PROJECT_NAME = "主题与进度验收";
const PROGRESS_TITLE = "进度任务 7 / 10";
const PROGRESS_THREAD_ID = "019ffb43-b064-7ed0-89e0-48b4a43d95f2";
const COMPLETED_TITLE = "已完成：主题适配合同";
const EDITED_COMPLETED_TITLE = "已完成：主题适配合同（已编辑）";
const ARCHIVED_TITLE = "已归档需求：自动收集内容";
const FIRST_USE_COMPLETE_KEY = "taskboard.first-use-complete.v1";
const SCREENSHOT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.artifacts/playwright/screenshots",
);

interface SeededTask {
  id: string;
  identifier: string;
  title: string;
  status: string;
  version: number;
}

interface SeedState {
  progress: SeededTask;
}

let seed: SeedState;

async function expectApiOk(response: APIResponse, operation: string) {
  if (!response.ok()) {
    throw new Error(`${operation}: ${response.status()} ${await response.text()}`);
  }
}

async function removeProjectFixture(request: APIRequestContext) {
  const active = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(active, "list active fixture tasks");
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
  await expectApiOk(archived, "list archived fixture tasks");
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
    await expectApiOk(deleted, "delete fixture project");
  }
}

async function createTask(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<SeededTask> {
  const response = await request.post("/api/tasks", {
    data: { projectId: PROJECT_ID, ...body },
  });
  await expectApiOk(response, `create ${String(body.title)}`);
  return (await response.json()).task as SeededTask;
}

async function seedProjectFixture(request: APIRequestContext): Promise<SeedState> {
  await removeProjectFixture(request);
  const project = await request.post("/api/projects", {
    data: {
      id: PROJECT_ID,
      name: PROJECT_NAME,
      workspacePath: "/tmp/codex-taskboard-e2e-theme-progress",
    },
  });
  await expectApiOk(project, "create fixture project");

  const progress = await createTask(request, {
    title: PROGRESS_TITLE,
    description: "真实 Codex todo：已完成 7 项，共 10 项。",
    status: "in_progress",
    priority: "high",
    labels: ["浏览器验收"],
    threadId: PROGRESS_THREAD_ID,
  });
  await createTask(request, {
    title: "整理 Apple 浅色视觉层级",
    status: "todo",
    priority: "medium",
    labels: ["浏览器验收"],
  });
  await createTask(request, {
    title: "审核 Codex 侧栏入口",
    status: "in_review",
    priority: "urgent",
    labels: ["发布"],
  });
  await createTask(request, {
    title: COMPLETED_TITLE,
    status: "done",
    priority: "low",
  });
  for (const title of ["已归档需求：自动收集内容", "已归档需求：跨对话索引"]) {
    const task = await createTask(request, { title, status: "done", priority: "none" });
    const archived = await request.post(`/api/tasks/${task.id}/archive`, {
      data: { version: task.version },
    });
    await expectApiOk(archived, `archive ${task.identifier}`);
  }
  return { progress };
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
  await expectApiOk(response, "publish 7/10 host progress");
}

function boardPath(options: { theme?: "light" | "dark"; host?: "workbuddy" } = {}) {
  const query = new URLSearchParams({ project: PROJECT_ID, lang: "zh" });
  if (options.theme) query.set("theme", options.theme);
  if (options.host) query.set("host", options.host);
  return `/?${query}`;
}

async function waitForBoard(page: Page | Frame) {
  await expect(page.locator('.board-scroll[aria-label="议题看板"]')).toBeVisible();
  await expect(page.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`)).toBeVisible();
}

async function screenshot(page: Page, filename: string) {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIRECTORY, filename),
    fullPage: false,
  });
}

async function mountCodexFrame(page: Page): Promise<Frame> {
  await preparePage(page);
  await page.setContent(
    `<iframe title="Codex Taskboard" src="http://127.0.0.1:4173${boardPath({ theme: "light" })}&host=codex" style="border:0;width:100vw;height:100vh"></iframe>`,
  );
  const frame = page.frames().find((candidate) => candidate.url().includes("host=codex"));
  expect(frame, "embedded Codex taskboard frame").toBeTruthy();
  await waitForBoard(frame!);
  return frame!;
}

async function postHostMessage(page: Page, message: object) {
  await page.locator("iframe").evaluate((iframe, payload) => {
    (iframe as HTMLIFrameElement).contentWindow?.postMessage(payload, "*");
  }, message);
}

async function themeAtNextPaintAfterHostMessage(
  page: Page,
  frame: Frame,
  message: object,
): Promise<string | null> {
  const nextPaint = frame.evaluate(() => new Promise<string | null>((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      requestAnimationFrame(() => resolve(document.documentElement.dataset.theme ?? null));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }));
  await postHostMessage(page, message);
  return nextPaint;
}

test.beforeEach(async ({ request }) => {
  seed = await seedProjectFixture(request);
});

test.afterEach(async ({ request }) => {
  await removeProjectFixture(request);
});

test("standalone theme overrides apply light and dark", async ({ page }) => {
  await preparePage(page);
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.goto(boardPath({ theme: "dark" }));
  await waitForBoard(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("project switcher is an unclipped overlay above workspace navigation", async ({ page }) => {
  await preparePage(page);
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);

  await page.getByRole("button", { name: "切换项目" }).click();
  const menu = page.getByRole("menu", { name: "项目" });
  await expect(menu).toBeVisible();

  const metrics = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".workspace-header");
    return {
      position: getComputedStyle(element).position,
      parentTagName: element.parentElement?.tagName ?? null,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuZIndex: Number.parseInt(getComputedStyle(element).zIndex, 10),
      headerZIndex: header ? Number.parseInt(getComputedStyle(header).zIndex, 10) || 0 : 0,
    };
  });

  expect(metrics.position).toBe("fixed");
  expect(metrics.parentTagName).toBe("BODY");
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.menuZIndex).toBeGreaterThan(metrics.headerZIndex);
  await screenshot(page, "project-switcher-overlay-light.png");
});

test("issue board keeps 60px separation on every annotated edge", async ({ page }) => {
  await preparePage(page);

  for (const scenario of [
    { width: 1440, height: 900, theme: "light" as const },
    { width: 900, height: 760, theme: "dark" as const },
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto(boardPath({ theme: scenario.theme }));
    await waitForBoard(page);

    const spacing = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".board-toolbar");
      const layout = document.querySelector<HTMLElement>(".issue-board-layout");
      const scroll = document.querySelector<HTMLElement>(".board-scroll");
      const board = document.querySelector<HTMLElement>(".board");
      const columns = Array.from(document.querySelectorAll<HTMLElement>(".board-column"));
      if (!toolbar || !layout || !scroll || !board || columns.length < 2) {
        throw new Error("Expected toolbar, issue board, and at least two columns");
      }

      const toolbarRect = toolbar.getBoundingClientRect();
      const layoutRect = layout.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const boardRect = board.getBoundingClientRect();
      const firstRect = columns[0].getBoundingClientRect();
      const secondRect = columns[1].getBoundingClientRect();
      const firstHeader = columns[0].querySelector<HTMLElement>(".column-header");
      if (!firstHeader) throw new Error("Expected a column header");
      const firstHeaderRect = firstHeader.getBoundingClientRect();
      const firstColumnStyle = getComputedStyle(columns[0]);
      const firstHeaderStyle = getComputedStyle(firstHeader);
      const contentSurfaceProbe = document.createElement("span");
      contentSurfaceProbe.style.background = "var(--content-surface)";
      document.body.append(contentSurfaceProbe);
      const contentSurfaceBackground = getComputedStyle(contentSurfaceProbe).backgroundColor;
      contentSurfaceProbe.remove();
      const topGapOwner = document.elementFromPoint(
        firstRect.left + 20,
        toolbarRect.bottom + 30,
      );

      return {
        layoutTop: Math.round(layoutRect.top - toolbarRect.bottom),
        top: Math.round(firstRect.top - toolbarRect.bottom),
        topGapInsideBoard: Boolean(topGapOwner && layout.contains(topGapOwner)),
        left: Math.round(firstRect.left - scrollRect.left + scroll.scrollLeft),
        betweenColumns: Math.round(secondRect.left - firstRect.right),
        right: Math.round(scroll.scrollWidth - (boardRect.right - scrollRect.left + scroll.scrollLeft)),
        bottom: Math.round(scrollRect.bottom - boardRect.bottom),
        headerLeft: Math.round(firstHeaderRect.left - firstRect.left),
        headerRight: Math.round(firstRect.right - firstHeaderRect.right),
        headerTop: Math.round(firstHeaderRect.top - firstRect.top),
        columnRadius: firstColumnStyle.borderTopLeftRadius,
        headerRadius: firstHeaderStyle.borderTopLeftRadius,
        headerBackground: firstHeaderStyle.backgroundColor,
        contentSurfaceBackground,
      };
    });
    expect(spacing).toMatchObject({
      layoutTop: 0,
      top: 60,
      topGapInsideBoard: true,
      left: 60,
      betweenColumns: 60,
      right: 60,
      bottom: 60,
      headerLeft: 12,
      headerRight: 12,
      headerTop: 12,
      columnRadius: "20px",
      headerRadius: "12px",
    });
    if (scenario.theme === "light") {
      expect(spacing.headerBackground).toBe(spacing.contentSurfaceBackground);
    }
    await screenshot(page, `taskboard-spacing-${scenario.theme}-${scenario.width}.png`);
  }
});

test("light list view separates the white canvas from stronger category rows", async ({ page }) => {
  await preparePage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);
  await page.getByRole("button", { name: "列表视图", exact: true }).click();

  const listView = page.locator(".issue-list-view");
  const categoryRows = page.locator(".issue-list-group-header");
  await expect(listView).toBeVisible();
  await expect(categoryRows).toHaveCount(7);

  const colors = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(".board-toolbar");
    const canvas = document.querySelector<HTMLElement>(".issue-list-view");
    const category = document.querySelector<HTMLElement>(".issue-list-group-header");
    if (!toolbar || !canvas || !category) {
      throw new Error("Expected toolbar, list canvas, and category row");
    }
    const toolbarRect = toolbar.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const categoryRect = category.getBoundingClientRect();
    const topGapOwner = document.elementFromPoint(canvasRect.left + 20, toolbarRect.bottom + 10);
    return {
      canvas: getComputedStyle(canvas).backgroundColor,
      category: getComputedStyle(category).backgroundColor,
      canvasTop: Math.round(canvasRect.top - toolbarRect.bottom),
      categoryTop: Math.round(categoryRect.top - toolbarRect.bottom),
      topGapIsListCanvas: Boolean(topGapOwner && canvas.contains(topGapOwner)),
    };
  });

  expect(colors).toEqual({
    canvas: "rgb(255, 255, 255)",
    category: "rgb(223, 241, 255)",
    canvasTop: 0,
    categoryTop: 20,
    topGapIsListCanvas: true,
  });
  await screenshot(page, "list-view-surfaces-light-1440.png");
});

test("completed is a visible board column and archive has a dedicated entry", async ({ page }) => {
  await preparePage(page);
  await page.setViewportSize({ width: 1728, height: 960 });
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);

  const completedColumn = page.locator(".board-column.status-done");
  await expect(completedColumn.getByRole("heading", { name: "已完成", exact: true })).toBeVisible();
  await expect(completedColumn.getByText(COMPLETED_TITLE, { exact: true })).toBeVisible();

  const archiveEntry = page.getByRole("button", { name: "打开归档" });
  await expect(archiveEntry).toBeVisible();
  await screenshot(page, "board-completed-archive-entry-light.png");
  await archiveEntry.click();
  await expect(page.getByRole("tabpanel", { name: /已归档/ })).toBeVisible();
  await expect(page.getByText(ARCHIVED_TITLE, { exact: true })).toBeVisible();
  await screenshot(page, "archive-dedicated-light.png");
});

test("completed tasks can be edited and continued with a versioned server move", async ({ page, request }) => {
  await preparePage(page);
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);

  const beforeEditResponse = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(beforeEditResponse, "list active tasks before edit");
  const beforeEdit = ((await beforeEditResponse.json()).tasks as SeededTask[]).find(
    (task) => task.title === COMPLETED_TITLE,
  );
  expect(beforeEdit, "seeded completed task").toBeTruthy();

  const completedCard = page.locator(".board-column.status-done .task-card").filter({
    hasText: COMPLETED_TITLE,
  });
  await completedCard.locator(".task-card-open").click();
  await expect(page.getByRole("region", { name: /议题详情/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /议题详情/ }).getByText(COMPLETED_TITLE, { exact: true })).toBeVisible();
  const titleEditor = page.getByRole("textbox", { name: "议题标题" });
  await titleEditor.fill(EDITED_COMPLETED_TITLE);
  await titleEditor.press("Enter");
  await expect.poll(async () => {
    const response = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
    await expectApiOk(response, "poll active tasks after edit");
    return ((await response.json()).tasks as SeededTask[]).find(
      (task) => task.id === beforeEdit!.id,
    )?.title;
  }).toBe(EDITED_COMPLETED_TITLE);
  await page.getByRole("button", { name: "返回议题看板" }).click();

  const editedCard = page.locator(".board-column.status-done .task-card").filter({
    hasText: EDITED_COMPLETED_TITLE,
  });
  await expect(editedCard).toBeVisible();

  const afterEditResponse = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(afterEditResponse, "list active tasks after edit");
  const afterEdit = ((await afterEditResponse.json()).tasks as SeededTask[]).find(
    (task) => task.id === beforeEdit!.id,
  );
  expect(afterEdit?.title).toBe(EDITED_COMPLETED_TITLE);
  expect(afterEdit?.version).toBeGreaterThan(beforeEdit!.version);

  await editedCard.scrollIntoViewIfNeeded();
  await editedCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "继续任务" }).click();
  await expect(page.locator(".board-column.status-in_progress").getByText(EDITED_COMPLETED_TITLE, { exact: true })).toBeVisible();

  const active = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(active, "list active tasks after continue");
  const moved = ((await active.json()).tasks as SeededTask[]).find((task) => task.id === beforeEdit!.id);
  expect(moved?.title).toBe(EDITED_COMPLETED_TITLE);
  expect(moved?.status).toBe("in_progress");
  expect(moved?.version).toBeGreaterThan(afterEdit!.version);
});

test("completed tasks can be archived and restored without losing their status", async ({ page, request }) => {
  await preparePage(page);
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);

  const completedCard = page.locator(".board-column.status-done .task-card").filter({
    hasText: COMPLETED_TITLE,
  });
  await completedCard.scrollIntoViewIfNeeded();
  await completedCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "归档议题" }).click();
  await expect(completedCard).toHaveCount(0);

  const archived = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=true`);
  await expectApiOk(archived, "list archived tasks after archive");
  const archivedTask = ((await archived.json()).tasks as Array<SeededTask & { archivedAt: string | null }>).find(
    (task) => task.title === COMPLETED_TITLE,
  );
  expect(archivedTask?.archivedAt).toBeTruthy();

  await page.getByRole("button", { name: "打开归档" }).click();
  const archivedCard = page.locator(".archived-task-card").filter({ hasText: COMPLETED_TITLE });
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole("button", { name: "恢复" }).click();
  await expect(archivedCard).toHaveCount(0);
  await expect(page.locator(".board-column.status-done").getByText(COMPLETED_TITLE, { exact: true })).toBeVisible();

  const restored = await request.get(`/api/tasks?projectId=${PROJECT_ID}&archived=false`);
  await expectApiOk(restored, "list active tasks after restore");
  const restoredTask = ((await restored.json()).tasks as SeededTask[]).find((task) => task.title === COMPLETED_TITLE);
  expect(restoredTask?.status).toBe("done");
  expect(restoredTask?.version).toBeGreaterThan(archivedTask?.version ?? 0);
});

test("Codex host theme changes without reload and retains filter, search, and open detail", async ({ page }) => {
  const frame = await mountCodexFrame(page);
  await postHostMessage(page, {
    type: "taskboard:host-context",
    payload: {
      theme: "light",
      language: "zh",
      threadId: PROGRESS_THREAD_ID,
      threadRunning: true,
      threadTodoProgress: { completed: 7, total: 10 },
    },
  });
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");

  await frame.getByRole("button", { name: "筛选议题" }).click();
  await frame.getByRole("menuitem", { name: "标签" }).click();
  await frame.getByRole("menuitemcheckbox", { name: /浏览器验收/ }).click();
  await frame.locator("body").press("Escape");
  await frame.getByRole("searchbox", { name: "搜索议题" }).fill("进度任务");
  await frame.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`).click();
  await expect(frame.getByRole("region", { name: /议题详情/ })).toBeVisible();
  const detailUrl = frame.url();

  expect(await themeAtNextPaintAfterHostMessage(
    page,
    frame,
    { type: "taskboard:theme", theme: "dark" },
  )).toBe("dark");
  await expect(frame.getByRole("region", { name: /议题详情/ })).toBeVisible();
  expect(frame.url()).toBe(detailUrl);

  await postHostMessage(page, { type: "taskboard:theme", theme: "sepia" });
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await themeAtNextPaintAfterHostMessage(
    page,
    frame,
    { type: "taskboard:theme", theme: "light" },
  )).toBe("light");
  await expect(frame.getByRole("region", { name: /议题详情/ })).toBeVisible();
  expect(frame.url()).toBe(detailUrl);
  await frame.getByRole("button", { name: "返回议题看板" }).click();
  await expect(frame.getByRole("searchbox", { name: "搜索议题" })).toHaveValue("进度任务");
  await expect(frame.getByRole("button", { name: /筛选议题，已启用 1 个条件/ })).toBeVisible();
});

test("real 7/10 progress is shared by the card and detail", async ({ page, request }) => {
  await preparePage(page);
  await page.emulateMedia({ colorScheme: "light" });
  await publishSevenOfTen(request);
  await page.goto(boardPath({ host: "workbuddy" }));
  await waitForBoard(page);

  const card = page.locator(`[data-task-id="${seed.progress.id}"]`);
  await expect(card.getByText("70%", { exact: true })).toBeVisible();
  await expect(card.getByText("验证中 · 剩余 3 步", { exact: true })).toBeVisible();
  await expect(card.locator("progress")).toHaveJSProperty("value", 7);
  await expect(card.locator("progress")).toHaveJSProperty("max", 10);

  await card.locator(".task-card-open").click();
  const detail = page.getByRole("region", { name: /议题详情/ });
  await expect(detail.getByText("70%", { exact: true })).toBeVisible();
  await expect(detail.getByText("验证中 · 剩余 3 步", { exact: true })).toBeVisible();
  await expect(detail.locator("progress")).toHaveJSProperty("value", 7);
  await expect(detail.locator("progress")).toHaveJSProperty("max", 10);
});

test("900px layout is operable without document-level horizontal overflow", async ({ page }) => {
  await preparePage(page);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(boardPath({ theme: "light" }));
  await waitForBoard(page);
  await expect(page.getByRole("searchbox", { name: "搜索议题" })).toBeEditable();
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
});

test("captures the required light and dark regression screenshots", async ({ page, request }) => {
  await preparePage(page);
  await page.emulateMedia({ colorScheme: "light" });
  await publishSevenOfTen(request);

  for (const width of [1728, 1440, 1280, 900]) {
    await page.setViewportSize({ width, height: width === 900 ? 900 : 960 });
    await publishSevenOfTen(request);
    await page.goto(boardPath({ host: "workbuddy" }));
    await waitForBoard(page);
    await expect(page.getByText("70%", { exact: true }).first()).toBeVisible();
    await screenshot(page, `board-light-${width}.png`);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await publishSevenOfTen(request);
  await page.goto(boardPath({ host: "workbuddy" }));
  await waitForBoard(page);
  await page.locator(`.task-card-open[aria-label*="${PROGRESS_TITLE}"]`).click();
  await expect(page.getByRole("region", { name: /议题详情/ }).getByText("70%", { exact: true })).toBeVisible();
  await screenshot(page, "task-progress-light-70.png");

  await page.getByRole("button", { name: "返回议题看板" }).click();
  await page.getByRole("button", { name: "自动化" }).click();
  await expect(page.getByRole("dialog", { name: "自动认领待办设置" })).toBeVisible();
  await screenshot(page, "automation-light.png");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "打开其他任务" }).click();
  await page.getByRole("tab", { name: /已归档/ }).click();
  await expect(page.getByText("已归档需求：自动收集内容", { exact: true })).toBeVisible();
  await screenshot(page, "archive-light.png");

  await page.emulateMedia({ colorScheme: "dark" });
  await publishSevenOfTen(request);
  await page.goto(boardPath({ host: "workbuddy" }));
  await waitForBoard(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot(page, "board-dark-regression-1440.png");
});
