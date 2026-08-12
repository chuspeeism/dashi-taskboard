const memoryStorage = new Map<string, string>();
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let storageWrite = Promise.resolve();

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
    return;
  } catch {
    const response = await fetch(new URL("api/client-storage", document.baseURI));
    if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
    const payload = await response.json() as { entries: Record<string, string> };
    for (const [key, value] of Object.entries(payload.entries)) {
      memoryStorage.set(key, value);
    }
    serverBacked = true;
  }
}

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    return localStorageBackend?.getItem(key) ?? memoryStorage.get(key) ?? null;
  },
  setItem(key, value) {
    if (localStorageBackend) {
      localStorageBackend.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    if (serverBacked) persist(key, value);
  },
  removeItem(key) {
    if (localStorageBackend) {
      localStorageBackend.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    if (serverBacked) persist(key, null);
  },
};
