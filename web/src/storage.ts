import { AGENT_LOOP_STORAGE_KEY, LOOP_RUNNER_STORAGE_KEY } from "../../shared/agent-loop.mjs";

const memoryStorage = new Map<string, string>();
export const PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX = "taskboard.project-board-display-settings.v3.";
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let storageWrite = Promise.resolve();
let storageRefresh = Promise.resolve();

function isProjectBoardDisplaySettingsKey(key: string) {
  return key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX);
}

// Keys kept in server client storage even when localStorage exists, so taskctl sees them.
function isServerSharedKey(key: string) {
  return isProjectBoardDisplaySettingsKey(key) || key === AGENT_LOOP_STORAGE_KEY || key === LOOP_RUNNER_STORAGE_KEY;
}

async function readServerStorage() {
  const response = await fetch(new URL("api/client-storage", document.baseURI));
  if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
  const payload = await response.json() as { entries: Record<string, string> };
  if (localStorageBackend) {
    for (const key of memoryStorage.keys()) {
      if (isServerSharedKey(key)) memoryStorage.delete(key);
    }
    for (const [key, value] of Object.entries(payload.entries)) {
      if (isServerSharedKey(key)) memoryStorage.set(key, value);
    }
    return;
  }
  memoryStorage.clear();
  for (const [key, value] of Object.entries(payload.entries)) {
    memoryStorage.set(key, value);
  }
  serverBacked = true;
}

async function refreshServerStorage() {
  storageRefresh = storageRefresh.catch(() => {}).then(readServerStorage);
  await storageRefresh;
}

function persist(key: string, value: string | null) {
  storageWrite = storageWrite.then(async () => {
    const body = JSON.stringify({ key, value });
    const keepalive = new TextEncoder().encode(body).byteLength <= 64 * 1024;
    let retryDelay = RETRY_DELAY_MS;
    while (true) {
      try {
        const response = await fetch(new URL("api/client-storage", document.baseURI), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
          keepalive,
        });
        if (response.ok) return;
        const error = new Error(`Taskboard storage returned ${response.status}`);
        if (response.status >= 400 && response.status < 500) {
          console.error(error);
          return;
        }
        throw error;
      } catch (error) {
        console.error(error);
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  });
}

export async function initializeTaskboardStorage() {
  try {
    localStorageBackend = window.localStorage;
  } catch {
    localStorageBackend = null;
  }
  await refreshServerStorage();
}

export async function refreshProjectBoardDisplaySettingsStorage() {
  await storageWrite;
  await refreshServerStorage();
}

export function projectBoardDisplaySettingsStorageEntries() {
  return [...memoryStorage.entries()].filter(([key]) => isProjectBoardDisplaySettingsKey(key));
}

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    if (isServerSharedKey(key)) return memoryStorage.get(key) ?? null;
    return localStorageBackend?.getItem(key) ?? memoryStorage.get(key) ?? null;
  },
  setItem(key, value) {
    if (isServerSharedKey(key)) {
      memoryStorage.set(key, value);
      persist(key, value);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    if (serverBacked) persist(key, value);
  },
  removeItem(key) {
    if (isServerSharedKey(key)) {
      memoryStorage.delete(key);
      persist(key, null);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    if (serverBacked) persist(key, null);
  },
};
