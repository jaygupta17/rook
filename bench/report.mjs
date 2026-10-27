#!/usr/bin/env node
/**
 * results.json -> report.md + report.html.
 *
 * The numbers come from bench.mjs; nothing here measures anything or rounds a
 * failure into a pass. Every verdict is `measured median <= target`, printed
 * next to the number it came from.
 *
 *   bench/report.mjs            # after bench.mjs (or bench/run.sh --report)
 */
import { readFileSync, writeFileSync } from "node:fs";
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

const fmt = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

function measured(row) {
  const sum = row.summary;
  if (!sum || !sum.n) return "—";
  const digits = row.unit === "%" ? 2 : row.unit === "MB" ? 0 : 1;
  if (sum.n === 1) return `${fmt(sum.median, digits)} ${row.unit} (one figure, no spread)`;
  return `${fmt(sum.median, digits)} ${row.unit} ± ${fmt(sum.spread, digits)} (${fmt(sum.min, digits)}..${fmt(sum.max, digits)})`;
}

const met = metrics.filter((row) => row.pass).length;
const failed = metrics.filter((row) => !row.pass);
const minutes = Math.round((results.durationSeconds ?? 0) / 60);

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
function markdown() {
  const lines = [];
  lines.push("# Performance budget — measured");
  lines.push("");
  lines.push(
    `Run ${results.generatedAt}, on ${host.cores} cores (${host.model ?? "unknown CPU"}), ` +
      `${(host.memBytes / 1024 ** 3).toFixed(1)} GiB RAM, kernel ${host.kernel}. ` +
      `Package \`${pkg?.deb?.split("/").pop() ?? "?"}\` (${pkg?.version ?? "?"}), unpacked with ` +
      "`dpkg-deb -x` and run from a private Xvfb. The budget is the target column below.",
  );
  lines.push("");
  lines.push(`**${met} of ${metrics.length} targets met**${failed.length ? `; over budget on ${failed.map((row) => `\`${row.label}\``).join(", ")}` : ""}.`);
  lines.push("");
  lines.push("| Metric | Target | Measured (median ± spread) | Verdict | Method |");
  lines.push("|---|---|---|---|---|");
  for (const row of metrics) {
    const verdict = row.pass ? "**pass**" : "**FAIL**";
    lines.push(
      `| ${row.label} | ${row.better === "lower" ? "≤" : "≥"} ${row.target} ${row.unit} | ${measured(row)} | ${verdict} | ${row.method} |`,
    );
  }
  lines.push("");
  lines.push("Every row is three runs unless the method says otherwise; `spread` is `max − min` across them.");
  lines.push("");

  const discarded = results.discards ?? [];
  if (discarded.length) {
    const byReason = new Map();
    for (const entry of discarded) {
      const key = /exited during|process tree came back empty/.test(entry.error)
        ? "the app aborted during the measurement window"
        : entry.error;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    lines.push(
      `**Reliability, and it matters for these numbers:** ${discarded.length} run(s) were discarded because the ` +
        `packaged app did not survive them — ${[...byReason.entries()].map(([reason, count]) => `${count}× ${reason}`).join("; ")}. ` +
        `Each was retried, and every discard is listed under \`discards\` in results.json. The packaged build prints ` +
        `\`*** stack smashing detected ***\` from CEF subprocesses on **every** launch, and a launch occasionally ` +
        `does not survive ten seconds. The measurements below are from runs where the app stayed up, which is the ` +
        `only thing worth measuring, but the instability is a real defect and not a benchmark artefact: it is why ` +
        `a window closes on its own sometimes.`,
    );
    lines.push("");
  }

  lines.push("## Baseline, for context");
  lines.push("");
  lines.push("| Baseline | Measured | Method |");
  lines.push("|---|---|---|");
  for (const row of baselines) {
    const method =
      row.id === "chrome-idle"
        ? `google-chrome --headless=new, one page loaded, RSS over the Chrome pid tree after a ${config.chromeIdleSeconds} s window.`
        : row.method;
    lines.push(`| ${row.label} | ${measured(row)} | ${method} |`);
  }
  lines.push("");

  lines.push("## What this means");
  lines.push("");
  const cold = metrics.find((row) => row.id === "cold-start");
  const rss = metrics.find((row) => row.id === "idle-rss");
  const margin = metrics.find((row) => row.id === "space-margin");
  const cpu = metrics.find((row) => row.id === "cpu-idle");
  const p50 = metrics.find((row) => row.id === "snapshot-p50");
  const p95 = metrics.find((row) => row.id === "snapshot-p95");
  const size = metrics.find((row) => row.id === "install-size");

  lines.push(
    `Starting the app is the part that works: ${fmt(cold.summary.median, 0)} ms from exec to a painted page, ` +
      `${cold.pass ? "comfortably inside" : "outside"} the 1.5 s budget, and faster than plain headless Chrome ` +
      `produces a frame on this box (${fmt(baselines[1].summary.median, 0)} ms). ` +
      `Sitting idle, the app holds ${fmt(rss.summary.median, 0)} MiB of RSS across ` +
      `${raw?.idle?.oneTab?.[0]?.pids ?? "?"} processes — plain headless Chrome holds ` +
      `${fmt(baselines[0]?.summary?.median, 0)} MiB on the same box for one page — which is ` +
      `${rss.pass ? "inside" : `${fmt(rss.summary.median / 250, 1)}× over`} the 250 MiB budget; ` +
      `its proportional share (Pss) is ${fmt(rss.detail.pssMiB.median, 0)} MiB, so roughly ` +
      `${fmt((rss.summary.median - rss.detail.pssMiB.median) / rss.summary.median * 100, 0)} % of that sum is pages shared with the other processes in the tree. ` +
      `Each additional parked space costs ${fmt(margin.summary.median, 0)} MiB (${margin.pass ? "inside" : "over"} the 120 MiB allowance), ` +
      `so four spaces is ${fmt(margin.detail?.fourParked?.median, 0)} MiB. ` +
      `CPU idle is ${fmt(cpu.summary.median, 2)} % of one core, ${cpu.pass ? "inside" : "over"} the 1 % budget: parking spaces does throttle them. ` +
      `Snapshots are the real gap: ${fmt(p50.summary.median, 0)} ms p50 on a 2,000-node page against a 40 ms budget, ` +
      `and ${fmt(p95.summary.median, 0)} ms p95 on the dashboard against 150 ms, which is what an agent waiting on the page feels. ` +
      `The package itself is ${fmt(size.summary.median, 0)} MB installed, ${size.pass ? "inside" : "over"} the 450 MB ceiling.`,
  );
  lines.push("");

  const borderline = metrics.filter(
    (row) =>
      Number.isFinite(row.summary?.median) &&
      row.summary.n > 1 &&
      Math.abs(row.summary.median - row.target) / row.target <= 0.1,
  );
  if (borderline.length) {
    lines.push(
      `**Borderline, so it will flip between passes on this box:** ` +
        borderline
          .map(
            (row) =>
              `${row.label} at ${fmt(row.summary.median, row.unit === "%" ? 2 : 1)} ${row.unit} against ` +
              `${row.target} ${row.unit}`,
          )
          .join("; ") +
        ". That is inside what a shared box moves these numbers by, so treat those verdicts as coin flips.",
    );
    lines.push("");
  }

  const roles = raw?.idle?.oneTab?.[0]?.roles ?? [];
  if (roles.length) {
    lines.push("### Where the memory goes (one tab, idle)");
    lines.push("");
    lines.push("| Process | Count | RSS | Pss |");
    lines.push("|---|---|---|---|");
    for (const role of roles) {
      lines.push(`| ${role.role} | ${role.procs} | ${fmt(role.rssKb / 1024, 0)} MiB | ${fmt(role.pssKb / 1024, 0)} MiB |`);
    }
    lines.push("");
  }

  const bigCosts = contributors();
  if (bigCosts.length) {
    lines.push("### Three biggest contributors to the cost");
    lines.push("");
    bigCosts.forEach((entry, index) => {
      lines.push(`${index + 1}. **${entry.title}** — ${entry.detail}`);
    });
    lines.push("");
  }

  const snapPages = Array.isArray(raw?.snapshots) ? raw.snapshots : (raw?.snapshots?.pages ?? []);
  const standalone = Array.isArray(raw?.snapshots) ? [] : (raw?.snapshots?.standalone ?? []);
  if (standalone.length) {
    lines.push("### Is the host socket the bottleneck?");
    lines.push("");
    lines.push(
      "The same snapshot calls, run through the same CLI against the bridge's own headless Chrome " +
        "(no control socket, no host process in between):",
    );
    lines.push("");
    lines.push("| Page class | Through the app (p50) | Same bridge, own Chrome (p50) |");
    lines.push("|---|---|---|");
    for (const page of snapPages) {
      const other = standalone.find((entry) => entry.id === page.id);
      lines.push(
        `| ${page.label} | ${fmt(page.viewportP50, 0)} ms | ${other && !other.error ? `${fmt(other.p50, 0)} ms` : "—"} |`,
      );
    }
    lines.push("");
    lines.push(
      "If the two columns are close, the cost is the snapshot pipeline itself, not the pipe to the app.",
    );
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
      `Each measured run gets its own Xvfb (never \`:99\`, which other QA runs on this box share) and its own profile ` +
      `directory. Node ${host.node}, ${host.chrome}.`,
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
 * One metric: a measured bar with a min..max whisker, a dashed target line, and
 * the numbers printed under it. Plain words on the axis, no log scale tricks.
 */
function chart(row, { width = 780, height = 116 } = {}) {
  const sum = row.summary;
  const target = row.target;
  const top = Math.max(sum.max, target) * 1.18;
  const scale = niceScale(top);
  const left = 8;
  const right = width - 8;
  const plotWidth = right - left;
  const mid = 44;
  const x = (value) => left + (Math.min(value, scale) / scale) * plotWidth;
  const colour = row.pass ? COLOURS.pass : COLOURS.fail;

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
  const targetX = Math.min(Math.max(x(target), left + 34), right - 34);

  return `
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
     aria-label="${esc(row.label)}: measured ${fmt(sum.median)} ${row.unit}, target ${target} ${row.unit}">
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
  <line x1="${x(target).toFixed(1)}" y1="${mid - 26}" x2="${x(target).toFixed(1)}" y2="${mid + 18}"
        stroke="${COLOURS.target}" stroke-width="1.6" stroke-dasharray="4 3"/>
  <text x="${targetX.toFixed(1)}" y="${mid + 48}" fill="${COLOURS.target}" font-size="10.5"
        text-anchor="middle">target ${target} ${row.unit}</text>
  <text x="${left}" y="16" fill="${colour}" font-size="12.5" font-weight="600">
    ${fmt(sum.median, row.unit === "%" ? 2 : 0)} ${row.unit}
  </text>
  ${sum.n > 1
    ? `<text x="${left + 92}" y="16" fill="${COLOURS.ink}" font-size="11.5">
    runs ${fmt(sum.min, row.unit === "%" ? 2 : 0)}..${fmt(sum.max, row.unit === "%" ? 2 : 0)} ${row.unit}
  </text>`
    : ""}
</svg>`;
}

function card(row) {
  const note = row.detail?.note ? `<p class="note">${esc(row.detail.note)}</p>` : "";
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>${esc(row.plain)}</h2>
      <p class="sub">${esc(row.label)}</p>
    </div>
    <span class="pill ${row.pass ? "pass" : "fail"}">${row.pass ? "inside budget" : "over budget"}</span>
  </div>
  ${chart(row)}
  ${note}
  <details><summary>How this was measured</summary><p>${esc(row.method)}</p></details>
</section>`;
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
      <td class="num">${fmt(role.rssKb / 1024, 0)} MiB</td>
      <td class="num muted">${fmt(role.pssKb / 1024, 0)} MiB</td>
    </tr>`,
    )
    .join("");
  return `
<section class="card">
  <div class="card-head">
    <div>
      <h2>Where one tab's memory actually goes</h2>
      <p class="sub">RSS per process, app idle with a single tab. Pss (right) counts shared pages once.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Process</th><th class="num">Count</th><th></th><th class="num">RSS</th><th class="num">Pss</th></tr></thead>
    <tbody>${rows}</tbody>
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
      <td class="muted">${esc(
        row.id === "chrome-idle"
          ? `google-chrome --headless=new, one page loaded, RSS over the Chrome pid tree after a ${config.chromeIdleSeconds} s window`
          : row.method,
      )}</td>
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

function reliabilityBlock() {
  const discarded = results.discards ?? [];
  if (!discarded.length) return "";
  return `
<section class="card" id="reliability">
  <div class="card-head">
    <div>
      <h2>The app does not always stay open</h2>
      <p class="sub">${discarded.length} run(s) were thrown away because the app closed itself mid-measurement</p>
    </div>
  </div>
  <p class="note">On every single launch the packaged build prints an internal crash message
     (<code>stack smashing detected</code>) from its forked helper processes, and every so often a launch closes
     by itself a few seconds after a page opens. Those runs were retried and are listed in
     <code>results.json</code> under <code>discards</code>. The numbers here are from runs that survived —
     but a window that closes on its own is a bug, not a measurement problem.</p>
</section>`;
}

/**
 * The three biggest contributors, derived here rather than baked into
 * results.json: the prose can be corrected without measuring again, and there is
 * one place where "biggest" is defined.
 */
function contributors() {
  const metric = (id) => metrics.find((row) => row.id === id);
  const rss = metric("idle-rss");
  const margin = metric("space-margin");
  const oneTab = raw?.idle?.oneTab?.[0];
  const pageList = Array.isArray(raw?.snapshots) ? raw.snapshots : (raw?.snapshots?.pages ?? []);
  const standalone = Array.isArray(raw?.snapshots) ? [] : (raw?.snapshots?.standalone ?? []);
  const listPage = pageList.find((page) => page.id === "long-list");
  const heavyPage = pageList.find((page) => page.id === "heavy-dashboard");
  const smallPage = pageList.find((page) => page.id === "small-form");

  const pss = rss?.detail?.pssMiB?.median;
  const gap = Number.isFinite(pss) ? rss.summary.median - pss : NaN;
  const perNodeUs =
    listPage && smallPage && listPage.nodes > smallPage.nodes
      ? ((listPage.viewportP50 - smallPage.viewportP50) / (listPage.nodes - smallPage.nodes)) * 1000
      : NaN;
  const standaloneList = standalone.find((entry) => entry.id === "long-list" && !entry.error);

  const out = [];

  if (Number.isFinite(gap)) {
    out.push({
      title: `The CEF runtime, counted once per process (${fmt(gap, 0)} MiB of the ${fmt(rss.summary.median, 0)} MiB)`,
      detail:
        `RSS sums every process in the tree, and each of the ${oneTab?.pids ?? "?"} processes maps the same ` +
        `277 MB libcef.so from the package. The gap between summed RSS (${fmt(rss.summary.median, 0)} MiB) and ` +
        `summed Pss (${fmt(pss, 0)} MiB) is that double count. It is not memory the app can give back, but a budget ` +
        `written as "total RSS" pays for it once per process, so the number of processes is itself a cost.`,
    });
  }

  if (margin) {
    const parked = margin.detail?.fourParked?.median;
    const awake = margin.detail?.fourAwake?.median;
    const delta = awake - parked;
    // 2 % of the parked total, or the run-to-run spread if that is bigger: below
    // that the difference is not something this box can resolve.
    const tolerance = Math.max(
      Math.max(margin.detail?.fourParked?.spread ?? 0, margin.detail?.fourAwake?.spread ?? 0),
      parked * 0.02,
    );
    const verdict =
      Math.abs(delta) <= tolerance
        ? "within 2 % of each other, so parking buys no memory at all"
        : `${fmt(Math.abs(delta), 0)} MiB ${delta > 0 ? "more" : "less"}, which is more than this box resolves`;
    out.push({
      title: `One browser context per space (${fmt(margin.summary.median, 0)} MiB per extra parked space)`,
      detail:
        `4 spaces cost ${fmt(parked, 0)} MiB against ${fmt(rss?.summary?.median, 0)} MiB for 1: ` +
        `${fmt(margin.summary.median, 0)} MiB per space. Parking a space (WasHidden(true)) throttles its timers but ` +
        `does not drop its browser: with all four awake the tree measures ${fmt(awake, 0)} MiB against ` +
        `${fmt(parked, 0)} MiB parked — ${verdict}. Parking is a CPU knob, not a memory one.`,
    });
  }

  if (Number.isFinite(perNodeUs) && listPage && heavyPage && smallPage) {
    const pipeNote = standaloneList
      ? ` The host socket is not the cost: the same call against the bridge's own headless Chrome, with no app ` +
        `process in between, takes ${fmt(standaloneList.p50, 0)} ms against ${fmt(listPage.viewportP50, 0)} ms here.`
      : "";
    out.push({
      title: `Snapshot cost scales with the page, not with the viewport (${fmt(perNodeUs, 0)} µs per element)`,
      detail:
        `p50 goes from ${fmt(smallPage.viewportP50, 0)} ms at ${smallPage.nodes} elements to ` +
        `${fmt(listPage.viewportP50, 0)} ms at ${listPage.nodes} elements and ${fmt(heavyPage.viewportP50, 0)} ms at ` +
        `${heavyPage.nodes} elements. Filtering to the viewport does not avoid that work: the same call without the ` +
        `filter (\`scope: "full_page"\`) costs ${fmt(listPage.fullP50 ?? listPage.fullPageP50, 0)} ms instead of ` +
        `${fmt(listPage.viewportP50, 0)} ms on the long list and ${fmt(heavyPage.fullP50 ?? heavyPage.fullPageP50, 0)} ms instead of ` +
        `${fmt(heavyPage.viewportP50, 0)} ms on the dashboard, because Accessibility.getFullAXTree reads the whole ` +
        `document before anything is filtered out.` + pipeNote,
    });
  }

  return out.slice(0, 3);
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

function html() {
  const p50 = metrics.find((row) => row.id === "snapshot-p50");
  const p95 = metrics.find((row) => row.id === "snapshot-p95");
  const snapshotPages = p50.detail?.perPage ?? [];
  const snapshotRows = snapshotPages
    .map(
      (page) => `
    <tr>
      <th>${esc(page.label ?? page.id)}</th>
      <td class="num">${page.nodes}</td>
      <td class="num">${fmt(page.p50, 0)} ms</td>
      <td class="num">${fmt(page.p95, 0)} ms</td>
      <td class="num muted">${page.fullPageP50 ? `${fmt(page.fullPageP50, 0)} ms` : "—"}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rook on Linux — performance budget</title>
<style>
  :root { color-scheme: dark; --bg: #0e1116; --panel: #161b24; --line: #232a36; --ink: #e8edf6; --muted: #8b97ab; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); max-width: 900px; margin-inline: auto;
         padding: 40px 24px 72px; font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header h1 { font-size: 26px; letter-spacing: -.02em; margin: 0 0 6px; }
  header p { color: var(--muted); margin: 0; font-size: 13.5px; }
  .verdict { display: flex; gap: 12px; align-items: baseline; margin: 22px 0 8px; }
  .verdict strong { font-size: 19px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px 14px; margin-top: 16px; }
  .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h2 { font-size: 15.5px; margin: 0 0 2px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
  .pill { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
          padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .pill.pass { background: rgba(52,211,153,.14); color: ${COLOURS.pass}; }
  .pill.fail { background: rgba(248,113,113,.14); color: ${COLOURS.fail}; }
  svg { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-weight: 400; }
  thead th { color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  tbody th { font-weight: 550; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { color: var(--muted); }
  .bar-cell { width: 34%; }
  .bar { display: block; height: 10px; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #60a5fa); }
  details { margin-top: 6px; }
  summary { color: var(--muted); font-size: 12.5px; cursor: pointer; }
  details p { color: var(--muted); font-size: 12.5px; margin: 8px 0 2px; }
  .note { color: var(--muted); font-size: 12.5px; margin: 4px 0 0; }
  ol.contributors { margin: 6px 0 2px; padding-left: 20px; }
  ol.contributors li { margin-bottom: 14px; }
  ol.contributors p { margin: 4px 0 0; font-size: 13px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 26px; border-top: 1px solid var(--line); padding-top: 14px; }
  code { background: #1d2430; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Rook on Linux — performance budget</h1>
  <p>${esc(results.generatedAt.slice(0, 10))} · ${host.cores}-core box, ${(host.memBytes / 1024 ** 3).toFixed(1)} GiB RAM · packaged
     <code>${esc(pkg?.version ?? "?")}</code> run from an unpacked copy · ${minutes} min of measurement</p>
</header>

<div class="verdict">
  <strong>${met} of ${metrics.length} budgets met</strong>
  <span class="muted">${failed.length ? `over: ${failed.map((row) => row.label.toLowerCase()).join(", ")}` : "everything inside its budget"}</span>
</div>

${metrics.map(card).join("\n")}

${roleBars()}

<section class="card">
  <div class="card-head">
    <div>
      <h2>How long an agent waits to read a page</h2>
      <p class="sub">Median / 95th percentile per page type, through the real command-line tool.</p>
    </div>
  </div>
  <table class="roles">
    <thead><tr><th>Page</th><th class="num">Elements</th><th class="num">Median</th><th class="num">Slow (p95)</th><th class="num">Whole page</th></tr></thead>
    <tbody>${snapshotRows}</tbody>
  </table>
  <p class="note">Budget: ≤ ${p50.target} ms median, ≤ ${p95.target} ms slow case. "Whole page" is the same call without the
     viewport filter — context, not part of the budget.</p>
</section>

${baselinesBlock()}
${reliabilityBlock()}
${contributorsBlock()}

<footer>
  Methods in <code>bench/README.md</code>, raw numbers in <code>bench/results.json</code>.
  Every figure is the median of ${config.runs} runs (spread = max − min); memory is the sum of
  <code>/proc/&lt;pid&gt;/smaps_rollup</code> over the app's whole process tree. The box is shared:
  other builds and QA runs were active during this pass, so treat small differences as noise.
</footer>
</body>
</html>
`;
}

writeFileSync(join(OUT, "report.md"), markdown());
writeFileSync(join(OUT, "report.html"), html());
process.stdout.write(`wrote ${join(OUT, "report.md")} and ${join(OUT, "report.html")} (${met}/${metrics.length} targets met)\n`);
