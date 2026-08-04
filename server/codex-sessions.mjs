import { startCodexAppServer } from "../scripts/codex-rate-limits.mjs";

const PAGE_SIZE = 100;

export function taskStatusForCodexThread(status) {
  if (status?.type === "active") {
    if (status.activeFlags?.includes("waitingOnApproval")) return "in_review";
    if (status.activeFlags?.includes("waitingOnUserInput")) return "todo";
    return "in_progress";
  }
  if (status?.type === "systemError") return "blocked";
  return "done";
}

function normalizeThread(thread) {
  const title = typeof thread?.name === "string" && thread.name.trim()
    ? thread.name.trim()
    : String(thread?.preview ?? "").split("\n", 1)[0].trim() || "未命名会话";
  return {
    id: String(thread.id),
    title,
    cwd: typeof thread.cwd === "string" ? thread.cwd : "",
    status: taskStatusForCodexThread(thread.status),
    nativeStatus: thread.status?.type ?? "notLoaded",
    activeFlags: Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : [],
    pinned: thread.isPinned === true,
    createdAt: Number(thread.createdAt) || 0,
    updatedAt: Number(thread.recencyAt ?? thread.updatedAt) || 0,
  };
}

export class CodexSessionCatalog {
  constructor(codexExecutable = "codex") {
    this.codexExecutable = codexExecutable;
    this.client = null;
    this.connecting = null;
    this.pendingList = null;
  }

  async list() {
    if (this.pendingList) return this.pendingList;
    this.pendingList = this.#list().finally(() => {
      this.pendingList = null;
    });
    return this.pendingList;
  }

  async #list() {
    const client = await this.#client();
    const threads = [];
    let cursor = null;
    do {
      let result;
      try {
        result = await client.request("thread/list", {
          cursor,
          limit: PAGE_SIZE,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          useStateDbOnly: true,
        });
      } catch (error) {
        this.#reset();
        throw error;
      }
      threads.push(...(Array.isArray(result?.data) ? result.data : []));
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return threads.filter((thread) => thread?.id).map(normalizeThread);
  }

  async #client() {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = startCodexAppServer(this.codexExecutable);
        try {
          await client.request("initialize", {
            clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          });
          client.notify("initialized", {});
          this.client = client;
          return client;
        } catch (error) {
          client.close();
          throw error;
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  #reset() {
    this.client?.close();
    this.client = null;
  }

  close() {
    this.#reset();
  }
}
