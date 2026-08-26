import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { createServer } from "vite";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

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

test("a new status entry overrides the old draft status and restores the remaining draft", async (t) => {
  const chrome = chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = await createServer({
    root: projectRoot,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const profile = await mkdtemp(path.join(os.tmpdir(), "task-editor-create-status-"));

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/test/fixtures/task-editor-create-status.html`;
    let stdout;
    try {
      ({ stdout } = await execFileAsync(chrome, [
        "--headless=new",
        "--disable-background-networking",
        "--disable-gpu",
        "--no-first-run",
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        url,
      ], { maxBuffer: 2_000_000, timeout: 30_000 }));
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

    const error = stdout.match(/data-error="([^"]+)"/);
    assert.equal(error, null, error?.[1]);
    const result = stdout.match(/data-result="([^"]+)"/);
    assert.ok(result, "TaskEditor did not submit a creation payload");
    const draft = JSON.parse(decodeURIComponent(result[1]));

    assert.equal(draft.status, "in_progress");
    assert.equal(draft.title, "保留的草稿標題");
    assert.equal(draft.description, "保留的草稿描述");
    assert.equal(draft.priority, "high");
    assert.deepEqual(draft.labels, ["迴歸證據"]);
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
