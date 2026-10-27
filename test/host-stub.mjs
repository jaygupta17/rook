/**
 * A stand-in for the native app's control socket, for tests that must run
 * without CEF: newline-delimited JSON-RPC 2.0 over a unix socket with the same
 * ops, pushes and error codes as host/src/control_rpc.cc documents.
 *
 * It keeps just enough page state to answer the CDP calls the bridge makes on
 * its own (`Target.getTargetInfo`, `Target.getTargets`, `Target.attachToTarget`)
 * and to prove that everything else is passed through untouched.
 */
import { createServer } from "node:net";
import { rm } from "node:fs/promises";

let sequence = 0;

export class StubHost {
  constructor({ socketPath }) {
    this.socketPath = socketPath;
    this.spaces = new Map();
    this.tabs = new Map();
    this.calls = [];
    this.frames = [];
    this.sockets = new Set();
    this.server = null;
    this.#nextSpace = 1;
    this.#nextTab = 1;
  }

  #nextSpace;
  #nextTab;
  /** browserId -> [{id, method, params, sessionId}] what the bridge asked for. */
  cdpFrames = [];

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

  addSpace(name) {
    const spaceId = `sp${this.#nextSpace++}`;
    this.spaces.set(spaceId, {
      spaceId,
      name,
      user: false,
      ownership: "agent",
      agentState: "",
      activeTabId: null,
    });
    return spaceId;
  }

  addTab(spaceId, { url = "about:blank", title = "", contextId = null, openerTabId = "", windowName = "" } = {}) {
    const tabId = `tb${this.#nextTab++}`;
    const space = this.spaces.get(spaceId);
    const tab = {
      tabId,
      browserId: tabId,
      spaceId,
      url,
      title,
      loading: false,
      // One tab is one CEF browser: the browser id and the page target id are
      // different ids, and only the app knows the mapping.
      targetId: `T-${tabId}`,
      contextId: contextId ?? `CTX-${spaceId}`,
      openerTabId,
      windowName,
    };
    this.tabs.set(tabId, tab);
    if (space && !space.activeTabId) space.activeTabId = tabId;
    return tab;
  }

  #spaceJson(spaceId) {
    const space = this.spaces.get(spaceId);
    const tabs = [...this.tabs.values()].filter((tab) => tab.spaceId === spaceId);
    return { ...space, tabCount: tabs.length };
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
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`,
      );
    };
    const fail = (code, errorMessage) => reply({ error: { code, message: errorMessage } });
    const method = message.method;
    const params = message.params ?? {};
    this.#account(method);

    if (method === "getInfo") {
      return reply({ result: { version: "0.2.0-M2", protocol: "1", pid: process.pid } });
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
      const spaceId = this.addSpace(params.name ?? "space");
      return reply({ result: { spaceId, name: params.name ?? "space" } });
    }
    if (method === "closeSpace") {
      if (!this.spaces.has(params.spaceId)) return fail(-32001, `unknown space ${params.spaceId}`);
      this.spaces.delete(params.spaceId);
      for (const [tabId, tab] of [...this.tabs]) {
        if (tab.spaceId === params.spaceId) this.tabs.delete(tabId);
      }
      return reply({ result: { spaceId: params.spaceId, closed: true } });
    }
    if (method === "listTabs") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      const tabs = [...this.tabs.values()].filter((tab) => tab.spaceId === params.spaceId);
      return reply({
        result: {
          spaceId: params.spaceId,
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
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      const tab = this.addTab(params.spaceId, { url: params.url ?? "about:blank" });
      space.activeTabId = tab.tabId;
      return reply({
        result: { spaceId: params.spaceId, tabId: tab.tabId, browserId: tab.browserId, url: tab.url },
      });
    }
    if (method === "activateTab") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      if (!this.tabs.has(params.tabId)) return fail(-32001, `unknown tab ${params.tabId}`);
      space.activeTabId = params.tabId;
      return reply({ result: { spaceId: params.spaceId, tabId: params.tabId, active: true } });
    }
    if (method === "closeTab") {
      if (!this.tabs.has(params.tabId)) return fail(-32001, `unknown tab ${params.tabId}`);
      this.tabs.delete(params.tabId);
      const space = this.spaces.get(params.spaceId);
      if (space?.activeTabId === params.tabId) {
        space.activeTabId =
          [...this.tabs.values()].find((tab) => tab.spaceId === params.spaceId)?.tabId ?? null;
      }
      return reply({ result: { spaceId: params.spaceId, tabId: params.tabId, closed: true } });
    }
    if (method === "navigate") {
      const tab = this.tabs.get(params.tabId);
      if (!tab) return fail(-32001, `unknown tab ${params.tabId}`);
      tab.url = params.url;
      return reply({ result: { tabId: tab.tabId, url: tab.url } });
    }
    if (method === "handOff" || method === "takeOver") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      space.ownership = method === "handOff" ? "user" : "agent";
      return reply({ result: { spaceId: params.spaceId, ownership: space.ownership } });
    }
    if (method === "setAgentTaskState") {
      const space = this.spaces.get(params.spaceId);
      if (!space) return fail(-32001, `unknown space ${params.spaceId}`);
      space.agentState = params.state;
      return reply({ result: { spaceId: params.spaceId, agentState: space.agentState } });
    }
    if (method === "highlightMouseTo") {
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
      this.cdpFrames.push({ browserId: params.browserId, ...frame });
      // The host takes the frame and says so; the page answers later, as a push.
      reply({ result: { browserId: params.browserId, accepted: true } });
      queueMicrotask(() => this.#answerCdp(tab, frame, params.browserId));
      return undefined;
    }
    return fail(-32601, `unknown method ${method}`);
  }

  #answerCdp(tab, frame, browserId) {
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
      // Process-wide, like CEF: another space's page and its iframe are visible.
      const targetInfos = [...this.tabs.values()].map((other) => this.#targetInfo(other));
      targetInfos.push({
        targetId: "T-foreign-page",
        type: "page",
        url: "http://other-space.invalid/",
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
      respond({ result: { result: { type: "string", value: "stub" } } });
      return;
    }
    respond({ result: {} });
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
