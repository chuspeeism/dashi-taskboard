import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRef = process.env.TASKBOARD_INJECTION_SOURCE_REF;
const source = sourceRef
  ? (await execFileAsync(
      "git",
      ["show", `${sourceRef}:inject/codex-taskboard.user.js`],
      { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
    )).stdout
  : await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function fixtureHtml(origin) {
  const encodedSource = Buffer.from(source).toString("base64");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 1200px; height: 800px; margin: 0; }
      aside { position: absolute; width: 200px; height: 800px; }
      main { position: absolute; left: 200px; width: 1000px; height: 700px; }
      main > header { position: absolute; z-index: 2; width: 1000px; height: 48px; }
      #surface { width: 1000px; height: 700px; }
      [data-app-shell-main-content-layout] { position: absolute; width: 1000px; height: 700px; }
      #conversation { position: absolute; top: 48px; width: 1000px; height: 652px; }
      [data-browser-sidebar-webview] { position: absolute; right: 0; width: 320px; height: 700px; visibility: visible; }
    </style>
  </head>
  <body>
    <aside>
      <nav role="navigation">
        <div data-app-action-sidebar-scroll>
          <div>
            <button><span>首页</span></button>
            <button><span>站点</span></button>
            <button><svg></svg><span class="text-fade-truncate">插件</span></button>
          </div>
          <section data-app-action-sidebar-section>
            <div data-app-action-sidebar-section-heading="项目">项目</div>
          </section>
        </div>
      </nav>
    </aside>
    <main>
      <header>Codex header</header>
      <div id="surface">
        <div data-app-shell-main-content-layout>
          <div id="conversation">Conversation</div>
        </div>
      </div>
      <div data-browser-sidebar-webview>
        <webview
          data-browser-sidebar-conversation-id="conversation-1"
          data-browser-sidebar-browser-tab-id="browser-tab-1"
        ></webview>
      </div>
    </main>
    <output id="result"></output>
    <script>
      window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(`${origin}/taskboard?host=codex`)};
      window.__CODEX_TASKBOARD_SOURCE_HASH__ = "fullheight-regression";
      window.__browserPanelClosed = false;
      window.__injectionError = null;
      window.addEventListener("error", (event) => {
        window.__injectionError = event.error?.stack || event.message;
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__injectionError = event.reason?.stack || String(event.reason);
      });
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "toggle-browser-panel" || event.data.open !== false) return;
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        panel.style.visibility = "hidden";
        panel.hidden = true;
        const conversation = document.getElementById("conversation");
        conversation.style.top = "0";
        conversation.style.height = "700px";
        window.__browserPanelClosed = true;
      });
    </script>
    <script>eval(atob(${JSON.stringify(encodedSource)}));</script>
    <script>
      (async () => {
        const entry = document.getElementById("codex-taskboard-entry");
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        const panelVisibleBefore = getComputedStyle(panel).visibility !== "hidden";
        entry?.click();

        for (let attempt = 0; attempt < 150; attempt += 1) {
          const frame = document.getElementById("codex-taskboard-frame");
          if (frame && frame.hidden === false) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));

        const page = document.getElementById("codex-taskboard-page");
        const frame = document.getElementById("codex-taskboard-frame");
        const surface = document.getElementById("surface");
        const conversation = document.getElementById("conversation");
        const result = {
          panelVisibleBefore,
          browserPanelClosed: window.__browserPanelClosed,
          conversationTop: conversation.getBoundingClientRect().top,
          pageMounted: page?.parentElement === surface,
          pageVisible: Boolean(page && !page.hidden && getComputedStyle(page).display !== "none"),
          frameMounted: frame?.parentElement === page,
          frameVisible: Boolean(frame && !frame.hidden && getComputedStyle(frame).display !== "none"),
          injectionError: window.__injectionError,
        };
        document.getElementById("result").textContent = btoa(JSON.stringify(result));
        window.__codexTaskboardInjection__?.destroy();
      })();
    </script>
  </body>
</html>`;
}

test("Taskboard stays visible when closing the browser panel makes the conversation full height", async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((request, response) => {
    response.setHeader("connection", "close");
    if (request.url?.startsWith("/taskboard")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><script>parent.postMessage({ type: "taskboard:ready" }, location.origin)</script>`);
      return;
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(origin));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const profile = await mkdtemp(path.join(os.tmpdir(), "taskboard-fullheight-chrome-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=4000",
      "--dump-dom",
      url,
    ], { maxBuffer: 5 * 1024 * 1024, timeout: 10_000 }));
  } catch (error) {
    if (!String(error?.stdout ?? "").trim()) {
      t.skip("Chrome or Chromium cannot run headless dump-dom in this environment");
      return;
    }
    throw error;
  }
  if (!stdout.trim()) {
    t.skip("Chrome or Chromium cannot run headless dump-dom in this environment");
    return;
  }

  const encodedResult = stdout.match(/<output id="result">([^<]+)<\/output>/)?.[1];
  assert.ok(encodedResult, "fixture did not report an injection result");
  const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
  assert.deepEqual(result, {
    panelVisibleBefore: true,
    browserPanelClosed: true,
    conversationTop: 0,
    pageMounted: true,
    pageVisible: true,
    frameMounted: true,
    frameVisible: true,
    injectionError: null,
  });
});
