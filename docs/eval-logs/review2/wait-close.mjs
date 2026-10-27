#!/usr/bin/env node
/**
 * Reproduction for the second review's task 10 defect: "closing a tab while a
 * wait is pending makes the wait run its full timeout".
 *
 *   node docs/eval-logs/review2/wait-close.mjs            # private Xvfb :134
 *   node docs/eval-logs/review2/wait-close.mjs --display :99
 *
 * It starts the real app (host/build/bin/rook) against a private socket and a
 * local fixture page, then runs four cases through the real `ego-browser nodejs`
 * CLI.  In every case the round starts `page.waitForSelector("#never")` — an
 * element that never appears — and prints a line when the wait is in flight.
 * The script then interrupts the wait *from outside that CLI process* (a tab
 * close, a space close, the app dying) or uses a short timeout as a control:
 *
 *   control      the wait runs its own 1200 ms timeout, nothing is interrupted
 *   tab-close    the tab the wait is polling is closed through the app
 *   space-close  the whole task space is closed through the app
 *   app-kill     the app process is SIGKILLed
 *
 * Each case prints `RESULT {json}` with the wall time to the error and the
 * message the agent sees, and the script prints a `CASE ...` summary line. A
 * fast, clear failure is the point: an interrupted wait must not run out its
 * 15 s clock.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HostControlClient } from "../../../runtime/backends/host.js";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(HERE, "bin", "ego-browser");
const HOST_BIN = process.env.ROOK_HOST_BIN || join(HERE, "host", "build", "bin", "rook");
const SDK_PATH =
  process.env.EGO_BROWSER_SDK_PATH ||
  join(HERE, "vendor", "ego-browser", "dist", "out", "index.js");

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const DISPLAY = argValue("--display", process.env.ROOK_DISPLAY || process.env.DISPLAY || ":134");
/** `--only tab-close` runs one case; the rest are skipped. */
const ONLY = argValue("--only", null);
const wanted = (name) => !ONLY || ONLY === name;
const ROUND_TIMEOUT_MS = 90000;
const LONG_WAIT_MS = 15000;
const children = [];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function track(child) {
  children.push(child);
  return child;
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

/** Run a command, streaming stdout lines to `onLine` as they arrive. */
function runStreaming(command, argv, { env, onLine, timeoutMs = ROUND_TIMEOUT_MS }) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const child = track(
      spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") onLine?.(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}${error?.message || error}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

function run(command, argv, { env = {}, timeoutMs = 10000 } = {}) {
  return runStreaming(command, argv, { env, timeoutMs });
}

// --- display and fixture ----------------------------------------------------

async function displayAlive() {
  const probe = await run("/usr/bin/env", ["xdpyinfo", "-display", DISPLAY], { timeoutMs: 10000 });
  return probe.code === 0;
}

async function ensureDisplay() {
  if (await displayAlive()) return;
  for (const candidate of [
    process.env.ROOK_XVFB_BIN,
    "/tmp/opencode/xvfb-root/usr/bin/Xvfb",
    "Xvfb",
  ]) {
    if (!candidate) continue;
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const xvfb = track(
      spawn(candidate, [DISPLAY, "-screen", "0", "1280x820x24", "-nolisten", "tcp", "-ac"], {
        stdio: "ignore",
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [process.env.ROOK_XVFB_LIB, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        },
      }),
    );
    xvfb.on("error", () => {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await sleep(100);
      if (await displayAlive()) return;
    }
    xvfb.kill("SIGKILL");
  }
  throw new Error(`no X display at ${DISPLAY}`);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>wait-close</title>
<h1 id="title">wait-close fixture</h1><p>The element a wait asks for is never added.</p>
<script>window.__loaded = true;</script>`;

/**
 * The same page, but it blocks its own main thread for three seconds just after
 * load. A poll that arrives in that window sits in the renderer unanswered, so
 * closing the tab then is the case the first review measured at 20.4 s: the
 * command is in flight, not between polls.
 */
const BUSY_PAGE = `<!doctype html><meta charset="utf-8"><title>wait-close busy</title>
<h1 id="title">wait-close busy fixture</h1>
<script>
  setTimeout(() => {
    const started = Date.now();
    while (Date.now() - started < 3000) {}
  }, 150);
</script>`;

async function startFixtures() {
  const server = createServer((request, response) => {
    const busy = new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/busy";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(busy ? BUSY_PAGE : PAGE);
  });
  await new Promise((listen) => server.listen(0, "127.0.0.1", listen));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// --- the app ---------------------------------------------------------------

async function startApp({ runtimeDir, dataRoot, socketPath, logPath }) {
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const log = createWriteStream(logPath);
  const app = track(
    spawn(
      HOST_BIN,
      ["--data-root", dataRoot, "--socket-path", socketPath, "--window-size", "1280x820"],
      {
        env: {
          ...process.env,
          DISPLAY,
          XDG_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataRoot,
          HOME: dirname(dataRoot),
          ROOK_CEF_EXTRA_FLAGS: "password-store=basic",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    ),
  );
  app.stderr.pipe(log);
  app.on("error", (error) => {
    process.stderr.write(`app failed to start: ${error?.message || error}\n`);
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const client = new HostControlClient({ socketPath });
      await client.connect(1000);
      const info = await client.request("getInfo", {}, { timeoutMs: 5000 });
      return { app, client, info };
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`the app never answered on ${socketPath}; see ${logPath}`);
}

/**
 * The app space that holds a tab on the fixture page. Newest first: earlier
 * cases leave their own spaces behind, and the one the current round just made
 * is the last one the app knows.
 */
async function fixtureSpace(client, base) {
  const listed = await client.request("listSpaces", {}, { timeoutMs: 5000 });
  for (const space of [...(listed.spaces ?? [])].reverse()) {
    const tabs = await client.request("listTabs", { spaceId: space.spaceId }, { timeoutMs: 5000 });
    if ((tabs.tabs ?? []).some((tab) => String(tab.url).startsWith(base))) {
      return { spaceId: space.spaceId, tabs: tabs.tabs ?? [] };
    }
  }
  return null;
}

/** The round: start a wait that cannot succeed, report, then report the end. */
function roundSource({ base, timeoutMs, name, inProcessClose = false, path = "/" }) {
  return `
const out = { name: ${JSON.stringify(name)} };
const task = await taskSpace(${JSON.stringify(name)});
const tabs = await task.tabs();
const page = task.page(tabs[0].label);
await page.goto(${JSON.stringify(base)} + ${JSON.stringify(path)});
// A second tab, as any real session has: after the page below is closed the
// space still holds one, which is what lets a poll of the closed page be
// silently re-routed to a sibling tab instead of failing.
await task.newPage();
const started = Date.now();
process.stdout.write("WAIT-STARTED " + JSON.stringify({ name: out.name }) + "\\n");
${inProcessClose ? `// The same-process close the first review used: the SDK serialises page
// operations, so this queues behind the wait instead of ending it.
setTimeout(() => { void page.close().then(() => process.stdout.write("CLOSED \\n"), () => {}); }, 300);` : ""}
try {
  await page.waitForSelector("#never", { timeout: ${timeoutMs} });
  out.result = "resolved";
} catch (error) {
  out.result = "error";
  out.message = String(error?.message ?? error).split("\\n")[0];
  out.code = error?.code ?? error?.error_code ?? null;
}
out.ms = Date.now() - started;
process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
`;
}

function resultOf(round) {
  const line = round.stdout
    .split("\n")
    .filter((entry) => entry.startsWith("RESULT "))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line.slice("RESULT ".length));
  } catch {
    return null;
  }
}

// --- one case --------------------------------------------------------------

async function runCase({
  name,
  base,
  env,
  action,
  timeoutMs = LONG_WAIT_MS,
  inProcessClose = false,
  path = "/",
}) {
  const startedAt = Date.now();
  let waitStarted = null;
  let armed = false;
  const round = await runStreaming(
    CLI,
    ["nodejs", "-e", roundSource({ base, timeoutMs, name, inProcessClose, path })],
    {
    env,
    onLine: (line) => {
      if (line.startsWith("WAIT-STARTED ") && !armed) {
        armed = true;
        waitStarted = Date.now();
        // Let the first poll land before interrupting, so the wait is really
        // in flight rather than failing before it began.
        void (async () => {
          await sleep(400);
          try {
            await action?.();
          } catch (error) {
            process.stderr.write(`case ${name}: the interrupt failed: ${error?.message || error}\n`);
          }
        })();
      }
    },
    timeoutMs: ROUND_TIMEOUT_MS,
  });
  const result = resultOf(round);
  const t = result?.ms ?? null;
  if (process.argv.includes("--verbose")) {
    process.stdout.write(`--- ${name} stderr ---\n${round.stderr}\n--- end ${name} ---\n`);
  }
  process.stdout.write(
    `CASE ${name} ${JSON.stringify({
      waitStartedAt: waitStarted ? `${waitStarted - startedAt}ms` : null,
      to_error_ms: t,
      result: result?.result ?? "no result",
      code: result?.code ?? null,
      message: result?.message ?? round.stderr.trim().split("\n").pop() ?? "",
    })}\n`,
  );
  return result;
}

// --- main ------------------------------------------------------------------

async function main() {
  for (const [what, path] of [
    ["the app binary", HOST_BIN],
    ["the CLI", CLI],
    ["the SDK build", SDK_PATH],
  ]) {
    if (!existsSync(path)) throw new Error(`${what} is missing: ${path}`);
  }

  await ensureDisplay();
  const root = await mkdtemp(join(tmpdir(), "rook-wait-close-"));
  const runtimeDir = join(root, "run");
  const dataRoot = join(root, "data");
  const stateDir = join(root, "state");
  const socketPath = join(runtimeDir, `rook-${process.getuid?.() ?? 0}.sock`);
  const appLog = join(root, "app.log");
  const fixtures = await startFixtures();

  let app = null;
  try {
    app = await startApp({ runtimeDir, dataRoot, socketPath, logPath: appLog });
    process.stdout.write(`APP version=${app.info?.version} protocol=${app.info?.protocol}\n`);

    const env = {
      PATH: process.env.PATH,
      DISPLAY,
      ROOK_BACKEND: "host",
      ROOK_HOST_SOCKET: socketPath,
      ROOK_DEBUG: process.env.ROOK_DEBUG ?? "0",
      EGO_BROWSER_STATE_DIR: stateDir,
      EGO_BROWSER_SDK_PATH: SDK_PATH,
    };

    // 1. Control: nothing interrupts the wait, so its own clock must decide.
    if (wanted("control")) await runCase({
      name: "control",
      base: fixtures.base,
      env,
      timeoutMs: 1200,
    });

    // 2. Tab closed while the wait is polling it.
    if (wanted("tab-close")) await runCase({
      name: "tab-close",
      base: fixtures.base,
      env,
      action: async () => {
        const found = await fixtureSpace(app.client, fixtures.base);
        if (!found) throw new Error("no fixture tab to close");
        const tab = found.tabs.find((entry) => String(entry.url).startsWith(fixtures.base));
        await app.client.request(
          "closeTab",
          { spaceId: found.spaceId, tabId: tab.tabId },
          { timeoutMs: 5000 },
        );
        process.stdout.write(`CASE-EVENT tab-close closed ${found.spaceId}/${tab.tabId}\n`);
      },
    });

    // 3. The whole space closed while the wait is polling.
    if (wanted("space-close")) await runCase({
      name: "space-close",
      base: fixtures.base,
      env,
      action: async () => {
        const found = await fixtureSpace(app.client, fixtures.base);
        if (!found) throw new Error("no fixture space to close");
        await app.client.request("closeSpace", { spaceId: found.spaceId }, { timeoutMs: 5000 });
        process.stdout.write(`CASE-EVENT space-close closed ${found.spaceId}\n`);
      },
    });

    // 4. The tab is closed while a poll is really in flight: the page blocks its
    //    own thread, so the Runtime.evaluate the wait sent cannot be answered.
    //    This is the first review's measured case (20.4 s to error).
    if (wanted("tab-close-busy")) {
      await runCase({
        name: "tab-close-busy",
        base: fixtures.base,
        env,
        path: "/busy",
        timeoutMs: 30000,
        action: async () => {
          const found = await fixtureSpace(app.client, fixtures.base);
          if (!found) throw new Error("no busy tab to close");
          const tab = found.tabs.find((entry) =>
            String(entry.url).startsWith(`${fixtures.base}/busy`),
          );
          if (!tab) throw new Error("the busy tab is not in any space yet");
          await app.client.request(
            "closeTab",
            { spaceId: found.spaceId, tabId: tab.tabId },
            { timeoutMs: 5000 },
          );
          process.stdout.write(`CASE-EVENT tab-close-busy closed ${found.spaceId}/${tab.tabId}\n`);
        },
      });
    }

    // 5. The same-process close the first review used. The SDK serialises page
    //    operations, so this close is queued behind the wait and cannot end it:
    //    the wait runs out its own 3 s clock first. Recorded so the report can
    //    say plainly which part of the review's 15 s this fix does not touch.
    if (wanted("close-in-process")) {
      await runCase({
        name: "close-in-process",
        base: fixtures.base,
        env,
        timeoutMs: 3000,
        inProcessClose: true,
      });
    }

    // 6. The app dies mid-wait (socket EOF). Runs last: the app is gone after.
    if (wanted("app-kill")) await runCase({
      name: "app-kill",
      base: fixtures.base,
      env,
      action: async () => {
        process.kill(app.app.pid, "SIGKILL");
        process.stdout.write(`CASE-EVENT app-kill killed pid ${app.app.pid}\n`);
      },
    });

    process.stdout.write(`DONE appLog=${appLog}\n`);
  } finally {
    if (app?.app?.exitCode === null && app?.app?.signalCode === null) {
      try {
        await app.client.request("quit", {}, { timeoutMs: 3000 });
      } catch {
        // already gone
      }
      try {
        app.client.close();
      } catch {
        // already gone
      }
      try {
        process.kill(app.app.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fixtures.server.close();
    killChildren();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`FAILED: ${error?.stack || error}\n`);
    killChildren();
    process.exit(1);
  });
