import path from "node:path";

export function defaultCaptureOutputDirectory(projectRoot) {
  return path.join(projectRoot, ".artifacts/codex-qa/customized-codex");
}

export function minimalSidebarEvidence(raw) {
  const pluginIndex = Number.isInteger(raw?.pluginIndex) ? raw.pluginIndex : -1;
  const entryIndex = Number.isInteger(raw?.entryIndex) ? raw.entryIndex : -1;
  return {
    dataTheme: raw?.dataTheme ?? null,
    colorScheme: raw?.colorScheme ?? null,
    taskboardRuntime: raw?.taskboardRuntime === "present" ? "present" : "missing",
    sidebarScrollCount: Number.isInteger(raw?.sidebarScrollCount) ? raw.sidebarScrollCount : 0,
    pluginPresent: raw?.pluginPresent === true,
    entryMounted: raw?.entryMounted === true,
    sameParent: raw?.sameParent === true,
    pluginIndex,
    entryIndex,
    itemsBetween: pluginIndex >= 0 && entryIndex >= 0 ? Math.max(0, entryIndex - pluginIndex - 1) : null,
    passesAfterPlugins: raw?.passesAfterPlugins === true,
  };
}

export function normalizeScreenshotClip(raw, viewport) {
  const viewportWidth = Math.max(1, Number(viewport?.width) || 1);
  const viewportHeight = Math.max(1, Number(viewport?.height) || 1);
  const x = Math.min(viewportWidth - 1, Math.max(0, Number(raw?.x) || 0));
  const y = Math.min(viewportHeight - 1, Math.max(0, Number(raw?.y) || 0));
  const requestedRight = (Number(raw?.x) || 0) + Math.max(1, Number(raw?.width) || 1);
  const requestedBottom = (Number(raw?.y) || 0) + Math.max(1, Number(raw?.height) || 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(viewportWidth, requestedRight) - x),
    height: Math.max(1, Math.min(viewportHeight, requestedBottom) - y),
    scale: 1,
  };
}
