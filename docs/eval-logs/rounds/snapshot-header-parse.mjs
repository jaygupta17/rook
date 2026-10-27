// Proof that the snapshot header line is safe for the harness parser, and that
// putting the same information on the `root` line is not.
//
//   node docs/eval-logs/rounds/snapshot-header-parse.mjs
import { compactSnapshotContent } from "../../../vendor/ego-browser/dist/src/snapshot-result.js";

const header =
  'snapshot scope=viewport only, 6 lines, 1 refs, 12 nodes outside the viewport not shown - pass {scope:"full_page"} for the whole page';

const withHeader = [
  header,
  "root",
  "  main",
  "    container",
  "      button \"Save\" [ref=1, loc=css:#save]",
].join("\n");

const compacted = compactSnapshotContent(withHeader);
console.log("header before root:");
console.log(compacted);
console.log(`  header kept verbatim: ${compacted.split("\n")[0] === header}`);
console.log(`  compaction still ran (container removed): ${!compacted.includes("container")}`);

const onRootLine = withHeader
  .replace(/^snapshot[^\n]*\n/, "")
  .replace(/^root$/m, "root scope=viewport only");
const compactedRoot = compactSnapshotContent(onRootLine);
console.log("\nscope on the root line instead:");
console.log(compactedRoot);
console.log(`  compaction still ran (container removed): ${!compactedRoot.includes("container")}`);
