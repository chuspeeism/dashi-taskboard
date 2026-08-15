import assert from "node:assert/strict";
import test from "node:test";

import {
  chromeMaterialArguments,
  chromeMaterialSpawnOptions,
  closeOwnedChrome,
  waitForMaterialSnapshot,
} from "./support/chrome-material-fixture.mjs";

test("the production React fixture uses a private CDP pipe and stays loopback-only", () => {
  const arguments_ = chromeMaterialArguments({
    profile: "/tmp/material-profile",
    url: "http://127.0.0.1:43123/fixture?theme=light",
  });
  assert.ok(arguments_.includes("--remote-debugging-pipe"));
  assert.ok(arguments_.includes("--disable-component-update"));
  assert.equal(arguments_.some((argument) => argument.startsWith("--remote-debugging-port")), false);
  assert.equal(arguments_.includes("--dump-dom"), false);
  assert.equal(arguments_.some((argument) => argument.startsWith("--virtual-time-budget")), false);
  assert.equal(arguments_.includes("http://127.0.0.1:43123/fixture?theme=light"), false);
  assert.doesNotMatch(arguments_.join(" "), /0\.0\.0\.0|localhost/);
  assert.deepEqual(
    chromeMaterialSpawnOptions().stdio,
    ["ignore", "ignore", "pipe", "pipe", "pipe"],
  );
});

test("the production React fixture rejects non-loopback URLs", () => {
  assert.throws(() => chromeMaterialArguments({
    profile: "/tmp/material-profile",
    url: "http://0.0.0.0:43123/fixture",
  }), /127\.0\.0\.1/);
});

test("the CDP poller returns the encoded snapshot and reports its fixture phase", async () => {
  let clock = 0;
  let evaluations = 0;
  const session = {
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /dataset\.result/);
      evaluations += 1;
      if (evaluations === 1) {
        return { result: { value: { result: "", phase: "react-render-requested" } } };
      }
      return {
        result: {
          value: {
            phase: "capturing-computed-styles",
            result: encodeURIComponent(JSON.stringify({ theme: "light" })),
          },
        },
      };
    },
  };

  const result = await waitForMaterialSnapshot(session, {
    timeout: 100,
    pollInterval: 10,
    now: () => clock,
    wait: async (delay) => { clock += delay; },
  });
  assert.deepEqual(result, { theme: "light" });
  assert.equal(evaluations, 2);
});

test("the CDP poller surfaces real fixture failures instead of timing out", async () => {
  const session = {
    async send() {
      return {
        result: {
          value: {
            phase: "opening-automation-portal",
            result: encodeURIComponent(JSON.stringify({
              infrastructureError: "Missing real React element: .project-automation-menu",
              phase: "opening-automation-portal",
            })),
          },
        },
      };
    },
  };

  await assert.rejects(
    waitForMaterialSnapshot(session),
    /Missing real React element.*opening-automation-portal/,
  );
});

test("owned Chrome cleanup closes the pipe and terminates only the spawned child", async () => {
  const signals = [];
  const browser = { closed: false, close() { this.closed = true; } };
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      this.signalCode = signal;
      return true;
    },
  };

  await closeOwnedChrome(browser, child, {
    waitUntilExit: async () => child.signalCode !== null,
  });
  assert.equal(browser.closed, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});
