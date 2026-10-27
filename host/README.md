# Rook (Linux) — native shell, M4

A GTK3 + CEF 156 host: one native window with a space sidebar, a browser-style tab
strip and a real Chromium page per tab, plus the **agent control channel** the bridge
talks to — a unix socket speaking newline-delimited JSON-RPC 2.0, with every DevTools
protocol message passed through to the page untouched.

The model is ego lite's: **a profile is the isolation boundary, a space is a tab set
inside a profile, and a handoff is exclusive user control.**

`host/` owns only the C++ app. `runtime/`, `bin/`, `test/` and the root `package.json`
belong to the Node side.

## What works today

- One window, native chrome: 224 px space sidebar, tab strip with `+` and per-tab
  close, toolbar with back / forward / reload and an address bar (Enter navigates,
  focus selects the whole address).
- Tabs: create, switch, close, live title from the page, busy/back/forward state.
  Closing the last tab of a live space opens a new tab page instead of a dead window.
- **Profiles.** One `CefRequestContext` per profile, created once and shared by every
  space in it: `profiles/<id>` on disk, all its spaces see the same cookies,
  `localStorage` and cache. The default profile is `default` / "You" and holds the
  user's own logins; `createProfile` adds more. A space in another profile is isolated
  by its own storage directory. Spaces are tab sets, not storage boundaries.
- **Real handoff.** `handOff` reveals the space, gives its page the keyboard and shows
  a native "You have control — Rook is paused" banner; every agent mutation
  (`cdp.send`, `createTab`, `closeTab`, `activateTab`, `navigate`,
  `highlightMouseTo`, `closeSpace`) is refused with
  `EGO_TASK_SPACE_USER_IN_CONTROL` until `takeOver`. Reads keep working.
- **Control channel (M4, protocol 3).** `$XDG_RUNTIME_DIR/rook-<uid>.sock`, mode 0600,
  JSON-RPC 2.0: `getInfo`, `listProfiles`, `createProfile`, `listSpaces`,
  `createSpace`, `closeSpace`, `listTabs`, `createTab`, `activateSpace`, `activateTab`,
  `closeTab`, `navigate`, `handOff`, `takeOver`, `setAgentTaskState`,
  `highlightMouseTo`, `cdp.send`, `quit`. A tab created over the socket in a space the
  window is not showing loads, runs DevTools commands and screenshots without stealing
  the view.
- **Tab lifecycle pushes.** Every space/tab/profile/ownership change the shell makes —
  from a click or from the socket, same code path — is broadcast to every client as
  `profile.created`, `space.created`, `space.closed`, `tab.created`, `tab.closed`,
  `tab.activated`, `tab.updated` and `control.changed`. `tab.created` carries
  `openerTabId` for a popup, which is the attribution CEF itself cannot give a DevTools
  target.
- **CDP broker.** `cdp.send{browserId,message}` goes to
  `CefBrowserHost::SendDevToolsMessage`; every message CEF produces comes back as
  `cdp.event{browserId,message}` with the original bytes (`id`, `sessionId` and
  payload untouched). Failures come back as `cdp.error{browserId,code,message,reason?}`.
- `--screenshot PATH`: loads the given spaces/tabs, captures the window as PNG and
  exits 0. `scripts/qa.sh` builds from scratch and reproduces it with no display.
- `--verify-isolation`: prints what each space's page can see (`localStorage` and
  `document.cookie`) next to the profile it belongs to. Two spaces of one profile must
  report the same values; a space in another profile must not.

## Layout

```
GtkWindow
└ GtkBox (horizontal)
  ├ sidebar (GtkBox, 224 px, CSS .sidebar)
  │   ├ brand + "SPACES" label
  │   ├ space rows (GtkButton per space: avatar, name, tab count / agent state /
  │   │   "You have control"; a space in a second profile is prefixed with its name)
  │   └ "+ New space"
  └ GtkBox (vertical)
      ├ tab strip (GtkBox + GtkScrolledWindow, CSS .tabstrip)
      │   └ tab items (GtkButton per tab of the *active* space) + "+"
      ├ toolbar (back / forward / reload / GtkEntry url)
      ├ handoff banner (GtkBox .banner, hidden unless the visible space is handed off)
      └ GtkStack .content
          └ one GtkDrawingArea per tab  ← CEF child window lives here
```

Each tab's `GtkDrawingArea` is pinned to the X **root visual** and given to CEF with
`CefWindowInfo::SetAsChild(..., CEF_RUNTIME_STYLE_ALLOY)` (`src/shell.cc:2144`,
`src/shell.cc:2147`). Without both, X rejects the child with `BadMatch` and the page
renders nowhere while still reporting `readyState=complete`. Resizes are forwarded by
hand because CEF watches Configure events on its own window, not ours
(`src/shell.cc:2427`).

Switching tabs/spaces only changes which stack page is visible; parked browsers get
`CefBrowserHost::WasHidden(true)` so their timers are throttled. The state is
edge-triggered in `Shell::ApplyVisibility` (`src/shell.cc:2266`) and a tab is visible
when the user is looking at it **or** an agent round woke it up (below).

The agent pointer ring is not a widget: the page is a native X child window, so the
ring lives in its own override-redirect toplevel with an X shape mask
(`src/highlight.cc`), positioned over the tab's drawing area.

## Processes and threads

```
rook (this binary)
├── browser process: GTK + CEF UI thread (single-threaded message loop)
│   └── control socket: GLib fd sources, same thread, no locks
└── CEF re-execs this same binary for renderer / GPU / utility processes
    (browser_subprocess_path = /proc/self/exe, src/app.cc:64)
```

CEF's GLib message pump drives GTK, so CEF callbacks, widget code and control-socket
requests all run on the same thread (`CefRunMessageLoop()` in `src/main.cc`). One
profile context means the tabs of a profile share the browser process's network
service and storage; each tab still gets its own renderer, which is why the memory
delta of this model is in the browser process and on disk, not per tab.

## Profiles, spaces and storage

The model, in one line each:

- **Profile = the isolation boundary.** One `CefRequestContext`, one storage
  directory, created once and shared by every space in it.
- **Space = a tab set plus ownership inside a profile.** Tabs stay separate per space;
  cookies, `localStorage` and the cache are the profile's, so an agent space works with
  the user's logins instead of a fresh browser.
- **Handoff = exclusive control.** The user drives; the agent is refused until
  `takeOver`.

```
$XDG_DATA_HOME/rook/                 (default ~/.local/share/rook)
├── profiles.json                    {"profiles":[{id,name}]} — display names only
├── profiles/                        CefSettings.root_cache_path
│   ├── default/                     profile "You": one request context, flat CEF layout
│   │   ├── Preferences              (pre-M4 data moved up here once, see below)
│   │   ├── Local Storage/           shared by every space of this profile
│   │   └── Cookies
│   ├── work/                        profile "Work": one request context
│   ├── Default/                     CEF's own global context — never used by a tab
│   └── ActorSafetyLists, …          CEF's component data (not profiles)
├── shell/new-tab.html               generated new-tab page
└── cef.log                          CEF's log file
```

`CefSettings.root_cache_path` is `rook/profiles` and every profile is a **direct
child** of it: CEF refuses any other cache path and silently falls back to in-memory
storage when a context points outside the root (measured — the check is in
`cef/libcef/browser/context.cc`), so profiles cannot live deeper in the tree. CEF also
keeps its own global context in `<root>/Default` and its component data beside the
profiles; Rook never creates a tab in either and `Shell::LoadProfiles` tells them apart
from real profiles (`src/shell.cc`), so `listProfiles` never shows them.

**Why one context per profile and not per space.** One context per space meant one
Chromium storage tree and cookie jar per space: a login in "You" was invisible to every
agent space, three spaces cost four profile directories on disk (measured 12 MB versus
5.4 MB for the same pages), and the browser process carried ~10 MB more per extra
context. It was also not what the product is: the agent is supposed to work *in* the
user's session.

**Migration from the pre-M4 layout.** Pre-release, so old per-space storage is dropped
rather than translated:

- a space no longer owns a directory; any leftover `profiles/<p>/<space>/` directory
  (recognisable by the `Preferences` file at its root) is deleted at startup and the
  removal is reported (`[rook] removed legacy per-space storage …`);
- the default profile's own data used to live one level down, in CEF's global
  user-data layout (`profiles/default/Default/…`). `Shell::LoadProfiles` moves those
  entries up once (`[rook] profile migrated from the pre-M4 layout: N entries moved`),
  which is what keeps the user's existing cookies and logins. Nothing is overwritten:
  an entry that already exists at the target stays put.

Do not mix the two layouts by hand: a `profiles/<p>/<space>` directory is never read
again, and the default profile's storage is the profile directory itself.

## The control channel (bridge → host)

`src/control.h` is the contract; `src/control_rpc.cc` is the transport.

```
socket   $XDG_RUNTIME_DIR/rook-<uid>.sock   (fallback /tmp when that dir is not
         writable; --socket-path overrides, --no-control-socket disables)
mode     0600, set before listen(); a stale file is removed, a live one is refused
framing  one JSON object per line, UTF-8, no pretty printing, max 96 MB per line
```

Requests carry an `id`; replies echo the exact JSON token the client sent (int or
string). A request without an `id` is a notification and gets no reply.

```jsonc
{"jsonrpc":"2.0","id":7,"method":"createTab","params":{"spaceId":"sp2","url":"http://…"}}
{"jsonrpc":"2.0","id":7,"result":{"spaceId":"sp2","tabId":"tb2","browserId":"tb2","url":"http://…"}}
{"jsonrpc":"2.0","id":8,"error":{"code":-32602,"message":"createTab needs a string 'spaceId'"}}
{"jsonrpc":"2.0","id":9,"error":{"code":-32002,"message":"space sp2 is handed off to the user; the agent cannot drive it until takeOver","data":{"reason":"EGO_TASK_SPACE_USER_IN_CONTROL"}}}

// pushes, never replies
{"jsonrpc":"2.0","method":"cdp.event","params":{"browserId":"tb2","message":"{\"id\":3,\"result\":{…}}"}}
{"jsonrpc":"2.0","method":"cdp.error","params":{"browserId":"tb2","code":-32002,"reason":"EGO_TASK_SPACE_USER_IN_CONTROL","message":"space sp2 is handed off…"}}
```

| method | params | result |
| --- | --- | --- |
| `getInfo` | — | `{version, protocol, pid, socket, cef, state}` |
| `listProfiles` | — | `{defaultProfileId, profiles:[{id,name,isDefault,path}]}` |
| `createProfile` | `{name}` | `{profileId,name,isDefault:false}` |
| `listSpaces` | — | `{activeSpaceId, spaces:[{spaceId,name,user,active,ownership,agentState,profileId,profileName,cache,tabCount,activeTabId}]}` |
| `createSpace` | `{name,profileId?}` | `{spaceId,name,profileId}` — `profileId` omitted means the default profile |
| `closeSpace` | `{spaceId}` | `{spaceId,closed}` |
| `activateSpace` | `{spaceId}` | `{spaceId,active:true}` — shows the space (sidebar + tab strip) |
| `listTabs` | `{spaceId}` | `{spaceId,name,ownership,profileId,activeTabId,tabs:[{tabId,browserId,title,url,active,loading,closing,openerTabId,windowName}]}` |
| `createTab` | `{spaceId,url?}` | `{spaceId,tabId,browserId,url}` |
| `activateTab` | `{spaceId,tabId}` | `{spaceId,tabId,active}` |
| `closeTab` | `{spaceId,tabId}` | `{spaceId,tabId,closed}` |
| `navigate` | `{tabId,url}` | `{tabId,url}` |
| `handOff` / `takeOver` | `{spaceId}` | `{spaceId,ownership:"user"\|"agent"}` |
| `setAgentTaskState` | `{spaceId,state}` | `{spaceId,agentState}` |
| `highlightMouseTo` | `{spaceId,x,y}` | `{spaceId,x,y}` |
| `cdp.send` | `{browserId,message}` | `{browserId,accepted:true}` |
| `quit` | — | `{quitting:true}`, then the app closes |

`cache` is the storage directory the space reads: its profile's, shared with every
other space of that profile (the field keeps its old name so a protocol-2 client does
not break).

`activateSpace` is a view operation, not a mutation: it is allowed on the user's
space and on a handed-off space, and it never touches a tab (the mutation gate still
covers `createTab`/`closeTab`/`activateTab`/`navigate`/`cdp.send`/`highlightMouseTo`).

Error codes: `-32700` parse, `-32600` invalid request, `-32601` unknown method,
`-32602` bad params, `-32001` the host refused (unknown/closing space, handed off),
`-32002` the CDP broker could not take the message.

### Errors a bridge keys on

A refusal caused by *who owns the space* carries ego's error code in
`error.data.reason` (RPC replies) and in `reason` (the `cdp.error` push), so a client
never has to parse the prose:

| reason | when |
| --- | --- |
| `EGO_TASK_SPACE_USER_IN_CONTROL` | the space is handed off to the user, or it is the "You" space; `takeOver` lifts the first, nothing lifts the second |
| `EGO_TASK_SPACE_INACTIVE` | the space is closing |
| `EGO_TASK_SPACE_NOT_FOUND` | no such space/profile/tab/browser id |
| `EGO_INVALID_ARGUMENT` | a profile name that is empty or taken, a tab from another space |

Other failures (bad JSON-RPC params, a CDP message CEF refused, a create that failed
for an unrelated reason) have no `reason`: there is no ego code for them.

**The `browserId` is the tab id.** One id per page, so a bridge never has to map
between a target id and a tab.

### Lifecycle pushes (protocol 3)

Notifications, no `id`, broadcast to **every** connected client, in the order the
model changed. They are emitted from the `Shell` methods themselves, so a click and
an RPC request produce identical events. They are also queued rather than written on
the spot: `ActivateTab` pumps the GTK loop, which can service another request in the
middle of an operation, so a push is only written once the outermost operation has
returned. A client that reads `listSpaces`/`listTabs` in reaction to a push therefore
always sees the finished operation, never a half-applied one. The push for a request
can arrive before *or* after that request's reply.

```jsonc
{"jsonrpc":"2.0","method":"profile.created","params":{"profileId":"work","name":"Work"}}
{"jsonrpc":"2.0","method":"space.created","params":{"spaceId":"sp2","name":"probe","profileId":"default"}}
{"jsonrpc":"2.0","method":"space.closed","params":{"spaceId":"sp2"}}
{"jsonrpc":"2.0","method":"tab.created","params":{"spaceId":"sp2","tabId":"tb3","url":"http://…","openerTabId":"tb2","windowName":"probe_popup"}}
{"jsonrpc":"2.0","method":"tab.closed","params":{"spaceId":"sp2","tabId":"tb3"}}
{"jsonrpc":"2.0","method":"tab.activated","params":{"spaceId":"sp2","tabId":"tb2"}}
{"jsonrpc":"2.0","method":"tab.updated","params":{"spaceId":"sp2","tabId":"tb2","url":"http://…"}}
{"jsonrpc":"2.0","method":"tab.updated","params":{"spaceId":"sp2","tabId":"tb2","title":"Notes"}}
{"jsonrpc":"2.0","method":"control.changed","params":{"spaceId":"sp2","state":"user"}}
```

| push | when | params |
| --- | --- | --- |
| `profile.created` | `createProfile` made a profile | `profileId`, `name` |
| `space.created` | a space exists (UI `+ New space` or `createSpace`) | `spaceId`, `name`, `profileId` |
| `space.closed` | the space is gone: every browser closed, the profile's storage kept | `spaceId` |
| `tab.created` | a tab was added, including a popup adopted from `window.open` | `spaceId`, `tabId`, `url`, `openerTabId?`, `windowName?` |
| `tab.closed` | the browser is gone and the tab left the model | `spaceId`, `tabId` |
| `tab.activated` | that space's current tab changed (also when the space is off screen) | `spaceId`, `tabId` |
| `tab.updated` | URL and/or title changed; edge-triggered, only changed keys | `spaceId`, `tabId`, `url?`, `title?` |
| `control.changed` | `handOff` (→ `"user"`) or `takeOver` (→ `"agent"`), once per transition | `spaceId`, `state` (`"user"` \| `"agent"`) |

`openerTabId`/`windowName` are present in `tab.created` only when they apply, and
always present (empty string when not) in `listTabs`. `tabId` is stable from the
moment the tab is created: it is the id `createTab` returns and the `browserId` the
CDP broker uses, and it does not change when CEF's browser appears.

Every push is also written to the host's stderr as `[event] <method> <params>`, so
the QA log and a bug report both show what the bridge was told. Nothing is replayed:
a client that attaches later takes `getInfo`/`listSpaces`/`listTabs` as its baseline.

A tab made by the `createTab` op carries no opener. A tab made by a page
(`window.open`, `<a target="_blank">`) carries the opener's `tabId`.

#### What popup attribution really is

CEF's `CefLifeSpanHandler::OnBeforePopup` runs on **the opener's browser**, so the
opener and the requested window name are known facts, not a guess:

- `openerTabId` — the tab whose client received the callback (its page called
  `window.open` / clicked a `target` link).
- `windowName` — the callback's `target_frame_name`: the `name` argument of
  `window.open()` (`"_blank"` for a plain `target="_blank"`).

The host **cancels** the popup (`OnBeforePopup` returns `true`) and opens an
ordinary tab in the opener's space instead. That is why the attribution has to
travel in `tab.created` at all: the popup browser CEF would have created is the
only thing that carries `canAccessOpener`/`openerId`, and it is never created. The
consequences a bridge must handle:

- the adopted tab is a normal top-level target: `listTabs`, `activateTab`,
  `closeTab`, `navigate` and `cdp.send` all work on it like any other tab;
- `Target.targetInfo` for it has `canAccessOpener:false` and no `openerId`, and
  `window.opener` is `null` **inside** the popup page. Synthesise the CDP target
  relationship (and any `page.waitForEvent("popup")`) from `tab.created`;
- `window.open()` in the opener returns `null`, because the popup was cancelled.

Two rules for the bridge, both consequences of CEF's model:

- **Create tabs with `createTab`, never `Target.createTarget`.** A DevTools-created
  browser is not owned by any tab: the window does not show it, `listTabs` does not
  count it, and nothing closes it at shutdown (the host force-exits after a 5 s
  watchdog). It also crashed renderer subprocesses here.
- **`Target.getTargets` is process-wide.** CEF's request contexts are not Chromium
  browser contexts, so the Target domain has no `browserContextId`: from one
  space's browser you can see (and attach to) every page in the app, whatever
  profile it belongs to. Use `listTabs{spaceId}` for the per-space view, and pick
  the target whose `url` names the tab you mean (the QA probes do exactly that).
  Storage isolation is a profile property, not a CDP one.

`cdp.send` returns `accepted:true` once CEF has taken the message; it does not mean
the command succeeded. A malformed frame is accepted and then discarded by CEF
without a reply, so a bridge needs its own timeouts as well as id correlation. A
message sent before CEF finishes creating the browser is queued for that tab and
flushed in order.

How it is wired:

- `ControlDelegate` (`src/control.h:67`) is implemented once, by
  `Shell::ControlAdapter` (`src/shell.cc:747`). Every method ends in the same `Shell`
  call the GTK handler uses — `OnTabClicked` → `ActivateTab`, `OnAddTabClicked` →
  `OpenTab`, `OnSpaceRowClicked` → `ActivateSpace`/`CloseSpace` — so a UI click and an
  RPC request cannot drift apart.
- `ControlServer` (`src/control.h:151`) is the transport. `MakeSocketControlServer()`
  (`src/control_rpc.cc`) binds, listens and registers GLib fd sources; `--no-control-socket`
  falls back to the M1 no-op (`src/control_local.cc`).
- Dispatch is `SocketControlServer::Invoke` (`src/control_rpc.cc:565`), line splitting
  is `HandleLine` (`src/control_rpc.cc:527`), and the socket is set up in `Bind`
  (`src/control_rpc.cc:190`).
- The broker's two halves:
  - out: `ControlAdapter::SendCdp` → `Shell::SendCdpMessage` (`src/shell.cc:3421`) →
    `CefBrowserHost::SendDevToolsMessage`. Messages that arrive before CEF has created
    the browser are queued per tab and flushed in `OnBrowserCreated`.
  - in: `BrowserClient::OnDevToolsMessage` (`src/browser_client.cc:21`, returns `true`
    so CEF does not re-split the message) → `Shell::OnDevToolsMessage`
    (`src/shell.cc:2562`) → `PushCdpEvent`. Per-message observer registration happens
    in `OnAfterCreated` (`src/browser_client.cc:11`).
- Lifecycle pushes come from `Shell::PushEvent` (`src/shell.cc:2577`), the one place
  that talks to `ControlServer::PushEvent`; the four typed wrappers under it
  (`PushTabCreated` … `PushTabClosed`) only build the payload. They are called from
  the model methods — `CreateSpace` (`src/shell.cc:1738`), `DestroySpace`
  (`src/shell.cc:1890`), `OpenTab` (`src/shell.cc:2036`), `ActivateTab`
  (`src/shell.cc:2165`), `DestroyTab` (`src/shell.cc:2318`), `Navigate`
  (`src/shell.cc:2693`), `HandOffSpace`/`TakeOverSpace` (`src/shell.cc:3504`/`3534`),
  `CreateProfile` (`src/shell.cc:1679`), `OnAddressChange`/`OnTitleChange`/`OnLoadEnd`
  — never from the RPC dispatch.
- Popups: `BrowserClient::OnBeforePopup` (`src/browser_client.cc:60`) hands CEF's
  request to `Shell::OnOpenPopup` (`src/shell.cc:2544`) with the opener tab id and the
  window name, returns `true` to cancel, and the tab is opened from an idle callback
  (`OpenPopupIdle`) once CEF's window-open path has unwound. The opener is carried on
  the `Tab` (`Tab::opener_id`, set in `OpenTab`) before the browser exists, so
  `OnAfterCreated` has nothing left to attribute.

### Parking vs. CDP

A tab in a space the user is not looking at is `WasHidden(true)`, which throttles its
timers. That would make an agent round slow or leave the compositor without a frame, so
`Shell::CdpKeepAwake` (`src/shell.cc:3452`) un-hides a tab on the first message of a
round and re-asserts the size; a 1 s sweeper re-parks it once it has been quiet for 10 s
and the user is still not looking at it. The probe captures a screenshot while the tab
is still parked, from a space the window never switched to.

### Handoff

Handing a space off is three things at once (`Shell::HandOffSpace`,
`src/shell.cc:3504`):

1. **The window reveals the space.** `ActivateSpace` selects the sidebar row, swaps the
   tab strip and shows its active tab — the user should not have to find the space the
   agent just stopped in.
2. **Its page takes the keyboard.** The toplevel is presented and `FocusPage` runs for
   the space's active tab: GTK focus, `CefBrowserHost::SetFocus(true)` and X input focus,
   the same path a click into the page takes. Typing after a handoff goes to the page
   (that is what `scripts/profile-probe.mjs` types and reads back).
3. **The banner appears.** A native bar above the page reads
   `You have control — Rook is paused` plus the space name and the agent's last state,
   and the sidebar row says "You have control". It is visible while the handed-off space
   is on screen, and only for a space the user owns.

From that moment the mutation gate refuses every agent write for that space:
`cdp.send`, `createTab`, `closeTab`, `activateTab`, `navigate`, `highlightMouseTo` and
`closeSpace` all fail with `data.reason: "EGO_TASK_SPACE_USER_IN_CONTROL"`
(`ControlAdapter::Guard`, `src/shell.cc:984`; the RPC reply and the `cdp.error` push
both carry it). Reads — `getInfo`, `listSpaces`, `listTabs`, `listProfiles` — keep
working, as does `activateSpace` (a view operation) and `setAgentTaskState` (the agent
saying what it was doing). `takeOver` flips `ownership` back to `"agent"`, removes the
banner and lets the same calls through again. `control.changed{spaceId,state}` is
emitted on both transitions.

The user's own clicks and keystrokes are never gated: a handed-off space stays fully
usable by hand, and the normal chrome (tabs, address bar, `+ New space`) keeps working.
The `You` space is permanently the user's for the same reason — the agent may look at
it, highlight in it and read it, but not create tabs in it or drive its pages.

## Build

```sh
cmake -S host -B host/build -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C host/build -j4
host/build/bin/rook
```

- CEF must be pointed at with `-DCEF_ROOT=/path/to/cef_binary_156` (there is no default).
  The runtime
  files (`libcef.so`, paks, `icudtl.dat`, `locales/`) are staged once into
  `host/cef-runtime/` by hardlink, so throwaway build directories are cheap and the
  binary's rpath can point at a directory that actually contains `icudtl.dat`
  (CEF resolves ICU relative to the *loaded* `libcef.so`, not `resources_dir_path`).
- **The host compiles as C++20, not C++17.** CEF 156's headers use C++20 concepts
  (`std::same_as` in `base/cef_scoped_refptr.h`); the code itself is C++17-shaped.
- `USE_SANDBOX` is `ON` in `CMakeLists.txt` because this binary can run Chromium's
  sandbox now; it only adds the `CEF_USE_SANDBOX` define. Whether the sandbox is on is
  a runtime decision (`src/sandbox.cc`), not a build option.
- Needs X11. A private Xvfb display is enough (`ROOK_DISPLAY`, default `:131`); there
  is no Wayland backend here.

## Run

```sh
# interactive, empty profile (control socket at $XDG_RUNTIME_DIR/rook-<uid>.sock)
host/build/bin/rook

# two spaces of the default profile: the second one is already signed in as the
# first (same storage), then the window is captured and the app exits
host/build/bin/rook --screenshot /tmp/shot.png \
  --space "You=http://127.0.0.1:8000/notes.html,http://127.0.0.1:8000/isolation.html?label=You" \
  --space "Agent 1=http://127.0.0.1:8000/isolation.html?label=Agent1" \
  --verify-isolation
```

`--help` lists every flag. Useful extras: `--profile NAME` (the *default* profile id
for this run; other profiles are created over the socket), `--data-root DIR`,
`--window-size WxH`, `--socket-path PATH`, `--no-control-socket`, `--verbose` (CEF info
logging), `ROOK_CEF_EXTRA_FLAGS` (escape hatch for Chromium switches), `ROOK_GPU=1`
(keep the GPU path), `ROOK_NO_SANDBOX=1|0` and `ROOK_SANDBOX_PROBE=1` (see
"Sandbox" below).

Talking to it by hand, no dependencies:

```sh
python3 - <<'PY'
import json, socket, os
s = socket.socket(socket.AF_UNIX); s.connect(f"/tmp/rook-{os.getuid()}.sock")
s.sendall(b'{"jsonrpc":"2.0","id":1,"method":"getInfo"}\n')
print(json.loads(s.makefile().readline())["result"]["version"])
PY
```

## Sandbox

The Chromium sandbox is decided at startup, never hardcoded: `DecideSandbox()` in
`src/sandbox.cc` is called from `src/main.cc:43`, before GTK and before CEF, and its
result feeds both `CefSettings.no_sandbox` (`src/app.cc:54`) and the browser command
line (`src/app.cc:94-100`). The decision always carries its reason, and the reason is
printed either way, so a fallback is never silent.

The checks, in order (first match wins):

| # | Signal | Verdict |
|---|--------|---------|
| 1 | `ROOK_NO_SANDBOX=1` | disabled, by explicit request |
| 2 | `geteuid() == 0` | disabled: Chromium will not start sandboxed as root |
| 3 | `chrome-sandbox` is a regular file, owned by uid 0, setuid, executable | **enabled via setuid helper** |
| 4 | a real `unshare(CLONE_NEWUSER)` + `uid_map`/`gid_map` + `CLONE_NEWPID\|CLONE_NEWNET` in a forked child | **enabled via user namespaces** |
| 5 | neither | disabled, with the reason and how to fix it |

Why a syscall and not a container check: `/proc/sys/user/max_user_namespaces` and
`/proc/self/uid_map` describe policy, not what this binary is allowed to do (Ubuntu
23.10+ ships `kernel.apparmor_restrict_unprivileged_userns=1`, where the sysctl says
yes and `unshare(2)` returns `EPERM`), and container markers (`/.dockerenv`,
`/run/.containerenv`) are missing from exactly the restrictive hosts that block
namespaces, while being present in privileged ones that allow them. The probe forks
once, before GTK/CEF start any threads, and costs about a millisecond.

The helper is found the way Chromium finds it: `$CHROME_DEVEL_SANDBOX`, then
`<exe dir>/chrome-sandbox`, then the CEF payload dir — `<prefix>/lib/rook/cef` in
the package, `host/cef-runtime` in the build tree. When the setuid helper is the
mechanism, the host exports `CHROME_DEVEL_SANDBOX` to that path (`src/app.cc:56-60`),
because the package's helper is not beside the executable. When user namespaces are
the mechanism, the host appends `--disable-setuid-sandbox`: a helper that exists but
is not `4755 root:root` makes Chromium abort instead of falling through to the
namespace path.

Overrides:

```sh
ROOK_NO_SANDBOX=1     # run unsandboxed on purpose; still warns (never silent)
ROOK_NO_SANDBOX=0     # require the sandbox: exit 4 with the reason instead of
                          # starting unsandboxed
ROOK_SANDBOX_PROBE=1  # print the decision and exit 0 (no display needed)
```

`ROOK_SANDBOX_PROBE=1` prints one `[rook] sandbox: <key>` line per signal —
`override`, `helper`, `userns`, `decision`, `reason`, `fix`, `message` — which is what
`scripts/sandbox-probe.sh` and `scripts/qa.sh` parse. The probe does not start CEF,
so it works over SSH, on a machine with no X display and with no profile.

What a normal run prints on stderr, in each situation:

| Situation | Line |
|-----------|------|
| `.deb` install, 4755 `root:root` helper in place | `[rook] sandbox: enabled (setuid helper)` |
| dev box / container where user namespaces work (this one) | `[rook] sandbox: enabled (user namespaces)` |
| no usable helper and no user namespaces | `[rook] WARNING: Chromium sandbox disabled: <reason>. Renderers run unsandboxed and a hostile page has this user's rights. Fix: <fix>` |
| `ROOK_NO_SANDBOX=1` | `[rook] WARNING: Chromium sandbox disabled by ROOK_NO_SANDBOX=1: ...` |
| `ROOK_NO_SANDBOX=0` where it cannot start | `[rook] ERROR: ROOK_NO_SANDBOX=0 asks for the Chromium sandbox, but it cannot start here: <reason>.` then `[rook] Refusing to run unsandboxed. Fix: ...` and exit 4 |

The exact fallback warning for a build tree without the helper and without user
namespaces is:

```
[rook] WARNING: Chromium sandbox disabled: /path/to/cef-runtime/chrome-sandbox is owned by uid 1000, the sandbox helper must be owned by root, and user namespaces do not work here: unshare(CLONE_NEWUSER): Operation not permitted (EPERM). Renderers run unsandboxed and a hostile page has this user's rights. Fix: install the rook .deb and run rook from it (the package sets chrome-sandbox to 4755 root:root), or enable unprivileged user namespaces; set ROOK_NO_SANDBOX=1 to accept an unsandboxed run.
```

## Accessibility bridge

GTK loads `atk-bridge` during `gtk_init()`, and on a session with no accessibility bus
to attach to that load does not fail fast: it waits (measured 15.7 s on the QA box),
and Chromium's own accessibility start-up waits with it, so the **first page never
commits**. The window appears and stays blank; `--screenshot` only ends the run because
of its 15 s load watchdog, so the symptom is "first launch takes 16 s and captures a
blank frame, second launch 1.3 s" — the first launch leaves a half-started bus behind,
the second finds one.

`DecideAccessibilityBridge()` (src/a11y.cc) therefore keeps the bridge only when the
session published one, which is what at-spi's launcher does with `AT_SPI_BUS_ADDRESS`:

```
[rook] accessibility bridge off: no AT_SPI_BUS_ADDRESS: the session has no accessibility bus for the bridge to attach to
```

An explicit `NO_AT_BRIDGE` (read by GTK itself) always wins, and
`ROOK_A11Y_BRIDGE=on|off` forces either side. `on` is the one to use on a box where
this probe is wrong and a screen reader is in use.

## QA (`scripts/qa.sh`)

Five phases, one command.

**Cold-start gate.** Before the phases: the same binary on a display and a profile
that have never been used, `--screenshot` with a 3 s budget
(`ROOK_COLD_START_MS` overrides it) to a frame that is neither blank nor flat.
Every passing run measured on this box lands in 1.3-1.8 s; the failure it catches
is a first launch that never commits its page (15.7 s and a flat frame, see
"Accessibility bridge" above). Both numbers are printed whether it passes or not.

**Phase 0 — the sandbox.** `scripts/sandbox-probe.sh` runs nine cases with no root
and no installed package: the decision this machine produces (with its reason), the
`ROOK_NO_SANDBOX=1` fallback and its warning, a `4755` helper owned by the
current user being **refused**, a real `4755 root:root` helper flipping the decision
to "enabled via setuid helper", `ROOK_NO_SANDBOX=0` exiting 4 instead of starting
unsandboxed (proved as a root-mapped user namespace), the same refusal on a container
whose seccomp profile denies `unshare(2)` (real EPERM, via
`scripts/deny-unshare.c`), the full fallback warning that container produces, a live
run whose renderers are checked in `/proc` for `Seccomp: 2` plus private namespaces,
and a whole forced-fallback run that must warn, render a screenshot and exit 0.
`qa.sh` then asserts phase 1 printed exactly one sandbox line and that it matches the
decision the probe saw. Logs: `artifacts/sandbox-probe.log`,
`artifacts/sandbox-probe/{host.log,fallback.log,fallback.png}`.

**Phase 1 — the shell and the shared profile.** Builds `host/` from scratch, serves
`host/fixtures/` over local HTTP on a random port, runs the shell on a private Xvfb
(`ROOK_DISPLAY`, default `:131`) with two spaces of the default profile, captures
`artifacts/m1-shell.png`, and fails unless:

- the process exits 0 and the PNG is at least 1000x700 with ≥500 colours and
  standard deviation > 0.02 (a blank frame is sd 0 / a handful of colours);
- both spaces report `profile="default"`, `localStorage="You"` and
  `cookie="rook-space=You"` — the first page wrote the value, the second one found it,
  which is the whole point of a profile (pre-M4 builds asserted the opposite);
- `.../profiles/default` holds Chromium data and leveldb stores, and no per-space
  directory (`.../profiles/default/agent-1`) exists any more;
- exactly one `[rook] sandbox: enabled …` or `[rook] WARNING: Chromium sandbox disabled …`
  line is in the run log, and it is the decision the sandbox probe predicted (a box
  with a usable helper or user namespaces runs phase 1 sandboxed; a box without either
  runs it on the fallback, warning included).

An interactive run (no `--screenshot`) then keeps the same build alive past CEF's
renderer-zygote churn and quits over the socket, so the stack-guard bug of M1 cannot
come back.

**Phase 2 — the control channel.** `scripts/control-probe.mjs` (Node 20+, no
dependencies) starts a second host on its own `XDG_RUNTIME_DIR` and data root, then:

1. checks the socket is mode 0600 and answers `getInfo` with the right pid/version
   (protocol 3);
2. framing: a request split across two writes, a string `id` echoed verbatim, a garbage
   line answered with `-32700`, and a notification that gets no reply;
3. the `You` space refuses `createTab` and `closeSpace` — the agent may not drive the
   user's space;
4. `createSpace("probe")` + `createTab(space, fixture)` while the window is showing
   another space, and asserts the window did not move and the space landed in the
   run's default profile;
5. drives raw CDP through the broker: `Target.getTargets`, `Target.attachToTarget`
   (flatten), `Page.enable`, `Runtime.evaluate("document.title")`,
   `Accessibility.getFullAXTree` — then asserts the title, the `readyState`, and that
   the tree contains `button "Run probe"` and the `control probe` heading;
6. asserts events arrive as `cdp.event` with the payload verbatim, and that a second
   client sees the same host and the same pushes;
7. asserts an unknown `browserId` produces both an RPC error and a `cdp.error`
   notification;
8. `Page.captureScreenshot` → `artifacts/m2-cdp.png`, checked for size, colour count
   and standard deviation;
9. `handOff` → the window moves to the space, the gate refuses `cdp.send` with
   `data.reason: EGO_TASK_SPACE_USER_IN_CONTROL`, and `control.changed{state:"user"}`
   is pushed; `takeOver` → it works again and pushes `state:"agent"`;
10. `highlightMouseTo`, then `activateSpace` (the window follows to the agent space and
    `listSpaces.activeSpaceId` changes without a tab being touched);
11. a same-space tab calls `window.open("/control.html?popup=1", "probe_popup", …)` via
    `Runtime.evaluate{userGesture:true}`; the probe asserts the `tab.created` push names
    the opener (`openerTabId`) and the window name, that `listTabs` reports both, that
    the popup tab can be activated / navigated / closed like any other tab (with
    `tab.activated`, `tab.updated{url}`, `tab.updated{title}` and `tab.closed` arriving),
    and that the space is back to one tab afterwards;
12. `closeTab`, `closeSpace` (the space is gone, `listTabs` refuses it, `space.closed`
    was pushed), then a space closed *with a live tab*, then `quit` → host exits 0 and
    removes its socket.

**Phase 3 — keyboard focus.** `scripts/focus-probe.mjs` drives real X input with
`xdotool`: click a field and type (the page's DOM and the keyboard agree), read the
address bar back through the X clipboard, Escape back to the page, Tab/Enter inside
the form, and Ctrl+L → Escape handing the keyboard back. Screenshot:
`artifacts/m3-focus-form.png`.

**Phase 4 — profiles and handoff.** `scripts/profile-probe.mjs` starts a host on its
own data root and proves, in one pass:

1. `listProfiles` reports `default` / `You` / `isDefault`, and `createProfile("Work
   laptop")` adds `work-laptop` on disk;
2. signing in (cookie + `localStorage`) in one space of the default profile makes a
   second space of that profile signed in too — same `cache` path, same storage;
3. a space in `work-laptop` is signed out and writes to its own directory (its own
   leveldb store);
4. with the space handed off: the window is showing it, `control.changed{user}`
   arrived, `cdp.send` **and** `createTab`/`closeTab`/`navigate`/`activateTab`/
   `highlightMouseTo` are refused with `EGO_TASK_SPACE_USER_IN_CONTROL` (the `cdp.error`
   push too), reads still answer, and `takeOver` lets the same `cdp.send` through;
5. the other order: success → `handOff` → refused → `takeOver` → success;
6. the banner: a capture before the handoff has a light band above the page, the one
   after it is dark (the native banner is really there);
7. the revealed space takes the keyboard: with no click, typed characters land in the
   page's autofocused field and `document.hasFocus()` is true;
8. switching to the other profile's space and back keeps the tab, its field text and
   the session (a space's tabs are not rebuilt by a profile switch);
9. a pre-made `profiles/default/agent-legacy` directory is gone after startup and the
   removal was logged;
10. after a restart the default profile is still signed in and `work-laptop` is still
    listed.

It writes `artifacts/m4-handoff.png`: the banner and a space with the user's session in
one frame. The probes print one line per check and a `PASS/FAIL` summary; the QA run
fails with them.

Env knobs: `ROOK_KEEP_BUILD=1`, `ROOK_DISPLAY` (default `:131`), `ROOK_SCREENSHOT`,
`ROOK_NODE`, `JOBS`, `CEF_ROOT`, `XVFB_BIN`/`XVFB_LIB` or `ROOK_XVFB_ROOT` (an
extracted Xvfb, for a box without the package installed).
`scripts/sandbox-probe.sh --no-live` skips the two cases that need a display; the
decision cases need neither X nor root.

The storage report in phase 1 is produced by the fixture page itself: it writes
`localStorage`/cookie on load and logs `EGO_STORAGE {json}` on the console, which the
host picks up in `OnConsoleMessage` (`src/shell.cc`). Phase 4 proves the same fact from
the other side: a real cookie set over CDP in one space, read back from another.

## Known gaps (and one must-fix)

1. **The sandbox is on where the machine can run it, and the fallback says so.** The
   old build forced `no_sandbox = true` everywhere; now `src/sandbox.cc` decides at
   startup (setuid helper → user namespaces → fallback with a warning) and
   `ROOK_NO_SANDBOX=0` refuses to start rather than run unsandboxed. What is
   **verified on this box**: the namespace path really engages — renderers carry
   `Seccomp: 2` and live in their own pid/net/user namespaces
   (`scripts/sandbox-probe.sh` case 6 reads it from `/proc` while they run), and a
   forced-fallback run has no sandboxed children at all. What is **not** verified:
   the setuid helper path on a real install (it needs a 4755 root:root file and root
   to create one; the decision layer is exercised by
   `scripts/sandbox-probe.sh` case 4, the actual helper exec is not), and the
   AppImage, where the squashfs is mounted `nosuid`, so `chrome-sandbox` loses
   setuid and only the user-namespace path can work. Treat the packaged build as
   "sandboxed where the kernel allows it", not as a proven-hardened release.
2. Control-channel gaps the bridge will care about:
   - pushes are broadcast to every connected client, not scoped per client or per
     space, there is no per-client subscription and **no replay**: a client that
     attaches late has to take `getInfo`/`listSpaces`/`listTabs` as its baseline and
     apply pushes from then on;
   - a popup is adopted, not joined: the tab carries `openerTabId`, but the new page
     has `window.opener === null`, `window.open()` in the opener returned `null`, and
     its CDP `targetInfo` keeps `canAccessOpener:false` with no `openerId`. Letting CEF
     create the real popup browser (and reparenting its X window into a tab) is the
     only way to get a genuine opener relationship, and it is not done here;
   - `highlightMouseTo` still needs its space on screen; `activateSpace` is how a
     client gets it there;
   - CDP messages for a tab are dropped when the tab closes, without a final
     `cdp.error`; a bridge with requests in flight sees the socket go quiet for them;
   - `Target.getTargets` is process-wide and `Target.createTarget` is off limits
     (above), so tab lifecycle has to go through the host ops;
   - the space's active tab is host state: `Target.activateTarget` over CDP moves
     the page but not the sidebar/tab strip, so use `activateTab`;
   - a renderer crash kills its DevTools session (`Inspector.detached` is forwarded,
     but the session id is dead and the bridge has to re-attach);
   - request/response only: no batches, no cancellation, no streaming, and no
     backpressure signal beyond the 64 MB per-client queue that drops the client;
   - re-parking after an agent round is a 10 s idle heuristic, not an explicit "round
     over" signal.
3. No tab drag-to-reorder, no tab tearing/multi-window, no favicons, no tab overflow UI
   beyond horizontal scrolling. Titles are truncated at 20 characters.
4. No find-in-page, history menu, downloads UI, permission prompts, or DevTools UI.
   Address-bar input with no scheme is treated as a host (`https://<text>`), so there is
   no search engine; `target=_blank` and `window.open` open a new tab in the same space
   and ignore popup features (size/position, `noopener`), and the page gets no window
   handle back.
5. Back/forward history is per-tab and dies with the tab (CEF Alloy does not persist
   navigation history); only cookies/localStorage survive restarts. Spaces themselves
   are runtime objects: a restart starts with the "You" space only, while the profiles
   (and their logins) stay.
6. **Ctrl+T/W/L/R need a window manager for the *typing* part.** The shortcuts are
   grabbed on the toplevel (`Shell::GrabChromeShortcuts`, reported once at startup as
   `[rook] chrome shortcut grabs on 0x…: installed`), so they always reach the shell;
   but on a bare X server without a WM, `gdk_window_focus` cannot hand the X focus to
   the address bar, so keys typed after Ctrl+L may go nowhere. On any desktop the
   shortcut works; `scripts/focus-probe.mjs` therefore asserts the recovery (Ctrl+L →
   Escape → the page types again) rather than the entry's contents.
7. Performance: cold start and idle RSS are not gated by QA. What has been measured
   (this box, 4 tabs in 4 spaces, Xvfb, `--disable-gpu`): M3's context-per-space used
   ~10 MB more in the browser process per extra space (281/228 MB vs 218/218 MB for two
   runs each) and 12 MB on disk versus 5.4 MB for the same pages. Renderers are per tab
   in both models, so "~130 MB per space" was never context overhead.
8. `browser_subprocess_path` points at `/proc/self/exe`; packaging needs a dedicated
   helper binary so the browser binary can grow a different argv surface.
9. `profiles/` also holds CEF's component data and its own unused `Default` context,
   because CEF's `root_cache_path` must be the parent of every profile directory. The
   protocol and the UI never show them (`Shell::LoadProfiles` filters them), but a human
   looking at the directory sees ~30 extra entries. Moving them is not possible without
   giving up `profiles/<id>` as the storage path.
10. The handoff banner is checked by pixels now (phase 4 compares a band above the page
    before and after the handoff); the agent pointer ring still is not. The ring needs
    an X server that honours shape masks; under a compositor-less Xvfb it is fine, but
    it has not been tried on Wayland.
11. There is one app instance per data root: CEF's process singleton is keyed on
    `root_cache_path` (`rook/profiles`), so two instances with different `--profile`
    values on the same data root would now collide. Two instances with different
    `--data-root`s are fine (that is what the probes do).
