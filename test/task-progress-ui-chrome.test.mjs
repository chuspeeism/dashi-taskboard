import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { build } from "vite";

import { CdpPipeBrowser } from "../scripts/codex-cdp-pipe.mjs";
import { chromeFixtureSkipReason, runChromeFixture } from "./support/chrome-fixture-policy.mjs";
import {
  chromeMaterialArguments,
  chromeMaterialSpawnOptions,
  closeOwnedChrome,
  waitForMaterialSnapshot,
} from "./support/chrome-material-fixture.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = path.join(projectRoot, "test/fixtures/task-progress-ui");

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

async function contentType(filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function assertProgress(progress, expected, location) {
  assert.equal(progress.value, expected.completed, `${location} must expose the real completed count`);
  assert.equal(progress.max, expected.total, `${location} must expose the real total count`);
  assert.match(progress.text, expected.percent, `${location} must expose the percentage as visible text`);
  assert.match(
    progress.text,
    expected.activity,
    `${location} must expose the localized activity phase`,
  );
  assert.match(progress.text, expected.remaining, `${location} must expose the localized remaining steps`);
  assert.match(progress.accessibleLabel ?? "", expected.percent, `${location} must expose the percentage to assistive technology`);
  assert.doesNotMatch(
    progress.text,
    /\b\d+(?:m|h)(?:\d+[ms])?\b|分钟|小时/i,
    `${location} progress summary must not invent a time ETA`,
  );
  assert.doesNotMatch(
    progress.accessibleLabel ?? "",
    /\b\d+(?:m|h)(?:\d+[ms])?\b|分钟|小时/i,
    `${location} accessible progress summary must not invent a time ETA`,
  );
  assert.notEqual(progress.trackBackground, "rgba(0, 0, 0, 0)", `${location} must use a solid progress track`);
}

function countOccurrences(value, phrase) {
  return value.split(phrase).length - 1;
}

test("real presentation paths keep host progress, selected detail progress, elapsed time and pause copy truthful", async (t) => {
  const chrome = chromeExecutable();
  const skipReason = chromeFixtureSkipReason(chrome);
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const buildDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-progress-react-build-"));
  const profiles = [];
  await build({
    root: fixtureRoot,
    configFile: false,
    logLevel: "silent",
    base: "/",
    plugins: [react()],
    build: { outDir: buildDirectory, emptyOutDir: true },
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.endsWith("/comments")) {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ comments: [] }));
        return;
      }
      if (url.pathname.endsWith("/activities")) {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ activities: [] }));
        return;
      }
      if (url.pathname.endsWith("/attachments")) {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ attachments: [] }));
        return;
      }
      const relative = url.pathname === "/fixture" || url.pathname === "/"
        ? "index.html"
        : url.pathname.replace(/^\/+/, "");
      const filename = path.resolve(buildDirectory, relative);
      if (filename !== buildDirectory && !filename.startsWith(`${buildDirectory}${path.sep}`)) {
        response.writeHead(400).end();
        return;
      }
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("not a file");
      response.setHeader("content-type", await contentType(filename));
      response.end(await readFile(filename));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(profiles.map((profile) => rm(profile, { recursive: true, force: true })));
    await rm(buildDirectory, { recursive: true, force: true });
  });

  const capture = async (theme, language) => {
    const profile = await mkdtemp(path.join(os.tmpdir(), `taskboard-progress-${theme}-${language}-`));
    profiles.push(profile);
    return runChromeFixture(chrome, async (executable) => {
      const url = `http://127.0.0.1:${address.port}/fixture?theme=${theme}&language=${language}`;
      const child = spawn(
        executable,
        chromeMaterialArguments({ profile, url }),
        chromeMaterialSpawnOptions(),
      );
      const browser = new CdpPipeBrowser(child);
      let session;
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });

      try {
        await browser.open();
        const { targetId } = await browser.send("Target.createTarget", { url });
        session = await browser.connect(targetId);
        await session.send("Runtime.enable");
        return await waitForMaterialSnapshot(session);
      } catch (error) {
        const diagnostic = stderr.trim() ? `\nChrome stderr:\n${stderr.trim()}` : "";
        throw new Error(`${error.message}${diagnostic}`, { cause: error });
      } finally {
        session?.close();
        await closeOwnedChrome(browser, child);
      }
    });
  };

  for (const scenario of [
    {
      theme: "light",
      language: "zh",
      labels: {
        phase: /验证中/,
        remaining: /剩余 3 步/,
        paused: /已暂停/,
        pausedText: "已暂停",
        finishing: /收尾中/,
        oneRemaining: /剩余 1 步/,
        elapsed: /已处理 1m15s/,
      },
    },
    {
      theme: "dark",
      language: "en",
      labels: {
        phase: /Verifying/,
        remaining: /3 steps remaining/,
        paused: /Paused/,
        pausedText: "Paused",
        finishing: /Finishing/,
        oneRemaining: /1 step remaining/,
        elapsed: /Processing for 1m15s/,
      },
    },
  ]) {
    const result = await capture(scenario.theme, scenario.language);
    assert.equal(result.theme, scenario.theme);
    assert.equal(result.language, scenario.language);
    for (const [location, progress, expected] of [
      ["host-driven running card", result.runningCard, {
        completed: 7,
        total: 10,
        percent: /70%/,
        activity: scenario.labels.phase,
        remaining: scenario.labels.remaining,
      }],
      ["selected task detail", result.runningDetail, {
        completed: 7,
        total: 10,
        percent: /70%/,
        activity: scenario.labels.phase,
        remaining: scenario.labels.remaining,
      }],
      ["AI-thread boundary card", result.boundaryCard, {
        completed: 199,
        total: 200,
        percent: /99%/,
        activity: scenario.labels.finishing,
        remaining: scenario.labels.oneRemaining,
      }],
      ["paused host card", result.pausedCard, {
        completed: 7,
        total: 10,
        percent: /70%/,
        activity: scenario.labels.paused,
        remaining: scenario.labels.remaining,
      }],
      ["paused selected detail", result.pausedDetail, {
        completed: 7,
        total: 10,
        percent: /70%/,
        activity: scenario.labels.paused,
        remaining: scenario.labels.remaining,
      }],
    ]) {
      assertProgress(progress, expected, `${scenario.theme} ${location}`);
      assert.equal(progress.accentColor, result.accent, `${scenario.theme} ${location} must use Apple blue`);
    }
    assert.notEqual(result.runningDetail.value, result.boundaryCard.value, "detail must use the selected task presentation");
    assert.match(result.boundaryCardText, scenario.labels.elapsed);
    assert.equal(countOccurrences(result.pausedCardText, scenario.labels.pausedText), 1, "card must expose Paused once");
    assert.equal(countOccurrences(result.pausedDetailText, scenario.labels.pausedText), 1, "detail must expose Paused once");
  }
});
