#!/usr/bin/env node
/**
 * Proof that the official ego-browser skill drives the *native* app.
 *
 *   scripts/demo-host.mjs                 # start the app, run the round, capture the window
 *   scripts/demo-host.mjs --keep          # leave the app running afterwards
 *   scripts/demo-host.mjs --socket PATH   # attach to an app that is already running
 *
 * What it does:
 *   1. starts host/build/bin/rook on a private XDG_RUNTIME_DIR if no control
 *      socket answers (and a private Xvfb display if DISPLAY has no server);
 *   2. runs an `ego-browser nodejs` round — the same CLI and the same SDK the
 *      skill uses — with ROOK_BACKEND=host: create a task space, open a tab
 *      on a local fixture, take a snapshot, click a ref from that snapshot;
 *   3. asks the app to show the space (`activateSpace`, view only; the sidebar
 *      row is still clicked when the app is too old to have the op), and
 *      captures the app window to artifacts/host-demo.png.
 *
 * The screenshot is the proof: the window is showing a space and a page that
 * only the bridge could have opened (the fixture URL carries the run's port and
 * timestamp), rendered by CEF inside the GTK window.
 *
 * No dependencies: node:net for the control socket, xdotool + ImageMagick for
 * the click and the capture (both are optional, the round still runs without).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostControlClient, hostSocketPaths } from "../runtime/backends/host.js";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(HERE, "bin", "ego-browser");
const HOST_BIN = join(HERE, "host", "build", "bin", "rook");
const ARTIFACTS = join(HERE, "artifacts");
const PNG_PATH = join(ARTIFACTS, "host-demo.png");
const UPSTREAM =
  process.env.ROOK_UPSTREAM || join(HERE, "vendor", "ego-browser");
const SDK_PATH = process.env.EGO_BROWSER_SDK_PATH || join(UPSTREAM, "dist", "out", "index.js");
const DISPLAY = process.env.ROOK_DISPLAY || process.env.DISPLAY || ":99";

const args = new Set(process.argv.slice(2));
const keepApp = args.has("--keep");
const socketArg = valueOf("--socket");

const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : null;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

function run(command, argv, { env = {}, input = "", timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, argv, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${error?.message || error}` });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// --- display / app ---------------------------------------------------------

async function displayAlive() {
  const probe = await run("/usr/bin/env", ["xdpyinfo", "-display", DISPLAY], { timeoutMs: 10000 });
  return probe.code === 0;
}

async function ensureDisplay() {
  if (await displayAlive()) return null;
  for (const candidate of [process.env.ROOK_XVFB_BIN, "Xvfb"]) {
    if (!candidate) continue;
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const xvfb = spawn(candidate, [DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac"], {
      stdio: "ignore",
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [process.env.ROOK_XVFB_LIB, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    });
    children.push(xvfb);
    for (let i = 0; i < 40; i += 1) {
      await sleep(125);
      if (await displayAlive()) return xvfb;
    }
    xvfb.kill("SIGKILL");
  }
  throw new Error(`no X display on ${DISPLAY} and no Xvfb to start one`);
}

async function liveSocket() {
  if (socketArg) return socketArg;
  for (const path of hostSocketPaths()) {
    if (!existsSync(path)) continue;
    const client = new HostControlClient({ socketPath: path });
    try {
      await client.connect(600);
      const info = await client.request("getInfo", {}, { timeoutMs: 1500 });
      if (info?.version) return path;
    } catch {
      // Not ours, or not answering: keep looking.
    } finally {
      client.close();
    }
  }
  return null;
}

async function startApp() {
  if (!existsSync(HOST_BIN)) {
    throw new Error(`no app binary at ${HOST_BIN} (build host/ first)`);
  }
  const root = await mkdtemp(join(tmpdir(), "rook-demo-"));
  const runDir = join(root, "run");
  const dataDir = join(root, "data");
  await mkdir(runDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const app = spawn(
    HOST_BIN,
    ["--profile", "demo", "--data-root", join(dataDir, "rook"), "--window-size", "1280x820"],
    {
      env: {
        ...process.env,
        DISPLAY,
        XDG_RUNTIME_DIR: runDir,
        XDG_DATA_HOME: dataDir,
        HOME: root,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  children.push(app);
  let log = "";
  app.stderr.on("data", (chunk) => {
    log += chunk;
    if (log.length > 20000) log = log.slice(-10000);
  });
  const socketPath = join(runDir, `rook-${process.getuid()}.sock`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(`the app exited during startup (code ${app.exitCode})\n${log}`);
    }
    if (existsSync(socketPath)) break;
    await sleep(100);
  }
  if (!existsSync(socketPath)) {
    throw new Error(`the app never opened ${socketPath}\n${log}`);
  }
  return { app, root, socketPath };
}

// --- the round -------------------------------------------------------------

const FIXTURE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Rook native demo</title></head>
  <body>
    <main>
      <h1>Rook native demo</h1>
      <p>This page is open inside the <strong>native GTK3 + CEF window</strong>.</p>
      <p id="status">agent has not clicked yet</p>
      <button id="run" aria-label="Run the demo action">Run the demo action</button>
    </main>
    <script>
      document.getElementById("run").addEventListener("click", () => {
        document.getElementById("status").textContent =
          "clicked by ego-browser through the control socket";
      });
    </script>
  </body>
</html>`;

async function startFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const ROUND = (taskName, url) => `
  const task = await taskSpace(${JSON.stringify(taskName)});
  const page = await task.newPage();
  await page.goto(${JSON.stringify(url)}, { timeout: 20000 });
  // The snapshot is the skill's view of the page: an indented accessibility
  // tree with [ref=N] on everything an action can name.
  const text = await page.snapshot({ scope: "full_page" });
  console.log(text);
  const buttonLine = text.split("\\n").find((line) => line.includes("Run the demo action"));
  const buttonRef = buttonLine && buttonLine.match(/\\[ref=([0-9]+)/);
  if (!buttonRef) throw new Error("the fixture snapshot has no demo button ref: " + text);
  await page.click("@" + buttonRef[1]);
  const status = await page.evaluate(() => document.getElementById("status").textContent);
  const info = await page.info();
  console.log("DEMO RESULT " + JSON.stringify({
    spaceId: task.spaceId,
    spaceName: task.name,
    url: info.url,
    title: info.title,
    ref: buttonRef[1],
    status,
  }));
`;

// --- window capture --------------------------------------------------------

async function xdo(argv, timeoutMs = 10000) {
  const result = await run("xdotool", argv, {
    env: { DISPLAY },
    timeoutMs,
  });
  return { ...result, out: result.stdout.trim() };
}

async function appWindow() {
  const search = await xdo(["search", "--class", "rook"]);
  if (search.code !== 0) return null;
  let best = null;
  for (const id of search.out.split("\n").filter(Boolean)) {
    const geometry = await xdo(["getwindowgeometry", "--shell", id]);
    const width = Number(/WIDTH=(\d+)/.exec(geometry.out)?.[1] ?? 0);
    const height = Number(/HEIGHT=(\d+)/.exec(geometry.out)?.[1] ?? 0);
    const x = Number(/X=(-?\d+)/.exec(geometry.out)?.[1] ?? 0);
    const y = Number(/Y=(-?\d+)/.exec(geometry.out)?.[1] ?? 0);
    if (!best || width * height > best.width * best.height) best = { id, x, y, width, height };
  }
  return best;
}

/** Click the space's sidebar row, verified against the app's own active space. */
async function revealSpace(client, spaceId, index) {
  const first = 118;
  const pitch = 49;
  const candidates = [];
  const expected = first + pitch * index;
  for (let offset = 0; offset <= 60; offset += 6) {
    candidates.push(expected + offset, expected - offset);
  }
  for (let y = 70; y <= 420; y += 8) candidates.push(y);
  const seen = new Set();
  const debug = process.env.ROOK_DEMO_DEBUG === "1";
  for (const y of candidates) {
    if (y < 40 || seen.has(y)) continue;
    seen.add(y);
    // Move away first: GTK only sees a click on a row that received a motion
    // event, and `mousemove --sync` hangs when the pointer is already there.
    const click = await xdo([
      "mousemove",
      "4",
      "4",
      "sleep",
      "0.02",
      "mousemove",
      "112",
      String(y),
      "sleep",
      "0.02",
      "click",
      "1",
    ], 5000);
    if (click.code !== 0) {
      if (debug) say(`  xdotool failed at y=${y}: ${click.stderr.trim() || `exit ${click.code}`}`);
      return false;
    }
    await sleep(150);
    const listed = await client.request("listSpaces", {}, { timeoutMs: 5000 }).catch(() => null);
    if (debug) say(`  click (112,${y}) -> active ${listed?.activeSpaceId} want ${spaceId}`);
    if (listed?.activeSpaceId === spaceId) return true;
  }
  return false;
}

/**
 * Capture the app window as PNG.
 *
 * The page is a CEF **child** window pinned to the X root visual, so XGetImage
 * on the GTK toplevel returns that window's own (flat) background and nothing
 * else: the screenshot has to be taken from the screen and cropped to the
 * window's geometry, which is exactly what a user would see.
 */
async function capture(app, path) {
  const shot = await run("import", ["-window", "root", path], { env: { DISPLAY }, timeoutMs: 30000 });
  if (shot.code === 0 && existsSync(path)) {
    const crop = `${app.width}x${app.height}+${app.x}+${app.y}`;
    const cropped = await run("convert", [path, "-crop", crop, "+repage", path], { timeoutMs: 30000 });
    if (cropped.code === 0) return `root cropped to ${crop}`;
    return "root";
  }
  const scrot = await run(
    "scrot",
    ["-a", `${app.x},${app.y},${app.width},${app.height}`, "-o", path],
    { env: { DISPLAY }, timeoutMs: 30000 },
  );
  if (scrot.code === 0 && existsSync(path)) return "scrot";
  throw new Error("no screenshot tool worked (tried import and scrot)");
}

async function pngSummary(path) {
  const identify = await run("identify", ["-format", "%w %h %k %[fx:standard_deviation]", path], {
    timeoutMs: 20000,
  });
  if (identify.code !== 0 || !identify.stdout.trim()) return null;
  const [width, height, colours, sd] = identify.stdout.trim().split(/\s+/);
  return {
    width: Number(width),
    height: Number(height),
    colours: Number(colours),
    sd: Number(sd),
  };
}

// --- main ------------------------------------------------------------------

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  if (!existsSync(CLI)) throw new Error(`no CLI at ${CLI}`);
  if (!existsSync(SDK_PATH)) {
    throw new Error(
      `no SDK build at ${SDK_PATH}. Build the ego-browser checkout (npm ci && npm run build) or set EGO_BROWSER_SDK_PATH.`,
    );
  }

  await ensureDisplay();
  say(`display    ${DISPLAY}`);

  let started = null;
  let socketPath = await liveSocket();
  if (socketPath) {
    say(`app        already running on ${socketPath}`);
  } else {
    started = await startApp();
    socketPath = started.socketPath;
    say(`app        started, socket ${socketPath}`);
  }

  const stateDir = await mkdtemp(join(tmpdir(), "rook-demo-state-"));
  const { server, base } = await startFixture();
  const url = `${base}/demo?run=${Date.now()}`;
  const taskName = `native demo ${new Date().toISOString().slice(11, 19)}`;
  say(`fixture    ${url}`);

  const roundEnv = {
    DISPLAY,
    ROOK_BACKEND: "host",
    ROOK_HOST_SOCKET: socketPath,
    EGO_BROWSER_STATE_DIR: stateDir,
  };

  say("\n== ego-browser nodejs (host backend) ==");
  const round = await run(CLI, ["nodejs", "--sdk-path", SDK_PATH], {
    env: roundEnv,
    input: ROUND(taskName, url),
    timeoutMs: 180000,
  });
  const output = `${round.stdout}${round.stderr}`;
  process.stdout.write(output.endsWith("\n") || output === "" ? output : `${output}\n`);
  if (round.code !== 0) {
    throw new Error(`the round exited with code ${round.code}`);
  }
  const resultLine = output
    .split("\n")
    .find((line) => line.startsWith("DEMO RESULT "));
  if (!resultLine) throw new Error("the round did not report a DEMO RESULT line");
  const result = JSON.parse(resultLine.slice("DEMO RESULT ".length));
  say(`\nspace      ${result.spaceName} (${result.spaceId})`);
  say(`page       ${result.title} — ${result.url}`);
  say(`click      ${result.status}`);

  // The app keeps the space after the round exits; drive it directly now. The
  // round only knows the SDK's numeric id, so the space is found by its name.
  const client = new HostControlClient({ socketPath });
  let captured = null;
  let summary = null;
  try {
    await client.connect(4000);
    const listed = await client.request("listSpaces");
    const index = (listed.spaces ?? []).findIndex((space) => space.name === result.spaceName);
    const space = listed.spaces?.[index];
    if (!space) throw new Error(`the app no longer lists a space named ${result.spaceName}`);
    result.hostSpaceId = space.spaceId;
    await client
      .request("setAgentTaskState", {
        spaceId: space.spaceId,
        state: "clicked by ego-browser",
      })
      .catch(() => {});
    if (space.tabCount < 1) throw new Error("the app reports no tab in the demo space");

    const window = await appWindow();
    if (!window) throw new Error("could not find the app window on the display");
    // `activateSpace` is the supported way to reveal a space (view only: it
    // never touches a tab), so the window is asked to show it. The sidebar click
    // stays as the fallback for an app too old to have the op.
    let revealed = await client
      .request("activateSpace", { spaceId: space.spaceId }, { timeoutMs: 5000 })
      .then(async () => {
        const after = await client.request("listSpaces").catch(() => null);
        return after?.activeSpaceId === space.spaceId;
      })
      .catch(() => false);
    let how = "activateSpace";
    if (!revealed) {
      revealed = await revealSpace(client, space.spaceId, Math.max(0, index));
      how = "sidebar click";
    }
    say(`window     ${window.width}x${window.height}, space ${revealed ? `shown (${how})` : "not shown"}`);
    // A space that was just revealed has to paint: the tab was parked
    // (`WasHidden`) until the switch, so the first capture can be one flat
    // colour. Grab until the window has actual content.
    await sleep(400);
    captured = await capture(window, PNG_PATH);
    summary = await pngSummary(PNG_PATH);
    for (let attempt = 0; attempt < 12 && summary && summary.colours < 50; attempt += 1) {
      await sleep(250);
      captured = await capture(window, PNG_PATH);
      summary = await pngSummary(PNG_PATH);
    }
  } finally {
    client.close();
  }

  say(`screenshot ${PNG_PATH} (${captured})`);
  if (summary) {
    say(`           ${summary.width}x${summary.height}, ${summary.colours} colours, sd ${summary.sd.toFixed(3)}`);
    if (summary.width < 800 || summary.height < 500 || summary.colours < 50 || summary.sd < 0.02) {
      throw new Error("the captured window looks blank");
    }
  }

  server.close();
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});

  if (started && !keepApp) {
    const quit = new HostControlClient({ socketPath });
    await quit.connect(2000).catch(() => null);
    await quit.request("quit", {}, { timeoutMs: 5000 }).catch(() => {});
    quit.close();
    await sleep(1500);
    await rm(started.root, { recursive: true, force: true }).catch(() => {});
  } else if (started) {
    say(`app kept running; its data root is ${started.root}`);
  }

  say("\nDEMO OK — the native app is showing a page the ego-browser skill opened and clicked.");
}

main().then(
  () => {
    killChildren();
    process.exitCode = 0;
  },
  async (error) => {
    process.stderr.write(`demo failed: ${error?.stack || error}\n`);
    killChildren();
    process.exitCode = 1;
  },
);
