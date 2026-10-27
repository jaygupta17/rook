import { connect } from "node:net";

/**
 * The native app's control channel: a unix socket, newline-delimited JSON-RPC
 * 2.0, with every DevTools message passed through untouched (host/README.md).
 *
 * Two things live here:
 *  - `HostControlClient`, the transport: framing, id correlation, push
 *    dispatch, reconnect-on-EOF. It never guesses whether a request worked;
 *    only a reply with the matching id settles a promise.
 *  - `HostBackend`, that transport shaped like the browser backend the bridge
 *    talks to (see backends/index.js for the interface both backends share).
 *
 * Host rules this file is built around, measured in host/README.md:
 *  - a tab id IS the browser id; one tab is one CEF browser, so a page command
 *    needs no session id and no `Target.attachToTarget` unless a real session
 *    is wanted (the SDK wants one, so we attach and pass `sessionId` through);
 *  - `Target.createTarget` is never forwarded (it makes an unowned browser);
 *    tabs are created with `createTab`, closed with `closeTab`, activated with
 *    `activateTab`;
 *  - `Target.getTargets` is process-wide and leaks every other space, so its
 *    results are narrowed here to the space's request context before they reach
 *    the SDK, exactly as the standalone backend narrows them to its own context;
 *  - `cdp.send` replying `accepted:true` only means CEF took the frame, so this
 *    file keeps its own request table and its own timeouts.
 */

const DEFAULT_RPC_TIMEOUT_MS = 15000;
/** Internal CDP request ids start here so they can never collide with the harness's. */
const INTERNAL_ID_BASE = 2_000_000_000;
const CDP_REQUEST_TIMEOUT_MS = 30000;
const TARGET_RESOLVE_TIMEOUT_MS = 10000;

/** The protocol-2 pushes that describe a tab's life (host/README.md). */
const LIFECYCLE_PUSHES = new Set([
  "space.created",
  "space.closed",
  "tab.created",
  "tab.closed",
  "tab.activated",
  "tab.updated",
  "control.changed",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `ROOK_DEBUG=1`: what the synthesised target lifecycle is doing. */
function debug(line) {
  if (process.env.ROOK_DEBUG !== "1") return;
  process.stderr.write(`[rook] host ${line}\n`);
}

function describeTargetEvent(params) {
  const info = params?.targetInfo;
  if (!info) return String(params?.targetId ?? "");
  return `${info.targetId} ${info.type} opener=${info.openerId ?? "-"} url=${info.url ?? ""}`;
}

/** `$XDG_RUNTIME_DIR/rook-<uid>.sock`, falling back to `/tmp` (host/README.md). */
export function hostSocketPaths({ env = process.env } = {}) {
  const explicit = env.ROOK_HOST_SOCKET;
  if (typeof explicit === "string" && explicit.trim() !== "") return [explicit.trim()];
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const name = `rook-${uid}.sock`;
  const paths = [];
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (typeof runtimeDir === "string" && runtimeDir.trim() !== "") {
    paths.push(`${runtimeDir.replace(/\/+$/, "")}/${name}`);
  }
  paths.push(`/tmp/${name}`);
  return paths;
}

export class HostControlError extends Error {
  constructor(message, { code, method, socketPath, cause } = {}) {
    super(message);
    this.name = "HostControlError";
    if (code !== undefined) this.rpcCode = code;
    if (method) this.method = method;
    if (socketPath) this.socketPath = socketPath;
    if (cause) this.cause = cause;
  }
}

/** One connection to the app. Reconnects lazily after the other side hangs up. */
export class HostControlClient {
  #socketPath;
  #socket = null;
  #buffer = "";
  #opening = null;
  #nextId = 1;
  #pending = new Map();
  #pushListeners = new Set();
  #closeListeners = new Set();
  #closedByUs = false;
  /** Set once a connection attempt failed: the message a later call repeats. */
  #unreachable = null;

  constructor({ socketPath }) {
    this.#socketPath = socketPath;
  }

  get socketPath() {
    return this.#socketPath;
  }

  get isOpen() {
    return this.#socket !== null;
  }

  onPush(listener) {
    this.#pushListeners.add(listener);
    return () => this.#pushListeners.delete(listener);
  }

  /** Told about an unexpected EOF/error, so the backend can drop cached state. */
  onClose(listener) {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async connect(timeoutMs = 2000) {
    if (this.#socket) return this;
    if (this.#opening) return this.#opening;
    this.#closedByUs = false;
    this.#opening = new Promise((resolve, reject) => {
      let settled = false;
      const socket = connect(this.#socketPath);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#opening = null;
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          this.#unreachable = null;
          this.#socket = socket;
          this.#buffer = "";
          socket.setEncoding("utf8");
          socket.setNoDelay(true);
          socket.on("data", (chunk) => this.#onData(chunk));
          socket.on("error", (cause) => this.#onGone(cause));
          socket.on("close", () => this.#onGone(null));
          resolve(this);
        }
      };
      const timer = setTimeout(() => {
        finish(
          new HostControlError(
            `the Rook app did not answer on ${this.#socketPath} within ${timeoutMs}ms`,
            { socketPath: this.#socketPath },
          ),
        );
      }, timeoutMs);
      socket.once("connect", () => finish(null));
      socket.once("error", (cause) => {
        const message =
          cause?.code === "ENOENT" || cause?.code === "ECONNREFUSED"
            ? `the Rook app is not running (no control socket at ${this.#socketPath})`
            : `cannot reach the Rook app on ${this.#socketPath}: ${cause?.message || cause}`;
        finish(new HostControlError(message, { socketPath: this.#socketPath, cause }));
      });
    });
    return this.#opening;
  }

  async request(method, params = {}, { timeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
    if (!this.#socket) await this.connect();
    const id = this.#nextId++;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          this.#goneError(
            `${method} got no reply from the Rook app within ${timeoutMs}ms`,
            method,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.write(frame);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(this.#goneError(`${method} could not be sent: ${error?.message || error}`, method));
      }
    });
  }

  close() {
    this.#closedByUs = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#failAll("the Rook control connection was closed");
    try {
      socket?.destroy();
    } catch {
      // already gone
    }
  }

  #goneError(message, method, cause) {
    return new HostControlError(message, {
      method,
      socketPath: this.#socketPath,
      cause,
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && Object.hasOwn(message, "id")) {
        const entry = this.#pending.get(message.id);
        if (!entry) continue;
        this.#pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(
            new HostControlError(
              String(message.error.message ?? "the app refused the request"),
              {
                code: message.error.code,
                method: entry.method,
                socketPath: this.#socketPath,
              },
            ),
          );
        } else {
          entry.resolve(message.result ?? {});
        }
        continue;
      }
      for (const listener of this.#pushListeners) {
        try {
          listener(message);
        } catch {
          // A throwing push listener must not take the connection down.
        }
      }
    }
  }

  #onGone(cause) {
    if (!this.#socket) return;
    this.#socket = null;
    this.#buffer = "";
    const message = this.#closedByUs
      ? "the Rook control connection was closed"
      : `the Rook app closed the control connection${cause ? `: ${cause.message}` : ""}`;
    this.#failAll(message, cause);
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  #failAll(message, cause) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(this.#goneError(message, entry.method, cause));
    }
  }
}

/**
 * The bridge's browser backend, served by the native app.
 *
 * Every method takes the bridge's own space record (`{ id, hostSpaceId, ... }`)
 * so this file never has to know about spaces.json. `space.contextId` is filled
 * in when a tab reports its request context, which is what lets the bridge
 * narrow `Target.getTargets` the same way it does in standalone mode.
 */
export class HostBackend {
  kind = "host";

  #client;
  #frames = new Set();
  /** host space id -> space record (`space.hostSpaceId` is the same key) */
  #spaceByHostId = new Map();
  /** tabId -> space record */
  #spaceByTab = new Map();
  /** space.hostSpaceId -> the tab the app considers active */
  #activeTabBySpace = new Map();
  /** space.hostSpaceId -> the active tab the app reported in `getInfo` */
  #hostActiveTab = new Map();
  /** tabId -> page target id */
  #targetByTab = new Map();
  /** tabId -> the last full targetInfo read for it (url, title, context) */
  #infoByTab = new Map();
  /** tabId -> {openerTabId, windowName} for a tab a page opened */
  #openers = new Map();
  /** target id -> tabId (page targets and the space's OOPIF targets) */
  #tabByTarget = new Map();
  /** sessionId -> tabId */
  #tabBySession = new Map();
  /**
   * space.hostSpaceId -> the client's `Target.setDiscoverTargets` subscription:
   * `{sinkTabId, announced: Map<targetId, "synthesized"|"baseline">,
   * lastInfo: Map<targetId, {url, title, type}>, destroyed: Set<targetId>}`.
   * Target lifecycle events are only synthesised while one of these exists,
   * because a client that never asked for discovery must not be told about
   * targets it cannot reconcile.
   */
  #discover = new Map();
  /** internal CDP id -> {resolve, reject, timer, method, tabId} */
  #cdpPending = new Map();
  /** spaceId -> when this process last re-read that space's tabs */
  #refreshedAt = new Map();
  #nextCdpId = INTERNAL_ID_BASE;
  #info = null;
  #disposed = false;

  constructor({ socketPath }) {
    this.#client = new HostControlClient({ socketPath });
    this.#client.onPush((message) => this.#onPush(message));
    this.#client.onClose(() => this.#onGone());
  }

  get socketPath() {
    return this.#client.socketPath;
  }

  get info() {
    return this.#info;
  }

  describe() {
    return `host ${this.#client.socketPath}`;
  }

  openFrameListener(listener) {
    this.#frames.add(listener);
    return () => this.#frames.delete(listener);
  }

  async open() {
    if (this.#disposed) throw new Error("the host backend was closed");
    await this.#client.connect();
    if (!this.#info) {
      this.#info = await this.#client.request("getInfo", {}, { timeoutMs: 5000 });
      this.#applyInfoState(this.#info?.state);
    }
    return this;
  }

  /**
   * `getInfo` carries the app's own snapshot of every space and tab. Only the
   * active tab of a space is usable here (a tab id means nothing until the
   * space it belongs to is known), but it is the baseline a reconnecting client
   * needs: routing a session-less frame to the tab the window is showing.
   */
  #applyInfoState(state) {
    for (const entry of state?.spaces ?? []) {
      const spaceId = entry?.spaceId;
      const activeTabId = entry?.activeTabId;
      if (typeof spaceId !== "string" || typeof activeTabId !== "string") continue;
      if (!this.#activeTabBySpace.has(spaceId)) this.#hostActiveTab.set(spaceId, activeTabId);
    }
  }

  close() {
    this.#disposed = true;
    for (const entry of this.#cdpPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("the host backend was closed"));
    }
    this.#cdpPending.clear();
    this.#client.close();
  }

  call(method, params = {}, options) {
    return this.#client.request(method, params, options);
  }

  // --- spaces ------------------------------------------------------------

  async createSpace(name, space) {
    await this.open();
    const created = await this.call("createSpace", { name });
    const spaceId = created?.spaceId;
    if (typeof spaceId !== "string" || spaceId === "") {
      throw new Error("createSpace returned no spaceId");
    }
    space.hostSpaceId = spaceId;
    this.#spaceByHostId.set(spaceId, space);
    // Standalone creates the context *and* its canonical blank tab in one go;
    // the app has no such op, so the tab is asked for here to keep the surface
    // identical (a new space must expose exactly one tab).
    let tab;
    try {
      tab = await this.call("createTab", { spaceId, url: "about:blank" });
    } catch (error) {
      // A space without its canonical tab is worse than no space at all.
      await this.call("closeSpace", { spaceId }).catch(() => {});
      space.hostSpaceId = null;
      throw error;
    }
    if (tab?.tabId) {
      this.#spaceByTab.set(tab.tabId, space);
      this.#activeTabBySpace.set(spaceId, tab.tabId);
    }
    return { spaceId, contextId: null };
  }

  async closeSpace(space) {
    await this.open();
    if (!space.hostSpaceId) return;
    await this.call("closeSpace", { spaceId: space.hostSpaceId });
    this.#forgetSpace(space);
  }

  /** Live space ids in the app; the bridge reaps rows whose space is gone. */
  async listSpaceIds() {
    await this.open();
    const result = await this.call("listSpaces");
    return (result?.spaces ?? []).map((entry) => entry.spaceId);
  }

  async handOff(space) {
    await this.call("handOff", { spaceId: this.#requireHostSpace(space) });
  }

  async takeOver(space) {
    await this.call("takeOver", { spaceId: this.#requireHostSpace(space) });
  }

  async setAgentTaskState(space, text) {
    await this.call("setAgentTaskState", {
      spaceId: this.#requireHostSpace(space),
      state: typeof text === "string" ? text : "",
    });
  }

  async highlightMouseTo(space, x, y) {
    await this.call("highlightMouseTo", {
      spaceId: this.#requireHostSpace(space),
      x: Math.round(x),
      y: Math.round(y),
    });
  }

  // --- tabs --------------------------------------------------------------

  async listTabs(space) {
    await this.open();
    this.#rememberSpace(space);
    const result = await this.call("listTabs", { spaceId: this.#requireHostSpace(space) });
    const activeTabId = result?.activeTabId ?? null;
    if (activeTabId) this.#activeTabBySpace.set(space.hostSpaceId, activeTabId);
    const subscription = this.#subscriptionFor(space);
    const tabs = [];
    for (const tab of result?.tabs ?? []) {
      this.#spaceByTab.set(tab.tabId, space);
      if (tab.openerTabId) {
        this.#openers.set(tab.tabId, {
          openerTabId: tab.openerTabId,
          windowName: tab.windowName ?? "",
        });
      }
      let info = null;
      try {
        info = await this.#targetInfoFor(tab.tabId);
      } catch {
        // The tab closed between listTabs and the target read: leave it out.
        continue;
      }
      this.#rememberTarget(tab.tabId, space, info);
      // The client has just been told about this target by this very list, so a
      // later `Target.targetCreated` for it would be a duplicate: the opener is
      // still reported here, and that is what page discovery adopts from.
      if (subscription && !subscription.announced.has(info.targetId)) {
        subscription.announced.set(info.targetId, "baseline");
      }
      const openerId = this.#openerTargetId(tab.openerTabId);
      tabs.push({
        tabId: tab.tabId,
        browserId: tab.browserId ?? tab.tabId,
        targetId: info.targetId,
        url: tab.url ?? "",
        title: tab.title ?? "",
        loading: Boolean(tab.loading),
        active: activeTabId ? tab.tabId === activeTabId : false,
        ...(openerId ? { openerId } : {}),
      });
    }
    return tabs;
  }

  async createTab(space, url) {
    await this.open();
    this.#rememberSpace(space);
    const created = await this.call("createTab", { spaceId: this.#requireHostSpace(space), url });
    const tabId = created?.tabId;
    if (typeof tabId !== "string" || tabId === "") {
      throw new Error("createTab returned no tabId");
    }
    this.#spaceByTab.set(tabId, space);
    this.#activeTabBySpace.set(space.hostSpaceId, tabId);
    const info = await this.#targetInfoFor(tabId, TARGET_RESOLVE_TIMEOUT_MS);
    this.#rememberTarget(tabId, space, info);
    return { tabId, browserId: created.browserId ?? tabId, targetId: info.targetId };
  }

  /** `target` is a DevTools target id (the surface only ever hands those out). */
  async activateTab(space, target) {
    this.#rememberSpace(space);
    const tabId = this.#tabForTarget(target) ?? (await this.#ensureTargetKnown(space, target)) ?? target;
    if (!this.#spaceByTab.has(tabId)) this.#spaceByTab.set(tabId, space);
    this.#activeTabBySpace.set(this.#requireHostSpace(space), tabId);
    await this.call("activateTab", {
      spaceId: this.#requireHostSpace(space),
      tabId,
    });
  }

  async closeTab(space, target) {
    this.#rememberSpace(space);
    const tabId = this.#tabForTarget(target) ?? (await this.#ensureTargetKnown(space, target)) ?? target;
    await this.call("closeTab", {
      spaceId: this.#requireHostSpace(space),
      tabId,
    });
    this.#closeAndForget(space, tabId);
  }

  // --- CDP ---------------------------------------------------------------

  /**
   * Send one harness frame. The frame keeps its `id` and `sessionId`; only the
   * browser it is delivered to is chosen here.
   */
  async sendRaw(space, text) {
    const frame = parseFrame(text);
    if (typeof frame?.params?.targetId === "string") {
      // A target the app knows but this process has not seen yet (a previous
      // bridge run persisted it): re-read the space's tabs before refusing.
      await this.#ensureTargetKnown(space, frame.params.targetId);
    }
    let tabId = this.#route(space, frame);
    if (!tabId) {
      // Reused space, fresh process: the tab ids are not known until the app is
      // asked, and a frame that names no session still has to reach a browser.
      await this.#refreshSpaceTabs(space);
      tabId = this.#route(space, frame);
    }
    if (!tabId) {
      this.#emitSynthetic(space, null, {
        id: frame?.id,
        error: { code: -32000, message: "no tab to send this command to in the task space" },
      });
      return;
    }
    await this.#sendFrame(space, tabId, frame, text);
  }

  async attach(space, targetId, tabId = null) {
    const browserTab = tabId ?? (await this.#ensureTargetKnown(space, targetId));
    if (!browserTab) {
      throw new Error(`cannot attach: ${targetId} is not a tab of this task space`);
    }
    const attached = await this.#cdpRequest(browserTab, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("Target.attachToTarget returned no sessionId");
    }
    this.#tabBySession.set(sessionId, browserTab);
    return sessionId;
  }

  /** Internal correlated call, addressed to one tab's browser. */
  async request(space, tabId, method, params = {}, sessionId = undefined) {
    const browserTab = this.#tabForTarget(tabId) ?? (await this.#ensureTargetKnown(space, tabId)) ?? tabId;
    return this.#cdpRequest(browserTab, method, params, sessionId);
  }

  /**
   * CDP targets this space may see, for snapshot's OOPIF discovery. Filtered to
   * the space's own request context: `Target.getTargets` is process-wide.
   */
  async targets(space, tabId) {
    const browserTab = this.#tabForTarget(tabId) ?? (await this.#ensureTargetKnown(space, tabId)) ?? tabId;
    const result = await this.#cdpRequest(browserTab, "Target.getTargets", {}).catch(() => null);
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    const contextId = this.#contextOf(space);
    const mine = infos.filter(
      (info) =>
        typeof info?.targetId === "string" &&
        (contextId === null || (info.browserContextId ?? null) === contextId),
    );
    for (const info of mine) {
      // Only ids we have not already attributed: `Target.getTargets` says
      // nothing about which tab a page target belongs to, so a known tab target
      // keeps its owner and only this tab's iframe targets are new here. A
      // *page* target is a tab of its own and must never be pinned on the tab
      // that happened to ask: attaching to it would go to the wrong browser.
      if (!this.#tabByTarget.has(info.targetId) && info.type !== "page") {
        this.#tabByTarget.set(info.targetId, browserTab);
      }
      if (!this.#spaceByTab.has(browserTab)) this.#spaceByTab.set(browserTab, space);
    }
    return mine;
  }

  // --- internals ---------------------------------------------------------

  #requireHostSpace(space) {
    const spaceId = space?.hostSpaceId;
    if (typeof spaceId !== "string" || spaceId === "") {
      throw new Error("this task space is not backed by the running app");
    }
    return spaceId;
  }

  /** Remember which host space a bridge space record belongs to. */
  #rememberSpace(space) {
    const hostSpaceId = space?.hostSpaceId;
    if (typeof hostSpaceId !== "string" || hostSpaceId === "") return null;
    this.#spaceByHostId.set(hostSpaceId, space);
    return hostSpaceId;
  }

  /** The `Target.setDiscoverTargets` subscription of a space, if a client made one. */
  #subscriptionFor(space) {
    const hostSpaceId = space?.hostSpaceId;
    if (typeof hostSpaceId !== "string" || hostSpaceId === "") return null;
    return this.#discover.get(hostSpaceId) ?? null;
  }

  /** The target id of an opener tab, when this process has already seen it. */
  #openerTargetId(openerTabId) {
    if (typeof openerTabId !== "string" || openerTabId === "") return null;
    return this.#targetByTab.get(openerTabId) ?? null;
  }

  /**
   * A target id this process has not seen yet is normally a persisted id from
   * an earlier run (the app kept the tab). Re-read the space's tabs once, at
   * most every half second, and answer with the owning tab id when it appears.
   */
  async #ensureTargetKnown(space, targetId) {
    const known = this.#tabForTarget(targetId);
    if (known) return known;
    await this.#refreshSpaceTabs(space);
    return this.#tabForTarget(targetId);
  }

  /**
   * Read a space's tab list, at most every half second. This is also what makes
   * a *reused* space routable: on a fresh process the tab ids are unknown until
   * the app is asked, and a frame that names no session still needs a browser.
   */
  async #refreshSpaceTabs(space) {
    if (!space?.hostSpaceId) return false;
    const now = Date.now();
    const last = this.#refreshedAt.get(space.hostSpaceId) ?? 0;
    if (now - last <= 500) return false;
    this.#refreshedAt.set(space.hostSpaceId, now);
    await this.listTabs(space).catch(() => {});
    return true;
  }

  #contextOf(space) {
    if (typeof space?.contextId === "string" && space.contextId !== "") return space.contextId;
    return null;
  }

  #tabForTarget(target) {
    if (typeof target !== "string") return null;
    return this.#tabByTarget.get(target) ?? null;
  }

  #rememberTarget(tabId, space, info) {
    if (typeof info?.targetId !== "string") return;
    this.#targetByTab.set(tabId, info.targetId);
    this.#infoByTab.set(tabId, info);
    this.#tabByTarget.set(info.targetId, tabId);
    if (space && !this.#spaceByTab.has(tabId)) this.#spaceByTab.set(tabId, space);
    if (
      space &&
      typeof info.browserContextId === "string" &&
      info.browserContextId !== "" &&
      space.contextId !== info.browserContextId
    ) {
      // The bridge filters `Target.*` traffic by this the same way standalone
      // mode filters by its browser-context id.
      space.contextId = info.browserContextId;
    }
  }

  /** True once a DevTools session exists for that tab (what `attached` means). */
  #tabAttached(tabId) {
    for (const owner of this.#tabBySession.values()) {
      if (owner === tabId) return true;
    }
    return false;
  }

  #forgetTab(tabId) {
    this.#spaceByTab.delete(tabId);
    this.#targetByTab.delete(tabId);
    this.#infoByTab.delete(tabId);
    this.#openers.delete(tabId);
    for (const [targetId, owner] of this.#tabByTarget) {
      if (owner === tabId) this.#tabByTarget.delete(targetId);
    }
    for (const [sessionId, owner] of this.#tabBySession) {
      if (owner === tabId) this.#tabBySession.delete(sessionId);
    }
    for (const subscription of this.#discover.values()) {
      if (subscription.sinkTabId === tabId) subscription.sinkTabId = null;
    }
  }

  #forgetSpace(space) {
    const hostSpaceId = space?.hostSpaceId;
    this.#activeTabBySpace.delete(hostSpaceId);
    this.#hostActiveTab.delete(hostSpaceId);
    this.#discover.delete(hostSpaceId);
    this.#spaceByHostId.delete(hostSpaceId);
    for (const [tabId, owner] of this.#spaceByTab) {
      if (owner === space || owner?.hostSpaceId === hostSpaceId) this.#forgetTab(tabId);
    }
  }

  /**
   * The app hung up. Every id in this file belongs to a host process that may
   * have restarted, so none of it survives: pending replies are failed now
   * rather than at their timeout, and the caches are dropped so the next call
   * rediscoveres tabs from the app itself.
   */
  #onGone() {
    for (const entry of this.#cdpPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error("the Rook app closed the control connection while a command was in flight"),
      );
    }
    this.#cdpPending.clear();
    this.#spaceByTab.clear();
    this.#spaceByHostId.clear();
    this.#tabByTarget.clear();
    this.#targetByTab.clear();
    this.#infoByTab.clear();
    this.#openers.clear();
    this.#tabBySession.clear();
    this.#activeTabBySpace.clear();
    this.#hostActiveTab.clear();
    this.#discover.clear();
    this.#refreshedAt.clear();
  }

  async #targetInfoFor(tabId, timeoutMs = 5000) {
    const cached = this.#infoByTab.get(tabId);
    if (cached) return cached;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        const result = await this.#cdpRequest(
          tabId,
          "Target.getTargetInfo",
          {},
          undefined,
          Math.max(1000, Math.min(4000, deadline - Date.now())),
        );
        const info = result?.targetInfo;
        if (typeof info?.targetId === "string" && info.targetId !== "") {
          this.#infoByTab.set(tabId, info);
          return info;
        }
        lastError = new Error("Target.getTargetInfo returned no targetId");
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await sleep(50);
    }
    throw new Error(
      `could not read the DevTools target of tab ${tabId}${lastError ? `: ${lastError.message}` : ""}`,
    );
  }

  #cdpRequest(tabId, method, params = {}, sessionId = undefined, timeoutMs = CDP_REQUEST_TIMEOUT_MS) {
    const id = this.#nextCdpId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cdpPending.delete(id);
        debug(`cdp ${method} on ${tabId} timed out after ${timeoutMs}ms`);
        reject(new Error(`${method} got no reply from the page within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#cdpPending.set(id, { resolve, reject, timer, method, tabId, startedAt });
      debug(`cdp -> ${tabId} ${method} #${id}`);
      this.#client
        .request("cdp.send", { browserId: tabId, message: JSON.stringify(frame) })
        .catch((error) => {
          if (!this.#cdpPending.has(id)) return;
          this.#cdpPending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  #route(space, frame) {
    if (!frame || typeof frame !== "object") return this.#activeTab(space);
    if (typeof frame.sessionId === "string") {
      const bySession = this.#tabBySession.get(frame.sessionId);
      if (bySession) return bySession;
    }
    const targetId = frame.params?.targetId;
    const byTarget = this.#tabForTarget(targetId);
    if (byTarget) return byTarget;
    return this.#activeTab(space);
  }

  #activeTab(space) {
    const spaceId = space?.hostSpaceId;
    const live = (tabId) => typeof tabId === "string" && this.#spaceByTab.has(tabId);
    if (spaceId && live(this.#activeTabBySpace.get(spaceId))) {
      return this.#activeTabBySpace.get(spaceId);
    }
    // A reconnecting client has read no tab list yet; the app's own `getInfo`
    // snapshot is the baseline the pushes continue from.
    if (spaceId && live(this.#hostActiveTab.get(spaceId))) {
      return this.#hostActiveTab.get(spaceId);
    }
    for (const [tabId, owner] of this.#spaceByTab) {
      if (owner === space || (spaceId && owner?.hostSpaceId === spaceId)) return tabId;
    }
    return null;
  }

  /**
   * Forward a frame, translating the three DevTools calls that would otherwise
   * bypass the app's own tab bookkeeping. Everything else goes as-is.
   */
  async #sendFrame(space, tabId, frame, text) {
    const method = typeof frame?.method === "string" ? frame.method : null;
    const hasId = frame && frame.id !== undefined;

    if (method === "Target.setDiscoverTargets") {
      // The app's own Target domain is process-wide but says nothing about
      // openers, so target lifecycle is re-synthesised from the host's tab
      // pushes (see #onTabCreated and friends). Track the subscription here so
      // nothing is emitted to a client that never asked for discovery, and keep
      // forwarding the call: CEF's own targetInfoChanged notifications are a
      // useful second source for a page that navigates itself.
      if (frame.params?.discover === false) {
        this.#discover.delete(space.hostSpaceId);
      } else if (frame.params?.discover === true && space.hostSpaceId) {
        const announced = new Map();
        for (const [knownTabId, targetId] of this.#targetByTab) {
          const owner = this.#spaceByTab.get(knownTabId);
          if (owner === space || owner?.hostSpaceId === space.hostSpaceId) {
            announced.set(targetId, "baseline");
          }
        }
        this.#discover.set(space.hostSpaceId, {
          sinkTabId: tabId,
          announced,
          lastInfo: new Map(),
          destroyed: new Set(),
        });
      }
      await this.#sendToBrowser(space, tabId, text);
      return;
    }

    if (method === "Target.createTarget") {
      if (!hasId) return;
      this.#emitSynthetic(space, tabId, {
        id: frame.id,
        error: {
          code: -32601,
          message:
            "Target.createTarget is not available in host mode: a DevTools-created browser is owned by no tab, so create tabs through createTab()",
        },
      });
      return;
    }

    if (method === "Target.activateTarget" && hasId) {
      const target = frame.params?.targetId;
      const owner = this.#tabForTarget(target);
      if (owner && owner === tabId) {
        await this.call("activateTab", {
          spaceId: this.#requireHostSpace(space),
          tabId: owner,
        }).catch(() => {});
        this.#activeTabBySpace.set(space.hostSpaceId, owner);
        this.#emitSynthetic(space, tabId, { id: frame.id, result: {} });
        return;
      }
      // Not ours: refuse instead of moving another space's page.
      this.#emitSynthetic(space, tabId, {
        id: frame.id,
        error: { code: -32602, message: "no such target in this task space" },
      });
      return;
    }

    if (method === "Target.closeTarget" && hasId) {
      const target = frame.params?.targetId;
      const owner = this.#tabForTarget(target);
      if (owner) {
        try {
          await this.call("closeTab", {
            spaceId: this.#requireHostSpace(space),
            tabId: owner,
          });
          this.#closeAndForget(space, owner);
          this.#emitSynthetic(space, tabId, { id: frame.id, result: { success: true } });
        } catch (error) {
          this.#emitSynthetic(space, tabId, {
            id: frame.id,
            error: { code: -32000, message: error?.message || String(error) },
          });
        }
        return;
      }
      this.#emitSynthetic(space, tabId, {
        id: frame.id,
        error: { code: -32602, message: "no such target in this task space" },
      });
      return;
    }

    if (method === "Target.attachToTarget") {
      const target = frame.params?.targetId;
      if (!this.#tabForTarget(target)) {
        // A popup the app has just opened is the usual reason for this: its tab
        // is in the space's tab list before this process has read the target id.
        await this.#ensureTargetKnown(space, target).catch(() => {});
      }
      if (!this.#tabForTarget(target)) {
        // Still unknown: the target may be one of this space's iframes.
        await this.targets(space, tabId).catch(() => {});
      }
      const owner = this.#tabForTarget(target);
      if (!owner) {
        if (hasId) {
          this.#emitSynthetic(space, tabId, {
            id: frame.id,
            error: { code: -32602, message: "no such target in this task space" },
          });
        }
        return;
      }
      await this.#sendToBrowser(space, owner, text);
      return;
    }

    if (method === "Target.getTargetInfo" && frame.params?.targetId !== undefined) {
      if (!this.#tabForTarget(frame.params.targetId)) {
        this.#emitSynthetic(space, tabId, {
          id: frame.id,
          error: { code: -32602, message: "no such target in this task space" },
        });
        return;
      }
    }

    await this.#sendToBrowser(space, tabId, text);
  }

  async #sendToBrowser(space, tabId, text) {
    try {
      await this.#client.request("cdp.send", { browserId: tabId, message: text });
    } catch (error) {
      const frame = parseFrame(text);
      if (frame && frame.id !== undefined) {
        this.#emitSynthetic(space, tabId, {
          id: frame.id,
          error: { code: -32002, message: error?.message || String(error) },
        });
      }
    }
  }

  #emitSynthetic(space, tabId, payload) {
    const text = JSON.stringify(payload);
    for (const listener of this.#frames) {
      try {
        listener({ space, tabId, data: payload, text });
      } catch {
        // ignore
      }
    }
  }

  #onPush(message) {
    if (!message || typeof message !== "object") return;
    const method = message.method;
    if (method === "cdp.event" || method === "cdp.error") {
      this.#onCdpPush(method, message.params ?? {});
      return;
    }
    if (typeof method === "string" && LIFECYCLE_PUSHES.has(method)) {
      this.#onLifecyclePush(method, message.params ?? {});
    }
  }

  #onCdpPush(method, params) {
    const browserId = params.browserId;
    const tabId = typeof browserId === "string" ? browserId : null;
    const space = tabId ? this.#spaceByTab.get(tabId) ?? null : null;

    if (method === "cdp.error") {
      for (const listener of this.#frames) {
        try {
          listener({
            kind: "error",
            space,
            tabId,
            code: params.code,
            message: params.message,
          });
        } catch {
          // ignore
        }
      }
      return;
    }

    const raw = params.message;
    if (typeof raw !== "string") return;
    const data = parseFrame(raw);
    if (!data) return;

    // A session always belongs to the browser it was attached to. Record it from
    // any frame that names one — an `Target.attachToTarget` reply carries the new
    // id in `result.sessionId`, and every later reply echoes it — so harness
    // frames that only carry a `sessionId` can still be routed to the right tab.
    if (tabId) {
      if (typeof data.sessionId === "string") this.#tabBySession.set(data.sessionId, tabId);
      if (typeof data.result?.sessionId === "string") {
        this.#tabBySession.set(data.result.sessionId, tabId);
      }
    }

    if (data.id !== undefined && data.id >= INTERNAL_ID_BASE) {
      // Only a tab this process knows about: pushes are broadcast to every
      // client, so an internal id from another bridge process must not resolve
      // a request of ours (both processes start at the same id base).
      if (!tabId || !this.#spaceByTab.has(tabId)) return;
      const entry = this.#cdpPending.get(data.id);
      if (!entry) return;
      this.#cdpPending.delete(data.id);
      clearTimeout(entry.timer);
      debug(
        `cdp <- ${tabId} ${entry.method} #${data.id} ${Date.now() - entry.startedAt}ms${data.error ? " (error)" : ""}`,
      );
      if (data.error) {
        const error = new Error(data.error.message || `CDP error ${data.error.code}`);
        error.cdp = data.error;
        entry.reject(error);
      } else {
        entry.resolve(data.result ?? {});
      }
      return;
    }

    // Keep the session/target bookkeeping the bridge's isolation rules need.
    if (data.method === "Target.attachedToTarget") {
      const sessionId = data.params?.sessionId;
      const targetId = data.params?.targetInfo?.targetId;
      if (typeof sessionId === "string" && tabId) this.#tabBySession.set(sessionId, tabId);
      if (typeof targetId === "string" && tabId) this.#tabByTarget.set(targetId, tabId);
    } else if (data.method === "Target.detachedFromTarget") {
      const sessionId = data.params?.sessionId;
      if (typeof sessionId === "string") this.#tabBySession.delete(sessionId);
    } else if (data.method === "Target.targetDestroyed") {
      const targetId = data.params?.targetId;
      if (typeof targetId === "string") {
        this.#tabByTarget.delete(targetId);
        // Already replaced by the event synthesised from `tab.closed`: a client
        // that was told once must not be told twice.
        if (this.#consumedCefEvent(space, "Target.targetDestroyed", targetId)) return;
      }
    } else if (data.method === "Target.targetCreated") {
      const targetId = data.params?.targetInfo?.targetId;
      if (typeof targetId === "string" && this.#consumedCefEvent(space, "Target.targetCreated", targetId)) {
        return;
      }
    } else if (data.method === "Target.targetInfoChanged") {
      const info = data.params?.targetInfo;
      if (info && typeof info.targetId === "string") {
        const subscription = this.#subscriptionFor(space);
        // CEF is the authoritative source for a navigation it drove itself;
        // remembering it keeps #onTabUpdated from repeating the same keys.
        subscription?.lastInfo.set(info.targetId, {
          url: info.url ?? "",
          title: info.title ?? "",
          type: info.type ?? "page",
        });
      }
    }

    for (const listener of this.#frames) {
      try {
        listener({ space, tabId, data, text: raw });
      } catch {
        // ignore
      }
    }
  }

  // --- host lifecycle pushes -> DevTools target lifecycle -----------------

  /**
   * The app knows which tab a popup belongs to (CEF's `OnBeforePopup` runs on
   * the opener) and this file knows which tab is which DevTools target, so the
   * pair is enough to synthesise the target relationship the SDK attributes
   * popups by. `window.opener` inside the popup is still null: the popup browser
   * CEF would have made is cancelled, so only the protocol event is real
   * (host/README.md, "What popup attribution really is").
   */
  #onLifecyclePush(method, params) {
    const hostSpaceId = params.spaceId;
    if (typeof hostSpaceId !== "string" || hostSpaceId === "") return;
    const tabId = typeof params.tabId === "string" ? params.tabId : null;

    switch (method) {
      case "space.created": {
        // Only remembered: a space this process did not create has no record to
        // attach to, and one that it did already has its hostSpaceId.
        return;
      }
      case "space.closed": {
        const space = this.#spaceByHostId.get(hostSpaceId);
        if (space) this.#forgetSpace(space);
        else this.#discover.delete(hostSpaceId);
        return;
      }
      case "tab.created": {
        if (!tabId) return;
        const space = this.#spaceByHostId.get(hostSpaceId);
        if (!space) return; // another bridge process's space, or the user's "You"
        this.#spaceByTab.set(tabId, space);
        if (typeof params.openerTabId === "string" && params.openerTabId !== "") {
          this.#openers.set(tabId, {
            openerTabId: params.openerTabId,
            windowName: typeof params.windowName === "string" ? params.windowName : "",
          });
          void this.#announceTarget(space, tabId).catch(() => {});
        }
        return;
      }
      case "tab.closed": {
        if (!tabId) return;
        const space = this.#spaceByTab.get(tabId) ?? this.#spaceByHostId.get(hostSpaceId) ?? null;
        this.#closeAndForget(space, tabId);
        return;
      }
      case "tab.activated": {
        if (!tabId) return;
        this.#activeTabBySpace.set(hostSpaceId, tabId);
        return;
      }
      case "tab.updated": {
        if (!tabId) return;
        const space = this.#spaceByTab.get(tabId) ?? this.#spaceByHostId.get(hostSpaceId) ?? null;
        if (!space) return;
        void this.#announceTargetInfo(space, tabId, params).catch(() => {});
        return;
      }
      default:
        return;
    }
  }

  /**
   * Resolve a tab's DevTools target and tell the client it appeared, carrying
   * the opener the app reported. Skipped when the client already knows the
   * target (a `listTabs` baseline, or an earlier announcement).
   */
  async #announceTarget(space, tabId) {
    const subscription = this.#subscriptionFor(space);
    if (!subscription) return;
    let info;
    try {
      info = await this.#targetInfoFor(tabId, TARGET_RESOLVE_TIMEOUT_MS);
    } catch {
      // The browser never appeared (the tab was closed again): nothing to say.
      debug(`popup ${tabId}: no DevTools target, nothing to announce`);
      return;
    }
    this.#rememberTarget(tabId, space, info);
    if (subscription.announced.has(info.targetId)) return;

    const opener = this.#openers.get(tabId);
    let openerId = this.#openerTargetId(opener?.openerTabId);
    if (!openerId && opener?.openerTabId) {
      // Usually already known; the opener can be a tab this process has not
      // read yet on a reconnecting run.
      openerId = await this.#resolveTabTarget(space, opener.openerTabId);
    }
    if (!openerId) return; // no attribution is better than a guessed one

    const targetInfo = {
      ...info,
      type: "page",
      title: info.title ?? "",
      url: info.url ?? "",
      attached: this.#tabAttached(tabId),
      canAccessOpener: true,
      openerId,
    };
    subscription.announced.set(info.targetId, "synthesized");
    subscription.lastInfo.set(info.targetId, {
      url: targetInfo.url,
      title: targetInfo.title,
      type: "page",
    });
    // Keep the enriched view: a later `tab.updated` must not lose the opener.
    this.#infoByTab.set(tabId, targetInfo);
    this.#emitTargetEvent(space, "Target.targetCreated", { targetInfo });
  }

  /** `tab.updated` (url and/or title) as `Target.targetInfoChanged`. */
  async #announceTargetInfo(space, tabId, params) {
    if (!space) return;
    const subscription = this.#subscriptionFor(space);
    if (!subscription) return;
    const known = this.#infoByTab.get(tabId) ?? (await this.#targetInfoFor(tabId).catch(() => null));
    if (!known?.targetId) return;
    if (!subscription.announced.has(known.targetId)) {
      // The client was never told about this target: `targetCreated` comes from
      // #announceTarget (a popup) or from its own createTab, so a change event
      // for it would name a target the client has no reason to know.
      return;
    }
    const targetInfo = {
      ...known,
      type: "page",
      url: typeof params.url === "string" ? params.url : known.url ?? "",
      title: typeof params.title === "string" ? params.title : known.title ?? "",
      attached: this.#tabAttached(tabId),
      ...(known.openerId ? { canAccessOpener: true } : {}),
    };
    const previous = subscription.lastInfo.get(known.targetId);
    const changed =
      !previous ||
      previous.url !== targetInfo.url ||
      previous.title !== targetInfo.title ||
      previous.type !== "page";
    if (!changed) return;
    this.#infoByTab.set(tabId, targetInfo);
    subscription.lastInfo.set(known.targetId, {
      url: targetInfo.url,
      title: targetInfo.title,
      type: "page",
    });
    this.#emitTargetEvent(space, "Target.targetInfoChanged", { targetInfo });
  }

  /** One synthesised Target event, on the tab whose browser subscribed. */
  #emitTargetEvent(space, method, params) {
    const subscription = this.#subscriptionFor(space);
    if (!subscription) return;
    // A sink that is no longer a live tab would go to a closed browser, so the
    // space's current tab takes over (the event is space-scoped either way).
    const sink =
      (subscription.sinkTabId && this.#spaceByTab.has(subscription.sinkTabId)
        ? subscription.sinkTabId
        : null) ?? this.#activeTab(space);
    if (!sink) return;
    if (method === "Target.targetDestroyed") {
      const targetId = params?.targetId;
      if (typeof targetId === "string") {
        subscription.announced.delete(targetId);
        subscription.destroyed.add(targetId);
      }
    }
    debug(`${method} -> ${sink} ${describeTargetEvent(params)}`);
    this.#emitSynthetic(space, sink, { method, params });
  }

  /**
   * A tab this process closed: the `tab.closed` push may arrive after the reply
   * that closed it, and by then the tab is already forgotten here, so the one
   * `Target.targetDestroyed` a client gets for it is emitted on the way out.
   * The tab is forgotten first so the event cannot be sent to its dead browser.
   */
  #closeAndForget(space, tabId) {
    const targetId = this.#targetByTab.get(tabId) ?? null;
    this.#forgetTab(tabId);
    if (targetId) this.#emitTargetEvent(space, "Target.targetDestroyed", { targetId });
  }

  /** True when this target's lifecycle event was already emitted by us. */
  #consumedCefEvent(space, method, targetId) {
    const subscription = this.#subscriptionFor(space);
    if (!subscription) return false;
    if (method === "Target.targetCreated") {
      return subscription.announced.get(targetId) === "synthesized";
    }
    if (method === "Target.targetDestroyed") return subscription.destroyed.has(targetId);
    return false;
  }

  async #resolveTabTarget(space, tabId) {
    const known = this.#openerTargetId(tabId);
    if (known) return known;
    try {
      const info = await this.#targetInfoFor(tabId, TARGET_RESOLVE_TIMEOUT_MS);
      this.#rememberTarget(tabId, space, info);
      return info.targetId;
    } catch {
      return null;
    }
  }
}

function parseFrame(text) {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
