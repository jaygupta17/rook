// Reading the app's cost straight out of /proc.
//
// Everything the bench reports about memory and CPU comes from here, because a
// Chromium app is a process tree, not a process: the host, the zygote, the
// renderer per space, the network/GPU/utility services. Summing only the parent
// would understate the app by about 80%.
//
// Two numbers, deliberately:
//   Rss — what the architecture document's budget talks about ("≤ 250 MB RSS
//         total"). It double counts pages shared between processes (libcef.so is
//         ~330 MB of mapped file), so it is the pessimistic number.
//   Pss — the proportional share of those same pages, which is what a memory
//         dashboard would show. Reported alongside so the delta is visible.
import { readFileSync, readdirSync, statSync } from "node:fs";

// /proc/<pid>/stat times are in USER_HZ. Linux/x86_64 pins this at 100; the
// harness asserts it against `getconf CLK_TCK` in run.sh rather than trusting it.
export const CLK_TCK = 100;

function readStat(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // comm is parenthesised and may itself contain spaces or parens, so the
  // fields are only reliable after the *last* ')'.
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const comm = raw.slice(raw.indexOf("(") + 1, close);
  const f = raw.slice(close + 2).split(" ");
  return {
    pid: Number(pid),
    comm,
    state: f[0],
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    threads: Number(f[17]),
  };
}

export function allStats() {
  const out = new Map();
  for (const name of readdirSync("/proc")) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    const stat = readStat(name);
    if (stat) out.set(stat.pid, stat);
  }
  return out;
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

// What a process's own command line can prove about it.
//
// Renderers are forked from the zygote and never re-exec, so they keep the
// zygote's argv: on this build every forked child — renderers included — shows
// `--type=zygote` in /proc/<pid>/cmdline and cannot be told apart from the
// zygote itself. Reporting them as "renderer" would be a guess, so they are
// grouped under the one thing the command line does prove.
function roleOf(cmd) {
  const match = /--type=([a-z-]+)/.exec(cmd);
  if (!match) return "browser";
  const type = match[1];
  if (type === "gpu-process") return "gpu";
  if (type === "renderer") return "renderer (own process)";
  if (type === "utility") {
    const sub = /--utility-sub-type=([a-zA-Z0-9_.]+)/.exec(cmd);
    return sub ? `utility:${sub[1].split(".")[0]}` : "utility";
  }
  if (type === "zygote") return "cef child (zygote fork)";
  return type;
}

function smaps(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const rss = /^Rss:\s+(\d+) kB/m.exec(raw);
    const pss = /^Pss:\s+(\d+) kB/m.exec(raw);
    return { rssKb: rss ? Number(rss[1]) : 0, pssKb: pss ? Number(pss[1]) : 0 };
  } catch {
    return null;
  }
}

/**
 * Every process belonging to `rootPid`: the pid subtree, plus anything whose
 * command line carries this run's unique `token` (a per-run temp path). The
 * token pass is a safety net for a helper that outlived its parent; the tree
 * pass is what normally finds everything.
 */
export function tree(rootPid, token) {
  const stats = allStats();
  const members = new Set();
  if (stats.has(rootPid)) members.add(rootPid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, stat] of stats) {
      if (members.has(pid)) continue;
      if (members.has(stat.ppid)) {
        members.add(pid);
        grew = true;
      }
    }
  }
  if (token) {
    for (const [pid, stat] of stats) {
      if (members.has(pid)) continue;
      if (stat.comm !== "rook" && stat.comm !== "node" && !stat.comm.startsWith("rook")) continue;
      if (cmdline(pid).includes(token)) {
        members.add(pid);
        grew = true;
      }
    }
  }
  return { stats, members };
}

/**
 * One sample: memory and CPU for the whole tree.
 * `cpu` is cumulative (it is a counter — take two samples and subtract).
 */
export function sample(rootPid, token) {
  const { stats, members } = tree(rootPid, token);
  const detail = [];
  let rssKb = 0;
  let pssKb = 0;
  let utime = 0;
  let stime = 0;
  let unavailable = 0;
  for (const pid of members) {
    const stat = stats.get(pid);
    if (!stat || stat.state === "Z") continue;
    const mem = smaps(pid);
    if (mem === null) {
      unavailable += 1;
      continue;
    }
    const cmd = cmdline(pid);
    detail.push({ pid, comm: stat.comm, role: roleOf(cmd), rssKb: mem.rssKb, pssKb: mem.pssKb });
    rssKb += mem.rssKb;
    pssKb += mem.pssKb;
    utime += stat.utime;
    stime += stat.stime;
  }
  return {
    pids: detail.length,
    unavailable,
    rssKb,
    pssKb,
    cpuSeconds: (utime + stime) / CLK_TCK,
    userSeconds: utime / CLK_TCK,
    systemSeconds: stime / CLK_TCK,
    detail: detail.sort((a, b) => b.rssKb - a.rssKb),
  };
}

/** Roll a sample up per process role, biggest first. */
export function byRole(sampled) {
  const out = new Map();
  for (const proc of sampled.detail) {
    const key = proc.role;
    const entry = out.get(key) ?? { role: key, procs: 0, rssKb: 0, pssKb: 0 };
    entry.procs += 1;
    entry.rssKb += proc.rssKb;
    entry.pssKb += proc.pssKb;
    out.set(key, entry);
  }
  return [...out.values()].sort((a, b) => b.rssKb - a.rssKb);
}

export function fileExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
