/**
 * Host-backend test: the bridge driving the native app's control socket, with a
 * stub host instead of CEF (test/host-stub.mjs). No browser and no app needed.
 *
 *   node test/host-backend.mjs
 *
 * What it covers: backend selection, JSON-RPC framing and id correlation, the
 * task-space/tab mapping onto host ops, the three DevTools calls the app
 * re-maps (`Target.createTarget`, `Target.activateTarget`, `Target.closeTarget`),
 * `Target.getTargets` narrowing, push filtering, and reconnect after EOF.
 * The real app is exercised by scripts/demo-host.mjs and the upstream E2E slice.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEgoRuntime } from "../runtime/index.js";
import { resetBackendSelection, resolveSelection } from "../runtime/backends/index.js";
import { StubHost } from "./host-stub.mjs";

let failures = 0;
let checks = 0;

function check(condition, message, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(` - ${message}${detail ? `\n   ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "rook-host-"));
  const socketPath = join(root, "rook-000.sock");
  process.env.EGO_BROWSER_STATE_DIR = join(root, "state");
  process.env.ROOK_HOST_SOCKET = socketPath;
  process.env.ROOK_BACKEND = "host";
  resetBackendSelection();

  // -- the app is not running --------------------------------------------
  const missing = await createEgoRuntime();
  const noApp = await missing.createTaskSpace("no app");
  check(
    typeof noApp?.error === "string" && /Rook app|control socket/i.test(noApp.error),
    "a missing app is reported instead of launching Chrome",
    JSON.stringify(noApp),
  );
  check(
    noApp?.error_code === "EGO_BROWSER_UNAVAILABLE",
    "a missing app uses EGO_BROWSER_UNAVAILABLE",
    noApp?.error_code,
  );
  await missing.dispose();

  // -- backend selection --------------------------------------------------
  process.env.ROOK_BACKEND = "";
  resetBackendSelection();
  const autoWithoutApp = await resolveSelection({ requested: undefined });
  check(
    autoWithoutApp.mode === "standalone",
    "auto-detection falls back to standalone when no socket answers",
    autoWithoutApp.mode,
  );

  const stub = await new StubHost({ socketPath }).start();
  process.env.ROOK_BACKEND = "host";
  resetBackendSelection();
  const autoWithApp = await resolveSelection({ requested: undefined });
  check(
    autoWithApp.mode === "host" && autoWithApp.socketPath === socketPath,
    "a live control socket is chosen automatically",
    JSON.stringify(autoWithApp),
  );
  const forced = await resolveSelection({
    requested: "standalone",
    env: { ...process.env, ROOK_BACKEND: "host" },
  });
  check(forced.mode === "standalone", "--standalone overrides the environment", forced.mode);
  resetBackendSelection();

  // -- the surface, over the socket --------------------------------------
  const replies = [];
  const sendErrors = [];
  const ego = createEgoRuntime();
  ego.onCDPMessage = (text) => replies.push(JSON.parse(text));
  ego.onSendCDPMessageError = (message, code) => sendErrors.push({ message, code });

  const space = await ego.createTaskSpace("stub space");
  check(space?.id === 1, "createTaskSpace allocates the first numeric id", JSON.stringify(space));
  check(space?.ownership === "agent", "a new space is agent-owned", space?.ownership);
  check(stub.countCalls("createSpace") === 1, "createSpace reached the host");
  const blanks = stub.cdpFrames.length === 0 && stub.countCalls("createTab") === 1;
  check(blanks, "a new space asks the host for exactly one tab");

  const hostSpaceId = [...stub.spaces.keys()][0];
  const firstTab = [...stub.tabs.values()][0];
  const tabs = await ego.listTabs();
  check(
    tabs.tabs?.length === 1 && tabs.tabs[0].targetId === firstTab.targetId,
    "listTabs reports the DevTools target of the host tab",
    JSON.stringify(tabs),
  );
  check(tabs.tabs?.[0]?.active === true, "the single tab is active", JSON.stringify(tabs.tabs));
  check(
    stub.framesFor(firstTab.tabId, "Target.getTargetInfo").length === 1,
    "the target id is learned with Target.getTargetInfo on that browser",
  );

  const created = await ego.createTab("http://example.invalid/");
  check(
    /^T-tb\d+$/.test(created?.targetId ?? ""),
    "createTab returns a DevTools target id, not the host tab id",
    JSON.stringify(created),
  );
  check(stub.countCalls("createTab") === 2, "createTab went through the host op");
  check(
    stub.framesFor(firstTab.tabId, "Target.createTarget").length === 0,
    "Target.createTarget is never sent to the host",
  );
  const afterCreate = await ego.listTabs();
  check(afterCreate.tabs.length === 2, "the new tab is listed", JSON.stringify(afterCreate.tabs));
  check(
    afterCreate.tabs[1].active && !afterCreate.tabs[0].active,
    "the new tab is the active one",
    JSON.stringify(afterCreate.tabs),
  );

  // -- CDP round trip ----------------------------------------------------
  ego.sendCDPMessage(
    JSON.stringify({
      id: 11,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1", returnByValue: true },
      sessionId: "S-session",
    }),
  );
  await waitFor("evaluate reply", () => replies.some((reply) => reply.id === 11));
  const evaluateReply = replies.find((reply) => reply.id === 11);
  check(
    evaluateReply?.result?.result?.value === "stub",
    "a harness reply comes back with its own id and payload",
    JSON.stringify(evaluateReply),
  );
  check(
    stub.cdpFrames.some(
      (frame) => frame.method === "Runtime.evaluate" && frame.sessionId === "S-session",
    ),
    "the harness sessionId is passed through untouched",
  );

  // -- getTargets narrowing ---------------------------------------------
  ego.sendCDPMessage(JSON.stringify({ id: 12, method: "Target.getTargets", params: {} }));
  await waitFor("getTargets reply", () => replies.some((reply) => reply.id === 12));
  const targetsReply = replies.find((reply) => reply.id === 12);
  const targetIds = (targetsReply?.result?.targetInfos ?? []).map((info) => info.targetId);
  check(
    !targetIds.includes("T-foreign-page"),
    "another space's page is filtered out of Target.getTargets",
    JSON.stringify(targetIds),
  );
  check(
    targetIds.includes("T-iframe"),
    "the space's own iframe target survives the filter",
    JSON.stringify(targetIds),
  );

  // -- refused calls -----------------------------------------------------
  ego.sendCDPMessage(JSON.stringify({ id: 13, method: "Target.createTarget", params: { url: "about:blank" } }));
  await waitFor("createTarget refusal", () => replies.some((reply) => reply.id === 13));
  const refusal = replies.find((reply) => reply.id === 13);
  check(
    refusal?.error?.code === -32601 && /createTab/.test(refusal.error.message),
    "Target.createTarget is refused with advice to use createTab",
    JSON.stringify(refusal),
  );
  check(
    !stub.cdpFrames.some((frame) => frame.method === "Target.createTarget"),
    "the refused createTarget never reached the host",
  );

  const foreignBefore = stub.cdpFrames.length;
  ego.sendCDPMessage(
    JSON.stringify({ id: 14, method: "Target.attachToTarget", params: { targetId: "T-foreign-page" } }),
  );
  await waitFor("attach refusal", () => replies.some((reply) => reply.id === 14));
  const attachRefusal = replies.find((reply) => reply.id === 14);
  check(
    attachRefusal?.error?.code === -32602,
    "attaching to another space's target is refused",
    JSON.stringify(attachRefusal),
  );
  check(
    stub.cdpFrames
      .slice(foreignBefore)
      .every((frame) => frame.method !== "Target.attachToTarget"),
    "the refused attach never reached the host",
  );

  // -- activateTarget / closeTarget are re-mapped -------------------------
  ego.sendCDPMessage(
    JSON.stringify({ id: 15, method: "Target.activateTarget", params: { targetId: firstTab.targetId } }),
  );
  await waitFor("activate reply", () => replies.some((reply) => reply.id === 15));
  check(
    stub.countCalls("activateTab") === 1 && stub.spaces.get(hostSpaceId).activeTabId === firstTab.tabId,
    "Target.activateTarget becomes the host's activateTab",
    stub.spaces.get(hostSpaceId).activeTabId,
  );
  check(
    replies.find((reply) => reply.id === 15)?.result !== undefined,
    "the re-mapped activateTarget still answers the harness",
  );

  // -- a session routes back to its own tab -------------------------------
  // `created` (the second tab) is no longer active: the call above activated the
  // first tab. Its session must still reach the second tab's browser.
  const secondTabId = created.targetId.slice(2);
  ego.sendCDPMessage(
    JSON.stringify({
      id: 18,
      method: "Target.attachToTarget",
      params: { targetId: created.targetId, flatten: true },
    }),
  );
  await waitFor("attach reply", () => replies.some((reply) => reply.id === 18));
  const attachReply = replies.find((reply) => reply.id === 18);
  check(
    typeof attachReply?.result?.sessionId === "string",
    "Target.attachToTarget is passed through to the tab's browser",
    JSON.stringify(attachReply),
  );
  ego.sendCDPMessage(
    JSON.stringify({
      id: 19,
      method: "Runtime.evaluate",
      params: { expression: "location.href", returnByValue: true },
      sessionId: attachReply.result.sessionId,
    }),
  );
  await waitFor("session reply", () => replies.some((reply) => reply.id === 19));
  check(
    stub
      .framesFor(secondTabId, "Runtime.evaluate")
      .some((frame) => frame.sessionId === attachReply.result.sessionId),
    "a session-only frame reaches the tab the session belongs to",
    stub.cdpFrames.map((frame) => `${frame.browserId}:${frame.method}`).join(" "),
  );

  // -- closeTarget is re-mapped ------------------------------------------
  ego.sendCDPMessage(
    JSON.stringify({ id: 16, method: "Target.closeTarget", params: { targetId: created.targetId } }),
  );
  await waitFor("close reply", () => replies.some((reply) => reply.id === 16));
  check(
    stub.countCalls("closeTab") === 1 && !stub.tabs.has(secondTabId),
    "Target.closeTarget becomes the host's closeTab",
    [...stub.tabs.keys()].join(","),
  );
  check(
    replies.find((reply) => reply.id === 16)?.result?.success === true,
    "the re-mapped closeTarget reports success",
  );

  // -- pushes -----------------------------------------------------------
  const beforePush = replies.length;
  stub.emitEvent(firstTab.tabId, JSON.stringify({ method: "Page.loadEventFired" }));
  await waitFor("own push", () => replies.length > beforePush);
  check(
    replies[replies.length - 1].method === "Page.loadEventFired",
    "a push for this space's tab reaches the harness",
    JSON.stringify(replies[replies.length - 1]),
  );
  const beforeForeignPush = replies.length;
  stub.emitEvent("tb-elsewhere", JSON.stringify({ method: "Page.loadEventFired" }));
  await sleep(100);
  check(
    replies.length === beforeForeignPush,
    "a push for another space's browser is dropped",
    JSON.stringify(replies.slice(beforeForeignPush)),
  );

  // -- ownership --------------------------------------------------------
  const handed = await ego.handOffTaskSpace();
  check(/handed off/.test(String(handed)), "handOffTaskSpace reports the handoff", String(handed));
  check(stub.countCalls("handOff") === 1, "handOff reached the host");
  ego.sendCDPMessage(JSON.stringify({ id: 17, method: "Runtime.evaluate", params: {} }));
  await waitFor("user control error", () => sendErrors.length > 0);
  check(
    sendErrors[0]?.code === "EGO_TASK_SPACE_USER_IN_CONTROL",
    "a handed-off space refuses sends with the user-control code",
    JSON.stringify(sendErrors[0]),
  );
  const taken = await ego.takeOverTaskSpace();
  check(/taken over/.test(String(taken)), "takeOverTaskSpace reports the takeover", String(taken));
  check(stub.countCalls("takeOver") === 1, "takeOver reached the host");

  // -- agent chrome ------------------------------------------------------
  await ego.setAgentTaskState("reading");
  await ego.animationHighlightMouseToPosition(12, 34);
  check(stub.countCalls("setAgentTaskState") === 1, "setAgentTaskState reached the host");
  check(stub.countCalls("highlightMouseTo") === 1, "highlightMouseTo reached the host");

  // -- DevTools target lifecycle synthesised from host pushes -------------
  // This is the popup path: the app knows the opener, CEF's target does not.
  const targetEvents = (method) => replies.filter((reply) => reply.method === method);

  const earlyPopup = stub.addTab(hostSpaceId, {
    url: "http://popup.invalid/early",
    openerTabId: firstTab.tabId,
    windowName: "_blank",
  });
  stub.push("tab.created", {
    spaceId: hostSpaceId,
    tabId: earlyPopup.tabId,
    url: earlyPopup.url,
    openerTabId: firstTab.tabId,
    windowName: "_blank",
  });
  await sleep(250);
  check(
    targetEvents("Target.targetCreated").length === 0,
    "no targetCreated is emitted before the client asks for discovery",
    JSON.stringify(replies.slice(-2)),
  );

  // The baseline has to carry the attribution the (missed) push would have.
  const baseline = await ego.listTabs();
  check(
    baseline.tabs.find((tab) => tab.targetId === earlyPopup.targetId)?.openerId ===
      firstTab.targetId,
    "listTabs reports the opener target of a popup the client never saw created",
    JSON.stringify(baseline.tabs),
  );

  ego.sendCDPMessage(
    JSON.stringify({ id: 30, method: "Target.setDiscoverTargets", params: { discover: true } }),
  );
  await waitFor("discover reply", () => replies.some((reply) => reply.id === 30));

  const livePopup = stub.addTab(hostSpaceId, {
    url: "about:blank",
    openerTabId: firstTab.tabId,
    windowName: "probe_popup",
  });
  stub.push("tab.created", {
    spaceId: hostSpaceId,
    tabId: livePopup.tabId,
    url: "http://popup.invalid/live",
    openerTabId: firstTab.tabId,
    windowName: "probe_popup",
  });
  await waitFor("popup targetCreated", () =>
    targetEvents("Target.targetCreated").some(
      (reply) => reply.params?.targetInfo?.targetId === livePopup.targetId,
    ),
  );
  const popupCreated = targetEvents("Target.targetCreated").find(
    (reply) => reply.params?.targetInfo?.targetId === livePopup.targetId,
  )?.params?.targetInfo;
  check(popupCreated?.type === "page", "the synthesised popup target is a page", JSON.stringify(popupCreated));
  check(
    popupCreated?.openerId === firstTab.targetId,
    "the synthesised popup target names the opener's target id",
    JSON.stringify(popupCreated),
  );
  check(
    popupCreated?.canAccessOpener === true,
    "the synthesised popup target can access its opener",
    JSON.stringify(popupCreated),
  );
  check(
    popupCreated?.attached === false,
    "a target nobody attached to reports attached:false",
    JSON.stringify(popupCreated),
  );

  // CEF's own discovery says canAccessOpener:false and no openerId, so a second
  // event for the same target would only teach the SDK the wrong answer.
  const createdCount = targetEvents("Target.targetCreated").length;
  stub.emitEvent(
    firstTab.tabId,
    JSON.stringify({
      method: "Target.targetCreated",
      params: { targetInfo: { ...popupCreated, canAccessOpener: false, openerId: undefined } },
    }),
  );
  await sleep(120);
  check(
    targetEvents("Target.targetCreated").length === createdCount,
    "a CEF targetCreated for the same target is not passed on twice",
    JSON.stringify(replies.slice(-2)),
  );

  ego.sendCDPMessage(
    JSON.stringify({
      id: 31,
      method: "Target.attachToTarget",
      params: { targetId: livePopup.targetId, flatten: true },
    }),
  );
  await waitFor("popup attach reply", () => replies.some((reply) => reply.id === 31));
  check(
    replies.find((reply) => reply.id === 31)?.result?.sessionId === `S-${livePopup.targetId}`,
    "the SDK can attach to the popup target itself",
    JSON.stringify(replies.find((reply) => reply.id === 31)),
  );
  check(
    stub.framesFor(livePopup.tabId, "Target.attachToTarget").length === 1 &&
      stub.framesFor(firstTab.tabId, "Target.attachToTarget").length === 0,
    "the popup attach is delivered to the popup's browser, not the opener's",
    stub.cdpFrames.map((frame) => `${frame.browserId}:${frame.method}`).join(" "),
  );

  const changesBefore = targetEvents("Target.targetInfoChanged").length;
  stub.push("tab.updated", {
    spaceId: hostSpaceId,
    tabId: livePopup.tabId,
    url: "http://popup.invalid/live-2",
  });
  await waitFor("popup targetInfoChanged", () =>
    targetEvents("Target.targetInfoChanged").some(
      (reply) => reply.params?.targetInfo?.targetId === livePopup.targetId,
    ),
  );
  const popupChanged = targetEvents("Target.targetInfoChanged").find(
    (reply) => reply.params?.targetInfo?.targetId === livePopup.targetId,
  )?.params?.targetInfo;
  check(
    popupChanged?.url === "http://popup.invalid/live-2",
    "tab.updated becomes targetInfoChanged with the new url",
    JSON.stringify(popupChanged),
  );
  check(
    popupChanged?.openerId === firstTab.targetId,
    "the synthesised change keeps the opener attribution",
    JSON.stringify(popupChanged),
  );

  stub.push("tab.updated", {
    spaceId: hostSpaceId,
    tabId: livePopup.tabId,
    url: "http://popup.invalid/live-2",
  });
  await sleep(200);
  check(
    targetEvents("Target.targetInfoChanged").length === changesBefore + 1,
    "an unchanged tab.updated is not repeated",
    String(targetEvents("Target.targetInfoChanged").length),
  );

  stub.tabs.delete(livePopup.tabId);
  stub.push("tab.closed", { spaceId: hostSpaceId, tabId: livePopup.tabId });
  await waitFor("popup targetDestroyed", () =>
    replies.some(
      (reply) =>
        reply.method === "Target.targetDestroyed" &&
        reply.params?.targetId === livePopup.targetId,
    ),
  );
  stub.emitEvent(
    firstTab.tabId,
    JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: livePopup.targetId } }),
  );
  await sleep(120);
  check(
    replies.filter(
      (reply) =>
        reply.method === "Target.targetDestroyed" &&
        reply.params?.targetId === livePopup.targetId,
    ).length === 1,
    "a closed tab destroys its target exactly once",
    JSON.stringify(replies.filter((reply) => reply.method === "Target.targetDestroyed")),
  );

  stub.tabs.delete(earlyPopup.tabId);
  stub.push("tab.closed", { spaceId: hostSpaceId, tabId: earlyPopup.tabId });
  await sleep(200);

  // -- reconnect after EOF ----------------------------------------------
  await stub.stop();
  let survivorError = null;
  try {
    await ego.listTabs();
  } catch (error) {
    survivorError = error;
  }
  check(
    survivorError && /Rook app|control socket|control connection/i.test(survivorError.message),
    "losing the app gives a clear error, not a hang",
    survivorError?.message,
  );

  await stub.start();
  const revived = await ego.listTabs();
  check(
    revived.tabs?.length === 1 && revived.tabs[0].targetId === firstTab.targetId,
    "the next call reconnects once the app is back",
    JSON.stringify(revived),
  );

  // -- close ------------------------------------------------------------
  const closed = await ego.closeTaskSpace();
  check(String(closed).includes("closed"), "closeTaskSpace reports the close", String(closed));
  check(stub.countCalls("closeSpace") === 1, "closeSpace reached the host");
  const remaining = await ego.listTaskSpaces();
  check(remaining.taskSpaces.length === 0, "a closed space disappears from listTaskSpaces");

  await ego.dispose();
  await stub.stop();
  await rm(root, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nHOST BACKEND FAILED (${failures} of ${checks} checks)`);
    process.exitCode = 1;
    return;
  }
  console.log(`HOST BACKEND PASSED (${checks} checks)`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
