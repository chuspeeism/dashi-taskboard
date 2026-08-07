const ROUTE_SEARCH_STATE_KEY = "__codexTaskboardRouteSearch__";

type TaskboardHistoryUpdate = {
  state: unknown;
  url: URL | null;
};

function routeSearchFromState(state: unknown): string {
  if (!state || typeof state !== "object") return "";
  const search = (state as Record<string, unknown>)[ROUTE_SEARCH_STATE_KEY];
  return typeof search === "string" ? search : "";
}

export function resolveTaskboardRouteUrl(
  physicalHref: string,
  historyState: unknown,
  baseHref: string,
): URL {
  const physicalUrl = new URL(physicalHref);
  if (physicalUrl.protocol !== "blob:") return physicalUrl;

  const routeUrl = new URL(baseHref);
  routeUrl.search = routeSearchFromState(historyState);
  return routeUrl;
}

export function buildTaskboardHistoryUpdate(
  physicalHref: string,
  historyState: unknown,
  routeUrl: URL,
): TaskboardHistoryUpdate {
  if (new URL(physicalHref).protocol !== "blob:") {
    return { state: historyState, url: routeUrl };
  }

  const currentState = historyState && typeof historyState === "object"
    ? historyState as Record<string, unknown>
    : {};
  return {
    state: { ...currentState, [ROUTE_SEARCH_STATE_KEY]: routeUrl.search },
    // Chromium rejects query changes on blob document URLs. Keep that physical
    // URL untouched and store only the logical Taskboard route in history.state.
    url: null,
  };
}

export function currentTaskboardRouteUrl(): URL {
  return resolveTaskboardRouteUrl(
    window.location.href,
    window.history.state,
    document.baseURI,
  );
}

export function currentTaskboardRouteSearch(): string {
  return currentTaskboardRouteUrl().search;
}

function writeTaskboardRoute(method: "pushState" | "replaceState", routeUrl: URL): void {
  const update = buildTaskboardHistoryUpdate(
    window.location.href,
    window.history.state,
    routeUrl,
  );
  if (update.url) window.history[method](update.state, "", update.url);
  else window.history[method](update.state, "");
}

export function pushTaskboardRoute(routeUrl: URL): void {
  writeTaskboardRoute("pushState", routeUrl);
}

export function replaceTaskboardRoute(routeUrl: URL): void {
  writeTaskboardRoute("replaceState", routeUrl);
}
