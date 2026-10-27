#!/usr/bin/env node
/**
 * Rook (Linux) — M2 control-channel probe.
 *
 * Drives the host's agent control channel the way the bridge will: a unix
 * socket, newline-delimited JSON-RPC 2.0, and raw DevTools protocol messages
 * passed through the host untouched. No dependencies, Node 22+.
 *
 *   node scripts/control-probe.mjs                      # build/bin/rook
 *   node scripts/control-probe.mjs --bin host/build/bin/rook
 *   node scripts/control-probe.mjs --keep               # keep the temp profile
 *
 * What it proves, in order:
 *   1. getInfo           — version, pid, socket path (mode 0600), space list
 *   2. framing           — split lines, string ids, garbage, notifications
 *   3. createSpace       — a real space with its own request context
 *   4. createTab         — a tab in a space the window is *not* showing
 *   5. CDP on a parked tab — Target.getTargets/attachToTarget, Page.enable,
 *                            Runtime.evaluate, Accessibility.getFullAXTree
 *   6. passthrough       — events keep their shape, payloads are byte-identical
 *   7. multi-client      — a second client sees the host and its pushes
 *   8. cdp.error         — an unknown browser id is refused, not swallowed
 *   9. captureScreenshot — written to artifacts/m2-cdp.png
 *  10. handOff / takeOver — the mutation gate refuses agent traffic, then lifts
 *  11. highlightMouseTo  — the native pointer ring is placed in the user space
 *  12. tab lifecycle     — space.created/tab.created/space.closed reach the
 *                          client; activateSpace moves the window
 *  13. popups           — window.open() in a same-space tab produces
 *                          tab.created{openerTabId,windowName}, is listed by
 *                          listTabs with that attribution, and closes cleanly
 *  14. closeTab/closeSpace/quit — teardown leaves nothing behind, exit 0
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(here, "..");

// ---------------------------------------------------------------------------
// arguments and process plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "keep" || key === "verbose") {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const bin = resolve(args.bin ?? join(hostRoot, "build", "bin", "rook"));
const fixtures = resolve(args.fixtures ?? join(hostRoot, "fixtures"));
const artifacts = resolve(args.artifacts ?? join(hostRoot, "artifacts"));
const display = args.display ?? process.env.DISPLAY ?? ":99";
const stepTimeout = Number(args.timeout ?? 45000);
const keepTemp = booleans().keep;
const verbose = booleans().verbose;

function booleans() {
  return { keep: args.keep === true, verbose: args.verbose === true };
}

const pngPath = join(artifacts, "m2-cdp.png");
const hostLogPath = join(artifacts, "control-probe-host.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const children = [];
function trackChild(child) {
  children.push(child);
  return child;
}

let server = null;
let rpc = null;
let temp = null;
let hostLog = null;

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function cleanup() {
  try {
    rpc?.close();
  } catch {
    /* ignore */
  }
  killChildren();
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  if (temp && !keepTemp) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (hostLog) {
    try {
      hostLog.end();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// fixture server + display
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startFixtureServer(directory) {
  const http = createServer((request, response) => {
    const path = join(directory, decodeURIComponent((request.url ?? "/").split("?")[0]));
    const file = path.endsWith("/") ? join(path, "index.html") : path;
    if (!file.startsWith(directory)) {
      response.writeHead(403).end("no");
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  return new Promise((resolvePromise, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address();
      resolvePromise({ http, base: `http://127.0.0.1:${port}` });
    });
  });
}

function displayAlive() {
  return new Promise((resolvePromise) => {
    const probe = spawn("xdpyinfo", ["-display", display], { stdio: "ignore" });
    probe.on("error", () => resolvePromise(false));
    probe.on("exit", (code) => resolvePromise(code === 0));
  });
}

async function ensureDisplay() {
  if (await displayAlive()) return null;
  const candidates = [process.env.ROOK_XVFB_BIN, "Xvfb"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const xvfb = trackChild(
      spawn(candidate, [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac"], {
        stdio: "ignore",
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [process.env.ROOK_XVFB_LIB, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        },
      }),
    );
    let alive = false;
    for (let i = 0; i < 40 && !alive; i += 1) {
      await sleep(125);
      alive = await displayAlive();
    }
    if (alive) return xvfb;
    xvfb.kill("SIGKILL");
  }
  fail(`no X display on ${display} and no Xvfb to start one`);
}

// ---------------------------------------------------------------------------
// JSON-RPC client (newline delimited, one object per line)
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(code, message) {
    super(`${message} (code ${code})`);
    this.code = code;
    this.rpcMessage = message;
  }
}

class Rpc {
  #socket;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onClose());
    socket.on("error", (error) => this.#onClose(error));
  }

  static async connect(path, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise((resolvePromise, reject) => {
          const candidate = createConnection(path);
          candidate.once("connect", () => resolvePromise(candidate));
          candidate.once("error", reject);
        });
        return new Rpc(socket);
      } catch (error) {
        lastError = error;
        await sleep(50);
      }
    }
    fail(`could not connect to ${path}: ${lastError?.message ?? "timed out"}`);
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(`host sent a non-JSON line: ${line.slice(0, 120)} (${error.message})`);
      }
      if (verbose) process.stderr.write(`<- ${line.slice(0, 400)}\n`);
      if (Object.hasOwn(message, "id")) {
        const entry = this.#pending.get(message.id);
        if (!entry) continue;
        this.#pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new RpcError(message.error.code, message.error.message));
        } else {
          entry.resolve(message.result ?? {});
        }
        continue;
      }
      for (const listener of this.#listeners) {
        try {
          listener(message);
        } catch (error) {
          process.stderr.write(`probe listener threw: ${error?.message ?? error}\n`);
        }
      }
    }
  }

  #onClose(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`control socket closed${error ? `: ${error.message}` : ""}`));
    }
    this.#pending.clear();
  }

  onNotification(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(method, params, timeoutMs = stepTimeout) {
    if (this.#closed) return Promise.reject(new Error("control socket is closed"));
    const id = this.#nextId++;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`;
    if (verbose) process.stderr.write(`-> ${frame.slice(0, 400)}`);
    this.#socket.write(frame);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer, method });
    });
  }

  close() {
    this.#socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// CDP channel over cdp.send / cdp.event
// ---------------------------------------------------------------------------

function cdpChannel(client, browserId) {
  const pending = new Map();
  const events = [];
  const rawByMethod = new Map();
  let nextId = 1;

  client.onNotification((notification) => {
    if (notification.method !== "cdp.event") return;
    if (notification.params?.browserId !== browserId) return;
    const raw = notification.params.message;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      fail(`host passed a non-JSON CDP payload: ${String(raw).slice(0, 120)}`);
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new RpcError(message.error.code, `${entry.method}: ${message.error.message}`),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    events.push({ ...message, __raw: raw });
    rawByMethod.set(message.method, raw);
  });

  return {
    events,
    rawByMethod,
    /**
     * Send one DevTools method call. `sessionId` is passed through verbatim:
     * the host never touches it, which is what keeps page-level commands
     * working over a browser-level message.
     */
    send(method, params = {}, { sessionId, timeoutMs = stepTimeout } = {}) {
      const id = nextId++;
      const frame = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no CDP reply within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, timer, method });
        client
          .request("cdp.send", { browserId, message: JSON.stringify(frame) }, timeoutMs)
          .catch((error) => {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          });
      });
    },
  };
}

async function evaluate(cdp, expression, sessionId) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    { sessionId },
  );
  if (result.exceptionDetails) {
    fail(`page threw while evaluating ${expression}: ${result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

async function waitFor(label, check, timeoutMs = stepTimeout, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  fail(`${label}: timed out after ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ""}`);
}

/**
 * Write one frame and hang up immediately. Proves the host still acts on a
 * notification whose sender disconnected before any reply.
 */
async function fireAndForget(socketPath, frame) {
  const socket = createConnection(socketPath);
  await new Promise((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("error", reject);
  });
  socket.write(`${frame}\n`);
  socket.destroy();
}
async function rawExchange(socketPath, chunks, expected, timeoutMs = 5000) {
  const socket = createConnection(socketPath);
  await new Promise((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  let buffer = "";
  const replies = [];
  const notifications = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      // Every client is broadcast every push, this one included. Only lines
      // that answer something (an id, even null) are replies.
      if (Object.hasOwn(parsed, "id")) replies.push(parsed);
      else notifications.push(parsed);
    }
  });
  for (const chunk of chunks) {
    socket.write(chunk);
    await sleep(20);
  }
  const deadline = Date.now() + timeoutMs;
  while (replies.length < expected && Date.now() < deadline) {
    await sleep(20);
  }
  socket.destroy();
  return { replies, notifications };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const results = [];
let currentStep = null;

async function step(name, body) {
  const started = Date.now();
  currentStep = name;
  try {
    const detail = await body();
    const ms = Date.now() - started;
    results.push({ name, ok: true, detail, ms });
    process.stdout.write(`  ok    ${name.padEnd(16)} ${detail ?? ""}  (${ms} ms)\n`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, detail: error?.message ?? String(error), ms });
    process.stdout.write(`  FAIL  ${name.padEnd(16)} ${error?.message ?? error}\n`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  assert(existsSync(bin), `no host binary at ${bin} (build it first, or pass --bin)`);
  mkdirSync(artifacts, { recursive: true });
  hostLog = createWriteStream(hostLogPath, { flags: "w" });

  temp = mkdtempSync(join(tmpdir(), "rook-m2-probe-"));
  const runDir = join(temp, "run");
  const dataDir = join(temp, "data");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const socketPath = join(runDir, `rook-${process.getuid()}.sock`);

  await ensureDisplay();
  const { http, base } = await startFixtureServer(fixtures);
  server = http;
  const fixtureUrl = `${base}/control.html`;

  process.stdout.write(`\nRook control probe\n`);
  process.stdout.write(`  host       ${bin}\n`);
  process.stdout.write(`  display    ${display}\n`);
  process.stdout.write(`  socket     ${socketPath}\n`);
  process.stdout.write(`  fixture    ${fixtureUrl}\n\n`);

  let host = null;
  await step("launch", async () => {
    host = spawn(
      bin,
      [
        "--profile", "probe",
        "--data-root", dataDir,
        "--window-size", "1280x820",
        // Unknown flags are forwarded to CEF verbatim. A page that calls
        // window.open() without a gesture is normally stopped by the popup
        // blocker before CEF ever sees it; the probe wants the popup path.
        "--disable-popup-blocking",
      ],
      {
        env: {
          ...process.env,
          DISPLAY: display,
          XDG_RUNTIME_DIR: runDir,
          XDG_DATA_HOME: dataDir,
          HOME: temp,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    host.stderr.pipe(hostLog);
    trackChild(host);
    host.on("exit", (code, signal) => {
      if (verbose) process.stderr.write(`host exited code=${code} signal=${signal}\n`);
    });
    await waitFor("control socket", () => existsSync(socketPath), 30000, 50);
    return `pid ${host.pid}, socket ready`;
  });

  const mode = (statSync(socketPath).mode & 0o777).toString(8);
  assertEqual(mode, "600", "socket mode");

  rpc = await Rpc.connect(socketPath, 10000);
  const cdpErrors = [];
  // Every lifecycle push the host sends, in order. The events are broadcast to
  // all clients; this one collects them so each step can assert its own.
  const lifecycle = [];
  rpc.onNotification((notification) => {
    if (notification.method === "cdp.error") cdpErrors.push(notification.params);
    if (/^(space|tab|control)\./.test(notification.method ?? "")) {
      lifecycle.push({ method: notification.method, params: notification.params });
    }
  });

  let info;
  let spaceId;
  let tabId;
  let popupTabId = null;
  let cdp;
  let sessionId;
  let setActiveSpace = null;

  await step("getInfo", async () => {
    info = await rpc.request("getInfo");
    assertEqual(info.version, "0.3.0-M3", "host version");
    assertEqual(info.protocol, "2", "protocol version");
    assertEqual(info.pid, host.pid, "host pid");
    assertEqual(info.socket, socketPath, "socket path");
    assert(/^\d+\.\d+\.\d+/.test(info.cef ?? ""), `CEF version missing: ${info.cef}`);
    const spaces = info.state?.spaces ?? [];
    assert(spaces.length >= 1, "getInfo carries no spaces");
    assert(
      spaces.some((s) => s.name === "You" && s.user === true),
      'the "You" space is missing from getInfo',
    );
    setActiveSpace = info.state.activeSpaceId;
    return `${info.cef.split("+")[0]} · pid ${info.pid} · ${spaces.length} space(s)`;
  });

  await step("listSpaces", async () => {
    const list = await rpc.request("listSpaces");
    assertEqual(list.activeSpaceId, setActiveSpace, "active space");
    assert(Array.isArray(list.spaces), "spaces is not an array");
    const you = list.spaces.find((s) => s.spaceId === setActiveSpace);
    assert(you && you.user === true, "the active space is not the user space");
    return `${list.spaces.length} space(s), active ${list.activeSpaceId} "${you.name}"`;
  });

  await step("framing", async () => {
    const { replies } = await rawExchange(
      socketPath,
      [
        "this is not json\n",
        // One request, split across two writes.
        '{"jsonrpc":"2.0","id":"abc",',
        '"method":"getInfo"}\n',
        // No id: a notification, so no reply - and an unknown method must not
        // take the connection down.
        '{"jsonrpc":"2.0","method":"nope.notAMethod"}\n',
      ],
      2,
    );
    assertEqual(replies.length, 2, "reply count (garbage + string id; no reply to a notification)");
    assertEqual(replies[0].id, null, "parse error id");
    assertEqual(replies[0].error?.code, -32700, "parse error code");
    assertEqual(replies[1].id, "abc", "string id was not echoed verbatim");
    assert(replies[1].result?.version, "the string-id request produced no result");
    return "split frame + string id ok, garbage line -32700, notification ignored";
  });

  await step("userSpaceGate", async () => {
    // The "You" space is the user's: an agent may look at it but not drive it.
    let tabError = null;
    let closeError = null;
    try {
      await rpc.request("createTab", { spaceId: setActiveSpace, url: fixtureUrl });
    } catch (error) {
      tabError = error;
    }
    try {
      await rpc.request("closeSpace", { spaceId: setActiveSpace });
    } catch (error) {
      closeError = error;
    }
    assert(tabError, "createTab in the user space was allowed");
    assert(closeError, "closeSpace on the user space was allowed");
    assert(/belongs to the user/.test(closeError.rpcMessage),
      `closeSpace message: ${closeError.rpcMessage}`);
    return `createTab + closeSpace refused on ${setActiveSpace}`;
  });

  await step("createSpace", async () => {
    const created = await rpc.request("createSpace", { name: "probe" });
    spaceId = created.spaceId;
    assert(typeof spaceId === "string" && spaceId.length > 0, "no spaceId");
    const list = await rpc.request("listSpaces");
    const space = list.spaces.find((s) => s.spaceId === spaceId);
    assert(space, "the new space is not in listSpaces");
    assertEqual(space.name, "probe", "space name");
    assertEqual(space.user, false, "agent space flag");
    assertEqual(space.ownership, "agent", "space ownership");
    assertEqual(space.tabCount, 0, "a new space starts with no tabs");
    // The window must still be showing the user's space: an agent creating a
    // space may not steal the view.
    const after = await rpc.request("listSpaces");
    assertEqual(after.activeSpaceId, setActiveSpace, "createSpace stole the active space");
    // Pushed from Shell::CreateSpace, so a UI "new space" click emits it too.
    const pushed = lifecycle.find(
      (event) => event.method === "space.created" && event.params?.spaceId === spaceId,
    );
    assert(pushed, "no space.created push for the new space");
    assertEqual(pushed.params.name, "probe", "space.created name");
    return `${spaceId} "probe" (hidden, ${space.cache}), space.created pushed`;
  });

  await step("createTab", async () => {
    const created = await rpc.request("createTab", { spaceId, url: fixtureUrl });
    tabId = created.tabId;
    assert(typeof tabId === "string" && tabId.length > 0, "no tabId");
    assertEqual(created.browserId, tabId, "browserId must equal the tab id");
    const tabs = await rpc.request("listTabs", { spaceId });
    assertEqual(tabs.tabs.length, 1, "tab count");
    assertEqual(tabs.tabs[0].tabId, tabId, "tab id in listTabs");
    assertEqual(tabs.activeTabId, tabId, "active tab id");
    const after = await rpc.request("listSpaces");
    assertEqual(after.activeSpaceId, setActiveSpace, "createTab stole the active space");
    return `${tabId} in ${spaceId} (window untouched)`;
  });

  await step("cdp.attach", async () => {
    cdp = cdpChannel(rpc, tabId);
    const targets = await waitFor("page target", async () => {
      const result = await cdp.send("Target.getTargets", {});
      return result.targetInfos?.find((t) => t.type === "page" && t.url === fixtureUrl) ?? null;
    });
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: targets.targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0, "no sessionId");
    return `target ${targets.targetId} session ${sessionId}`;
  });

  await step("cdp.evaluate", async () => {
    await cdp.send("Page.enable", {}, { sessionId });
    const title = await waitFor(
      "document.title",
      async () => {
        const value = await evaluate(cdp, "document.title", sessionId);
        return value === "control probe" ? value : null;
      },
      30000,
    );
    assertEqual(title, "control probe", "document.title");
    const ready = await evaluate(cdp, "document.readyState", sessionId);
    assertEqual(ready, "complete", "document.readyState");
    // The tab lives in a space the window is not showing, so the page had to be
    // woken from WasHidden(true) for this to render and run.
    return `document.title = "${title}", readyState = ${ready} (parked tab)`;
  });

  await step("cdp.axTree", async () => {
    const tree = await cdp.send("Accessibility.getFullAXTree", {}, { sessionId });
    assert(Array.isArray(tree.nodes), "AX tree has no nodes");
    const hasButton = tree.nodes.some(
      (node) => node.role?.value === "button" && node.name?.value === "Run probe",
    );
    const hasHeading = tree.nodes.some(
      (node) => node.role?.value === "heading" && /control\s+probe/i.test(node.name?.value ?? ""),
    );
    assert(hasButton, 'AX tree has no button named "Run probe"');
    assert(hasHeading, 'AX tree has no heading matching "control probe"');
    return `${tree.nodes.length} nodes, button "Run probe" + heading present`;
  });

  await step("cdp.passthrough", async () => {
    // Events arrive as notifications and keep their shape; replies keep the id
    // the bridge chose. Neither is rewritten by the host.
    const navigated = await waitFor(
      "Page.* event",
      () => cdp.events.find((e) => typeof e.method === "string" && e.method.startsWith("Page.")),
      5000,
    );
    assert(!Object.hasOwn(navigated, "id"), "an event carried an id");
    const raw = cdp.rawByMethod.get(navigated.method);
    assert(typeof raw === "string", "event payload is not a string");
    assert(raw.includes('"method"'), "raw event payload was rewritten");
    return `${cdp.events.length} event(s), first "${navigated.method}", payload verbatim`;
  });

  await step("multiClient", async () => {
    const second = await Rpc.connect(socketPath, 5000);
    try {
      const seen = [];
      second.onNotification((notification) => seen.push(notification));
      const info2 = await second.request("getInfo");
      assertEqual(info2.pid, info.pid, "second client sees a different host");
      // Pushes are broadcast: a message this client never sent must arrive.
      await evaluate(cdp, "1 + 1", sessionId);
      const event = await waitFor(
        "broadcast cdp.event",
        () => seen.find((n) => n.method === "cdp.event" && n.params?.browserId === tabId),
        5000,
      );
      assert(typeof event.params.message === "string", "broadcast payload is not a string");
      return `second client sees getInfo + ${seen.length} broadcast push(es)`;
    } finally {
      second.close();
    }
  });

  await step("cdp.error", async () => {
    const before = cdpErrors.length;
    let error = null;
    try {
      await rpc.request("cdp.send", { browserId: "tb-does-not-exist", message: '{"id":1,"method":"Page.enable"}' });
    } catch (caught) {
      error = caught;
    }
    assert(error, "cdp.send to an unknown browser succeeded");
    assertEqual(error.code, -32002, "cdp.send error code");
    await waitFor("cdp.error notification", () => cdpErrors.length > before, 5000);
    const notification = cdpErrors[cdpErrors.length - 1];
    assertEqual(notification.browserId, "tb-does-not-exist", "cdp.error browserId");
    assertEqual(notification.code, -32002, "cdp.error code");
    assert(typeof notification.message === "string" && notification.message.length > 0,
      "cdp.error has no message");
    return `refused + cdp.error(${notification.code}) "${notification.message}"`;
  });

  await step("screenshot", async () => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, { sessionId });
    assert(typeof shot.data === "string" && shot.data.length > 0, "no screenshot data");
    const png = Buffer.from(shot.data, "base64");
    assert(png.length > 1024, `screenshot is only ${png.length} bytes`);
    const signature = png.subarray(0, 8).toString("hex");
    assertEqual(signature, "89504e470d0a1a0a", "PNG signature");
    writeFileSync(pngPath, png);
    const pixels = await inspectPng(pngPath);
    return `${pngPath} (${Math.round(png.length / 1024)} KB, ${pixels})`;
  });

  await step("agentState", async () => {
    await rpc.request("setAgentTaskState", { spaceId, state: "reading the fixture" });
    const list = await rpc.request("listSpaces");
    const space = list.spaces.find((s) => s.spaceId === spaceId);
    assertEqual(space.agentState, "reading the fixture", "agent state");
    // A notification from a client that hangs up before any reply must still
    // take effect: fire-and-forget is how a short-lived CLI can talk.
    await fireAndForget(
      socketPath,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "setAgentTaskState",
        params: { spaceId, state: "disconnected client" },
      }),
    );
    await waitFor(
      "fire-and-forget notification",
      async () => {
        const after = await rpc.request("listSpaces");
        return after.spaces.find((s) => s.spaceId === spaceId)?.agentState ===
          "disconnected client";
      },
      5000,
    );
    await rpc.request("setAgentTaskState", { spaceId, state: "" });
    return 'space row shows the state; a closed sender still lands';
  });

  await step("handOff", async () => {
    const handed = await rpc.request("handOff", { spaceId });
    assertEqual(handed.ownership, "user", "handOff result");
    const list = await rpc.request("listSpaces");
    assertEqual(
      list.spaces.find((s) => s.spaceId === spaceId).ownership,
      "user",
      "ownership after handOff",
    );
    // The gate: the agent may not drive a space the user owns.
    let blocked = null;
    try {
      await rpc.request("cdp.send", {
        browserId: tabId,
        message: JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "1+1" }, sessionId }),
      });
    } catch (error) {
      blocked = error;
    }
    assert(blocked, "cdp.send still worked after handOff");
    assertEqual(blocked.code, -32002, "handOff gate error code");
    assert(/handed off/i.test(blocked.rpcMessage), `gate message: ${blocked.rpcMessage}`);
    // The ownership change is pushed too: this is what a bridge repaints on.
    await waitFor(
      "control.changed user",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "control.changed" &&
            event.params?.spaceId === spaceId &&
            event.params.state === "user",
        ),
      5000,
    );
    return `ownership=user + control.changed, cdp.send blocked ("${blocked.rpcMessage}")`;
  });

  await step("takeOver", async () => {
    await rpc.request("takeOver", { spaceId });
    await waitFor(
      "control.changed agent",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "control.changed" &&
            event.params?.spaceId === spaceId &&
            event.params.state === "agent",
        ),
      5000,
    );
    const title = await evaluate(cdp, "document.title", sessionId);
    assertEqual(title, "control probe", "page after takeOver");
    return "agent can drive the space again (control.changed agent)";
  });

  await step("highlight", async () => {
    const result = await rpc.request("highlightMouseTo", {
      spaceId: setActiveSpace,
      x: 420,
      y: 300,
    });
    assertEqual(result.x, 420, "highlight x");
    assertEqual(result.y, 300, "highlight y");
    return "ring placed at 420,300 in the user space";
  });

  // -------------------------------------------------------------------------
  // Tab lifecycle pushes + popup attribution. This is what the bridge turns
  // into CDP target events: CEF reports the popup on the opener's browser, the
  // host cancels it and opens an ordinary tab that carries the attribution.
  // -------------------------------------------------------------------------

  await step("tabEvents", async () => {
    const created = lifecycle.find(
      (event) => event.method === "tab.created" && event.params?.tabId === tabId,
    );
    assert(created, "no tab.created push for the probe tab");
    assertEqual(created.params.spaceId, spaceId, "tab.created spaceId");
    assertEqual(created.params.url, fixtureUrl, "tab.created url");
    assertEqual(
      created.params.openerTabId,
      undefined,
      "a createTab tab must not claim an opener",
    );
    return `tab.created {spaceId,tabId,url} pushed for a createTab tab`;
  });

  await step("popup", async () => {
    const before = lifecycle.length;
    // The window is on the user space, so the opener's tab is parked in a space
    // nobody is looking at — the agent case, not the user-click case.
    const windowBefore = (await rpc.request("listSpaces")).activeSpaceId;
    const opened = await cdp.send(
      "Runtime.evaluate",
      {
        // A relative URL and a named window, from a same-space tab.
        expression:
          '(() => { const w = window.open("/control.html?popup=1", "probe_popup", "width=420,height=320"); return String(w); })()',
        returnByValue: true,
        userGesture: true,
      },
      { sessionId },
    );
    const created = await waitFor(
      "tab.created for the popup",
      () =>
        lifecycle
          .slice(before)
          .find(
            (event) =>
              event.method === "tab.created" &&
              event.params?.spaceId === spaceId &&
              event.params?.tabId !== tabId,
          ),
      20000,
    );
    popupTabId = created.params.tabId;
    assert(/^tb\d+$/.test(popupTabId), `popup tab id looks wrong: ${popupTabId}`);
    assertEqual(created.params.openerTabId, tabId, "tab.created openerTabId");
    assertEqual(created.params.windowName, "probe_popup", "tab.created windowName");
    assertEqual(created.params.spaceId, spaceId, "popup left the space");
    assert(
      String(created.params.url).includes("popup=1"),
      `popup url: ${created.params.url}`,
    );
    const windowAfter = (await rpc.request("listSpaces")).activeSpaceId;
    assertEqual(windowAfter, windowBefore, "a popup in a hidden space stole the window");
    // Cancelled popups cannot hand the page a window handle; that is the cost
    // of the attribute-and-reopen path, and it is reported, not hidden.
    return `${popupTabId} from ${tabId} (name "probe_popup", window.open() -> ${opened.result?.value}, window stayed on ${windowAfter})`;
  });

  await step("activateSpace", async () => {
    const before = await rpc.request("listSpaces");
    assert(before.activeSpaceId !== spaceId, "the probe space is already on screen");
    const result = await rpc.request("activateSpace", { spaceId });
    assertEqual(result.spaceId, spaceId, "activateSpace result");
    const after = await rpc.request("listSpaces");
    assertEqual(after.activeSpaceId, spaceId, "activeSpaceId after activateSpace");
    assertEqual(
      after.spaces.find((s) => s.spaceId === spaceId)?.active,
      true,
      "space.active after activateSpace",
    );
    return `window ${before.activeSpaceId} -> ${spaceId} (sidebar + tab strip)`;
  });

  await step("popupTab", async () => {
    const list = await waitFor(
      "popup in listTabs",
      async () => {
        const tabs = await rpc.request("listTabs", { spaceId });
        return tabs.tabs.length === 2 ? tabs : null;
      },
      15000,
    );
    const popup = list.tabs.find((tab) => tab.tabId === popupTabId);
    assert(popup, "the popup tab is not in listTabs");
    assertEqual(popup.openerTabId, tabId, "listTabs openerTabId");
    assertEqual(popup.windowName, "probe_popup", "listTabs windowName");

    // The tab was created with its URL, so the first load is already running.
    // Navigating over an in-flight load makes the URL events racy; wait first.
    await waitFor(
      "the popup tab to finish loading",
      async () => {
        const tabs = await rpc.request("listTabs", { spaceId });
        const tab = tabs.tabs.find((candidate) => candidate.tabId === popupTabId);
        return tab && tab.loading === false ? tab : null;
      },
      20000,
    );

    // What the bridge actually does next: find the popup's page target on its
    // own browser and attach a session to it.
    const popupCdp = cdpChannel(rpc, popupTabId);
    const target = await waitFor(
      "popup page target",
      async () => {
        const result = await popupCdp.send("Target.getTargets", {});
        return (
          result.targetInfos?.find(
            (info) => info.type === "page" && String(info.url).includes("popup=1"),
          ) ?? null
        );
      },
      20000,
    );
    const attached = await popupCdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    assert(
      typeof attached.sessionId === "string" && attached.sessionId.length > 0,
      "no sessionId for the popup target",
    );
    const popupTitle = await evaluate(popupCdp, "document.title", attached.sessionId);
    assertEqual(popupTitle, "control probe", "popup page title over CDP");

    // Adoptable as a normal tab: activation, then navigation through the op.
    await rpc.request("activateTab", { spaceId, tabId: popupTabId });
    await waitFor(
      "tab.activated for the popup",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "tab.activated" && event.params?.tabId === popupTabId,
        ),
      5000,
    );
    const activated = await rpc.request("listTabs", { spaceId });
    assertEqual(activated.activeTabId, popupTabId, "activateTab on the popup tab");

    const navigatedUrl = `${base}/control.html?popup=2`;
    await rpc.request("navigate", { tabId: popupTabId, url: navigatedUrl });
    const updated = await waitFor(
      "tab.updated (url) for the popup",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "tab.updated" &&
            event.params?.tabId === popupTabId &&
            typeof event.params?.url === "string" &&
            event.params.url.includes("popup=2"),
        ),
      20000,
    );
    assertEqual(updated.params.spaceId, spaceId, "tab.updated spaceId");

    // A page with a different <title>, so tab.updated{title} comes from CEF's
    // title callback rather than from our own navigate.
    await rpc.request("navigate", { tabId: popupTabId, url: `${base}/notes.html` });
    await waitFor(
      "tab.updated (title) for the popup",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "tab.updated" &&
            event.params?.tabId === popupTabId &&
            typeof event.params?.title === "string" &&
            event.params.title.includes("Notes"),
        ),
      20000,
    );
    return `${popupTabId} adopted: target attached, listed with opener, activated, url+title pushed`;
  });

  await step("popupClose", async () => {
    await rpc.request("closeTab", { spaceId, tabId: popupTabId });
    await waitFor(
      "tab.closed for the popup",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "tab.closed" && event.params?.tabId === popupTabId,
        ),
      15000,
    );
    const list = await waitFor(
      "popup gone from listTabs",
      async () => {
        const tabs = await rpc.request("listTabs", { spaceId });
        return tabs.tabs.length === 1 ? tabs : null;
      },
      15000,
    );
    assert(
      !list.tabs.some((tab) => tab.tabId === popupTabId),
      "the closed popup is still listed",
    );
    assertEqual(list.activeTabId, tabId, "active tab after the popup closed");
    return `${popupTabId} closed, ${spaceId} back to 1 tab`;
  });

  await step("backToUser", async () => {
    // Leave the window where the next steps (and a user) expect it. Closing the
    // last tab of the *visible* space opens a welcome tab by design, so the
    // teardown checks below only hold with the user space on screen.
    await rpc.request("activateSpace", { spaceId: setActiveSpace });
    const after = await rpc.request("listSpaces");
    assertEqual(after.activeSpaceId, setActiveSpace, "window did not return");
    return `window back on ${setActiveSpace}, ${spaceId} still loaded`;
  });

  await step("closeTab", async () => {
    await rpc.request("closeTab", { spaceId, tabId });
    await waitFor(
      "tab.closed for the probe tab",
      () =>
        lifecycle.find(
          (event) => event.method === "tab.closed" && event.params?.tabId === tabId,
        ),
      15000,
    );
    const tabs = await waitFor("tab gone", async () => {
      const list = await rpc.request("listTabs", { spaceId });
      return list.tabs.length === 0 ? list : null;
    });
    assertEqual(tabs.tabs.length, 0, "tabs after closeTab");
    return "tab closed + tab.closed pushed, listTabs is empty";
  });

  await step("closeSpace", async () => {
    await rpc.request("closeSpace", { spaceId });
    await waitFor(
      "space.closed",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "space.closed" && event.params?.spaceId === spaceId,
        ),
      15000,
    );
    const list = await rpc.request("listSpaces");
    assert(
      !list.spaces.some((s) => s.spaceId === spaceId),
      "the closed space is still listed",
    );
    let gone = null;
    try {
      await rpc.request("listTabs", { spaceId });
    } catch (error) {
      gone = error;
    }
    assert(gone, "listTabs still answers for a closed space");
    return `space ${spaceId} gone, listTabs refused (${gone.code})`;
  });

  await step("closeSpaceTab", async () => {
    // Closing a space with live tabs has to close the browsers, release the
    // request context and drop the space, in that order.
    const second = await rpc.request("createSpace", { name: "probe-2" });
    const created = await rpc.request("createTab", { spaceId: second.spaceId, url: fixtureUrl });
    await rpc.request("closeSpace", { spaceId: second.spaceId });
    await waitFor(
      "space with a live tab to disappear",
      async () => {
        const list = await rpc.request("listSpaces");
        return !list.spaces.some((s) => s.spaceId === second.spaceId);
      },
      15000,
    );
    let error = null;
    try {
      await rpc.request("cdp.send", {
        browserId: created.tabId,
        message: JSON.stringify({ id: 1, method: "Page.enable" }),
      });
    } catch (caught) {
      error = caught;
    }
    assert(error, "the tab of a closed space still accepts CDP");
    return `${second.spaceId} closed with its tab, browser ${created.tabId} gone`;
  });

  await step("quit", async () => {
    const exited = new Promise((resolvePromise) => host.once("exit", (code) => resolvePromise(code)));
    await rpc.request("quit");
    const code = await Promise.race([
      exited,
      sleep(30000).then(() => fail("host did not exit within 30 s of quit")),
    ]);
    assertEqual(code, 0, "host exit code");
    assert(!existsSync(socketPath), "the host left its socket file behind");
    return "host exited 0, socket removed";
  });
}

async function inspectPng(path) {
  const identify = spawn("identify", [
    "-format",
    "%w %h %k %[fx:standard_deviation]",
    path,
  ]);
  let out = "";
  identify.stdout.on("data", (chunk) => {
    out += chunk;
  });
  const code = await new Promise((resolvePromise) => identify.on("exit", resolvePromise));
  if (code !== 0 || !out.trim()) return "dimensions unavailable (no ImageMagick)";
  const [width, height, colours, sd] = out.trim().split(/\s+/);
  assert(Number(width) > 800, `screenshot is only ${width}px wide`);
  assert(Number(height) > 500, `screenshot is only ${height}px tall`);
  assert(Number(colours) > 50, `screenshot looks blank: ${colours} colours`);
  assert(Number(sd) > 0.02, `screenshot looks flat: sd ${sd}`);
  return `${width}x${height}, ${colours} colours, sd ${Number(sd).toFixed(3)}`;
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  const ms = results.reduce((total, r) => total + r.ms, 0);
  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write(`PASS control probe - ${results.length} checks, ${ms} ms\n`);
    process.stdout.write(`     screenshot ${pngPath}\n`);
    process.stdout.write(`     host log   ${hostLogPath}\n\n`);
  } else {
    process.stdout.write(`FAIL control probe - ${failed.length} of ${results.length} checks failed\n`);
    for (const failure of failed) {
      process.stdout.write(`     ${failure.name}: ${failure.detail}\n`);
    }
    process.stdout.write(`     host log ${hostLogPath}\n\n`);
  }
}

// A stuck host must not wedge the QA run forever.
const watchdog = setTimeout(() => {
  process.stderr.write("control probe: global timeout, giving up\n");
  cleanup();
  process.exit(1);
}, 240000);
watchdog.unref();

try {
  await main();
  summary();
  cleanup();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
} catch (error) {
  process.stderr.write(`\ncontrol probe failed: ${error?.stack ?? error}\n`);
  summary();
  cleanup();
  process.exit(1);
}
