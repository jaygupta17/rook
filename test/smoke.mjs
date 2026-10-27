/**
 * Stage-1 smoke test: drive a real Chrome through our CLI end to end.
 *
 *   create task space -> create/resume tab -> snapshot -> click a button by
 *   ref -> assert the DOM changed
 *
 * Requirements: an SDK build. The default is the vendored copy this repo
 * builds (`scripts/build-sdk.sh` -> vendor/ego-browser); set ROOK_UPSTREAM to
 * point at another `package/ego-browser` checkout and ROOK_SDK to use a
 * prepared dist/out/index.js.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const CLI = join(PACKAGE_ROOT, "bin", "ego-browser");
const UPSTREAM =
  process.env.ROOK_UPSTREAM || join(PACKAGE_ROOT, "vendor", "ego-browser");
const SDK_PATH = process.env.ROOK_SDK || join(UPSTREAM, "dist", "out", "index.js");

const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Smoke fixture</title></head>
  <body>
    <main>
      <h1>Smoke fixture</h1>
      <p id="status">ready</p>
      <button id="go" aria-label="Run the smoke action">Run action</button>
      <span id="result">idle</span>
      <a id="nav" href="/next">Next page</a>
      <div id="dynamic-container"></div>
      <iframe id="frame" title="Smoke frame" src="/frame" width="400" height="180"></iframe>
    </main>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        document.getElementById("result").textContent = "clicked";
        const node = document.createElement("div");
        node.id = "dynamic-element";
        node.textContent = "Dynamic!";
        document.getElementById("dynamic-container").append(node);
      });
    </script>
  </body>
</html>`;

const FRAME_PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Smoke frame</title></head>
  <body>
    <h2>Frame content</h2>
    <button id="frame-go" aria-label="Frame action">Run frame action</button>
    <span id="frame-result">frame idle</span>
    <script>
      document.getElementById("frame-go").addEventListener("click", () => {
        document.getElementById("frame-result").textContent = "frame clicked";
      });
    </script>
  </body>
</html>`;

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/next") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Next</title><h1>Next page</h1>");
      return;
    }
    if (url.pathname === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FRAME_PAGE);
      return;
    }
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function run(command, args, { env, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

async function ensureSdk() {
  if (existsSync(SDK_PATH)) return;
  if (!existsSync(join(UPSTREAM, "package.json"))) {
    throw new Error(
      `no SDK at ${SDK_PATH}.\n` +
        `Build one with scripts/build-sdk.sh --upstream <checkout>/package/ego-browser,\n` +
        `or point ROOK_UPSTREAM at another ego-browser checkout (ROOK_SDK at a dist/out/index.js).`,
    );
  }
  console.log(`building upstream SDK at ${UPSTREAM} ...`);
  const npm = join(process.execPath, "..", "npm");
  const install = await run(npm, ["ci"], { env: {}, timeoutMs: 600000 }).catch(() => null);
  const build = await run(`${npm}`, ["run", "build"], { env: {}, timeoutMs: 600000 });
  if (install?.code !== 0 || build.code !== 0) {
    throw new Error(
      `could not build the upstream SDK (npm ci exit ${install?.code}, npm run build exit ${build.code})\n${build.stderr}`,
    );
  }
  if (!existsSync(SDK_PATH)) throw new Error(`SDK still missing at ${SDK_PATH}`);
}

function checkSnapshotGrammar(snapshot, problems) {
  const lines = String(snapshot.content || "").split("\n");
  // The first line says what slice of the page this is; the tree follows it.
  const header = lines[0]?.startsWith("snapshot scope=") ? lines.shift() : null;
  if (header === null) {
    problems.push(`content must start with the scope header, got ${JSON.stringify(lines[0])}`);
  } else if (!/scope=(?:viewport only|full page|subtree)\b/.test(header)) {
    problems.push(`scope header names no scope: ${JSON.stringify(header)}`);
  }
  if (lines[0] !== "root") problems.push(`content must start with "root", got ${JSON.stringify(lines[0])}`);
  for (const line of lines) {
    if (line.trim() === "") continue;
    if ((line.length - line.trimStart().length) % 2 !== 0) {
      problems.push(`odd indentation in line ${JSON.stringify(line)}`);
    }
    if (!/^(?:root|text(?: "(?:[^"\\]|\\.)*")?|[a-z_]+(?: "(?:[^"\\]|\\.)*")?(?: \[ref=\d+(?:, [^\]]+)?\])?)$/.test(line.trim())) {
      problems.push(`line does not match the snapshot grammar: ${JSON.stringify(line)}`);
    }
  }
  if (!Array.isArray(snapshot.refs) || snapshot.refs.length === 0) {
    problems.push("snapshot returned no refs");
    return;
  }
  for (const ref of snapshot.refs) {
    if (!Number.isInteger(ref.backendNodeId) || ref.backendNodeId <= 0) {
      problems.push(`ref has no usable backendNodeId: ${JSON.stringify(ref)}`);
    }
    if (!Number.isInteger(ref.refId) || ref.refId <= 0) {
      problems.push(`ref has no positive integer refId: ${JSON.stringify(ref)}`);
    }
  }
}

async function main() {
  await ensureSdk();

  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const stateDir = await mkdtemp(join(tmpdir(), "rook-smoke-"));
  const taskName = `smoke-${process.pid}-${Date.now()}`;

  const script = `
const task = await taskSpace(${JSON.stringify(taskName)});
if (task.name !== ${JSON.stringify(taskName)}) throw new Error("task space name mismatch");
const page = task.page("p1");

await page.goto(${JSON.stringify(`${baseUrl}/`)});

const raw = await snapshotRaw({ scope: "full_page" });
console.log(JSON.stringify({ step: "snapshot", content: raw.content, refs: raw.refs }));
const snapshotLines = String(raw.content).split("\\n");
if (!/^snapshot scope=/.test(snapshotLines[0] || "")) throw new Error("snapshot does not state its scope: " + snapshotLines[0]);
if (snapshotLines[1] !== "root") throw new Error("snapshot tree does not start with root");
if (!String(raw.content).includes("Smoke fixture")) throw new Error("snapshot is missing the heading");

const text = await page.snapshot({ scope: "full_page" });
if (!text.includes("Smoke fixture")) throw new Error("Page.snapshot is missing the heading");

const button = (raw.refs || []).find(
  (ref) => ref.role === "button" && String(ref.name || "").includes("Run"),
);
if (!button) throw new Error("snapshot has no button ref: " + JSON.stringify(raw.refs || []));
const ref = button.refId ?? button.backendNodeId;
await page.click("@" + ref);
const resultText = await page.evaluate(() => document.getElementById("result").textContent);
if (resultText !== "clicked") throw new Error("click did not run the handler: " + resultText);
const after = await page.snapshot({ scope: "full_page" });
if (!after.includes("Dynamic!")) throw new Error("snapshot does not see the DOM change");

// Frames: an iframe must expand into a nested root, and a ref inside it must
// name the frame that owns the node so the action lands in that frame.
const frameRaw = await snapshotRaw({ scope: "full_page" });
if (!String(frameRaw.content).includes("Frame content")) {
  throw new Error("snapshot is missing the iframe content");
}
const frameLine = String(frameRaw.content)
  .split("\\n")
  .find((line) => line.trimStart().startsWith("iframe "));
if (!frameLine || !/\\[ref=[0-9]+/.test(frameLine)) {
  throw new Error("snapshot has no iframe line with a ref: " + frameRaw.content);
}
const frameButton = (frameRaw.refs || []).find(
  (ref) => ref.role === "button" && String(ref.name || "").includes("Frame action"),
);
if (!frameButton) {
  throw new Error("snapshot has no iframe button ref: " + JSON.stringify(frameRaw.refs || []));
}
if (typeof frameButton.frameId !== "string" || frameButton.frameId === "") {
  throw new Error("iframe ref has no frameId: " + JSON.stringify(frameButton));
}
const frameText = await page.snapshot({ scope: "full_page" });
const frameActionLine = frameText
  .split("\\n")
  .find((line) => line.includes("Frame action"));
const frameActionRef = frameActionLine && frameActionLine.match(/\\[ref=([0-9]+)/);
if (!frameActionRef) {
  throw new Error("Page.snapshot has no iframe action ref: " + frameText);
}
await page.click("@" + frameActionRef[1]);
const frameResult = await page.evaluate(
  () => document.querySelector("#frame").contentDocument.querySelector("#frame-result").textContent,
);
if (frameResult !== "frame clicked") {
  throw new Error("iframe ref click did not run in the frame: " + frameResult);
}

const tabs = await listTabs({ includeChrome: false });
if (!tabs.some((tab) => tab.url.startsWith(${JSON.stringify(baseUrl)}))) {
  throw new Error("listTabs does not expose the smoke tab");
}

console.log("SMOKE OK");
await task.finish({ keep: [] });
`;

  const result = await run(CLI, ["nodejs", "--sdk-path", SDK_PATH], {
    // This test is about the Chrome path: an Rook app that happens to be
    // running must not silently become the browser under test.
    env: { EGO_BROWSER_STATE_DIR: stateDir, ROOK_BACKEND: "standalone" },
    input: script,
    timeoutMs: 180000,
  });

  await new Promise((resolve) => server.close(resolve));
  await run(CLI, ["shutdown"], { env: { EGO_BROWSER_STATE_DIR: stateDir }, timeoutMs: 30000 });
  await rm(stateDir, { recursive: true, force: true }).catch(() => {});

  const output = `${result.stdout}\n${result.stderr}`.trim();
  console.log(output);

  const problems = [];
  if (result.code !== 0) problems.push(`CLI exited with code ${result.code}`);
  if (!result.stdout.includes("SMOKE OK")) problems.push("script did not reach SMOKE OK");

  // Re-check the snapshot grammar from the machine-readable step line.
  const stepLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith('{"step":"snapshot"'));
  if (!stepLine) {
    problems.push("snapshot step output missing");
  } else {
    const { content, refs } = JSON.parse(stepLine);
    checkSnapshotGrammar({ content, refs }, problems);
  }

  if (problems.length > 0) {
    console.error("\nSMOKE FAILED");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nSMOKE PASSED");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
