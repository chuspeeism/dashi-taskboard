#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createContextServer } from "./context-server.mjs";

const handle = serveStdio(() => createContextServer(), {
  onerror() {
    console.error("Taskboard MCP transport error.");
  },
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handle.close();
}

process.once("SIGINT", () => {
  close().catch(() => {
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  close().catch(() => {
    process.exitCode = 1;
  });
});
