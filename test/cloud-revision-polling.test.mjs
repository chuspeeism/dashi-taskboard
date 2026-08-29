import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRevisionPoller,
  createRevisionWebSocketClient,
  getRevisionPollingInterval,
  getRevisionWebSocketConfig,
} from "../web/src/revisionPolling.mjs";

function createTimerHarness() {
  const intervals = [];
  const cleared = [];

  return {
    setInterval(callback, delay) {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
    fire(index = 0) {
      return intervals[index].callback();
    },
    intervals,
    cleared,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function runFirstPoll(poller, timer, calls) {
  poller.start();
  await flush();
  if (calls.length === 0) {
    await timer.fire();
    await flush();
  }
}

test("polls the current revision every 2000ms by default and ignores unchanged responses", async () => {
  const timer = createTimerHarness();
  const calls = [];
  let invalidations = 0;
  const poller = createRevisionPoller({
    fetchRevision: async (since) => {
      calls.push(since);
      return { changed: false, revision: 0 };
    },
    onInvalidate: () => {
      invalidations += 1;
    },
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await runFirstPoll(poller, timer, calls);

  assert.equal(timer.intervals.length, 1);
  assert.equal(timer.intervals[0].delay, 2000);
  assert.deepEqual(calls, [0]);
  assert.equal(invalidations, 0);
});

test("advances the revision on change and invalidates once", async () => {
  const timer = createTimerHarness();
  const calls = [];
  let invalidations = 0;
  const responses = [
    { changed: false, revision: 0 },
    { changed: true, revision: 7 },
    { changed: false, revision: 7 },
  ];
  const poller = createRevisionPoller({
    fetchRevision: async (since) => {
      calls.push(since);
      return responses.shift();
    },
    onInvalidate: () => {
      invalidations += 1;
    },
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await runFirstPoll(poller, timer, calls);
  await timer.fire();
  await flush();
  await timer.fire();
  await flush();

  assert.deepEqual(calls, [0, 0, 7]);
  assert.equal(invalidations, 1);
});

test("does not start another request while a revision request is pending", async () => {
  const timer = createTimerHarness();
  const calls = [];
  let invalidations = 0;
  let resolveRequest;
  const request = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const poller = createRevisionPoller({
    fetchRevision: (since) => {
      calls.push(since);
      return request;
    },
    onInvalidate: () => {
      invalidations += 1;
    },
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  poller.start();
  await flush();
  if (calls.length === 0) timer.fire();
  await flush();
  timer.fire();
  timer.fire();
  await flush();

  assert.deepEqual(calls, [0]);

  resolveRequest({ changed: true, revision: 9 });
  await flush();
  await timer.fire();
  await flush();

  assert.deepEqual(calls, [0, 9]);
  assert.equal(invalidations, 1);
});

test("keeps the old revision after an error and retries it on the next tick", async () => {
  const timer = createTimerHarness();
  const calls = [];
  let attempt = 0;
  let invalidations = 0;
  const poller = createRevisionPoller({
    fetchRevision: async (since) => {
      calls.push(since);
      attempt += 1;
      if (attempt === 1) throw new Error("temporarily unavailable");
      return { changed: true, revision: 4 };
    },
    onInvalidate: () => {
      invalidations += 1;
    },
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  await runFirstPoll(poller, timer, calls);
  await timer.fire();
  await flush();

  assert.deepEqual(calls, [0, 0]);
  assert.equal(invalidations, 1);
});

test("uses an explicit interval and clears its timer when stopped", async () => {
  const timer = createTimerHarness();
  const poller = createRevisionPoller({
    fetchRevision: async () => ({ changed: false, revision: 0 }),
    onInvalidate: () => {},
    intervalMs: 750,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  poller.start();
  poller.stop();

  assert.equal(timer.intervals.length, 1);
  assert.equal(timer.intervals[0].delay, 750);
  assert.deepEqual(timer.cleared, [timer.intervals[0]]);
});

test("does not invalidate after being stopped while a request is pending", async () => {
  const timer = createTimerHarness();
  let invalidations = 0;
  let resolveRequest;
  const poller = createRevisionPoller({
    fetchRevision: () => new Promise((resolve) => {
      resolveRequest = resolve;
    }),
    onInvalidate: () => {
      invalidations += 1;
    },
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  poller.start();
  await flush();
  poller.stop();
  resolveRequest({ changed: true, revision: 1 });
  await flush();

  assert.equal(invalidations, 0);
});

test("cloud metadata selects polling and local metadata does not", () => {
  assert.equal(getRevisionPollingInterval({
    mode: "cloud",
    realtime: { transport: "poll", intervalMs: 2000 },
  }), 2000);
  assert.equal(getRevisionPollingInterval({
    mode: "local",
    realtime: { transport: "poll", intervalMs: 2000 },
  }), null);
  assert.equal(getRevisionPollingInterval({ mode: "cloud" }), null);
});

test("cloud metadata selects WebSocket push without periodic polling", () => {
  assert.deepEqual(getRevisionWebSocketConfig({
    mode: "cloud",
    realtime: {
      transport: "websocket",
      endpoint: "/api/events",
    },
  }), {
    endpoint: "/api/events",
  });
  assert.equal(getRevisionWebSocketConfig({
    mode: "local",
    realtime: {
      transport: "websocket",
      endpoint: "/api/events",
    },
  }), null);
});

test("WebSocket push invalidates on changes and checks revision once per connection", async () => {
  const sockets = [];
  const timeouts = [];
  const states = [];
  const revisionCalls = [];
  let invalidations = 0;

  const client = createRevisionWebSocketClient({
    url: "wss://taskboard.example.test/api/events",
    fetchRevision: async (since) => {
      revisionCalls.push(since);
      return { changed: false, revision: since };
    },
    onInvalidate: () => {
      invalidations += 1;
    },
    onConnectionChange: (state) => states.push(state),
    createWebSocket: (url) => {
      const socket = {
        url,
        closeCalls: [],
        close(code, reason) {
          this.closeCalls.push({ code, reason });
        },
      };
      sockets.push(socket);
      return socket;
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout() {},
  });

  client.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://taskboard.example.test/api/events");
  assert.deepEqual(states, ["connecting"]);

  sockets[0].onopen();
  await flush();
  assert.deepEqual(states, ["connecting", "live"]);
  assert.deepEqual(revisionCalls, [0]);

  sockets[0].onmessage({ data: JSON.stringify({ type: "revision", revision: 4 }) });
  assert.equal(invalidations, 1);
  sockets[0].onmessage({ data: JSON.stringify({ type: "revision", revision: 4 }) });
  sockets[0].onmessage({ data: "malformed" });
  assert.equal(invalidations, 1);

  sockets[0].onclose();
  await flush();
  assert.equal(states.at(-1), "reconnecting");
  assert.deepEqual(revisionCalls, [0]);
  assert.equal(timeouts[0].delay, 1_000);

  timeouts[0].callback();
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  await flush();
  assert.equal(states.at(-1), "live");
  assert.deepEqual(revisionCalls, [0, 4]);

  client.stop();
  assert.deepEqual(sockets[1].closeCalls, [{ code: 1000, reason: "Client stopped" }]);
});

test("a failed reconnect revision check closes the socket so compensation retries", async () => {
  const sockets = [];
  const timeouts = [];
  let revisionRequest = 0;

  const client = createRevisionWebSocketClient({
    url: "wss://taskboard.example.test/api/events",
    fetchRevision: async () => {
      revisionRequest += 1;
      if (revisionRequest === 1) throw new Error("temporary revision failure");
      return { changed: true, revision: 7 };
    },
    onInvalidate() {},
    createWebSocket() {
      const socket = {
        closeCalls: [],
        close(code, reason) {
          this.closeCalls.push({ code, reason });
        },
      };
      sockets.push(socket);
      return socket;
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout() {},
  });

  client.start();
  sockets[0].onopen();
  await flush();
  assert.deepEqual(sockets[0].closeCalls, [{ code: 4000, reason: "Revision check failed" }]);

  sockets[0].onclose();
  assert.equal(timeouts[0].delay, 1_000);
  timeouts[0].callback();
  sockets[1].onopen();
  await flush();
  assert.equal(revisionRequest, 2);
  client.stop();
});

test("the app connects the selected realtime transport without reloading the page", async () => {
  const [appSource, apiSource] = await Promise.all([
    readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(apiSource, /\/api\/revisions\?\$\{query\}/);
  assert.match(appSource, /getRevisionPollingInterval\(taskboardMetadata\)/);
  assert.match(appSource, /createRevisionPoller\(\{/);
  assert.match(appSource, /getRevisionWebSocketConfig\(taskboardMetadata\)/);
  assert.match(appSource, /createRevisionWebSocketClient\(\{/);
  assert.doesNotMatch(appSource, /revisionFallbackInterval|fallbackIntervalMs/);
  assert.match(appSource, /controller\.abort\(\);\s*poller\.stop\(\)/);
  assert.match(appSource, /new EventSource\(resolveTaskboardUrl\("\/api\/events"\)\)/);
  assert.doesNotMatch(appSource, /location\.reload\(/);

  const pollingEffect = appSource.slice(
    appSource.indexOf("if (revisionPollingInterval === null) return;"),
    appSource.indexOf("function pushUndo"),
  );
  assert.doesNotMatch(pollingEffect, /\bdetailTaskId\b|\btaskboardMetadata\b|\bselectedProjectId\b/);
  assert.match(appSource, /const projectId = taskScopeProjectIdRef\.current/);
});
