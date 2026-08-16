export function waitForTimer(delay = 16) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function waitForDomSelector(root, selector, options = {}) {
  const {
    timeout = 10_000,
    pollInterval = 16,
    now = () => performance.now(),
    wait = waitForTimer,
  } = options;
  const deadline = now() + timeout;

  while (true) {
    const element = root.querySelector(selector);
    if (element) return element;

    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${selector}`);
    await wait(Math.min(pollInterval, remaining));
  }
}
