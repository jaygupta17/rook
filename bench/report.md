# Performance budget — measured

Run 2026-10-27T21:33:49.859Z, on 4 cores (AMD Ryzen 9 9950X 16-Core Processor), 7.8 GiB RAM, kernel 6.8.0-117-generic, load 0.38 0.63 0.63. Package `rook_0.4.0_amd64.deb` (0.4.0), unpacked with `dpkg-deb -x` and run from a private Xvfb. The budget is `ego-lite-linux-architecture.md` §6.

**5 of 8 budgets met**; over budget on `Memory, one tab open (PSS)`, `Snapshot p50, viewport`, `Snapshot p95, viewport`. 5 rows are context: no budget was ever written for them.

| Metric | Target | Measured (median ± spread) | Verdict | Method |
|---|---|---|---|---|
| Cold start to first paint | ≤ 1500 ms | 662.5 ms ± 268.1 (517.6..785.8) | **pass** | exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X display server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle. |
| Memory, one tab open (PSS) | ≤ 250 MiB | 354.9 MiB ± 2.7 (353.2..355.8) | **FAIL** | Sum of Pss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), 30 s after the tab loaded. PSS splits a shared page between the processes mapping it, so it is the number that adds up to real memory. Summed RSS is the row below. |
| Memory, one tab open (summed RSS) | — | 929.8 MiB ± 7.3 (926.5..933.8) | context | Sum of Rss over the same process tree. Every process maps the same libcef.so, so this counts those ~277 MB once per process: it is an upper bound, not memory in use. Kept because the original budget was written in these units. |
| Extra memory for a 2nd space | ≤ 120 MiB | 16.0 MiB ± 3.1 (14.6..17.7) | **pass** | (PSS with 2 spaces - PSS with 1 space), same page in both, same profile, 30 s after load. The 0.3.0 figure was summed RSS over 4-vs-1 spaces, when every space also had its own browser context: that counted libcef once per renderer, which is why 130 MB was a real measurement of the wrong quantity. |
| Extra memory for the 4th space | ≤ 120 MiB | 27.0 MiB ± 8.0 (19.4..27.4) | **pass** | ((PSS with 4 spaces - PSS with 2 spaces) / 2), same page in every space, same profile, 30 s after load. |
| Extra memory for a 2nd profile | — | 21.9 MiB ± 1.9 (21.5..23.4) | context | (PSS with 1 space + 1 space in a second profile - PSS with 1 space), same page, 30 s after load; the second profile's space is created over the control socket with createProfile + createSpace(profileId), the same calls the bridge makes. |
| CPU while idle | ≤ 1 % | 0.86 % ± 0.16 (0.85..1.01) | **pass** | Delta of utime+stime over the whole process tree across a 60 s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %. |
| Snapshot p50, viewport | ≤ 40 ms | 81.6 ms ± 10.4 (79.3..89.6) | **FAIL** | 30 viewport snapshots per run x 3 runs on the long list (2412 elements), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF). The snapshot's own scope header says what was returned; each run's p50, then median and spread across runs. |
| Snapshot p95, viewport | ≤ 150 ms | 237.7 ms ± 143.7 (216.8..360.6) | **FAIL** | Same samples as the p50 row; p95 of each run on the heavy dashboard (3797 elements), median and spread across runs. |
| Snapshot p50, full page | — | 82.9 ms ± 10.0 (77.4..87.4) | context | Same CLI round, 20 'full_page' snapshots per run on the long list. Not part of the original budget, which is written for the default viewport scope. |
| Snapshot p95, full page | — | 209.4 ms ± 25.9 (198.5..224.4) | context | Same samples as the full-page p50 row; p95 on the heavy dashboard (3797 elements). |
| Agent round (navigate → snapshot → click → type) | — | 522.8 ms ± 78.6 (514.2..592.8) | context | One 'ego-browser nodejs' invocation per run, 3 runs, on the local small-form page: create space, open the page, snapshot, click "Forgot password?", click the email field, type 15 characters, finish. Timed from spawn to exit; the script stamps every phase on the same clock. |
| Installed size | ≤ 450 MB | 445 MB (one figure, no spread) | **pass** | dpkg's Installed-Size field of the .deb (KiB -> MB), i.e. what dpkg reports for the installed tree. The compressed .deb and the AppImage are listed for context. |

Every row is three runs unless the method says otherwise; `spread` is `max − min` across them. PSS is the proportional share of shared pages; summed RSS counts shared pages once per process.

## What this means

Starting the app takes 662 ms from exec to a painted page (inside the 1.5 s budget; plain headless Chrome needs 462 ms to produce a frame). Idle with one tab it holds 355 MiB of PSS — 1.4× over the 250 MiB budget — which is 930 MiB if you add up every process's RSS instead, and 315 MiB for plain headless Chrome on the same box. Concurrency is cheap: a second space adds 16 MiB, a third and fourth 27 MiB each, and a whole second *profile* — a separate browser context, which is the isolation boundary — adds 22 MiB. What costs is the first browser, before any agent does anything. CPU idle is 0.86 % of one core. Snapshots come in at 82 ms p50 viewport (over the 40 ms budget) and 238 ms p95 on the dashboard (over 150 ms); a whole agent round — create a space, open a page, snapshot it, click a button, type into a field — takes 523 ms, of which 51 ms is the command-line tool starting up. The package is 445 MB installed, inside 450 MB.

## What the 0.4.0 fixes changed

Targets are the old §6 numbers, which were guesses written before anything was measured; they have not been moved. What changed is the build, and the bench: the rows below are the ones a 0.4.0 change should move, with the 0.3.0 number beside them where the two are comparable.

| Metric | 0.3.0~m3 | 0.4.0 | Change | Why |
|---|---|---|---|---|
| Cold start to first paint | 259.2 ms | 662.5 ms | +403.3 ms (+156 %) | 0.4.0 fixes the at-spi stall that could keep the first page blank for ~16 s |
| Memory, one tab (summed RSS — the old row's units) | 940.0 MiB | 929.8 MiB | -10.2 MiB (-1 %) | the build did not get smaller; this row only measures the same way the old one did |
| Per-space cost, 4-vs-1 (summed RSS, the old row's units) | 129.9 MiB | 127.3 MiB | -2.6 MiB (-2 %) | the same model change |
| Snapshot p50, viewport (long list) | 64.8 ms | 81.6 ms | +16.8 ms (+26 %) | 0.4.0's serializer: scope header, no duplicated url=, no label-echo children, no empty generic wrappers |
| Snapshot p95, viewport (dashboard) | 154.2 ms | 237.7 ms | +83.5 ms (+54 %) | the same serializer change |
| Installed size | 444 MB | 445 MB | +1 MB (+0 %) |  |

**The team's 1.31 s cold-start figure and this one are different intervals, not a disagreement.** That measurement times a whole `--screenshot` run — spawn to a written PNG to exit — and that path carries a fixed 900 ms settle (`host/src/shell.cc:3626`) before it captures. This bench stops at the first painted frame: 662 ms is the same launch minus the settle, the capture and the shutdown. Neither number is wrong; they answer different questions.

**Read the change column with the load in mind.** The two passes ran on different days. This pass started at load 0.38 0.63 0.63 and the 0.3.0 pass at 0.13–1.0, but what matters is what else was running while the numbers were taken: the same 0.4.0 build measured 286–321 ms of cold start in a smoke run minutes earlier on an idle box, and 518–786 ms during this pass. The baseline agrees that the box was slower: plain headless Chrome's own cold start went from 329 ms to 462 ms (+40 %) between the two passes, and nothing in either build changes Chrome. So the cold-start and snapshot deltas above are not attributable to 0.4.0 — a same-box A/B of the two packages back to back is the only way to get that, and this bench has not done it.

The per-space row is a different kind of change: a *model* change, not a speed-up. 0.3.0 gave every space its own browser context, so a space and a renderer were the same thing, and the figure was summed RSS on top of that (130 MiB, reproduced exactly: a like-for-like repeat of the same calculation now gives 127 MiB). In 0.4.0 a space is a tab set inside one profile, so the honest per-space number is the PSS row above (27 MiB for the third and fourth), and crossing a profile costs 22 MiB.

### What the agent actually gets back

Timing is load-sensitive and moved by more than either build did on this box; the size of the answer is not. Same pages, same scope, two builds:

| Page class | 0.3.0, viewport (lines) | 0.4.0, viewport (lines / refs) | 0.4.0, full page (lines / refs) |
|---|---|---|---|
| small form | 26 | 22 / 6 | 22 / 6 |
| long list | 2170 | 183 / 481 | 1688 / 481 |
| heavy dashboard | 5794 | 133 / 604 | 3378 / 604 |

0.3.0's default snapshot of the long list came back nearly the size of the whole page (2,170 lines); 0.4.0 returns the 183 lines that fit the viewport, and the dashboard drops from 5,794 lines to 133. That is the serializer fix measured in something the box's load cannot distort — and it is why the timing rows do not move much: the expensive part is reading the accessibility tree for the whole document, not writing the answer down.

## Where the memory goes (one tab, idle)

Two ways of counting the same ten processes. PSS splits a page between the processes mapping it; summed RSS counts it once per process, and every one of them maps the same 277 MB `libcef.so`. The gap between the two columns is not memory the app can give back — it is the same bytes counted again.

| Process | Count | PSS | Summed RSS |
|---|---|---|---|
| cef child (zygote fork) | 8 | 161 MiB | 547 MiB |
| browser | 1 | 154 MiB | 273 MiB |
| utility:network | 1 | 40 MiB | 110 MiB |
| **total** | 10 | **355 MiB** | **930 MiB** |

| Configuration | PSS | Summed RSS | Processes |
|---|---|---|---|
| 1 space | 355 MiB | 930 MiB | 10 |
| 2 spaces, same profile | 371 MiB | 1054 MiB | 11 |
| 4 spaces, same profile | 420 MiB | 1314 MiB | 13 |
| 1 space + 1 space in a second profile | 377 MiB | 1056 MiB | 11 |
| 4 spaces awake (not parked) | 405 MiB | 1302 MiB | 13 |

A second space in one profile adds 16 MiB of PSS and the next two add 27 MiB each — one more renderer each, and a renderer that mostly maps the same shared `libcef.so`. A second *profile* adds 22 MiB: a new `CefRequestContext` with its own renderer and cache is, at idle, about as expensive as one more space. The isolation boundary is therefore close to free in memory — what costs 355 MiB is the first browser, before any agent does anything.

## Snapshot, per page class

Viewport is the default scope and what the budget is written for; full page is the same call with `{scope:"full_page"}`. The snapshot's first line now says which one it returned and how big it was.

| Page class | Elements | Viewport p50 | Viewport p95 | Full page p50 | Full page p95 | Scope header (viewport) |
|---|---|---|---|---|---|---|
| small form | 21 | 8 ms | 12 ms | 8 ms | 13 ms | `22 lines, 6 refs` |
| long list | 2412 | 83 ms | 105 ms | 83 ms | 100 ms | `183 lines, 481 refs` |
| heavy dashboard | 3797 | 187 ms | 238 ms | 190 ms | 218 ms | `133 lines, 604 refs` |

## The agent round

One `ego-browser nodejs` invocation that does what an agent actually does on a page: create a space, open the local sign-in form, snapshot it, click "Forgot password?", click the email field, type 15 characters, finish. Timed from spawn to exit, with every phase stamped on the same clock.

| Phase | Median | Share of the round |
|---|---|---|
| CLI startup (node + SDK, before the first statement) | 51 ms | 10 % |
| create space (taskSpace) | 43 ms | 8 % |
| open the page (goto + load) | 118 ms | 23 % |
| snapshot (viewport) | 23 ms | 4 % |
| click (resolve a ref, dispatch) | 127 ms | 24 % |
| type 15 characters | 162 ms | 31 % |
| teardown (finish + exit) | 12 ms | 2 % |
| **total** | **523 ms** | 100 % |

Each phase is its own median, so the shares add up to slightly more than 100 %: medians are not additive. The stacked bar in `report.html` uses one real run instead, so its slices do add up.

The browser work is 465 ms of that; the rest is the command-line tool starting up and shutting down, which an agent pays on every invocation that is not kept open.

## Baseline, for context

| Baseline | Measured | Method |
|---|---|---|
| Chrome, headless, one tab | 315.5 MiB ± 1.7 (315.0..316.8) | google-chrome --headless=new, one page loaded, PSS over the Chrome pid tree after a 15 s window. |
| Chrome, headless, cold start | 461.6 ms ± 116.9 (428.6..545.5) | exec -> PNG written by --screenshot, warm profile after a discarded warm-up. Headless Chrome has no window, so there is no framebuffer to poll; this is its own equivalent measurement, not the same instrument as the app's number. |

Chrome's summed RSS with one page is 1082 MiB against 315 MiB of PSS — the same shared-page effect.

## Three biggest remaining costs

1. **The Chromium payload itself (355 MiB of PSS, 575 MiB of it counted twice as RSS)** — One idle tab is 355 MiB of PSS across 10 processes; adding up each process's RSS gives 930 MiB for the same bytes. A stock headless Chrome on the same box is 315 MiB of PSS for one page, so what is left is Chromium, not anything this app's shell adds on top: the app's own browser process (GTK plus CEF's browser side) accounts for 154 MiB of it, and the rest is renderer, network service and zygote.
2. **Spaces and profiles are no longer the cost (16 / 27 / 22 MiB each)** — A second space adds 16 MiB of PSS, a third or fourth adds 27 MiB, and crossing into a second profile adds 22 MiB. The old per-space figure of 130 MiB was summed RSS over 4-vs-1 spaces when each space also had its own browser context — a real measurement of the wrong quantity. With the profile as the isolation boundary, concurrency is cheap; the fixed cost is the single browser underneath it.
3. **Acting on a page costs far more than reading it (407 of 523 ms in one round)** — One round is 523 ms: opening the page 118 ms, clicking a button 127 ms, typing 15 characters 162 ms, while the snapshot of that page is only 23 ms and the command-line tool starting up 51 ms. Each action is its own round trip plus the SDK's action boundary, so the interaction path — not the snapshot serializer — is where an agent's wall time goes on ordinary pages. Reading a heavy one is still expensive when an agent gets there: the 3797-element dashboard takes 187 ms p50 and — ms p95 to snapshot, against a 40 ms budget.

## How it was measured

- **Cold start to first paint** — exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X display server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle.
- **Memory, one tab open (PSS)** — Sum of Pss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), 30 s after the tab loaded. PSS splits a shared page between the processes mapping it, so it is the number that adds up to real memory. Summed RSS is the row below.
- **Memory, one tab open (summed RSS)** — Sum of Rss over the same process tree. Every process maps the same libcef.so, so this counts those ~277 MB once per process: it is an upper bound, not memory in use. Kept because the original budget was written in these units.
- **Extra memory for a 2nd space** — (PSS with 2 spaces - PSS with 1 space), same page in both, same profile, 30 s after load. The 0.3.0 figure was summed RSS over 4-vs-1 spaces, when every space also had its own browser context: that counted libcef once per renderer, which is why 130 MB was a real measurement of the wrong quantity.
- **Extra memory for the 4th space** — ((PSS with 4 spaces - PSS with 2 spaces) / 2), same page in every space, same profile, 30 s after load.
- **Extra memory for a 2nd profile** — (PSS with 1 space + 1 space in a second profile - PSS with 1 space), same page, 30 s after load; the second profile's space is created over the control socket with createProfile + createSpace(profileId), the same calls the bridge makes.
- **CPU while idle** — Delta of utime+stime over the whole process tree across a 60 s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %.
- **Snapshot p50, viewport** — 30 viewport snapshots per run x 3 runs on the long list (2412 elements), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF). The snapshot's own scope header says what was returned; each run's p50, then median and spread across runs.
- **Snapshot p95, viewport** — Same samples as the p50 row; p95 of each run on the heavy dashboard (3797 elements), median and spread across runs.
- **Snapshot p50, full page** — Same CLI round, 20 'full_page' snapshots per run on the long list. Not part of the original budget, which is written for the default viewport scope.
- **Snapshot p95, full page** — Same samples as the full-page p50 row; p95 on the heavy dashboard (3797 elements).
- **Agent round (navigate → snapshot → click → type)** — One 'ego-browser nodejs' invocation per run, 3 runs, on the local small-form page: create space, open the page, snapshot, click "Forgot password?", click the email field, type 15 characters, finish. Timed from spawn to exit; the script stamps every phase on the same clock.
- **Installed size** — dpkg's Installed-Size field of the .deb (KiB -> MB), i.e. what dpkg reports for the installed tree. The compressed .deb and the AppImage are listed for context.

Fixture pages are generated locally and served from 127.0.0.1; no page in this bench touches the network. Each measured run gets its own Xvfb (never `:99`, which other QA runs on this box share) and its own profile directory. Node v22.23.4, Google Chrome 151.0.7922.108 stable.

