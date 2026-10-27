// A private Xvfb, and the pixel poller that timestamps the first painted frame.
//
// :99 is shared with every other QA run on this box, and `import -window` grabs
// a screen rectangle — another app overlapping it lands in the capture. So the
// bench always brings up its own server on the first free display in :95-:120,
// the same range packaging/verify-deb.sh uses.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLLER = join(HERE, "..", "xpoll.py");

// Xvfb comes from PATH unless ROOK_BENCH_XVFB points at a specific binary;
// ROOK_BENCH_XVFB_LIB is only needed for an extracted copy with its own libs.
const XVFB_BIN = process.env.ROOK_BENCH_XVFB || "Xvfb";
const XVFB_LIB = process.env.ROOK_BENCH_XVFB_LIB || "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function xvfbAvailable() {
  if (XVFB_BIN.includes("/")) return existsSync(XVFB_BIN);
  return spawnSync("sh", ["-c", `command -v ${XVFB_BIN}`], { stdio: "ignore" }).status === 0;
}

function displayFree(n) {
  return !existsSync(`/tmp/.X11-unix/X${n}`);
}

/** Start a private Xvfb and return { display, stop() }. */
export async function startXvfb({ width = 1440, height = 900, logPath } = {}) {
  let display = null;
  for (let n = 95; n <= 120; n += 1) {
    if (!displayFree(n)) continue;
    const candidate = `:${n}`;
    const child = spawn(XVFB_BIN, [candidate, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LD_LIBRARY_PATH: `${XVFB_LIB}:${process.env.LD_LIBRARY_PATH ?? ""}` },
    });
    const ready = await new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const tick = () => {
        if (child.exitCode !== null) return resolve(false);
        const probe = spawnSync("xdpyinfo", ["-display", candidate], { stdio: "ignore" });
        if (probe.status === 0) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    if (ready) {
      display = candidate;
      return {
        display,
        pid: child.pid,
        async stop() {
          child.kill("SIGTERM");
          await sleep(120);
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    }
    child.kill("SIGKILL");
  }
  throw new Error(`no free X display in :95-:120 (log: ${logPath ?? "none"})`);
}

/**
 * Poll `display` until the fixture's marker colour is on screen.
 *
 * Returns { ready, first, marker, samples, done } where the timestamps are
 * CLOCK_MONOTONIC nanoseconds — the same clock as process.hrtime.bigint(), so
 * the caller subtracts its own spawn time.
 */
export function startPoller(display, { timeout = 25, step = 8 } = {}) {
  const child = spawn("python3", [POLLER, display, "--timeout", String(timeout), "--step", String(step)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = { ready: null, first: null, marker: null, samples: null, timeout: null };
  let buffer = "";
  let stderr = "";
  child.stdin?.end();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      const [name, value] = line.split(/\s+/);
      if (name === "READY") events.ready = Number(value);
      else if (name === "FIRST") events.first = Number(value);
      else if (name === "MARKER") events.marker = Number(value);
      else if (name === "SAMPLES") events.samples = Number(value);
      else if (name === "TIMEOUT") events.timeout = Number(value);
      else if (name === "ERROR") stderr += `${line}\n`;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise((resolve) => {
    child.on("exit", () => resolve({ ...events, stderr }));
  });
  return {
    events,
    exited,
    stop() {
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
