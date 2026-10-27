#!/usr/bin/env node
/**
 * The performance harness behind bench/report.md.
 *
 *   bench/run.sh                 # unpack the .deb, measure everything, write results.json
 *   bench/run.sh --report        # ... and regenerate report.md / report.html
 *   ROOK_BENCH_QUICK=1 bench/run.sh
 *
 * Six measurements, on the unpacked .deb, on a private X display, with plain
 * `google-chrome --headless=new` measured the same way for context:
 *
 *   1. cold start      exec -> first painted frame, from the framebuffer
 *   2. idle RSS        1 tab, 60 s quiet, whole process tree
 *   3. space margin    1 space vs 4, parked and awake, delta per space
 *   4. snapshot        p50/p95 over 30 snapshots x 3 page classes, real CLI
 *   5. CPU idle        60 s sample of utime+stime over the tree
 *   6. install size    what dpkg will put on disk
 *
 * Nothing here is tuned to hit the budget: the numbers are whatever the box
 * produces, and every method is recorded in results.json next to the number so
 * a reader can disagree with the measurement rather than with the summary.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem, loadavg } from "node:os";

import { launchApp, msSince } from "./lib/app.mjs";
import { Control } from "./lib/control.mjs";
import { sample, byRole } from "./lib/procs.mjs";
import { startXvfb, startPoller } from "./lib/x11.mjs";
import { percentile, summary } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const ROOT = join(HERE, "work", "root");
const APP = join(ROOT, "usr", "bin", "rook");
const CLI = join(ROOT, "usr", "bin", "ego-browser");
const WORK = join(HERE, "work");
const RESULTS = join(HERE, "results.json");
const FIXTURES = join(HERE, "fixtures");

const QUICK = process.env.ROOK_BENCH_QUICK === "1";
// Debugging aid: run one section only, e.g. ROOK_BENCH_ONLY=cold. A full pass is
// what run.sh does; a partial pass still writes results.json but leaves the
// sections it skipped out, so it can never be mistaken for a full run.
const ONLY = new Set(
  (process.env.ROOK_BENCH_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const wants = (name) => ONLY.size === 0 || ONLY.has(name);
const CFG = {
  runs: QUICK ? 2 : Number(process.env.ROOK_BENCH_RUNS ?? 3),
  idleSeconds: QUICK ? 20 : Number(process.env.ROOK_BENCH_IDLE_S ?? 60),
  wakeSeconds: QUICK ? 12 : Number(process.env.ROOK_BENCH_WAKE_S ?? 20),
  chromeIdleSeconds: QUICK ? 12 : Number(process.env.ROOK_BENCH_CHROME_IDLE_S ?? 15),
  snapshots: QUICK ? 10 : Number(process.env.ROOK_BENCH_SNAPSHOTS ?? 30),
  snapshotRuns: QUICK ? 1 : 3,
  pollTimeout: 25,
};

// Every app launch gets the standard headless Chromium setting below. Without
// it CEF asks libsecret for a key store on this box, no unlocked keyring exists,
// and a gnome-keyring GTK prompt covers the window — a modal dialog from the
// test machine's missing keyring, not from the app, and nothing on screen could
// be measured through it. Details in bench/README.md.
const APP_ENV = {
  ROOK_CEF_EXTRA_FLAGS: process.env.ROOK_CEF_EXTRA_FLAGS ?? "password-store=basic",
  // GTK's GIO layer otherwise activates a private gvfs daemon per run, which
  // mounts a FUSE filesystem inside the run's XDG_RUNTIME_DIR and outlives the
  // app. A desktop has one gvfs for the session; a bench run should not leak one.
  GIO_USE_VFS: "local",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt0 = (value) => (Number.isFinite(value) ? value.toFixed(0) : "—");
const log = (line) => process.stdout.write(`${line}\n`);
const now = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;

/**
 * The packaged app sometimes aborts on its own ("*** stack smashing detected ***")
 * a few seconds after a page loads — see bench/README.md. A run whose app died is
 * not a slow run, it is no run at all, so it is discarded and retried, and every
 * discard is recorded in results.json rather than hidden.
 */
const DISCARDED = [];

async function withRetry(label, attempts, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const first = String(error.message ?? error).split("\n")[0];
      DISCARDED.push({ label, attempt, error: first });
      log(`  ! ${label}: ${first} — attempt ${attempt}/${attempts}`);
      await sleep(1500);
    }
  }
  throw lastError;
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Fixture server: 127.0.0.1 only, no external network, no cache so a second run
// pays the same price as the first.
// ---------------------------------------------------------------------------
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

async function startFixtureServer() {
  const hits = new Map();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const file = join(FIXTURES, basename(path));
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-length": body.length,
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Remove a run directory, including anything the app's GTK helpers left behind.
 * gvfsd-fuse keeps a FUSE mount inside the run's runtime dir; killing the helper
 * drops the mount, and only then can the directory go.
 */
async function removeRunDir(dir) {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmd.includes(dir) && !cmd.includes("bench.mjs")) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** Per-run data dir + runtime dir, so no profile is ever warm by accident. */
async function newRunDirs(name) {
  const dir = join(WORK, "runs", name);
  await removeRunDir(dir);
  const dataHome = join(dir, "data");
  const runtimeDir = join(dir, "run");
  await mkdir(dataHome, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  return { dir, dataHome, runtimeDir, socketPath: join(runtimeDir, "rook.sock") };
}

// ---------------------------------------------------------------------------
// 1. Cold start
// ---------------------------------------------------------------------------
/**
 * One cold start: fresh X display, fresh profile, poll the framebuffer from
 * before the fork until the fixture's marker colour is on screen.
 *
 * Reported three ways in the same run, because they answer different questions:
 *   paint — first frame containing the page's own colour (the metric)
 *   window — first non-black pixel (GTK window is up, page still blank)
 *   loaded — the app's own "tab ... loaded (http 200)" log line
 */
async function coldStartRun({ url, dataHome, runtimeDir, label }) {
  const xvfb = await startXvfb();
  const poller = startPoller(xvfb.display, { timeout: CFG.pollTimeout });
  let app = null;
  try {
    await waitFor("poller ready", () => poller.events.ready !== null, 8000);
    app = launchApp({
      appBin: APP,
      display: xvfb.display,
      dataHome,
      runtimeDir,
      spaces: [`You=${url}`],
      extraEnv: APP_ENV,
    });
    const loaded = await app.waitForLine(/loaded \(http 200\)/, 30000);
    // The compositor can land the first frame a moment after load-end.
    await waitFor("first paint", () => poller.events.marker !== null, 5000).catch(() => {});
    const events = poller.events;
    const skew = ms(BigInt(events.ready), app.startedAt);
    if (!(skew > -50 && skew < 10000)) {
      throw new Error(`poller and app disagree about the clock (skew ${skew.toFixed(0)} ms)`);
    }
    if (events.marker === null) {
      throw new Error(`no painted frame within ${CFG.pollTimeout} s (${events.samples ?? 0} polls)`);
    }
    return {
      label,
      paintMs: ms(app.startedAt, BigInt(events.marker)),
      windowMs: events.first === null ? null : ms(app.startedAt, BigInt(events.first)),
      loadedMs: msSince(app.startedAt, loaded.t),
      pollSamples: events.samples,
      pollerTimedOut: events.marker === null,
      display: xvfb.display,
    };
  } finally {
    poller.stop();
    if (app) await app.kill();
    await xvfb.stop();
  }
}

async function measureColdStart(server) {
  const url = `${server.base}/coldstart.html`;
  const cold = [];
  const warm = [];
  // Cold profile: a profile directory that has never existed. This is what a
  // first launch after install feels like, and it is where CEF creates its
  // LevelDBs.
  for (let run = 0; run < CFG.runs; run += 1) {
    const dirs = await newRunDirs(`cold-${run}`);
    cold.push(
      await withRetry(`cold start, cold profile #${run + 1}`, 3, () =>
        coldStartRun({ url, ...dirs, label: `cold profile #${run + 1}` }),
      ),
    );
    log(`  cold start, cold profile ${run + 1}/${CFG.runs}: ${cold.at(-1).paintMs?.toFixed(0)} ms to first paint`);
  }
  // Warm profile: the same directory every time, which is a normal launch. The
  // first pass through it only creates the profile, so it is a warm-up and is
  // not one of the three measured runs.
  const shared = await newRunDirs("cold-warm");
  const warmup = await withRetry("cold start, warm-up", 3, () =>
    coldStartRun({ url, ...shared, label: "warm profile warm-up" }),
  );
  log(`  cold start, warm profile warm-up (discarded): ${warmup.paintMs?.toFixed(0)} ms`);
  for (let run = 0; run < CFG.runs; run += 1) {
    warm.push(
      await withRetry(`cold start, warm profile #${run + 1}`, 3, () =>
        coldStartRun({ url, ...shared, label: `warm profile #${run + 1}` }),
      ),
    );
    log(`  cold start, warm profile ${run + 1}/${CFG.runs}: ${warm.at(-1).paintMs?.toFixed(0)} ms to first paint`);
  }
  return { cold, warm, url };
}

// ---------------------------------------------------------------------------
// 2./3./5. Idle: RSS, CPU, and the marginal cost of a space
// ---------------------------------------------------------------------------
/**
 * Launch with `spaces`, wait until every tab reported a load, let it settle,
 * then watch the tree for `seconds`: RSS every 10 s, CPU as the difference of
 * utime+stime across the whole window.
 */
async function idleRun({ label, pageUrl, spaceCount, seconds, awake = false }) {
  const dirs = await newRunDirs(label.replace(/[^a-z0-9]+/gi, "-"));
  const names = ["You", "Agent 1", "Agent 2", "Agent 3", "Agent 4", "Agent 5"];
  const spaces = names.slice(0, spaceCount).map((name) => `${name}=${pageUrl}`);
  const xvfb = await startXvfb();
  let app = null;
  let control = null;
  const pokeTimers = [];
  try {
    app = launchApp({
      appBin: APP,
      display: xvfb.display,
      dataHome: dirs.dataHome,
      runtimeDir: dirs.runtimeDir,
      socketPath: awake ? dirs.socketPath : null,
      spaces,
      extraEnv: APP_ENV,
    });
    await waitFor(
      `${spaceCount} tab(s) loaded`,
      () => app.lines.filter((line) => /loaded \(http 200\)/.test(line.text)).length >= spaceCount,
      60000,
      50,
    );
    // Let the load spike drain before the measurement window opens: the first
    // frames, the initial GC and the profile writes all belong to startup.
    await sleep(5000);

    if (awake) {
      control = await Control.connect(dirs.socketPath);
      // The host returns these as JSON *strings* inside the JSON-RPC result, but
      // a future host may hand back an object; accept either.
      const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);
      const tabIds = [];
      const spacesReply = json(await control.request("listSpaces"));
      for (const space of spacesReply.spaces) {
        const tabs = json(await control.request("listTabs", { spaceId: space.spaceId }));
        for (const tab of tabs.tabs) tabIds.push(tab.tabId);
      }
      if (tabIds.length !== spaceCount) {
        throw new Error(`expected ${spaceCount} tabs to wake, the host listed ${tabIds.length}`);
      }
      // CdpSweepTick re-parks a tab 10 s after its last CDP message, so poking
      // every 6 s holds every space at WasHidden(false) for the whole window.
      const poke = async () => {
        for (const tabId of tabIds) {
          await control
            .request("cdp.send", { browserId: tabId, message: JSON.stringify({ id: 1, method: "Page.enable" }) })
            .catch(() => {});
        }
      };
      await poke();
      pokeTimers.push(setInterval(() => void poke(), 6000));
    }

    const before = { t: now(), sample: sample(app.pid, dirs.dataHome) };
    const trace = [];
    const slices = Math.max(1, Math.round(seconds / 10));
    for (let i = 0; i < slices; i += 1) {
      await sleep((seconds * 1000) / slices);
      trace.push({ atMs: Math.round(ms(before.t, now())), rssKb: sample(app.pid, dirs.dataHome).rssKb });
    }
    const after = { t: now(), sample: sample(app.pid, dirs.dataHome) };
    const windowSeconds = ms(before.t, after.t) / 1000;
    const cpuSeconds = Math.max(0, after.sample.cpuSeconds - before.sample.cpuSeconds);
    const parked = app.lines.filter((line) => /parked$/.test(line.text)).length;
    const awakeLines = app.lines.filter((line) => /awake$/.test(line.text)).length;
    const alive = app.child.exitCode === null;
    if (!alive) {
      // Measuring the idle cost of a process that has exited would report 0 MiB.
      throw new Error(`the app exited during the ${Math.round(seconds)} s window (exit ${app.child.exitCode})`);
    }
    if (after.sample.pids === 0) {
      throw new Error("the process tree came back empty");
    }
    return {
      label,
      spaces: spaceCount,
      awake,
      windowSeconds,
      rssKb: after.sample.rssKb,
      pssKb: after.sample.pssKb,
      pids: after.sample.pids,
      cpuSeconds,
      cpuPercent: (cpuSeconds / windowSeconds) * 100,
      userSeconds: after.sample.userSeconds - before.sample.userSeconds,
      systemSeconds: after.sample.systemSeconds - before.sample.systemSeconds,
      trace,
      parkedTransitions: parked,
      awakeTransitions: awakeLines,
      roles: byRole(after.sample),
      detail: after.sample.detail,
    };
  } finally {
    for (const timer of pokeTimers) clearInterval(timer);
    if (control) await control.close();
    if (app) await app.kill();
    await xvfb.stop();
  }
}

async function measureIdle(server) {
  const url = `${server.base}/small-form.html`;
  const oneTab = [];
  const fourParked = [];
  const fourAwake = [];
  log(`  idle, 1 tab (${CFG.idleSeconds} s window, ${CFG.runs} runs)`);
  for (let run = 0; run < CFG.runs; run += 1) {
    oneTab.push(
      await withRetry(`idle, 1 tab #${run + 1}`, 3, () =>
        idleRun({ label: `idle-1tab-${run}`, pageUrl: url, spaceCount: 1, seconds: CFG.idleSeconds }),
      ),
    );
    log(`  idle, 1 tab ${run + 1}/${CFG.runs}: ${(oneTab.at(-1).rssKb / 1024).toFixed(1)} MiB, ${oneTab.at(-1).cpuPercent.toFixed(2)}% CPU`);
  }
  log(`  idle, 4 spaces parked (${CFG.idleSeconds} s window, ${CFG.runs} runs)`);
  for (let run = 0; run < CFG.runs; run += 1) {
    fourParked.push(
      await withRetry(`idle, 4 spaces parked #${run + 1}`, 3, () =>
        idleRun({ label: `idle-4parked-${run}`, pageUrl: url, spaceCount: 4, seconds: CFG.idleSeconds }),
      ),
    );
    log(`  idle, 4 spaces ${run + 1}/${CFG.runs}: ${(fourParked.at(-1).rssKb / 1024).toFixed(1)} MiB`);
  }
  log(`  idle, 4 spaces awake (${CFG.wakeSeconds} s window, ${CFG.runs} runs)`);
  for (let run = 0; run < CFG.runs; run += 1) {
    fourAwake.push(
      await withRetry(`idle, 4 spaces awake #${run + 1}`, 3, () =>
        idleRun({ label: `idle-4awake-${run}`, pageUrl: url, spaceCount: 4, seconds: CFG.wakeSeconds, awake: true }),
      ),
    );
    log(`  awake, 4 spaces ${run + 1}/${CFG.runs}: ${(fourAwake.at(-1).rssKb / 1024).toFixed(1)} MiB`);
  }
  return { oneTab, fourParked, fourAwake, url };
}

// ---------------------------------------------------------------------------
// 4. Snapshot latency, through the real CLI
// ---------------------------------------------------------------------------
const SNAPSHOT_SCRIPT = `
const url = process.env.ROOK_BENCH_URL;
const iterations = Number(process.env.ROOK_BENCH_ITERATIONS || 30);
const fullIterations = Number(process.env.ROOK_BENCH_FULL || 0);

const task = await taskSpace("bench-snapshot");
const page = task.page("p1");
await page.goto(url);
await page.waitForTimeout(400);

const nodes = await page.evaluate("document.querySelectorAll('*').length");

async function timeSnapshots(options, count, warmups) {
  for (let i = 0; i < warmups; i += 1) await page.snapshot(options);
  const times = [];
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    const text = await page.snapshot(options);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (i === 0) globalThis.__first = text;
  }
  return times;
}

const viewport = await timeSnapshots({}, iterations, 3);
const full = fullIterations > 0 ? await timeSnapshots({ scope: "full_page" }, fullIterations, 1) : [];
const first = globalThis.__first || "";
console.log("BENCH " + JSON.stringify({
  nodes,
  viewportLines: first.split("\\n").filter(Boolean).length,
  viewport,
  full,
}));
await task.finish({ keep: [] });
`;

/**
 * Run the CLI once, with the script on stdin. Returns the parsed BENCH line.
 * `ROOK_BACKEND=host` is the point: this is the bridge -> control socket ->
 * CEF path an agent actually uses, not a CDP shortcut the bench invented.
 */
function runCli({ env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, ["nodejs"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = out.split("\n").find((candidate) => candidate.startsWith("BENCH "));
      if (code !== 0 || !line) {
        reject(new Error(`CLI exited ${code}: ${(err || out).slice(-1200)}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice("BENCH ".length)));
      } catch (error) {
        reject(new Error(`unparseable BENCH line: ${line.slice(0, 500)} (${error.message})`));
      }
    });
    child.stdin.end(SNAPSHOT_SCRIPT);
  });
}

const PAGE_CLASSES = [
  { id: "small-form", file: "small-form.html", label: "small form", fullIterations: CFG.snapshots },
  { id: "long-list", file: "long-list.html", label: "long list", fullIterations: CFG.snapshots },
  { id: "heavy-dashboard", file: "heavy-dashboard.html", label: "heavy dashboard", fullIterations: CFG.snapshots },
];

async function measureSnapshots(server) {
  const dirs = await newRunDirs("snapshots");
  const xvfb = await startXvfb();
  let app = null;
  try {
    const startApp = async () => {
      app = launchApp({
        appBin: APP,
        display: xvfb.display,
        dataHome: dirs.dataHome,
        runtimeDir: dirs.runtimeDir,
        socketPath: dirs.socketPath,
        spaces: [],
        extraEnv: APP_ENV,
      });
      await waitFor("shell up", () => app.lines.some((line) => /shell up/.test(line.text)), 30000);
      await waitFor(
        "control socket",
        async () => {
          try {
            await stat(dirs.socketPath);
            return true;
          } catch {
            return false;
          }
        },
        15000,
      );
    };
    // Agent rounds keep the app up for seconds at a time, so an abort between
    // runs has to be survivable here too: restart and carry on.
    const ensureApp = async () => {
      if (app && app.child.exitCode === null) return;
      log("  the app is gone; restarting it before the next snapshot run");
      if (app) await app.kill();
      await rm(dirs.socketPath, { force: true });
      await startApp();
    };

    await startApp();

    const env = {
      DISPLAY: xvfb.display,
      XDG_RUNTIME_DIR: dirs.runtimeDir,
      XDG_DATA_HOME: dirs.dataHome,
      ROOK_HOST_SOCKET: dirs.socketPath,
      ROOK_BACKEND: "host",
      ROOK_NODE: join(ROOT, "usr", "lib", "rook", "node"),
    };

    const pages = [];
    for (const pageClass of PAGE_CLASSES) {
      const url = `${server.base}/${pageClass.file}`;
      const runs = [];
      for (let run = 0; run < CFG.snapshotRuns; run += 1) {
        const result = await withRetry(`snapshot, ${pageClass.label} #${run + 1}`, 3, async () => {
          await ensureApp();
          return runCli({
            env: {
              ...env,
              ROOK_BENCH_URL: url,
              ROOK_BENCH_ITERATIONS: String(CFG.snapshots),
              ROOK_BENCH_FULL: String(run === 0 ? pageClass.fullIterations : 0),
            },
          });
        });
        runs.push(result);
      }
      const viewport = runs.flatMap((run) => run.viewport);
      const full = runs.flatMap((run) => run.full);
      const perRunP50 = runs.map((run) => percentile(run.viewport, 50));
      const perRunP95 = runs.map((run) => percentile(run.viewport, 95));
      pages.push({
        ...pageClass,
        url,
        nodes: runs[0].nodes,
        snapshotLines: runs[0].viewportLines,
        viewport: summary(viewport),
        viewportP50: percentile(viewport, 50),
        viewportP95: percentile(viewport, 95),
        viewportSamples: viewport.length,
        perRunP50,
        perRunP95,
        full: full.length ? summary(full) : null,
        fullP50: full.length ? percentile(full, 50) : null,
        fullP95: full.length ? percentile(full, 95) : null,
        fullSamples: full.length,
      });
      log(
        `  snapshot ${pageClass.label}: ${runs[0].nodes} nodes, p50 ${percentile(viewport, 50).toFixed(1)} ms, ` +
          `p95 ${percentile(viewport, 95).toFixed(1)} ms (${viewport.length} samples)`,
      );
    }

    // The same measurement one layer down: the bridge against its own headless
    // Chrome, no host socket in between. If these numbers match the host ones,
    // the cost is the snapshot pipeline, not the pipe to the app.
    const standalone = [];
    if (process.env.ROOK_BENCH_STANDALONE !== "0") {
      const stateDir = join(dirs.dir, "standalone-state");
      await mkdir(stateDir, { recursive: true });
      // Its own data/state/runtime dirs: the standalone backend launches its own
      // Chrome, which must not share a profile directory with the running app.
      const standaloneDirs = {
        XDG_DATA_HOME: join(stateDir, "data"),
        XDG_RUNTIME_DIR: join(stateDir, "run"),
        EGO_BROWSER_STATE_DIR: join(stateDir, "state"),
      };
      for (const path of Object.values(standaloneDirs)) await mkdir(path, { recursive: true });
      for (const pageClass of PAGE_CLASSES) {
        try {
          const result = await runCli({
            env: {
              ...env,
              ...standaloneDirs,
              ROOK_HOST_SOCKET: "",
              ROOK_BACKEND: "standalone",
              ROOK_BENCH_URL: `${server.base}/${pageClass.file}`,
              ROOK_BENCH_ITERATIONS: "10",
              ROOK_BENCH_FULL: "0",
            },
          });
          standalone.push({
            id: pageClass.id,
            p50: percentile(result.viewport, 50),
            p95: percentile(result.viewport, 95),
            samples: result.viewport.length,
          });
          log(`  snapshot ${pageClass.label} (standalone Chrome): p50 ${percentile(result.viewport, 50).toFixed(1)} ms`);
        } catch (error) {
          standalone.push({ id: pageClass.id, error: error.message });
          log(`  snapshot ${pageClass.label} (standalone Chrome) failed: ${error.message.split("\n")[0]}`);
        }
      }
    }

    return { pages, backend: "host", standalone, loadavg: loadavg() };
  } finally {
    if (app) await app.kill();
    await xvfb.stop();
  }
}

// ---------------------------------------------------------------------------
// 6. Baseline: stock headless Chrome, measured the same way
// ---------------------------------------------------------------------------
const CHROME = process.env.ROOK_BENCH_CHROME || "/usr/bin/google-chrome";

function chromeVersion() {
  try {
    return execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "google-chrome not found";
  }
}

function chromeColdRun({ url, profileDir, pngPath, warmup }) {
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--screenshot=${pngPath}`,
    "--window-size=1280,820",
    url,
  ];
  const started = now();
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("exit", async (code) => {
      const elapsed = ms(started, now());
      let bytes = 0;
      try {
        bytes = (await stat(pngPath)).size;
      } catch {
        bytes = 0;
      }
      resolve({ ms: elapsed, code, bytes, warmup, stderr: code === 0 ? undefined : err.slice(-600) });
    });
  });
}

async function chromeIdleRun({ url, label, seconds }) {
  const dir = join(WORK, "runs", `chrome-${label}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const profileDir = join(dir, "profile");
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    url,
  ];
  const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  try {
    await waitFor("chrome devtools", () => /DevTools listening/.test(err), 30000);
    await sleep(5000);
    const before = { t: now(), sample: sample(child.pid, null) };
    const trace = [];
    const slices = Math.max(1, Math.round(seconds / 10));
    for (let i = 0; i < slices; i += 1) {
      await sleep((seconds * 1000) / slices);
      trace.push({ atMs: Math.round(ms(before.t, now())), rssKb: sample(child.pid, null).rssKb });
    }
    const after = { t: now(), sample: sample(child.pid, null) };
    const windowSeconds = ms(before.t, after.t) / 1000;
    return {
      label,
      windowSeconds,
      rssKb: after.sample.rssKb,
      pssKb: after.sample.pssKb,
      pids: after.sample.pids,
      cpuPercent:
        (Math.max(0, after.sample.cpuSeconds - before.sample.cpuSeconds) / windowSeconds) * 100,
      trace,
      roles: byRole(after.sample),
    };
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function measureChrome(server) {
  const coldBlank = [];
  const coldPage = [];
  const warmBlank = [];
  const dir = join(WORK, "runs", "chrome-cold");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // Cold = a profile directory that has never existed. Chrome creates tens of
  // MB of profile on first launch (5 s on this box), so it is measured
  // separately from the warm case, exactly as the app is.
  for (let run = 0; run < CFG.runs; run += 1) {
    coldBlank.push(
      await chromeColdRun({ url: "about:blank", profileDir: join(dir, `blank-${run}`), pngPath: join(dir, `blank-${run}.png`) }),
    );
  }
  const warmBlankProfile = join(dir, "blank-warm");
  // Same rule as the app: the first launch into a fresh profile dir only
  // creates the profile (5 s on this box), so it is a discarded warm-up.
  const chromeWarmup = await chromeColdRun({
    url: "about:blank",
    profileDir: warmBlankProfile,
    pngPath: join(dir, "blankw-warmup.png"),
  });
  log(`  chrome warm-up (discarded): ${chromeWarmup.ms.toFixed(0)} ms`);
  for (let run = 0; run < CFG.runs; run += 1) {
    warmBlank.push(
      await chromeColdRun({ url: "about:blank", profileDir: warmBlankProfile, pngPath: join(dir, `blankw-${run}.png`) }),
    );
  }
  for (let run = 0; run < CFG.runs; run += 1) {
    coldPage.push(
      await chromeColdRun({
        url: `${server.base}/small-form.html`,
        profileDir: join(dir, `page-${run}`),
        pngPath: join(dir, `page-${run}.png`),
      }),
    );
  }
  log(
    `  chrome cold start: about:blank ${summary(warmBlank.map((s) => s.ms)).median.toFixed(0)} ms warm, ` +
      `small form ${summary(coldPage.map((s) => s.ms)).median.toFixed(0)} ms cold`,
  );

  const idle = [];
  for (const [label, url] of [
    ["about-blank", "about:blank"],
    ["small-form", `${server.base}/small-form.html`],
  ]) {
    const runs = [];
    for (let run = 0; run < CFG.runs; run += 1) {
      runs.push(await chromeIdleRun({ url, label: `${label}-${run}`, seconds: CFG.chromeIdleSeconds }));
    }
    idle.push({ label, runs });
    log(`  chrome idle ${label}: ${(runs[0].rssKb / 1024).toFixed(0)} MiB, ${runs[0].cpuPercent.toFixed(2)}% CPU`);
  }
  return { coldBlank, coldPage, warmBlank, idle };
}

// ---------------------------------------------------------------------------
// Install size
// ---------------------------------------------------------------------------
async function measurePackage() {
  const out = {};
  const debDir = join(REPO, "packaging", "out");
  let debs = [];
  try {
    const { readdir } = await import("node:fs/promises");
    debs = (await readdir(debDir)).filter((name) => name.endsWith(".deb")).sort();
  } catch {
    debs = [];
  }
  const deb = debs.at(-1);
  if (deb) {
    const path = join(debDir, deb);
    out.deb = path;
    out.debBytes = (await stat(path)).size;
    out.installedKb = Number(
      execFileSync("dpkg-deb", ["-f", path, "Installed-Size"], { encoding: "utf8" }).trim(),
    );
    out.installedBytes = out.installedKb * 1024;
    out.version = execFileSync("dpkg-deb", ["-f", path, "Version"], { encoding: "utf8" }).trim();
  }
  try {
    const { readdir } = await import("node:fs/promises");
    const appimages = (await readdir(debDir)).filter((name) => name.endsWith(".AppImage"));
    if (appimages.length) out.appImageBytes = (await stat(join(debDir, appimages.at(-1)))).size;
  } catch {
    // an AppImage is optional
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------
function metric({ id, label, plain, target, unit, better, summary: sum, pass, method, detail }) {
  return { id, label, plain, target, unit, better, summary: sum, pass, method, detail };
}

function assemble(results) {
  const { cold, idle, snapshots, chrome, pkg } = results;
  const coldPaint = summary(cold.cold.map((run) => run.paintMs).filter(Number.isFinite));
  const coldWarm = summary(cold.warm.map((run) => run.paintMs).filter(Number.isFinite));
  const oneTab = summary(idle.oneTab.map((run) => run.rssKb / 1024));
  const fourParked = summary(idle.fourParked.map((run) => run.rssKb / 1024));
  const fourAwake = summary(idle.fourAwake.map((run) => run.rssKb / 1024));
  const marginalParked = summary(
    idle.fourParked.map((run, index) => (run.rssKb - idle.oneTab[index].rssKb) / 1024 / 3),
  );
  const marginalAwake = summary(
    idle.fourAwake.map((run, index) => (run.rssKb - idle.oneTab[index].rssKb) / 1024 / 3),
  );
  const cpuParked = summary(idle.fourParked.map((run) => run.cpuPercent));
  const cpuOneTab = summary(idle.oneTab.map((run) => run.cpuPercent));

  const smallForm = snapshots.pages.find((page) => page.id === "small-form");
  const heavy = snapshots.pages.find((page) => page.id === "heavy-dashboard");
  const list = snapshots.pages.find((page) => page.id === "long-list");

  // §6 names one p50 and one p95 for the whole harness. The p50 is graded on the
  // long list (~2,000 nodes) — stricter than the "1,000-node page" the budget
  // describes — and the p95 on the heavy dashboard, which is what it names. Each
  // row is the median of the three runs' own percentile, spread across runs.
  const p50Metric = summary(list.perRunP50);
  const p95Metric = summary(heavy.perRunP95);

  const chromeBlank = summary(chrome.idle.find((entry) => entry.label === "about-blank").runs.map((run) => run.rssKb / 1024));
  const chromePage = summary(chrome.idle.find((entry) => entry.label === "small-form").runs.map((run) => run.rssKb / 1024));
  const chromeColdWarm = summary(chrome.warmBlank.map((run) => run.ms));
  const chromeColdPage = summary(chrome.coldPage.map((run) => run.ms));

  const installMb = pkg.installedBytes ? pkg.installedBytes / 1e6 : NaN;

  const metrics = [
    metric({
      id: "cold-start",
      label: "Cold start to first paint",
      plain: "Time from double-click to the page being visible",
      target: 1500,
      unit: "ms",
      better: "lower",
      summary: coldPaint,
      pass: coldPaint.median <= 1500,
      method:
        "exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle.",
      detail: {
        warmProfile: coldWarm,
        windowUp: summary(cold.cold.map((run) => run.windowMs).filter(Number.isFinite)),
        appLoaded: summary(cold.cold.map((run) => run.loadedMs).filter(Number.isFinite)),
      },
    }),
    metric({
      id: "idle-rss",
      label: "Memory, one tab open",
      plain: "Memory the app uses sitting idle with one tab",
      target: 250,
      unit: "MiB",
      better: "lower",
      summary: oneTab,
      pass: oneTab.median <= 250,
      method:
        "Sum of Rss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), 60 s after the tab loaded. Pss is reported too: Rss double counts pages shared between processes.",
      detail: { pssMiB: summary(idle.oneTab.map((run) => run.pssKb / 1024)), fourSpacesPss: summary(idle.fourParked.map((run) => run.pssKb / 1024)) },
    }),
    metric({
      id: "space-margin",
      label: "Extra memory per parked space",
      plain: "Memory added by each agent space kept in the background",
      target: 120,
      unit: "MiB",
      better: "lower",
      summary: marginalParked,
      pass: marginalParked.median <= 120,
      method:
        "(RSS with 4 spaces - RSS with 1 space) / 3, same page in every space, 60 s after load. The three parked spaces are WasHidden(true); the app reports 'parked' in its log, which the harness counts.",
      detail: {
        oneSpace: oneTab,
        fourParked,
        fourAwake,
        awakeMargin: marginalAwake,
        parkedTransitions: idle.fourParked.map((run) => run.parkedTransitions),
      },
    }),
    metric({
      id: "cpu-idle",
      label: "CPU while idle",
      plain: "Share of one processor core wasted while nothing is happening",
      target: 1,
      unit: "%",
      better: "lower",
      summary: cpuParked,
      pass: cpuParked.median <= 1,
      method:
        "Delta of utime+stime over the whole process tree across a 60 s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %.",
      detail: { oneTab: cpuOneTab },
    }),
    metric({
      id: "snapshot-p50",
      label: "Snapshot, median",
      plain: "Time for an agent to read the page it is looking at",
      target: 40,
      unit: "ms",
      better: "lower",
      summary: p50Metric,
      pass: p50Metric.median <= 40,
      method:
        `${CFG.snapshots} snapshots per run x ${CFG.snapshotRuns} runs on the long list (${list.nodes} nodes), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF), viewport scope (the default). Each run's own p50, then median and spread across runs.`,
      detail: {
        perPage: snapshots.pages.map((page) => ({
          id: page.id,
          label: page.label,
          nodes: page.nodes,
          p50: page.viewportP50,
          p95: page.viewportP95,
          perRunP50: page.perRunP50,
          perRunP95: page.perRunP95,
          samples: page.viewportSamples,
          fullPageP50: page.fullP50,
          fullPageP95: page.fullP95,
        })),
      },
    }),
    metric({
      id: "snapshot-p95",
      label: "Snapshot, p95",
      plain: "Time for an agent to read a heavy dashboard, slow case",
      target: 150,
      unit: "ms",
      better: "lower",
      summary: p95Metric,
      pass: p95Metric.median <= 150,
      method: `Same samples as the p50 row; p95 of each run on the heavy dashboard (${heavy.nodes} nodes, ${heavy.snapshotLines} snapshot lines), median and spread across runs.`,
      detail: {
        heavy: { p50: heavy.viewportP50, p95: heavy.viewportP95, nodes: heavy.nodes, lines: heavy.snapshotLines },
        list: { p50: list.viewportP50, p95: list.viewportP95, nodes: list.nodes },
        small: { p50: smallForm.viewportP50, p95: smallForm.viewportP95, nodes: smallForm.nodes },
      },
    }),
    metric({
      id: "install-size",
      label: "Installed size",
      plain: "Disk space the package takes after installing",
      target: 450,
      unit: "MB",
      better: "lower",
      summary: summary([installMb]),
      pass: installMb <= 450,
      method:
        "dpkg's Installed-Size field of the .deb (KiB -> MB), i.e. what dpkg reports for the installed tree. The compressed .deb and the AppImage are listed for context.",
      detail: { debBytes: pkg.debBytes, appImageBytes: pkg.appImageBytes, installedKb: pkg.installedKb },
    }),
  ];

  const baselines = [
    {
      id: "chrome-idle",
      label: "Chrome, headless, one tab",
      plain: "Plain Chrome with one page open, for comparison",
      unit: "MiB",
      target: null,
      summary: chromePage,
      extra: { aboutBlank: chromeBlank, pssMiB: summary(chrome.idle[1].runs.map((run) => run.pssKb / 1024)) },
      method: `google-chrome --headless=new, one page loaded, RSS over the chrome pid tree after a ${CFG.chromeIdleSeconds} s window.`,
    },
    {
      id: "chrome-cold",
      label: "Chrome, headless, cold start",
      plain: "Time for plain Chrome to produce a rendered frame",
      unit: "ms",
      target: null,
      summary: chromeColdWarm,
      extra: { onePage: chromeColdPage },
      method:
        "exec -> PNG written by --screenshot, warm profile. Headless Chrome has no window, so there is no framebuffer to poll; this is its own equivalent measurement, not the same instrument as the rook number.",
    },
  ];

  return {
    metrics,
    baselines,
    derived: {
      coldPaint,
      coldWarm,
      oneTab,
      fourParked,
      fourAwake,
      marginalParked,
      marginalAwake,
      cpuParked,
      cpuOneTab,
      chromeBlank,
      chromePage,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  log(`rook bench — ${startedAt.toISOString()}`);
  log(`${cpus().length} cores, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB, load ${loadavg().map((v) => v.toFixed(2)).join(" ")}`);

  for (const [name, path] of [["app", APP], ["cli", CLI], ["fixtures", FIXTURES]]) {
    try {
      await stat(path);
    } catch {
      throw new Error(`missing ${name} at ${path} — run bench/run.sh, which unpacks the .deb first`);
    }
  }
  await mkdir(join(WORK, "runs"), { recursive: true });
  // Leftovers from an interrupted pass: stale mounts hold their directory open.
  for (const name of readdirSync(join(WORK, "runs"))) {
    await removeRunDir(join(WORK, "runs", name));
  }

  const server = await startFixtureServer();
  log(`fixtures on ${server.base} (127.0.0.1, no external network)`);

  const results = { generatedAt: startedAt.toISOString(), config: CFG };
  try {
    if (wants("cold")) {
      log("1/6 cold start");
      results.cold = await measureColdStart(server);
    }

    if (wants("idle")) {
      log("2/6 idle: 1 tab, then 4 spaces parked and awake");
      results.idle = await measureIdle(server);
    }

    if (wants("snapshots")) {
      log("3/6 snapshot latency through the CLI");
      results.snapshots = await measureSnapshots(server);
    }

    if (wants("chrome")) {
      log("4/6 baseline: google-chrome --headless=new");
      results.chrome = await measureChrome(server);
    }

    log("5/6 package size");
    results.pkg = await measurePackage();
  } finally {
    await server.close();
  }

  if (ONLY.size > 0 && (!results.cold || !results.idle || !results.snapshots || !results.chrome)) {
    log(`partial run (ROOK_BENCH_ONLY=${[...ONLY].join(",")}): not assembling grades`);
    return 0;
  }

  const { metrics, baselines, derived } = assemble(results);

  const host = {
    cores: cpus().length,
    model: cpus()[0]?.model?.trim(),
    memBytes: totalmem(),
    loadavg: loadavg(),
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    node: process.version,
    chrome: chromeVersion(),
    clockTicks: Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()),
    display: "private Xvfb per run (:95-:120)",
    dbus: "DBUS_SESSION_BUS_ADDRESS removed for every app measured",
  };

  const output = {
    discards: DISCARDED,
    discardedRuns: DISCARDED.length,
    generatedAt: results.generatedAt,
    durationSeconds: (Date.now() - startedAt.getTime()) / 1000,
    config: CFG,
    host,
    package: results.pkg,
    metrics,
    baselines,
    derived,
    raw: {
      cold: results.cold,
      idle: results.idle,
      snapshots: {
        pages: results.snapshots.pages,
        standalone: results.snapshots.standalone,
        loadavg: results.snapshots.loadavg,
      },
      chrome: results.chrome,
    },
  };
  await writeFile(RESULTS, `${JSON.stringify(output, null, 2)}\n`);

  const failed = metrics.filter((metricRow) => !metricRow.pass);
  log("");
  log(`wrote ${RESULTS}`);
  log(`${metrics.length - failed.length}/${metrics.length} targets met${failed.length ? `; failing: ${failed.map((m) => m.label).join(", ")}` : ""}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    log(`bench failed: ${error.stack ?? error.message}`);
    process.exitCode = 2;
  },
);
