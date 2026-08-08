import assert from "node:assert/strict";
import test from "node:test";
import { computeTaskIntervention } from "../server/task-intervention.mjs";

const NOW = "2026-08-06T12:00:00.000Z";

function task(overrides = {}) {
  return {
    id: "task-1",
    status: "blocked",
    createdAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:00.000Z",
    ...overrides,
  };
}

test("awaiting-user signals populate resolve and comment views until the user replies", () => {
  const signal = {
    kind: "awaiting_user",
    status: "active",
    summary: "需要确认商品范围",
    action: "请回复要保留的商品范围",
    createdAt: "2026-08-06T08:00:00.000Z",
    updatedAt: "2026-08-06T08:00:00.000Z",
    target: { kind: "task", taskId: "task-1" },
  };
  const waiting = computeTaskIntervention({ task: task(), signals: [signal] }, { now: NOW });
  assert.deepEqual(waiting.views, ["resolve", "comment"]);
  assert.equal(waiting.primary.code, "awaiting_confirmation");
  assert.equal(waiting.reasons[0].action, "请回复要保留的商品范围");

  const replied = computeTaskIntervention({
    task: task(),
    signals: [signal],
    comments: [{
      authorType: "user",
      createdAt: "2026-08-06T09:00:00.000Z",
      updatedAt: "2026-08-06T09:00:00.000Z",
    }],
  }, { now: NOW });
  assert.deepEqual(replied.views, []);
});

test("readiness review waiting and failure are visible, then disappear after a reply", () => {
  const review = {
    status: "awaiting_input",
    aiThreadId: "ai-thread-1",
    createdAt: "2026-08-06T07:00:00.000Z",
    updatedAt: "2026-08-06T07:30:00.000Z",
  };
  const waiting = computeTaskIntervention({ task: task(), readinessReview: review }, { now: NOW });
  assert.deepEqual(waiting.views, ["resolve", "comment"]);
  assert.equal(waiting.reasons.every((reason) => reason.target.kind === "readiness"), true);

  const replied = computeTaskIntervention({
    task: task(),
    readinessReview: review,
    comments: [{
      authorType: "user",
      createdAt: "2026-08-06T08:00:00.000Z",
      updatedAt: "2026-08-06T08:00:00.000Z",
    }],
  }, { now: NOW });
  assert.deepEqual(replied.views, []);

  const failed = computeTaskIntervention({
    task: task(),
    readinessReview: { ...review, status: "failed", error: "worker stopped" },
  }, { now: NOW });
  assert.deepEqual(failed.views, ["resolve", "follow_up"]);
  assert.equal(failed.reasons.some((reason) => reason.code === "readiness_failed"), true);
});

test("review, execution failure, and stalled rules stay separate", () => {
  const review = computeTaskIntervention({
    task: task({ status: "in_review", updatedAt: "2026-08-06T10:00:00.000Z" }),
  }, { now: NOW });
  assert.deepEqual(review.views, ["follow_up"]);
  assert.equal(review.primary.code, "awaiting_acceptance");

  const failed = computeTaskIntervention({
    task: task({ status: "blocked" }),
    dispatches: [{
      status: "failed",
      error: "worker exited",
      createdAt: "2026-08-06T09:00:00.000Z",
      updatedAt: "2026-08-06T09:05:00.000Z",
    }],
  }, { now: NOW });
  assert.deepEqual(failed.views, ["resolve", "follow_up"]);

  const stalled = computeTaskIntervention({
    task: task({ status: "in_progress", updatedAt: "2026-08-05T12:00:00.000Z" }),
  }, { now: NOW });
  assert.deepEqual(stalled.views, ["follow_up"]);
  assert.equal(stalled.primary.code, "stalled");

  const retrying = computeTaskIntervention({
    task: task({ status: "in_progress", updatedAt: "2026-08-05T12:00:00.000Z" }),
    retryJobs: [{ state: "running", updatedAt: "2026-08-05T12:00:00.000Z" }],
  }, { now: NOW });
  assert.deepEqual(retrying.views, []);
});

test("manual include and exclude are applied only while the override is current", () => {
  const included = computeTaskIntervention({
    task: task({ status: "backlog" }),
    manualOverrides: [{ view: "follow_up", mode: "include", updatedAt: "2026-08-06T09:00:00.000Z" }],
  }, { now: NOW });
  assert.deepEqual(included.views, ["follow_up"]);
  assert.equal(included.reasons[0].code, "manual_include");

  const excluded = computeTaskIntervention({
    task: task({ status: "in_review", updatedAt: "2026-08-06T09:00:00.000Z" }),
    manualOverrides: [{ view: "follow_up", mode: "exclude", updatedAt: "2026-08-06T10:00:00.000Z" }],
  }, { now: NOW });
  assert.deepEqual(excluded.views, []);

  const stale = computeTaskIntervention({
    task: task({ status: "in_review", updatedAt: "2026-08-06T10:00:00.000Z" }),
    manualOverrides: [{ view: "follow_up", mode: "include", updatedAt: "2026-08-06T09:00:00.000Z" }],
  }, { now: NOW });
  assert.deepEqual(stale.views, ["follow_up"]);
  assert.equal(stale.reasons[0].code, "awaiting_acceptance");
});
