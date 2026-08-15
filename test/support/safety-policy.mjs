export function lanTestOptions(env) {
  return env.CODEX_TASKBOARD_LOOPBACK_ONLY === "1"
    ? { skip: "Disabled by loopback-only safety policy" }
    : {};
}
