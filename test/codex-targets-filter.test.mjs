import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// codexTargets 的页面识别逻辑（参考 Codex++）不导出，从源码抽出函数体测：
// 改坏过滤器时此测试应失败。fetchJson 以桩注入，返回预设的 CDP 目标列表。
const src = readFileSync(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const start = src.indexOf("function targetInitialRoute");
const end = src.indexOf("function logInjector");
assert.ok(start > 0 && end > start, "codexTargets block not found in injector source");
const build = new Function(
  "fetchJson",
  `${src.slice(start, end)}; return { codexTargets };`,
);

const MAC_CODEX = {
  type: "page",
  title: "Codex",
  url: "app://-/index.html?initialRoute=%2F",
  webSocketDebuggerUrl: "ws://127.0.0.1/1",
};
const WIN_STORE_CHATGPT = {
  type: "page",
  title: "ChatGPT",
  url: "https://chatgpt.com/codex",
  webSocketDebuggerUrl: "ws://127.0.0.1/2",
};
const WIN_TITLE_CODEX = {
  type: "page",
  title: "codex",
  url: "https://chatgpt.com/",
  webSocketDebuggerUrl: "ws://127.0.0.1/3",
};
const QUICK_CHAT_PREWARM = {
  type: "page",
  title: "ChatGPT",
  url: "app://-/index.html?initialRoute=%2Fchatgpt%2Fquick-chat-prewarm",
  webSocketDebuggerUrl: "ws://127.0.0.1/4",
};
const AVATAR_OVERLAY = {
  type: "page",
  title: "Codex",
  url: "app://-/index.html?initialRoute=%2Favatar-overlay",
  webSocketDebuggerUrl: "ws://127.0.0.1/5",
};
const GLOBAL_DICTATION = {
  type: "page",
  title: "ChatGPT",
  url: "app://-/index.html?initialRoute=%2Fglobal-dictation",
  webSocketDebuggerUrl: "ws://127.0.0.1/6",
};
const SERVICE_WORKER = { type: "service_worker", title: "", url: "app://-/sw.js" };

async function pick(targets) {
  const { codexTargets } = build(async () => targets);
  return (await codexTargets(9229)).map((t) => t.webSocketDebuggerUrl);
}

test("macOS app:// 主页面仍然命中（回归）", async () => {
  assert.deepEqual(await pick([MAC_CODEX, GLOBAL_DICTATION]), [MAC_CODEX.webSocketDebuggerUrl]);
});

test("Windows 商店版 chatgpt.com 主页面命中", async () => {
  assert.deepEqual(
    await pick([WIN_STORE_CHATGPT, WIN_TITLE_CODEX, QUICK_CHAT_PREWARM, AVATAR_OVERLAY, SERVICE_WORKER]),
    [WIN_STORE_CHATGPT.webSocketDebuggerUrl, WIN_TITLE_CODEX.webSocketDebuggerUrl],
  );
});

test("快捷聊天/浮层/听写路由全部排除", async () => {
  assert.deepEqual(await pick([QUICK_CHAT_PREWARM, AVATAR_OVERLAY, GLOBAL_DICTATION]), []);
});
