import { getBackend, closeBackends, resolveSelection } from "./backends/index.js";
import {
  assertNoExtraArgs,
  egoError,
  errorResult,
  invalidArgument,
} from "./errors.js";
import { captureSnapshot } from "./snapshot.js";
import {
  listProfiles,
  loadSpaces,
  loadSpacesSync,
  resolveProfile,
  updateSpaces,
} from "./store.js";

/** The app has one profile; host mode reports exactly this. */
const APP_PROFILE = { id: "Default", name: "Default", isDefault: true };

/**
 * The object Rook injects as `globalThis.ego`, served over CDP.
 *
 * Everything the harness touches lives here (docs/native-bindings-api.md):
 * a raw CDP pipe, the task-space/tab lifecycle, and one snapshot serializer.
 * The browser itself is behind a backend (runtime/backends/index.js): stock
 * Chrome or the native app's control socket, chosen once per process.
 *
 * The SDK requires a *plain, mutable* object: index.ts:125-141 stamps a symbol
 * on it and monkey-patches createTab/useTaskSpace/createTaskSpace/claimTaskSpace
 * /closeTaskSpace, and index.ts:242-263 copies every own enumerable function
 * onto globalThis. So methods are own enumerable properties (not prototype
 * methods) and the surface is kept to the documented names plus `dispose`,
 * which is non-enumerable on purpose.
 */
class EgoRuntime {
  #WebSocketImpl;
  #requestedMode;
  #modePromise = null;
  /** profileId (standalone) or "host" -> open backend */
  #backends = new Map();
  #opening = new Map();
  #activeBackend = null;
  #activeBackendSpaceId = null;
  /** `${spaceId}:${targetId}` -> Promise<sessionId> */
  #sessions = new Map();
  /** [{ space, message }] sent before its backend was ready */
  #sendQueue = [];
  /** `${spaceId}:${requestId}` -> { method, params, spaceId } while in flight */
  #harnessRequests = new Map();
  /** channel object per `${spaceId}:${targetId}` so snapshot can cache OOPIF sessions */
  #channels = new Map();
  #disposed = false;
  /**
   * spaceId -> active targetId. In-process first: `switchTab()` follows
   * `Target.activateTarget` with `listTabs()`, and persisting through the state
   * lock is too slow to win that race, so the file is only a restart fallback.
   */
  #activeTargets = new Map();

  constructor({ WebSocketImpl, backend } = {}) {
    this.#WebSocketImpl = WebSocketImpl;
    this.#requestedMode = backend;
    this.active = null;
    /** Assigned by the SDK; kept as plain writable properties. */
    this.onCDPMessage = undefined;
    this.onSendCDPMessageError = undefined;
  }

  // --- task spaces -------------------------------------------------------

  async listTaskSpaces() {
    assertNoExtraArgs("listTaskSpaces", arguments.length, 0);
    const state = await loadSpaces();
    const live = await this.#liveSpaceIds(state.spaces);
    const spaces = state.spaces.filter(
      (space) => live === null || (space.hostSpaceId && live.has(space.hostSpaceId)),
    );
    return { taskSpaces: spaces.map(describeSpace) };
  }

  async createTaskSpace(name, profileId) {
    assertNoExtraArgs("createTaskSpace", arguments.length, 2);
    if (typeof name !== "string" || name.trim() === "") {
      throw invalidArgument("createTaskSpace requires a non-empty task-space name");
    }
    if (profileId !== undefined && typeof profileId !== "string") {
      throw invalidArgument(
        `createTaskSpace profileId must be a string, got ${typeof profileId}`,
      );
    }
    const profile = await this.#resolveProfile(profileId);
    if (!profile) {
      return errorResult("Profile not found", "EGO_PROFILE_NOT_FOUND");
    }

    // Built before the row exists so the backend can fill in the ids it owns
    // (`contextId` on Chrome, `hostSpaceId` for the app).
    const record = {
      id: null,
      name,
      taskId: name,
      createdBy: "agent",
      ownership: "agent",
      profileId: profile.id,
      profileName: profile.name,
      contextId: null,
      hostSpaceId: null,
      activeTargetId: null,
      recentTabTitles: [],
      createdAt: Date.now(),
    };

    let backend;
    try {
      backend = await this.#ensureBackendForProfile(profile.id);
      const created = await backend.createSpace(name, record);
      record.contextId = created.contextId ?? null;
      record.hostSpaceId = created.spaceId ?? null;
    } catch (error) {
      return errorResult(
        `No active browser: ${error?.message || error}`,
        "EGO_BROWSER_UNAVAILABLE",
      );
    }

    const persisted = await updateSpaces((state) => {
      record.id = state.nextId++;
      state.spaces.push(record);
      return record;
    });
    this.#activeBackend = backend;
    this.#activeBackendSpaceId = persisted.id;
    this.active = { spaceId: persisted.id };
    return describeSpace(persisted);
  }

  async claimTaskSpace(id, name) {
    assertNoExtraArgs("claimTaskSpace", arguments.length, 2);
    if (!Number.isInteger(id)) {
      throw invalidArgument(`claimTaskSpace requires a numeric task-space id, got ${typeof id}`);
    }
    if (name !== undefined && typeof name !== "string") {
      throw invalidArgument("claimTaskSpace name must be a string");
    }
    const claimed = await updateSpaces((state) => {
      const space = state.spaces.find((item) => item.id === id);
      if (!space) return null;
      space.ownership = "agent";
      space.createdBy = "agent";
      if (typeof name === "string" && name.trim() !== "") {
        space.name = name;
        space.taskId = name;
      }
      space.claimedAt = Date.now();
      return space;
    });
    if (!claimed) {
      return errorResult(`Task space not found: ${id}`, "EGO_TASK_SPACE_NOT_FOUND");
    }
    await this.#selectSpace(claimed);
    await this.#ensureBackend(claimed)
      .then((backend) => backend.takeOver(claimed))
      .catch(() => {});
    return describeSpace(claimed);
  }

  useTaskSpace(id) {
    assertNoExtraArgs("useTaskSpace", arguments.length, 1);
    if (!Number.isInteger(id)) {
      throw invalidArgument(`useTaskSpace requires a numeric task-space id, got ${typeof id}`);
    }
    const state = loadSpacesSync();
    const space = state.spaces.find((item) => item.id === id);
    if (!space) {
      return errorResult(`Task space not found: ${id}`, "EGO_TASK_SPACE_NOT_FOUND");
    }
    this.active = { spaceId: id, space };
    // Selection is synchronous and never moves the native window: the bridge
    // opens its route in the background and every queued message is flushed in
    // order once it is ready. In host mode a space that the window is not
    // showing works identically, because CDP does not need the view.
    void this.#selectSpace(space).catch(() => {});
    return id;
  }

  async closeTaskSpace() {
    assertNoExtraArgs("closeTaskSpace", arguments.length, 0);
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;

    const backend = await this.#ensureBackend(space.space);
    await backend.closeSpace(space.space).catch(() => {});
    await updateSpaces((state) => {
      state.spaces = state.spaces.filter((item) => item.id !== space.space.id);
    });
    this.#forgetSpace(space.space.id);
    this.active = null;
    return `${space.space.id} task space closed.`;
  }

  async completeTaskSpace() {
    assertNoExtraArgs("completeTaskSpace", arguments.length, 0);
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;

    await updateSpaces((state) => {
      const target = state.spaces.find((item) => item.id === space.space.id);
      if (!target) return;
      // The Space stays open for the user, so it drops agent ownership but
      // keeps its id, tabs and profile (docs: completeTaskSpace).
      target.ownership = "user";
      target.agentState = null;
      target.completedAt = Date.now();
    });
    space.space.ownership = "user";
    // The app shows the native "You have control" banner for the same state.
    await this.#ensureBackend(space.space)
      .then((backend) => backend.handOff(space.space))
      .catch(() => {});
    return `${space.space.id} task space completed.`;
  }

  // --- control -----------------------------------------------------------

  async handOffTaskSpace() {
    assertNoExtraArgs("handOffTaskSpace", arguments.length, 0);
    const space = this.#requireSpace();
    if (space.error) return space;
    await updateSpaces((state) => {
      const target = state.spaces.find((item) => item.id === space.space.id);
      if (target) target.ownership = "agentDelegatedToUser";
    });
    space.space.ownership = "agentDelegatedToUser";
    await this.#ensureBackend(space.space)
      .then((backend) => backend.handOff(space.space))
      .catch(() => {});
    return `${space.space.id} has been handed off to the user.`;
  }

  async takeOverTaskSpace() {
    assertNoExtraArgs("takeOverTaskSpace", arguments.length, 0);
    const space = this.#requireSpace();
    if (space.error) return space;
    const backend = await this.#ensureBackend(space.space);
    // The app's own gate refuses agent traffic on a handed-off space, so it has
    // to be lifted before this call can succeed — never after.
    await backend.takeOver(space.space);
    await updateSpaces((state) => {
      const target = state.spaces.find((item) => item.id === space.space.id);
      if (target) target.ownership = "agent";
    });
    space.space.ownership = "agent";
    return `${space.space.id} has been taken over by the agent.`;
  }

  async setAgentTaskState(text) {
    assertNoExtraArgs("setAgentTaskState", arguments.length, 1);
    if (typeof text !== "string") {
      throw invalidArgument("setAgentTaskState requires a string");
    }
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;
    await updateSpaces((state) => {
      const target = state.spaces.find((item) => item.id === space.space.id);
      if (target) target.agentState = text;
    });
    await this.#ensureBackend(space.space)
      .then((backend) => backend.setAgentTaskState(space.space, text))
      .catch(() => {});
    return `${space.space.id} state updated.`;
  }

  async animationHighlightMouseToPosition(x, y) {
    assertNoExtraArgs("animationHighlightMouseToPosition", arguments.length, 2);
    if (typeof x !== "number" || typeof y !== "number") {
      throw invalidArgument("animationHighlightMouseToPosition requires numeric x and y");
    }
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;
    const backend = await this.#ensureBackend(space.space);
    // Only the native app can draw; standalone keeps the documented no-op.
    await backend.highlightMouseTo(space.space, x, y).catch(() => {});
    return `${space.space.id} mouse highlight shown.`;
  }

  // --- profiles ----------------------------------------------------------

  async listProfiles() {
    assertNoExtraArgs("listProfiles", arguments.length, 0);
    if (await this.#isHostMode()) return { profiles: [APP_PROFILE] };
    return { profiles: await listProfiles() };
  }

  // --- tabs --------------------------------------------------------------

  async createTab(url) {
    assertNoExtraArgs("createTab", arguments.length, 1);
    if (typeof url !== "string") {
      throw invalidArgument("createTab requires a URL string");
    }
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;

    const backend = await this.#ensureBackend(space.space);
    const created = await backend.createTab(space.space, url);
    if (typeof created.targetId !== "string" || created.targetId === "") {
      return errorResult("createTab returned no targetId", "EGO_OPERATION_FAILED");
    }
    await this.#setActiveTarget(space.space.id, created.targetId);
    return { targetId: created.targetId, url, title: "", active: true };
  }

  async listTabs() {
    assertNoExtraArgs("listTabs", arguments.length, 0);
    const space = this.#requireSpace();
    if (space.error) return space;
    const control = this.#controlError(space.space);
    if (control) return control;

    const backend = await this.#ensureBackend(space.space);
    const listed = await backend.listTabs(space.space);
    const tabs = listed.filter((tab) => typeof tab.targetId === "string" && tab.targetId !== "");
    if (tabs.length === 0) {
      this.#activeTargets.delete(space.space.id);
      return { tabs: [] };
    }
    // The native app is the authority on which tab is active (the user can
    // click one); Chrome has no such record, so the bridge's own is used.
    const reported = tabs.find((tab) => tab.active === true)?.targetId ?? null;
    const recorded =
      this.#activeTargets.get(space.space.id) ?? space.space.activeTargetId ?? null;
    const known = tabs.some((tab) => tab.targetId === recorded);
    const activeTargetId = reported ?? (known ? recorded : tabs[0].targetId);
    if (activeTargetId !== space.space.activeTargetId || !known) {
      await this.#setActiveTarget(space.space.id, activeTargetId);
    }
    const result = tabs.map((tab, index) => ({
      index,
      targetId: tab.targetId,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.targetId === activeTargetId,
      // The opener of a popup, when the backend knows it: the SDK adopts a
      // child page from a first `listTabs()` exactly as it would from a
      // `Target.targetCreated`, so a popup opened before this round is
      // discoverable without a replay of the event that announced it.
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
    }));
    await this.#rememberTabTitles(space.space.id, result);
    return { tabs: result };
  }

  // --- snapshot ----------------------------------------------------------

  async snapshot(options = {}) {
    assertNoExtraArgs("snapshot", arguments.length, 1);
    if (options !== null && typeof options !== "object") {
      throw invalidArgument("snapshot requires an options object");
    }
    const space = this.#requireSpace();
    if (space.error) throw egoError(space.error, space.error_code);
    const control = this.#controlError(space.space);
    // snapshot() rejects with an Error carrying error_code; probeAgentControl()
    // relies on this shape to detect user control.
    if (control) throw egoError(control.error, control.error_code);

    const backend = await this.#ensureBackend(space.space);
    const targetId = this.#activeTargets.get(space.space.id)
      ?? space.space.activeTargetId
      ?? (await this.#activeTarget(space.space));
    if (!targetId) {
      throw egoError("No active tab in this task space", "EGO_WEB_CONTENTS_UNAVAILABLE");
    }
    return captureSnapshot({
      connection: this.#channel(space.space, backend, targetId),
      targetId,
      attach: (id) => this.#attach(space.space, backend, id),
      options,
    });
  }

  // --- CDP pipe ----------------------------------------------------------

  sendCDPMessage(message) {
    assertNoExtraArgs("sendCDPMessage", arguments.length, 1);
    if (typeof message !== "string") {
      throw invalidArgument("sendCDPMessage requires a JSON-encoded string");
    }
    const space = this.#requireSpace();
    if (space.error) {
      this.#reportSendError(message, space.error_code);
      return undefined;
    }
    const control = this.#controlError(space.space);
    if (control) {
      this.#reportSendError(message, control.error_code);
      return undefined;
    }

    const parsed = parseFrame(message);
    if (parsed && parsed.id !== undefined) {
      const command = { method: parsed.method, params: parsed.params, sessionId: parsed.sessionId };
      this.#trackHarnessCommand(space.space, command);
      this.#harnessRequests.set(`${space.space.id}:${parsed.id}`, {
        ...command,
        spaceId: space.space.id,
      });
    }

    const backend = this.#backendForSpace(space.space);
    if (backend) {
      void backend.sendRaw(space.space, message).catch((error) => {
        this.#reportSendError(message, "EGO_CDP_CHANNEL_UNAVAILABLE", error);
      });
      return undefined;
    }
    this.#sendQueue.push({ space: space.space, message });
    void this.#selectSpace(space.space).catch((error) => {
      this.#reportSendError(message, "EGO_CDP_CHANNEL_UNAVAILABLE", error);
    });
    return undefined;
  }

  // --- lifecycle ---------------------------------------------------------

  /** Non-enumerable: closes sockets so a short-lived CLI process can exit. */
  async dispose() {
    this.#disposed = true;
    this.#sessions.clear();
    this.#channels.clear();
    this.#sendQueue.length = 0;
    this.#harnessRequests.clear();
    this.#activeBackend = null;
    this.#backends.clear();
    this.#opening.clear();
    await closeBackends().catch(() => {});
  }

  // --- internals ---------------------------------------------------------

  #requireSpace() {
    const space = this.#spaceOrNull();
    if (!space) {
      return errorResult("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");
    }
    return { space };
  }

  #spaceOrNull() {
    const active = this.active;
    if (!active) return null;
    if (!active.space) {
      const state = loadSpacesSync();
      active.space = state.spaces.find((item) => item.id === active.spaceId) ?? null;
    }
    if (!active.space) {
      this.active = null;
      return null;
    }
    return active.space;
  }

  #controlError(space) {
    if (space.ownership === "agent") return null;
    if (space.ownership === "agentDelegatedToUser" || space.ownership === "user") {
      return errorResult("The task is under user control", "EGO_TASK_SPACE_USER_IN_CONTROL");
    }
    return errorResult("Task space unavailable", "EGO_TASK_SPACE_UNAVAILABLE");
  }

  #reportSendError(message, code, cause) {
    const text = cause?.message ? `${message} (${cause.message})` : message;
    queueMicrotask(() => {
      try {
        this.onSendCDPMessageError?.(text, code);
      } catch {
        // A throwing callback must not break the pipe.
      }
    });
  }

  // -- backend plumbing ---------------------------------------------------

  async #mode() {
    if (!this.#modePromise) {
      this.#modePromise = resolveSelection({ requested: this.#requestedMode }).then(
        (chosen) => chosen,
      );
    }
    return this.#modePromise;
  }

  async #isHostMode() {
    const chosen = await this.#mode();
    return chosen.mode === "host";
  }

  #backendForSpace(space) {
    const backend = this.#activeBackend;
    if (!backend) return null;
    if (this.#activeBackendSpaceId === space.id) return backend;
    return null;
  }

  async #ensureBackendForProfile(profileId) {
    const chosen = await this.#mode();
    const key = chosen.mode === "host" ? "host" : profileId ?? "Default";
    const open = this.#backends.get(key);
    if (open) {
      this.#activeBackend = open;
      return open;
    }
    let pending = this.#opening.get(key);
    if (!pending) {
      pending = getBackend({
        requested: this.#requestedMode,
        profileId,
        WebSocketImpl: this.#WebSocketImpl,
      })
        .then(async (backend) => {
          await backend.open();
          backend.openFrameListener((frame) => this.#forward(backend, frame));
          this.#backends.set(key, backend);
          return backend;
        })
        .catch((error) => {
          this.#opening.delete(key);
          throw error;
        });
      this.#opening.set(key, pending);
    }
    const backend = await pending;
    this.#opening.delete(key);
    this.#activeBackend = backend;
    return backend;
  }

  async #ensureBackend(space) {
    const backend = await this.#ensureBackendForProfile(space.profileId);
    if (this.#activeBackendSpaceId !== space.id) {
      this.#activeBackend = backend;
      this.#activeBackendSpaceId = space.id;
      await this.#flushSendQueue(space, backend);
    }
    return backend;
  }

  /** Space selected in-process: open the route and replay what was queued. */
  async #selectSpace(space) {
    const backend = await this.#ensureBackend(space);
    return backend;
  }

  async #flushSendQueue(space, backend) {
    if (this.#sendQueue.length === 0) return;
    const pending = this.#sendQueue;
    this.#sendQueue = [];
    for (const entry of pending) {
      if (entry.space.id !== space.id) {
        this.#reportSendError(
          entry.message,
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          new Error("the task space was switched before the message could be sent"),
        );
        continue;
      }
      try {
        await backend.sendRaw(space, entry.message);
      } catch (error) {
        this.#reportSendError(entry.message, "EGO_CDP_CHANNEL_UNAVAILABLE", error);
        break;
      }
    }
  }

  async #resolveProfile(profileId) {
    if (await this.#isHostMode()) {
      const wanted = profileId === undefined || profileId === null ? null : String(profileId).trim();
      if (!wanted || wanted === "default" || wanted === APP_PROFILE.id) return APP_PROFILE;
      return null;
    }
    return resolveProfile(profileId);
  }

  async #liveSpaceIds(spaces) {
    if (spaces.length === 0) return null;
    if (!(await this.#isHostMode())) return null;
    try {
      const backend = await this.#ensureBackendForProfile(spaces[0].profileId);
      const ids = await backend.listSpaceIds();
      return Array.isArray(ids) ? new Set(ids) : null;
    } catch {
      // The app is gone: report what we have rather than hiding every space.
      return null;
    }
  }

  #channel(space, backend, targetId) {
    const key = `${space.id}:${targetId}`;
    const existing = this.#channels.get(key);
    if (existing) return existing;
    const channel = {
      spaceId: space.id,
      targetId,
      request: (method, params = {}, sessionId = undefined) =>
        backend.request(space, targetId, method, params, sessionId),
      attach: (id) => backend.attach(space, id, targetId),
      targets: () => backend.targets(space, targetId),
    };
    this.#channels.set(key, channel);
    return channel;
  }

  async #attach(space, backend, targetId) {
    const key = `${space.id}:${targetId}`;
    let pending = this.#sessions.get(key);
    if (!pending) {
      pending = backend.attach(space, targetId).then((sessionId) => {
        let bySession = this.#sessionTargets.get(space.id);
        if (!bySession) {
          bySession = new Map();
          this.#sessionTargets.set(space.id, bySession);
        }
        if (typeof sessionId === "string" && sessionId !== "") {
          bySession.set(sessionId, targetId);
        }
        return sessionId;
      });
      pending.catch(() => this.#sessions.delete(key));
      this.#sessions.set(key, pending);
    }
    return pending;
  }

  async #activeTarget(space) {
    const tabsResult = await this.listTabs().catch(() => null);
    const tabs = tabsResult?.tabs ?? [];
    if (tabs.length === 0) return null;
    const active = tabs.find((tab) => tab.active);
    return active?.targetId ?? tabs[0].targetId;
  }

  async #setActiveTarget(spaceId, targetId) {
    this.#activeTargets.set(spaceId, targetId);
    if (this.active?.space?.id === spaceId) this.active.space.activeTargetId = targetId;
    await updateSpaces((state) => {
      const space = state.spaces.find((item) => item.id === spaceId);
      if (space && space.activeTargetId !== targetId) space.activeTargetId = targetId;
    }).catch(() => {});
  }

  async #rememberTabTitles(spaceId, tabs) {
    const titles = tabs.map((tab) => tab.title).filter(Boolean);
    await updateSpaces((state) => {
      const space = state.spaces.find((item) => item.id === spaceId);
      if (!space) return;
      const previous = space.recentTabTitles ?? [];
      if (previous.length === titles.length && previous.every((value, i) => value === titles[i])) {
        return;
      }
      space.recentTabTitles = titles;
    }).catch(() => {});
  }

  #trackHarnessCommand(space, command) {
    if (command.method === "Target.activateTarget" && typeof command.params?.targetId === "string") {
      void this.#setActiveTarget(space.id, command.params.targetId);
      return;
    }
    if (command.method === "Page.bringToFront" && typeof command.sessionId === "string") {
      const targetId = this.#sessionTargets.get(space.id)?.get(command.sessionId);
      if (targetId) void this.#setActiveTarget(space.id, targetId);
    }
  }

  #forgetSpace(spaceId) {
    this.#activeTargets.delete(spaceId);
    for (const key of [...this.#sessions.keys()]) {
      if (key.startsWith(`${spaceId}:`)) this.#sessions.delete(key);
    }
    for (const key of [...this.#channels.keys()]) {
      if (key.startsWith(`${spaceId}:`)) this.#channels.delete(key);
    }
    for (const key of [...this.#harnessRequests.keys()]) {
      if (key.startsWith(`${spaceId}:`)) this.#harnessRequests.delete(key);
    }
  }

  /**
   * Forwarding rules, shared by both backends: responses go back verbatim
   * except `Target.getTargets`, which is narrowed to the space's context;
   * events are dropped when they belong to another space or another profile.
   *
   * Frames arrive with the space the backend could attribute them to, or with
   * `space: undefined` when the backend has no per-frame routing (standalone:
   * one socket carries every space of one profile). A frame attributed to no
   * space at all (`null`) is dropped.
   */
  #forward(backend, frame) {
    if (this.#disposed) return;
    if (frame.kind === "error") {
      // The host also reports refusals as `cdp.error`; anything that mattered
      // to a caller has already been answered with a correlated CDP error.
      if (process.env.ROOK_DEBUG === "1") {
        process.stderr.write(`[rook] cdp.error ${frame.code}: ${frame.message}\n`);
      }
      return;
    }
    const data = frame.data;
    const text = frame.text;
    if (!data || typeof text !== "string") return;
    const current = this.#spaceOrNull();
    // `undefined` = the backend cannot attribute frames (standalone: one socket
    // carries a whole profile); `null` = attributed to no space we know, so it
    // belongs to another space and must not be forwarded.
    const space = frame.space === null ? null : frame.space ?? current;
    const enabled = Boolean(space && current && space.id === current.id);
    const contextId = enabled ? space.contextId ?? null : null;

    const method = typeof data.method === "string" ? data.method : undefined;

    if (data.id !== undefined) {
      // Replies go back even when the space stopped being current mid-flight:
      // the SDK correlates them by id and would otherwise wait for a timeout.
      if (!space) {
        this.#emit(text);
        return;
      }
      const key = `${space.id}:${data.id}`;
      const request = this.#harnessRequests.get(key);
      this.#harnessRequests.delete(key);
      if (data.error && process.env.ROOK_DEBUG === "1") {
        process.stderr.write(
          `[rook] ${request?.method || "?"} ${JSON.stringify(request?.params ?? {})} -> ${data.error.message}\n`,
        );
      }
      if (
        enabled &&
        request?.method === "Target.getTargets" &&
        Array.isArray(data.result?.targetInfos)
      ) {
        data.result.targetInfos = data.result.targetInfos.filter(
          (info) => contextId === null || (info.browserContextId ?? null) === contextId,
        );
        this.#emit(JSON.stringify(data));
        return;
      }
      this.#emit(text);
      return;
    }

    if (!enabled) return;

    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = data.params?.targetInfo;
      if (info && contextId !== null && (info.browserContextId ?? null) !== contextId) return;
    } else if (method === "Target.attachedToTarget") {
      const info = data.params?.targetInfo;
      if (info && contextId !== null && (info.browserContextId ?? null) !== contextId) return;
    }
    // `Target.targetDestroyed` / `Target.detachedFromTarget` carry ids only, and
    // a lifecycle event for a page this space never knew is ignored by the SDK,
    // so they are always forwarded: dropping them would be the worse mistake.
    this.#emit(text);
  }

  #emit(text) {
    try {
      this.onCDPMessage?.(text);
    } catch {
      // A throwing callback must not kill the socket.
    }
  }

  /** Filled by #attach: spaceId -> (sessionId -> targetId). */
  #sessionTargets = new Map();
}

function parseFrame(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function describeSpace(space) {
  return {
    id: space.id,
    taskId: space.taskId ?? space.name,
    name: space.name,
    createdBy: space.createdBy ?? "agent",
    ownership: space.ownership ?? "agent",
    profileId: space.profileId,
    profileName: space.profileName,
    recentTabTitles: space.recentTabTitles ?? [],
  };
}

export function createEgoRuntime(options = {}) {
  const runtime = new EgoRuntime(options);
  // The SDK walks Object.keys(ego) (index.ts:242-263) to publish bindings as
  // globals, so every binding must be an own enumerable property. `dispose`
  // stays off that list: it is a host concern, not an agent binding.
  for (const key of Object.getOwnPropertyNames(EgoRuntime.prototype)) {
    if (key === "constructor" || key === "dispose") continue;
    const value = runtime[key];
    if (typeof value !== "function") continue;
    Object.defineProperty(runtime, key, {
      value: value.bind(runtime),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  Object.defineProperty(runtime, "dispose", {
    value: runtime.dispose.bind(runtime),
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return runtime;
}
