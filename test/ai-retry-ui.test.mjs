import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const aiChatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const typeSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("AI chat history exposes persistent automatic retry states", () => {
  assert.match(typeSource, /type AiChatRetryState =/);
  assert.match(typeSource, /retryJob\?: AiChatRetryJob \| null/);
  assert.match(aiChatSource, /"running" \| "completed" \| "retry" \| "archived"/);
  assert.match(aiChatSource, /待重试\{retryThreadCount/);
  assert.match(aiChatSource, /待人工处理 · 已重试/);
  assert.match(aiChatSource, /snapshot\.thread\.retryJob/);
  assert.match(styleSource, /\.ai-chat-retry-status/);
});
