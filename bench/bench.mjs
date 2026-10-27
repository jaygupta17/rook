#!/usr/bin/env node
/**
 * The performance harness behind ego-lite-linux-architecture.md §6, re-run for
 * Rook 0.4.0.
 *
 *   bench/run.sh                 # unpack the .deb, measure everything, write results.json
 *   bench/run.sh --report        # ... and regenerate report.md / report.html
 *   ROOK_BENCH_QUICK=1 bench/run.sh
 *
 * Seven measurements, on the unpacked .deb, on a private X display, with plain
 * `google-chrome --headless=new` measured the same way for context:
 *
 *   1. cold start      exec -> first painted frame, from the framebuffer
 *   2. idle memory     PSS and summed RSS over the process tree, one tab
 *   3. space margin    the 2nd space, the 4th space, and a second profile
 *   4. snapshot        p50/p95 over 30 snapshots x 3 page classes, viewport and full page
 *   5. CPU idle        utime+stime over the tree across a 60 s window
 *   6. agent round     navigate -> snapshot -> click -> type, split by phase
 *   7. install size    what dpkg will put on disk
 *
 * Nothing here is tuned to hit the budget: the numbers are whatever the box
 * produces, and every method is recorded in results.json next to the number so
 * a reader can disagree with the measurement rather than with the summary.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { launchApp, msSince } from "./lib/app.mjs";
import { Control } from "./lib/control.mjs";
import { sample, byRole } from "./lib/procs.mjs";
import { startXvfb, startPoller } from "./lib/x11.mjs";
import { percentile, summary } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const ROOT = join(HERE, "work", "root");
const CLI = join(ROOT, "usr", "bin", "ego-browser");
const WORK = join(HERE, "work");
const RESULTS = join(HERE, "results.json");
const FIXTURES = join(HERE, "fixtures");

// 0.4.0 shipped as `rook`; the 0.3.0 layout is kept as a fallback so this
// harness still runs against an older package when one is all there is.
const APP = [join(ROOT, "usr", "bin", "rook"), join(ROOT, "usr", "bin", "ego-lite")].find((path) =>
  existsSync(path),
);
const LIB = [join(ROOT, "usr", "lib", "rook"), join(ROOT, "usr", "lib", "ego-lite")].find((path) =>
  existsSync(path),
);

// Env names follow the project's ROOK_ prefix; the older EGO_BENCH_* spellings
// still work so an existing command line does not silently stop applying.
const envAny = (name, fallback) =>
  process.env[`ROOK_BENCH_${name}`] ?? process.env[`EGO_BENCH_${name}`] ?? fallback;

const QUICK = envAny("QUICK", "") === "1";
// Debugging aid: run one section only, e.g. ROOK_BENCH_ONLY=cold. A full pass is
// what run.sh does; a partial pass writes no grades, so it can never be
// mistaken for a full run.
const ONLY = new Set(
  (envAny("ONLY", ""))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const wants = (name) => ONLY.size === 0 || ONLY.has(name);

const CFG = {
  runs: QUICK ? 2 : Number(envAny("RUNS", 3)),
  idleSeconds: QUICK ? 20 : Number(envAny("IDLE_S", 60)),
  // PSS/RSS are flat within ~10 s of load; 60 s is only needed for the CPU window.
  memSeconds: QUICK ? 15 : Number(envAny("MEM_S", 30)),
  wakeSeconds: QUICK ? 12 : Number(envAny("WAKE_S", 20)),
  chromeIdleSeconds: QUICK ? 12 : Number(envAny("CHROME_IDLE_S", 15)),
  snapshots: QUICK ? 10 : Number(envAny("SNAPSHOTS", 30)),
  fullSnapshots: QUICK ? 6 : Number(envAny("FULL_SNAPSHOTS", 20)),
  snapshotRuns: QUICK ? 1 : 3,
  roundRuns: QUICK ? 1 : 3,
  pollTimeout: 25,
};

// Every app launch gets the standard headless Chromium setting below. Without
// it CEF asks libsecret for a key store on this box, no unlocked keyring exists,
// and a gnome-keyring GTK prompt covers the window — a modal dialog from the
// test machine's missing keyring, not from the app, with nothing measurable on
// screen behind it. Details in bench/README.md.
const APP_ENV = {
  ROOK_CEF_EXTRA_FLAGS: process.env.ROOK_CEF_EXTRA_FLAGS ?? "password-store=basic",
  // GTK's GIO layer otherwise activates a private gvfs daemon per run, which
  // mounts a FUSE filesystem inside the run's XDG_RUNTIME_DIR and outlives the
  // app. A desktop has one gvfs for the session; a bench run should not leak one.
  GIO_USE_VFS: "local",
};

// The bridge's own env names moved from EGO_LITE_* to ROOK_* in 0.4.0.
const BACKEND_ENV = "ROOK_BACKEND";
const SOCKET_ENV = "ROOK_HOST_SOCKET";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(`${line}\n`);
const now = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
const fmt0 = (value) => (Number.isFinite(value) ? value.toFixed(0) : "—");

/**
 * The packaged app sometimes does not survive a long wait (a launch dies, or a
 * renderer goes away). A run whose app died is not a slow run, it is no run at
 * all, so it is discarded and retried, and every discard is recorded in
 * results.json rather than hidden.
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

const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);

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
  return { base, hits, close: () => new Promise((resolve) => server.close(resolve)) };
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
 *   paint  — first frame containing the page's own colour (the metric)
 *   window — first non-black pixel (GTK window is up, page still blank)
 *   loaded — the app's own "tab ... loaded (http 200)" log line
 */
async function coldStartRun({ url, dataHome, runtimeDir, label, extraEnv = {} }) {
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
      extraEnv: { ...APP_ENV, ...extraEnv },
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
    log(`  cold start, cold profile ${run + 1}/${CFG.runs}: ${cold.at(-1).paintMs.toFixed(0)} ms to first paint`);
  }
  // Warm profile: the same directory every time, which is a normal launch. The
  // first pass through it only creates the profile, so it is a warm-up and is
  // not one of the measured runs.
  const shared = await newRunDirs("cold-warm");
  const warmup = await withRetry("cold start, warm-up", 3, () =>
    coldStartRun({ url, ...shared, label: "warm profile warm-up" }),
  );
  log(`  cold start, warm profile warm-up (discarded): ${warmup.paintMs.toFixed(0)} ms`);
  for (let run = 0; run < CFG.runs; run += 1) {
    warm.push(
      await withRetry(`cold start, warm profile #${run + 1}`, 3, () =>
        coldStartRun({ url, ...shared, label: `warm profile #${run + 1}` }),
      ),
    );
    log(`  cold start, warm profile ${run + 1}/${CFG.runs}: ${warm.at(-1).paintMs.toFixed(0)} ms to first paint`);
  }
  return { cold, warm, url };
}

// ---------------------------------------------------------------------------
// 2./3./5. Idle: memory per configuration, and CPU
// ---------------------------------------------------------------------------
/**
 * Launch with `spaces` in the default profile (and optionally more spaces in a
 * second profile, created over the control socket), wait until every tab
 * reported a load, let it settle, then watch the tree for `seconds`:
 * RSS and PSS every slice, CPU as the difference of utime+stime across the whole
 * window.
 */
async function idleRun({ label, config, pageUrl, seconds, awake = false }) {
  const dirs = await newRunDirs(label.replace(/[^a-z0-9]+/gi, "-"));
  const xvfb = await startXvfb();
  let app = null;
  let control = null;
  const pokeTimers = [];
  const createdTabIds = [];
  try {
    app = launchApp({
      appBin: APP,
      display: xvfb.display,
      dataHome: dirs.dataHome,
      runtimeDir: dirs.runtimeDir,
      socketPath: config.extraProfiles.length || awake ? dirs.socketPath : null,
      spaces: config.spaces.map((name) => `${name}=${pageUrl}`),
      extraEnv: APP_ENV,
    });
    const totalTabs = config.spaces.length + config.extraProfiles.length;
    await waitFor(
      `${config.spaces.length} tab(s) loaded`,
      () => app.lines.filter((line) => /loaded \(http 200\)/.test(line.text)).length >= config.spaces.length,
      60000,
      50,
    );

    // A space in another profile cannot come from --space: it needs its own
    // CefRequestContext, which is exactly what createSpace(profileId) makes.
    const profilesSeen = new Map();
    if (config.extraProfiles.length) {
      control = await Control.connect(dirs.socketPath);
      const profileIds = new Map();
      for (const spec of config.extraProfiles) {
        // A space can only be created inside a profile that exists, and the
        // host names profiles itself (a slug), so ask it to create one first.
        let profileId = spec.profileId;
        if (!profileId) {
          if (!profileIds.has(spec.profileName)) {
            const created = json(await control.request("createProfile", { name: spec.profileName }));
            profileIds.set(spec.profileName, created.profileId);
          }
          profileId = profileIds.get(spec.profileName);
        }
        const space = json(await control.request("createSpace", { name: spec.name, profileId }));
        const tab = json(await control.request("createTab", { spaceId: space.spaceId, url: pageUrl }));
        createdTabIds.push(tab.tabId);
        profilesSeen.set(space.profileId, (profilesSeen.get(space.profileId) ?? 0) + 1);
      }
      await waitFor(
        `${totalTabs} tab(s) loaded`,
        () => app.lines.filter((line) => /loaded \(http 200\)/.test(line.text)).length >= totalTabs,
        60000,
        50,
      );
    }

    // Let the load spike drain before the measurement window opens: the first
    // frames, the initial GC and the profile writes all belong to startup.
    await sleep(5000);

    if (awake) {
      if (!control) control = await Control.connect(dirs.socketPath);
      const tabs = [];
      const spacesReply = json(await control.request("listSpaces"));
      for (const space of spacesReply.spaces) {
        const listed = json(await control.request("listTabs", { spaceId: space.spaceId }));
        for (const tab of listed.tabs) tabs.push({ tabId: tab.tabId, profileId: space.profileId });
        profilesSeen.set(space.profileId, (profilesSeen.get(space.profileId) ?? 0) + 1);
      }
      if (tabs.length !== totalTabs) {
        throw new Error(`expected ${totalTabs} tabs to wake, the host listed ${tabs.length}`);
      }
      // The parking sweep re-parks a tab 10 s after its last CDP message, so
      // poking every 6 s holds every space at WasHidden(false) for the window.
      const poke = async () => {
        for (const tab of tabs) {
          await control
            .request("cdp.send", {
              browserId: tab.tabId,
              message: JSON.stringify({ id: 1, method: "Page.enable" }),
            })
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
      const taken = sample(app.pid, dirs.dataHome);
      trace.push({ atMs: Math.round(ms(before.t, now())), rssKb: taken.rssKb, pssKb: taken.pssKb });
    }
    const after = { t: now(), sample: sample(app.pid, dirs.dataHome) };
    const windowSeconds = ms(before.t, after.t) / 1000;
    const cpuSeconds = Math.max(0, after.sample.cpuSeconds - before.sample.cpuSeconds);
    const parked = app.lines.filter((line) => /parked$/.test(line.text)).length;
    const awakeLines = app.lines.filter((line) => /awake$/.test(line.text)).length;
    if (app.child.exitCode !== null) {
      throw new Error(`the app exited during the ${Math.round(seconds)} s window (exit ${app.child.exitCode})`);
    }
    if (after.sample.pids === 0) {
      throw new Error("the process tree came back empty");
    }
    return {
      label,
      spaces: config.spaces.length,
      extraProfiles: config.extraProfiles.length,
      profiles: [...profilesSeen.keys()],
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
  const configs = [
    {
      key: "oneTab",
      label: "idle-1space",
      title: "1 space",
      config: { spaces: ["You"], extraProfiles: [] },
      seconds: CFG.memSeconds,
    },
    {
      key: "twoSpaces",
      label: "idle-2spaces",
      title: "2 spaces, same profile",
      config: { spaces: ["You", "Agent 1"], extraProfiles: [] },
      seconds: CFG.memSeconds,
    },
    {
      key: "fourSpaces",
      label: "idle-4spaces",
      title: "4 spaces, same profile",
      config: { spaces: ["You", "Agent 1", "Agent 2", "Agent 3"], extraProfiles: [] },
      seconds: CFG.idleSeconds,
    },
    {
      key: "secondProfile",
      label: "idle-2profiles",
      title: "2 spaces, a second profile",
      config: {
        spaces: ["You"],
        extraProfiles: [{ name: "Agent 1", profileName: "Bench second" }],
      },
      seconds: CFG.memSeconds,
    },
  ];
  const out = {};
  for (const entry of configs) {
    const runs = [];
    log(`  ${entry.title} (${entry.seconds} s window, ${CFG.runs} runs)`);
    for (let run = 0; run < CFG.runs; run += 1) {
      runs.push(
        await withRetry(`${entry.title} #${run + 1}`, 3, () =>
          idleRun({
            label: `${entry.label}-${run}`,
            config: entry.config,
            pageUrl: url,
            seconds: entry.seconds,
          }),
        ),
      );
      const last = runs.at(-1);
      log(
        `  ${entry.title} ${run + 1}/${CFG.runs}: PSS ${(last.pssKb / 1024).toFixed(0)} MiB, ` +
          `RSS ${(last.rssKb / 1024).toFixed(0)} MiB, ${last.cpuPercent.toFixed(2)} % CPU, ${last.pids} processes`,
      );
    }
    out[entry.key] = runs;
  }

  // Awake variant of the 4-space configuration: the same lever an agent round
  // pulls, to show what parking actually buys.
  log(`  4 spaces awake (${CFG.wakeSeconds} s window, ${CFG.runs} runs)`);
  const awake = [];
  for (let run = 0; run < CFG.runs; run += 1) {
    awake.push(
      await withRetry(`4 spaces awake #${run + 1}`, 3, () =>
        idleRun({
          label: `idle-4awake-${run}`,
          config: configs[2].config,
          pageUrl: url,
          seconds: CFG.wakeSeconds,
          awake: true,
        }),
      ),
    );
    log(
      `  4 spaces awake ${run + 1}/${CFG.runs}: PSS ${(awake.at(-1).pssKb / 1024).toFixed(0)} MiB, ` +
        `RSS ${(awake.at(-1).rssKb / 1024).toFixed(0)} MiB`,
    );
  }
  out.fourAwake = awake;
  out.url = url;
  return out;
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
  let header = "";
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    const text = await page.snapshot(options);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (i === 0) {
      const lines = String(text).split("\\n");
      header = lines.find((line) => line.startsWith("snapshot scope=")) || "";
    }
  }
  return { times, header };
}

const viewport = await timeSnapshots({}, iterations, 3);
const full = fullIterations > 0 ? await timeSnapshots({ scope: "full_page" }, fullIterations, 1) : { times: [], header: "" };
console.log("BENCH " + JSON.stringify({
  nodes,
  viewport: viewport.times,
  viewportHeader: viewport.header,
  full: full.times,
  fullHeader: full.header,
}));
await task.finish({ keep: [] });
`;

/**
 * Run the CLI once, with the script on stdin. Returns the parsed BENCH line.
 * `ROOK_BACKEND=host` is the point: this is the bridge -> control socket -> CEF
 * path an agent actually uses, not a CDP shortcut the bench invented.
 */
function runCli({ env, script = SNAPSHOT_SCRIPT }) {
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
    child.stdin.end(script);
  });
}

const PAGE_CLASSES = [
  { id: "small-form", file: "small-form.html", label: "small form" },
  { id: "long-list", file: "long-list.html", label: "long list" },
  { id: "heavy-dashboard", file: "heavy-dashboard.html", label: "heavy dashboard" },
];

/** Header like `snapshot scope=viewport only, 22 lines, 6 refs, ...`. */
function parseScopeHeader(header) {
  const match = /^snapshot scope=([^,]+),\s*(\d+) lines,\s*(\d+) refs/.exec(header ?? "");
  if (!match) return null;
  return { scope: match[1].trim(), lines: Number(match[2]), refs: Number(match[3]) };
}

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
      log("  the app is gone; restarting it before the next CLI run");
      if (app) await app.kill();
      await rm(dirs.socketPath, { force: true });
      await startApp();
    };

    await startApp();

    const env = {
      DISPLAY: xvfb.display,
      XDG_RUNTIME_DIR: dirs.runtimeDir,
      XDG_DATA_HOME: dirs.dataHome,
      [SOCKET_ENV]: dirs.socketPath,
      [BACKEND_ENV]: "host",
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
              ROOK_BENCH_FULL: String(CFG.fullSnapshots),
            },
          });
        });
        runs.push(result);
      }
      const pick = (key) => runs.flatMap((run) => run[key] ?? []);
      const viewport = pick("viewport");
      const full = pick("full");
      pages.push({
        ...pageClass,
        url,
        nodes: runs[0].nodes,
        viewportHeader: runs[0].viewportHeader,
        fullHeader: runs[0].fullHeader,
        viewportScope: parseScopeHeader(runs[0].viewportHeader),
        fullScope: parseScopeHeader(runs[0].fullHeader),
        viewport: summary(viewport),
        viewportP50: percentile(viewport, 50),
        viewportP95: percentile(viewport, 95),
        viewportSamples: viewport.length,
        perRunP50: runs.map((run) => percentile(run.viewport, 50)),
        perRunP95: runs.map((run) => percentile(run.viewport, 95)),
        full: summary(full),
        fullP50: percentile(full, 50),
        fullP95: percentile(full, 95),
        fullSamples: full.length,
        perRunFullP50: runs.map((run) => percentile(run.full, 50)),
        perRunFullP95: runs.map((run) => percentile(run.full, 95)),
      });
      log(
        `  snapshot ${pageClass.label}: ${runs[0].nodes} elements, viewport p50 ` +
          `${percentile(viewport, 50).toFixed(1)} / p95 ${percentile(viewport, 95).toFixed(1)} ms, ` +
          `full page p50 ${percentile(full, 50).toFixed(1)} / p95 ${percentile(full, 95).toFixed(1)} ms ` +
          `(${viewport.length}+${full.length} samples)`,
      );
    }

    // The same measurement one layer down: the bridge against its own Chrome,
    // no host socket in between. If these match the host ones, the cost is the
    // snapshot pipeline, not the pipe to the app.
    const standalone = [];
    if (envAny("STANDALONE", "1") !== "0") {
      const stateDir = join(dirs.dir, "standalone-state");
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
              [SOCKET_ENV]: "",
              [BACKEND_ENV]: "standalone",
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
          standalone.push({ id: pageClass.id, error: error.message.split("\n")[0] });
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
// 6. Agent round: navigate -> snapshot -> click -> type
// ---------------------------------------------------------------------------
// The script is the unit an agent actually runs: one CLI invocation, one round.
// It stamps every phase on CLOCK_MONOTONIC, the same clock the harness uses, so
// spawn -> first statement is the CLI's own startup and everything after it is
// the browser's.
const ROUND_SCRIPT = `
const started = process.hrtime.bigint();
const marks = { start: String(started) };
const mark = (name) => { marks[name] = String(process.hrtime.bigint()); };

const task = await taskSpace(process.env.ROOK_BENCH_SPACE);
mark("taskSpace");
const page = task.page("p1");
mark("page");
await page.goto(process.env.ROOK_BENCH_URL);
mark("goto");
const snap = await page.snapshot();
mark("snapshot");

const lines = String(snap).split("\\n");
const refOf = (pattern) => {
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const found = /\\[ref=(\\d+)/.exec(line);
    if (found) return found[1];
  }
  return null;
};
const button = refOf(/button "Forgot password\\?"/);
if (!button) throw new Error("snapshot has no ref for the 'Forgot password?' button");
await page.click("@" + button);
mark("click");
const field = refOf(/textbox "Email"/);
if (!field) throw new Error("snapshot has no ref for the Email textbox");
await page.click("@" + field);
await page.keyboard.type("ada@example.com");
mark("type");
await task.finish({ keep: [] });
mark("finish");
console.log("ROUND " + JSON.stringify({ marks, ends: String(process.hrtime.bigint()), lines: lines.length, header: lines[1] || "" }));
`;

async function measureAgentRound(server) {
  const dirs = await newRunDirs("agent-round");
  const xvfb = await startXvfb();
  let app = null;
  try {
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
    const env = {
      DISPLAY: xvfb.display,
      XDG_RUNTIME_DIR: dirs.runtimeDir,
      XDG_DATA_HOME: dirs.dataHome,
      [SOCKET_ENV]: dirs.socketPath,
      [BACKEND_ENV]: "host",
    };
    const url = `${server.base}/small-form.html`;

    const runs = [];
    for (let run = 0; run < CFG.roundRuns; run += 1) {
      const result = await withRetry(`agent round #${run + 1}`, 3, () => {
        if (app.child.exitCode !== null) throw new Error("the app exited");
        return runRound({
          env: { ...env, ROOK_BENCH_URL: url, ROOK_BENCH_SPACE: `bench-round-${run}` },
        });
      });
      runs.push(result);
      log(
        `  agent round ${run + 1}/${CFG.roundRuns}: ${result.totalMs.toFixed(0)} ms total ` +
          `(CLI ${result.cliStartupMs.toFixed(0)} ms, browser ${result.browserMs.toFixed(0)} ms)`,
      );
    }
    return { runs, url };
  } finally {
    if (app) await app.kill();
    await xvfb.stop();
  }
}

/**
 * One CLI invocation, timed from spawn to exit. The script's own marks split the
 * wall time into CLI startup (node + SDK load, before the first statement runs),
 * browser phases (round trips to the running app) and teardown.
 */
function runRound({ env }) {
  return new Promise((resolve, reject) => {
    const spawnedAt = now();
    const child = spawn(CLI, ["nodejs"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
      const exitedAt = now();
      const line = out.split("\n").find((candidate) => candidate.startsWith("ROUND "));
      if (code !== 0 || !line) {
        reject(new Error(`round exited ${code}: ${(err || out).slice(-1200)}`));
        return;
      }
      const parsed = JSON.parse(line.slice("ROUND ".length));
      const at = (name) => BigInt(parsed.marks[name] ?? parsed.ends);
      const phases = {};
      let previous = "start";
      for (const name of ["taskSpace", "page", "goto", "snapshot", "click", "type", "finish"]) {
        if (parsed.marks[name]) {
          phases[name] = ms(at(previous), at(name));
          previous = name;
        }
      }
      const browserMs =
        phases.taskSpace + phases.page + phases.goto + phases.snapshot + phases.click + phases.type;
      resolve({
        totalMs: ms(spawnedAt, exitedAt),
        cliStartupMs: ms(spawnedAt, BigInt(parsed.marks.start)),
        browserMs,
        teardownMs: ms(BigInt(parsed.marks.type ?? parsed.marks.finish), BigInt(parsed.ends)) + ms(BigInt(parsed.ends), exitedAt),
        phases,
        snapshotLines: parsed.lines,
        snapshotHeader: parsed.header,
      });
    });
    child.stdin.end(ROUND_SCRIPT);
  });
}

// ---------------------------------------------------------------------------
// Baseline: stock headless Chrome, measured the same way
// ---------------------------------------------------------------------------
const CHROME = process.env[`ROOK_BENCH_CHROME`] ?? process.env[`EGO_BENCH_CHROME`] ?? "/usr/bin/google-chrome";

function chromeVersion() {
  try {
    return execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "google-chrome not found";
  }
}

function chromeColdRun({ url, profileDir, pngPath }) {
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--password-store=basic",
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
      resolve({ ms: elapsed, code, bytes, stderr: code === 0 ? undefined : err.slice(-600) });
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
    "--password-store=basic",
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
      const taken = sample(child.pid, null);
      trace.push({ atMs: Math.round(ms(before.t, now())), rssKb: taken.rssKb, pssKb: taken.pssKb });
    }
    const after = { t: now(), sample: sample(child.pid, null) };
    const windowSeconds = ms(before.t, after.t) / 1000;
    return {
      label,
      windowSeconds,
      rssKb: after.sample.rssKb,
      pssKb: after.sample.pssKb,
      pids: after.sample.pids,
      cpuPercent: (Math.max(0, after.sample.cpuSeconds - before.sample.cpuSeconds) / windowSeconds) * 100,
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
  // MB of profile on first launch, so it is measured separately from the warm
  // case, exactly as the app is.
  for (let run = 0; run < CFG.runs; run += 1) {
    coldBlank.push(
      await chromeColdRun({
        url: "about:blank",
        profileDir: join(dir, `blank-${run}`),
        pngPath: join(dir, `blank-${run}.png`),
      }),
    );
  }
  const warmBlankProfile = join(dir, "blank-warm");
  // Same rule as the app: the first launch into a fresh profile dir only
  // creates the profile, so it is a discarded warm-up.
  const warmup = await chromeColdRun({
    url: "about:blank",
    profileDir: warmBlankProfile,
    pngPath: join(dir, "blankw-warmup.png"),
  });
  log(`  chrome warm-up (discarded): ${warmup.ms.toFixed(0)} ms`);
  for (let run = 0; run < CFG.runs; run += 1) {
    warmBlank.push(
      await chromeColdRun({
        url: "about:blank",
        profileDir: warmBlankProfile,
        pngPath: join(dir, `blankw-${run}.png`),
      }),
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
    log(
      `  chrome idle ${label}: PSS ${(runs[0].pssKb / 1024).toFixed(0)} MiB, ` +
        `RSS ${(runs[0].rssKb / 1024).toFixed(0)} MiB, ${runs[0].cpuPercent.toFixed(2)} % CPU`,
    );
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
    debs = (await readdirSafe(debDir)).filter((name) => name.endsWith(".deb")).sort();
  } catch {
    debs = [];
  }
  const deb = debs.at(-1);
  if (deb) {
    const path = join(debDir, deb);
    out.deb = path;
    out.debBytes = (await stat(path)).size;
    out.installedKb = Number(execFileSync("dpkg-deb", ["-f", path, "Installed-Size"], { encoding: "utf8" }).trim());
    out.installedBytes = out.installedKb * 1024;
    out.version = execFileSync("dpkg-deb", ["-f", path, "Version"], { encoding: "utf8" }).trim();
    out.package = execFileSync("dpkg-deb", ["-f", path, "Package"], { encoding: "utf8" }).trim();
  }
  try {
    const appimages = (await readdirSafe(debDir)).filter((name) => name.endsWith(".AppImage"));
    if (appimages.length) out.appImageBytes = (await stat(join(debDir, appimages.at(-1)))).size;
  } catch {
    // an AppImage is optional
  }
  return out;
}

async function readdirSafe(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------
function metric({ id, label, plain, target, unit, better, summary: sum, pass, method, detail, improved }) {
  return { id, label, plain, target, unit, better, summary: sum, pass, method, detail, improved };
}

function assemble(results) {
  const { cold, idle, snapshots, chrome, pkg, round } = results;
  const pss = (run) => run.pssKb / 1024;
  const rss = (run) => run.rssKb / 1024;

  const coldPaint = summary(cold.cold.map((run) => run.paintMs));
  const coldWarm = summary(cold.warm.map((run) => run.paintMs));
  const oneTabPss = summary(idle.oneTab.map(pss));
  const oneTabRss = summary(idle.oneTab.map(rss));
  const twoPss = summary(idle.twoSpaces.map(pss));
  const fourPss = summary(idle.fourSpaces.map(pss));
  const secondProfilePss = summary(idle.secondProfile.map(pss));
  const fourAwakePss = summary(idle.fourAwake.map(pss));

  // Marginal cost in PSS: what each additional space (or profile) really adds.
  const marginalSecond = summary(idle.twoSpaces.map((run, i) => pss(run) - pss(idle.oneTab[i])));
  const marginalFourth = summary(
    idle.fourSpaces.map((run, i) => (pss(run) - pss(idle.twoSpaces[i])) / 2),
  );
  const marginalProfile = summary(
    idle.secondProfile.map((run, i) => pss(run) - pss(idle.oneTab[i])),
  );
  const marginalPerSpaceOld = summary(
    idle.fourSpaces.map((run, i) => (pss(run) - pss(idle.oneTab[i])) / 3),
  );
  // The 0.3.0 figure was computed in summed RSS over the same 4-vs-1 shape, so
  // this is the like-for-like repeat of it, in the units it was written in.
  const marginalPerSpaceRss = summary(
    idle.fourSpaces.map((run, i) => (rss(run) - rss(idle.oneTab[i])) / 3),
  );

  const cpuParked = summary(idle.fourSpaces.map((run) => run.cpuPercent));
  const cpuOneTab = summary(idle.oneTab.map((run) => run.cpuPercent));

  const smallForm = snapshots.pages.find((page) => page.id === "small-form");
  const list = snapshots.pages.find((page) => page.id === "long-list");
  const heavy = snapshots.pages.find((page) => page.id === "heavy-dashboard");

  // §6 names one p50 and one p95 for the whole harness. The p50 is graded on the
  // long list (~2,400 elements) — stricter than the "1,000-node page" the budget
  // describes — and the p95 on the heavy dashboard, which is what it names. Each
  // row is the median of the three runs' own percentile, spread across runs.
  const p50Metric = summary(list.perRunP50);
  const p95Metric = summary(heavy.perRunP95);
  const p50FullMetric = summary(list.perRunFullP50);
  const p95FullMetric = summary(heavy.perRunFullP95);

  const roundTotal = summary(round.runs.map((run) => run.totalMs));
  const roundCli = summary(round.runs.map((run) => run.cliStartupMs));
  const roundBrowser = summary(round.runs.map((run) => run.browserMs));
  const roundPhase = (name) => summary(round.runs.map((run) => run.phases[name] ?? NaN));

  const chromeBlankPss = summary(chrome.idle.find((entry) => entry.label === "about-blank").runs.map((run) => run.pssKb / 1024));
  const chromePagePss = summary(chrome.idle.find((entry) => entry.label === "small-form").runs.map((run) => run.pssKb / 1024));
  const chromePageRss = summary(chrome.idle.find((entry) => entry.label === "small-form").runs.map((run) => run.rssKb / 1024));
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
      improved: "0.4.0 fixed the at-spi stall",
      method:
        "exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X display server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle.",
      detail: {
        warmProfile: coldWarm,
        windowUp: summary(cold.cold.map((run) => run.windowMs).filter(Number.isFinite)),
        appLoaded: summary(cold.cold.map((run) => run.loadedMs).filter(Number.isFinite)),
      },
    }),
    metric({
      id: "idle-pss",
      label: "Memory, one tab open (PSS)",
      plain: "Memory the app uses sitting idle with one tab",
      target: 250,
      unit: "MiB",
      better: "lower",
      summary: oneTabPss,
      pass: oneTabPss.median <= 250,
      improved: "reported as PSS, which does not double count shared pages",
      method:
        `Sum of Pss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), ${CFG.memSeconds} s after the tab loaded. PSS splits a shared page between the processes mapping it, so it is the number that adds up to real memory. Summed RSS is the row below.`,
      detail: { rss: oneTabRss, pids: idle.oneTab[0]?.pids, chrome: chromePagePss },
    }),
    metric({
      id: "idle-rss",
      label: "Memory, one tab open (summed RSS)",
      plain: "The same app, counted the old way: every process's RSS added up",
      target: null,
      unit: "MiB",
      better: "lower",
      summary: oneTabRss,
      pass: null,
      method:
        "Sum of Rss over the same process tree. Every process maps the same libcef.so, so this counts those ~277 MB once per process: it is an upper bound, not memory in use. Kept because the original budget was written in these units.",
      detail: { pss: oneTabPss },
    }),
    metric({
      id: "space-margin-2",
      label: "Extra memory for a 2nd space",
      plain: "Memory added by a second space inside the same profile",
      target: 120,
      unit: "MiB",
      better: "lower",
      summary: marginalSecond,
      pass: marginalSecond.median <= 120,
      improved: "measured per space, not per renderer",
      method:
        `(PSS with 2 spaces - PSS with 1 space), same page in both, same profile, ${CFG.memSeconds} s after load. The 0.3.0 figure was summed RSS over 4-vs-1 spaces, when every space also had its own browser context: that counted libcef once per renderer, which is why 130 MB was a real measurement of the wrong quantity.`,
      detail: { twoSpaces: twoPss, fourSpaces: fourPss, perSpaceOfFour: marginalPerSpaceOld },
    }),
    metric({
      id: "space-margin-4",
      label: "Extra memory for the 4th space",
      plain: "Memory added by the third and fourth space, per space",
      target: 120,
      unit: "MiB",
      better: "lower",
      summary: marginalFourth,
      pass: marginalFourth.median <= 120,
      improved: "measured per space, not per renderer",
      method:
        `((PSS with 4 spaces - PSS with 2 spaces) / 2), same page in every space, same profile, ${CFG.memSeconds} s after load.`, 
      detail: { awake: fourAwakePss, parkedTransitions: idle.fourSpaces.map((run) => run.parkedTransitions) },
    }),
    metric({
      id: "profile-margin",
      label: "Extra memory for a 2nd profile",
      plain: "Memory added by a second profile, which is a whole separate browser context",
      target: null,
      unit: "MiB",
      better: "lower",
      summary: marginalProfile,
      pass: null,
      improved: "new measurement: profiles are the isolation boundary now",
      method:
        `(PSS with 1 space + 1 space in a second profile - PSS with 1 space), same page, ${CFG.memSeconds} s after load; the second profile's space is created over the control socket with createProfile + createSpace(profileId), the same calls the bridge makes.`,
      detail: { both: secondProfilePss, profiles: idle.secondProfile[0]?.profiles },
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
        `Delta of utime+stime over the whole process tree across a ${CFG.idleSeconds} s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %.`,
      detail: { oneTab: cpuOneTab },
    }),
    metric({
      id: "snapshot-p50",
      label: "Snapshot p50, viewport",
      plain: "Time for an agent to read the page it is looking at",
      target: 40,
      unit: "ms",
      better: "lower",
      summary: p50Metric,
      pass: p50Metric.median <= 40,
      improved: "0.4.0 reworked the serializer",
      method:
        `${CFG.snapshots} viewport snapshots per run x ${CFG.snapshotRuns} runs on the long list (${list.nodes} elements), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF). The snapshot's own scope header says what was returned; each run's p50, then median and spread across runs.`,
      detail: {
        perPage: snapshots.pages.map((page) => ({
          id: page.id,
          label: page.label,
          nodes: page.nodes,
          viewportScope: page.viewportScope,
          fullScope: page.fullScope,
          p50: page.viewportP50,
          p95: page.viewportP95,
          fullP50: page.fullP50,
          fullP95: page.fullP95,
          perRunP50: page.perRunP50,
          perRunP95: page.perRunP95,
          samples: page.viewportSamples,
          fullSamples: page.fullSamples,
        })),
      },
    }),
    metric({
      id: "snapshot-p95",
      label: "Snapshot p95, viewport",
      plain: "Time for an agent to read a heavy dashboard, slow case",
      target: 150,
      unit: "ms",
      better: "lower",
      summary: p95Metric,
      pass: p95Metric.median <= 150,
      improved: "0.4.0 reworked the serializer",
      method: `Same samples as the p50 row; p95 of each run on the heavy dashboard (${heavy.nodes} elements), median and spread across runs.`,
      detail: { header: heavy.viewportHeader },
    }),
    metric({
      id: "snapshot-p50-full",
      label: "Snapshot p50, full page",
      plain: "The same read, with nothing filtered out",
      target: null,
      unit: "ms",
      better: "lower",
      summary: p50FullMetric,
      pass: null,
      improved: "0.4.0 reworked the serializer",
      method: `Same CLI round, ${CFG.fullSnapshots} 'full_page' snapshots per run on the long list. Not part of the original budget, which is written for the default viewport scope.`,
      detail: { header: list.fullHeader },
    }),
    metric({
      id: "snapshot-p95-full",
      label: "Snapshot p95, full page",
      plain: "The slow case of the same read, with nothing filtered out",
      target: null,
      unit: "ms",
      better: "lower",
      summary: p95FullMetric,
      pass: null,
      improved: "0.4.0 reworked the serializer",
      method: `Same samples as the full-page p50 row; p95 on the heavy dashboard (${heavy.nodes} elements).`,
      detail: { header: heavy.fullHeader },
    }),
    metric({
      id: "agent-round",
      label: "Agent round (navigate → snapshot → click → type)",
      plain: "How long one complete agent step takes, from the command line",
      target: null,
      unit: "ms",
      better: "lower",
      summary: roundTotal,
      pass: null,
      method:
        `One 'ego-browser nodejs' invocation per run, ${CFG.roundRuns} runs, on the local small-form page: create space, open the page, snapshot, click "Forgot password?", click the email field, type 15 characters, finish. Timed from spawn to exit; the script stamps every phase on the same clock.`,
      detail: {
        cliStartup: roundCli,
        browser: roundBrowser,
        phases: {
          taskSpace: roundPhase("taskSpace"),
          page: roundPhase("page"),
          goto: roundPhase("goto"),
          snapshot: roundPhase("snapshot"),
          click: roundPhase("click"),
          type: roundPhase("type"),
        },
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
      summary: chromePagePss,
      extra: { aboutBlank: chromeBlankPss, rss: chromePageRss },
      method: `google-chrome --headless=new, one page loaded, PSS over the Chrome pid tree after a ${CFG.chromeIdleSeconds} s window.`,
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
        "exec -> PNG written by --screenshot, warm profile after a discarded warm-up. Headless Chrome has no window, so there is no framebuffer to poll; this is its own equivalent measurement, not the same instrument as the app's number.",
    },
  ];

  return {
    metrics,
    baselines,
    derived: {
      coldPaint,
      coldWarm,
      oneTabPss,
      oneTabRss,
      twoPss,
      fourPss,
      secondProfilePss,
      fourAwakePss,
      marginalSecond,
      marginalFourth,
      marginalProfile,
      marginalPerSpaceOld,
      marginalPerSpaceRss,
      cpuParked,
      cpuOneTab,
      chromeBlankPss,
      chromePagePss,
      roundTotal,
      roundCli,
      roundBrowser,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
/**
 * Rebuild the metric rows from the raw samples already in results.json. The
 * numbers are copied, not re-measured: this exists so a correction to a method
 * description does not cost another 13-minute pass, and it can never change a
 * measurement (it only reads `raw`).
 */
async function recompute() {
  const stored = JSON.parse(readFileSync(RESULTS, "utf8"));
  const { metrics, baselines, derived } = assemble({
    cold: stored.raw.cold,
    idle: stored.raw.idle,
    snapshots: { pages: stored.raw.snapshots.pages, standalone: stored.raw.snapshots.standalone, loadavg: stored.raw.snapshots.loadavg },
    round: stored.raw.round,
    chrome: stored.raw.chrome,
    pkg: stored.package,
  });
  const next = {
    ...stored,
    metrics,
    baselines,
    derived,
    recomputedAt: new Date().toISOString(),
  };
  await writeFile(RESULTS, `${JSON.stringify(next, null, 2)}\n`);
  const graded = metrics.filter((row) => row.pass !== null);
  const failed = graded.filter((row) => !row.pass);
  log(`recomputed ${RESULTS} from stored raw samples (${graded.length - failed.length}/${graded.length} targets met)`);
  return failed.length === 0 ? 0 : 1;
}

async function main() {
  if (envAny("RECOMPUTE", "") === "1") {
    return recompute();
  }
  const startedAt = new Date();
  log(`rook bench — ${startedAt.toISOString()}`);
  log(`${cpus().length} cores, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB, load ${loadavg().map((v) => v.toFixed(2)).join(" ")}`);

  if (!APP || !existsSync(APP)) {
    throw new Error(`no app binary in ${ROOT}/usr/bin (run bench/run.sh, which unpacks the .deb first)`);
  }
  if (!LIB) {
    throw new Error(`no payload directory in ${ROOT}/usr/lib (run bench/run.sh, which unpacks the .deb first)`);
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
      log("1/7 cold start");
      results.cold = await measureColdStart(server);
    }

    if (wants("idle")) {
      log("2/7 idle: 1, 2 and 4 spaces, and a second profile");
      results.idle = await measureIdle(server);
    }

    if (wants("snapshots")) {
      log("3/7 snapshot latency through the CLI (viewport and full page)");
      results.snapshots = await measureSnapshots(server);
    }

    if (wants("round")) {
      log("4/7 agent round: navigate, snapshot, click, type");
      results.round = await measureAgentRound(server);
    }

    if (wants("chrome")) {
      log("5/7 baseline: google-chrome --headless=new");
      results.chrome = await measureChrome(server);
    }

    log("6/7 package size");
    results.pkg = await measurePackage();
  } finally {
    await server.close();
  }

  if (ONLY.size > 0 && (!results.cold || !results.idle || !results.snapshots || !results.chrome || !results.round)) {
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
    app: { binary: APP, lib: LIB, cli: CLI },
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
      round: results.round,
      chrome: results.chrome,
    },
  };
  await writeFile(RESULTS, `${JSON.stringify(output, null, 2)}\n`);

  const graded = metrics.filter((row) => row.pass !== null);
  const failed = graded.filter((metricRow) => !metricRow.pass);
  log("");
  log(`wrote ${RESULTS}`);
  log(
    `${graded.length - failed.length}/${graded.length} targets met` +
      `${failed.length ? `; failing: ${failed.map((m) => m.label).join(", ")}` : ""}`,
  );
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
