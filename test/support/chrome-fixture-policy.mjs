export function chromeFixtureSkipReason(executable) {
  return executable ? null : "Chrome or Chromium is not installed";
}

export function runChromeFixture(executable, run) {
  return run(executable);
}
