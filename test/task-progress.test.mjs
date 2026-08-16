import assert from "node:assert/strict";
import test from "node:test";

import { presentTaskProgress } from "../web/src/taskProgress.mjs";
import * as taskProgress from "../web/src/taskProgress.mjs";

test("converts real 7/10 counts into 70 percent with three remaining verifying steps", () => {
  assert.deepEqual(presentTaskProgress({ completed: 7, total: 10, running: true }), {
    percent: 70,
    completed: 7,
    total: 10,
    remaining: 3,
    phase: "verifying",
    running: true,
  });
});

test("keeps the last known percentage and counts when processing is paused", () => {
  assert.deepEqual(presentTaskProgress({ completed: 7, total: 10, running: false }), {
    percent: 70,
    completed: 7,
    total: 10,
    remaining: 3,
    phase: "verifying",
    running: false,
  });
});

test("uses paused as the display phase without mutating the last deterministic phase", () => {
  const progress = presentTaskProgress({ completed: 7, total: 10, running: false });
  assert.equal(progress?.phase, "verifying");
  assert.equal(taskProgress.displayTaskProgressPhase?.(progress), "paused");
});

test("rejects invalid counts and clamps underflow and overflow to real bounds", () => {
  assert.equal(presentTaskProgress({ completed: null, total: 10, running: true }), null);
  assert.equal(presentTaskProgress({ completed: 1, total: 0, running: true }), null);
  assert.equal(presentTaskProgress({ completed: Number.NaN, total: 10, running: true }), null);
  assert.equal(presentTaskProgress({ completed: 1, total: Number.POSITIVE_INFINITY, running: true }), null);

  assert.deepEqual(presentTaskProgress({ completed: -3, total: 10, running: true }), {
    percent: 0,
    completed: 0,
    total: 10,
    remaining: 10,
    phase: "analyzing",
    running: true,
  });
  assert.deepEqual(presentTaskProgress({ completed: 12, total: 10, running: true }), {
    percent: 100,
    completed: 10,
    total: 10,
    remaining: 0,
    phase: "complete",
    running: true,
  });
});

test("keeps incomplete 199/200 progress below complete with one step remaining", () => {
  assert.deepEqual(presentTaskProgress({ completed: 199, total: 200, running: true }), {
    percent: 99,
    completed: 199,
    total: 200,
    remaining: 1,
    phase: "finishing",
    running: true,
  });
});

test("formats one remaining English step in the singular", () => {
  assert.equal(taskProgress.taskProgressRemainingLabel?.(1, "en"), "1 step remaining");
  assert.equal(taskProgress.taskProgressRemainingLabel?.(2, "en"), "2 steps remaining");
  assert.equal(taskProgress.taskProgressRemainingLabel?.(1, "zh"), "剩余 1 步");
});

test("formats startedAt as factual elapsed time without adding it to progress data", () => {
  const startedAt = "2026-08-15T09:58:45.000Z";
  const now = new Date("2026-08-15T10:00:00.000Z").getTime();
  assert.equal(taskProgress.presentTaskElapsed?.(startedAt, now), "1m15s");
  assert.equal(taskProgress.presentTaskElapsed?.(null, now), "");
  assert.equal("elapsed" in presentTaskProgress({ completed: 7, total: 10, running: true }), false);
});

test("maps progress bands to deterministic work phases without an ETA", () => {
  const cases = [
    [{ completed: 0, total: 10, running: true }, "analyzing"],
    [{ completed: 3, total: 10, running: true }, "implementing"],
    [{ completed: 5, total: 10, running: true }, "verifying"],
    [{ completed: 8, total: 10, running: true }, "finishing"],
    [{ completed: 10, total: 10, running: true }, "complete"],
  ];

  for (const [processing, expectedPhase] of cases) {
    const result = presentTaskProgress(processing);
    assert.equal(result?.phase, expectedPhase);
    assert.equal("eta" in result, false);
  }
});
