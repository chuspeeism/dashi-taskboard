import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("agent avatar asset is a transparent PNG logo", async () => {
  const logo = await readFile(new URL("../web/public/codex-agent-logo.png", import.meta.url));
  assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(logo[25], 6);
});
