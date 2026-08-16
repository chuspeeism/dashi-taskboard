import assert from "node:assert/strict";
import test from "node:test";

import { waitForDomSelector } from "./support/wait-for-dom.mjs";

test("DOM polling advances on timers until the requested element exists", async () => {
  const element = { id: "ready" };
  let queries = 0;
  const startedAt = performance.now();
  const result = await waitForDomSelector({
    querySelector() {
      queries += 1;
      return queries >= 3 ? element : null;
    },
  }, ".ready", { timeout: 200, pollInterval: 5 });

  assert.equal(result, element);
  assert.equal(queries, 3);
  assert.ok(performance.now() - startedAt >= 5, "polling must yield to a timer between checks");
});

test("DOM polling rejects at an absolute deadline when the element never appears", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    waitForDomSelector({ querySelector: () => null }, ".missing", {
      timeout: 20,
      pollInterval: 5,
    }),
    /Timed out waiting for \.missing/,
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 15, `deadline fired too early after ${elapsed}ms`);
  assert.ok(elapsed < 250, `deadline was not bounded: ${elapsed}ms`);
});
