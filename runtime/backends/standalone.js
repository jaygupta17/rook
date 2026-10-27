import { ensureBrowser, releaseBrowserHandles } from "../browser.js";

/**
 * The stock-Chrome backend: one headless Chromium per profile, one browser
 * context per task space, one DevTools target per tab (README "How a task space
 * maps onto Chrome").
 *
 * This is the only backend that owns a browser process, so it is also the only
 * one that persists anything: Chrome writes cookies and storage into its own
 * `--user-data-dir`, which is why a space survives a bridge restart here.
 */
export class StandaloneBackend {
  kind = "standalone";

  #profileId;
  #WebSocketImpl;
  #handle = null;
  #opening = null;
  #frames = new Set();
  #listenersAttached = false;

  constructor({ profileId, WebSocketImpl }) {
    this.#profileId = profileId;
    this.#WebSocketImpl = WebSocketImpl;
  }

  get profileId() {
    return this.#profileId;
  }

  get connection() {
    return this.#handle?.connection ?? null;
  }

  describe() {
    const port = this.#handle?.port;
    return port ? `chrome profile ${this.#profileId} (port ${port})` : `chrome profile ${this.#profileId}`;
  }

  openFrameListener(listener) {
    this.#frames.add(listener);
    return () => this.#frames.delete(listener);
  }

  async open() {
    if (this.#handle) return this;
    if (!this.#opening) {
      this.#opening = ensureBrowser(this.#profileId, { WebSocketImpl: this.#WebSocketImpl })
        .then((handle) => {
          this.#handle = handle;
          this.#attachForwarding();
          return this;
        })
        .catch((error) => {
          this.#opening = null;
          throw error;
        });
    }
    return this.#opening;
  }

  close() {
    // Chrome outlives the CLI by design (the next round reconnects to it), but
    // this process's WebSocket must be closed or a short-lived CLI never exits.
    this.#frames.clear();
    this.#listenersAttached = false;
    if (this.#handle?.connection) {
      this.#handle.connection.onForward = null;
    }
    // Drop the handle too: a backend that is opened again after a close must
    // reconnect (or relaunch) instead of handing out a closed WebSocket.
    this.#handle = null;
    this.#opening = null;
    return releaseBrowserHandles().catch(() => {});
  }

  // --- spaces ------------------------------------------------------------

  async createSpace(name, space) {
    await this.open();
    const connection = this.connection;
    const created = await connection.request("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    const contextId = created.browserContextId;
    if (typeof contextId !== "string" || contextId === "") {
      throw new Error("Target.createBrowserContext returned no browserContextId");
    }
    try {
      await connection.request("Target.createTarget", {
        url: "about:blank",
        browserContextId: contextId,
      });
    } catch (error) {
      // A space without its canonical tab is worse than no space at all.
      await connection
        .request("Target.disposeBrowserContext", { browserContextId: contextId })
        .catch(() => {});
      throw error;
    }
    space.contextId = contextId;
    return { spaceId: null, contextId };
  }

  async closeSpace(space) {
    await this.open();
    if (!space.contextId) return;
    await this.connection
      .request("Target.disposeBrowserContext", { browserContextId: space.contextId })
      .catch(() => {});
  }

  /** Chrome spaces live in browser contexts, so there is nothing to verify. */
  async listSpaceIds() {
    return null;
  }

  async handOff() {}

  async takeOver() {}

  async setAgentTaskState() {}

  async highlightMouseTo() {}

  // --- tabs --------------------------------------------------------------

  async listTabs(space) {
    await this.open();
    const result = await this.connection.request("Target.getTargets", {});
    const infos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    this.connection.learnTargets(infos);
    return infos
      .filter(
        (info) =>
          info.type === "page" &&
          (info.browserContextId ?? null) === (space.contextId ?? null),
      )
      .map((info) => ({
        tabId: info.targetId,
        browserId: info.targetId,
        targetId: info.targetId,
        url: info.url || "",
        title: info.title || "",
        active: null,
      }));
  }

  async createTab(space, url) {
    await this.open();
    const created = await this.connection.request("Target.createTarget", {
      url,
      browserContextId: space.contextId,
    });
    const targetId = created.targetId;
    if (typeof targetId !== "string" || targetId === "") {
      throw new Error("createTab returned no targetId");
    }
    return { tabId: targetId, browserId: targetId, targetId };
  }

  async activateTab(space, targetId) {
    await this.open();
    await this.connection.request("Target.activateTarget", { targetId });
  }

  async closeTab(space, targetId) {
    await this.open();
    await this.connection.request("Target.closeTarget", { targetId });
  }

  // --- CDP ---------------------------------------------------------------

  async sendRaw(space, text) {
    await this.open();
    this.connection.sendRaw(text);
  }

  async attach(space, targetId) {
    await this.open();
    const attached = await this.connection.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== "string" || attached.sessionId === "") {
      throw new Error("Target.attachToTarget returned no sessionId");
    }
    return attached.sessionId;
  }

  async request(space, tabId, method, params = {}, sessionId = undefined) {
    await this.open();
    return this.connection.request(method, params, sessionId);
  }

  async targets(space, tabId) {
    await this.open();
    const result = await this.connection.request("Target.getTargets", {}).catch(() => null);
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    return infos.filter(
      (info) => (info.browserContextId ?? null) === (space.contextId ?? null),
    );
  }

  // --- internals ---------------------------------------------------------

  #attachForwarding() {
    if (this.#listenersAttached) return;
    this.#listenersAttached = true;
    const connection = this.connection;
    if (!connection) return;
    connection.onForward = (data, text) => {
      for (const listener of this.#frames) {
        try {
          listener({ space: undefined, tabId: undefined, data, text });
        } catch {
          // A throwing listener must not break the socket.
        }
      }
    };
  }
}
