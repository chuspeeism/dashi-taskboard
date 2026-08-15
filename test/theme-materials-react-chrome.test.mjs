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
import {
  chromeFixtureSkipReason,
  runChromeFixture,
} from "./support/chrome-fixture-policy.mjs";
import {
  chromeMaterialArguments,
  chromeMaterialSpawnOptions,
  closeOwnedChrome,
  waitForMaterialSnapshot,
} from "./support/chrome-material-fixture.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = path.join(projectRoot, "test/fixtures/theme-materials-react");

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

function assertSolid(snapshot, label) {
  assert.equal(snapshot.backdrop, "none", `${label} must not use backdrop blur`);
  assert.match(snapshot.background, /^rgb\(/, `${label} must use an opaque surface`);
}

function colorLuminance(value) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `Expected a computed RGB color, received ${value}`);
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function computedContrast(left, right) {
  const values = [colorLuminance(left), colorLuminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function contentType(filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

test("the production bundle keeps real lazy and portal surfaces within the Scheme A material contract", async (t) => {
  const chrome = chromeExecutable();
  const skipReason = chromeFixtureSkipReason(chrome);
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const buildDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-material-react-build-"));
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
      if (url.pathname === "/api/projects/local/summary") {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({
          projectId: "local",
          summary: "Integration summary",
          updatedAt: null,
          refreshing: false,
          error: null,
        }));
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

  const capture = async (theme) => {
    const profile = await mkdtemp(path.join(os.tmpdir(), `taskboard-material-react-${theme}-`));
    profiles.push(profile);
    return runChromeFixture(chrome, async (executable) => {
      const url = `http://127.0.0.1:${address.port}/fixture?theme=${theme}`;
      const child = spawn(
        executable,
        chromeMaterialArguments({
          profile,
          url,
        }),
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

  for (const theme of ["light", "dark"]) {
    const result = await capture(theme);
    assert.equal(result.theme, theme);
    assert.match(result.automationMenu.backdrop, /blur\(18px\)/);
    assert.equal(result.workflowBackdrop.backdrop, "none", `${theme} workflow overlay must not use unapproved blur`);
    assertSolid(result.automationSwitch, `${theme} automation switch row`);
    assertSolid(result.automationField, `${theme} automation field row`);
    assertSolid(result.automationQuota, `${theme} automation quota row`);
    assert.equal(result.dashboardHero.backgroundImage, "none", `${theme} completion must not use a rainbow gradient`);
    assert.equal(result.dashboardHero.color, result.dashboardStartedLine.stroke, `${theme} completion and progress line must share the Apple-blue role`);
    assert.equal(result.dashboardHero.textFill, result.dashboardHero.color, `${theme} completion text must remain visible`);
    assert.equal(result.dashboardStartedText.color, result.tokens.accentText, `${theme} small progress text must use the contrast-safe accent role`);
    const smallTextSurfaces = theme === "light"
      ? [["quaternary on muted", result.tokens.textQuaternary, result.dashboardMutedSurface.background]]
      : [
          ["tertiary on content", result.tokens.textTertiary, result.automationSwitch.background],
          ["tertiary on muted", result.tokens.textTertiary, result.dashboardMutedSurface.background],
          ["quaternary on content", result.tokens.textQuaternary, result.automationSwitch.background],
          ["quaternary on muted", result.tokens.textQuaternary, result.dashboardMutedSurface.background],
        ];
    for (const [label, foreground, background] of smallTextSurfaces) {
      const ratio = computedContrast(foreground, background);
      assert.ok(
        ratio >= 4.5,
        `${theme} ${label} small text must reach 4.5:1; received ${ratio.toFixed(2)}:1`,
      );
    }
    assertSolid(result.normalColumn, `${theme} normal board column`);
    assertSolid(result.dropColumn, `${theme} drop-target board column`);
    assert.notEqual(result.dropColumn.background, result.normalColumn.background, `${theme} drop target must remain visibly distinct`);
    assert.equal(result.dropColumn.boxShadow, "none", `${theme} drop target must not use a shadow or outline`);
  }
});
