import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createTaskboardSupervisor } from "../scripts/taskboard-supervisor.mjs";

class ManagedChild extends EventEmitter {
  constructor(name, events) {
    super();
    this.name = name;
    this.events = events;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal) {
    this.events.push(["kill", this.name, signal]);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  unref() {}
}

test("an unhealthy live child exits before its replacement starts", async () => {
  const events = [];
  let sequence = 0;
  const supervisor = createTaskboardSupervisor({
    detached: false,
    isReachable: async () => false,
    waitUntilReachable: async (timeoutMs) => {
      events.push(["health", timeoutMs]);
      if (timeoutMs === 3_000) throw new Error("unhealthy");
    },
    start: () => {
      const child = new ManagedChild(`child-${++sequence}`, events);
      events.push(["start", child.name]);
      return child;
    },
  });

  await supervisor.ensure();
  await supervisor.ensure({ force: true });

  assert.deepEqual(events.slice(0, 6), [
    ["start", "child-1"],
    ["health", 10_000],
    ["health", 3_000],
    ["kill", "child-1", "SIGTERM"],
    ["start", "child-2"],
    ["health", 10_000],
  ]);
  await supervisor.stop();
});
