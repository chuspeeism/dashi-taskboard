import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  chromeFixtureSkipReason,
  runChromeFixture,
} from "./support/chrome-fixture-policy.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const GLASS_KEYS = [
  "appNav",
  "workspaceHeader",
  "boardToolbar",
  "headerProjectMenu",
  "projectAutomationMenu",
  "taskFilterMenu",
  "taskFilterSubmenu",
  "taskContextMenu",
  "contextSubmenu",
  "labelPopover",
  "issueRelationPopover",
  "commentActionMenu",
];

const CONTENT_KEYS = [
  "taskCard",
  "issueDetail",
  "boardColumn",
  "taskDialog",
  "automationRow",
  "archiveRow",
];

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function fixture(theme) {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <nav class="app-nav" data-material="appNav"></nav>
    <header class="workspace-header" data-material="workspaceHeader"></header>
    <section class="board-toolbar" data-material="boardToolbar"></section>
    <div class="header-project-menu" data-material="headerProjectMenu"></div>
    <div class="project-automation-menu" data-material="projectAutomationMenu"></div>
    <div class="task-filter-menu" data-material="taskFilterMenu"></div>
    <div class="task-filter-submenu" data-material="taskFilterSubmenu"></div>
    <div class="task-context-menu" data-material="taskContextMenu"></div>
    <div class="context-submenu" data-material="contextSubmenu"></div>
    <div class="composer-popover label-popover" data-material="labelPopover"></div>
    <div class="issue-relation-popover" data-material="issueRelationPopover"></div>
    <div class="comment-action-menu" data-material="commentActionMenu"></div>

    <article class="task-card" data-material="taskCard"></article>
    <main class="issue-detail" data-material="issueDetail"></main>
    <section class="board-column" data-material="boardColumn"></section>
    <div class="task-dialog" data-material="taskDialog"></div>
    <div class="project-automation-quota" data-material="automationRow"></div>
    <article class="task-card archived-task-card" data-material="archiveRow"></article>

    <script>
      const normalizeBackdrop = (styles) =>
        styles.backdropFilter || styles.webkitBackdropFilter || "none";
      const snapshot = (element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.backgroundColor,
          backdrop: normalizeBackdrop(styles),
          boxShadow: styles.boxShadow,
          transitionDuration: styles.transitionDuration,
          animationDuration: styles.animationDuration,
        };
      };
      const root = getComputedStyle(document.documentElement);
      const materials = Object.fromEntries(
        [...document.querySelectorAll("[data-material]")]
          .map((element) => [element.dataset.material, snapshot(element)]),
      );
      document.body.dataset.result = encodeURIComponent(JSON.stringify({
        accent: root.getPropertyValue("--accent").trim(),
        contentSurface: root.getPropertyValue("--content-surface").trim(),
        colorScheme: root.colorScheme,
        fontFamily: root.fontFamily,
        media: {
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
        },
        materials,
      }));
    </script>
  </body>
</html>`;
}

function decodeResult(stdout) {
  const match = stdout.match(/data-result="([^"]+)"/);
  assert.ok(match, "Chrome did not emit the computed material snapshot");
  return JSON.parse(decodeURIComponent(match[1]));
}

function dumpDomUntilSnapshot(executable, arguments_, options = {}) {
  const { maxBuffer = 2_000_000, timeout = 30_000 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer;

    const hasCompleteSnapshot = () => /data-result="[^"]+"/.test(stdout);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(stdout);
    };
    const terminateAfterSnapshot = () => {
      if (child.exitCode !== null) {
        finish();
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
    };
    const timeoutTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Chrome did not emit a computed material snapshot within ${timeout}ms\n${stderr}`));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(new Error(`Chrome DOM output exceeded ${maxBuffer} bytes`));
        return;
      }
      if (hasCompleteSnapshot()) terminateAfterSnapshot();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (hasCompleteSnapshot()) {
        finish();
        return;
      }
      setImmediate(() => {
        if (hasCompleteSnapshot()) finish();
        else finish(new Error(`Chrome exited before emitting a computed material snapshot (code ${code}, signal ${signal})\n${stderr}`));
      });
    });
  });
}

function assertNavigationGlass(snapshot, label) {
  assert.match(snapshot.backdrop, /blur\(18px\)/, `${label} must use the restrained navigation blur`);
  assert.equal(snapshot.boxShadow, "none", `${label} must not use a shadow`);
}

function assertSolidContent(snapshot, label) {
  assert.equal(snapshot.backdrop, "none", `${label} must not use backdrop blur`);
  assert.match(snapshot.background, /^rgb\(/, `${label} must use an opaque content surface`);
}

function cssTimesInMilliseconds(value) {
  return value.split(",").map((part) => {
    const duration = part.trim();
    if (duration.endsWith("ms")) return Number.parseFloat(duration);
    if (duration.endsWith("s")) return Number.parseFloat(duration) * 1000;
    return Number.NaN;
  });
}

test("Scheme A limits glass to navigation controls and keeps task content solid in light and dark", async (t) => {
  const chrome = chromeExecutable();
  const skipReason = chromeFixtureSkipReason(chrome);
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const styles = await readFile(path.join(projectRoot, "web/src/styles.css"), "utf8");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/styles.css") {
      response.setHeader("content-type", "text/css; charset=utf-8");
      response.end(styles);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixture(url.searchParams.get("theme") === "dark" ? "dark" : "light"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const profiles = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(profiles.map((profile) => rm(profile, { recursive: true, force: true })));
  });

  const capture = async (theme, extraArguments = []) => {
    const profile = await mkdtemp(path.join(os.tmpdir(), `taskboard-materials-${theme}-`));
    profiles.push(profile);
    const stdout = await runChromeFixture(chrome, (executable) => dumpDomUntilSnapshot(executable, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      `--user-data-dir=${profile}`,
      ...extraArguments,
      "--dump-dom",
      `http://127.0.0.1:${address.port}/fixture?theme=${theme}`,
    ], { maxBuffer: 2_000_000, timeout: 30_000 }));
    return decodeResult(stdout);
  };

  const light = await capture("light");
  assert.equal(light.colorScheme, "light");
  assert.equal(light.accent, "#0a84ff");
  assert.equal(light.contentSurface, "#ffffff");
  assert.match(light.fontFamily, /SF Pro Text/);
  assert.equal(light.materials.taskCard.background, "rgb(255, 255, 255)");
  for (const key of GLASS_KEYS) assertNavigationGlass(light.materials[key], key);
  for (const key of CONTENT_KEYS) assertSolidContent(light.materials[key], key);

  const dark = await capture("dark");
  assert.equal(dark.colorScheme, "dark");
  assert.notEqual(dark.accent, "");
  for (const key of GLASS_KEYS) assertNavigationGlass(dark.materials[key], key);
  for (const key of CONTENT_KEYS) assertSolidContent(dark.materials[key], key);

  const reduced = await capture("light", [
    "--force-prefers-reduced-motion",
    "--force-prefers-reduced-transparency",
  ]);
  assert.equal(reduced.media.reducedMotion, true, "Chromium must expose reduced-motion emulation");
  for (const duration of cssTimesInMilliseconds(reduced.materials.taskCard.transitionDuration)) {
    assert.ok(duration <= 0.01, `reduced motion must cap transitions at 0.01ms, received ${duration}ms`);
  }
  if (reduced.media.reducedTransparency) {
    for (const key of GLASS_KEYS) {
      assert.equal(reduced.materials[key].backdrop, "none", `${key} must disable blur under reduced transparency`);
      assert.match(reduced.materials[key].background, /^rgb\(/, `${key} must become opaque under reduced transparency`);
    }
  } else {
    t.diagnostic("Chromium does not expose prefers-reduced-transparency emulation; transparency assertions skipped");
  }
});
