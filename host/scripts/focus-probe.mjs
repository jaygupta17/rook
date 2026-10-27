#!/usr/bin/env node
/**
 * Rook (Linux) — keyboard-focus probe.
 *
 * Proves the thing a browser is useless without: clicking into the page and
 * typing puts the characters in the page, while the address bar stays out of
 * it. The page is a native X child window of the GTK shell, so this is the one
 * place where "who owns the keyboard" is decided by X input focus, and this
 * probe drives it the way a person does: xdotool clicks, xdotool keystrokes,
 * and the DOM read back over CDP.
 *
 *   node scripts/focus-probe.mjs
 *   node scripts/focus-probe.mjs --bin build/bin/rook --display :131
 *   node scripts/focus-probe.mjs --keep     # keep the temp profile
 *
 * Checks, in order:
 *   1. clickTyping      click the name field, type "Jay Gupta": the field holds
 *                       exactly that, and the address bar still holds the URL
 *   2. escapeToPage     type into the address bar, Escape, click the page, type
 *                       again: the text goes to the page, the URL is unchanged
 *   3. tabAndEnter      Tab moves the field focus, Enter submits the form
 *   4. shortcut         Ctrl+L still reaches the shell while the page is focused
 *   5. screenshot       artifacts/m3-focus-form.png shows the typed text
 *
 * Requires xdotool (real input), xclip (reading the URL entry back) and a
 * running X display (the QA runner passes a private Xvfb).
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
  rmSync,
  statSync,
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
const stepTimeout = Number(args.timeout ?? 30000);

const pngPath = join(artifacts, "m3-focus-form.png");
const hostLogPath = join(artifacts, "focus-probe-host.log");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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
// xdotool / xclip: the probe types the way a person does.
// ---------------------------------------------------------------------------

function xdo(command, ...rest) {
  return new Promise((resolvePromise, reject) => {
    const child = trackChild(
      spawn("xdotool", [command, ...rest], {
        env: { ...process.env, DISPLAY: display },
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`xdotool ${command} ${rest.join(" ")}: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function xclipRead() {
  return new Promise((resolvePromise) => {
    const child = trackChild(
      spawn("xclip", ["-o", "-selection", "clipboard"], {
        env: { ...process.env, DISPLAY: display },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolvePromise(null));
    child.on("exit", () => resolvePromise(stdout));
  });
}

function captureWindow(xid, path) {
  return new Promise((resolvePromise, reject) => {
    const child = trackChild(
      spawn("import", ["-window", xid, path], {
        env: { ...process.env, DISPLAY: display },
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`import -window ${xid}: ${stderr.trim()}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC client for the control socket (newline-delimited JSON 2.0)
// ---------------------------------------------------------------------------

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
        if (message.error) {
          entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        } else {
          entry.resolve(message.result ?? {});
        }
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

let server = null;
let rpc = null;
let temp = null;
let hostLog = null;
let host = null;

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

async function step(name, fn) {
  const started = Date.now();
  let detail;
  try {
    detail = await fn();
  } catch (error) {
    if (host !== null && (host.exitCode !== null || host.signalCode !== null)) {
      throw new Error(
        `${name}: ${error.message} (host exit=${host.exitCode} signal=${host.signalCode})`,
      );
    }
    throw new Error(`${name}: ${error.message}`);
  }
  const elapsed = Date.now() - started;
  process.stdout.write(`  ${name.padEnd(16)} ${detail} (${elapsed} ms)\n`);
}

async function main() {
  if (!existsSync(bin)) fail(`host binary not found: ${bin}`);
  mkdirSync(artifacts, { recursive: true });
  rmSync(pngPath, { force: true });
  temp = mkdtempSync(join(tmpdir(), "rook-focus-"));
  const dataDir = join(temp, "data");
  const runDir = join(temp, "run");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const socketPath = join(runDir, "rook.sock");
  hostLog = createWriteStream(hostLogPath);

  const { port } = await new Promise((resolvePromise, reject) => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      const file = path === "/" ? "form.html" : path.replace(/^\//, "");
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
  const fixtureUrl = `http://127.0.0.1:${port}/form.html`;

  let hostStderr = "";
  host = trackChild(
    spawn(bin, [
      "--window-size", "1280x820",
      "--socket-path", socketPath,
      // A keyring prompt on a bare Xvfb would steal the focus this probe is
      // about to measure.
      "--password-store=basic",
    ], {
      env: {
        ...process.env,
        DISPLAY: display,
        XDG_RUNTIME_DIR: runDir,
        XDG_DATA_HOME: dataDir,
        HOME: temp,
      },
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  host.stderr.on("data", (chunk) => {
    hostStderr += chunk;
    hostLog.write(chunk);
    if (verbose) process.stderr.write(chunk);
  });

  await waitFor("control socket", () => existsSync(socketPath), 30000, 50);
  rpc = await Rpc.connect(socketPath, 10000);
  const info = await rpc.request("getInfo");
  const userSpaceId = info.state.activeSpaceId;

  const space = await rpc.request("createSpace", { name: "focus" });
  const spaceId = space.spaceId;
  const tab = await rpc.request("createTab", { spaceId, url: fixtureUrl });
  const tabId = tab.tabId;
  await rpc.request("activateSpace", { spaceId });
  await waitFor("active tab", async () => {
    const tabs = await rpc.request("listTabs", { spaceId });
    return tabs.activeTabId === tabId;
  });

  // The browser's X window is where the page's viewport starts: its absolute
  // origin plus a DOM rectangle is a screen coordinate xdotool can click.
  const windowLine = await waitFor("browser window", async () => {
    const match = hostStderr.match(new RegExp(`tab ${tabId} browser ready \\(xid (0x[0-9a-f]+)\\)`));
    return match ? match[1] : null;
  }, 20000);
  const toplevel = await waitFor("toplevel window", async () => {
    const match = hostStderr.match(/window xid (0x[0-9a-f]+)/);
    return match ? match[1] : null;
  }, 5000);

  // The report's repro starts "with the app focused"; on a real desktop the
  // first click would spend itself on focusing the window, so focus it first.
  // windowfocus (XSetInputFocus) rather than windowactivate: Xvfb has no window
  // manager, so there is no _NET_ACTIVE_WINDOW to ask for.
  await xdo("windowfocus", "--sync", toplevel);
  await sleep(300);

  const cdp = cdpChannel(rpc, tabId);
  const target = await waitFor("page target", async () => {
    const result = await cdp.send("Target.getTargets", {});
    return result.targetInfos?.find((t) => t.type === "page" && t.url === fixtureUrl) ?? null;
  }, 20000);
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, { sessionId });
  // The tab starts at about:blank, whose readyState is already "complete": wait
  // for the fixture document itself, field and all.
  await waitFor("page loaded", async () => {
    const href = await evaluate(cdp, "location.href", sessionId);
    const ready = await evaluate(cdp, "document.readyState", sessionId);
    const hasField = await evaluate(cdp, "!!document.getElementById('name')", sessionId);
    return href === fixtureUrl && ready === "complete" && hasField;
  });

  const geometry = async (xid) => {
    const text = await new Promise((resolvePromise, reject) => {
      const child = trackChild(
        spawn("xwininfo", ["-id", xid], {
          env: { ...process.env, DISPLAY: display },
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolvePromise(stdout) : reject(new Error(`xwininfo ${xid}`))));
    });
    const x = Number(text.match(/Absolute upper-left X:\s+(-?\d+)/)?.[1]);
    const y = Number(text.match(/Absolute upper-left Y:\s+(-?\d+)/)?.[1]);
    const viewable = /Map State: IsViewable/.test(text);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`could not read the geometry of ${xid}`);
    return { x, y, viewable };
  };
  // The window manager may still be placing the window when the tab first
  // appears; a click aimed at a stale origin lands somewhere else entirely.
  // Wait for a viewable window at a position that holds across two reads.
  let origin = await geometry(windowLine);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(50);
    const again = await geometry(windowLine);
    if (origin.viewable && again.viewable && again.x === origin.x && again.y === origin.y) {
      origin = again;
      break;
    }
    origin = again;
  }
  assert(origin.viewable, `the page window ${windowLine} is not viewable`);

  // Poll a value the page computes; used instead of fixed sleeps so a slow
  // frame never turns into a flaky check.
  const waitForValue = async (expression, predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(cdp, expression, sessionId);
      if (predicate(last)) return last;
      await sleep(50);
    }
    return last;
  };

  // Click the centre of an element: DOM rectangle (viewport) + window origin.
  const clickElement = async (id) => {
    const rect = JSON.parse(
      await evaluate(
        cdp,
        `JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`,
        sessionId,
      ),
    );
    const x = Math.round(origin.x + rect.left + rect.width / 2);
    const y = Math.round(origin.y + rect.top + rect.height / 2);
    // Park the pointer outside the page first: a click on a spot the pointer
    // already occupies produces no crossing event, and the probe would then be
    // measuring that edge instead of the ordinary path.
    await xdo("mousemove", "4", "4");
    await sleep(60);
    if (verbose) process.stderr.write(`click #${id} at ${x},${y} (origin ${origin.x},${origin.y})\n`);
    await xdo("mousemove", String(x), String(y));
    await xdo("click", "1");
    // The hand-off is asynchronous by design (it has to outrank GTK's own focus
    // on the click), so wait until the page has both the DOM focus and the
    // keyboard before typing.
    await waitForValue("document.activeElement && document.activeElement.id", (v) => v === id, 2000);
    await waitForValue("document.hasFocus()", (v) => v === true, 2000);
  };
  const type = async (text) => {
    await xdo("type", "--delay", "30", text);
    await sleep(200);
  };
  // The address bar is a GTK widget inside the toplevel, so a click on it goes
  // to the shell (not to the page). Clicking is the reliable way to focus it:
  // the Ctrl+L shortcut is checked separately below, and on a display with no
  // window manager it may move the keyboard without the entry ever seeing the
  // following keys — a click always works.
  const clickAddressBar = async () => {
    const toplevelGeometry = await geometry(toplevel);
    const x = Math.round(toplevelGeometry.x + 600);
    const y = Math.round(toplevelGeometry.y + 65);
    await xdo("mousemove", "4", "4");
    await sleep(60);
    await xdo("mousemove", String(x), String(y));
    await xdo("click", "1");
    await sleep(150);
  };
  // Ctrl+A selects the whole address, Ctrl+C copies it, and the X clipboard is
  // what the entry really holds.
  const readAddressBar = async () => {
    let text = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clickAddressBar();
      await xdo("key", "ctrl+a");
      await sleep(120);
      await xdo("key", "ctrl+c");
      await sleep(150);
      text = (await xclipRead()) ?? "";
      if (text.startsWith("http")) break;
      await sleep(120);
    }
    await xdo("key", "Escape");
    await sleep(200);
    return text;
  };

  await step("clickTyping", async () => {
    await clickElement("name");
    assertEqual(
      await evaluate(cdp, "document.activeElement && document.activeElement.id", sessionId),
      "name",
      "clicked field is not focused",
    );
    await type("Jay Gupta");
    assertEqual(
      await evaluate(cdp, "document.getElementById('name').value", sessionId),
      "Jay Gupta",
      "text typed into the field",
    );
    assertEqual(await evaluate(cdp, "document.hasFocus()", sessionId), true, "the page has focus");
    return `"Jay Gupta" in #name`;
  });

  await step("addressBar", async () => {
    const text = await readAddressBar();
    assert(text !== null, "could not read the address bar back (is xclip installed?)");
    const entry = text.trim();
    assertEqual(entry, fixtureUrl, "address bar contents");
    assert(!entry.includes("Jay Gupta"), `the typed text leaked into the address bar: ${entry}`);
    return "entry still shows the URL";
  });

  await step("escapeToPage", async () => {
    await clickAddressBar();
    await type("nonsense.press.escape");
    await xdo("key", "Escape");
    await sleep(300);
    await clickElement("email");
    await type("jay@example.com");
    assertEqual(
      await evaluate(cdp, "document.getElementById('email').value", sessionId),
      "jay@example.com",
      "text typed after Escape",
    );
    assertEqual(await evaluate(cdp, "location.pathname", sessionId), "/form.html", "the page URL");
    const entry = (await readAddressBar()) ?? "";
    assert(!entry.includes("nonsense"), `Escape left the typed address in the bar: ${entry}`);
    return `Escape -> page, entry clean`;
  });

  await step("tabAndEnter", async () => {
    await clickElement("name");
    await xdo("key", "Tab");
    await sleep(250);
    assertEqual(
      await evaluate(cdp, "document.activeElement && document.activeElement.id", sessionId),
      "email",
      "Tab moved to the next field",
    );
    await xdo("key", "Return");
    await sleep(300);
    assertEqual(await evaluate(cdp, "window.__submits", sessionId), 1, "Enter submitted the form");
    return "Tab -> #email, Enter submitted";
  });

  await step("shortcut", async () => {
    // Ctrl+L while the page has the keyboard is the shell's shortcut (the grab
    // is reported as "chrome shortcut grabs ... installed" at startup). What
    // this step can prove in every environment is the recovery: Escape leaves
    // the edit, the page takes the keyboard back and typing lands in the field.
    // Where the keys typed *during* a Ctrl+L go depends on the X focus, which a
    // display without a window manager does not settle; the artifact is a run
    // with a WM.
    await clickElement("name");
    const before = await evaluate(cdp, "document.getElementById('name').value", sessionId);
    await xdo("key", "ctrl+l");
    await sleep(250);
    await xdo("key", "Escape");
    await sleep(300);
    await clickElement("name");
    await type("Rabi");
    assertEqual(
      await evaluate(cdp, "document.getElementById('name').value", sessionId),
      `${before}Rabi`,
      "typing after Ctrl+L/Escape",
    );
    return "Ctrl+L + Escape give the page the keyboard back";
  });

  await step("screenshot", async () => {
    await captureWindow(toplevel, pngPath);
    const size = statSync(pngPath).size;
    assert(size > 1000, `screenshot looks empty (${size} bytes)`);
    return `${pngPath} (${Math.round(size / 1024)} KB)`;
  });

  // Fire and forget: the host closes the socket as it quits.
  try {
    rpc.request("quit", {}, 2000).catch(() => {});
    await sleep(300);
  } catch {
    /* already gone */
  }
  if (userSpaceId === spaceId) fail("the probe replaced the user space");
}

main()
  .then(() => {
    cleanup();
    process.stdout.write("\nfocus-probe: OK\n");
    process.exit(0);
  })
  .catch((error) => {
    cleanup();
    process.stderr.write(`\nfocus-probe: FAIL ${error.message}\n`);
    process.exit(1);
  });
