import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CdpConnection } from "./cdp.js";
import { browserKey, browsersRoot, chromeBinary, profileDataDir, stateDir } from "./paths.js";
import { loadBrowsers, readJsonFile, saveBrowsers, withLock } from "./store.js";

/** profileId -> Promise<handle> */
const handles = new Map();

export async function ensureBrowser(profileId, options = {}) {
  const existing = handles.get(profileId);
  if (existing) return existing;
  const pending = withLock(`browser-${profileId}`, () =>
    launchOrReuse(profileId, options),
  ).catch((error) => {
    handles.delete(profileId);
    throw error;
  });
  handles.set(profileId, pending);
  return pending;
}

export function getBrowserHandle(profileId) {
  return handles.get(profileId);
}

export async function releaseBrowserHandles() {
  const all = [...handles.values()];
  handles.clear();
  for (const pending of all) {
    const handle = await pending.catch(() => null);
    handle?.connection?.close();
  }
}

async function launchOrReuse(profileId, options) {
  const WebSocketImpl = options.WebSocketImpl;
  const state = await loadBrowsers();
  const record = state.browsers[profileId];

  if (record && (await isDevToolsAlive(record))) {
    const connection = await connect(record, WebSocketImpl);
    return { profileId, ...record, connection };
  }
  if (record) await killStale(record);

  const launched = await launchChrome(profileId);
  state.browsers[profileId] = launched;
  await saveBrowsers(state);
  const connection = await connect(launched, WebSocketImpl);
  return { profileId, ...launched, connection };
}

async function connect(record, WebSocketImpl) {
  const url = `ws://127.0.0.1:${record.port}${record.wsPath}`;
  const connection = new CdpConnection({ url, WebSocketImpl });
  await connection.connect();
  return connection;
}

async function isDevToolsAlive(record) {
  if (!record || !Number.isInteger(record.port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Kill a recorded browser only when /proc still shows our own user-data-dir. */
async function killStale(record) {
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline.includes(record.userDataDir)) return;
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already gone, or /proc is unavailable.
  }
}

/**
 * Headless Chrome has no system clipboard on Linux: its ozone platform is
 * `headless`, so Control+V pastes nothing. A real window under an X display
 * does read the X11 selection, which is why `page.keyboard.paste` needs it.
 * ROOK_HEADFUL=1 launches that window; everything else stays headless.
 */
function wantsHeadedChrome() {
  const value = (process.env.ROOK_HEADFUL || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function launchChrome(profileId) {
  const userDataDir = profileDataDir(profileId);
  const headed = wantsHeadedChrome();
  await reapOrphanBrowsers();
  const args = [
    ...(headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1280,800",
    "about:blank",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }
  const child = spawn(chromeBinary(), args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 25000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `Chrome exited during startup (code ${child.exitCode}); binary ${chromeBinary()}`,
      );
    }
    try {
      const raw = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
      const [portLine, pathLine] = raw.trim().split("\n");
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine) {
        const record = {
          pid: child.pid,
          port,
          wsPath: pathLine.trim(),
          userDataDir,
          stateDir: stateDir(),
          startedAt: Date.now(),
          headless: !headed,
        };
        await mkdir(dirname(userDataDir), { recursive: true }).catch(() => {});
        await writeFile(
          join(dirname(userDataDir), "browser.json"),
          `${JSON.stringify(record, null, 2)}\n`,
        ).catch(() => {});
        return record;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    `Chrome did not expose a DevTools port within 25s (${lastError?.code || "no DevToolsActivePort"}): ${chromeBinary()}`,
  );
}

/** Close every browser this state directory owns (used by `ego-browser shutdown`). */
export async function shutdownBrowsers() {
  const state = await loadBrowsers();
  const stopped = [];
  for (const [profileId, record] of Object.entries(state.browsers)) {
    await killStale(record);
    stopped.push(profileId);
  }
  state.browsers = {};
  await saveBrowsers(state);
  await releaseBrowserHandles();
  return stopped;
}

/** A profile with no record is only touched once it is clearly abandoned. */
const PROFILE_ORPHAN_AGE_MS = 5 * 60_000;

/**
 * Remove browsers whose owning state directory is gone. Each browser root keeps
 * a browser.json beside its Chromium profile; a run that deletes its state dir
 * (the E2E suite does) therefore leaves a reaping clue instead of a stray
 * Chromium forever. The profile directory goes with it: its key is derived from
 * the state dir, so once that is deleted no later run can reach it again, and
 * every E2E run would otherwise leave another ~40 MB behind. Fresh records are
 * spared so a concurrent run that has not written its state directory yet is
 * never killed.
 */
async function reapOrphanBrowsers() {
  const prefix = `${browserKey()}-`;
  let entries;
  try {
    entries = await readdir(browsersRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  const inUse = await profilesInUse();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(prefix)) continue;
    const root = join(browsersRoot(), entry.name);
    const record = await readJsonFile(join(root, "browser.json"), null);
    if (record && Number.isInteger(record.pid)) {
      if (Date.now() - (record.startedAt ?? 0) < 60_000) continue;
      if (record.stateDir && existsSync(record.stateDir)) continue;
      await killStale(record);
      await rm(root, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    // No usable record: an older runtime deleted it while leaving the profile,
    // or the write failed. Only reclaim it when no Chrome is using it.
    if (inUse.has(join(root, "chrome"))) continue;
    const info = await stat(join(root, "chrome")).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < PROFILE_ORPHAN_AGE_MS) continue;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** user-data-dirs currently claimed by a running process, from /proc cmdlines. */
async function profilesInUse() {
  const inUse = new Set();
  let pids;
  try {
    pids = await readdir("/proc");
  } catch {
    return inUse;
  }
  await Promise.all(
    pids
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => {
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
          for (const arg of cmdline.split("\0")) {
            if (arg.startsWith("--user-data-dir=")) inUse.add(arg.slice("--user-data-dir=".length));
          }
        } catch {
          // Process exited mid-scan, or /proc is unavailable.
        }
      }),
  );
  return inUse;
}
