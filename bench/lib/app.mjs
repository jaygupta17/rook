// Launching the packaged app and timestamping its startup log.
//
// The app prints its startup log with no timestamps, so the launcher stamps
// every line with process.hrtime.bigint() the moment it arrives from the pipe.
// That is CLOCK_MONOTONIC, the same clock the X poller uses, which is what makes
// "exec -> first paint" a subtraction instead of a guess.
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function launchApp({
  appBin,
  display,
  dataHome,
  runtimeDir,
  socketPath = null,
  spaces = [],
  windowSize = "1280x820",
  extraArgs = [],
  extraEnv = {},
}) {
  const args = [];
  if (socketPath) args.push("--socket-path", socketPath);
  else args.push("--no-control-socket");
  args.push("--window-size", windowSize);
  for (const space of spaces) args.push("--space", space);
  args.push(...extraArgs);

  const env = {
    ...process.env,
    DISPLAY: display,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: runtimeDir,
    ...extraEnv,
  };
  // A stale DBUS_SESSION_BUS_ADDRESS makes every CEF child log a failure and
  // spend time retrying; a normal desktop has a working bus, so the bench pins
  // the same "no bus" state for every app it measures instead of inheriting
  // whatever the calling shell happened to have.
  if (!process.env.ROOK_BENCH_KEEP_DBUS) delete env.DBUS_SESSION_BUS_ADDRESS;

  const startedAt = process.hrtime.bigint();
  const child = spawn(appBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });

  const lines = [];
  const waiters = [];
  let pending = "";
  let stderrTail = "";

  const absorb = (chunk, stream) => {
    if (stream === "stderr") {
      stderrTail = (stderrTail + chunk).slice(-8000);
    }
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const text = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const line = { t: process.hrtime.bigint(), text, stream };
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].match.test(text)) {
          const [waiter] = waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        }
      }
    }
  };

  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => absorb(chunk, "stderr"));
  child.stdout.on("data", (chunk) => absorb(chunk, "stdout"));

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  /** Resolve with the first line matching `pattern` (string or RegExp). */
  const waitForLine = (pattern, timeoutMs = 20000, from = 0) => {
    const match = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    for (let i = from; i < lines.length; i += 1) {
      if (match.test(lines[i].text)) return Promise.resolve(lines[i]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${match} (${timeoutMs} ms); last output:\n${stderrTail.slice(-1500)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  const kill = async (graceMs = 4000) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const died = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
    if (!died && child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(2000)]);
    }
  };

  return {
    child,
    pid: child.pid,
    startedAt,
    lines,
    exited,
    waitForLine,
    kill,
    stderrTail: () => stderrTail,
  };
}

/** ms between the spawn and a log line. */
export function msSince(startedAt, stamp) {
  return Number(stamp - startedAt) / 1e6;
}
