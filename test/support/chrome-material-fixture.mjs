export function chromeMaterialArguments({ profile, url }) {
  const target = new URL(url);
  if (
    target.protocol !== "http:"
    || target.hostname !== "127.0.0.1"
    || target.username
    || target.password
  ) {
    throw new Error("Material fixture URLs must use HTTP on 127.0.0.1");
  }
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-gpu",
    "--no-first-run",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
  ];
}

export function chromeMaterialSpawnOptions() {
  return { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] };
}

export async function waitForMaterialSnapshot(session, options = {}) {
  const {
    timeout = 15_000,
    pollInterval = 25,
    now = () => performance.now(),
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = options;
  const deadline = now() + timeout;
  let latestPhase = "unknown";

  while (true) {
    const evaluation = await session.send("Runtime.evaluate", {
      expression: `(() => ({
        result: document.documentElement.dataset.result || "",
        phase: document.documentElement.dataset.fixturePhase || "unknown",
        readyState: document.readyState
      }))()`,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(
        evaluation.exceptionDetails.exception?.description
        || evaluation.exceptionDetails.text
        || "Material fixture Runtime.evaluate failed",
      );
    }

    const state = evaluation.result?.value;
    latestPhase = state?.phase || latestPhase;
    if (state?.result) {
      let snapshot;
      try {
        snapshot = JSON.parse(decodeURIComponent(state.result));
      } catch (error) {
        throw new Error(`Material fixture emitted an invalid snapshot in phase ${latestPhase}: ${error.message}`);
      }
      if (snapshot.infrastructureError) {
        throw new Error(
          `${snapshot.infrastructureError} (fixture phase: ${snapshot.phase || latestPhase})`,
        );
      }
      return snapshot;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Chrome did not expose the real React material snapshot within ${timeout}ms (fixture phase: ${latestPhase})`,
      );
    }
    await wait(Math.min(pollInterval, remaining));
  }
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeout) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", handleExit);
      resolve(false);
    }, timeout);
    const handleExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", handleExit);
  });
}

export async function closeOwnedChrome(browser, child, options = {}) {
  const {
    gracefulTimeout = 2_000,
    forceTimeout = 1_000,
    waitUntilExit = waitForChildExit,
  } = options;

  browser.close();
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitUntilExit(child, gracefulTimeout)) return;
  child.kill("SIGKILL");
  if (!await waitUntilExit(child, forceTimeout)) {
    throw new Error("Chrome material fixture did not exit after SIGKILL");
  }
}
