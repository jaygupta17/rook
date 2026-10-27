# Performance budget — measured

Run 2026-10-27T11:02:46.802Z, on 4 cores (AMD Ryzen 9 9950X 16-Core Processor), 7.8 GiB RAM, kernel 6.8.0-117-generic. Package `rook_0.3.0~m3_amd64.deb` (0.3.0~m3), unpacked with `dpkg-deb -x` and run from a private Xvfb. The budget is the target column below.

**3 of 7 targets met**; over budget on `Memory, one tab open`, `Extra memory per parked space`, `Snapshot, median`, `Snapshot, p95`.

| Metric | Target | Measured (median ± spread) | Verdict | Method |
|---|---|---|---|---|
| Cold start to first paint | ≤ 1500 ms | 259.2 ms ± 15.0 (244.5..259.5) | **pass** | exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle. |
| Memory, one tab open | ≤ 250 MiB | 940.0 MiB ± 8.3 (936.8..945.1) | **FAIL** | Sum of Rss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), 60 s after the tab loaded. Pss is reported too: Rss double counts pages shared between processes. |
| Extra memory per parked space | ≤ 120 MiB | 129.9 MiB ± 4.5 (127.5..132.0) | **FAIL** | (RSS with 4 spaces - RSS with 1 space) / 3, same page in every space, 60 s after load. The three parked spaces are WasHidden(true); the app reports 'parked' in its log, which the harness counts. |
| CPU while idle | ≤ 1 % | 0.75 % ± 0.13 (0.70..0.83) | **pass** | Delta of utime+stime over the whole process tree across a 60 s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %. |
| Snapshot, median | ≤ 40 ms | 64.8 ms ± 4.2 (64.7..68.8) | **FAIL** | 30 snapshots per run x 3 runs on the long list (2412 nodes), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF), viewport scope (the default). Each run's own p50, then median and spread across runs. |
| Snapshot, p95 | ≤ 150 ms | 154.2 ms ± 11.2 (150.4..161.6) | **FAIL** | Same samples as the p50 row; p95 of each run on the heavy dashboard (3797 nodes, 5794 snapshot lines), median and spread across runs. |
| Installed size | ≤ 450 MB | 444 MB (one figure, no spread) | **pass** | dpkg's Installed-Size field of the .deb (KiB -> MB), i.e. what dpkg reports for the installed tree. The compressed .deb and the AppImage are listed for context. |

Every row is three runs unless the method says otherwise; `spread` is `max − min` across them.

## Baseline, for context

| Baseline | Measured | Method |
|---|---|---|
| Chrome, headless, one tab | 1090.8 MiB ± 15.4 (1081.1..1096.5) | google-chrome --headless=new, one page loaded, RSS over the Chrome pid tree after a 15 s window. |
| Chrome, headless, cold start | 328.6 ms ± 41.7 (306.1..347.7) | exec -> PNG written by --screenshot, warm profile. Headless Chrome has no window, so there is no framebuffer to poll; this is its own equivalent measurement, not the same instrument as the rook number. |

## What this means

Starting the app is the part that works: 259 ms from exec to a painted page, comfortably inside the 1.5 s budget, and faster than plain headless Chrome produces a frame on this box (329 ms). Sitting idle, the app holds 940 MiB of RSS across 10 processes — plain headless Chrome holds 1091 MiB on the same box for one page — which is 3.8× over the 250 MiB budget; its proportional share (Pss) is 353 MiB, so roughly 62 % of that sum is pages shared with the other processes in the tree. Each additional parked space costs 130 MiB (over the 120 MiB allowance), so four spaces is 1335 MiB. CPU idle is 0.75 % of one core, inside the 1 % budget: parking spaces does throttle them. Snapshots are the real gap: 65 ms p50 on a 2,000-node page against a 40 ms budget, and 154 ms p95 on the dashboard against 150 ms, which is what an agent waiting on the page feels. The package itself is 444 MB installed, inside the 450 MB ceiling.

**Borderline, so it will flip between passes on this box:** Extra memory per parked space at 129.9 MiB against 120 MiB; Snapshot, p95 at 154.2 ms against 150 ms. That is inside what a shared box moves these numbers by, so treat those verdicts as coin flips.

### Where the memory goes (one tab, idle)

| Process | Count | RSS | Pss |
|---|---|---|---|
| cef child (zygote fork) | 8 | 543 MiB | 155 MiB |
| browser | 1 | 284 MiB | 159 MiB |
| utility:network | 1 | 109 MiB | 39 MiB |

### Three biggest contributors to the cost

1. **The CEF runtime, counted once per process (587 MiB of the 940 MiB)** — RSS sums every process in the tree, and each of the 10 processes maps the same 277 MB libcef.so from the package. The gap between summed RSS (940 MiB) and summed Pss (353 MiB) is that double count. It is not memory the app can give back, but a budget written as "total RSS" pays for it once per process, so the number of processes is itself a cost.
2. **One browser context per space (130 MiB per extra parked space)** — 4 spaces cost 1335 MiB against 940 MiB for 1: 130 MiB per space. Parking a space (WasHidden(true)) throttles its timers but does not drop its browser: with all four awake the tree measures 1312 MiB against 1335 MiB parked — within 2 % of each other, so parking buys no memory at all. Parking is a CPU knob, not a memory one.
3. **Snapshot cost scales with the page, not with the viewport (26 µs per element)** — p50 goes from 5 ms at 21 elements to 66 ms at 2412 elements and 141 ms at 3797 elements. Filtering to the viewport does not avoid that work: the same call without the filter (`scope: "full_page"`) costs 71 ms instead of 66 ms on the long list and 154 ms instead of 141 ms on the dashboard, because Accessibility.getFullAXTree reads the whole document before anything is filtered out. The host socket is not the cost: the same call against the bridge's own headless Chrome, with no app process in between, takes 74 ms against 66 ms here.

### Is the host socket the bottleneck?

The same snapshot calls, run through the same CLI against the bridge's own headless Chrome (no control socket, no host process in between):

| Page class | Through the app (p50) | Same bridge, own Chrome (p50) |
|---|---|---|
| small form | 5 ms | 7 ms |
| long list | 66 ms | 74 ms |
| heavy dashboard | 141 ms | 147 ms |

If the two columns are close, the cost is the snapshot pipeline itself, not the pipe to the app.

## How it was measured

- **Cold start to first paint** — exec -> first frame containing the page's own marker colour, polled from the framebuffer at ~4 ms; fresh profile and fresh X server per run. Not screenshot-mode minus a baseline: that path carries a fixed 900 ms settle.
- **Memory, one tab open** — Sum of Rss over every process in the app's pid tree (/proc/<pid>/smaps_rollup), 60 s after the tab loaded. Pss is reported too: Rss double counts pages shared between processes.
- **Extra memory per parked space** — (RSS with 4 spaces - RSS with 1 space) / 3, same page in every space, 60 s after load. The three parked spaces are WasHidden(true); the app reports 'parked' in its log, which the harness counts.
- **CPU while idle** — Delta of utime+stime over the whole process tree across a 60 s window, 4 spaces (3 parked, the visible one included), divided by the window: percent of one core. Kernel jiffies, so ±0.02 %.
- **Snapshot, median** — 30 snapshots per run x 3 runs on the long list (2412 nodes), through 'ego-browser nodejs' with ROOK_BACKEND=host (bridge -> control socket -> CEF), viewport scope (the default). Each run's own p50, then median and spread across runs.
- **Snapshot, p95** — Same samples as the p50 row; p95 of each run on the heavy dashboard (3797 nodes, 5794 snapshot lines), median and spread across runs.
- **Installed size** — dpkg's Installed-Size field of the .deb (KiB -> MB), i.e. what dpkg reports for the installed tree. The compressed .deb and the AppImage are listed for context.

Fixture pages are generated locally and served from 127.0.0.1; no page in this bench touches the network. Each measured run gets its own Xvfb (never `:99`, which other QA runs on this box share) and its own profile directory. Node v22.23.4, Google Chrome 151.0.7922.108 stable.

