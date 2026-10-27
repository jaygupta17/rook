// Snapshot quality, measured through the shipped CLI exactly as an agent would.
//
//   SNAPSHOT_URL=... SNAPSHOT_LABEL=wikipedia \
//   ego-browser nodejs < docs/eval-logs/rounds/snapshot-quality.mjs
//
// Prints one JSON line per scope: lines, characters, wall time, how much of the
// page is indentation / duplicate URLs / wrapper rows, and whether the article
// body is present. The space name carries a timestamp so a rerun against the
// same app never resumes an old space.
const url = process.env.SNAPSHOT_URL;
const label = process.env.SNAPSHOT_LABEL || "page";
if (!url) throw new Error("SNAPSHOT_URL is required");

const task = await taskSpace(`${label}-${Date.now()}`);
const page = task.page("p1");
await page.goto(url);

async function measure(scope) {
  const started = performance.now();
  const raw = await snapshotRaw(scope ? { scope } : {});
  const ms = Math.round(performance.now() - started);
  const content = String(raw.content ?? "");
  const lines = content.split("\n");
  const torvalds = lines.find((line) => line.includes("Torvalds")) ?? null;
  return {
    scope: scope ?? "runtime default",
    ms,
    lines: lines.length,
    chars: content.length,
    refs: Array.isArray(raw.refs) ? raw.refs.length : 0,
    textLines: lines.filter((line) => line.trim().startsWith("text ")).length,
    wrapperLines: lines.filter((line) => /^\s*(generic|layout[a-z]*)\b/.test(line)).length,
    indentChars: lines.reduce((sum, line) => sum + (line.length - line.trimStart().length), 0),
    urlAttr: (content.match(/, url=/g) || []).length,
    hrefLoc: (content.match(/loc=href:/g) || []).length,
    longestLine: lines.reduce((max, line) => Math.max(max, line.length), 0),
    article: Boolean(torvalds) && content.includes("GPL"),
    sample: torvalds ? torvalds.trim().slice(0, 120) : null,
    header: String(lines[0] ?? "").slice(0, 200),
  };
}

for (const scope of ["only_within_viewport", "full_page"]) {
  console.log(JSON.stringify({ label, ...(await measure(scope)) }));
}

await task.finish({ keep: [] });
