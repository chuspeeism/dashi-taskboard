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
      #native-actions { height: 80px; }
      [data-app-action-sidebar-section] { margin-top: 20px; }
    </style>
  </head>
  <body>
    <aside>
      <nav role="navigation">
        <div data-app-action-sidebar-scroll>
          <div id="native-actions">
            <button><span>首页</span></button>
            <button><span>站点</span></button>
            <button id="new-native-action"><span>新建任务</span></button>
          </div>
          <section data-app-action-sidebar-section>
            <div data-app-action-sidebar-section-heading="项目">项目</div>
            <button id="project-named-plugins"><span>Plugins</span></button>
          </section>
        </div>
      </nav>
    </aside>
    <main><div data-app-shell-main-content-layout>Conversation</div></main>
    <output id="result"></output>
    <script>
      window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(`${origin}/taskboard?host=codex`)};
      window.__CODEX_TASKBOARD_SOURCE_HASH__ = "plugin-anchor-regression";
      window.__injectionError = null;
      window.addEventListener("error", (event) => {
        window.__injectionError = event.error?.stack || event.message;
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__injectionError = event.reason?.stack || String(event.reason);
      });
    </script>
    <script>eval(atob(${JSON.stringify(encodedSource)}));</script>
    <script>
      setTimeout(() => {
        const entry = document.getElementById("codex-taskboard-entry");
        document.getElementById("result").textContent = btoa(JSON.stringify({
          entryExists: Boolean(entry),
          entryFollowsNativeAction: document.getElementById("new-native-action").nextElementSibling === entry,
          entryFollowsProjectNamedPlugins: document.getElementById("project-named-plugins").nextElementSibling === entry,
          injectionError: window.__injectionError,
        }));
        window.__codexTaskboardInjection__?.destroy();
      }, 0);
    </script>
  </body>
</html>`;
}

test("a project named Plugins cannot become the Taskboard insertion anchor", async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(origin));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const profile = await mkdtemp(path.join(os.tmpdir(), "taskboard-plugin-anchor-chrome-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      "--virtual-time-budget=1000",
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

  const encodedResult = stdout.match(/<output id="result">([^<]+)<\/output>/)?.[1];
  assert.ok(encodedResult, "fixture did not report an injection result");
  const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
  assert.deepEqual(result, {
    entryExists: true,
    entryFollowsNativeAction: true,
    entryFollowsProjectNamedPlugins: false,
    injectionError: null,
  });
});
