/**
 * Restart-collision regression: a persisted space is never re-bound to a
 * `hostSpaceId` issued by a *different* app run.
 *
 *   node test/space-resume.mjs
 *
 * The app numbers its spaces from `sp1` on every launch, so a stale
 * `hostSpaceId` in `spaces.json` can name an unrelated space after a restart -
 * the reported symptom is `taskSpace("alpha")` returning beta's tab. Two stub
 * hosts with different pids stand in for two app runs here, and both runs hand
 * out `sp2`, which is exactly the collision. Needs no browser: the stub speaks
 * the control protocol (test/host-stub.mjs).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEgoRuntime } from "../runtime/index.js";
import { resetBackendSelection } from "../runtime/backends/index.js";
import { StubHost } from "./host-stub.mjs";

const ALPHA_URL = "data:text/html,<title>ALPHA</title><h1>ALPHA page</h1>";
const BETA_URL = "data:text/html,<title>BETA</title><h1>BETA page</h1>";
const APP_RUN_1 = 900001;
const APP_RUN_2 = 900002;

let failures = 0;
let checks = 0;

function check(condition, message, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(` - ${message}${detail ? `\n   ${detail}` : ""}`);
}

async function readState(stateDir) {
  return JSON.parse(await readFile(join(stateDir, "spaces.json"), "utf8"));
}

function spaceNamed(state, name) {
  return (state.spaces ?? []).find((space) => space.name === name) ?? null;
}

function urlsOf(tabs) {
  return (tabs?.tabs ?? []).map((tab) => tab.url);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "rook-resume-"));
  const socketPath = join(root, "rook-000.sock");
  const stateDir = join(root, "state");
  process.env.EGO_BROWSER_STATE_DIR = stateDir;
  process.env.ROOK_HOST_SOCKET = socketPath;
  process.env.ROOK_BACKEND = "host";

  // -- app run 1: alpha is the run's second space, `sp2` ------------------
  resetBackendSelection();
  const run1 = await new StubHost({ socketPath, pid: APP_RUN_1, firstSpaceNumber: 2 }).start();
  const firstRound = createEgoRuntime();
  const alpha = await firstRound.createTaskSpace("alpha");
  check(alpha?.id === 1, "run 1 allocates the first bridge space id", JSON.stringify(alpha));
  await firstRound.createTab(ALPHA_URL);
  await firstRound.listTabs();

  const afterRun1 = await readState(stateDir);
  check(
    spaceNamed(afterRun1, "alpha")?.hostSpaceId === "sp2",
    "the first run's space is host id sp2",
    JSON.stringify(afterRun1.spaces),
  );
  check(
    spaceNamed(afterRun1, "alpha")?.hostInstance === String(APP_RUN_1),
    "the record remembers which app run issued the host id",
    JSON.stringify(spaceNamed(afterRun1, "alpha")),
  );
  check(
    (spaceNamed(afterRun1, "alpha")?.recentTabUrls ?? []).includes(ALPHA_URL),
    "the record remembers the tab URLs to reopen",
    JSON.stringify(spaceNamed(afterRun1, "alpha")),
  );
  await firstRound.dispose();
  await run1.stop();

  // -- app run 2: a fresh process numbers its spaces the same way ---------
  resetBackendSelection();
  const run2 = await new StubHost({ socketPath, pid: APP_RUN_2, firstSpaceNumber: 2 }).start();
  const secondRound = createEgoRuntime();
  const beta = await secondRound.createTaskSpace("beta");
  await secondRound.createTab(BETA_URL);
  const betaTabs = await secondRound.listTabs();
  check(
    urlsOf(betaTabs).includes(BETA_URL),
    "run 2's beta space holds BETA",
    JSON.stringify(betaTabs),
  );
  const afterRun2 = await readState(stateDir);
  check(
    spaceNamed(afterRun2, "beta")?.hostSpaceId === "sp2",
    "run 2 hands beta the same id alpha's stale record claims",
    JSON.stringify(afterRun2.spaces),
  );

  // -- resume alpha, in another process of the same app run ---------------
  const resumeRound = createEgoRuntime();
  const listed = await resumeRound.listTaskSpaces();
  check(
    (listed.taskSpaces ?? []).some((space) => space.name === "alpha"),
    "a space from the previous app run stays listed (resumable by name)",
    JSON.stringify(listed.taskSpaces),
  );

  resumeRound.useTaskSpace(alpha.id);
  const resumedTabs = await resumeRound.listTabs();
  check(
    urlsOf(resumedTabs).includes(ALPHA_URL),
    "resuming alpha reopens the recorded tab",
    JSON.stringify(resumedTabs),
  );
  check(
    !urlsOf(resumedTabs).includes(BETA_URL),
    "resuming alpha never returns beta's tab",
    JSON.stringify(resumedTabs),
  );

  const afterResume = await readState(stateDir);
  const alphaRecord = spaceNamed(afterResume, "alpha");
  const betaRecord = spaceNamed(afterResume, "beta");
  check(
    alphaRecord?.hostInstance === String(APP_RUN_2),
    "the rebound record is stamped with the app run it now belongs to",
    JSON.stringify(alphaRecord),
  );
  check(
    alphaRecord?.hostSpaceId !== "sp2",
    "the stale host id is never reused",
    JSON.stringify(alphaRecord),
  );
  check(
    alphaRecord?.hostSpaceId !== betaRecord?.hostSpaceId,
    "the resumed space and the other agent's space hold different host ids",
    `${alphaRecord?.hostSpaceId} vs ${betaRecord?.hostSpaceId}`,
  );
  check(
    run2.spaces.get(alphaRecord?.hostSpaceId)?.name === "alpha",
    "the new host space is the one the app named alpha",
    JSON.stringify([...run2.spaces.values()]),
  );

  // -- beta is untouched by the resume ------------------------------------
  const betaRound = createEgoRuntime();
  betaRound.useTaskSpace(beta.id);
  const betaAgain = await betaRound.listTabs();
  check(
    urlsOf(betaAgain).includes(BETA_URL) && !urlsOf(betaAgain).includes(ALPHA_URL),
    "beta still sees its own tab after alpha was resumed",
    JSON.stringify(betaAgain),
  );

  // -- a second resume in the same app run does not recreate the space ----
  const createsBefore = run2.countCalls("createSpace");
  const again = createEgoRuntime();
  again.useTaskSpace(alpha.id);
  const againTabs = await again.listTabs();
  check(
    urlsOf(againTabs).includes(ALPHA_URL) && !urlsOf(againTabs).includes(BETA_URL),
    "a same-run resume keeps the rebound space",
    JSON.stringify(againTabs),
  );
  check(
    run2.countCalls("createSpace") === createsBefore,
    "a same-run resume does not create another host space",
    `${run2.countCalls("createSpace")} vs ${createsBefore}`,
  );

  // -- app gone: clear failure, no silent re-point ------------------------
  await run2.stop();
  resetBackendSelection();
  const offline = createEgoRuntime();
  offline.useTaskSpace(alpha.id);
  let offlineError = null;
  try {
    await offline.listTabs();
  } catch (error) {
    offlineError = error;
  }
  check(
    offlineError && /Rook app|control socket|control connection/i.test(offlineError.message),
    "with the app stopped, resuming fails with a clear error instead of re-pointing",
    offlineError?.message,
  );
  const afterOffline = await readState(stateDir);
  check(
    spaceNamed(afterOffline, "alpha")?.hostSpaceId === alphaRecord?.hostSpaceId,
    "a failed resume leaves the record untouched",
    JSON.stringify(spaceNamed(afterOffline, "alpha")),
  );

  await resumeRound.dispose();
  await betaRound.dispose();
  await again.dispose();
  await secondRound.dispose();
  await offline.dispose();
  await rm(root, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nSPACE RESUME FAILED (${failures} of ${checks} checks)`);
    process.exitCode = 1;
    return;
  }
  console.log(`SPACE RESUME PASSED (${checks} checks)`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
