# Rook 0.4.0-M4 — independent product review (second pass)

**Reviewer:** independent; I did not build Rook.  
**Second review:** 27 October 2026, evening.  
**What I tested:** the current **build tree**, because there is no 0.4.0 package: `host/build/bin/rook` (M4, built 18:11), `bin/ego-browser`, and the vendored SDK `vendor/ego-browser/dist/out/index.js`, on a private Xvfb `:122` with Openbox, CEF 156.0.14 / Chromium 156.0.8078.48, Node 22.23.4.  
**What I did not test as the product:** the only artefacts in `packaging/out` are still `rook_0.3.0~m3_amd64.deb` and the matching AppImage, both timestamped 15:27 and containing the M3 host. I used the M3 `.deb` only to compare the old snapshot and to run the old collision repro.  
**ego lite:** still cannot run on this Linux box. Statements about it remain sourced from its README, landing page, and `docs/native-bindings-api.md`, not from running it.

I used a private Xvfb `:122` + Openbox for the M4 build-tree tests, the same local fixture server on `127.0.0.1:8781` (and `127.0.0.2` for the cross-origin iframe), and the real `ego-browser nodejs` CLI with the vendored SDK. I ran the old M3 `.deb` on a separate private `:123` only to measure the old snapshot, and the supplied old collision script on `:121` to check its claim. I did not use `:99`.

## Second verdict

**I would not use this daily because the only installable `.deb` is still 0.3.0, a resumed space comes back with unlabeled tabs (`task.page("p1")` fails until adopted), popups still have no `window.opener`, and there is still no Chrome import or extension/bookmark/password UI. The two blockers I reported yesterday are genuinely fixed in the 0.4.0 build tree: keyboard typing works, the restart collision is gone, profiles share logins, handoff is real, and snapshots are smaller and honestly scoped. I would use the 0.4.0 build for agent work now; I would not yet install it as a daily browser.**

That is a real improvement, not a cosmetic one. The first review's complaint was that Rook could not be the thing ego lite is; the second review's complaint is that the remaining gaps are narrower and mostly honest feature work, plus one packaging/release failure.

## Changes since the first review

| First-review finding | Status now | Evidence |
|---|---|---|
| Keyboard focus: clicking a page and typing did nothing | **Fixed** | `Ctrl+L` → form URL; click Name, type `Jay Gupta`; field shows it. `Ctrl+L`, `Escape`, type `X` appends to the field. [`shots/05-typed-name.png`](eval-logs/review2/shots/05-typed-name.png), [`shots/06-after-escape.png`](eval-logs/review2/shots/06-after-escape.png), [`keyboard.out`](eval-logs/review2/keyboard.out). |
| Restart collision: `taskSpace("alpha")` returned `BETA`'s tab | **Fixed in the build tree** | `test/space-resume.mjs` **18/18**; end-to-end alpha run resumes **ALPHA**, with distinct `hostInstance` IDs. [`collision.out`](eval-logs/review2/collision.out), [`space-resume.out`](eval-logs/review2/space-resume.out). |
| Agent spaces could not use the user's logins; no profile boundary | **Fixed / new model** | Same-profile A and B both `PRIVATE-OK`; second-profile C `PRIVATE-DENIED`; `profiles()` lists `default`/You and `work`/Work. `test/profile-e2e.mjs` **20/20**. [`profiles-login.out`](eval-logs/review2/profiles-login.out), [`profile-e2e.out`](eval-logs/review2/profile-e2e.out). |
| Handoff was not exclusive | **Fixed / new** | Handoff reveals the space, user typed `USER-WROTE-THIS`, agent click is refused with `EGO_TASK_SPACE_USER_IN_CONTROL` (20/20 test), takeover reads the user's value and the click works. [`handoff-takeover.out`](eval-logs/review2/handoff-takeover.out), [`shots/08-handoff-user-typed.png`](eval-logs/review2/shots/08-handoff-user-typed.png). |
| Snapshot had no scope header, duplicate metadata, empty wrappers | **Fixed** | Header line is present and honest; Wikipedia full page **551,053 → 329,702 chars (−40.2%)**; `/big` **124,129 → 97,669 (−21.3%)**; default slice says how many nodes are omitted. `/big` full has 0 `url=` metadata and no empty generic wrapper (1,201 `generic` lines, all with children). [`snapshot-final.out`](eval-logs/review2/snapshot-final.out), [`old-0.3-snapshot.out`](eval-logs/review2/old-0.3-snapshot.out), [`bigfull-current.txt`](eval-logs/review2/bigfull-current.txt). |
| Popup: `window.opener` null, `window.open()` returns null | **Still broken** | `p2` is drivable, but child `window.opener` is `"null"` and opener status is `window.open returned: null`. [`popup.out`](eval-logs/review2/popup.out). |
| Restored space/tabs were not addressable | **Still broken / reclassified** | After a clean restart all three spaces return, A/B cookies are `PRIVATE-OK`, C is denied, tabs reopen at `private.html` — but `task.pages()` is `[]`, tabs have no label, and `task.page("p1")` throws `page label not found: p1. Managed Pages in task space 1: none`. `adopt` works. [`restored-labels.out`](eval-logs/review2/restored-labels.out). |
| Page labels tied to the CLI parent PID (two shells) | **Still broken** | A round in a fresh shell reports `Managed Pages ... none`; `task.page("p1")` throws `page label not found`; restored tabs are unlabeled too. `adopt` is the workaround. [`restored-labels.out`](eval-logs/review2/restored-labels.out). |
| Closing a tab while a wait is pending waits the full timeout | **Still broken** | `waitForSelector("#never", {timeout:15000})` + `page.close()` returned `ERROR after 15004ms: page.waitForSelector timed out after 15000ms`. [`wait-close.out`](eval-logs/review2/wait-close.out). |
| Unhandled alert could leave a later round stuck | **Not re-tested** | No fix claimed; old failure remains a risk, not re-proven. |
| Standalone `shutdown` then resume failed with a raw CDP error | **Not re-tested** | I only spot-checked the standalone snapshot header, not the shutdown/resume path. |
| No Chrome import or extension/bookmark/password UI | **Still missing** | `profiles()` has profiles, but there is no import/migration or extension/bookmark/password UI. This is still the largest gap to ego lite's “your real logins and tabs” pitch beyond the default profile. |
| “Works as a daily browser” | **Improved, not done** | Keyboard fixed; tab URLs restore; still no import/extension/bookmark/password UI, X11 only, no URL handler. |
| Installable package contains the fixes | **New release blocker** | `packaging/VERSION` is `0.3.0~m3`; `packaging/out/*` is M3 from 15:27; `host/build/bin/rook` is M4 from 18:11. `docs/eval-logs/rounds/collision3.sh` still points at the old extracted `.deb` and, run verbatim, prints `alpha actually sees BETA`. [`packaging.out`](eval-logs/review2/packaging.out), [`old-repro-collision3.out`](eval-logs/review2/old-repro-collision3.out). |
| Performance / memory | **Improved PSS, not faster in absolute terms** | One tab **870 MiB RSS / 195 MiB PSS**, 0.4 % idle; three spaces **1,312 / 296 MiB**, 0.0 %. Wikipedia full snapshot 3.2 s (old 3.5 s); `/big` full 0.53 s (old 0.57 s); docs default 0.15–0.22 s. [`memory.out`](eval-logs/review2/memory.out), [`snapshot-final.out`](eval-logs/review2/snapshot-final.out). |

The supplied collision repro is the sharpest caveat: the **code** is fixed, but the **script users were told to run** still exercises the old M3 binary and still fails. The same is true of the packages. That is a release problem, not a code problem, and I rank it below as a blocker because “fixed” is not true for anything a user can install from `packaging/out` today.

## Second-review results

| Task | Result in the 0.4.0 build tree | Evidence |
|---|---|---|
| 1. Cold start / docs title | Socket in **157–326 ms**; docs `goto` **285 ms**, title correct. | `app-run1.log`, `app-run2.log`; `feel.out`. |
| 2. Form fill, select, checkbox, submit | **FORM-OK**, **724 ms** for three fills, select, checkbox, submit and wait. | [`form.out`](eval-logs/review2/form.out). |
| 3. Login, close, relaunch, session in the space | **Pass with label caveat.** Clean close 104 ms; relaunch 212 ms; A/B `PRIVATE-OK`, C `PRIVATE-DENIED`; private tabs reopen. `task.page("p1")` fails; `task.tabs()` + `adopt` works. | [`restart-profiles.out`](eval-logs/review2/restart-profiles.out), [`restored-labels.out`](eval-logs/review2/restored-labels.out). |
| 4. Two agents in parallel | **Pass.** A in default logged in `PRIVATE-OK`; B in Work profile `PRIVATE-DENIED`; both completed; visible page stayed unchanged. | [`par-A.out`](eval-logs/review2/par-A.out), [`par-B.out`](eval-logs/review2/par-B.out). |
| 5. Popup + opener | **Partial.** Popup arrives as `p2`, drive works; `window.opener` is still `null`, `window.open()` returns `null`. | [`popup.out`](eval-logs/review2/popup.out). |
| 6. Cross-origin iframe | **Pass.** Frame content in snapshot, ref click lands. | [`regressions.out`](eval-logs/review2/regressions.out). |
| 7. Upload / download | **Pass.** Upload `UPLOAD-OK`; download payload correct. | `regressions.out`. |
| 8. Clipboard | **Pass.** Textarea, contenteditable, HTML paste; `ORIGINAL-CLIP` restored. | `regressions.out`. |
| 9. Screenshot | **Pass** (form result saved); not re-timed this pass. | [`shots/09-form-result.png`](eval-logs/review2/shots/09-form-result.png). |
| 10. Recovery | Dialogs pass; broken selector / navigation errors were already clear in review 1; **tab-close-while-waiting still burns the full 15 s**; unhandled alert not re-tested. | [`wait-close.out`](eval-logs/review2/wait-close.out). |
| 11. Feel | 870/195 MiB (1 tab), 1,312/296 MiB (3 spaces), idle 0.0–0.4 %; docs snapshot 148–221 ms, click 116–286 ms; Wikipedia full 3.2 s; `/big` full 0.53 s. | [`memory.out`](eval-logs/review2/memory.out), [`feel.out`](eval-logs/review2/feel.out), [`snapshot-final.out`](eval-logs/review2/snapshot-final.out). |
| 12. Crash / bridge kill | **Pass.** SIGKILLed bridge, app stayed alive, new round found the same `Profile form` tab, `p1` usable. | [`crash-round1.out`](eval-logs/review2/crash-round1.out), [`crash-recover.out`](eval-logs/review2/crash-recover.out). |
| Profiles / handoff | **Pass.** `profile-e2e` 20/20; exact refusal code asserted; user typed and takeover preserved `USER-WROTE-THIS`. | `profile-e2e.out`, [`handoff-takeover.out`](eval-logs/review2/handoff-takeover.out). |
| Snapshot scope / size | **Pass.** Header is line 2, after the SDK page banner: docs default `viewport only, 274 lines, 248 refs, 2632 nodes outside…`; Wikipedia full `full page, 8087 lines, 1696 refs`; `/big` full `3606 lines, 1200 refs`. | [`snapshot-header.out`](eval-logs/review2/snapshot-header.out), `snapshot-final.out`. |

## Remaining defects, ranked

### Blocker (release) — no installable artefact contains the fixes

This is the one blocker that remains, and it is not subtle. The current build tree is M4 and passes the fixes; the package directory is still the M3 build that failed the first review:

```text
$ cat packaging/VERSION
0.3.0~m3
$ ls -lh packaging/out
rook_0.3.0~m3_amd64.deb   132M  Oct 27 15:27
rook-0.3.0~m3-x86_64.AppImage  165M  Oct 27 15:27
$ ./host/build/bin/rook --help | head -1
Rook (Linux) — native shell, M4
$ /tmp/opencode/rook-eval/root/usr/lib/rook/rook --help | head -1
Rook (Linux) — native shell, M3
```

Worse, the documented repro still points at the old extracted `.deb`:

```sh
$ bash docs/eval-logs/rounds/collision3.sh
...
resumed alpha 1 [{"label":"p2","title":"BETA"}]
alpha actually sees BETA
```

The supplied script does **not** show `ALPHA`; my adapted build-tree script does ([`rounds/collision-current.sh`](eval-logs/review2/rounds/collision-current.sh), [`collision.out`](eval-logs/review2/collision.out)). Until a 0.4.0 package is built and the repro points at the same build it claims to test, “fixed” is only true for the working tree.

### Major — restored tabs are not managed or labeled

Persistence now restores the space, its cookie and its URL, but not its page identity:

```text
pages []
p1_error page label not found: p1. Managed Pages in task space 1: none. task.page(label) only refers to an existing Page; create one with await task.newPage()
tabs [{"title":"Private area","url":"http://127.0.0.1:8781/private.html"}]
```

`adopt` works, so data is not lost and the session is genuinely restored. But an agent that resumes a space and follows the normal `task.page("p1")` idiom fails. This is either an intentional “restored tabs are user tabs” rule that needs to be documented, or a missing re-adoption step. Either way, it is the remaining automation papercut in the restart path.

### Major — popups still have no live `window.opener`

Unchanged from the first review:

```text
popup p2 http://127.0.0.1:8781/popup-child.html {"popups":[{"label":"p2",...}]}
opener_in_child null
opener_return window.open returned: null
child_result CHILD-CLICKED
```

The popup is announced and drivable; opener-dependent OAuth/SSO flows are still not fidelity-compatible with Chrome. On stock Chrome the same fixture returns `object`/`object`. This remains a documented CEF/Alloy limitation, not a regression.

### Major — closing a tab while a command waits still waits the full timeout

```text
ERROR after 15004ms: page.waitForSelector timed out after 15000ms: #never
```

The page did close; the pending command did not abort. This is unchanged and can burn 15–20 s per dead tab.

### Major (unverified) — unhandled alert and standalone shutdown/resume

I did not re-run these two. The first review found an unhandled alert could leave a later `taskSpace` hung, and that standalone `shutdown` then resume produced `task.listTabs: CDP WebSocket error`. Neither is in the fix list, and the relevant code paths were not exercised this pass. Do not treat them as fixed.

### Major (product) — no Chrome import, extensions, bookmarks or passwords

The profile model now gives agent spaces the default profile's logins, which closes the biggest first-review gap. The other half of ego lite's “your real browser” pitch is still absent: there is no Chrome migration/import, no extension support, and no bookmark/password UI. `profiles()` is a storage boundary, not a browser-data migration. This is the remaining reason I would not hand Rook to a normal user as their daily browser.

### Major — snapshot is still slow on the largest real page

The size fix is real: Wikipedia full page went **551,053 → 329,702 chars (−40.2%)**, and the default slice now says `7892 nodes outside the viewport not shown`. But the same full-page snapshot took **3.2 s** (old 3.5 s) and default **4.5 s** (old 4.8 s) on this Xvfb box; docs is 148–221 ms. The header is honest and the output is smaller; it is not fast on a huge page. `/big` full is 0.53 s, roughly unchanged from 0.57 s. The first review's performance finding is therefore **not fixed**, only mitigated in size.

### Minor — protocol error surfaces still not consistently `EGO_*`

The old raw `task.listTabs: CDP WebSocket error` is not re-tested, but the new profile/handoff tests pass through the SDK's stable error path. The native-bindings doc promises stable error codes; the remaining standalone/shutdown path is the one I would re-check before release.

### Minor — packaging description is stale

`packaging/build-deb.sh` still describes “each space is its own Chromium storage context”, which is the pre-M4 model. Even after a 0.4.0 rebuild, that description should be corrected to “profile is the storage boundary; spaces are tab sets”.

## Where it stands versus ego lite's pitch

| Claim | Second-review result | Classification |
|---|---|---|
| “the agent can always reach your real logins and tabs” | **Much closer.** Spaces in the default profile share its cookies; A/B both `PRIVATE-OK`; a second profile is isolated. Handoff gives the agent a user space only after explicit user control. | **Fixed for the profile model**; still not a Chrome-data migration. |
| “migrate Chrome data: cookies, extensions, bookmarks, open tabs” | Still no import; no extension/bookmark/password UI; `profiles()` only manages storage contexts. | **Missing feature.** |
| “works as your daily browser” | Keyboard is fixed, tabs restore by URL, but no import/extensions/bookmarks/passwords, no 0.4.0 package, and restored tabs are unlabeled. | **Improved; not done.** |
| “strongest snapshot / deeply nested iframes” | Header and size fixed; iframe behaviour remains good; popup opener still null. | **Fixed in size/honesty; popup limitation remains.** |
| “faster runs / fewer tokens” | Same JS skill contract; Wikipedia full snapshot still 3.2 s on this box; no token measurement. | **Not established**, no head-to-head. |
| “any agent can drive it” | Protocol works; labels after restart are still a resume papercut; SDK parent-PID behavior remains. | **Mostly good, with caveats.** |
| “spaces multitask; no tab stealing” | Passes; A/B parallel, visible page unchanged, different profiles isolated. | **Strength.** |

## What surprised me positively

- **The keyboard fix is real.** Clicking the page and typing now works, and `Ctrl+L` → `Escape` returns to the page. The first-review blocker is gone in the build tree.
- **The collision fix is real end to end.** Alpha and beta both get `sp2` in different app runs, but `hostInstance` distinguishes them; alpha comes back as `ALPHA`, not beta's tab. `space-resume.mjs` makes the same point 18 times.
- **Profiles and handoff are the product model now.** A/B share a login, C does not; handoff blocks a mutation with the exact code, the user types, and takeover preserves the user's value.
- **The snapshot is both smaller and more honest.** Wikipedia full page dropped 40.2% to 329,702 chars; the default slice explicitly says `7892 nodes outside the viewport not shown`; `/big` has no duplicate `url=` metadata.
- **Memory PSS and crash recovery improved.** One tab is 195 MiB PSS, three spaces 296 MiB; killing the bridge mid-form left the same `Profile form` tab for the next round.
- **Regressions I cared about still pass:** iframe snapshots/clicks, upload/download, clipboard text/HTML/restore, dialogs, and parallel work.

## What I could not verify

- **A real window manager/physical desktop.** Keyboard was tested under Xvfb + Openbox only; the fix looks correct, but a physical X session is still unverified.
- **A real `.deb`/setuid install.** I tested the build tree, not `dpkg -i`; the package in `packaging/out` is still M3.
- **The 0.4.0 AppImage.** It does not exist; only the old 0.3.0 AppImage exists.
- **Standalone after the profile changes.** I checked its snapshot header only; I did not re-run its shutdown/resume path.
- **Unhandled alert recovery.** Not re-tested.
- **The full 69/69 upstream suite.** I ran the two targeted regressions (`space-resume` 18/18, `profile-e2e` 20/20) plus the task round above, not the entire suite.
- **macOS/Windows ego lite parity.** Popup opener behaviour, Chrome import and native focus are still Mac-only questions.

I did not edit `host/`, `runtime/`, `vendor/` or `test/`, and did not commit; this review adds only `docs/evaluation.md` and `docs/eval-logs/review2/`.

---

# Appendix — first review (0.3.0~m3, 27 October 2026, preserved as history)

The sections below are the first review, kept verbatim except where a heading was changed for structure. They describe the M3 build and the old `.deb`; the “fixed” status is recorded in the second-review table above, not by editing history.


### First-review verdict

Rook is a real, working Linux implementation of the **ego-browser automation contract**, and a genuinely good multi-space agent harness. It is not a Linux `ego lite`.

**I would not use this daily because on this Linux/X11 setup I could not type into a web page by hand, my agent spaces cannot use the logins already in my browser by default, and after an app restart resuming an old space can land on another space's tab.** I would use it for scripted agent work on Linux, with a fresh `EGO_BROWSER_STATE_DIR` per session, and I would not hand it to a non-technical person as their browser.

The automation half is the surprise: cross-origin iframe snapshots, parallel spaces, popups once you have the handle, uploads/downloads, clipboard paste, and the app surviving a killed bridge all worked. The product half — the part that is supposed to make it a browser you live in — is where it falls over.

Against the stock-Chrome standalone baseline, Rook is better for parallel agent work (real spaces, no tab stealing, a sidebar you can see) and worse for popup fidelity and restart recovery. Against `ego lite`, it is missing the shared-login/Chrome-import product, which is the reason `ego lite` exists.

### What I ran

- Private Xvfb `:120` (and a second private `:121` for the clean restart reproduction), 1440×900×24, with Openbox added after the initial no-WM cold-start tests. I did not use `:99`.
- Fresh `HOME`, `XDG_RUNTIME_DIR`, `EGO_BROWSER_STATE_DIR` and app profile for the clean runs; the long exploratory run accumulated spaces, which is itself how I found the restart collision.
- A local fixture server on `127.0.0.1:8781`: form with text/email/textarea/`<select>`/checkbox, cookie login, popup + child, cross-origin iframe (`127.0.0.2:8781`), upload, download, textarea + contenteditable, alerts/confirm/prompt, a page that navigates itself away, and a synthetic `/big` page (1,200 rows, ~4,800 snapshot lines).
- Every agent round used the shipped CLI exactly as the skill instructs: `ego-browser nodejs` with a heredoc (or `-e` for one-liners). The `.deb` was unpacked; the launcher and bundled Node/SDK were used from the unpacked tree.
- Standalone baseline: `ROOK_BACKEND=standalone`; `ROOK_HEADFUL=1` for clipboard, because headless Chrome has no system clipboard.
- The sandbox path was the packaged tree's user-namespace path (the `.deb`'s setuid helper can't retain root ownership after `dpkg-deb -x`). I did not test a real `dpkg -i` install.
- Timings are wall-clock from the shell around a complete CLI round, or `Date.now()` around one SDK call; they are one run unless three are shown. Memory is summed RSS over the app and all CEF children, plus summed `Pss` from `/proc/<pid>/smaps_rollup`; CPU is the sum of `utime+stime` over a 5 s idle sample. No model was in the loop, so these are browser/CLI numbers, not agent-thinking numbers.

Logs, screenshots and all round scripts are in [`docs/eval-logs/`](eval-logs/). The clean collision reproduction is [`35-collision-repro.out`](eval-logs/35-collision-repro.out); the standalone shutdown failure is [`28-standalone-persist2.out`](eval-logs/28-standalone-persist2.out).

### Task results

| # | Task | Rook (host) | standalone Chrome | Notes |
|---|---|---|---|---|
| 1 | Cold first-run: launch, tab, real docs page, title | First socket at **625 ms**; later launches **194–311 ms**. First agent round to `docs.python.org/3/library/json.html`: **361 ms wall**, `goto` 233 ms; correct title. | **886 ms** wall; `goto` **476 ms**. | Rook paints a new-tab page immediately, then the agent space appears in the sidebar. No progress/status while the agent works. Cold start is the strongest number in the product. |
| 2 | Form: name/email/textarea, `<select>`, checkbox, submit | **FORM-OK**. 3 fills + `selectOption({label:"October"})` + checkbox click + submit + wait: **737 ms**. | **FORM-OK**. | Both support refs, CSS, `selectOption` and checkbox-by-click. There is no `check()`/`uncheck()` in the Page API; clicking works. |
| 3 | Login, close app, relaunch, session in that space | **Partial.** Clean WM close: **108 ms**; cookie DB had 0 rows while running and **1 row after close**; relaunch reported **0 spaces**, then a same-name space got a **new id** and `PRIVATE-OK`; another space was `PRIVATE-DENIED`. | Login persists across CLI processes while Chrome is alive. After `ego-browser shutdown`, one clean run failed on resume with `task.listTabs: CDP WebSocket error`; another resumed `PRIVATE-OK`. | In this test Rook did not write the cookie while running (0 rows after 15 s); the row appeared after a clean close, so a SIGKILL would not get that flush. The space and its tabs are not restored — only the on-disk store keyed by the space's slug comes back if you recreate the same name. |
| 4 | Two agents in parallel, different spaces | **Pass.** A `PRIVATE-OK`, B `PRIVATE-DENIED`; localStorage markers stayed `A`/`B2` in their own spaces; window title stayed `New tab - Rook` before/during/after; no tab stealing. | **Pass.** Same isolation; headless. | The best behaviour in the product. See [`02-parallel.png`](eval-logs/shots/02-parallel.png). |
| 5 | Popup: `window.open`, drive popup, opener | Popup arrives as `p2`; receipt `{popups:[…]}`; child input/button work. But **`window.opener` is `null`** and **`window.open()` returns `null`**. | `window.opener` is an **object**; `window.open()` returns an **object**; child drive works. | This is the clearest fidelity gap versus Chrome, and it is documented in Rook's README. OAuth/SSO popups that use `window.opener` or `postMessage` may fail. |
| 6 | Cross-origin iframe: refs and clicks | **Pass.** Snapshot included the `127.0.0.2` frame's heading, textbox and button; ref click landed; `{scope:"subtree", root:"@iframe"}` worked. | **Pass.** Same. | Genuinely good; this is the hard case the pitch talks about. |
| 7 | Upload and download | **Pass.** `setInputFiles` → `UPLOAD-OK`, `upload.txt`; download saved 25 bytes, `rook-download-payload-42`. | **Pass.** Same. | Upload server-side byte count includes multipart overhead (fixture detail, not a bug). |
| 8 | Clipboard: textarea + contenteditable | **Pass.** Text and contenteditable text; HTML paste produced `<b>bold html</b>`; previous clipboard `ORIGINAL-CLIP` restored. | **Pass** for text and HTML in headful Chrome; the restore check blocked on `xclip -o`, so restore is unverified. | Host paste needs `xclip` on `PATH` and `DISPLAY`; documented. One clipboard representation at a time. |
| 9 | Screenshot through the skill | **35 ms**, 1056×732 PNG, viewed. | **43 ms**, 1280×713 PNG, viewed. | [`03-host-form-screenshot.png`](eval-logs/shots/03-host-form-screenshot.png), [`04-standalone-form-screenshot.png`](eval-logs/shots/04-standalone-form-screenshot.png). |
| 10 | Recovery: dialogs, close mid-command, navigate away, broken selector | Handled alert/confirm/prompt all pass (`CONFIRM-TRUE`, `PROMPT:typed-answer`). Broken selector: **3.09 s**, `page.click timed out after 3000ms: Selector #does-not-exist matched 0 elements`. Navigate-away: **3.09 s**, same clear shape. Stale ref: **105 ms**, `Stale ref: @1; take a new snapshot`. Close tab while a wait was pending: wait ran the **full 20.4 s timeout** instead of failing on tab close. Unhandled alert: next command threw `PageDialogOpenedError` (clear), but a following round hung at `taskSpace` for >30 s and had to be killed. | Not repeated in full; same SDK surface. | Error text is useful, but the tab-close case is a slow failure, not a fast abort. |
| 11 | Feel: idle CPU/memory; snapshot+click | 1 tab: **887 MiB** summed RSS / **339 MiB** PSS; idle CPU 0.0–0.4 %. 3–4 spaces: **930–1323 MiB** RSS / **433–442 MiB** PSS; idle CPU 0.0–1.2 %. Docs page snapshot: **98/104/142 ms** (13.9 k chars, 379 lines); heading click **128 ms**. `/big` full-page snapshot: **453/487/578 ms** (123 k chars, 4,807 lines); click `#b600` **838 ms**. | `/big` viewport snapshot **486–504 ms**, click **773 ms**; screenshot 43 ms. | Numbers are noisy on Xvfb with software GL and background tabs; treat as rough. The `/big` page has 1,200 rows and 4,807 snapshot lines — larger than the README's 2.4k-node sample. The README's own measured p50 was 65 ms (target 40 ms) and p95 154 ms (target 150 ms); I did not reproduce those numbers. |
| 12 | Crash: kill bridge mid-task, restart, reconnect | **Partial.** SIGKILL of the `ego-browser` process during a 60 s wait; app stayed alive; a new round reattached, but the tab it found was `Clipboard`, not the `Profile form` page the killed round had loaded — the stale-record collision again. The `p1` label was lost (new process parent), so I adopted the tab and continued. | Not the same test (no app); Chrome survived, but stale contexts are a known issue above. | The app is crash-tolerant; the agent-side state is not. |

### Where it is worse than ego lite's pitch

The landing page and README say the point is “your agent working inside your real browser”, with “your real logins and tabs”, a Chrome-data migration, and “works as your daily browser”. Rook is deliberately the opposite in one important way: every agent space is a separate `CefRequestContext`, and the user profile is not shared.

| Claim (ego lite) | What Rook does here | Classification |
|---|---|---|
| “the agent can always reach your real logins and tabs through `ego-browser`” | A new `taskSpace()` gets an isolated cookie jar. A space logged into the fixture saw `PRIVATE-OK`; a second space on the same server saw `PRIVATE-DENIED` and an empty cookie. There is no path for an ordinary task space to read the `You` profile's cookies. Handoff (`task.handOff()` / `takeOverTaskSpace()`) can give an agent a user space after an explicit user action, but the default workflow does not. | **Missing feature / deliberate design**, not a Linux limitation. This is the biggest product gap. |
| “migrate your Chrome data: cookies, logins, extensions, bookmarks, open tabs” | No import path, no Chrome migration, no extensions/bookmarks/passwords UI. `listProfiles()` reports one profile; the README says so. The profile starts empty. | **Missing feature.** |
| “works as your daily browser” | On this Xvfb/Openbox setup, clicking a form field and typing put nothing in the field (and nothing in the address bar). After an address-bar navigation, typed characters appended to the URL instead. There is no tab restore after relaunch, no import, no extensions, no bookmark/password UI, no URL handler, X11 only, one profile. | **Bug + missing features + Linux constraint.** The keyboard issue is the blocker for the “daily browser” claim; the rest is packaging/scope. |
| “the strongest page Snapshot on the market”, “deeply nested iframes” | Cross-origin iframe snapshots and refs are genuinely good. But popups expose `window.opener === null` and `window.open()` returns `null`; the `/big` full-page snapshot (1,200 rows, 4,807 lines) took 0.45–0.58 s here, with an 0.84 s click, versus the README's own measured 65 ms p50 (target 40 ms). | **Mixed:** iframe strength is real; popup/opener is a **CEF/Alloy limitation**; speed is a **performance gap on this box**, not a macOS comparison. |
| “faster runs, fewer tokens”, “code not CLI” | The code-based skill contract is preserved, and the same JS composes multi-step rounds. On this box a big-page round is ~1.0–1.4 s of browser work before model thinking; I did not measure tokens. | **Not established**; no head-to-head. The protocol is compatible, which is a real win. |
| “no extra setup” | The `.deb` unpacks and runs with the bundled Node/SDK. But it needs X11 (no native Wayland), glibc ≥ 2.38/libstdc++ ≥ 13, `xclip` or `wl-clipboard` for paste, ~444 MB installed; the app has no URL handler, auto-update or signed repo. | **Linux/packaging constraints**, mostly documented. |
| “any agent can drive it” | Yes at the protocol level. Page labels are keyed on the CLI's parent PID; a new shell per command loses `p1` (`page label not found: p1. Managed Pages in task space N: none`) even though the tab is still open. An agent that keeps one parent process is fine; one that spawns a shell per command is not. | **SDK/contract gap**, not unique to Rook, but it bites on Linux CLI use. |
| “spaces multitask; nobody steals your tabs” | **Passes.** Two simultaneous agents, separate cookies/storage, no view switch, no cross-talk. | Strength. |

The contradiction is worth stating plainly: ego lite's differentiator is shared access to the user's real browser; Rook's differentiator is isolation. Isolation is the safer design and is implemented well, but it means Rook cannot substitute for ego lite on the “use my existing logins” use case without a handoff step.

### Defects, ranked

### Blocker — stale space records collide with new host space ids after a restart

Rook's bridge persists `spaces.json`; the native app numbers spaces from `sp1` on every launch. After a restart a stale record with `hostSpaceId: "sp2"` is treated as live when the new app creates a different space as `sp2`. Resuming the old name then returns the *new* space's tab.

Reproduction (fresh `HOME`/`XDG_RUNTIME_DIR`; stop the app between the two runs; no fixture needed; full script in `docs/eval-logs/rounds/collision3.sh`, output in `35-collision-repro.out`):

```sh
# app run 1: alpha becomes sp2, loads ALPHA; kill the app
ego-browser nodejs -e 'const t=await taskSpace("alpha"); await t.page("p1").goto("data:text/html,<title>ALPHA</title>")'
# app run 2: beta also becomes sp2, loads BETA
ego-browser nodejs -e 'const t=await taskSpace("beta"); await t.page("p1").goto("data:text/html,<title>BETA</title>")'
# resume alpha
ego-browser nodejs -e 'const a=await taskSpace("alpha"); console.log(a.spaceId, (await a.tabs()).map(t=>t.title))'
```

Observed:

```text
host ids after phase1 [(1, 'alpha', 'sp2')]
host ids after phase2 [(1, 'alpha', 'sp2'), (2, 'beta', 'sp2')]
resumed alpha 1 [{"label":"p2","title":"BETA"}]
alpha actually sees BETA
```

Impact: wrong-space action and a page/data leak between unrelated agents. It is a **bug**, not a Linux limitation. Likely fix: an app-instance UUID in the record, or clear/re-key stale spaces on host startup.

### Blocker — keyboard input does not reach the page (daily-browser claim)

With the app focused, clicking a form field and typing produced no characters in the field and no characters in the address bar. The app only calls `CefBrowserHost::SetFocus(true)` on tab/space activation and navigation; I found no click-to-focus path for the CEF content. After using the address bar, the GTK entry keeps focus and typed text appended to the URL (`…login.htmljay`).

Reproduction (window at 81,67 after Openbox; field at 510,275 on the 1280×820 window):

```sh
rook --url http://127.0.0.1:8781/form.html &
xdotool mousemove 510 275 click 1
xdotool type --delay 30 'Jay Gupta'
# field empty, address bar unchanged
```

Evidence: [`05-host-form-before-typing.png`](eval-logs/shots/05-host-form-before-typing.png), [`06-host-form-after-typing.png`](eval-logs/shots/06-host-form-after-typing.png). This is a **bug** on this Xvfb/Openbox setup; a WM may focus the native child differently, but the code path suggests it is not WM-specific. I could not test a physical X desktop. It makes manual login, search boxes and form filling impossible, so the browser half of the product is not usable.

### Major — agent spaces cannot see the user's logins; no Chrome import

This is the central pitch gap, not a crash. `taskSpace()` creates an isolated context; `You` cookies are not visible. A second space returned `PRIVATE-DENIED` while the first was `PRIVATE-OK`. There is no Chrome migration/import, no extension/bookmark/password support, and `listProfiles()` reports one profile.

```sh
# space A: log in; space B: open /private.html
# A -> PRIVATE-OK; B -> PRIVATE-DENIED and cookie ""
```

Classification: **missing feature / design choice.** The README openly says spaces are isolated; the pitch is what makes it a problem.

### Major — spaces and tabs do not survive relaunch

A clean close/relaunch left `listTaskSpaces()` empty and gave the next space a new numeric id. The on-disk cookie store came back only when I recreated a space with the same name (`PRIVATE-OK`), and tabs/URLs were gone. The user's sidebar after relaunch is just `You`; the agent's old space is not there to resume.

Reproduction: log in in a space, close the window with the WM, relaunch, run `listTaskSpaces()` — output `[]`; `taskSpace("same-name")` gets a new id. See [`08-persist2.out`](eval-logs/08-persist2.out).

Classification: **missing session-restore feature.** In this test the SQLite cookie DB had 0 rows while running and the cookie appeared after a clean `CefShutdown`; a SIGKILL would miss that flush.

### Major — page labels are tied to the CLI process's parent PID

`SKILL.md` says task spaces, tabs and Page labels persist. In practice the SDK's ledger key is `process.ppid` (`runtimeInstanceId`). A new shell per command gives a new parent, so the ledger is discarded:

```sh
ego-browser nodejs -e 'const t=await taskSpace("x"); console.log((await t.pages()).length)'
# first process: 1
ego-browser nodejs -e 'const t=await taskSpace("x"); console.log((await t.pages()).length)'
# second process: 0; task.page("p1") -> "page label not found: p1. Managed Pages in task space N: none."
```

An agent CLI that keeps a stable parent (or spawns `ego-browser` directly) is fine; one that shells out per command is not. This is **upstream SDK behaviour**, but it is an operational gap for “any agent” and for humans running the CLI by hand.

### Major — popups have no live `window.opener`

```js
const wait = page.waitForEvent("popup")
await page.click("#open")
const pop = await wait
console.log(await pop.evaluate(() => String(window.opener === null ? "null" : typeof window.opener))) // "null"
console.log(await page.evaluate(() => document.getElementById("status").textContent)) // "window.open returned: null"
```

Driving the popup itself works (`p2`, input/button). On stock Chrome the same test returns `object`/`object`. Classification: **CEF/Alloy limitation / missing feature**, documented by Rook. It is a real compatibility break for OAuth and opener-based apps.

### Major — closing a tab while a command waits does not cancel the command

```js
const waiting = page.waitForSelector("#never", { timeout: 20000 })
await page.close()
console.log(await waiting)
```

Observed `WAIT-ERROR: page.waitForSelector timed out after 20000ms: #never-appears after_ms 20402`. The tab did close (`pages []`), but the pending command waited its full timeout instead of failing with a closed-target error. An agent can burn 20 s per dead tab. Classification: **bug/behaviour gap.**

### Major — unhandled alert leaves the page modal, and a later round can hang at `taskSpace`

Handled dialogs are good: `receipt.dialog` identifies alert/confirm/prompt; `acceptDialog("typed-answer")` works. If the alert is left open, the next command fails clearly:

```text
PageDialogOpenedError: Runtime.evaluate cannot run while a JavaScript alert dialog ("ALERT-OK") is open; handle it with page.acceptDialog() or page.dismissDialog() before continuing
```

But a subsequent fresh round (`taskSpace("recover3")`) did not return within 30 s; I killed it. If the alert is left open, recovery is not self-service. Classification: **bug**, with the caveat that my probe was after a tab-close and a killed process.

### Major — standalone `shutdown` then resume is inconsistent

```sh
ROOK_BACKEND=standalone ego-browser nodejs -e '…login in space persist-iso…'
ego-browser shutdown
ROOK_BACKEND=standalone ego-browser nodejs -e 'const t=await taskSpace("persist-iso"); …'
# one clean run:
# task.listTabs: CDP WebSocket error: Received network error or non-101 status code.
```

A second run resumed `PRIVATE-OK`, so the failure is race-dependent. Either way the user gets a raw CDP error, not an `EGO_*` recovery message. Classification: **bug in the standalone baseline**; it matters because the README presents standalone as the dev/test path.

### Major — performance target not reproduced

On the `/big` page (1,200 rows; 4,807 snapshot lines — larger than the README's 2.4k-node sample), a **full-page** snapshot took 453/487/578 ms (123 k chars) and `#b600` click took **838 ms**; the README's own measured p50 was 65 ms (target 40 ms), p95 154 ms (target 150 ms) on a 2.4k-node page. A normal docs page was 98–142 ms per snapshot, 128 ms per click. Standalone was 486–504 ms for the viewport and 773 ms for the click. This is measured on a 1440×900 Xvfb box with software GL and background tabs, so it is not a like-for-like macOS comparison; it is still far from the advertised feel.

### Minor — second launch is not a clean single-instance error

Launching `rook` while an app is already running printed `Opening in existing browser session.` and left a 1050×880 `New Tab - Chromium` top-level window at (10,10) over the app; it was mostly black and owned by the first app's PID. I saw this once; I did not re-run it after a clean start. A single-instance guard that focuses the existing window would be better. See [`09-stray-window.png`](eval-logs/shots/09-stray-window.png).

### Minor — no-WM/XDestroy close skips CEF shutdown

`xdotool windowclose` on an X11 session without a WM destroys the window; the app then took 5.1 s, logged `shutdown watchdog: the message loop did not return within 5 s (open browsers: N)`, and never printed `CefShutdown finished`. With Openbox and a proper `WM_DELETE_WINDOW` the same app closed in **103–316 ms** and did print `CefShutdown finished`. Normal desktop users have a WM, but scripted QA and kiosk setups do not; the watchdog path also explains why cookies are not flushed on that close.

### Minor — protocol errors are not always the documented `EGO_*` codes

`docs/native-bindings-api.md` promises stable `error_code` values such as `EGO_TASK_HOST_DISCONNECTED` and `EGO_CDP_SEND_FAILED`. I also saw raw `task.listTabs: CDP WebSocket error…` and SDK-level `PageDialogOpenedError`. Useful messages, but an agent matching on `error_code` (as the native API doc suggests) cannot rely on them everywhere.

### Minor — one clipboard representation

`keyboard.paste({text, html})` carries HTML only with `xclip`; a plain `<textarea>` receives nothing (the README documents this). A user pasting rich text into a plain field gets an empty field rather than the text fallback. Not a blocker, but easy to trip over.

### What surprised me positively

- **Cross-origin iframes really work.** The snapshot of `127.0.0.1` included the `127.0.0.2` frame's heading, textbox and button, refs resolved, and the click landed. That is the case the pitch brags about, and Rook handled it.
- **Parallel isolation is clean.** Two agents ran at once; A was `PRIVATE-OK`, B was `PRIVATE-DENIED`; localStorage markers stayed in their own spaces; the visible page never changed from `New tab - Rook`. No cross-talk, no tab stealing.
- **Popups are drivable once you have the handle.** The receipt gave `p2`, the child input and button worked, and `task.tabs()` showed both pages with labels.
- **Clean shutdown/relaunch preserves the cookie store by space name.** The cookie DB went from 0 rows while running to 1 row after close, and the same-name space came back `PRIVATE-OK`; a different space stayed `PRIVATE-DENIED`. The data model is sound even though the session UI is not restored.
- **Crash survival.** SIGKILLing the bridge mid-task did not take the app down; a new round reconnected to a live tab and continued. The tab identity was wrong (the collision above), but the app itself did not hang or die.
- **Cold start is fast** (0.2–0.6 s to socket) and a page screenshot is 35 ms.

### What a Mac-only review could not tell you

- Whether `ego lite`'s popups expose a live `window.opener`. Rook's `null` may be a CEF Alloy limitation rather than a protocol limitation; only a macOS run can settle it.
- Whether `ego lite` has the same keyboard/focus behaviour. My failure is on Xvfb + Openbox; a real macOS window server and the native app may focus the web view correctly.
- Whether `ego lite` restores spaces/tabs after relaunch, or expects agents to resume by name. Rook's README does not claim restore, but the task “session persisted in that space” is only half true here.
- Whether `ego lite` really gives a new agent space the user's existing cookies. Its landing page and migration copy say yes; the native bindings doc only describes task-scoped APIs, so I could not verify the handoff semantics without the app.
- Snapshot quality and latency on Apple Silicon with the customized engine; this review's 0.45–0.58 s and popup/opener results are Linux/CEF numbers, not a head-to-head.
- Chrome import, extensions, bookmarks, passwords and auto-update on macOS. Rook has none of those; ego lite claims all of them.
- The AppImage path and a real `dpkg -i` (setuid sandbox) install; only the extracted `.deb` tree was exercised here.

### Reproduction notes

- The extracted tree is `/tmp/opencode/rook-eval/root`; launcher `/tmp/opencode/rook-eval/root/usr/bin/rook`; CLI `/tmp/opencode/rook-eval/root/usr/bin/ego-browser`.
- Fixture server: `docs/eval-logs/fixtures-server.mjs`; it serves `127.0.0.1:8781` and `127.0.0.2:8781` from the same listener.
- Host runs used `HOME=/tmp/opencode/rook-eval/home`, `XDG_RUNTIME_DIR=/tmp/opencode/rook-eval/run`, `DISPLAY=:120` (or `:121` for the clean collision test).
- Standalone runs set `ROOK_BACKEND=standalone` and a separate `EGO_BROWSER_STATE_DIR`; clipboard used `ROOK_HEADFUL=1`.
- Raw logs are in `docs/eval-logs/`; the round scripts that produced them are in `docs/eval-logs/rounds/`.
- No source under `host/`, `runtime/` or `vendor/` was modified; nothing was committed or pushed.
