#!/usr/bin/env node
/**
 * results.json -> report.md + report.html.
 *
 * The numbers come from bench.mjs; nothing here measures anything or rounds a
 * failure into a pass. Every verdict is `measured median <= target`, printed next
 * to the number it came from. Rows with no target (budget was not written for
 * them) are reported as context and never graded.
 *
 * `previous/*.json` holds older passes; where a metric is comparable, the report
 * prints the old number next to the new one so a fix can be seen to have worked
 * (or not) instead of being asserted.
 *
 *   bench/report.mjs            # after bench.mjs (or bench/run.sh --report)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: results.json beside this script, reports written next to it. The
// optional overrides exist so the generator can be exercised on its own.
const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const INPUT = valueOf("--in") ?? join(HERE, "results.json");
const OUT = valueOf("--out") ?? HERE;
const results = JSON.parse(readFileSync(INPUT, "utf8"));
const { metrics, baselines, host, package: pkg, raw, config } = results;

const fmt = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
const medianOf = (values) => {
  const clean = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return NaN;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
};
/** Phase medians straight from the raw runs, so the report never depends on a
 *  summary shape that a future bench may not write. */
const roundRuns = () => raw?.round?.runs ?? [];
const digitsFor = (unit) => (unit === "%" ? 2 : unit === "MB" ? 0 : 1);

function measured(row) {
  const sum = row.summary;
  if (!sum || !sum.n) return "—";
  const digits = digitsFor(row.unit);
  if (sum.n === 1) return `${fmt(sum.median, digits)} ${row.unit} (one figure, no spread)`;
  return `${fmt(sum.median, digits)} ${row.unit} ± ${fmt(sum.spread, digits)} (${fmt(sum.min, digits)}..${fmt(sum.max, digits)})`;
}

// --- previous passes -------------------------------------------------------
const previousDir = join(HERE, "previous");
const previous = [];
if (existsSync(previousDir)) {
  for (const name of readdirSync(previousDir).filter((n) => n.endsWith(".json")).sort()) {
    const file = JSON.parse(readFileSync(join(previousDir, name), "utf8"));
    previous.push({ label: file.package?.version ?? name.replace(".json", ""), file });
  }
}
const previousMetric = (id, label = id) => {
  for (const entry of previous) {
    const found = entry.file.metrics?.find((row) => row.id === id);
    if (found && Number.isFinite(found.summary?.median)) {
      return { value: found.summary.median, unit: found.unit, label: entry.label };
    }
  }
  return null;
};
/** The 0.3.0 per-space figure was summed RSS over 4-vs-1; keep the comparison like for like. */
const previousPerSpaceRss = (() => {
  const found = previousMetric("space-margin");
  if (!found) return null;
  const now = results.derived?.marginalPerSpaceRss?.median;
  return { ...found, now };
})();

const graded = metrics.filter((row) => row.pass !== null);
const met = graded.filter((row) => row.pass).length;
const failed = graded.filter((row) => !row.pass);
const contextRows = metrics.filter((row) => row.pass === null);
const minutes = Math.round((results.durationSeconds ?? 0) / 60);

const IMPROVED = {
  "cold-start": "0.4.0 fixes the at-spi stall that could keep the first page blank for ~16 s",
  "snapshot-p50": "0.4.0's serializer: scope header, no duplicated url=, no label-echo children, no empty generic wrappers",
  "snapshot-p95": "the same serializer change",
  "snapshot-p50-full": "the same serializer change (full page shrank from ~551k to ~330k chars on a Wikipedia page)",
  "snapshot-p95-full": "the same serializer change",
  "space-margin-2": "profiles are the isolation boundary now, so spaces in one profile are tab sets, not separate browser contexts",
  "space-margin-4": "the same model change",
  "idle-pss": "0.4.0 reports memory as PSS instead of summing RSS over 10 processes",
};

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
function markdown() {
  const lines = [];
  lines.push("# Performance budget — measured");
  lines.push("");
  lines.push(
    `Run ${results.generatedAt}, on ${host.cores} cores (${host.model ?? "unknown CPU"}), ` +
      `${(host.memBytes / 1024 ** 3).toFixed(1)} GiB RAM, kernel ${host.kernel}, load ` +
      `${host.loadavg.map((v) => v.toFixed(2)).join(" ")}. Package ` +
      `\`${pkg?.deb?.split("/").pop() ?? "?"}\` (${pkg?.version ?? "?"}), unpacked with ` +
      `\`dpkg-deb -x\` and run from a private Xvfb. The budget is \`ego-lite-linux-architecture.md\` §6.`,
  );
  lines.push("");
  lines.push(
    `**${met} of ${graded.length} budgets met**` +
      `${failed.length ? `; over budget on ${failed.map((row) => `\`${row.label}\``).join(", ")}` : ""}. ` +
      `${contextRows.length} rows are context: no budget was ever written for them.`,
  );
  lines.push("");
  lines.push("| Metric | Target | Measured (median ± spread) | Verdict | Method |");
  lines.push("|---|---|---|---|---|");
  for (const row of metrics) {
    const target = row.target === null ? "—" : `${row.better === "lower" ? "≤" : "≥"} ${row.target} ${row.unit}`;
    const verdict = row.pass === null ? "context" : row.pass ? "**pass**" : "**FAIL**";
    lines.push(`| ${row.label} | ${target} | ${measured(row)} | ${verdict} | ${row.method} |`);
  }
  lines.push("");
  lines.push(
    "Every row is three runs unless the method says otherwise; `spread` is `max − min` across them. " +
      "PSS is the proportional share of shared pages; summed RSS counts shared pages once per process.",
  );
  lines.push("");

  const discarded = results.discards ?? [];
  if (discarded.length) {
    lines.push(
      `**Reliability:** ${discarded.length} run(s) were discarded because the app did not survive them ` +
        `(${[...new Set(discarded.map((entry) => entry.error))].join("; ")}). Each was retried; every discard is ` +
        `listed under \`discards\` in results.json.`,
    );
    lines.push("");
  }

  lines.push("## What this means");
  lines.push("");
  const cold = metrics.find((row) => row.id === "cold-start");
  const pss = metrics.find((row) => row.id === "idle-pss");
  const rssSum = metrics.find((row) => row.id === "idle-rss");
  const space2 = metrics.find((row) => row.id === "space-margin-2");
  const space4 = metrics.find((row) => row.id === "space-margin-4");
  const profile = metrics.find((row) => row.id === "profile-margin");
  const cpu = metrics.find((row) => row.id === "cpu-idle");
  const snap50 = metrics.find((row) => row.id === "snapshot-p50");
  const snap95 = metrics.find((row) => row.id === "snapshot-p95");
  const round = metrics.find((row) => row.id === "agent-round");
  const size = metrics.find((row) => row.id === "install-size");

  lines.push(
    `Starting the app takes ${fmt(cold.summary.median, 0)} ms from exec to a painted page ` +
      `(${cold.pass ? "inside" : "over"} the 1.5 s budget; plain headless Chrome needs ` +
      `${fmt(baselines[1].summary.median, 0)} ms to produce a frame). Idle with one tab it holds ` +
      `${fmt(pss.summary.median, 0)} MiB of PSS — ${pss.pass ? "inside" : `${fmt(pss.summary.median / 250, 1)}× over`} the ` +
      `250 MiB budget — which is ${fmt(rssSum.summary.median, 0)} MiB if you add up every process's RSS instead, ` +
      `and ${fmt(baselines[0].summary.median, 0)} MiB for plain headless Chrome on the same box. ` +
      `Concurrency is cheap: a second space adds ${fmt(space2.summary.median, 0)} MiB, a third and fourth ` +
      `${fmt(space4.summary.median, 0)} MiB each, and a whole second *profile* — a separate browser context, which is ` +
      `the isolation boundary — adds ${fmt(profile.summary.median, 0)} MiB. What costs is the first browser, before ` +
      `any agent does anything. CPU idle is ${fmt(cpu.summary.median, 2)} % of one core. ` +
      `Snapshots come in at ${fmt(snap50.summary.median, 0)} ms p50 viewport ` +
      `(${snap50.pass ? "inside" : "over"} the 40 ms budget) and ${fmt(snap95.summary.median, 0)} ms p95 on the ` +
      `dashboard (${snap95.pass ? "inside" : "over"} 150 ms); a whole agent round — create a space, open a page, ` +
      `snapshot it, click a button, type into a field — takes ${fmt(round.summary.median, 0)} ms, of which ` +
      `${fmt(medianOf(roundRuns().map((run) => run.cliStartupMs)), 0)} ms is the command-line tool starting up. ` +
      `The package is ${fmt(size.summary.median, 0)} MB installed, ${size.pass ? "inside" : "over"} 450 MB.`,
  );
  lines.push("");

  const borderline = graded.filter(
    (row) =>
      Number.isFinite(row.summary?.median) &&
      row.summary.n > 1 &&
      Math.abs(row.summary.median - row.target) / row.target <= 0.1,
  );
  if (borderline.length) {
    lines.push(
      `**Borderline:** ${borderline
        .map((row) => `${row.label} at ${fmt(row.summary.median, digitsFor(row.unit))} ${row.unit} against ${row.target} ${row.unit}`)
        .join("; ")}. Within 10 % of the budget, so treat those verdicts as coin flips between passes.`,
    );
    lines.push("");
  }

  lines.push("## What the 0.4.0 fixes changed");
  lines.push("");
  lines.push(
    "Targets are the old §6 numbers, which were guesses written before anything was measured; they have not " +
      "been moved. What changed is the build, and the bench: the rows below are the ones a 0.4.0 change should " +
      "move, with the 0.3.0 number beside them where the two are comparable.",
  );
  lines.push("");
  const rssSumNow = metrics.find((row) => row.id === "idle-rss").summary.median;
  const comparisons = [
    {
      label: "Cold start to first paint",
      unit: "ms",
      before: previousMetric("cold-start"),
      now: cold.summary.median,
      why: IMPROVED["cold-start"],
    },
    {
      label: "Memory, one tab (summed RSS — the old row's units)",
      unit: "MiB",
      before: previousMetric("idle-rss"),
      now: rssSumNow,
      why: "the build did not get smaller; this row only measures the same way the old one did",
    },
    {
      label: "Per-space cost, 4-vs-1 (summed RSS, the old row's units)",
      unit: "MiB",
      before: previousMetric("space-margin"),
      now: results.derived?.marginalPerSpaceRss?.median,
      why: IMPROVED["space-margin-4"],
    },
    {
      label: "Snapshot p50, viewport (long list)",
      unit: "ms",
      before: previousMetric("snapshot-p50"),
      now: snap50.summary.median,
      why: IMPROVED["snapshot-p50"],
    },
    {
      label: "Snapshot p95, viewport (dashboard)",
      unit: "ms",
      before: previousMetric("snapshot-p95"),
      now: snap95.summary.median,
      why: IMPROVED["snapshot-p95"],
    },
    {
      label: "Installed size",
      unit: "MB",
      before: previousMetric("install-size"),
      now: size.summary.median,
      why: "",
    },
  ];
  lines.push("| Metric | 0.3.0~m3 | 0.4.0 | Change | Why |");
  lines.push("|---|---|---|---|---|");
  for (const entry of comparisons) {
    const digits = digitsFor(entry.unit);
    let change = "—";
    if (entry.before && Number.isFinite(entry.before.value) && Number.isFinite(entry.now)) {
      const delta = entry.now - entry.before.value;
      const pct = entry.before.value === 0 ? NaN : (delta / entry.before.value) * 100;
      change = `${delta > 0 ? "+" : ""}${fmt(delta, digits)} ${entry.unit} (${delta > 0 ? "+" : ""}${fmt(pct, 0)} %)`;
    }
    lines.push(
      `| ${entry.label} | ${entry.before ? `${fmt(entry.before.value, digits)} ${entry.unit}` : "—"} | ` +
        `${fmt(entry.now, digits)} ${entry.unit} | ${change} | ${entry.why} |`,
    );
  }
  lines.push("");
  lines.push(
    "**The team's 1.31 s cold-start figure and this one are different intervals, not a disagreement.** " +
      "That measurement times a whole `--screenshot` run — spawn to a written PNG to exit — and that path carries " +
      "a fixed 900 ms settle (`host/src/shell.cc:3626`) before it captures. This bench stops at the first painted " +
      "frame: 662 ms is the same launch minus the settle, the capture and the shutdown. Neither number is wrong; " +
      "they answer different questions.",
  );
  lines.push("");
  lines.push(
    "**Read the change column with the load in mind.** The two passes ran on different days. This pass started at " +
      `load ${host.loadavg.map((v) => v.toFixed(2)).join(" ")} and the 0.3.0 pass at 0.13–1.0, but what matters is ` +
      "what else was running while the numbers were taken: the same 0.4.0 build measured 286–321 ms of cold start " +
      "in a smoke run minutes earlier on an idle box, and 518–786 ms during this pass. The baseline agrees that the " +
      "box was slower: plain headless Chrome's own cold start went from 329 ms to 462 ms (+40 %) between the two " +
      "passes, and nothing in either build changes Chrome. So the cold-start and snapshot deltas above are not " +
      "attributable to 0.4.0 — a same-box A/B of the two packages back to back is the only way to get that, and " +
      "this bench has not done it.",
  );
  lines.push("");
  lines.push(
    "The per-space row is a different kind of change: a *model* change, not a speed-up. 0.3.0 gave every space its " +
      "own browser context, so a space and a renderer were the same thing, and the figure was summed RSS on top of " +
      "that (130 MiB, reproduced exactly: a like-for-like repeat of the same calculation now gives " +
      `${fmt(results.derived?.marginalPerSpaceRss?.median, 0)} MiB). In 0.4.0 a space is a tab set inside one ` +
      `profile, so the honest per-space number is the PSS row above (${fmt(space4.summary.median, 0)} MiB for the ` +
      `third and fourth), and crossing a profile costs ${fmt(profile.summary.median, 0)} MiB.`,
  );
  lines.push("");

  // ---- what the agent gets back ----
  const nowPages = Array.isArray(raw?.snapshots) ? raw.snapshots : (raw?.snapshots?.pages ?? []);
  const oldPages = (() => {
    const entry = previous[0];
    const pages = entry?.file?.raw?.snapshots?.pages ?? entry?.file?.raw?.snapshots;
    return Array.isArray(pages) ? pages : [];
  })();
  if (nowPages.length) {
    lines.push("### What the agent actually gets back");
    lines.push("");
    lines.push(
      "Timing is load-sensitive and moved by more than either build did on this box; the size of the answer is not. " +
        "Same pages, same scope, two builds:",
    );
    lines.push("");
    lines.push("| Page class | 0.3.0, viewport (lines) | 0.4.0, viewport (lines / refs) | 0.4.0, full page (lines / refs) |");
    lines.push("|---|---|---|---|");
    for (const page of nowPages) {
      const before = oldPages.find((candidate) => candidate.id === page.id);
      const viewport = page.viewportScope ? `${page.viewportScope.lines} / ${page.viewportScope.refs}` : "—";
      const full = page.fullScope ? `${page.fullScope.lines} / ${page.fullScope.refs}` : "—";
      lines.push(
        `| ${page.label} | ${before?.snapshotLines ?? "—"} | ${viewport} | ${full} |`,
      );
    }
    lines.push("");
    lines.push(
      "0.3.0's default snapshot of the long list came back nearly the size of the whole page (2,170 lines); 0.4.0 " +
        "returns the 183 lines that fit the viewport, and the dashboard drops from 5,794 lines to 133. That is the " +
        "serializer fix measured in something the box's load cannot distort — and it is why the timing rows do " +
        "not move much: the expensive part is reading the accessibility tree for the whole document, not writing " +
        "the answer down.",
    );
    lines.push("");
  }

  // ---- memory ----
  const roles = raw?.idle?.oneTab?.[0]?.roles ?? [];
  if (roles.length) {
    lines.push("## Where the memory goes (one tab, idle)");
    lines.push("");
    lines.push(
      "Two ways of counting the same ten processes. PSS splits a page between the processes mapping it; summed " +
        "RSS counts it once per process, and every one of them maps the same 277 MB `libcef.so`. The gap between " +
        "the two columns is not memory the app can give back — it is the same bytes counted again.",
    );
    lines.push("");
    lines.push("| Process | Count | PSS | Summed RSS |");
    lines.push("|---|---|---|---|");
    for (const role of roles) {
      lines.push(
        `| ${role.role} | ${role.procs} | ${fmt(role.pssKb / 1024, 0)} MiB | ${fmt(role.rssKb / 1024, 0)} MiB |`,
      );
    }
    lines.push(
      `| **total** | ${roles.reduce((n, role) => n + role.procs, 0)} | **${fmt(pss.summary.median, 0)} MiB** | ` +
        `**${fmt(rssSum.summary.median, 0)} MiB** |`,
    );
    lines.push("");
  }

  const memRows = [
    ["1 space", raw?.idle?.oneTab],
    ["2 spaces, same profile", raw?.idle?.twoSpaces],
    ["4 spaces, same profile", raw?.idle?.fourSpaces],
    ["1 space + 1 space in a second profile", raw?.idle?.secondProfile],
    ["4 spaces awake (not parked)", raw?.idle?.fourAwake],
  ].filter(([, runs]) => Array.isArray(runs) && runs.length);
  if (memRows.length) {
    lines.push("| Configuration | PSS | Summed RSS | Processes |");
    lines.push("|---|---|---|---|");
    for (const [label, runs] of memRows) {
      const avg = (key) => runs.reduce((total, run) => total + run[key] / 1024, 0) / runs.length;
      const avgCount = (key) => runs.reduce((total, run) => total + run[key], 0) / runs.length;
      lines.push(
        `| ${label} | ${fmt(avg("pssKb"), 0)} MiB | ${fmt(avg("rssKb"), 0)} MiB | ${fmt(avgCount("pids"), 0)} |`,
      );
    }
    lines.push("");
    lines.push(
      `A second space in one profile adds ${fmt(space2.summary.median, 0)} MiB of PSS and the next two add ` +
        `${fmt(space4.summary.median, 0)} MiB each — one more renderer each, and a renderer that mostly maps the ` +
        `same shared ` + "`libcef.so`" + `. A second *profile* adds ${fmt(profile.summary.median, 0)} MiB: a new ` +
        `\`CefRequestContext\` with its own renderer and cache is, at idle, about as expensive as one more space. ` +
        `The isolation boundary is therefore close to free in memory — what costs 355 MiB is the first browser, ` +
        `before any agent does anything.`,
    );
    lines.push("");
  }

  // ---- snapshot per page class ----
  const perPage = snap50.detail?.perPage ?? [];
  if (perPage.length) {
    lines.push("## Snapshot, per page class");
    lines.push("");
    lines.push(
      "Viewport is the default scope and what the budget is written for; full page is the same call with " +
        "`{scope:\"full_page\"}`. The snapshot's first line now says which one it returned and how big it was.",
    );
    lines.push("");
    lines.push("| Page class | Elements | Viewport p50 | Viewport p95 | Full page p50 | Full page p95 | Scope header (viewport) |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const page of perPage) {
      lines.push(
        `| ${page.label} | ${page.nodes} | ${fmt(page.p50, 0)} ms | ${fmt(page.p95, 0)} ms | ` +
          `${fmt(page.fullP50, 0)} ms | ${fmt(page.fullP95, 0)} ms | \`${page.viewportScope ? `${page.viewportScope.lines} lines, ${page.viewportScope.refs} refs` : "—"}\` |`,
      );
    }
    lines.push("");
  }

  // ---- agent round ----
  const phase = (name) => round.detail?.phases?.[name];
  if (round) {
    lines.push("## The agent round");
    lines.push("");
    lines.push(
      "One `ego-browser nodejs` invocation that does what an agent actually does on a page: create a space, open " +
        "the local sign-in form, snapshot it, click \"Forgot password?\", click the email field, type 15 " +
        "characters, finish. Timed from spawn to exit, with every phase stamped on the same clock.",
    );
    lines.push("");
    lines.push("| Phase | Median | Share of the round |");
    lines.push("|---|---|---|");
    const total = round.summary.median;
    const runs = roundRuns();
    const phases = [
      ["CLI startup (node + SDK, before the first statement)", medianOf(runs.map((run) => run.cliStartupMs))],
      ["create space (taskSpace)", medianOf(runs.map((run) => run.phases?.taskSpace))],
      ["open the page (goto + load)", medianOf(runs.map((run) => run.phases?.goto))],
      ["snapshot (viewport)", medianOf(runs.map((run) => run.phases?.snapshot))],
      ["click (resolve a ref, dispatch)", medianOf(runs.map((run) => run.phases?.click))],
      ["type 15 characters", medianOf(runs.map((run) => run.phases?.type))],
      ["teardown (finish + exit)", medianOf(runs.map((run) => run.teardownMs))],
    ];
    for (const [label, value] of phases) {
      if (!Number.isFinite(value)) continue;
      lines.push(`| ${label} | ${fmt(value, 0)} ms | ${fmt((value / total) * 100, 0)} % |`);
    }
    lines.push(`| **total** | **${fmt(total, 0)} ms** | 100 % |`);
    lines.push("");
    lines.push(
      "Each phase is its own median, so the shares add up to slightly more than 100 %: medians are not additive. " +
        "The stacked bar in `report.html` uses one real run instead, so its slices do add up.",
    );
    lines.push("");
    lines.push(
      `The browser work is ${fmt(medianOf(roundRuns().map((run) => run.browserMs)), 0)} ms of that; the rest is the ` +
        `command-line tool starting up and shutting down, which an agent pays on every invocation that is not kept open.`,
    );
    lines.push("");
  }

  // ---- baseline ----
  lines.push("## Baseline, for context");
  lines.push("");
  lines.push("| Baseline | Measured | Method |");
  lines.push("|---|---|---|");
  for (const row of baselines) {
    lines.push(`| ${row.label} | ${measured(row)} | ${row.method} |`);
  }
  lines.push("");
  lines.push(
    `Chrome's summed RSS with one page is ${fmt(baselines[0].extra?.rss?.median, 0)} MiB against ` +
      `${fmt(baselines[0].summary.median, 0)} MiB of PSS — the same shared-page effect.`,
  );
  lines.push("");

  // ---- costs ----
  const bigCosts = contributors();
  if (bigCosts.length) {
    lines.push("## Three biggest remaining costs");
    lines.push("");
    bigCosts.forEach((entry, index) => {
      lines.push(`${index + 1}. **${entry.title}** — ${entry.detail}`);
    });
    lines.push("");
  }

  lines.push("## How it was measured");
  lines.push("");
  for (const row of metrics) {
    lines.push(`- **${row.label}** — ${row.method}`);
  }
  lines.push("");
  lines.push(
    `Fixture pages are generated locally and served from 127.0.0.1; no page in this bench touches the network. ` +
      `Each measured run gets its own Xvfb (never \`:99\`, which other QA runs on this box share) and its own ` +
      `profile directory. Node ${host.node}, ${host.chrome}.`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// HTML: one chart per metric, target line marked, dark, self-contained
// ---------------------------------------------------------------------------
const esc = (value) =>
  String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

const COLOURS = {
  pass: "#34d399",
  fail: "#f87171",
  context: "#60a5fa",
  target: "#fbbf24",
  ink: "#a9b4c8",
  faint: "#2a3242",
};

function niceScale(max) {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (max <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * One metric: a measured bar with a min..max whisker, a dashed target line when
 * a target exists, and the numbers printed under it. Plain words on the axis.
 */
function chart(row, { width = 780, height = 116 } = {}) {
  const sum = row.summary;
  const target = row.target;
  const top = Math.max(sum.max, target ?? 0) * 1.18;
  const scale = niceScale(top);
  const left = 8;
  const right = width - 8;
  const plotWidth = right - left;
  const mid = 44;
  const x = (value) => left + (Math.min(value, scale) / scale) * plotWidth;
  const colour = row.pass === null ? COLOURS.context : row.pass ? COLOURS.pass : COLOURS.fail;
  const digits = digitsFor(row.unit);

  const ticks = [];
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const value = (scale / steps) * i;
    ticks.push(
      `<line x1="${x(value).toFixed(1)}" y1="${mid - 12}" x2="${x(value).toFixed(1)}" y2="${mid + 16}" stroke="${COLOURS.faint}"/>` +
        `<text x="${x(value).toFixed(1)}" y="${mid + 30}" fill="${COLOURS.ink}" font-size="10" text-anchor="middle">${fmt(value, scale >= 100 ? 0 : 1)}</text>`,
    );
  }
  // The target caption lives under the axis so it cannot collide with the
  // measured value above it; clamped so it never runs off either edge.
  const targetX = target === null ? 0 : Math.min(Math.max(x(target), left + 34), right - 34);

  return `
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
     aria-label="${esc(row.label)}: measured ${fmt(sum.median, digits)} ${row.unit}${target === null ? ", no target" : `, target ${target} ${row.unit}`}">
  ${ticks.join("\n  ")}
  <rect x="${left}" y="${mid - 15}" width="${Math.max(0, x(sum.median) - left).toFixed(1)}" height="22" rx="4"
        fill="${colour}" fill-opacity="0.30"/>
  <line x1="${x(sum.min).toFixed(1)}" y1="${mid - 4}" x2="${x(sum.max).toFixed(1)}" y2="${mid - 4}"
        stroke="${colour}" stroke-width="2" stroke-opacity="0.75"/>
  <line x1="${x(sum.min).toFixed(1)}" y1="${mid - 10}" x2="${x(sum.min).toFixed(1)}" y2="${mid + 2}"
        stroke="${colour}" stroke-width="2" stroke-opacity="0.75"/>
  <line x1="${x(sum.max).toFixed(1)}" y1="${mid - 10}" x2="${x(sum.max).toFixed(1)}" y2="${mid + 2}"
        stroke="${colour}" stroke-width="2" stroke-opacity="0.75"/>
  <circle cx="${x(sum.median).toFixed(1)}" cy="${mid - 4}" r="5" fill="${colour}"/>
  ${
    target === null
      ? `<text x="${right}" y="${mid + 48}" fill="${COLOURS.ink}" font-size="10.5" text-anchor="end">no budget for this row</text>`
      : `<line x1="${x(target).toFixed(1)}" y1="${mid - 26}" x2="${x(target).toFixed(1)}" y2="${mid + 18}"
        stroke="${COLOURS.target}" stroke-width="1.6" stroke-dasharray="4 3"/>
  <text x="${targetX.toFixed(1)}" y="${mid + 48}" fill="${COLOURS.target}" font-size="10.5"
        text-anchor="middle">target ${target} ${row.unit}</text>`
  }
  <text x="${left}" y="16" fill="${colour}" font-size="12.5" font-weight="600">
    ${fmt(sum.median, digits)} ${row.unit}
  </text>
  ${
    sum.n > 1
      ? `<text x="${left + 92}" y="16" fill="${COLOURS.ink}" font-size="11.5">
    runs ${fmt(sum.min, digits)}..${fmt(sum.max, digits)} ${row.unit}
  </text>`
      : ""
  }
</svg>`;
}

// Only rows whose units are the same across builds get a "was X" note: the
// per-space row changed meaning (RSS per renderer -> PSS per tab), and mixing
// those two would read as a 100 MiB improvement that never happened.
const COMPARABLE = new Set(["cold-start", "idle-rss", "snapshot-p50", "snapshot-p95", "install-size"]);

function previousNote(row) {
  if (!COMPARABLE.has(row.id)) return "";
  const before = previousMetric(row.id);
  if (!before) return "";
  const digits = digitsFor(row.unit);
  const delta = row.summary.median - before.value;
  const timing = row.unit === "ms";
  const context = timing
    ? " Different build, and the box was busier during this pass — see the load caveat in report.md before reading a change into it."
    : " Different build.";
  return `<p class="note">Was ${fmt(before.value, digits)} ${row.unit} on ${esc(before.label)};
     now ${fmt(row.summary.median, digits)} ${row.unit} (${delta < 0 ? "−" : "+"}${fmt(Math.abs(delta), digits)} ${row.unit}).${context}</p>`;
}

function card(row) {
  const verdict =
    row.pass === null ? "context" : row.pass ? "inside budget" : "over budget";
  const pillClass = row.pass === null ? "context" : row.pass ? "pass" : "fail";
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>${esc(row.plain)}</h2>
      <p class="sub">${esc(row.label)}</p>
    </div>
    <span class="pill ${pillClass}">${verdict}</span>
  </div>
  ${chart(row)}
  ${previousNote(row)}
  <details><summary>How this was measured</summary><p>${esc(row.method)}</p></details>
</section>`;
}

/**
 * The three biggest remaining costs, derived here rather than baked into
 * results.json: the prose can be corrected without measuring again, and there is
 * one place where "biggest" is defined.
 */
function contributors() {
  const metric = (id) => metrics.find((row) => row.id === id);
  const pss = metric("idle-pss");
  const rss = metric("idle-rss");
  const profile = metric("profile-margin");
  const space4 = metric("space-margin-4");
  const snap50 = metric("snapshot-p50");
  const round = metric("agent-round");
  const pageList = Array.isArray(raw?.snapshots) ? raw.snapshots : (raw?.snapshots?.pages ?? []);
  const listPage = pageList.find((page) => page.id === "long-list");
  const heavyPage = pageList.find((page) => page.id === "heavy-dashboard");
  const smallPage = pageList.find((page) => page.id === "small-form");

  const out = [];

  if (pss && rss) {
    const gap = rss.summary.median - pss.summary.median;
    out.push({
      title: `The Chromium payload itself (${fmt(pss.summary.median, 0)} MiB of PSS, ${fmt(gap, 0)} MiB of it counted twice as RSS)`,
      detail:
        `One idle tab is ${fmt(pss.summary.median, 0)} MiB of PSS across ${raw?.idle?.oneTab?.[0]?.pids ?? "?"} processes; ` +
        `adding up each process's RSS gives ${fmt(rss.summary.median, 0)} MiB for the same bytes. ` +
        `A stock headless Chrome on the same box is ${fmt(baselines[0].summary.median, 0)} MiB of PSS for one page, ` +
        `so what is left is Chromium, not anything this app's shell adds on top: the app's own browser process ` +
        `(GTK plus CEF's browser side) accounts for ` +
        `${fmt((raw?.idle?.oneTab?.[0]?.roles ?? []).find((role) => role.role === "browser")?.pssKb / 1024, 0)} MiB of it, ` +
        `and the rest is renderer, network service and zygote.`,
    });
  }

  if (space4 && profile) {
    out.push({
      title: `Spaces and profiles are no longer the cost (${fmt(metric("space-margin-2").summary.median, 0)} / ${fmt(space4.summary.median, 0)} / ${fmt(profile.summary.median, 0)} MiB each)`,
      detail:
        `A second space adds ${fmt(metric("space-margin-2").summary.median, 0)} MiB of PSS, a third or fourth adds ` +
        `${fmt(space4.summary.median, 0)} MiB, and crossing into a second profile adds ${fmt(profile.summary.median, 0)} MiB. ` +
        `The old per-space figure of 130 MiB was summed RSS over 4-vs-1 spaces when each space also had its own browser ` +
        `context — a real measurement of the wrong quantity. With the profile as the isolation boundary, concurrency is ` +
        `cheap; the fixed cost is the single browser underneath it.`,
    });
  }

  if (round) {
    const runs = roundRuns();
    const part = (read) => medianOf(runs.map(read));
    const actions = part((run) => run.phases?.goto) + part((run) => run.phases?.click) + part((run) => run.phases?.type);
    out.push({
      title: `Acting on a page costs far more than reading it (${fmt(actions, 0)} of ${fmt(round.summary.median, 0)} ms in one round)`,
      detail:
        `One round is ${fmt(round.summary.median, 0)} ms: opening the page ${fmt(part((run) => run.phases?.goto), 0)} ms, ` +
        `clicking a button ${fmt(part((run) => run.phases?.click), 0)} ms, typing 15 characters ` +
        `${fmt(part((run) => run.phases?.type), 0)} ms, while the snapshot of that page is only ` +
        `${fmt(part((run) => run.phases?.snapshot), 0)} ms and the command-line tool starting up ` +
        `${fmt(part((run) => run.cliStartupMs), 0)} ms. Each action is its own round trip plus the SDK's action ` +
        `boundary, so the interaction path — not the snapshot serializer — is where an agent's wall time goes on ` +
        `ordinary pages. Reading a heavy one is still expensive when an agent gets there: the ${heavyPage.nodes}-element ` +
        `dashboard takes ${fmt(heavyPage.viewportP50, 0)} ms p50 and ${fmt(heavyPage.p95, 0)} ms p95 to snapshot, ` +
        `against a 40 ms budget.`,
    });
  }

  return out.slice(0, 3);
}

function roleBars() {
  const roles = raw?.idle?.oneTab?.[0]?.roles ?? [];
  if (!roles.length) return "";
  const max = Math.max(...roles.map((role) => role.rssKb));
  const rows = roles
    .map(
      (role) => `
    <tr>
      <th>${esc(role.role)}</th>
      <td class="num">${role.procs}</td>
      <td class="bar-cell"><span class="bar" style="width:${((role.rssKb / max) * 100).toFixed(1)}%"></span></td>
      <td class="num">${fmt(role.pssKb / 1024, 0)} MiB</td>
      <td class="num muted">${fmt(role.rssKb / 1024, 0)} MiB</td>
    </tr>`,
    )
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>Where one tab's memory actually goes</h2>
      <p class="sub">Per process, app idle with a single tab. PSS counts shared pages once; summed RSS counts them once per process.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Process</th><th class="num">Count</th><th></th><th class="num">PSS</th><th class="num">Summed RSS</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function memoryConfigs() {
  const rows = [
    ["1 space", raw?.idle?.oneTab],
    ["2 spaces, same profile", raw?.idle?.twoSpaces],
    ["4 spaces, same profile", raw?.idle?.fourSpaces],
    ["1 space + 1 space in a second profile", raw?.idle?.secondProfile],
    ["4 spaces awake (not parked)", raw?.idle?.fourAwake],
  ].filter(([, runs]) => Array.isArray(runs) && runs.length);
  if (!rows.length) return "";
  const max = Math.max(...rows.map(([, runs]) => runs.reduce((t, run) => t + run.pssKb, 0) / runs.length));
  const body = rows
    .map(([label, runs]) => {
      const pssAvg = runs.reduce((t, run) => t + run.pssKb, 0) / runs.length / 1024;
      const rssAvg = runs.reduce((t, run) => t + run.rssKb, 0) / runs.length / 1024;
      const pids = runs.reduce((t, run) => t + run.pids, 0) / runs.length;
      return `<tr>
        <th>${esc(label)}</th>
        <td class="bar-cell"><span class="bar" style="width:${((pssAvg / max) * 100).toFixed(1)}%"></span></td>
        <td class="num">${fmt(pssAvg, 0)} MiB</td>
        <td class="num muted">${fmt(rssAvg, 0)} MiB</td>
        <td class="num muted">${fmt(pids, 0)}</td>
      </tr>`;
    })
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>What each extra space really costs</h2>
      <p class="sub">Same page everywhere. PSS (left) is the real memory; summed RSS (right) is the old way and counts shared pages per process.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Configuration</th><th></th><th class="num">PSS</th><th class="num">Summed RSS</th><th class="num">Processes</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="note">Spaces in one profile share a browser context, so each extra space is one more renderer and
     little else. A second <em>profile</em> is a separate browser context with its own renderer and cache, and it
     measures about the same at idle — isolation is close to free here; what costs 355 MiB is the first browser.</p>
</section>`;
}

function roundCard() {
  const round = metrics.find((row) => row.id === "agent-round");
  if (!round) return "";
  // One real run — the one whose wall time is the median — so the slices add up
  // to the number printed at the end of the bar. Medians of phases do not add up
  // to the median of the totals, and a bar that implies they do would be a lie.
  const runs = roundRuns();
  const sorted = [...runs].sort((a, b) => a.totalMs - b.totalMs);
  const run = sorted[Math.floor(sorted.length / 2)] ?? runs[0];
  const parts = [
    ["Command-line tool starting up", run?.cliStartupMs, "#60a5fa"],
    ["Creating the space", run?.phases?.taskSpace, "#818cf8"],
    ["Opening the page", run?.phases?.goto, "#a78bfa"],
    ["Reading the page (snapshot)", run?.phases?.snapshot, "#f472b6"],
    ["Clicking a button", run?.phases?.click, "#fb923c"],
    ["Typing 15 characters", run?.phases?.type, "#fbbf24"],
    ["Shutting down", run?.teardownMs, "#94a3b8"],
  ].filter(([, value]) => Number.isFinite(value) && value > 0);
  const total = parts.reduce((sum, [, value]) => sum + value, 0);
  let offset = 0;
  const width = 780;
  const bars = parts
    .map(([label, value, colour]) => {
      const w = (value / total) * width;
      const bar = `<rect x="${offset.toFixed(1)}" y="16" width="${Math.max(0, w - 1).toFixed(1)}" height="26" rx="3" fill="${colour}" fill-opacity="0.85"/>`;
      offset += w;
      return bar;
    })
    .join("");
  const legend = parts
    .map(
      ([label, value, colour]) =>
        `<li><span class="swatch" style="background:${colour}"></span>${esc(label)} — <strong>${fmt(value, 0)} ms</strong> (${fmt((value / total) * 100, 0)} %)</li>`,
    )
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>One complete agent step, end to end</h2>
      <p class="sub">${fmt(round.summary.median, 0)} ms: open the command-line tool, create a space, open a page, read it, click, type, exit.</p>
    </div>
    <span class="pill context">no budget</span>
  </div>
  <svg viewBox="0 0 ${width} 58" width="100%" height="58" role="img" aria-label="Agent round broken down by phase">
    ${bars}
    <text x="0" y="52" fill="${COLOURS.ink}" font-size="10">0 ms</text>
    <text x="${width}" y="52" fill="${COLOURS.ink}" font-size="10" text-anchor="end">${fmt(run?.totalMs ?? total, 0)} ms</text>
  </svg>
  <ul class="legend">${legend}</ul>
  <p class="note">One run, the one with the median wall time, so the slices add up to the total shown.
     The blue slice is the tool starting up, not the browser: an agent pays it on every invocation that is not
     kept open. Everything else is the browser doing the work.</p>
</section>`;
}

function sizesCard() {
  const nowPages = Array.isArray(raw?.snapshots) ? raw.snapshots : (raw?.snapshots?.pages ?? []);
  if (!nowPages.length) return "";
  const entry = previous[0];
  const oldPages = (() => {
    const pages = entry?.file?.raw?.snapshots?.pages ?? entry?.file?.raw?.snapshots;
    return Array.isArray(pages) ? pages : [];
  })();
  const rows = nowPages
    .map((page) => {
      const before = oldPages.find((candidate) => candidate.id === page.id);
      return `<tr>
        <th>${esc(page.label)}</th>
        <td class="num muted">${before?.snapshotLines ?? "—"}</td>
        <td class="num">${page.viewportScope ? `${page.viewportScope.lines} / ${page.viewportScope.refs}` : "—"}</td>
        <td class="num muted">${page.fullScope ? `${page.fullScope.lines} / ${page.fullScope.refs}` : "—"}</td>
      </tr>`;
    })
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>What the agent actually gets back</h2>
      <p class="sub">Lines of snapshot text for the same page. Timing moves with the box; this does not.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Page</th><th class="num">0.3.0 viewport</th><th class="num">0.4.0 viewport (lines / refs)</th><th class="num">0.4.0 full page</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">0.3.0's default snapshot of the long list came back nearly the size of the whole page (2,170
     lines). 0.4.0 returns the 183 lines that fit the viewport, and the dashboard drops from 5,794 to 133. The
     round trip did not get much cheaper — reading the accessibility tree still covers the whole document — but the
     agent pays to read far less of it.</p>
</section>`;
}

function snapshotTable() {
  const row = metrics.find((candidate) => candidate.id === "snapshot-p50");
  const perPage = row?.detail?.perPage ?? [];
  if (!perPage.length) return "";
  const body = perPage
    .map(
      (page) => `
    <tr>
      <th>${esc(page.label ?? page.id)}</th>
      <td class="num">${page.nodes}</td>
      <td class="num">${fmt(page.p50, 0)} ms</td>
      <td class="num">${fmt(page.p95, 0)} ms</td>
      <td class="num muted">${fmt(page.fullP50, 0)} ms</td>
      <td class="num muted">${fmt(page.fullP95, 0)} ms</td>
    </tr>`,
    )
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>How long an agent waits to read a page</h2>
      <p class="sub">Viewport is the default and what the budget is written for; full page is the same call with nothing filtered out.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Page</th><th class="num">Elements</th><th class="num">Viewport p50</th><th class="num">Viewport p95</th><th class="num">Full p50</th><th class="num">Full p95</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</section>`;
}

function baselinesBlock() {
  const rows = baselines
    .map(
      (row) => `
    <tr>
      <th>${esc(row.label)}</th>
      <td class="num">${fmt(row.summary.median, 0)} ${esc(row.unit)}</td>
      <td class="muted">${esc(row.method)}</td>
    </tr>`,
    )
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>What plain Chrome costs on the same box</h2>
      <p class="sub">So the numbers above mean something. Not graded: context.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Baseline</th><th class="num">Measured</th><th>Method</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function contributorsBlock() {
  const list = contributors();
  if (!list.length) return "";
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>The three things that cost the most</h2>
      <p class="sub">Read off the same measurements, not a separate model.</p>
    </div>
  </div>
  <ol class="contributors">
    ${list
      .slice(0, 3)
      .map((entry) => `<li><strong>${esc(entry.title)}</strong><p class="muted">${esc(entry.detail)}</p></li>`)
      .join("")}
  </ol>
</section>`;
}

function improvedBlock() {
  const rows = metrics.filter((row) => IMPROVED[row.id]);
  if (!rows.length) return "";
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>What the 0.4.0 fixes changed</h2>
      <p class="sub">The §6 targets were guesses written before anything was measured. They have not been moved; these rows are where the build changed.</p>
    </div>
  </div>
  <ul class="improved">
    ${rows
      .map(
        (row) =>
          `<li><strong>${esc(row.label)}</strong> — ${esc(IMPROVED[row.id])}</li>`,
      )
      .join("")}
  </ul>
</section>`;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rook — performance budget</title>
<style>
  :root { color-scheme: dark; --bg: #0e1116; --panel: #161b24; --line: #232a36; --ink: #e8edf6; --muted: #8b97ab; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); max-width: 900px; margin-inline: auto;
         padding: 40px 24px 72px; font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 26px; letter-spacing: -.02em; margin: 0 0 6px; }
  header p { color: var(--muted); margin: 0; font-size: 13.5px; }
  .verdict { display: flex; gap: 12px; align-items: baseline; margin: 22px 0 8px; flex-wrap: wrap; }
  .verdict strong { font-size: 19px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px 14px; margin-top: 16px; }
  .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h2 { font-size: 15.5px; margin: 0 0 2px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
  .pill { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
          padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .pill.pass { background: rgba(52,211,153,.14); color: ${COLOURS.pass}; }
  .pill.fail { background: rgba(248,113,113,.14); color: ${COLOURS.fail}; }
  .pill.context { background: rgba(96,165,250,.14); color: ${COLOURS.context}; }
  svg { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-weight: 400; }
  thead th { color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  tbody th { font-weight: 550; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { color: var(--muted); }
  .bar-cell { width: 30%; }
  .bar { display: block; height: 10px; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #60a5fa); }
  details { margin-top: 6px; }
  summary { color: var(--muted); font-size: 12.5px; cursor: pointer; }
  details p { color: var(--muted); font-size: 12.5px; margin: 8px 0 2px; }
  .note { color: var(--muted); font-size: 12.5px; margin: 6px 0 0; }
  ol.contributors { margin: 6px 0 2px; padding-left: 20px; }
  ol.contributors li { margin-bottom: 14px; }
  ol.contributors p { margin: 4px 0 0; font-size: 13px; }
  ul.legend { list-style: none; padding: 0; margin: 8px 0 0; font-size: 12.5px; color: var(--muted); }
  ul.legend li { margin-bottom: 3px; }
  ol.improved { margin: 6px 0 2px; padding-left: 20px; font-size: 13px; }
  ol.improved li { margin-bottom: 6px; }
  .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 26px; border-top: 1px solid var(--line); padding-top: 14px; }
  code { background: #1d2430; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Rook — performance budget</h1>
  <p>${esc((results.generatedAt ?? "").slice(0, 10))} · ${host.cores}-core box, ${(host.memBytes / 1024 ** 3).toFixed(1)} GiB RAM,
     load ${esc(host.loadavg.map((v) => v.toFixed(2)).join(" "))} · packaged <code>${esc(pkg?.version ?? "?")}</code>
     run from an unpacked copy · ${minutes} min of measurement</p>
</header>

<div class="verdict">
  <strong>${met} of ${graded.length} budgets met</strong>
  <span class="muted">${failed.length ? `over: ${failed.map((row) => row.label.toLowerCase()).join(", ")}` : "everything inside its budget"} ·
     ${contextRows.length} context rows with no budget</span>
</div>

${graded.map(card).join("\n")}

${contextRows.length ? `<h2 style="margin:28px 0 0;font-size:15px;color:#a9b4c8">Context — measured, but the budget never named a number</h2>` : ""}
${contextRows.map(card).join("\n")}

${roundCard()}
${memoryConfigs()}
${roleBars()}
${sizesCard()}
${snapshotTable()}
${baselinesBlock()}
${improvedBlock()}
${contributorsBlock()}

<footer>
  Methods in <code>bench/README.md</code>, raw numbers in <code>bench/results.json</code>.
  Every figure is the median of ${config.runs} runs (spread = max − min); memory is the sum of
  <code>/proc/&lt;pid&gt;/smaps_rollup</code> over the app's whole process tree, reported as PSS (shared pages split
  between the processes mapping them) and as summed RSS (shared pages counted once per process).
  The box is shared: other builds and QA runs can be active during a pass, so treat small differences as noise.
</footer>
</body>
</html>
`;
}

writeFileSync(join(OUT, "report.md"), markdown());
writeFileSync(join(OUT, "report.html"), html());
process.stdout.write(
  `wrote ${join(OUT, "report.md")} and ${join(OUT, "report.html")} (${met}/${graded.length} budgets met, ${contextRows.length} context rows)\n`,
);
