/**
 * One Chromium DevTools WebSocket.
 *
 * Two id spaces share the socket:
 *  - the harness (ego-browser) allocates ids from 1 upward through
 *    ego.sendCDPMessage(); those must reach Chromium unchanged;
 *  - this runtime allocates ids from INTERNAL_ID_BASE upward for its own
 *    browser-level calls (browser contexts, targets, snapshot reads).
 * Responses for internal ids are consumed here; everything else is forwarded
 * verbatim so `sessionId` and event payloads stay byte-identical.
 */

const INTERNAL_ID_BASE = 1_000_000_000;

export class CdpConnection {
  #ws = null;
  #open = false;
  #closed = false;
  #opening = null;
  #queue = [];
  #pending = new Map();
  #nextId = INTERNAL_ID_BASE;
  #WebSocketImpl;

  constructor({ url, WebSocketImpl = globalThis.WebSocket, onForward = null }) {
    if (typeof WebSocketImpl !== "function") {
      throw new Error(
        "No WebSocket implementation available; run on Node >= 22 or pass WebSocketImpl",
      );
    }
    this.url = url;
    this.#WebSocketImpl = WebSocketImpl;
    this.onForward = onForward;
    /** targetId -> { contextId, type, url, title } */
    this.targets = new Map();
    /** sessionId -> targetId */
    this.sessions = new Map();
    /** harness request id -> { method, params } (only while the request is in flight) */
    this.harnessRequests = new Map();
    /** Set by the bridge: which browser context this connection should expose. */
    this.filter = { enabled: false, contextId: null };
  }

  get isOpen() {
    return this.#open;
  }

  async connect(timeoutMs = 15000) {
    if (this.#open) return this;
    if (this.#closed) throw new Error("CDP connection is closed");
    if (this.#opening) return this.#opening;
    this.#opening = new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.#WebSocketImpl(this.url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`CDP WebSocket did not open within ${timeoutMs}ms: ${this.url}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#ws = ws;
        this.#open = true;
        this.#flush();
        resolve(this);
      });
      ws.addEventListener("message", (event) => {
        void this.#handleFrame(event);
      });
      ws.addEventListener("error", (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket error: ${event?.message || this.url}`));
        }
      });
      ws.addEventListener("close", () => {
        this.#open = false;
        this.#closed = true;
        clearTimeout(timer);
        const error = new Error("CDP connection closed");
        for (const entry of this.#pending.values()) entry.reject(error);
        this.#pending.clear();
        this.#queue.length = 0;
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
    try {
      return await this.#opening;
    } catch (error) {
      this.#opening = null;
      throw error;
    }
  }

  close() {
    this.#closed = true;
    this.#open = false;
    this.#queue.length = 0;
    for (const entry of this.#pending.values()) {
      entry.reject(new Error("CDP connection closed"));
    }
    this.#pending.clear();
    try {
      this.#ws?.close();
    } catch {
      // ignore
    }
    this.#ws = null;
  }

  /** Forward one harness message verbatim (fire-and-forget). */
  sendRaw(text) {
    if (this.#closed) throw new Error("CDP connection is closed");
    if (this.#open) {
      this.#ws.send(text);
      return;
    }
    this.#queue.push(text);
  }

  /** Browser-level call owned by this runtime. */
  request(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.sendRaw(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  learnTarget(targetInfo) {
    if (!targetInfo || typeof targetInfo.targetId !== "string") return;
    this.targets.set(targetInfo.targetId, {
      contextId: targetInfo.browserContextId ?? null,
      type: targetInfo.type,
      url: targetInfo.url,
      title: targetInfo.title,
    });
  }

  learnTargets(targetInfos) {
    for (const info of targetInfos ?? []) this.learnTarget(info);
  }

  contextOfSession(sessionId) {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) return undefined;
    return this.targets.get(targetId)?.contextId ?? null;
  }

  #flush() {
    const queue = this.#queue;
    this.#queue = [];
    for (const text of queue) {
      try {
        this.#ws.send(text);
      } catch {
        // A failed queued send surfaces through the socket close handler.
        break;
      }
    }
  }

  async #handleFrame(event) {
    let text = event?.data;
    if (typeof text !== "string") {
      if (text && typeof text.text === "function") text = await text.text();
      else if (text instanceof ArrayBuffer) text = Buffer.from(text).toString("utf8");
      else if (ArrayBuffer.isView(text)) {
        text = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8");
      } else text = String(text ?? "");
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (data.id !== undefined && this.#pending.has(data.id)) {
      const entry = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (data.error) {
        const error = new Error(data.error.message || `CDP error ${data.error.code}`);
        error.cdp = data.error;
        entry.reject(error);
      } else {
        entry.resolve(data.result ?? {});
      }
      return;
    }
    this.onForward?.(data, text);
  }
}
