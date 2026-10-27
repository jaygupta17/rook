#!/usr/bin/env node
/**
 * Rook (Linux) — profile + handoff probe (M4).
 *
 * Proves the product model: a profile is the isolation boundary (one
 * CefRequestContext, one storage tree), a space is a tab set inside a profile,
 * and a handoff is exclusive user control (the window reveals the space, the
 * page takes the keyboard, agent mutations stop with a machine-readable error).
 *
 *   node scripts/profile-probe.mjs --display :131
 *   node scripts/profile-probe.mjs --bin build/bin/rook --keep
 *
 * Checks, in order:
 *   1. profiles        default profile is {id:"default",name:"You"}, a created
 *                      profile appears in listProfiles and on disk
 *   2. sameProfile     sign in in one space of the default profile; a second
 *                      space of the same profile is signed in too (same storage)
 *   3. secondProfile   a space in a second profile is signed out and writes to
 *                      its own storage directory
 *   4. handoffGate     handOff reveals the space + control.changed; every agent
 *                      mutation is refused with EGO_TASK_SPACE_USER_IN_CONTROL
 *                      while reads keep working; takeOver lifts the gate
 *   5. handoffOrder    the other order: succeed, hand off, refused, take over,
 *                      succeed again
 *   6. banner          before/after handoff captures: the banner band is light
 *                      with the agent in control and dark once the user has it
 *   7. handoffFocus    the revealed space takes the keyboard: typed characters
 *                      land in the page's autofocused field, artifacts/m4-handoff.png
 *   8. switchTabs      moving to another profile's space and back keeps the
 *                      tabs and the session of the first space
 *   9. migration       a pre-M4 per-space storage dir is gone after startup
 *  10. persist         after a restart the profile's login is still there
 *
 * A fresh temp data root and private socket per run; the display is the QA
 * runner's private Xvfb. Requires xdotool, xwininfo, ImageMagick (import,
 * identify, convert) and Node 22+.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(here, "..");

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
const artifacts = resolve(args.artifacts ?? join(hostRoot, "artifacts"));
const display = args.display ?? process.env.DISPLAY ?? ":131";
const keepTemp = args.keep === true;
const verbose = args.verbose === true;
const stepTimeout = Number(args.timeout ?? 45000);

const pngPath = join(artifacts, "m4-handoff.png");
const beforePng = join(artifacts, "m4-before-handoff.png");
const hostLogPath = join(artifacts, "profile-probe-host.log");

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

// ---------------------------------------------------------------------------
// xdotool / xwininfo / ImageMagick: real input and real pixels
// ---------------------------------------------------------------------------

function run(command, rest, { capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = trackChild(
      spawn(command, rest, {
        env: { ...process.env, DISPLAY: display },
        stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
      }),
    );
    let stdout = "";
    let stderr = "";
    if (capture) child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} ${rest.join(" ")}: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

const xdo = (...rest) => run("xdotool", rest);
const captureWindow = (xid, path) => run("import", ["-window", xid, path]);

async function windowGeometry(xid) {
  const text = await run("xwininfo", ["-id", xid], { capture: true });
  const x = Number(text.match(/Absolute upper-left X:\s+(-?\d+)/)?.[1]);
  const y = Number(text.match(/Absolute upper-left Y:\s+(-?\d+)/)?.[1]);
  const width = Number(text.match(/Width:\s+(\d+)/)?.[1]);
  const height = Number(text.match(/Height:\s+(\d+)/)?.[1]);
  const viewable = /Map State: IsViewable/.test(text);
  if (![x, y, width, height].every(Number.isFinite)) {
    fail(`could not read the geometry of ${xid}`);
  }
  return { x, y, width, height, viewable };
}

async function pngSize(path) {
  const text = await run("identify", ["-format", "%w %h %k", path], { capture: true });
  const [width, height, colours] = text.trim().split(/\s+/).map(Number);
  return { width, height, colours };
}

// Mean brightness of a horizontal band to the right of the sidebar. The layout
// is 224 px sidebar, 42 px tab strip, 46 px toolbar, then the banner: y 88..118.
async function bandMean(path) {
  const { width } = await pngSize(path);
  const cropWidth = Math.max(1, width - 224);
  const text = await run(
    "convert",
    [path, "-crop", `${cropWidth}x26+224+90`, "+repage", "-format", "%[fx:mean]", "info:"],
    { capture: true },
  );
  const mean = Number(text.trim());
  assert(Number.isFinite(mean), `could not read the banner band from ${path}`);
  return mean;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 client for the control socket
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(error) {
    super(error?.message ?? "rpc error");
    this.code = error?.code;
    this.data = error?.data ?? null;
    this.reason = error?.data?.reason ?? null;
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
      } catch {
        fail(`host sent a non-JSON line: ${line.slice(0, 120)}`);
      }
      if (Object.hasOwn(message, "id")) {
        const entry = this.#pending.get(message.id);
        if (!entry) continue;
        this.#pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new RpcError(message.error));
        else entry.resolve(message.result ?? {});
        continue;
      }
      for (const listener of this.#listeners) {
        try {
          listener(message);
        } catch (error) {
          if (verbose) process.stderr.write(`listener threw: ${error?.message ?? error}\n`);
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
    if (verbose) process.stderr.write(`-> ${frame.trim()}\n`);
    this.#socket.write(frame);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer, method });
    });
  }

  async expectError(method, params, what = method) {
    try {
      await this.request(method, params);
    } catch (error) {
      if (error instanceof RpcError) return error;
      throw error;
    }
    fail(`${what} was allowed; the host should have refused it`);
  }

  close() {
    this.#socket.destroy();
  }
}

function cdpChannel(client, browserId) {
  const pending = new Map();
  let nextId = 1;
  client.onNotification((notification) => {
    if (notification.method !== "cdp.event") return;
    if (notification.params?.browserId !== browserId) return;
    let message;
    try {
      message = JSON.parse(notification.params.message);
    } catch {
      fail(`host passed a non-JSON CDP payload: ${String(notification.params.message).slice(0, 120)}`);
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
    }
  });
  return {
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
  if (result.exceptionDetails) fail(`page threw while evaluating ${expression}`);
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

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const results = [];
async function step(name, body) {
  const started = Date.now();
  try {
    const detail = await body();
    const ms = Date.now() - started;
    results.push({ name, ok: true, detail, ms });
    process.stdout.write(`  ok    ${name.padEnd(15)} ${detail ?? ""}  (${ms} ms)\n`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, detail: error?.message ?? String(error), ms });
    process.stdout.write(`  FAIL  ${name.padEnd(15)} ${error?.message ?? error}\n`);
    throw error;
  }
}

let server = null;
let temp = null;
let hostLog = null;
let host = null;
let rpc = null;
let hostStderr = "";
let lifecycle = [];

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

function cleanup() {
  if (rpc) {
    rpc.close();
    rpc = null;
  }
  killChildren();
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
  if (hostLog) {
    try {
      hostLog.end();
    } catch {
      /* ignore */
    }
    hostLog = null;
  }
  if (temp && !keepTemp) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    temp = null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  assert(existsSync(bin), `no host binary at ${bin} (build it first, or pass --bin)`);
  mkdirSync(artifacts, { recursive: true });
  rmSync(pngPath, { force: true });
  rmSync(beforePng, { force: true });

  temp = mkdtempSync(join(tmpdir(), "rook-m4-probe-"));
  const dataDir = join(temp, "data");
  const runDir = join(temp, "run");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const socketPath = join(runDir, "rook.sock");
  const profileRoot = join(dataDir, "rook", "profiles");
  hostLog = createWriteStream(hostLogPath, { flags: "w" });

  // Pre-M4 storage dirs: one CEF profile per space inside the profile dir. The
  // host must remove them instead of mixing the two layouts.
  const legacyDir = join(profileRoot, "default", "agent-legacy");
  mkdirSync(join(legacyDir, "Cache"), { recursive: true });
  mkdirSync(join(legacyDir, "Local Storage"), { recursive: true });
  writeFileSync(join(legacyDir, "Preferences"), '{"pre-M4":true}');

  const { port } = await new Promise((resolvePromise, reject) => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      const file = path === "/" ? "session.html" : path.replace(/^\//, "");
      const full = join(hostRoot, "fixtures", file);
      if (!existsSync(full)) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(readFileSync(full));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(server.address()));
  });
  const fixtureUrl = `http://127.0.0.1:${port}/session.html`;

  process.stdout.write(`\nRook profile + handoff probe\n`);
  process.stdout.write(`  host       ${bin}\n`);
  process.stdout.write(`  display    ${display}\n`);
  process.stdout.write(`  data       ${dataDir}\n`);
  process.stdout.write(`  fixture    ${fixtureUrl}\n\n`);

  const launch = async () => {
    hostStderr = "";
    lifecycle = [];
    host = trackChild(
      spawn(
        bin,
        ["--window-size", "1280x820", "--socket-path", socketPath, "--password-store=basic"],
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
      ),
    );
    host.stderr.on("data", (chunk) => {
      hostStderr += chunk;
      hostLog.write(chunk);
      if (verbose) process.stderr.write(chunk);
    });
    await waitFor("control socket", () => existsSync(socketPath), 40000, 50);
    rpc = await Rpc.connect(socketPath, 10000);
    rpc.onNotification((notification) => {
      if (/^(space|tab|control|profile)\.|^cdp\./.test(notification.method ?? "")) {
        lifecycle.push({ method: notification.method, params: notification.params });
      }
    });
    return waitFor(
      "toplevel window",
      async () => {
        const match = hostStderr.match(/window xid (0x[0-9a-f]+)/);
        return match ? match[1] : null;
      },
      10000,
    );
  };

  let toplevel = await launch();

  const attach = async (tabId, marker) => {
    const cdp = cdpChannel(rpc, tabId);
    const target = await waitFor("page target", async () => {
      const result = await cdp.send("Target.getTargets", {});
      // Target.getTargets is process-wide (README), so the URL has to name the
      // space: the whole probe loads the same origin on purpose.
      return (
        result.targetInfos?.find(
          (info) =>
            info.type === "page" &&
            String(info.url).includes("/session.html") &&
            String(info.url).includes(`space=${marker}`),
        ) ?? null
      );
    }, 30000);
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, { sessionId });
    await waitFor("page loaded", async () => {
      const ready = await evaluate(cdp, "document.readyState", sessionId);
      const hasField = await evaluate(cdp, "!!document.getElementById('note')", sessionId);
      return ready === "complete" && hasField;
    }, 30000);
    return { cdp, sessionId };
  };

  const sessionOf = async ({ cdp, sessionId }) => {
    const value = await evaluate(cdp, "JSON.stringify(window.__session())", sessionId);
    return JSON.parse(value);
  };

  const openSpace = async (name, profileId, marker) => {
    const created = await rpc.request(
      "createSpace",
      profileId === undefined ? { name } : { name, profileId },
    );
    const tab = await rpc.request("createTab", {
      spaceId: created.spaceId,
      url: `${fixtureUrl}?space=${marker}`,
    });
    return { spaceId: created.spaceId, tabId: tab.tabId, marker, profileId: tab.profileId };
  };

  const spacesOf = async () => (await rpc.request("listSpaces")).spaces;

  let defaultProfileId = null;
  let workProfileId = null;
  let a = null;
  let aCdp = null;
  let bCdp = null;
  let c = null;
  let cCdp = null;

  await step("profiles", async () => {
    const list = await rpc.request("listProfiles");
    const def = list.profiles.find((profile) => profile.isDefault === true);
    assert(def, "no profile is marked isDefault");
    assertEqual(def.id, "default", "default profile id");
    assertEqual(def.name, "You", "default profile name");
    assertEqual(list.defaultProfileId, def.id, "defaultProfileId");
    assert(existsSync(def.path), `default profile dir missing: ${def.path}`);
    defaultProfileId = def.id;

    const created = await rpc.request("createProfile", { name: "Work laptop" });
    workProfileId = created.profileId;
    assertEqual(workProfileId, "work-laptop", "created profile id");
    const after = await rpc.request("listProfiles");
    const work = after.profiles.find((profile) => profile.id === workProfileId);
    assert(work, "the new profile is not in listProfiles");
    assertEqual(work.name, "Work laptop", "profile name");
    assertEqual(work.isDefault, false, "new profile is default");
    assert(existsSync(work.path), `profile dir missing: ${work.path}`);
    const duplicate = await rpc.expectError("createProfile", { name: "Work laptop" });
    assert(duplicate.reason, "duplicate profile error carries no reason");
    return `${def.id} "You" + ${workProfileId} on disk`;
  });

  await step("sameProfile", async () => {
    const list = await spacesOf();
    const youSpace = list.find((space) => space.user === true);
    assert(youSpace, "the You space is missing");
    assertEqual(youSpace.profileId, defaultProfileId, "You space profileId");

    a = await openSpace("agent a", undefined, "a");
    aCdp = await attach(a.tabId, "a");
    // Sign in: a cookie and a localStorage entry, the two storages a session is.
    await evaluate(
      aCdp.cdp,
      "(() => { localStorage.setItem('rook-login','jay@example.com');" +
        " document.cookie='rook-login=jay@example.com; path=/; max-age=86400';" +
        " return JSON.stringify(window.__session()); })()",
      aCdp.sessionId,
    );
    const signedIn = await sessionOf(aCdp);
    assertEqual(signedIn.ls, "jay@example.com", "localStorage after sign-in");
    assert(signedIn.ck.includes("rook-login=jay@example.com"), `cookie after sign-in: ${signedIn.ck}`);

    const b = await openSpace("agent b", undefined, "b");
    bCdp = await attach(b.tabId, "b");
    const shared = await sessionOf(bCdp);
    assertEqual(shared.ls, "jay@example.com", "second space sees the same localStorage");
    assert(
      shared.ck.includes("rook-login=jay@example.com"),
      `second space does not see the cookie: ${shared.ck}`,
    );

    const list2 = await spacesOf();
    const spaceA = list2.find((space) => space.spaceId === a.spaceId);
    const spaceB = list2.find((space) => space.spaceId === b.spaceId);
    assertEqual(spaceA.profileId, defaultProfileId, "space a profileId");
    assertEqual(spaceB.profileId, defaultProfileId, "space b profileId");
    assertEqual(spaceA.cache, spaceB.cache, "two spaces of one profile use one storage dir");
    return `${a.spaceId} signed in, ${b.spaceId} shares it (${spaceA.cache})`;
  });

  await step("secondProfile", async () => {
    c = await openSpace("agent c", workProfileId, "c");
    cCdp = await attach(c.tabId, "c");
    const fresh = await sessionOf(cCdp);
    assert(fresh.ls === null, `second profile saw localStorage ${JSON.stringify(fresh.ls)}`);
    assert(!fresh.ck.includes("rook-login="), `second profile saw the cookie: ${fresh.ck}`);
    // Give it its own session so both profile dirs hold data of their own.
    await evaluate(
      cCdp.cdp,
      "(() => { localStorage.setItem('rook-login','work@example.com');" +
        " document.cookie='rook-login=work@example.com; path=/; max-age=86400';" +
        " return JSON.stringify(window.__session()); })()",
      cCdp.sessionId,
    );

    const list = await spacesOf();
    const spaceC = list.find((space) => space.spaceId === c.spaceId);
    const spaceA = list.find((space) => space.spaceId === a.spaceId);
    assertEqual(spaceC.profileId, workProfileId, "space c profileId");
    assert(spaceC.cache !== spaceA.cache, "the two profiles share one storage dir");
    const leveldbs = (dir) => {
      const out = [];
      const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "leveldb") out.push(full);
            else walk(full);
          }
        }
      };
      walk(dir);
      return out;
    };
    const defaultStores = leveldbs(spaceA.cache);
    const workStores = leveldbs(spaceC.cache);
    assert(defaultStores.length > 0, `no leveldb store under ${spaceA.cache}`);
    assert(workStores.length > 0, `no leveldb store under ${spaceC.cache}`);
    return `${c.spaceId} in ${workProfileId} is signed out (${spaceC.cache}, ${workStores.length} store(s))`;
  });

  await step("handoffGate", async () => {
    const before = (await rpc.request("listSpaces")).activeSpaceId;
    const handed = await rpc.request("handOff", { spaceId: a.spaceId });
    assertEqual(handed.ownership, "user", "handOff result");
    const after = await rpc.request("listSpaces");
    assertEqual(after.activeSpaceId, a.spaceId, "handOff did not reveal the space");
    assertEqual(
      after.spaces.find((space) => space.spaceId === a.spaceId).ownership,
      "user",
      "ownership after handOff",
    );
    await waitFor(
      "control.changed user",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "control.changed" &&
            event.params?.spaceId === a.spaceId &&
            event.params.state === "user",
        ),
      5000,
    );

    // Reads stay available: a bridge keeps listTabs/getInfo/listSpaces after a
    // handoff, it just cannot drive the page.
    const tabs = await rpc.request("listTabs", { spaceId: a.spaceId });
    assertEqual(tabs.tabs[0].tabId, a.tabId, "listTabs during handoff");
    const info = await rpc.request("getInfo");
    assertEqual(info.protocol, "3", "protocol after M4");

    const reasonErrors = [];
    const blocked = await rpc.expectError("cdp.send", {
      browserId: a.tabId,
      message: JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "1+1" } }),
    });
    assertEqual(blocked.code, -32002, "cdp.send error code");
    assertEqual(blocked.reason, "EGO_TASK_SPACE_USER_IN_CONTROL", "cdp.send reason");
    reasonErrors.push("cdp.send");
    const blockedPush = await waitFor(
      "cdp.error with the reason",
      () =>
        lifecycle
          .slice()
          .reverse()
          .find((event) => event.method === "cdp.error")?.params ?? null,
      5000,
    );
    assertEqual(blockedPush.reason, "EGO_TASK_SPACE_USER_IN_CONTROL", "cdp.error reason");
    for (const [name, params] of [
      ["createTab", { spaceId: a.spaceId, url: fixtureUrl }],
      ["closeTab", { spaceId: a.spaceId, tabId: a.tabId }],
      ["navigate", { tabId: a.tabId, url: `${fixtureUrl}?nope=1` }],
      ["activateTab", { spaceId: a.spaceId, tabId: a.tabId }],
      ["highlightMouseTo", { spaceId: a.spaceId, x: 40, y: 40 }],
    ]) {
      const error = await rpc.expectError(name, params, `${name} during handoff`);
      assertEqual(error.reason, "EGO_TASK_SPACE_USER_IN_CONTROL", `${name} reason`);
      reasonErrors.push(name);
    }

    await rpc.request("takeOver", { spaceId: a.spaceId });
    await waitFor(
      "control.changed agent",
      () =>
        lifecycle.find(
          (event) =>
            event.method === "control.changed" &&
            event.params?.spaceId === a.spaceId &&
            event.params.state === "agent",
        ),
      5000,
    );
    const sum = await evaluate(aCdp.cdp, "1+1", aCdp.sessionId);
    assertEqual(sum, 2, "cdp.send after takeOver");
    return `handed off (window ${before} -> ${a.spaceId}), ${reasonErrors.length} ops refused with the reason, takeOver drives again`;
  });

  await step("handoffOrder", async () => {
    // The other order: driving first, then a handoff, then a take-over.
    const first = await evaluate(aCdp.cdp, "2+2", aCdp.sessionId);
    assertEqual(first, 4, "cdp.send before handOff");
    await rpc.request("handOff", { spaceId: a.spaceId });
    const blocked = await rpc.expectError("cdp.send", {
      browserId: a.tabId,
      message: JSON.stringify({ id: 100, method: "Runtime.evaluate", params: { expression: "3+3" } }),
    });
    assertEqual(blocked.reason, "EGO_TASK_SPACE_USER_IN_CONTROL", "second handoff reason");
    await rpc.request("takeOver", { spaceId: a.spaceId });
    const last = await evaluate(aCdp.cdp, "4+4", aCdp.sessionId);
    assertEqual(last, 8, "cdp.send after the second takeOver");
    return "success -> handOff -> refused -> takeOver -> success";
  });

  await step("banner", async () => {
    // The agent is in control again: no banner, so the band above the page is
    // the page (light). Captured now and compared after the next handoff.
    await xdo("windowfocus", "--sync", toplevel);
    await sleep(250);
    await captureWindow(toplevel, beforePng);
    const light = await bandMean(beforePng);
    assert(light > 0.6, `no handoff is expected here, but the banner band is dark (${light})`);
    return `band ${light.toFixed(3)} with the agent in control (no banner)`;
  });

  await step("handoffFocus", async () => {
    await xdo("windowfocus", "--sync", toplevel);
    await sleep(300);
    await rpc.request("handOff", { spaceId: a.spaceId });
    await waitFor(
      "the handed-off space on screen",
      async () => (await rpc.request("listSpaces")).activeSpaceId === a.spaceId,
      5000,
    );
    await sleep(400);
    // No click: the handoff itself has to put the keyboard in the page. CDP is
    // an agent mutation and is refused from here on, so what follows is real
    // X input first and the read-back after takeOver.
    await xdo("type", "--delay", "40", "hello m4");
    await sleep(300);

    await captureWindow(toplevel, pngPath);
    const dark = await bandMean(pngPath);
    assert(dark < 0.3, `the handoff banner is not visible (band ${dark.toFixed(3)})`);
    const size = await pngSize(pngPath);
    assert(size.width >= 1200 && size.height >= 700, `screenshot is ${size.width}x${size.height}`);
    assert(size.colours >= 500, `screenshot looks blank: ${size.colours} colours`);

    await rpc.request("takeOver", { spaceId: a.spaceId });
    const typed = await evaluate(aCdp.cdp, "document.getElementById('note').value", aCdp.sessionId);
    assertEqual(typed, "hello m4", "text typed after the handoff");
    assertEqual(await evaluate(aCdp.cdp, "document.hasFocus()", aCdp.sessionId), true,
      "the page has focus after the handoff");
    // The visible page is the signed-in one, so the banner and the session are
    // in the same frame.
    const session = await sessionOf(aCdp);
    assertEqual(session.ls, "jay@example.com", "session on screen in the handed-off space");
    return `typed into the page, banner band ${dark.toFixed(3)}, ${pngPath}`;
  });

  await step("switchTabs", async () => {
    // A profile switch: show the other profile's space, then come back. Tabs and
    // the session of the first space have to survive it.
    await rpc.request("activateSpace", { spaceId: c.spaceId });
    await waitFor(
      "window on the work profile",
      async () => (await rpc.request("listSpaces")).activeSpaceId === c.spaceId,
      5000,
    );
    const workSession = await sessionOf(cCdp);
    assertEqual(workSession.ls, "work@example.com", "work profile session after the switch");
    await rpc.request("activateSpace", { spaceId: a.spaceId });
    const tabs = await rpc.request("listTabs", { spaceId: a.spaceId });
    assertEqual(tabs.tabs.length, 1, "tab count after the switch");
    assert(tabs.tabs[0].url.includes("/session.html"), `tab url after the switch: ${tabs.tabs[0].url}`);
    const back = await sessionOf(aCdp);
    assertEqual(back.ls, "jay@example.com", "default profile session after the switch");
    // The typed text is still in the page: the tab was parked, not reloaded.
    const typed = await evaluate(aCdp.cdp, "document.getElementById('note').value", aCdp.sessionId);
    assertEqual(typed, "hello m4", "tab state after the switch");
    return "work profile and back, tab + session + field keep their state";
  });

  await step("migration", async () => {
    assert(!existsSync(legacyDir), `pre-M4 space storage was not removed: ${legacyDir}`);
    assert(
      hostStderr.includes("removed legacy per-space storage"),
      "the host did not report removing the pre-M4 layout",
    );
    return "pre-M4 per-space dir removed and reported";
  });

  await step("persist", async () => {
    // Restart on the same data root: the profile keeps its own storage.
    const exited = new Promise((resolvePromise) =>
      host.once("exit", (code) => resolvePromise(code)),
    );
    try {
      await rpc.request("quit", {}, 5000);
    } catch {
      /* the host may close the socket before replying */
    }
    const code = await Promise.race([
      exited,
      sleep(30000).then(() => fail("host did not exit within 30 s of quit")),
    ]);
    assertEqual(code, 0, "host exit code");
    rpc.close();
    rpc = null;

    toplevel = await launch();
    const spaces = await rpc.request("listSpaces");
    assertEqual(spaces.spaces.length, 1, "a restart starts with only the user space");
    const d = await openSpace("after restart", undefined, "d");
    const dCdp = await attach(d.tabId, "d");
    const session = await sessionOf(dCdp);
    assertEqual(session.ls, "jay@example.com", "localStorage after a restart");
    assert(
      session.ck.includes("rook-login=jay@example.com"),
      `cookie after a restart: ${session.ck}`,
    );
    const profiles = await rpc.request("listProfiles");
    assert(
      profiles.profiles.some((profile) => profile.id === workProfileId),
      "the created profile did not survive the restart",
    );
    return `restarted, ${d.spaceId} is still signed in, ${workProfileId} still listed`;
  });

  // Leave nothing running: the next phase gets its own display and socket.
  try {
    await rpc.request("quit", {}, 3000);
  } catch {
    /* already gone */
  }
}

function summary() {
  const failed = results.filter((result) => !result.ok);
  const ms = results.reduce((total, result) => total + result.ms, 0);
  process.stdout.write("\n");
  if (failed.length === 0) {
    process.stdout.write(`PASS profile probe - ${results.length} checks, ${ms} ms\n`);
    process.stdout.write(`     screenshot ${pngPath}\n`);
    process.stdout.write(`     host log   ${hostLogPath}\n\n`);
  } else {
    process.stdout.write(`FAIL profile probe - ${failed.length} of ${results.length} checks failed\n`);
    for (const failure of failed) {
      process.stdout.write(`     ${failure.name}: ${failure.detail}\n`);
    }
    process.stdout.write(`     host log ${hostLogPath}\n\n`);
  }
}

const watchdog = setTimeout(() => {
  process.stderr.write("profile probe: global timeout, giving up\n");
  cleanup();
  process.exit(1);
}, 300000);
watchdog.unref();

try {
  await main();
  summary();
  cleanup();
  process.exit(results.every((result) => result.ok) ? 0 : 1);
} catch (error) {
  process.stderr.write(`\nprofile probe failed: ${error?.stack ?? error}\n`);
  summary();
  cleanup();
  process.exit(1);
}
