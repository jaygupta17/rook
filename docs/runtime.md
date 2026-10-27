# Rook runtime internals

How the `ego-browser` command serves `globalThis.ego` on two backends, what
changes when the native app is the browser, and how the pieces are tested.

The front page is [../README.md](../README.md). The native shell's control
protocol lives in [../host/README.md](../host/README.md); packaging and the
performance numbers have their own reads in `../packaging/` and `../bench/`.

## Requirements

- Node.js **22 or newer** (the runtime uses the built-in `WebSocket`).
- One of two backends (see below):
  - **native app** — `host/build/bin/rook` running, its control socket
    live. Nothing else to install; CEF is inside the app.
  - **standalone** — a Chromium-family browser at `/usr/bin/google-chrome`,
    or `ROOK_CHROME` pointing at one.
- The SDK bundle from an ego-browser checkout: `dist/out/index.js` (build it
  with `npm ci && npm run build` in `package/ego-browser`). `scripts/build-sdk.sh`
  does that for a patched copy instead, under `vendor/ego-browser/dist/out/`
  (see **Clipboard on Linux**).

## Run a script

```sh
./bin/ego-browser nodejs --sdk-path /path/to/ego-browser/dist/out/index.js <<'JS'
const task = await taskSpace("demo")
const page = task.page("p1")
await page.goto("https://example.com")
console.log(await page.snapshot())
await task.finish({ keep: [] })
JS
```

The script comes from stdin, or from `-e '<code>'`. Without `--sdk-path` the
SDK is read from `EGO_BROWSER_SDK_PATH`.

## Backends

The same surface runs on two browsers, chosen once per process:

| Backend | Browser | A task space is | A tab is |
| --- | --- | --- | --- |
| `host` | the native app (`host/`) | a tab set inside a profile (`sp2`), sharing that profile's cookies and storage | a `browserId` on its control socket |
| `standalone` | Chrome, headless unless `ROOK_HEADFUL=1` | a Chromium browser context of one Chrome profile | a DevTools target |

**Selection.** `standalone` unless the app is *actually running*: the CLI probes
`$XDG_RUNTIME_DIR/rook-<uid>.sock` (then `/tmp/rook-<uid>.sock`) with a
real connect, so a stale socket file does not count. A round that started while
the app was down keeps using Chrome; start the app first if you want it.

- `ROOK_BACKEND=host|standalone|auto` forces one (`auto` is the default).
- `--standalone` on `nodejs` is the same as `ROOK_BACKEND=standalone`.
- An explicit `host` is strict: if the app is not there you get
  `the Rook app is not running (no control socket at ...)`, never a silent
  fallback to Chrome.
- `ego-browser backend` prints the choice and why.

```sh
$ ./bin/ego-browser backend
backend: host (auto)
socket:  /run/user/1000/rook-1000.sock
```

**What changes in host mode.** Tabs are created with `createTab`, closed with
`closeTab` and activated with `activateTab` — never with the DevTools `Target.*`
calls, because a DevTools-created browser is owned by no tab. The bridge
translates the three calls the SDK does send:

| the SDK sends | host mode does |
| --- | --- |
| `Target.createTarget` | refused with an error that names `createTab()` |
| `Target.activateTarget` | `activateTab{spaceId,tabId}` |
| `Target.closeTarget` | `closeTab{spaceId,tabId}` |

`Target.getTargets` is process-wide in CEF, so its *result* is narrowed to the
space's request context before the SDK sees it, and a `Target.attachToTarget`
for a target outside the space is refused rather than passed through. The same
narrowing carries the space's own cross-site iframe targets, so `snapshot()` and
the OOPIF cases still expand frames in host mode.

A tab id from the app is not a DevTools target id: the bridge reads the page
target with `Target.getTargetInfo` on that tab's browser and hands the SDK the
target id, so `listTabs`, refs and sessions all keep working unchanged.

**Profiles are a host-mode feature.** In the app, `listProfiles()` is the app's
list, a space is created *inside* a profile (`createTaskSpace(name, profileId)`)
and every space of that profile shares its cookies and storage. Standalone Chrome
has no such thing to report: a profile there is a separate Chrome with its own
user-data directory, `listProfiles()` lists the directories the bridge knows
about, and isolation is per task space (a browser context), which is what the
upstream suite relies on. The interface both backends implement
(`runtime/backends/index.js`) has `listProfiles`/`createProfile` in both; only
the app gives them the profile-is-the-boundary meaning.

## Commands

| Command | What it does |
| --- | --- |
| `ego-browser nodejs [--sdk-path <index.js>] [--standalone] [-e <script>]` | Run a script with `globalThis.ego` installed and the SDK helpers on the global object. |
| `ego-browser skill [--sdk-path <index.js>]` | Print the usage guide that ships beside the resolved SDK. |
| `ego-browser backend` | Print which backend this environment would use, and why. |
| `ego-browser shutdown` | Stop the Chrome processes this state directory started (the app is not touched). |
| `ego-browser --help` | Usage. |

Exit codes: `0` success, `1` script or runtime failure, `2` bad arguments.
A script that fails to parse gets a line/column diagnostic with the offending
source line and a caret.

## Environment

| Variable | Meaning |
| --- | --- |
| `EGO_BROWSER_SDK_PATH` | SDK bundle used when `--sdk-path` is absent. |
| `EGO_BROWSER_STATE_DIR` | Where task spaces, the browser record and locks live. Default `~/.config/rook/state`. The upstream E2E suite sets this to isolate each run. |
| `ROOK_BACKEND` | `host`, `standalone` or `auto` (default). See Backends. |
| `ROOK_HOST_SOCKET` | Control socket path, when the app is not on the default one. |
| `ROOK_HOME` | Root for durable browser profiles. Default `~/.local/state/rook`. |
| `ROOK_CHROME` | Chrome binary. Default `/usr/bin/google-chrome`. |
| `ROOK_NODE` | Node ≥ 22 binary for the launcher shim. |
| `ROOK_HEADFUL` | `1` launches standalone Chrome as a real window instead of `--headless=new`. Needed for `page.keyboard.paste`, which has no clipboard to read when headless. |
| `ROOK_DEBUG` | `1` prints the chosen backend, snapshot node counts and CDP command failures to stderr. |

## Clipboard on Linux

`page.keyboard.paste` needs a real OS clipboard. The SDK puts the content on it,
presses `Control+V` through the same CDP key path every platform uses, and puts
the previous clipboard back. Upstream only implements that for macOS
(`osascript`) and Windows (PowerShell) and refuses Linux with
`page.keyboard.paste requires macOS or Windows clipboard support`; our
`patches/0001-linux-clipboard.patch` adds the Linux half, and
`scripts/build-sdk.sh` applies it to a copy under `vendor/` instead of editing
the reference checkout.

```sh
scripts/build-sdk.sh          # -> vendor/ego-browser/dist/out/index.js
cat vendor/UPSTREAM           # commit, tag, patches applied, build time
export EGO_BROWSER_SDK_PATH=$PWD/vendor/ego-browser/dist/out/index.js

./bin/ego-browser nodejs -e '...'      # now uses the patched SDK
./bin/ego-browser skill | head          # its usage guide
```

What a paste needs, in the order it is looked for:

| Session | Commands | Package |
| --- | --- | --- |
| Wayland | `wl-paste --no-newline`, `wl-copy` | `wl-clipboard` |
| X11 | `xclip -selection clipboard -o`, `xclip -i` | `xclip` |
| X11 | `xsel --clipboard --output`, `xsel --clipboard --input` | `xsel` |

and a display the *agent process* can reach, because the clipboard tool runs
there and not inside the browser: `DISPLAY` for either backend, or
`WAYLAND_DISPLAY` on Wayland. Headless Chrome has no system clipboard at all
(its ozone platform is `headless`, so `Control+V` pastes nothing), which is why
standalone runs that paste start Chrome as a real window with
`ROOK_HEADFUL=1`. The native app always has a window; `host` mode only needs
`DISPLAY`.

With none of the three tools installed, `paste` fails with an error naming the
packages to install (`sudo apt install xclip`, or `wl-clipboard` on Wayland)
rather than pasting nothing, and `page.keyboard.insertText()` still inserts
plain text with no clipboard involved.

Two differences from macOS and Windows, both forced by the tools:

- **One representation per paste.** macOS and Windows publish text and HTML
  together; `xclip`, `wl-copy` and `xsel` each serve a single target. So
  `paste({ text, html })` carries the HTML (a rich editor gets the markup, a
  plain `<textarea>` gets nothing) and `paste("text")` carries UTF-8 text.
  `xsel` cannot carry HTML at all and falls back to the text.
- **Only text and HTML are restored.** The previous text (or HTML) is put back
  after the paste; a clipboard that held an image or a file is replaced. If
  another application takes the clipboard in between, `xclip` exits, the
  restore is skipped and the transaction reports `changed`, which is what the
  macOS/Windows change counter is for.

## How a task space maps onto Chrome

Both backends implement one interface, documented at the top of
`runtime/backends/index.js`; `standalone.js` is Chrome and `host.js` is the app.
Everything below is the Chrome half.

- One Chrome process per profile, headless by default, started with
  `--remote-debugging-port=0` and its own `--user-data-dir`.
- One `Target.createBrowserContext` per task space, plus one `about:blank` tab,
  so a new space exposes exactly the one `p1` tab the SDK insists on.
- `listTabs` is `Target.getTargets` filtered to the active context; `Target.*`
  responses and events from other contexts are dropped before they reach the
  SDK, which is what keeps concurrent spaces apart.
- Task spaces, ids, ownership and the active tab survive process exit in
  `spaces.json`; `browsers.json` records the running Chrome so a later run can
  reconnect instead of relaunching.
- Browsers are killed only when `/proc` still shows our own `--user-data-dir`,
  and orphaned ones are reaped once their state directory is gone.

## The native app backend

`runtime/backends/host.js`: a `HostControlClient` (newline-delimited JSON-RPC
over the app's unix socket: id map, push dispatch, reconnect-on-EOF) and a
`HostBackend` that shapes it like the Chrome one. The channel itself is
documented in `host/README.md`; this section is only the bridge's side.

- **Spaces** — `createTaskSpace` → `createSpace{name, profileId}` + one
  `createTab{url:"about:blank"}` (a new space must have exactly one tab), and
  `closeTaskSpace` → `closeSpace`. The app's own space id lives in `spaces.json`
  as `hostSpaceId`, together with the app run that issued it (`hostInstance`,
  from `getInfo.pid` plus the `/proc` start time). A space from a previous run is
  never re-bound to its old id — the app numbers spaces from `sp1` on every
  launch, so that number can name another agent's space. The bridge creates the
  space again under the same name in the same profile (`recentTabUrls` are
  reopened; the profile owns the storage, so logins survive) and re-stamps the
  record. `listTaskSpaces` still lists such a record so it can be resumed by
  name, and rows whose space is really gone are filtered out.
- **Profiles** — `listProfiles` is the app's list passed through, exactly the
  three fields the SDK checks (`id`, `name`, `isDefault`); the app's storage
  `path` is dropped. In host mode the app is the authority on profiles, so
  `createTaskSpace(name, profileId)` resolves the id against that list and an
  unknown one is `EGO_PROFILE_NOT_FOUND` with no space created.
  `ego.createProfile(name)` adds one (the SDK only lists them).
- **Tabs** — `createTab`/`closeTab`/`activateTab` are the host ops (navigation
  itself is ordinary CDP, so `Page.navigate` from the SDK needs nothing special).
  A row in `listTabs` is the app's tab id plus the DevTools target id read from
  `Target.getTargetInfo` on that tab's browser (`browserId == tab id`).
- **Sessions** — the SDK's `Target.attachToTarget` is passed through to that
  tab's browser, so `sessionId`s, replies and events keep their shape; the only
  difference is that every frame names a `browserId` instead of relying on one
  WebSocket per profile.
- **`useTaskSpace` does not touch the window.** CDP works on a space the window
  is not showing, and the app wakes a parked tab when a command arrives, so
  selecting a space is bridge state only. Selecting a handed-off space works
  too: it is a read-side operation, and the first mutation is what fails. The
  app does have `activateSpace` (view only: it shows a space and never touches a
  tab) and the bridge still does not call it, because a round must not move the
  user's window; `scripts/demo-host.mjs` uses it to put its space on screen for
  the screenshot.
- **Ownership** — `handOff`/`takeOver` are the app's and the bridge keeps its own
  `ownership` in step, so a handed-off space is refused by both sides. The app
  also draws the "You have control" banner and focuses the page.
- **Persistence** — the profile keeps the storage: every space of a profile
  shares its `CefRequestContext`, so its cookies, `localStorage` and cache are
  what a later round sees. A space has no directory of its own any more.

### Profiles, spaces and the handoff gate

The model is ego lite's, and it is the app's, not the bridge's:

- **Profile = the isolation boundary.** One `CefRequestContext`, one storage
  directory, created once and shared by every space in it.
- **Space = a tab set plus ownership inside a profile.** Two spaces of one
  profile share cookies, `localStorage` and the cache; a space in another profile
  reads another directory. (Standalone is the opposite: a space is a browser
  context, so spaces are isolated and a profile is a separate Chrome.)
- **Handoff = exclusive user control.** The app refuses every agent mutation for
  that space until `takeOver`.

`Target.getTargets` is process-wide and now carries the *profile's* context id,
so the bridge's context filter separates profiles, not spaces: from one space's
browser you can see another space's page in the same profile. That is inherent to
the model (one context, several tab sets), and it does not change routing — a
frame still goes to the tab it names, and `listTabs{spaceId}` is the per-space
view the SDK lists from.

The gate reaches the SDK as one error shape, whether the handoff was made by the
bridge (`handOffTaskSpace`) or by the user in the window:

```
Error { message, error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" }
```

How it gets there:

1. the app refuses the op with JSON-RPC error `-32002` (or `-32001`) and
   `error.data.reason: "EGO_TASK_SPACE_USER_IN_CONTROL"`;
2. `HostControlClient` puts `reason` on the error and, because the reason is an
   `EGO_*` code, also sets `error_code` (the property the SDK branches on, see
   `vendor/ego-browser/src/ego-errors.ts:118-133`);
3. a refused `cdp.send` is re-thrown out of `HostBackend.sendRaw` instead of
   being turned into a per-request CDP error, so the bridge reports it through
   `onSendCDPMessageError(message, "EGO_TASK_SPACE_USER_IN_CONTROL")` — the signal
   the SDK stops on — and the bridge marks the space
   `agentDelegatedToUser` so the next attempt fails locally and `snapshot()`
   (the SDK's own control probe) reports the same code.

Other app refusals (`EGO_TASK_SPACE_INACTIVE`, `EGO_TASK_SPACE_NOT_FOUND`) stay a
correlated CDP error for the one request: a whole-task stop is the wrong answer to
a closing tab. Reads are deliberately not gated on the bridge side —
`listTaskSpaces`/`listTabs` keep working while the user has control, but a
*page* read through raw CDP does not, because the app refuses every `cdp.send` in
a handed-off space.

### Target lifecycle, synthesised from the app's tab pushes

CEF's Target domain is process-wide and knows nothing about the app's tabs, and
for a popup it says `canAccessOpener:false` with no `openerId` — it cannot say
otherwise, because the popup browser that would carry the relationship is
cancelled. The app knows the truth: `tab.created` carries `openerTabId` and
`windowName`. So the bridge translates the protocol-3 pushes into the target
lifecycle the SDK listens for (`runtime/backends/host.js`):

| push | what the SDK sees |
| --- | --- |
| `tab.created` with `openerTabId` | `Target.targetCreated` with `type:"page"`, the tab's url/title, `attached`, `canAccessOpener:true` and `openerId` = the **opener's target id** |
| `tab.updated{url?,title?}` | `Target.targetInfoChanged`, only when a key actually changed |
| `tab.closed` | `Target.targetDestroyed{targetId}` |
| `tab.activated` | the space's current tab, which is where a frame naming no session goes |

The rules it keeps: nothing is emitted before the client sends
`Target.setDiscoverTargets{discover:true}` for that space (the call is still
forwarded, so CEF's own `targetInfoChanged` keeps arriving); a target the client
already knows from `listTabs` is never announced a second time; a CEF
`targetCreated` for a target the bridge already announced is dropped; and
`listTabs` rows carry `openerId`, so a client that connects *after* the popup
opened adopts it from its baseline instead of waiting for an event that has
already been delivered. `Target.attachToTarget` for the popup goes to the popup's
own browser, because the tab→target map picks the browser, not the tab that
asked.

Where it lives (`runtime/backends/host.js`): the subscription is recorded in
`#sendFrame` (`:868`), the pushes are dispatched in `#onLifecyclePush` (`:1145`),
the announcement is `#announceTarget` (`:1204`), and everything goes out through
`#emitTargetEvent` (`:1285`). The baseline is `listTabs` (`:465`), a space's tabs
are re-read before routing gives up (`#refreshSpaceTabs`, `:676`), and the bridge
passes `openerId` through in `runtime/bridge.js:357`. `ROOK_DEBUG=1`
prints every synthesised event as `Target.targetCreated -> <tab> <target>
opener=<target> url=…`, which is how a popup can be traced from the app's push
to the SDK's adoption.

What none of this can give you: `window.opener` inside the popup page is `null`,
and `window.open()` in the opener returns `null`. The attribution is a protocol
fact (`openerId`/`canAccessOpener`), not a live window relationship, and the app
never claims otherwise.

What only works standalone, or not at all:

- **No crash signal.** The app does not report a renderer crash, so no
  `Target.targetCrashed` is synthesised. A dead renderer shows up as a dead
  DevTools session: commands stop answering and the bridge's own timeouts fire.
- **Lazy-loading heuristics are not the same as headless Chrome's.** An offscreen
  `loading="lazy"` frame can get requested anyway in a real window, which is what
  `Page snapshot lazy iframe` asserts must not happen. It failed once in an
  earlier full host run and did not reproduce in the two runs measured here, so
  there is no fix to point at: the snapshot is right, the *page* loaded a frame
  the case expected to stay unrequested. Timeboxed and left alone.
- **One profile is the boundary, not one space.** `listProfiles()` reports the
  app's profiles (`default`/`You` and any created one) and a space can be created
  in any of them; two spaces of one profile share cookies and storage, and a
  space in another profile does not. A page in another space of the *same*
  profile is visible to `Target.getTargets` (CEF has no per-space context); the
  per-space view is `listTabs`.
- **`Target.createTarget` is refused**, on purpose. Raw CDP that creates tabs
  that way (instead of `createTab()`) does not work in host mode.
- **A closing tab silently drops in-flight requests** — the app sends no final
  `cdp.error`, so such a request ends at the bridge's own timeout instead of
  failing immediately.
- **Paste needs a display the agent can reach.** `Page keyboard interface` pastes
  through the system clipboard, which the SDK's own process (not the app) has to
  load: run the suite with `DISPLAY=:99`. Upstream's SDK refuses Linux outright;
  `patches/0001-linux-clipboard.patch` is what makes this case pass here (see
  **Clipboard on Linux**).

Measured on 2026-10-27 with the patched SDK (`scripts/build-sdk.sh`), same
upstream suite, same CLI, one full run each: **standalone 69/69** (1248
assertions) and **host 69/69** (1248 assertions), `Page keyboard interface` at 38
assertions in both. Standalone ran headed (`DISPLAY=:99 ROOK_HEADFUL=1`)
because headless Chrome has no system clipboard at all; host mode ran the app on
the same display.

The host suite still flakes on a busy machine, and none of it is clipboard
related. In the same session it also came back 66/69 and 60/69 — `Page load
states` lost "background discovery adopts the delayed popup", the unclosed popup
pages then filled the page budget and later cases cascaded — and the *unpatched*
SDK under the same load scored 53/69 on the same popup family (`Page popup
waiter and URL diagnostic`). Two runs lost the app itself mid-suite (its child
processes were killed from outside: `Failed to send GetTerminationStatus message
to zygote`). Re-run on a quiet machine before believing a single number.

Host mode used to stop at 55/69. Every one of those 14 failures followed from
the popup gap: two popup cases, then eleven cases behind the page budget that
unadopted popup tabs filled, then `Page delayed popup: resume` behind its
`schedule` half. With the target lifecycle synthesised from
`tab.created`/`tab.updated`/`tab.closed` they all pass, including
`Page snapshot lazy iframe`, which did not reproduce in any of the three runs.

## Snapshot

`ego.snapshot(options)` returns `{ content, refs }`. `content` starts with one
header line — `snapshot scope=full page, 8126 lines, 1696 refs` — followed by the
accessibility tree as indented text: `root`, two spaces per level,
`role "name" [ref=N, loc=css:#id]`, and `text "..."` for text nodes. Every ref
carries the real `backendNodeId`, so `page.click("@12")` and the SDK's element
resolver work unchanged. `scope` supports `full_page`, `only_within_viewport` and
`subtree`.

The header exists because the SDK's default is viewport-only: an agent that reads
a slice as the whole page concludes the page does not mention what it is looking
for. So the first line always says which slice it is, and when the viewport
filter left nodes out it says how many and what to call instead
(`..., 7893 nodes outside the viewport not shown - pass {scope:"full_page"} for
the whole page`). It sits above `root` on purpose: the harness finds the tree by
its `root` line and keeps the lines above it verbatim, so the header survives
compaction — putting the same text on the `root` line would make
`compactSnapshotContent` skip compaction altogether. The header also says when
`maxResultLength` cut the snapshot short.

What the serializer leaves out, and why it is safe to:

- **One identifier per line.** `loc=href:/wiki/Linux` and
  `url=https://en.wikipedia.org/wiki/Linux` are the same link; the line prints
  the locator (which is what an action resolves with) and only falls back to
  `url=` when the node has no locator. The absolute URL is still on the ref in
  `refs[]`, so nothing is lost for the SDK.
- **A text child identical to its parent's label** is the label twice and is not
  printed (1,157 such lines on the Wikipedia page the bench used).
- **A `generic`/`layout*` wrapper with no name, no ref and nothing named
  underneath** is not printed; its children take its place.
- **Indentation is clamped** at 8 levels (still 2 spaces per level, which is the
  grammar the harness parses). Deeper nodes print at the clamp so a deeply nested
  page does not spend most of its bytes on spaces.
- **Text over 240 characters** is cut with an explicit
  `... [truncated, N more characters; read the full text with page.evaluate]`
  marker, and only when the marker is shorter than the text it replaces.

`loc=` is emitted only when it is unique (`css:#id`, `href:/path?query`).


Frames expand in place: an `iframe` prints its own line, then a nested `root`
and that frame's tree, recursively.

```
snapshot scope=full page, 7 lines, 2 refs
root
  main
    iframe "A frame" [ref=3, loc=css:#frame]
      root
        button "Frame action" [ref=4, loc=css:#frame-go]
```

Same-process frames are read with `Accessibility.getFullAXTree({frameId})` in
the page session; an OOPIF gets its own `Target.attachToTarget` session and is
read there, so nested and cross-site frames work to any depth.
`DOM.getFrameOwner`, called in the session that owns the parent document, maps
each frame to its owner element, which is what puts the nested root under the
right `iframe` line. Refs inside a child frame carry the real frame id from
`Page.getFrameTree`, so the SDK resolves them in the right document, and a
replaced iframe invalidates its old descendant refs. `scope: "subtree"` accepts
an iframe ref and expands that one frame.

Viewport filtering uses each frame's own viewport (its size and scroll offset)
rather than the top document's, and an iframe that is outside the viewport
contributes nothing at all — which is how a `loading="lazy"` frame below the
fold stays out of a viewport snapshot until it scrolls in.

Known gaps: `includeActionMarks` and `interactiveOnly` are accepted but ignored;
`scope: "subtree"` roots are looked up by `backendNodeId` alone (ids are
renderer-local, so if two frames both use the same id the first frame wins); a
frame whose owner element has no accessibility node (hidden, `display: none`)
prints no nested root.

## Tests

```sh
npm test                   # launcher, host-backend, space-resume and a real-browser smoke test
node test/cli.mjs          # launcher surface only, no browser needed
node test/host-backend.mjs # host backend against a stub control socket, no browser needed
node test/space-resume.mjs # two stub app runs: a stale host id must never be reused
node test/smoke.mjs        # real Chrome: space -> tab -> snapshot -> click, incl. a frame ref
node test/profile-e2e.mjs  # profiles + handoff through the CLI against the real app
```

`test/smoke.mjs` drives a local fixture page through the real SDK, so an SDK
build has to exist: it looks in `vendor/ego-browser` (what
`scripts/build-sdk.sh` produces) unless `ROOK_UPSTREAM` or `ROOK_SDK` names
another one. It forces `ROOK_BACKEND=standalone` so a running app can never
become the browser under test.

`test/profile-e2e.mjs` is the product model proved the way an agent would see it:
it starts its own Xvfb and app, then runs four `ego-browser nodejs` rounds — A
signs in on a local fixture, B in the same profile is already signed in, C in a
second profile is not, a handoff makes a click fail with
`EGO_TASK_SPACE_USER_IN_CONTROL` without counting it, and `takeOverTaskSpace`
lets the same click through. It needs the app binary, the vendored SDK build and
an X server, so it is a separate command rather than part of `npm test`.

`test/space-resume.mjs` starts two stub hosts that both number their spaces from
`sp2` — two app runs, the same id — and asserts that resuming a space from the
first run reopens its own tab under a new host id instead of landing on the
second run's space.

`test/host-backend.mjs` starts `test/host-stub.mjs` on a temporary socket and
drives the bridge through it: space/tab mapping, DevTools id correlation, the
three re-mapped `Target.*` calls, `Target.getTargets` narrowing, push filtering
and reconnect after the socket goes away. It also covers the protocol-3 model end
to end: `listProfiles` in the SDK's shape, `createProfile`, a space created in a
named profile, two spaces of one profile reading the same `localStorage` and
cookies while a space in another profile reads neither, and the handoff gate in
both directions — the bridge's own `handOffTaskSpace`, and a takeover in the
window the bridge never saw, which must arrive as a thrown
`EGO_TASK_SPACE_USER_IN_CONTROL` on the send path, keep `listTabs` working, and
be lifted by `takeOverTaskSpace`. On top of that, the synthesised target
lifecycle: nothing is emitted before the client subscribes; a `tab.created` push
with an opener becomes a `Target.targetCreated` whose `targetInfo` carries
`openerId` (the opener's target id) and `canAccessOpener:true`; a CEF
`targetCreated` for the same target is dropped; `tab.updated` becomes exactly one
`targetInfoChanged`; `tab.closed` exactly one `targetDestroyed`; `listTabs`
reports the opener so a late client adopts the popup from its baseline; and the
SDK's `Target.attachToTarget` for the popup reaches the popup's browser rather
than the opener's.

The upstream end-to-end suite runs against this CLI through its own hook:

```sh
cd /path/to/rook/package/ego-browser
npm ci && npm run build
EGO_BROWSER_REAL_E2E_CLI=$PWD/bin/ego-browser \
  node scripts/run-real-browser-e2e.mjs
# one slice of it:
EGO_BROWSER_REAL_E2E_CLI=... \
EGO_BROWSER_REAL_E2E_ONLY='["environment initialization","task spaces and control","observation helpers"]' \
  node scripts/run-real-browser-e2e.mjs
```

The same suite against the native app (it starts the app on a private runtime
directory, waits for the socket, and runs the slice with `ROOK_BACKEND=host`):

```sh
scripts/run-host-e2e.sh
scripts/run-host-e2e.sh '["environment initialization","task spaces and control"]'
```

Against the patched SDK, run the suite that ships *inside* the vendored copy —
its `--sdk-path` points at its own `dist/out`, so the patch is what is under
test. `EGO_BROWSER_BUILD_ROOT` lets the runner rebuild that copy (see
`patches/0002-vendor-build-root.patch`); `DISPLAY` is what the clipboard needs.

```sh
scripts/build-sdk.sh

# standalone: headed, because headless Chrome has no system clipboard
DISPLAY=:99 ROOK_HEADFUL=1 ROOK_BACKEND=standalone \
EGO_BROWSER_BUILD_ROOT=$PWD/vendor \
EGO_BROWSER_REAL_E2E_CLI=$PWD/bin/ego-browser \
  node vendor/ego-browser/scripts/run-real-browser-e2e.mjs

# host: the app on the same display
ROOK_UPSTREAM=$PWD/vendor/ego-browser EGO_BROWSER_BUILD_ROOT=$PWD/vendor \
  scripts/run-host-e2e.sh --all
```

Cases within one run share a state directory, so a case that starts with
`switchTaskSpace(taskName)` depends on an earlier case having created that
space. Run such cases together, not one at a time.

## Demo: the skill driving the native app

```sh
scripts/demo-host.mjs          # starts the app, runs a round, screenshots the window
scripts/demo-host.mjs --keep   # leave the app running afterwards
```

It runs one `ego-browser nodejs` round with the host backend — create a space,
open a tab on a local fixture, snapshot, click a ref — then asks the app to show
that space (`activateSpace`; it falls back to clicking the sidebar row like a
user would) and captures the app window to `artifacts/host-demo.png`. The window
ends up showing a page whose URL carries the run's port and timestamp, so the
capture can only come from that round.
