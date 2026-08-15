import assert from "node:assert/strict";
import test from "node:test";

import { resolveHost } from "../server/app.mjs";

test("customized source defaults the Taskboard service to loopback", () => {
  assert.equal(resolveHost(undefined), "127.0.0.1");
});
