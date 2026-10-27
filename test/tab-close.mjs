/**
 * A page that dies under a command must fail that command now, not at its
 * timeout (docs/evaluation.md, second review, task 10: "closing a tab while a
 * command waits still waits the full timeout").
 *
 *   node test/tab-close.mjs
 *
 * Everything here runs against the stub app (test/host-stub.mjs), so no CEF and
 * no X server are needed. `stub.holdMethods` makes a page never answer, which is
 * what an agent's `page.waitForSelector` looks like while it polls: a request is
 * in flight and nothing is coming back.
 *
 * The cases, all of which must settle in well under a second:
 *   - the tab is closed                    -> "Target closed: tab tbN was closed"
 *   - the task space is closed             -> "Target closed: its task space was closed"
 *   - the renderer crashes (Inspector)     -> "Target closed: the page's renderer went away"
 *   - the app dies (socket EOF)            -> "the Rook app closed the control connection..."
 *
 * and two that must NOT fail early:
 *   - a request the page answers still resolves,
 *   - a request the page does not answer stays pending (the timeout is still the
 *     only thing that ends a slow command; the real-clock case is the "control"
 *     case in docs/eval-logs/review2/wait-close.mjs).
 *
 * The error text matters as much as the timing: `Target closed` is the shape the
 * SDK classifies as a lost page session (vendor/ego-browser/src/
 * browser-runtime.ts:13-14), and `page-waits.ts:218-222` stops polling on it
 * when it names the page's own session. Any other wording is retried until the
 * wait's deadline, which is the bug this file guards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostBackend } from "../runtime/backends/host.js";
import { StubHost } from "./host-stub.mjs";

let failures = 0;
let checks = 0;

function check(condition, message, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(` - ${message}${detail === undefined ? "" : `\n   ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

/** Settle a promise into `{value, error, ms}` without letting it throw. */
function settled(promise) {
  const startedAt = Date.now();
  return promise.then(
    (value) => ({ value, error: null, ms: Date.now() - startedAt }),
    (error) => ({ value: null, error, ms: Date.now() - startedAt }),
  );
}

/** The closed-page error a frame listener saw for one request id. */
function replyFor(frames, id) {
  return frames.find((frame) => frame.data?.id === id) ?? null;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "rook-tab-close-"));
  const socketPath = join(root, "rook-000.sock");
  const stub = await new StubHost({ socketPath }).start();
  const backend = new HostBackend({ socketPath });
  const frames = [];
  backend.openFrameListener((frame) => frames.push(frame));
  // A request that the page never answers is exactly what a pending poll is.
  stub.holdMethods.add("Runtime.evaluate");

  let nextSpaceId = 1;
  /** A space with one live tab, its target and one attached session. */
  async function spaceWithPage(name) {
    const record = { id: nextSpaceId++, hostSpaceId: null, profileId: "default" };
    await backend.createSpace(name, record);
    const tab = await backend.createTab(record, "http://fixture.invalid/");
    const sessionId = await backend.attach(record, tab.targetId);
    const targetId = tab.targetId;
    const pendingRequest = () =>
      backend.request(record, targetId, "Runtime.evaluate", { expression: "1" }, sessionId);
    const inFlight = async () => {
      const pending = settled(pendingRequest());
      // The frame has to reach the app before the tab is closed, or the test
      // would be closing a tab nothing was waiting on.
      await waitFor(
        "the request reached the app",
        () => stub.framesFor(tab.tabId, "Runtime.evaluate").length >= 1,
      );
      // Wrapped: returning the promise from an async function would await it.
      return { pending };
    };
    return { record, tab, targetId, sessionId, pendingRequest, inFlight };
  }

  try {
    // -- a normal request still works --------------------------------------
    const healthy = await spaceWithPage("healthy");
    stub.holdMethods.delete("Runtime.evaluate");
    const good = await settled(healthy.pendingRequest());
    check(
      good.error === null && good.value?.result !== undefined,
      "an answered request still resolves",
      `${good.error?.message ?? JSON.stringify(good.value)}`,
    );
    stub.holdMethods.add("Runtime.evaluate");

    // -- the tab is closed while a request is in flight --------------------
    // One space holds a page plus its canonical blank tab, so a re-route to the
    // surviving tab is possible: that is the bug this guards.
    const tabCase = await spaceWithPage("tab close");
    const tabsInSpace = await backend.listTabs(tabCase.record);
    const sibling = tabsInSpace.find((tab) => tab.tabId !== tabCase.tab.tabId);
    check(Boolean(sibling), "the space has a second tab a command could be misrouted to");

    const { pending: tabPending } = await tabCase.inFlight();
    // A harness frame (what `ego.sendCDPMessage` sends) still waiting for its
    // reply: the SDK holds that promise, so the backend has to answer it.
    const harnessId = 5001;
    await backend.sendRaw(
      tabCase.record,
      JSON.stringify({
        id: harnessId,
        method: "Runtime.evaluate",
        params: { expression: "1" },
        sessionId: tabCase.sessionId,
      }),
    );
    await waitFor(
      "the harness frame reached the app",
      () => stub.framesFor(tabCase.tab.tabId, "Runtime.evaluate").length >= 2,
    );

    const closedAt = Date.now();
    stub.tabs.delete(tabCase.tab.tabId);
    stub.push("tab.closed", { spaceId: tabCase.record.hostSpaceId, tabId: tabCase.tab.tabId });
    const tabResult = await tabPending;
    const tabMs = Date.now() - closedAt;
    const harnessReply = replyFor(frames, harnessId);

    check(
      tabResult.error !== null,
      "closing a tab fails the request in flight",
      tabResult.value === null ? "" : JSON.stringify(tabResult.value),
    );
    check(
      /^Target closed: tab tb\d+ was closed$/.test(String(tabResult.error?.message ?? "")),
      'the tab-close error is the SDK\'s closed-page shape ("Target closed: tab tbN was closed")',
      String(tabResult.error?.message ?? tabResult.error),
    );
    check(
      tabResult.error?.sessionId === tabCase.sessionId,
      "the failure names the session it was sent on, which is what stops the SDK's poll",
      String(tabResult.error?.sessionId),
    );
    check(tabMs < 500, `the tab-close failure took ${tabMs}ms (want < 500ms)`);
    check(
      /^Target closed: tab tb\d+ was closed$/.test(String(harnessReply?.data?.error?.message ?? "")),
      "a harness frame waiting on the closed tab is answered, so the SDK's promise settles",
      harnessReply ? JSON.stringify(harnessReply.data) : "never answered",
    );
    check(
      harnessReply?.data?.id === harnessId && harnessReply?.data?.sessionId === tabCase.sessionId,
      "that reply carries the id and session the SDK sent",
      JSON.stringify(harnessReply?.data ?? null),
    );

    // -- a later command for that page does not go to a sibling tab --------
    const siblingDelivered = stub.framesFor(sibling.tabId, "Runtime.evaluate").length;
    await backend.sendRaw(
      tabCase.record,
      JSON.stringify({
        id: 4242,
        method: "Runtime.evaluate",
        params: { expression: "1" },
        sessionId: tabCase.sessionId,
      }),
    );
    const lateReply = replyFor(frames, 4242);
    check(
      lateReply?.data?.error?.message === `Target closed: tab ${tabCase.tab.tabId} was closed`,
      "a command on the closed page's session gets the same closed-page error",
      lateReply ? JSON.stringify(lateReply.data) : "no reply at all",
    );
    check(
      lateReply?.data?.sessionId === tabCase.sessionId,
      "the reply echoes the session the SDK sent, so it settles the right promise",
      lateReply ? JSON.stringify(lateReply.data) : "",
    );
    check(
      stub.framesFor(sibling.tabId, "Runtime.evaluate").length === siblingDelivered,
      "the closed page's command was NOT re-routed to the sibling tab",
    );

    // A command naming the closed *target* fails the same way.
    await backend.sendRaw(
      tabCase.record,
      JSON.stringify({ id: 4243, method: "Target.getTargetInfo", params: { targetId: tabCase.targetId } }),
    );
    check(
      /^Target closed: tab tb\d+ was closed$/.test(
        String(replyFor(frames, 4243)?.data?.error?.message ?? ""),
      ),
      "a command naming the closed target gets the closed-page error too",
      JSON.stringify(replyFor(frames, 4243)?.data ?? null),
    );

    // Attaching again is refused rather than silently opening a new page.
    const reattach = await settled(backend.attach(tabCase.record, tabCase.targetId));
    check(
      /^Target closed: tab tb\d+ was closed$/.test(String(reattach.error?.message ?? "")),
      "attaching to the closed target is refused with the same error",
      String(reattach.error?.message ?? reattach.value),
    );

    // -- the task space is closed while a request is in flight -------------
    const spaceCase = await spaceWithPage("space close");
    const { pending: spacePending } = await spaceCase.inFlight();
    const spaceClosedAt = Date.now();
    // The user closing the space: no per-tab `tab.closed` push, only the space.
    stub.spaces.delete(spaceCase.record.hostSpaceId);
    for (const [tabId, tab] of [...stub.tabs]) {
      if (tab.spaceId === spaceCase.record.hostSpaceId) stub.tabs.delete(tabId);
    }
    stub.push("space.closed", { spaceId: spaceCase.record.hostSpaceId });
    const spaceResult = await spacePending;
    const spaceMs = Date.now() - spaceClosedAt;
    check(
      spaceResult.error?.message === "Target closed: its task space was closed",
      "closing the space fails its in-flight request with its own message",
      String(spaceResult.error?.message ?? spaceResult.value),
    );
    check(spaceMs < 500, `the space-close failure took ${spaceMs}ms (want < 500ms)`);

    // -- the renderer crashes ----------------------------------------------
    const crashCase = await spaceWithPage("renderer crash");
    const { pending: crashPending } = await crashCase.inFlight();
    const crashAt = Date.now();
    stub.emitEvent(
      crashCase.tab.tabId,
      JSON.stringify({
        method: "Inspector.detached",
        params: { reason: "Render process gone." },
      }),
    );
    const crashResult = await crashPending;
    const crashMs = Date.now() - crashAt;
    check(
      /^Target closed: the page's renderer went away \(Inspector detached: Render process gone\.\)$/.test(
        String(crashResult.error?.message ?? ""),
      ),
      "a renderer crash fails the in-flight request with a crash message",
      String(crashResult.error?.message ?? crashResult.value),
    );
    check(crashMs < 500, `the renderer-crash failure took ${crashMs}ms (want < 500ms)`);

    // A crashed renderer can be revived by a navigation, so the tab keeps
    // routing: only the dead session is refused.
    stub.holdMethods.delete("Runtime.evaluate");
    const revived = await settled(
      backend.request(crashCase.record, crashCase.targetId, "Target.getTargetInfo", {}),
    );
    check(
      revived.error === null && typeof revived.value?.targetInfo?.targetId === "string",
      "the tab itself still works after a renderer crash",
      String(revived.error?.message ?? JSON.stringify(revived.value)),
    );
    stub.holdMethods.add("Runtime.evaluate");
    const deadSession = await settled(
      backend.request(crashCase.record, crashCase.targetId, "Runtime.evaluate", {}, crashCase.sessionId),
    );
    check(
      /^Target closed: the page's DevTools session was detached|^Target closed: the page's renderer went away/.test(
        String(deadSession.error?.message ?? ""),
      ),
      "the crashed page's dead session is refused instead of being reused",
      String(deadSession.error?.message ?? deadSession.value),
    );

    // -- a slow command is not failed early --------------------------------
    const slowCase = await spaceWithPage("slow");
    let slowSettled = null;
    const slow = settled(slowCase.pendingRequest());
    void slow.then((result) => {
      slowSettled = result;
    });
    await waitFor(
      "the slow request reached the app",
      () => stub.framesFor(slowCase.tab.tabId, "Runtime.evaluate").length >= 1,
    );
    await sleep(400);
    check(
      slowSettled === null,
      "a request the page has not answered is left alone until its timeout",
      JSON.stringify(slowSettled?.error?.message ?? slowSettled?.value),
    );

    // -- the app dies (socket EOF) -----------------------------------------
    const goneAt = Date.now();
    await stub.stop({ unlink: false });
    const slowResult = await slow;
    const goneMs = Date.now() - goneAt;
    check(
      /Rook app closed the control connection/.test(String(slowResult.error?.message ?? "")),
      "the app dying fails the in-flight request with the connection message",
      String(slowResult.error?.message ?? slowResult.value),
    );
    check(goneMs < 500, `the socket-EOF failure took ${goneMs}ms (want < 500ms)`);
  } finally {
    backend.close();
    await stub.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\nTAB CLOSE FAILED (${checks - failures}/${checks} checks)`);
    process.exitCode = 1;
    return;
  }
  console.log(`TAB CLOSE PASSED (${checks} checks)`);
}

const startedAt = Date.now();
await main();
// Every closed tab also clears its pending calls. If a request were left in the
// map behind a live 30 s timer, this process would sit here for 30 s.
const totalMs = Date.now() - startedAt;
if (totalMs > 10000) {
  console.error(` - the run took ${totalMs}ms: a closed tab probably left a timer behind`);
  process.exitCode = 1;
}
