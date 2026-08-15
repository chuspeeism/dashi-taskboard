#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultCaptureOutputDirectory,
  minimalSidebarEvidence,
  normalizeScreenshotClip,
} from "./capture-codex-taskboard-qa-lib.mjs";

const port = Number(process.argv[2] ?? "9231");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(
  process.argv[3] ?? defaultCaptureOutputDirectory(projectRoot),
);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CDP port must be an integer between 1 and 65535");
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => (
  candidate.type === "page"
  && candidate.url === "app://-/index.html"
));
if (!target?.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) {
  throw new Error("No primary loopback Codex target is available");
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.bringToFront");
const expression = String.raw`(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const textNodes = [...document.querySelectorAll("button,a,[role='button'],[role='link'],nav *")]
    .filter(visible)
    .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, " ").trim() }))
    .filter(({ text }) => /^(Plugins|插件|Taskboard|任务面板)$/i.test(text));
  const plugin = textNodes.find(({ text }) => /^(Plugins|插件)$/i.test(text))?.element || null;
  const entry = document.getElementById("codex-taskboard-entry")
    || document.querySelector("[data-codex-taskboard-owned='entry']")
    || document.querySelector("[data-codex-taskboard-owned]");
  const pluginRow = plugin?.closest("button,a,[role='button'],[role='link'],li,div") || plugin;
  const entryRow = entry?.closest("button,a,[role='button'],[role='link'],li,div") || entry;
  const siblings = pluginRow?.parentElement === entryRow?.parentElement
    ? [...pluginRow.parentElement.children].filter(visible)
    : [];
  const rows = [pluginRow, entryRow].filter(visible);
  const rowRects = rows.map((row) => row.getBoundingClientRect());
  const left = rowRects.length > 0 ? Math.min(...rowRects.map((rect) => rect.left)) : 0;
  const top = rowRects.length > 0 ? Math.min(...rowRects.map((rect) => rect.top)) : 0;
  const right = rowRects.length > 0 ? Math.max(...rowRects.map((rect) => rect.right)) : 1;
  const bottom = rowRects.length > 0 ? Math.max(...rowRects.map((rect) => rect.bottom)) : 1;
  return {
    dataTheme: document.documentElement.getAttribute("data-theme"),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    taskboardRuntime: window.__codexTaskboardInjection__ ? "present" : "missing",
    sidebarScrollCount: document.querySelectorAll("[data-app-action-sidebar-scroll]").length,
    pluginPresent: Boolean(plugin),
    entryMounted: Boolean(entry),
    sameParent: Boolean(pluginRow && entryRow && pluginRow.parentElement === entryRow.parentElement),
    pluginIndex: siblings.indexOf(pluginRow),
    entryIndex: siblings.indexOf(entryRow),
    passesAfterPlugins: siblings.indexOf(pluginRow) >= 0 && siblings.indexOf(entryRow) === siblings.indexOf(pluginRow) + 1,
    screenshotClip: {
      x: left - 12,
      y: top - 12,
      width: right - left + 24,
      height: bottom - top + 24,
    },
    viewport: { width: innerWidth, height: innerHeight },
  };
})()`;
const evaluated = await send("Runtime.evaluate", { expression, returnByValue: true });
const result = evaluated.result?.value;
const evidence = minimalSidebarEvidence(result);
const clip = normalizeScreenshotClip(result?.screenshotClip, result?.viewport);
const screenshot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
  clip,
});
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "sidebar-order.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(path.join(outputDirectory, "codex-sidebar.png"), Buffer.from(screenshot.data, "base64"));
socket.close();
console.log(JSON.stringify({
  outputDirectory,
  entryPresent: evidence.entryMounted,
  pluginPresent: evidence.pluginPresent,
  passesAfterPlugins: evidence.passesAfterPlugins,
  sidebarScrollCount: evidence.sidebarScrollCount,
  taskboardRuntime: evidence.taskboardRuntime,
}, null, 2));
