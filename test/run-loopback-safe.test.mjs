import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateBatchExitCodes,
  partitionLoopbackTestFiles,
  SPECIAL_SERIAL_FIXTURE,
} from "../scripts/run-loopback-safe-lib.mjs";

test("loopback-safe keeps the full-height fixture out of main and in serial", () => {
  const batches = partitionLoopbackTestFiles([
    "test/server.test.mjs",
    SPECIAL_SERIAL_FIXTURE,
    "test/theme.test.mjs",
  ]);

  assert.deepEqual(batches.main, ["test/server.test.mjs", "test/theme.test.mjs"]);
  assert.deepEqual(batches.serial, [SPECIAL_SERIAL_FIXTURE]);
});

test("loopback-safe propagates a failure from either batch", () => {
  assert.equal(aggregateBatchExitCodes([7, 0]), 7);
  assert.equal(aggregateBatchExitCodes([0, 9]), 9);
  assert.equal(aggregateBatchExitCodes([0, 0]), 0);
});
