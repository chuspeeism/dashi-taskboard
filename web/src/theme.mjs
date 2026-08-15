export function isTaskboardTheme(value) {
  return value === "light" || value === "dark";
}

export function themeFromHostMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.type === "taskboard:theme") {
    return isTaskboardTheme(message.theme) ? message.theme : null;
  }
  if (message.type === "taskboard:host-context") {
    return isTaskboardTheme(message.payload?.theme) ? message.payload.theme : null;
  }
  return null;
}

export function resolveTaskboardTheme({ embedded, hostTheme, queryTheme, systemDark }) {
  if (embedded && isTaskboardTheme(hostTheme)) return hostTheme;
  if (!embedded && isTaskboardTheme(queryTheme)) return queryTheme;
  return systemDark ? "dark" : "light";
}
