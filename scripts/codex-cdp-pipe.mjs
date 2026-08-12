class CdpEventChannel {
  constructor() {
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  dispatch(method, params) {
    const waiters = this.eventWaiters.get(method) || [];
    this.eventWaiters.delete(method);
    waiters.forEach((waiter) => waiter.resolve(params));
    const handlers = this.eventHandlers.get(method) || [];
    handlers.forEach((handler) => {
      try {
        Promise.resolve(handler(params)).catch((error) => {
          console.error(`CDP ${method} handler failed: ${error.message}`);
        });
      } catch (error) {
        console.error(`CDP ${method} handler failed: ${error.message}`);
      }
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter(
            (waiter) => waiter.resolve !== wrappedResolve,
          ),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  markClosed(error) {
    if (this.closed) return;
    this.closed = true;
    this.eventWaiters.forEach((waiters) => {
      waiters.forEach((waiter) => waiter.reject(error));
    });
    this.eventWaiters.clear();
    this.eventHandlers.clear();
  }
}

export function validatedLoopbackCdpWebSocketUrl(value, port) {
  if (typeof value !== "string") {
    throw new Error("Rejected Codex CDP target without a WebSocket URL");
  }
  const debuggerUrl = new URL(value);
  if (
    debuggerUrl.protocol !== "ws:"
    || debuggerUrl.hostname !== "127.0.0.1"
    || debuggerUrl.port !== String(port)
    || !debuggerUrl.pathname.startsWith("/devtools/page/")
    || debuggerUrl.username
    || debuggerUrl.password
  ) {
    throw new Error(`Rejected unexpected Codex CDP target URL: ${debuggerUrl.origin}`);
  }
  return debuggerUrl.href;
}

class CdpPipeSession extends CdpEventChannel {
  constructor(browser, sessionId) {
    super();
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method, params = {}) {
    if (method === "Target.getTargets") return this.browser.send(method, params);
    if (this.closed) return Promise.reject(new Error("CDP session closed"));
    return this.browser.send(method, params, this.sessionId);
  }

  close() {
    if (this.closed) return;
    this.browser.detach(this.sessionId);
  }
}

export class CdpPipeBrowser extends CdpEventChannel {
  constructor(child) {
    super();
    this.child = child;
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.sequence = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.buffer = Buffer.alloc(0);

    this.output.on("data", (chunk) => this.receive(chunk));
    this.output.once("error", (error) => this.fail(error));
    this.output.once("end", () => this.fail(new Error("CDP pipe ended")));
    this.output.once("close", () => this.fail(new Error("CDP pipe closed")));
    this.input.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`Codex exited (${signal || code})`));
    });
  }

  async open() {
    await this.send("Browser.getVersion");
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let boundary = this.buffer.indexOf(0); boundary !== -1; boundary = this.buffer.indexOf(0)) {
      const source = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!source) continue;
      const message = JSON.parse(source);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.sessionId) {
        this.sessions.get(message.sessionId)?.dispatch(message.method, message.params);
      } else {
        if (message.method === "Target.detachedFromTarget") {
          this.closeSession(message.params.sessionId, new Error("CDP target detached"));
        }
        this.dispatch(message.method, message.params);
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP pipe closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.input.write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async targets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos;
  }

  async connect(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = new CdpPipeSession(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  detach(sessionId) {
    this.closeSession(sessionId, new Error("CDP session closed"));
    if (!this.closed) {
      this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  closeSession(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.markClosed(error);
  }

  fail(error) {
    if (this.closed) return;
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
    this.sessions.forEach((session) => session.markClosed(error));
    this.sessions.clear();
    this.markClosed(error);
  }

  close() {
    if (this.closed) return;
    this.input.destroy();
    this.output.destroy();
    this.fail(new Error("CDP pipe closed"));
  }
}
