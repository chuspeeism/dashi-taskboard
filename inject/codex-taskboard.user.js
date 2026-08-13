(() => {
  "use strict";

  const VERSION = "0.6.13";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823/?host=codex";
  const ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-taskboard-native-selected";
  const HOST_REQUEST_MESSAGE = "__codexTaskboardHostRequestV1";
  const HOST_RESPONSE_MESSAGE = "__codexTaskboardHostResponseV1";
  const HOST_HEARTBEAT_MESSAGE = "__codexTaskboardHostHeartbeatV1";
  const HOST_STARTUP_TOKEN_NAME = "__codexTaskboardHostStartupTokenV1";
  const HOST_CAPABILITY = window.__CODEX_TASKBOARD_HOST_CAPABILITY__;
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "新对话",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let taskboardOrigin = "";
  let frameTaskboardUrl = "";
  let frameCapability = "";
  let frameChallenge = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let hostHeartbeatAt = 0;
  let observer = null;
  let reattachTimer = null;
  let hostContextTimer = null;
  let hostUiLanguage = null;
  let entryLabel = null;
  let statusView = "idle";
  let loadError = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let mutedNativeSelections = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let lastNativeThreadId = "";
  let lastNativeProjectId = "";
  let suspendedNativeBrowserPanel = null;
  let active = false;
  let destroyed = false;

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function hostLanguage() {
    return document.documentElement.lang || navigator.language;
  }

  function resolvedHostLanguage() {
    const language = hostLanguage().trim().replaceAll("_", "-").toLowerCase();
    return language === "zh" || language.startsWith("zh-") ? "zh" : "en";
  }

  function hostText(chinese, english) {
    return resolvedHostLanguage() === "zh" ? chinese : english;
  }

  function hostError(chinese, english) {
    const error = new Error(hostText(chinese, english));
    error.taskboardText = { chinese, english };
    return error;
  }

  function hostErrorText(error) {
    if (error?.taskboardText) {
      return hostText(error.taskboardText.chinese, error.taskboardText.english);
    }
    return error instanceof Error ? error.message : String(error || "");
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL__ === "string"
      ? window.__CODEX_TASKBOARD_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported taskboard URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function isLocalTaskboardOrigin(origin) {
    try {
      const { protocol, hostname } = new URL(origin);
      return (protocol === "http:" || protocol === "https:")
        && (hostname === "127.0.0.1" || hostname === "localhost");
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin && plugin.parentElement) {
      const siblings = Array.from(plugin.parentElement.children).filter((child) => child.tagName === "BUTTON");
      if (siblings.length >= 3) return plugin;
    }

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
      <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
    `;
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    entryLabel = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    syncEntryText(button);
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskboard();
    });
    return button;
  }

  function syncEntryText(button = entry) {
    if (!button) return;
    button.setAttribute("aria-label", hostText("打开任务面板", "Open Taskboard"));
    button.setAttribute("title", hostText("任务面板", "Taskboard"));
    if (entryLabel) entryLabel.textContent = hostText("任务面板", "Taskboard");
    else button.textContent = hostText("任务面板", "Taskboard");
  }

  function syncEntryState() {
    if (!entry) return;
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    syncEntryState();
  }

  function findPageHost() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) return direct;

    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    return Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7;
    }) || null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (!frameHost || !viewport || !surface || !surface.closest("main")) return null;
    return { frameHost, surface };
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  async function selectedNativeProjectId() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const selectedProject = bootstrap?.globalStateEntries
      ?.find((entry) => entry.key === "selected-project")?.value;
    return typeof selectedProject?.projectId === "string" ? selectedProject.projectId : "";
  }

  function readCodexProjects() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    const todoProgress = nativeTodoProgress();
    const selectedProjectId = await selectedNativeProjectId();
    if (selectedProjectId) lastNativeProjectId = selectedProjectId;
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = readHostContext(projects, lastNativeProjectId);
    if (context.threadRunning && todoProgress) context.threadTodoProgress = todoProgress;
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function sidebarThreadRow(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedThreadId) || null;
  }

  function nativeRunningThreadRow(preferredThreadId, preferredProjectId) {
    const rows = Array.from(document.querySelectorAll(".sidebar-item .animate-spin"))
      .map((spinner) => spinner.closest("[data-app-action-sidebar-thread-id]"))
      .filter(Boolean);
    const normalizedPreferredThreadId = normalizeThreadId(preferredThreadId);
    if (normalizedPreferredThreadId) {
      return rows.find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedPreferredThreadId) || null;
    }
    if (preferredProjectId) {
      const projectRows = rows.filter((candidate) => (
        candidate.closest("[data-app-action-sidebar-project-list-id]")
          ?.getAttribute("data-app-action-sidebar-project-list-id") === preferredProjectId
      ));
      if (projectRows.length === 1) return projectRows[0];
    }
    return rows.length === 1 ? rows[0] : null;
  }

  function nativeThreadRunning(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const threadRow = sidebarThreadRow(normalizedThreadId);
    if (threadRow?.querySelector(".animate-spin")) return true;
    const running = Array.from(document.querySelectorAll("button[aria-label]")).some((button) => {
      const label = normalizedLabel(button.getAttribute("aria-label"));
      return ["停止", "停止生成", "stop", "stop generating"].includes(label);
    });
    const activeThreadId = normalizeThreadId(
      activeThreadRow()?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    if (running && (!normalizedThreadId || activeThreadId === normalizedThreadId)) return true;
    if (threadRow) return false;
    const composer = document.querySelector(
      "[contenteditable='true'][role='textbox'], textarea",
    );
    return composer ? false : undefined;
  }

  function nativeTodoProgress() {
    const indicator = Array.from(
      document.querySelectorAll('[data-in-progress-fixed-content="true"]'),
    ).at(-1);
    const label = Array.from(indicator?.querySelectorAll("span") ?? [])
      .map((element) => element.textContent?.trim() ?? "")
      .find((text) => /\d+\s*\/\s*\d+/.test(text));
    const match = label?.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    return {
      completed: Math.max(0, Math.min(total, current - 1)),
      total,
    };
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function readCodexUser() {
    const avatar = Array.from(document.querySelectorAll("img"))
      .find((image) => image.src.includes("cdn.auth0.com/avatars/"));
    const profileButton = avatar?.closest("button")
      || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
        normalizedLabel(button.getAttribute("aria-label")).includes("profile")
        || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
      ));
    const name = profileButton?.textContent?.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const avatarUrl = avatar?.currentSrc || avatar?.src || null;
    return {
      type: "user",
      id: userIdFromName(name),
      name,
      avatarUrl,
    };
  }

  function readHostContext(projects = readCodexProjects(), preferredProjectId = lastNativeProjectId) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || preferredProjectId
      || "";
    const preferredThreadId = activeThreadId || lastNativeThreadId;
    const runningThreadId = normalizeThreadId(
      nativeRunningThreadRow(preferredThreadId, projectId)
        ?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    const currentThreadId = activeThreadId || runningThreadId || lastNativeThreadId;
    if (activeThreadId || (!lastNativeThreadId && runningThreadId)) {
      lastNativeThreadId = currentThreadId;
    }
    const threadId = currentThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const workspacePath = workspaceFromLocation();
    const threadRunning = nativeThreadRunning(threadId);
    const payload = {
      language: hostLanguage(),
      theme: currentTheme(),
      projects,
      user: readCodexUser() ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (threadRunning !== undefined) payload.threadRunning = threadRunning;
    if (threadRunning) {
      const todoProgress = nativeTodoProgress();
      if (todoProgress) payload.threadTodoProgress = todoProgress;
    }
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message, allowUnready = false) {
    if (!frame?.contentWindow || !frameOrigin || (!allowUnready && !frameReady)) return;
    frame.contentWindow.postMessage(message, frameOrigin === "null" ? "*" : frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postFrameChallenge() {
    if (!frameChallenge) return;
    postToFrame({
      type: "taskboard:frame-challenge",
      payload: { challenge: frameChallenge },
    }, true);
  }

  function postHostContext() {
    syncHostUiLanguage();
    if (!frame) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  async function openThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closeTaskboard(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  function projectRowByLabel(label) {
    if (typeof label !== "string" || !label.trim()) return null;
    const expected = normalizedLabel(label);
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => normalizedLabel(row.getAttribute("data-app-action-sidebar-project-label")) === expected) || null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForPreparedComposer(identifier) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[data-codex-composer="true"][contenteditable="true"]');
      if (editor && editor.getClientRects().length > 0) {
        const containsIdentifier = normalizedLabel(editor.textContent).includes(normalizedLabel(identifier));
        if (containsIdentifier) return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error(hostText(
      "Codex 对话输入框没有写入任务编号",
      "The issue identifier was not written to the Codex composer",
    ));
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !instruction
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error(hostText(
          "当前 Codex 版本没有提供原生对话导航能力",
          "This Codex version does not provide native conversation navigation",
        ));
      }

      if (workspacePath) {
        await bridge.sendMessageFromView({
          type: "electron-set-active-workspace-root",
          root: workspacePath,
        });
      } else {
        await ensureProjectRows();
        const snapshotProjectId = hostContextSnapshot?.projectId || "";
        const requestedProjectId = typeof payload.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const row = projectRowByLabel(payload.workspaceLabel)
          || projectRowById(requestedProjectId)
          || projectRowById(snapshotProjectId)
          || projectRowByLabel(payload.projectName);
        if (row?.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
          row.click?.();
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const selectProject = row?.querySelector("[data-app-action-sidebar-select-project]");
        selectProject?.click?.();
        if (selectProject) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }

      closeTaskboard(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
        },
      });
      await requestHostTaskComposerPrefill({ instruction });
      await waitForPreparedComposer(identifier);
      postToFrame({ type: "taskboard:thread-prepared", payload: { taskId } });
    } catch (error) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: {
          taskId,
          error: error instanceof Error
            ? error.message
            : hostText("无法创建 Codex 对话", "Could not create the Codex conversation"),
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (!isLocalTaskboardOrigin(taskboardOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: hostText("仅本地任务面板可用", "Available only in the local Taskboard"),
        },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error
            ? error.message
            : hostText("Codex 自动任务操作失败", "The Codex automation operation failed"),
        },
      });
    }
  }

  function handleExternalOpen(payload) {
    try {
      const url = new URL(payload?.url);
      if (url.protocol !== "https:") return;
      void requestHost("open-external", { url: url.href }).catch(() => {});
    } catch (_) {}
  }

  async function handleAttachmentOpen(payload) {
    try {
      await requestHost("open-attachment", {
        attachmentId: payload?.attachmentId,
        filename: payload?.filename,
      });
    } catch (_) {
      postToFrame({
        type: "taskboard:attachment-open-error",
        payload: {
          error: hostText(
            "无法在 Finder 中显示附件，请重试。",
            "Could not reveal the attachment in Finder. Try again.",
          ),
        },
      });
    }
  }

  function challengeFrameDocument(event) {
    if (!frame || event.currentTarget !== frame) return;
    frameReady = false;
    frameChallenge = crypto.randomUUID();
    if (active) showLoading();
    postFrameChallenge();
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (
      !message
      || typeof message !== "object"
      || !frameCapability
      || message.capability !== frameCapability
    ) return;
    if (message.type === "taskboard:frame-awaiting-challenge") {
      postFrameChallenge();
      return;
    }
    if (!frameChallenge || message.challenge !== frameChallenge) return;
    if (message.type === "taskboard:ready") {
      if (frameReady) return;
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active) showFrame();
      postHostContext();
      return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload?.threadId);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskboard:open-external") {
      handleExternalOpen(message.payload);
      return;
    }
    if (message.type === "taskboard:open-attachment") {
      void handleAttachmentOpen(message.payload);
      return;
    }
    if (message.type === "taskboard:create-thread") void createThreadForTask(message.payload);
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", hostText("任务面板", "Taskboard"));

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    statusView = "loading";
    loadError = null;
    renderLoading();
  }

  function renderLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode(hostText("正在启动任务面板…", "Starting Taskboard…")));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    statusView = "frame";
    loadError = null;
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(error) {
    statusView = "error";
    loadError = error;
    renderLoadError();
  }

  function renderLoadError() {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = hostErrorText(loadError);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = hostText("重新加载面板", "Reload panel");
    retry.addEventListener("click", openTaskboard, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function syncHostUiLanguage() {
    const language = resolvedHostLanguage();
    if (hostUiLanguage === language) return;
    hostUiLanguage = language;
    syncEntryText();
    if (page) page.setAttribute("aria-label", hostText("任务面板", "Taskboard"));
    if (frame) frame.title = hostText("任务面板", "Taskboard");
    if (statusView === "loading") renderLoading();
    else if (statusView === "error") renderLoadError();
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(hostError("任务面板页面加载超时", "Taskboard page load timed out"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadTaskboardFrame(cacheBust = false) {
    cancelFrameReadyWaiters(hostError("任务面板正在重新加载", "Taskboard is reloading"));
    frame?.remove();
    frame = null;
    frameTaskboardUrl = "";
    frameCapability = "";
    frameChallenge = "";
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const taskboardUrl = resolveTaskboardUrl();
    if (cacheBust) {
      taskboardUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    taskboardOrigin = taskboardUrl.origin;
    frameTaskboardUrl = taskboardUrl.href;
    frameOrigin = "null";
    const frameName = `codex-taskboard-${crypto.randomUUID()}`;
    frameCapability = crypto.randomUUID();
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.name = frameName;
    nextFrame.hidden = true;
    nextFrame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
    nextFrame.src = "about:blank";
    nextFrame.title = hostText("任务面板", "Taskboard");
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", challengeFrameDocument);
    frame = nextFrame;
    page.appendChild(nextFrame);
    return { frameName, frameCapability };
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (active) showLoading();
    const frameRequest = loadTaskboardFrame(true);
    void requestHostLoadFrame(frameRequest)
      .then(() => waitForFrameReady())
      .then(() => {
          if (!active || generation !== openGeneration) return;
          showFrame();
          postHostContext();
      })
      .catch((error) => {
        if (!active || generation !== openGeneration) return;
        showLoadError(error);
      });
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
      : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    return typeof HOST_CAPABILITY === "string"
      && HOST_CAPABILITY.length > 0
      && Number.isFinite(hostHeartbeatAt)
      && Date.now() - hostHeartbeatAt <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}) {
    if (!hasLiveHostBinding()) {
      return Promise.reject(hostError(
        "Taskboard 启动器未运行，无法操作 Codex 对话输入框",
        "The Taskboard launcher is not running, so the Codex composer is unavailable",
      ));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        hostRequests.delete(id);
        reject(hostError("任务面板启动器没有响应", "The Taskboard launcher did not respond"));
      }, HOST_REQUEST_TIMEOUT_MS);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        window.postMessage({
          type: HOST_REQUEST_MESSAGE,
          capability: HOST_CAPABILITY,
          payload: { ...payload, id, action },
        }, window.location.origin);
      } catch (error) {
        window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostLoadFrame({ frameName, frameCapability: capability }) {
    return requestHost("load-frame", { frameName, frameCapability: capability });
  }

  function requestHostTaskComposerPrefill({ instruction }) {
    return requestHost("prefill-task-composer", {
      instruction,
    });
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    if (!frame || !frameTaskboardUrl) return false;
    try {
      const loadedUrl = new URL(frameTaskboardUrl);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(taskboardUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(response.error
      ? new Error(response.error)
      : hostError("任务面板服务启动失败", "The Taskboard service failed to start"));
  }

  function onHostBridgeMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.capability !== HOST_CAPABILITY) return;
    if (message.type === HOST_HEARTBEAT_MESSAGE) {
      hostHeartbeatAt = Number(message.at) || 0;
      window[HOST_STARTUP_TOKEN_NAME] = message.startupToken ?? null;
      return;
    }
    if (message.type === HOST_RESPONSE_MESSAGE) onHostResponse(message.response);
  }

  async function prepareTaskboard(generation) {
    const taskboardUrl = resolveTaskboardUrl();
    const canReuseFrame = Boolean(
      frameReady
      && frame?.isConnected
      && frameMatchesTaskboardUrl(taskboardUrl),
    );
    if (canReuseFrame) showFrame();
    else showLoading();

    try {
      const [result, context] = await Promise.all([
        requestHostEnsure(taskboardUrl),
        captureHostContext(),
      ]);
      if (!active || generation !== openGeneration) return;
      hostContextSnapshot = {
        ...hostContextSnapshot,
        ...context,
        projects: context.projects.length > 0
          ? context.projects
          : hostContextSnapshot?.projects ?? [],
      };
      if (!frameReady || result.restarted || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        const frameRequest = loadTaskboardFrame();
        await requestHostLoadFrame(frameRequest);
        await waitForFrameReady();
      }
      if (!active || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error
        : hostError(
          "任务面板服务未就绪。请保持 Taskboard 启动器运行后重试。",
          "The Taskboard service is not ready. Keep the Taskboard launcher running and try again.",
        ));
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function closeNativeBrowserPanel() {
    if (suspendedNativeBrowserPanel) return;
    const browserPanel = Array.from(
      document.querySelectorAll("[data-browser-sidebar-webview]"),
    ).find((node) => window.getComputedStyle(node).visibility !== "hidden");
    if (!browserPanel) return;
    const webview = browserPanel.querySelector("webview");
    suspendedNativeBrowserPanel = {
      conversationId: webview?.getAttribute("data-browser-sidebar-conversation-id") || null,
      browserTabId: webview?.getAttribute("data-browser-sidebar-browser-tab-id") || null,
    };
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "toggle-browser-panel",
        open: false,
        source: "manual",
        initiator: "taskboard_open",
      },
    }));
  }

  function restoreNativeBrowserPanel() {
    const browserPanel = suspendedNativeBrowserPanel;
    suspendedNativeBrowserPanel = null;
    if (!browserPanel) return;
    const data = {
      type: "toggle-browser-panel",
      open: true,
      source: "manual",
      initiator: "taskboard_close",
    };
    if (browserPanel.conversationId) data.conversationId = browserPanel.conversationId;
    if (browserPanel.browserTabId) data.browserTabId = browserPanel.browserTabId;
    window.dispatchEvent(new MessageEvent("message", { data }));
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return;
    const { surface } = mount;

    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeBrowserPanel();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function openTaskboard() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = readHostContext();
    }
    const generation = ++openGeneration;
    active = true;
    closeNativeBrowserPanel();
    ensureEntry();
    mountActivePage();
    syncEntryState();
    void prepareTaskboard(generation);
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    closeTaskboard(false);
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      mountActivePage();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
      ],
    });
    hostContextTimer = window.setInterval(postHostContext, 1_000);
    postHostContext();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    if (hostContextTimer !== null) window.clearInterval(hostContextTimer);
    hostContextTimer = null;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(hostError("任务面板已关闭", "Taskboard was closed"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(hostError("任务面板已关闭", "Taskboard was closed"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("message", onHostBridgeMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    entryLabel = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    taskboardOrigin = "";
    frameTaskboardUrl = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    get ready() {
      return frameReady;
    },
    refresh,
    reloadFrame,
    open: openTaskboard,
    close: closeTaskboard,
    destroy,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("message", onHostBridgeMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
