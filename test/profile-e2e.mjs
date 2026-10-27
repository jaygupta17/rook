#!/usr/bin/env node
/**
 * The product model, proved through the CLI against the real app.
 *
 *   node test/profile-e2e.mjs                 # starts its own Xvfb + app
 *   node test/profile-e2e.mjs --display :131  # use an X server that is already up
 *
 * One profile is one storage boundary and a space is a tab set inside it, so:
 *
 *   1. space A signs in on a local fixture (localStorage + cookie);
 *   2. space B, a second space of the *same* profile, is already signed in;
 *   3. space C, in a second profile, is signed out;
 *   4. handing A off makes a click fail with `EGO_TASK_SPACE_USER_IN_CONTROL`,
 *      and the click is not counted;
 *   5. `takeOverTaskSpace` lets the same click through.
 *
 * Every step is a real `ego-browser nodejs` round — the CLI, the vendored SDK
 * and the app's control socket — not a raw RPC call. Each round prints one
 * `PROOF {json}` line; the assertions below read those lines. Needs
 * `host/build/bin/rook`, the vendored SDK build and an X server (Xvfb is started
 * when the display is dead). Chrome is not used at all.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HostControlClient } from "../runtime/backends/host.js";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(HERE, "bin", "ego-browser");
const HOST_BIN = process.env.ROOK_HOST_BIN || join(HERE, "host", "build", "bin", "rook");
const FIXTURES = join(HERE, "test", "fixtures");
const SDK_PATH =
  process.env.EGO_BROWSER_SDK_PATH ||
  join(HERE, "vendor", "ego-browser", "dist", "out", "index.js");

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const DISPLAY = argValue("--display", process.env.ROOK_DISPLAY || process.env.DISPLAY || ":139");
const keepTemp = process.argv.includes("--keep");
const ROUND_TIMEOUT_MS = 120000;

let failures = 0;
let checks = 0;
const children = [];

function check(condition, message, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(` ok  ${message}\n`);
    return true;
  }
  failures += 1;
  process.stderr.write(`FAIL ${message}${detail === undefined ? "" : `\n     ${detail}`}\n`);
  return false;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function track(child) {
  children.push(child);
  return child;
}

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

function run(command, argv, { env = {}, timeoutMs = ROUND_TIMEOUT_MS } = {}) {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    const child = track(
      spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error?.message || error}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

// --- display and fixture server -------------------------------------------

async function displayAlive() {
  const probe = await run("/usr/bin/env", ["xdpyinfo", "-display", DISPLAY], { timeoutMs: 10000 });
  return probe.code === 0;
}

async function ensureDisplay() {
  if (await displayAlive()) return null;
  for (const candidate of [
    process.env.ROOK_XVFB_BIN,
    "/tmp/opencode/xvfb-root/usr/bin/Xvfb",
    "Xvfb",
  ]) {
    if (!candidate) continue;
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const xvfb = track(
      spawn(candidate, [DISPLAY, "-screen", "0", "1280x820x24", "-nolisten", "tcp", "-ac"], {
        stdio: "ignore",
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [process.env.ROOK_XVFB_LIB, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        },
      }),
    );
    xvfb.on("error", () => {});
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await sleep(100);
      if (await displayAlive()) return xvfb;
    }
    xvfb.kill("SIGKILL");
  }
  return null;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

/** A tiny static server: the fixture is one page and one origin for every space. */
async function startFixtures() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const file = join(FIXTURES, path === "/" ? "session.html" : path);
    if (!file.startsWith(FIXTURES)) {
      response.writeHead(403).end("no");
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

// --- the app ---------------------------------------------------------------

async function startApp({ runtimeDir, dataRoot, socketPath, logPath }) {
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const log = createWriteStream(logPath);
  const app = track(
    spawn(
      HOST_BIN,
      [
        "--data-root",
        dataRoot,
        "--socket-path",
        socketPath,
        "--window-size",
        "1280x820",
      ],
      {
        env: {
          ...process.env,
          DISPLAY,
          XDG_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataRoot,
          HOME: dirname(dataRoot),
          ROOK_CEF_EXTRA_FLAGS: "password-store=basic",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    ),
  );
  app.stderr.pipe(log);
  app.on("error", (error) => {
    process.stderr.write(`app failed to start: ${error?.message || error}\n`);
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const client = new HostControlClient({ socketPath });
      await client.connect(1000);
      const info = await client.request("getInfo", {}, { timeoutMs: 5000 });
      // Keep this one connection: it is the clean shutdown path.
      return { app, client, info };
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`the app never answered on ${socketPath}; see ${logPath}`);
}

// --- rounds ----------------------------------------------------------------

/** The last `PROOF {json}` line a round printed. */
function proof(round) {
  const lines = round.stdout.split("\n").filter((line) => line.startsWith("PROOF "));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice("PROOF ".length));
  } catch {
    return null;
  }
}

function roundEnv({ socketPath, stateDir, extra = {} }) {
  return {
    PATH: process.env.PATH,
    DISPLAY,
    ROOK_BACKEND: "host",
    ROOK_HOST_SOCKET: socketPath,
    ROOK_DEBUG: process.env.ROOK_DEBUG ?? "0",
    EGO_BROWSER_STATE_DIR: stateDir,
    EGO_BROWSER_SDK_PATH: SDK_PATH,
    ...extra,
  };
}

function roundSource(body) {
  return body;
}

const pageOf = `
async function pageOf(task) {
  const tabs = await task.tabs();
  const managed = tabs.find((tab) => tab.page && typeof tab.page.click === "function");
  if (managed) return managed.page;
  const first = tabs[0];
  if (!first) throw new Error("the task space has no tabs");
  return task.page(first.label);
}
`;

function roundOne(base) {
  return roundSource(`
const out = {};
const task = await taskSpace("proof A");
const page = task.page("p1");
await page.goto(${JSON.stringify(`${base}/session.html?as=alice`)});
out.before = await page.title();
await page.click("#signin");
out.after = await page.title();
out.spaceId = task.spaceId;
const work = await ego.createProfile("Work");
out.workProfileId = work.profileId;
out.workProfileName = work.name;
process.stdout.write("PROOF " + JSON.stringify(out) + "\\n");
`);
}

function roundTwo(base, workProfileId) {
  return roundSource(`
${pageOf}
const out = {};
const same = await taskSpace("proof B");
const samePage = same.page("p1");
await samePage.goto(${JSON.stringify(`${base}/session.html?as=bob`)});
out.sameProfile = await samePage.title();

const other = await taskSpace("proof C", { profileId: ${JSON.stringify(workProfileId)} });
const otherPage = other.page("p1");
await otherPage.goto(${JSON.stringify(`${base}/session.html?as=carol`)});
out.otherProfile = await otherPage.title();
out.profiles = (await profiles()).map((profile) => ({
  id: profile.id,
  name: profile.name,
  isDefault: profile.isDefault,
}));
process.stdout.write("PROOF " + JSON.stringify(out) + "\\n");
`);
}

function roundThree(base) {
  return roundSource(`
${pageOf}
const out = {};
const task = await taskSpace("proof A");
const page = await pageOf(task);
await page.goto(${JSON.stringify(`${base}/session.html?as=alice`)});
out.before = await page.title();
await task.handOff();
out.handedOff = true;
try {
  await page.click("#click");
  out.click = "allowed";
} catch (error) {
  out.click = "refused";
  out.error_code = error?.error_code ?? null;
  out.message = String(error?.message ?? "").split("\\n")[0];
}
process.stdout.write("PROOF " + JSON.stringify(out) + "\\n");
`);
}

function roundFour() {
  return roundSource(`
${pageOf}
const out = {};
const task = await takeOverTaskSpace("proof A");
const page = await pageOf(task);
out.before = await page.title();
await page.click("#click");
out.after = await page.title();
process.stdout.write("PROOF " + JSON.stringify(out) + "\\n");
`);
}

// --- main ------------------------------------------------------------------

async function main() {
  for (const [what, path] of [
    ["the app binary", HOST_BIN],
    ["the CLI", CLI],
    ["the SDK build", SDK_PATH],
  ]) {
    if (!existsSync(path)) throw new Error(`${what} is missing: ${path}`);
  }

  const xvfb = await ensureDisplay();
  if (!(await displayAlive())) throw new Error(`no X display at ${DISPLAY}`);
  void xvfb;

  const root = await mkdtemp(join(tmpdir(), "rook-profile-e2e-"));
  const runtimeDir = join(root, "run");
  const dataRoot = join(root, "data");
  const stateDir = join(root, "state");
  const socketPath = join(runtimeDir, `rook-${process.getuid?.() ?? 0}.sock`);
  const appLog = join(root, "app.log");
  const fixtures = await startFixtures();

  let app = null;
  try {
    app = await startApp({ runtimeDir, dataRoot, socketPath, logPath: appLog });
    check(
      app.info?.protocol === "3",
      "the app speaks protocol 3",
      JSON.stringify({ version: app.info?.version, protocol: app.info?.protocol }),
    );

    const env = roundEnv({ socketPath, stateDir });
    const cli = (...argv) => run(CLI, ["nodejs", "-e", ...argv], { env });

    // 1. space A signs in on the fixture ------------------------------------
    const one = await cli(roundOne(fixtures.base));
    const proofOne = proof(one);
    if (!proofOne) {
      throw new Error(`round 1 produced no proof: ${one.stderr || one.stdout}`);
    }
    check(
      one.code === 0,
      "round 1 (space A) ran through the CLI",
      one.stderr.trim(),
    );
    check(proofOne.before === "signed-in=none;clicks=0", "space A starts signed out", proofOne.before);
    check(proofOne.after === "signed-in=alice;clicks=0", "space A signs in on the fixture", proofOne.after);
    check(
      typeof proofOne.workProfileId === "string" && proofOne.workProfileId !== "",
      "a second profile can be created through the runtime",
      JSON.stringify(proofOne),
    );

    // 2. same profile shares, the other profile does not --------------------
    const two = await cli(roundTwo(fixtures.base, proofOne.workProfileId));
    const proofTwo = proof(two);
    if (!proofTwo) {
      throw new Error(`round 2 produced no proof: ${two.stderr || two.stdout}`);
    }
    check(two.code === 0, "round 2 (spaces B and C) ran through the CLI", two.stderr.trim());
    check(
      proofTwo.sameProfile === "signed-in=alice;clicks=0",
      "space B, in the same profile, is already signed in as A",
      proofTwo.sameProfile,
    );
    check(
      proofTwo.otherProfile === "signed-in=none;clicks=0",
      "space C, in the second profile, is signed out",
      proofTwo.otherProfile,
    );
    const defaults = (proofTwo.profiles ?? []).filter((profile) => profile.isDefault);
    check(
      defaults.length === 1 && (proofTwo.profiles ?? []).some((profile) => profile.id === proofOne.workProfileId),
      "the CLI's profiles() lists both profiles with one default",
      JSON.stringify(proofTwo.profiles),
    );
    check(
      (proofTwo.profiles ?? []).every(
        (profile) =>
          typeof profile.id === "string" &&
          profile.id !== "" &&
          typeof profile.name === "string" &&
          typeof profile.isDefault === "boolean",
      ),
      "every profile is in the shape the SDK requires",
      JSON.stringify(proofTwo.profiles),
    );

    // 3. handoff blocks a mutation ------------------------------------------
    const three = await cli(roundThree(fixtures.base));
    const proofThree = proof(three);
    if (!proofThree) {
      throw new Error(`round 3 produced no proof: ${three.stderr || three.stdout}`);
    }
    check(
      proofThree.handedOff === true,
      "task.handOff() reached the app",
      JSON.stringify(proofThree),
    );
    check(
      proofThree.click === "refused",
      "a click during handoff is refused",
      JSON.stringify(proofThree),
    );
    check(
      proofThree.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
      "the refusal carries the exact ego code",
      JSON.stringify(proofThree),
    );
    process.stdout.write(`     the SDK saw: ${JSON.stringify(proofThree.message)}\n`);

    // 4. takeover lets the same mutation through ----------------------------
    const four = await cli(roundFour());
    const proofFour = proof(four);
    if (!proofFour) {
      throw new Error(`round 4 produced no proof: ${four.stderr || four.stdout}`);
    }
    check(four.code === 0, "round 4 (takeover) ran through the CLI", four.stderr.trim());
    check(
      proofFour.before === "signed-in=alice;clicks=0",
      "the refused click was not counted",
      proofFour.before,
    );
    check(
      proofFour.after === "signed-in=alice;clicks=1",
      "the same click works after takeOverTaskSpace()",
      proofFour.after,
    );

    // The app agrees with both sides: ownership and the space's profile.
    const spaces = await app.client.request("listSpaces");
    const handed = spaces?.spaces?.find((space) => space.name === "proof A");
    check(
      handed?.ownership === "agent",
      "the app reports the space as agent-owned after the takeover",
      JSON.stringify(handed),
    );
    check(
      handed?.profileId === "default",
      "space A lives in the app's default profile",
      JSON.stringify(handed),
    );
    const otherProfileSpace = spaces?.spaces?.find((space) => space.name === "proof C");
    check(
      otherProfileSpace?.profileId === proofOne.workProfileId,
      "space C really lives in the second profile",
      JSON.stringify(otherProfileSpace),
    );
    check(
      otherProfileSpace?.cache !== handed?.cache && typeof otherProfileSpace?.cache === "string",
      "the two profiles read different storage directories",
      `${handed?.cache} vs ${otherProfileSpace?.cache}`,
    );
  } finally {
    if (app) {
      await app.client.request("quit", {}, { timeoutMs: 3000 }).catch(() => {});
      app.client.close();
      if (app.app.exitCode === null) {
        await Promise.race([
          new Promise((resolveExit) => app.app.once("close", resolveExit)),
          sleep(3000),
        ]);
        if (app.app.exitCode === null) app.app.kill("SIGKILL");
      }
    }
    fixtures.server.close();
    killChildren();
    if (keepTemp) {
      process.stdout.write(`kept ${root}\n`);
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (failures > 0) {
    process.stderr.write(`\nPROFILE E2E FAILED (${failures} of ${checks} checks)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nPROFILE E2E PASSED (${checks} checks)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  killChildren();
  process.exitCode = 1;
});
