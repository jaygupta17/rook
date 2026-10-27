import { connect } from "node:net";

import { HostBackend, hostSocketPaths } from "./host.js";
import { StandaloneBackend } from "./standalone.js";

/**
 * The browser backend interface — the one seam the ego surface is written
 * against. Two implementations, no forks of bridge logic:
 *
 *   standalone  runtime/backends/standalone.js — stock headless Chrome; a task
 *               space is a browser context, a tab is a DevTools target.
 *   host        runtime/backends/host.js — the native Rook app; a task space
 *               is a host space id, a tab is a `browserId` on the control socket.
 *
 * Every method takes the bridge's own space record (`{ id, contextId,
 * hostSpaceId, profileId, ... }`) so a backend never reads spaces.json. Ids the
 * surface hands out are always DevTools target ids, because that is what the SDK
 * attaches with; `tabId` is the backend's own handle for the same page.
 *
 *   kind                                "standalone" | "host"
 *   describe()                          one line for error messages
 *   async open()                        connect or launch; idempotent
 *   close()                             drop this process's resources
 *   openFrameListener(fn)               fn({space, tabId, data, text}) for every
 *                                       CDP frame, correlated replies included
 *   async createSpace(name, space)      -> { spaceId, contextId }; leaves exactly
 *                                       one blank tab in the new space
 *   async closeSpace(space)
 *   async listSpaceIds()                -> string[] | null (null: nothing to check)
 *   async handOff(space) / takeOver(space)
 *   async setAgentTaskState(space, text)
 *   async highlightMouseTo(space, x, y)
 *   async listTabs(space)               -> [{ tabId, browserId, targetId, url,
 *                                           title, active: boolean|null }]
 *   async createTab(space, url)         -> { tabId, browserId, targetId }
 *   async activateTab(space, targetId)
 *   async closeTab(space, targetId)
 *   async sendRaw(space, text)          one harness frame, verbatim
 *   async attach(space, targetId)       -> a session id for that page
 *   async request(space, tabId, method, params, sessionId)  -> result
 *   async targets(space, tabId)         -> DevTools target infos this space may
 *                                          use (never another space's)
 */

export const BACKEND_METHODS = [
  "open",
  "close",
  "openFrameListener",
  "describe",
  "createSpace",
  "closeSpace",
  "listSpaceIds",
  "handOff",
  "takeOver",
  "setAgentTaskState",
  "highlightMouseTo",
  "listTabs",
  "createTab",
  "activateTab",
  "closeTab",
  "sendRaw",
  "attach",
  "request",
  "targets",
];

const MODES = new Set(["standalone", "host"]);

/** profileId -> StandaloneBackend (a space's profile decides its Chrome). */
const standaloneBackends = new Map();
/** The app is one process, so host mode has exactly one backend. */
let hostBackend = null;
/** { mode, socketPath, source } — resolved once per process, on first use. */
let selection = null;

/** Test seam: forget the chosen backend and the module-level caches. */
export function resetBackendSelection() {
  for (const backend of standaloneBackends.values()) backend.close();
  standaloneBackends.clear();
  hostBackend?.close();
  hostBackend = null;
  selection = null;
}

export function assertBackend(backend) {
  if (!backend || !MODES.has(backend.kind)) {
    throw new Error(`not a browser backend: kind ${backend?.kind}`);
  }
  const missing = BACKEND_METHODS.filter((name) => typeof backend[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`${backend.kind} backend is missing ${missing.join(", ")}`);
  }
  return backend;
}

/** `ROOK_BACKEND=host|standalone|auto`, `--standalone` on the CLI wins. */
export function configuredMode({ requested, env = process.env } = {}) {
  if (typeof requested === "string" && requested.trim() !== "") {
    const value = requested.trim();
    if (!MODES.has(value)) {
      throw new Error(`unknown backend ${JSON.stringify(value)} (use host or standalone)`);
    }
    return { mode: value, source: "flag" };
  }
  const configured = env.ROOK_BACKEND;
  if (typeof configured === "string" && configured.trim() !== "") {
    const value = configured.trim();
    if (value === "auto") return { mode: null, source: "auto" };
    if (!MODES.has(value)) {
      throw new Error(
        `ROOK_BACKEND must be host, standalone or auto, got ${JSON.stringify(value)}`,
      );
    }
    return { mode: value, source: "env" };
  }
  return { mode: null, source: "auto" };
}

async function canConnect(path, timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(path);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Which backend this process talks to.
 *
 * The default is `standalone` unless the app is actually running: an app that
 * starts later does not hijack a round that already began, and headless CI never
 * needs to know this code exists. An explicit `host` is honoured strictly — a
 * missing socket is an error, not a quiet fallback, because a caller that asked
 * for the app wants to hear that it is not there.
 */
export async function resolveSelection({ requested, env = process.env } = {}) {
  const configured = configuredMode({ requested, env });
  const stillValid =
    selection &&
    (configured.mode === null
      ? selection.source === "auto"
      : selection.mode === configured.mode && selection.source === configured.source);
  if (stillValid) return selection;
  if (configured.mode) {
    selection = {
      mode: configured.mode,
      socketPath: configured.mode === "host" ? hostSocketPaths({ env })[0] : null,
      source: configured.source,
    };
    return selection;
  }
  const paths = hostSocketPaths({ env });
  for (const path of paths) {
    if (await canConnect(path)) {
      selection = { mode: "host", socketPath: path, source: "auto" };
      return selection;
    }
  }
  selection = { mode: "standalone", socketPath: null, source: "auto" };
  return selection;
}

/**
 * The backend for one profile. In host mode `profileId` is ignored: the app has
 * a single profile, so there is a single backend.
 */
export async function getBackend({ requested, profileId, WebSocketImpl, env } = {}) {
  const chosen = await resolveSelection({ requested, env });
  if (chosen.mode === "host") {
    if (!hostBackend) {
      hostBackend = new HostBackend({ socketPath: chosen.socketPath });
      debugBackend(hostBackend, chosen, env);
    }
    return assertBackend(hostBackend);
  }
  const key = profileId ?? "Default";
  let backend = standaloneBackends.get(key);
  if (!backend) {
    backend = new StandaloneBackend({ profileId: key, WebSocketImpl });
    standaloneBackends.set(key, backend);
    debugBackend(backend, chosen, env);
  }
  return assertBackend(backend);
}

function debugBackend(backend, chosen, env) {
  if ((env ?? process.env).ROOK_DEBUG !== "1") return;
  process.stderr.write(
    `[rook] backend ${backend.kind} (${chosen.source}): ${backend.describe()}\n`,
  );
}

export async function closeBackends() {
  const closing = [...standaloneBackends.values()].map((backend) =>
    Promise.resolve(backend.close()).catch(() => {}),
  );
  standaloneBackends.clear();
  if (hostBackend) closing.push(Promise.resolve(hostBackend.close()).catch(() => {}));
  hostBackend = null;
  await Promise.all(closing);
}

export { HostBackend, StandaloneBackend, hostSocketPaths };
