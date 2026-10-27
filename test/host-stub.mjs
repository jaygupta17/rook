/**
 * A stand-in for the native app's control socket, for tests that must run
 * without CEF: newline-delimited JSON-RPC 2.0 over a unix socket with the same
 * ops, pushes and error codes as `host/src/control_rpc.cc` documents.
 *
 * It speaks **protocol 3** (host/README.md): a profile is one request context
 * and the storage boundary (every space of a profile shares its cookies and
 * `localStorage`), a space is a tab set inside a profile, and a handoff puts the
 * user in control — agent mutations are refused with
 * `EGO_TASK_SPACE_USER_IN_CONTROL` while reads keep working.
 *
 * It keeps just enough page state to answer the CDP calls the bridge makes on
 * its own (`Target.getTargetInfo`, `Target.getTargets`, `Target.attachToTarget`)
 * and a tiny `Runtime.evaluate` vocabulary (`localStorage`, `document.cookie`)
 * so storage sharing within a profile — and isolation between profiles — can be
 * asserted through the bridge. Everything else is passed through untouched.
 */
import { createServer } from "node:net";
import { rm } from "node:fs/promises";

let sequence = 0;

const DEFAULT_PROFILE_ID = "default";
const USER_IN_CONTROL = "EGO_TASK_SPACE_USER_IN_CONTROL";

function makeProfile(id, name, isDefault) {
  return {
    id,
    name,
    isDefault,
    path: `profiles/${id}`,
    /** The profile's one storage tree: every space of it reads these. */
    storage: { cookies: new Map(), local: new Map() },
  };
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "profile" : slug;
}

function cookieHeader(storage) {
  return [...storage.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function setCookie(storage, header) {
  const pair = String(header).split(";")[0] ?? "";
  const equals = pair.indexOf("=");
  if (equals <= 0) return;
  const name = pair.slice(0, equals).trim();
  if (name === "") return;
  storage.cookies.set(name, pair.slice(equals + 1).trim());
}

export class StubHost {
  constructor({
    socketPath,
    pid = null,
    firstSpaceNumber = 1,
    defaultProfileId = DEFAULT_PROFILE_ID,
    profileName = "You",
  } = {}) {
    this.socketPath = socketPath;
    /** What `getInfo` reports as the app process: two stubs = two app runs. */
    this.pid = Number.isInteger(pid) ? pid : process.pid;
    this.spaces = new Map();
    this.tabs = new Map();
    this.profiles = new Map();
    this.defaultProfileId = defaultProfileId;
    this.profiles.set(defaultProfileId, makeProfile(defaultProfileId, profileName, true));
    this.calls = [];
    this.frames = [];
    this.sockets = new Set();
    this.server = null;
    this.#nextSpace = firstSpaceNumber;
    this.#nextTab = 1;
    this.#nextProfile = 1;
  }

  #nextSpace;
  #nextTab;
  #nextProfile;
  /** browserId -> [{id, method, params, sessionId}] what the bridge asked for. */
  cdpFrames = [];
  /**
   * CDP methods the stub records but never answers, for requests that must be
   * caught in flight (a page stuck on a script, a tab closed mid-command).
   * test/tab-close.mjs is the caller.
   */
  holdMethods = new Set();

  async start() {
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) void this.#handleLine(socket, line);
        }
      });
      socket.on("error", () => this.sockets.delete(socket));
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    return this;
  }

  async stop({ unlink = true } = {}) {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    if (unlink) await rm(this.socketPath, { force: true });
  }

  /** Push a notification to every connected client, as the host broadcasts. */
  push(method, params) {
    const frame = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    for (const socket of this.sockets) socket.write(frame);
  }

  emitEvent(browserId, message) {
    this.push("cdp.event", { browserId, message });
  }

  /** A profile as `createProfile`/`listProfiles` reports it (`path` included). */
  addProfile(name) {
    const base = slugify(name);
    let id = base;
    for (let suffix = 2; this.profiles.has(id); suffix += 1) id = `${base}-${suffix}`;
    this.profiles.set(id, makeProfile(id, name, false));
    return id;
  }

  /**
   * A space. `profileId` decides its storage; `user` marks the "You" space,
   * which the agent may never drive.
   */
  addSpace(name, { profileId = this.defaultProfileId, user = false } = {}) {
    const spaceId = `sp${this.#nextSpace++}`;
    this.spaces.set(spaceId, {
      spaceId,
      name,
      user,
      ownership: "agent",
      agentState: "",
      profileId,
      activeTabId: null,
    });
    return spaceId;
  }

  /** What the window does when the user takes over — no request involved. */
  handOff(spaceId) {
    const space = this.spaces.get(spaceId);
    if (!space) return false;
    space.ownership = "user";
    this.push("control.changed", { spaceId, state: "user" });
    return true;
  }

  takeOver(spaceId) {
    const space = this.spaces.get(spaceId);
    if (!space) return false;
    space.ownership = "agent";
    this.push("control.changed", { spaceId, state: "agent" });
    return true;
  }

  addTab(spaceId, { url = "about:blank", title = "", openerTabId = "", windowName = "" } = {}) {
    const tabId = `tb${this.#nextTab++}`;
    const space = this.spaces.get(spaceId);
    const profileId = space?.profileId ?? this.defaultProfileId;
    const tab = {
      tabId,
      browserId: tabId,
      spaceId,
      profileId,
      url,
      title,
      loading: false,
      // One tab is one CEF browser: the browser id and the page target id are
      // different ids, and only the app knows the mapping. The request context
      // belongs to the *profile*, not the space.
      targetId: `T-${tabId}`,
      contextId: `CTX-${profileId}`,
      openerTabId,
      windowName,
    };
    this.tabs.set(tabId, tab);
    if (space && !space.activeTabId) space.activeTabId = tabId;
    return tab;
  }

  #profileName(profileId) {
    return this.profiles.get(profileId)?.name ?? "";
  }

  #spaceJson(spaceId) {
    const space = this.spaces.get(spaceId);
    const tabs = [...this.tabs.values()].filter((tab) => tab.spaceId === spaceId);
    return {
      spaceId: space.spaceId,
      name: space.name,
      user: space.user,
      active: spaceId === [...this.spaces.keys()][0],
      ownership: space.ownership,
      agentState: space.agentState,
      profileId: space.profileId,
      profileName: this.#profileName(space.profileId),
      // The profile's storage dir: every space of the profile reads this one.
      cache: this.profiles.get(space.profileId)?.path ?? "",
      tabCount: tabs.length,
      activeTabId: space.activeTabId,
    };
  }

  #profileJson(profile) {
    return {
      id: profile.id,
      name: profile.name,
      isDefault: profile.isDefault,
      path: profile.path,
    };
  }

  /**
   * The mutation gate (host/README.md "Handoff"): the user's own space and a
   * handed-off space refuse agent writes; reads never come here.
   */
  #guard(spaceId, code = -32001) {
    const space = this.spaces.get(spaceId);
    if (!space) {
      return { code: -32001, message: `no space ${spaceId}`, reason: "EGO_TASK_SPACE_NOT_FOUND" };
    }
    if (space.user) {
      return {
        code,
        message: `the "You" space belongs to the user; the agent cannot drive it`,
        reason: USER_IN_CONTROL,
      };
    }
    if (space.ownership !== "agent") {
      return {
        code,
        message: `space ${spaceId} is handed off to the user; the agent cannot drive it until takeOver`,
        reason: USER_IN_CONTROL,
      };
    }
    return null;
  }

  #account(method) {
    this.calls.push(method);
  }

  async #handleLine(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      socket.write(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}\n',
      );
      return;
    }
    const id = message.id;
    const reply = (payload) => {
      if (id === undefined) return;
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
    };
    const fail = (code, errorMessage, reason = null) =>
      reply({
        error: {
          code,
          message: errorMessage,
          ...(reason ? { data: { reason } } : {}),
        },
      });
    const denied = (refusal) => fail(refusal.code, refusal.message, refusal.reason);
    const method = message.method;
    const params = message.params ?? {};
    this.#account(method);

    if (method === "getInfo") {
      return reply({
        result: {
          version: "0.4.0-M4",
          protocol: "3",
          pid: this.pid,
          state: {
            spaces: [...this.spaces.keys()].map((spaceId) => this.#spaceJson(spaceId)),
            activeSpaceId: [...this.spaces.keys()][0] ?? null,
          },
        },
      });
    }
    if (method === "listProfiles") {
      return reply({
        result: {
          defaultProfileId: this.defaultProfileId,
          profiles: [...this.profiles.values()].map((profile) => this.#profileJson(profile)),
        },
      });
    }
    if (method === "createProfile") {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (name === "") return fail(-32602, "createProfile needs a non-empty string 'name'");
      if ([...this.profiles.values()].some((profile) => profile.name === name)) {
        return fail(-32001, `a profile named ${JSON.stringify(name)} already exists`, "EGO_INVALID_ARGUMENT");
      }
      const profileId = this.addProfile(name);
      return reply({ result: { profileId, name, isDefault: false } });
    }
    if (method === "listSpaces") {
      return reply({
        result: {
          spaces: [...this.spaces.keys()].map((spaceId) => this.#spaceJson(spaceId)),
          activeSpaceId: [...this.spaces.keys()][0] ?? null,
        },
      });
    }
    if (method === "createSpace") {
      const name = params.name ?? "space";
      const profileId =
        typeof params.profileId === "string" && params.profileId !== ""
          ? params.profileId
          : this.defaultProfileId;
      if (!this.profiles.has(profileId)) {
        return fail(-32001, `no profile ${profileId}`, "EGO_TASK_SPACE_NOT_FOUND");
      }
      const spaceId = this.addSpace(name, { profileId });
      this.push("space.created", { spaceId, name, profileId });
      return reply({ result: { spaceId, name, profileId } });
    }
    if (method === "closeSpace") {
      const deniedClose = this.#guard(params.spaceId);
      if (deniedClose) return denied(deniedClose);
      this.spaces.delete(params.spaceId);
      for (const [tabId, tab] of [...this.tabs]) {
        if (tab.spaceId === params.spaceId) this.tabs.delete(tabId);
      }
      this.push("space.closed", { spaceId: params.spaceId });
      return reply({ result: { spaceId: params.spaceId, closed: true } });
    }
    if (method === "listTabs") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      const tabs = [...this.tabs.values()].filter((tab) => tab.spaceId === params.spaceId);
      return reply({
        result: {
          spaceId: params.spaceId,
          name: space.name,
          ownership: space.ownership,
          profileId: space.profileId,
          profileName: this.#profileName(space.profileId),
          activeTabId: space.activeTabId,
          tabs: tabs.map((tab) => ({
            tabId: tab.tabId,
            browserId: tab.browserId,
            title: tab.title,
            url: tab.url,
            active: tab.tabId === space.activeTabId,
            loading: tab.loading,
            openerTabId: tab.openerTabId,
            windowName: tab.windowName,
          })),
        },
      });
    }
    if (method === "createTab") {
      const deniedCreate = this.#guard(params.spaceId);
      if (deniedCreate) return denied(deniedCreate);
      const tab = this.addTab(params.spaceId, { url: params.url ?? "about:blank" });
      this.spaces.get(params.spaceId).activeTabId = tab.tabId;
      this.push("tab.created", {
        spaceId: params.spaceId,
        tabId: tab.tabId,
        url: tab.url,
      });
      return reply({
        result: { spaceId: params.spaceId, tabId: tab.tabId, browserId: tab.browserId, url: tab.url },
      });
    }
    if (method === "activateTab") {
      const deniedActivate = this.#guard(params.spaceId);
      if (deniedActivate) return denied(deniedActivate);
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      if (!this.tabs.has(params.tabId)) return fail(-32001, `unknown tab ${params.tabId}`);
      space.activeTabId = params.tabId;
      this.push("tab.activated", { spaceId: params.spaceId, tabId: params.tabId });
      return reply({ result: { spaceId: params.spaceId, tabId: params.tabId, active: true } });
    }
    if (method === "closeTab") {
      const deniedCloseTab = this.#guard(params.spaceId);
      if (deniedCloseTab) return denied(deniedCloseTab);
      if (!this.tabs.has(params.tabId)) return fail(-32001, `unknown tab ${params.tabId}`);
      this.tabs.delete(params.tabId);
      const space = this.spaces.get(params.spaceId);
      if (space?.activeTabId === params.tabId) {
        space.activeTabId =
          [...this.tabs.values()].find((tab) => tab.spaceId === params.spaceId)?.tabId ?? null;
      }
      this.push("tab.closed", { spaceId: params.spaceId, tabId: params.tabId });
      return reply({ result: { spaceId: params.spaceId, tabId: params.tabId, closed: true } });
    }
    if (method === "navigate") {
      const tab = this.tabs.get(params.tabId);
      if (!tab) return fail(-32001, `unknown tab ${params.tabId}`);
      const deniedNavigate = this.#guard(tab.spaceId);
      if (deniedNavigate) return denied(deniedNavigate);
      tab.url = params.url;
      this.push("tab.updated", { spaceId: tab.spaceId, tabId: tab.tabId, url: tab.url });
      return reply({ result: { tabId: tab.tabId, url: tab.url } });
    }
    if (method === "handOff" || method === "takeOver") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      if (space.user) return fail(-32001, `the "You" space is always the user's`);
      const changed = method === "handOff" ? this.handOff(params.spaceId) : this.takeOver(params.spaceId);
      if (!changed) return fail(-32001, `unknown space ${params.spaceId}`);
      return reply({
        result: { spaceId: params.spaceId, ownership: method === "handOff" ? "user" : "agent" },
      });
    }
    if (method === "setAgentTaskState") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      space.agentState = params.state;
      return reply({ result: { spaceId: params.spaceId, agentState: space.agentState } });
    }
    if (method === "highlightMouseTo") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      if (space.ownership !== "agent") {
        return fail(
          -32001,
          `space ${params.spaceId} is handed off to the user; the agent cannot drive it until takeOver`,
          USER_IN_CONTROL,
        );
      }
      return reply({ result: { spaceId: params.spaceId, x: params.x, y: params.y } });
    }
    if (method === "cdp.send") {
      const tab = this.tabs.get(params.browserId);
      if (!tab) return fail(-32002, `unknown browser ${params.browserId}`);
      let frame;
      try {
        frame = JSON.parse(params.message);
      } catch {
        return fail(-32002, "cdp.send needs a JSON message");
      }
      const deniedSend = this.#guard(tab.spaceId, -32002);
      if (deniedSend) {
        // The app does both: the notification the bridge's
        // onSendCDPMessageError needs, and a correlated error reply.
        this.push("cdp.error", {
          browserId: params.browserId,
          code: -32002,
          message: deniedSend.message,
          ...(deniedSend.reason ? { reason: deniedSend.reason } : {}),
        });
        return denied(deniedSend);
      }
      this.cdpFrames.push({ browserId: params.browserId, ...frame });
      // The host takes the frame and says so; the page answers later, as a push.
      reply({ result: { browserId: params.browserId, accepted: true } });
      queueMicrotask(() => this.#answerCdp(tab, frame, params.browserId));
      return undefined;
    }
    return fail(-32601, `unknown method ${method}`);
  }

  #answerCdp(tab, frame, browserId) {
    // A held method is recorded and deliberately never answered.
    if (this.holdMethods.has(frame.method)) return;
    const respond = (payload) => {
      this.emitEvent(browserId, JSON.stringify({ id: frame.id, ...payload }));
    };
    const method = frame.method;
    if (method === "Target.getTargetInfo") {
      const info = this.#targetInfo(tab);
      respond({ result: { targetInfo: info } });
      return;
    }
    if (method === "Target.getTargets") {
      // Process-wide, like CEF: other pages are visible, whatever space or
      // profile they belong to. Space filtering is the host's `listTabs`.
      const targetInfos = [...this.tabs.values()].map((other) => this.#targetInfo(other));
      targetInfos.push({
        targetId: "T-foreign-page",
        type: "page",
        url: "http://other-profile.invalid/",
        browserContextId: "CTX-other",
      });
      targetInfos.push({
        targetId: "T-iframe",
        type: "iframe",
        url: "http://127.0.0.1/frame",
        parentId: tab.targetId,
        browserContextId: tab.contextId,
      });
      respond({ result: { targetInfos } });
      return;
    }
    if (method === "Target.attachToTarget") {
      respond({ result: { sessionId: `S-${frame.params.targetId}` } });
      return;
    }
    if (method === "Runtime.evaluate") {
      respond({ result: { result: { type: "string", value: this.#evaluate(tab, frame.params?.expression) } } });
      return;
    }
    respond({ result: {} });
  }

  /**
   * A deliberate slice of the DOM: storage is the one thing a profile decides,
   * so `document.cookie` and `localStorage` answer from the *profile's* store.
   * Anything else stays the inert "stub" the pass-through test expects.
   */
  #evaluate(tab, expression) {
    const storage = this.profiles.get(tab.profileId)?.storage;
    if (!storage) return "stub";
    const expr = String(expression ?? "").trim();
    const get = /^localStorage\.getItem\((['"])(.*?)\1\)$/.exec(expr);
    if (get) return storage.local.get(get[2]) ?? null;
    const set = /^localStorage\.setItem\((['"])(.*?)\1\s*,\s*(['"])(.*?)\3\)$/.exec(expr);
    if (set) {
      storage.local.set(set[2], set[4]);
      return null;
    }
    if (expr === "document.cookie") return cookieHeader(storage);
    const put = /^document\.cookie\s*=\s*(['"])(.*?)\1(?:\s*,\s*(['"])(.*?)\3)?$/.exec(expr);
    if (put) {
      setCookie(storage, put[2]);
      return put[2];
    }
    return "stub";
  }

  #targetInfo(tab) {
    return {
      targetId: tab.targetId,
      type: "page",
      title: tab.title,
      url: tab.url,
      attached: false,
      // CEF cannot say otherwise for an adopted popup, so neither does the stub;
      // the bridge is what has to add the attribution.
      canAccessOpener: false,
      browserContextId: tab.contextId,
    };
  }

  countCalls(method) {
    return this.calls.filter((name) => name === method).length;
  }

  framesFor(browserId, method) {
    return this.cdpFrames.filter(
      (frame) => frame.browserId === browserId && (!method || frame.method === method),
    );
  }
}

/** One tab id that never exists, for "the app does not know this browser" tests. */
export function unknownTabId() {
  sequence += 1;
  return `tb-missing-${sequence}`;
}
