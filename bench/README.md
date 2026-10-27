# bench — the §6 performance budget, measured

The architecture document (`ego-lite-linux-architecture.md` §6) states a budget. This
directory is the thing that checks it: the numbers taken from the packaged `.deb`, on this box,
with the method recorded next to every one of them.

```
bench/run.sh --report        # full pass, ~13 min on this box; writes results.json + report.md + report.html
ROOK_BENCH_QUICK=1 bench/run.sh --report   # same code, short windows, ~4 min (smoke test only)
bench/run.sh --force         # re-extract the .deb even if work/root is up to date
ROOK_BENCH_ONLY=idle bench/run.sh          # one section (cold, idle, snapshots, round, chrome) — no grades
```

No root, no install, no system-wide packages, no network in any measured page. The `.deb` is
extracted with `dpkg-deb -x` into `bench/work/root` and run from there, exactly as
`packaging/verify-deb.sh` does. `packaging/out/stale/` is never picked up.

| File | What it is |
|---|---|
| `run.sh` | entry point: pick the `.deb`, extract it, check tools, run the harness, write the reports |
| `bench.mjs` | the measurements |
| `xpoll.py` | polls the X framebuffer to timestamp the first painted frame (see "Cold start") |
| `lib/procs.mjs` | PSS/RSS/CPU out of `/proc` for the whole process tree |
| `lib/app.mjs` | launch the app, timestamp every line of its startup log |
| `lib/x11.mjs` | private Xvfb, X poller |
| `lib/control.mjs` | a small client for the app's control socket |
| `report.mjs` | `results.json` → `report.md` + `report.html` |
| `previous/` | older passes, so the report can print "was X on 0.3.0" next to a new number |
| `fixtures/` | the four pages, all generated locally |
| `results.json` | every number, including the raw per-run samples |
| `report.md`, `report.html` | the table, and a visual version for people who do not read tables |

The app is `usr/bin/rook` from 0.4.0 on (0.3.0 called it `ego-lite`; the harness accepts
either). The command-line tool is still `ego-browser`, because that is the name the official
skill and the Docker image use.

### Knobs

| Variable | Default | Meaning |
|---|---|---|
| `ROOK_BENCH_QUICK` | off | short windows (20 s, 2 runs, 10+6 snapshots) — a smoke test, not a grade |
| `ROOK_BENCH_ONLY` | all | `cold,idle,snapshots,round,chrome` — run one section, writes no grades |
| `ROOK_BENCH_RUNS` | 3 | runs per measurement |
| `ROOK_BENCH_IDLE_S` | 60 | CPU window (the 4-space configuration) |
| `ROOK_BENCH_MEM_S` | 30 | window for the other memory configurations (PSS/RSS are flat after ~10 s) |
| `ROOK_BENCH_WAKE_S` | 20 | window for the "4 spaces awake" configuration |
| `ROOK_BENCH_CHROME_IDLE_S` | 15 | idle window for the Chrome baseline |
| `ROOK_BENCH_SNAPSHOTS` | 30 | viewport snapshots per run |
| `ROOK_BENCH_FULL_SNAPSHOTS` | 20 | full-page snapshots per run |
| `ROOK_BENCH_DEB` | newest `packaging/out/rook_*.deb` | the package to measure |
| `ROOK_BENCH_CHROME` | `/usr/bin/google-chrome` | the baseline browser |
| `ROOK_BENCH_XVFB` | `/tmp/opencode/xvfb-root/usr/bin/Xvfb`, else `Xvfb` on `PATH` | Xvfb binary |
| `ROOK_BENCH_STANDALONE` | on | `0` skips the standalone-Chrome snapshot comparison |

`EGO_BENCH_*` spellings of all of these still work.

`bench/work/` is disposable: an unpacked copy of the `.deb` plus one directory per run.
`run.sh --force` re-extracts; deleting `bench/work` costs one re-extraction (about 6 s).

## What a full pass takes

About 13 minutes: 6 cold starts, five memory configurations watched for 20–60 s each, 9 CLI
rounds of 30+20 snapshots, 3 agent rounds, and the Chrome baseline. Most of it is time spent
waiting for a real window to sit still.

A measurement is only trusted at low load. Other passes on this box — while other agents were
compiling and running their own browsers — moved cold start from 0.25 s to 1.05 s and snapshot
p50 from 66 ms to 186 ms for the same pages. Memory barely moved. `results.json` records the
load at the start of the pass and again at the snapshot section; the report prints it. Do not
compare two passes without it.

## The seven measurements

### 1. Cold start — exec to first painted frame

**Method: poll the framebuffer.** The app's startup log has no timestamps, and
`--screenshot` mode carries a fixed 900 ms settle that cannot be separated from the number you
want, so neither of the obvious methods is honest. Instead:

- every measured run gets a **new Xvfb** (its own display, black root window, nothing else
  drawing on it) and a **profile directory that has never existed**;
- `xpoll.py` grabs the root window in a tight loop (~4 ms per pass, every 8th pixel) and
  reports the CLOCK_MONOTONIC timestamp of the first frame in which the fixture's own marker
  colour (`#0b8f6a`) is on screen — that is the *page*, not the GTK chrome around it;
- `lib/app.mjs` stamps the app's stderr lines with the same clock from the moment of fork, so
  "exec → paint" is a subtraction of two nanosecond timestamps on one clock.

Each run therefore yields three numbers, all in `results.json`:

| Field | Meaning |
|---|---|
| `paintMs` | exec → first frame containing the page's own colour. **This is the metric.** |
| `windowMs` | exec → first non-black pixel (the window is mapped, page still blank) |
| `loadedMs` | exec → the app's own `tab … loaded (http 200)` line |

The warm-profile series discards one warm-up run: the first launch into a fresh profile
directory only creates the profile (LevelDBs, cache dirs) and is not a normal launch.

Depth-24 Xvfb still hands out 32 bits per pixel with the top byte set (`0xff0b8f6a`), so the
poller masks to the colour bits before comparing. A poll costs ~4 ms, so the figure is
quantised by about that much.

**Two cold-start numbers exist, and they are different intervals.** The review log
(`docs/eval-logs/review2/packaged-0.4.0-coldstart.out`) times a whole `--screenshot` run — spawn → PNG → exit —
which carries a fixed 900 ms settle (`host/src/shell.cc:3626`) plus the capture and shutdown, and reads ~1.31 s.
This bench stops at the first painted frame and reads ~0.3–0.7 s depending on load. When quoting either, say
which interval it is.

**On the at-spi fix.** 0.4.0 stops the accessibility bridge from stalling the first page when
an AT-SPI bus answers but never replies; that was a ~16 s blank window on a normal desktop.
This box has **no session bus at all**, so the bridge is off in both 0.3.0 and 0.4.0 here and
the fix does not move this number. The number this bench reports is the no-bus path. If you
need the stall path, it needs a machine with an at-spi registry answering — state that
explicitly rather than reading a change into a flat row.

### 2. Idle memory — PSS and summed RSS

**Method: sum `Pss` and `Rss` over the process tree, 30 s after the tab loaded** (60 s for the
configuration that also carries the CPU window).

- the tree is every descendant of the launched pid (CEF re-executes the same binary for
  renderer/GPU/utility/zygote, so `ppid` walking finds all of them), plus any process whose
  command line carries this run's unique profile path;
- per process, `Pss` and `Rss` come from `/proc/<pid>/smaps_rollup`;
- the 5 s after `loaded` are excluded, so the measurement window does not contain the load.

**The two columns are the same memory counted differently.** Every process in the tree maps the
same `libcef.so` (~277 MB). Summed RSS counts those pages once per process — a ten-process app
reports ~940 MiB for ~370 MiB of memory. PSS splits each shared page between the processes
mapping it, so it adds up to something real. The budget row is PSS; summed RSS is kept as a
context row because the original §6 wording ("total RSS") was written in those units.

PSS has one caveat worth stating: when a new process starts mapping `libcef.so`, everyone's PSS
share shrinks, so a *delta* of PSS slightly understates the physical cost of one more process.
For "how much would one more space cost", read the delta and the process count together.

### 3. Spaces and profiles — marginal cost

**Method: the same page in every configuration, PSS delta against the 1-space baseline.**

| Configuration | What it is |
|---|---|
| 1 space | the baseline |
| 2 spaces, same profile | second tab in the same browser context |
| 4 spaces, same profile | four tabs in the same browser context |
| 1 space + 1 space in a second profile | the second space is created with `createSpace(profileId)`, the same call the bridge makes, in a profile created with `createProfile` |
| 4 spaces awake | the same four spaces held at `WasHidden(false)` by one CDP message to each tab every 6 s — the lever an agent round pulls |

The window only ever shows one space, so "4 spaces visible" is not a state this app has.
"Awake" is the honest equivalent: every space's browser is unparked and unthrottled. The
harness fails loudly if the host reports a different number of tabs than expected.

**This is where the old bench was wrong.** 0.3.0 gave each space its own `CefRequestContext`, so
"per space" and "per renderer" were the same thing, and the number was computed in summed RSS —
which counts libcef once per renderer. 0.4.0 makes the *profile* the isolation boundary: spaces
in one profile are tab sets sharing a browser context, and four tabs on the same origin can
share a renderer. Per-space cost therefore collapsed, and the interesting number moved to
crossing a profile boundary. Both are measured, in PSS, with the old RSS figure kept for
comparison.

### 4. Snapshot latency

**Method: through the real CLI, `ego-browser nodejs` with `ROOK_BACKEND=host`** — the bridge →
unix control socket → CEF path an agent actually uses. 30 viewport snapshots and 20 full-page
snapshots per run, three runs per page class, after warm-up snapshots. The run's own p50/p95 is
taken, then the median and spread across runs. `bench.mjs` records the element count with
`document.querySelectorAll('*').length` and the snapshot's own scope header
(`snapshot scope=viewport only, 22 lines, 6 refs, …`), which 0.4.0 added.

| Page class | What it is |
|---|---|
| small form | a sign-in form, ~20 elements |
| long list | 240 invoices with status tags and two buttons each, ~2.4 k elements |
| heavy dashboard | stat cards, two SVG charts, a 300-row table with badges, ~3.8 k elements |

Viewport is the default scope and what §6 is written for; full page is reported separately
because the viewport filter does **not** save the expensive part — `Accessibility.getFullAXTree`
reads the whole document before anything is filtered out.

Each page class is also measured once through `ROOK_BACKEND=standalone` — the same bridge
against its own headless Chrome, with no host socket in between. If those numbers match the host
ones, the cost is the snapshot pipeline, not the pipe.

### 5. CPU while idle

**Method: `utime + stime` delta over the whole tree, 60 s window, as percent of one core.**
Kernel jiffies at 100 Hz over a 60 s window, so the resolution is 0.017 % — a 1 % budget is 60×
the resolution, which is why this number is trustworthy even on a busy box. Sampled from the
4-space configuration (3 parked, 1 visible).

### 6. Agent round

**Method: one `ego-browser nodejs` invocation that does what an agent does.** Create a space,
open the local sign-in form, snapshot it, click "Forgot password?", click the email field, type
15 characters, finish. Timed from spawn to exit.

The script stamps every phase on the same CLOCK_MONOTONIC clock the harness uses, so the wall
time splits without guesswork:

| Phase | What it measures |
|---|---|
| CLI startup | spawn → the script's first statement: node boot and SDK load, no browser |
| browser phases | `taskSpace`, `goto`, `snapshot`, `click`, `type` — each a round trip to the app |
| teardown | `finish` plus process exit |

This row has no budget: §6 never named one. It is the number an agent feels.

### 7. Install size

**Method: `dpkg-deb -f <deb> Installed-Size`**, i.e. what dpkg reports for the installed tree,
converted KiB → MB (10⁶). The compressed `.deb` and the AppImage are recorded next to it.

## Baseline

`google-chrome --headless=new`, measured with the same /proc code and the same launch
discipline, so the numbers above have a reference point:

- **idle memory**: one page loaded, 15 s window, PSS and RSS over Chrome's pid tree;
- **cold start**: `--screenshot` → PNG written, warm profile after a discarded warm-up.

Headless Chrome has no window, so there is no framebuffer to poll; its cold start is its own
equivalent measurement, not the same instrument as the app's. Treat the two cold-start numbers
as a comparison of *whole launches*, not of identical instants.

## Known noise sources on this box

1. **A shared 4-core VM.** Other agents compile, run E2E suites and run their own browsers on it.
   RSS/PSS are nearly immune; **snapshot latency, agent rounds and cold start are not** — p50 can
   move 3× between two passes. The spread column and the recorded load are there to show it.
2. **`/dev/shm` is a 3.9 GB tmpfs** shared with every other browser on the box.
3. **No session bus.** `DBUS_SESSION_BUS_ADDRESS` is empty here, and every CEF child spends its
   first milliseconds failing to reach one (GTK then autolaunches a private bus for at-spi). The
   harness clears the variable for every launch, app and Chrome alike, so both see the same
   environment.
4. **A missing keyring.** This machine has no unlocked login keyring, so CEF's default
   secret-store path starts `gnome-keyring-daemon` and that daemon puts a **modal GTK
   "Choose password for new keyring" dialog over the window**. The bench launches the app with
   the standard headless setting `ROOK_CEF_EXTRA_FLAGS=password-store=basic` (and Chrome with
   `--password-store=basic`) so no dialog appears. A desktop user with an unlocked keyring takes
   the same code path without the prompt.
5. **Other apps on `:99`.** The bench never uses `:99`, or any display it did not start; it takes
   the first free display in `:95`–`:120`, and fails rather than sharing.

Nothing in the harness retries a slow run, drops an outlier, or picks a window length after
seeing the result. The only discarded runs are the declared warm-ups (one per warm series) and
runs where the app did not survive, which are listed under `discards` in `results.json`.

## Things the app does that the bench noticed

- **CEF zygote-forked renderers keep the zygote's command line** (`--type=zygote`), so
  `/proc/<pid>/cmdline` cannot tell a renderer from a zygote. The memory table groups them as
  `cef child (zygote fork)` on purpose; calling them renderers would be a guess.
- **Parking is a CPU knob, not a memory one.** Four awake spaces measure within noise of four
  parked ones, because parking throttles timers and does not drop the renderer.
- **A space in another profile has to be created with `createProfile` + `createSpace
  (profileId)`**; `--space` can only put spaces in the default profile. That is also how the
  bridge creates one, so the bench uses the same path.
- If a window "never loads" on this box, check `ps` for a leftover
  `gnome-keyring-daemon --start --foreground` — its password dialog sits over the app and blocks
  the load event.

## Reproducing by hand

```sh
cd /home/user/projects/ego-lite-linux
dpkg-deb -x packaging/out/rook_0.4.0_amd64.deb /tmp/rook-root
mkdir -p /tmp/rook-data /tmp/rook-run
/tmp/opencode/xvfb-root/usr/bin/Xvfb :118 -screen 0 1440x900x24 -nolisten tcp -ac &
DISPLAY=:118 ROOK_CEF_EXTRA_FLAGS=password-store=basic \
  XDG_DATA_HOME=/tmp/rook-data XDG_RUNTIME_DIR=/tmp/rook-run \
  /tmp/rook-root/usr/bin/rook --space "You=http://127.0.0.1:8000/small-form.html"
# ...and then read /proc/<pid>/smaps_rollup (Pss and Rss), or just run bench/run.sh
```
