import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAiChatThread,
  deleteAiChatThread,
  archiveAiChatThread,
  getAiChatCatalog,
  getAiChatThread,
  interruptAiChatRun,
  listAttachments,
  listAiChatThreads,
  retryAiChatTurn,
  restoreAiChatThread,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../web/src/api.ts";

const thread = {
  id: "thread-1",
  title: "LOCAL-103",
  status: "idle",
  origin: {
    projectId: "project / one",
    projectName: "Project One",
    workspacePath: "/never/render/or/send",
    issueId: "issue-1",
    issueIdentifier: "LOCAL-103",
  },
  codexThreadId: null,
  role: "worker",
  model: "codex-real",
  reasoningEffort: "high",
  serviceTier: null,
  sandbox: "read-only",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  archivedAt: null,
  version: 1,
  currentRun: null,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("local AI API client follows the fixed catalog, thread, turn and interrupt contract", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (String(path).startsWith("/api/local/ai/catalog")) {
      return json({
        models: [{
          slug: "codex-real",
          displayName: "Codex Real",
          description: "Local catalog",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high"],
          serviceTiers: [],
        }],
        skills: [{ id: "real-skill", label: "Real Skill", scope: "user" }],
        sandboxes: ["read-only", "workspace-write", "danger-full-access"],
      });
    }
    if (path === "/api/local/ai/threads" && !init.method) return json({ threads: [thread] });
    if (path === "/api/local/ai/threads?archived=all" && !init.method) return json({ threads: [thread] });
    if (path === "/api/local/ai/threads" && init.method === "POST") return json({ thread });
    if (path === "/api/local/ai/threads/thread-1" && !init.method) {
      return json({ thread, events: [], runs: [] });
    }
    if (path === "/api/local/ai/threads/thread-1" && init.method === "PATCH") return json({ thread });
    if (path === "/api/local/ai/threads/thread-1/archive" && init.method === "POST") return json({ thread });
    if (path === "/api/local/ai/threads/thread-1/restore" && init.method === "POST") return json({ thread });
    if (path === "/api/local/ai/threads/thread-1" && init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (path === "/api/local/ai/threads/thread-1/turns") {
      return json({ run: { id: "run-1", threadId: "thread-1", status: "running" } }, 202);
    }
    if (path === "/api/local/ai/threads/thread-1/retry") {
      return json({ run: { id: "run-2", threadId: "thread-1", status: "running" } }, 202);
    }
    if (path === "/api/local/ai/runs/run-1/interrupt") {
      return json({ run: { id: "run-1", threadId: "thread-1", status: "interrupted" } });
    }
    throw new Error(`Unexpected request ${String(path)}`);
  };

  try {
    const catalog = await getAiChatCatalog("project / one");
    assert.equal(catalog.models[0].slug, "codex-real");
    assert.equal(calls.at(-1).path, "/api/local/ai/catalog?projectId=project%20%2F%20one");

    assert.equal((await listAiChatThreads())[0].id, "thread-1");
    assert.equal((await listAiChatThreads({ archived: "all" }))[0].id, "thread-1");
    assert.equal(calls.at(-1).path, "/api/local/ai/threads?archived=all");
    await createAiChatThread({
      projectId: "project / one",
      issueId: "issue-1",
      role: "worker",
      serviceTier: "priority",
    });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      projectId: "project / one",
      issueId: "issue-1",
      role: "worker",
      serviceTier: "priority",
    });

    assert.equal((await getAiChatThread("thread-1")).thread.id, "thread-1");
    await updateAiChatThread("thread-1", {
      model: "codex-real",
      reasoningEffort: "high",
      serviceTier: null,
      sandbox: "workspace-write",
    });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      model: "codex-real",
      reasoningEffort: "high",
      serviceTier: null,
      sandbox: "workspace-write",
    });
    await updateAiChatThread("thread-1", { serviceTier: "priority" });
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { serviceTier: "priority" });

    await deleteAiChatThread("thread-1");
    assert.equal(calls.at(-1).init.method, "DELETE");

    await archiveAiChatThread(thread);
    assert.equal(calls.at(-1).path, "/api/local/ai/threads/thread-1/archive");
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { version: 1 });
    await restoreAiChatThread(thread);
    assert.equal(calls.at(-1).path, "/api/local/ai/threads/thread-1/restore");

    await startAiChatTurn("thread-1", {
      message: "公开的用户消息",
      skillIds: ["real-skill"],
      dangerFullAccessConfirmed: true,
    });
    const turnBody = JSON.parse(calls.at(-1).init.body);
    assert.deepEqual(turnBody, {
      message: "公开的用户消息",
      skillIds: ["real-skill"],
      dangerFullAccessConfirmed: true,
    });
    assert.equal("workspacePath" in turnBody, false);
    assert.equal("model" in turnBody, false);
    assert.equal("hiddenPrompt" in turnBody, false);

    const retried = await retryAiChatTurn("thread-1", {
      message: "继续处理",
      sourceRunId: "run-failed",
      skillIds: [],
    });
    assert.equal(retried.id, "run-2");
    assert.equal(calls.at(-1).path, "/api/local/ai/threads/thread-1/retry");
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      message: "继续处理",
      sourceRunId: "run-failed",
      skillIds: [],
    });

    assert.equal((await interruptAiChatRun("run-1")).status, "interrupted");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("aborted catalog requests preserve AbortError instead of reporting a service outage", async () => {
  const previousFetch = globalThis.fetch;
  const abortError = new DOMException("The operation was aborted", "AbortError");
  globalThis.fetch = async () => {
    throw abortError;
  };

  try {
    await assert.rejects(
      () => getAiChatCatalog("project-1"),
      (error) => error === abortError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("aborted response parsing preserves AbortError instead of returning an undefined collection", async () => {
  const previousFetch = globalThis.fetch;
  const abortError = new DOMException("The operation was aborted", "AbortError");
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw abortError;
    },
  });

  try {
    await assert.rejects(
      () => listAttachments("task-1"),
      (error) => error === abortError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("thread event subscription listens only for public snapshot hints and closes cleanly", () => {
  const PreviousEventSource = globalThis.EventSource;
  const listeners = new Map();
  let openedUrl = "";
  let closed = false;
  globalThis.EventSource = class {
    constructor(url) {
      openedUrl = url;
    }

    addEventListener(type, listener) {
      listeners.set(type, listener);
    }

    close() {
      closed = true;
    }
  };

  try {
    const hints = [];
    const unsubscribe = subscribeAiChatThread("thread / 1", (type) => hints.push(type));
    assert.equal(openedUrl, "/api/local/ai/threads/thread%20%2F%201/events");
    listeners.get("ai.event")();
    listeners.get("ai.run")();
    assert.deepEqual(hints, ["ai.event", "ai.run"]);
    unsubscribe();
    assert.equal(closed, true);
  } finally {
    globalThis.EventSource = PreviousEventSource;
  }
});
