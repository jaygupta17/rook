#!/usr/bin/env bash
# rook acceptance run: M1 shell + M3 control channel + M4 profiles/handoff.
#
# Phase 1 builds host/ from scratch, serves fixtures over local HTTP, launches
# the shell on a private X display, captures the window to a PNG, and asserts
# that two spaces of one profile really share one storage tree.
#
# Before phase 1 there is a cold-start gate: the same binary, a display and a
# profile that have never been used, with a 3 s budget to a non-blank frame
# (ROOK_COLD_START_MS overrides it). A first launch that never commits its page
# costs 15 s and a flat frame, and that is what the gate is for.
#
# Phase 2 starts a second host with its own runtime/data dirs and drives the
# agent control channel over its unix socket (scripts/control-probe.mjs): real
# CDP through the broker, the tab/space lifecycle pushes and popup attribution,
# then artifacts/m2-cdp.png.
#
# Phase 3 drives real X input (scripts/focus-probe.mjs) to prove the page gets
# the keyboard when the user clicks into it.
#
# Phase 4 (scripts/profile-probe.mjs) proves the product model: one
# CefRequestContext per profile shared by every space in it, a second profile
# isolated on disk, and a handoff that reveals the space, focuses its page and
# refuses agent mutations with EGO_TASK_SPACE_USER_IN_CONTROL until takeOver.
# It writes artifacts/m4-handoff.png (banner + a space with the user's session).
#
#   scripts/qa.sh                      # fresh build, phases 1-4
#   ROOK_KEEP_BUILD=1 scripts/qa.sh    # reuse host/build
#   ROOK_DISPLAY=:131 scripts/qa.sh    # a display of your own (never :99; QA
#                                      # starts a private Xvfb when the given
#                                      # one is not up)
#   ROOK_NODE=/path/to/node scripts/qa.sh
#
# Phase 0 checks the Chromium sandbox decision (scripts/sandbox-probe.sh): both
# paths, the overrides, and what the renderers really got. Phase 1's run uses the
# decision this machine produces, so a box with a usable helper or user
# namespaces is tested sandboxed and a box without either is tested on the
# fallback, warning included.
#
# Requires: cmake, ninja, g++, gtk3 dev, ImageMagick (import/identify), python3,
#           xdotool, xclip, Node 20+ (for the probes).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"                       # host/
build="${ROOK_BUILD_DIR:-$root/build}"
artifacts="${ROOK_ARTIFACTS:-$root/artifacts}"
out="${ROOK_SCREENSHOT:-$artifacts/m1-shell.png}"
display="${ROOK_DISPLAY:-:131}"
jobs="${JOBS:-4}"
log="$artifacts/qa-run.log"
data_dir="$artifacts/qa-profile"

say()  { printf '\n\033[1m[qa]\033[0m %s\n' "$*"; }
step() { printf '  %-18s %s\n' "$1" "$2"; }
fail() { printf '\n\033[1m[qa] FAIL\033[0m %s\n' "$*" >&2; exit 1; }

app_pid=""
server_pid=""
xvfb_pid=""
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

for tool in cmake ninja g++ pkg-config import identify convert python3 xdpyinfo; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done
[ -n "${CEF_ROOT:-}" ] && export CEF_ROOT

mkdir -p "$artifacts"
: > "$log"

# start_xvfb DISPLAY: launch a private Xvfb and wait until it answers. Prints
# nothing; leaves the pid in xvfb_started_pid and returns non-zero on failure.
# Prefer a system install; on the QA box Xvfb lives in an extracted .deb, which
# ROOK_XVFB_ROOT (or XVFB_BIN/XVFB_LIB) points at.
xvfb_started_pid=""
start_xvfb() {
  local want="$1" xvfb_bin xvfb_lib
  xvfb_bin="${XVFB_BIN:-$(command -v Xvfb || true)}"
  xvfb_lib="${XVFB_LIB:-}"
  if [ -z "$xvfb_bin" ] && [ -n "${ROOK_XVFB_ROOT:-}" ] &&
     [ -x "$ROOK_XVFB_ROOT/usr/bin/Xvfb" ]; then
    xvfb_bin="$ROOK_XVFB_ROOT/usr/bin/Xvfb"
    xvfb_lib="$ROOK_XVFB_ROOT/usr/lib/x86_64-linux-gnu"
  fi
  if [ -z "$xvfb_bin" ] && [ -x /tmp/opencode/xvfb-root/usr/bin/Xvfb ]; then
    xvfb_bin=/tmp/opencode/xvfb-root/usr/bin/Xvfb
    xvfb_lib=/tmp/opencode/xvfb-root/usr/lib/x86_64-linux-gnu
  fi
  [ -n "$xvfb_bin" ] || return 1
  LD_LIBRARY_PATH="${xvfb_lib:+$xvfb_lib:}${LD_LIBRARY_PATH:-}" \
    "$xvfb_bin" "$want" -screen 0 1440x900x24 -nolisten tcp -ac \
    >>"$log" 2>&1 &
  xvfb_started_pid=$!
  for _ in $(seq 1 40); do
    xdpyinfo -display "$want" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}

say "display"
if ! xdpyinfo -display "$display" >/dev/null 2>&1; then
  start_xvfb "$display" ||
    fail "no display on $display and no Xvfb to start one (pass ROOK_DISPLAY, XVFB_BIN or ROOK_XVFB_ROOT)"
  xvfb_pid="$xvfb_started_pid"
  step "xvfb" "started $display (pid $xvfb_pid)"
else
  step "display" "$display (already running)"
fi

say "build"
if [ "${ROOK_KEEP_BUILD:-0}" != "1" ]; then
  rm -rf "$build"
fi
build_start=$(date +%s)
cmake_args=(-S "$root" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release)
[ -n "${CEF_ROOT:-}" ] && cmake_args+=("-DCEF_ROOT=$CEF_ROOT")
cmake "${cmake_args[@]}" >>"$log" 2>&1 ||
  fail "cmake configure failed (log: $log); CEF_ROOT must point at a CEF binary distribution"
ninja -C "$build" -j"$jobs" >>"$log" 2>&1 || fail "build failed (log: $log)"
build_seconds=$(( $(date +%s) - build_start ))
bin="$build/bin/rook"
[ -x "$bin" ] || fail "expected $bin"
step "cmake+ninja" "${build_seconds}s (-j$jobs, $([ "${ROOK_KEEP_BUILD:-0}" = 1 ] && echo incremental || echo fresh))"
step "binary" "$(du -h "$bin" | cut -f1) $bin"
step "cef runtime" "$(du -sh "$root/cef-runtime" | cut -f1) $root/cef-runtime"

# ---------------------------------------------------------------------------
# Sandbox: prove the decision this box produces, both paths, before anything
# depends on it. The probe needs no root and no installed package.
# ---------------------------------------------------------------------------
say "sandbox"
sandbox_log="$artifacts/sandbox-probe.log"
rm -f "$sandbox_log"
"$root/scripts/sandbox-probe.sh" --bin "$bin" --display "$display" 2>&1 | tee "$sandbox_log"
sandbox_probe_rc="${PIPESTATUS[0]}"
[ "$sandbox_probe_rc" -eq 0 ] || fail "sandbox probe failed (log: $sandbox_log)"
sandbox_decision="$(sed -n 's/^ *\[rook\] sandbox: decision  //p' "$sandbox_log" | head -1)"
[ -n "$sandbox_decision" ] || fail "sandbox probe printed no decision (log: $sandbox_log)"
step "decision" "$sandbox_decision"

say "fixtures"
port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)" || fail "could not pick a free port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root/fixtures" \
  >"$artifacts/fixtures.log" 2>&1 &
server_pid=$!
base="http://127.0.0.1:$port"
served=0
for _ in $(seq 1 80); do
  if python3 - "$base/isolation.html" <<'PY'
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1).read(1)
except Exception:
    sys.exit(1)
PY
  then served=1; break; fi
  sleep 0.1
done
[ "$served" = "1" ] || fail "fixture server did not answer on $base"
step "http" "$base (pid $server_pid)"

# ---------------------------------------------------------------------------
# Cold start: first launch on a display and a profile that have never been used.
#
# This is the packaging failure this check exists for: the first page of a first
# launch never committed, and the run sat in the shell's 15 s screenshot
# watchdog before capturing a flat window (measured 15.7 s / 731 colours,
# against 1.3 s / thousands of colours when it works). The screen therefore has
# to be new -- a display another run has already driven is not the same test --
# and the profile has to be new with it.
#
# 3 s is the budget: every passing run measured on this box (fresh display,
# fresh profile, cold or warm page cache) lands in 1.3-1.8 s, and the failure
# this catches is not 3 s but 15 s of nothing. The frame is checked as well,
# because a fast blank frame would pass a stopwatch.
say "cold start"
cold_display=""
for n in $(seq 132 180); do
  if ! xdpyinfo -display ":$n" >/dev/null 2>&1; then
    cold_display=":$n"
    break
  fi
done
[ -n "$cold_display" ] || fail "no free display number for the cold-start check"
start_xvfb "$cold_display" ||
  fail "could not start a fresh Xvfb on $cold_display for the cold-start check"
cold_xvfb_pid="$xvfb_started_pid"
cold_data="$artifacts/coldstart-profile"
cold_shot="$artifacts/coldstart.png"
rm -rf "$cold_data"
mkdir -p "$cold_data"
rm -f "$cold_shot"
cold_started=$(date +%s%N)
DISPLAY="$cold_display" XDG_DATA_HOME="$cold_data" timeout 60 "$bin" \
  --screenshot "$cold_shot" \
  --space "You=$base/notes.html" >"$artifacts/coldstart.log" 2>&1
cold_rc=$?
cold_ms=$(( ( $(date +%s%N) - cold_started ) / 1000000 ))
kill "$cold_xvfb_pid" 2>/dev/null
wait "$cold_xvfb_pid" 2>/dev/null
cold_budget_ms="${ROOK_COLD_START_MS:-3000}"
[ "$cold_rc" -eq 0 ] || fail "cold start exited $cold_rc (log: $artifacts/coldstart.log)"
[ -s "$cold_shot" ] || fail "cold start captured nothing at $cold_shot"
read -r cold_colours cold_sd < <(
  identify -format '%k %[fx:standard_deviation]\n' "$cold_shot" | head -1
)
step "fresh display+profile" "${cold_ms} ms on $cold_display (budget ${cold_budget_ms} ms)"
step "frame" "${cold_colours} colours, sd ${cold_sd}"
[ "$cold_ms" -le "$cold_budget_ms" ] ||
  fail "cold start took ${cold_ms} ms, over the ${cold_budget_ms} ms budget: a fresh display+profile must reach a real frame in seconds (log: $log)"
[ "$cold_colours" -ge 500 ] ||
  fail "cold start frame looks blank: only $cold_colours colours (log: $log)"
awk -v sd="$cold_sd" 'BEGIN { exit (sd > 0.02) ? 0 : 1 }' ||
  fail "cold start frame looks flat: sd $cold_sd (log: $log)"

say "run"
rm -rf "$data_dir"
mkdir -p "$data_dir"
rm -f "$out"
DISPLAY="$display" XDG_DATA_HOME="$data_dir" timeout 120 "$bin" \
  --screenshot "$out" \
  --space "You=$base/notes.html,$base/isolation.html?label=You" \
  --space "Agent 1=$base/isolation.html?label=Agent1" \
  --verify-isolation >>"$log" 2>&1
app_rc=$?
[ "$app_rc" -eq 0 ] || fail "rook exited $app_rc (log: $log)"
[ -s "$out" ] || fail "no screenshot at $out"

say "screenshot"
read -r width height colours mean sd < <(
  identify -format '%w %h %k %[fx:mean] %[fx:standard_deviation]\n' "$out" | head -1
)
bytes=$(stat -c %s "$out")
step "file" "$out"
step "size" "${width}x${height}, $((bytes / 1024)) KB"
step "pixels" "${colours} colours, mean ${mean}, sd ${sd}"
[ "$width" -ge 1000 ] || fail "screenshot is only ${width}px wide"
[ "$height" -ge 700 ] || fail "screenshot is only ${height}px tall"
# A blank/white frame is sd 0 and a handful of colours; a real shell with a page
# in it is thousands.
[ "$colours" -ge 500 ] || fail "frame looks blank: only $colours colours"
awk -v sd="$sd" 'BEGIN { exit (sd > 0.02) ? 0 : 1 }' ||
  fail "frame looks flat: sd $sd"

say "profile storage"
you_line="$(grep -m1 'space="You" profile=' "$log")"
agent_line="$(grep -m1 'space="Agent 1" profile=' "$log")"
[ -n "$you_line" ] || fail 'no storage report for space "You"'
[ -n "$agent_line" ] || fail 'no storage report for space "Agent 1"'
step "You" "${you_line#*] }"
step "Agent 1" "${agent_line#*] }"
# Both spaces live in the default profile, so they read the same storage: the
# first page to load writes the value and the second one finds it. Which label
# wins depends on load order, so the check is "one value, seen twice" — that is
# the M4 model (a profile shares its logins with every space in it) and it is the
# opposite of what pre-M4 builds asserted.
you_ls="$(printf '%s' "$you_line" | sed -n 's/.*localStorage="\([^"]*\)".*/\1/p')"
you_ck="$(printf '%s' "$you_line" | sed -n 's/.*cookie="rook-space=\([^"]*\)".*/\1/p')"
case "$you_ls" in
  You|Agent1) ;;
  *) fail "user space reported an unexpected localStorage value: $you_line" ;;
esac
[ "$you_ls" = "$you_ck" ] ||
  fail "localStorage and cookie disagree in one space: $you_line"
case "$agent_line" in
  *"localStorage=\"$you_ls\""*"cookie=\"rook-space=$you_ls\""*) ;;
  *) fail "a second space of the same profile did not see the first one's storage: $agent_line" ;;
esac
case "$agent_line" in
  *'profile="default"'*) ;;
  *) fail "the second space is not in the default profile: $agent_line" ;;
esac
step "shared" "both spaces read localStorage and cookie \"$you_ls\""

say "profile dirs"
# One storage tree for the profile, and no per-space directories any more.
profile="$data_dir/rook/profiles/default"
[ -d "$profile" ] || fail "default profile missing: $profile"
[ -d "$profile/agent-1" ] && fail "a per-space storage dir came back: $profile/agent-1"
files=$(find "$profile" -maxdepth 2 -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$files" -gt 0 ] || fail "no files written under $profile"
step "default" "$files files, shared by both spaces"
storage=$(find "$profile" -type d -name leveldb 2>/dev/null | wc -l | tr -d ' ')
[ "$storage" -gt 0 ] || fail "no leveldb store under $profile"
step "leveldb stores" "$storage in one profile dir"

say "log check"
if grep -q "screenshot FAILED" "$log"; then
  fail "capture reported a failure (log: $log)"
fi
# The sandbox decision must be reported exactly once (browser process only) and
# it must be the one the probe predicted: never silently weaker than promised.
sandbox_lines="$(grep -cE '^\[rook\] (sandbox: enabled|WARNING: Chromium sandbox disabled)' "$log" || true)"
[ "$sandbox_lines" -eq 1 ] ||
  fail "expected exactly one sandbox report line in the run log, found $sandbox_lines"
case "$sandbox_decision" in
  enabled*)
    grep -q '^\[rook\] sandbox: enabled' "$log" ||
      fail "the probe decided '$sandbox_decision' but the run did not enable the sandbox"
    step "sandbox" "enabled, as decided by the probe"
    ;;
  *)
    grep -q '^\[rook\] WARNING: Chromium sandbox disabled' "$log" ||
      fail "the probe decided '$sandbox_decision' but the run printed no fallback warning"
    step "sandbox" "fallback with a warning, as decided by the probe"
    ;;
esac
step "warnings" "$(grep -c 'Pango-WARNING' "$log" || true) pango, $(grep -c 'load error' "$log" || true) load errors"

# ---------------------------------------------------------------------------
# Interactive run: no --screenshot, so the shell stays up past the point where
# CEF's zygote discards renderer children (~3.5 s in on this box).
#
# Renderers are *forked* by the zygote, not re-executed, and Chromium rotates
# the stack guard in them (--change-stack-guard-on-fork). A forked child that
# unwinds back through the embedder's main() therefore compares its pre-fork
# saved canary with the rotated one and aborts: the process prints
# "*** stack smashing detected ***: terminated" and dies of SIGABRT although
# nothing overflowed (main.cc leaves sub-processes with _Exit() because of it).
# A --screenshot run finishes in ~2 s and never reaches the churn, which is why
# this crash never showed up here; this phase exists so it cannot come back.
# ---------------------------------------------------------------------------
say "interactive run"
interactive_log="$artifacts/interactive-run.log"
interactive_data="$artifacts/qa-interactive-profile"
interactive_runtime="$artifacts/qa-runtime"
rm -rf "$interactive_data" "$interactive_runtime"
mkdir -p "$interactive_data" "$interactive_runtime"
chmod 700 "$interactive_runtime"
: > "$interactive_log"
interactive_sock="$interactive_runtime/rook-$(id -u).sock"
DISPLAY="$display" XDG_DATA_HOME="$interactive_data" XDG_RUNTIME_DIR="$interactive_runtime" \
  timeout 60 "$bin" \
  --space "You=$base/notes.html" \
  --space "Agent 1=$base/isolation.html?label=Agent1" \
  >>"$interactive_log" 2>&1 &
app_pid=$!
for _ in $(seq 1 150); do
  [ -S "$interactive_sock" ] && break
  sleep 0.1
done
[ -S "$interactive_sock" ] || fail "the interactive run never opened $interactive_sock"
step "socket" "$interactive_sock"

# Keep it alive well past the renderer churn, then quit the way the bridge does.
sleep 8
python3 - "$interactive_sock" <<'PY' || fail "the interactive run did not answer quit (log: $interactive_log)"
import json, socket, sys, time

sock = sys.argv[1]
deadline = time.time() + 10
while True:
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.settimeout(5)
    try:
        c.connect(sock)
        break
    except OSError:
        c.close()
        if time.time() > deadline:
            print("could not connect to %s" % sock, file=sys.stderr)
            sys.exit(1)
        time.sleep(0.2)
c.sendall(b'{"jsonrpc":"2.0","id":1,"method":"quit","params":{}}\n')
data = c.recv(4096).decode("utf-8", "replace")
c.close()
try:
    reply = json.loads(data.strip() or "{}")
except ValueError:
    print("not JSON: %r" % data, file=sys.stderr)
    sys.exit(1)
print("  %-18s %s" % ("quit", data.strip()))
if reply.get("result", {}).get("quitting") is not True:
    sys.exit(1)
PY
interactive_rc=0
wait "$app_pid" || interactive_rc=$?
app_pid=""
[ "$interactive_rc" -eq 0 ] ||
  fail "the interactive run exited $interactive_rc (log: $interactive_log)"
grep -q '^\[rook\] message loop returned (exit 0)' "$interactive_log" ||
  fail "the interactive run did not shut down through the message loop"
interactive_pages="$(grep -c 'loaded (http 200)' "$interactive_log" || true)"
[ "$interactive_pages" -ge 2 ] ||
  fail "the interactive run loaded $interactive_pages page(s), expected 2"
if grep -q "stack smashing" "$interactive_log"; then
  grep -n "stack smashing" "$interactive_log" >&2
  fail "a sub-process tripped the stack guard in the interactive run (log: $interactive_log)"
fi
step "uptime" "8 s, $interactive_pages pages loaded, clean quit"
step "log" "$interactive_log"

# ---------------------------------------------------------------------------
# Phase 2: the M2 control channel (unix socket + CDP broker).
#
# The probe launches its own host on its own XDG_RUNTIME_DIR and data root, so
# it neither sees nor disturbs the run above. Everything it does goes through
# the same Shell methods the UI handlers use.
# ---------------------------------------------------------------------------
say "control channel (M3)"
node_bin="${ROOK_NODE:-}"
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  for candidate in "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      node_bin="$candidate"
      break
    fi
  done
fi
[ -n "$node_bin" ] || fail "the probes need Node 20+ (pass ROOK_NODE=/path/to/node)"
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || fail "the probes need Node 20+ ($("$node_bin" -v))"
probe_log="$artifacts/control-probe.log"
probe_png="$artifacts/m2-cdp.png"
rm -f "$probe_png" "$probe_log"
"$node_bin" "$root/scripts/control-probe.mjs" \
  --bin "$bin" --fixtures "$root/fixtures" --display "$display" \
  --artifacts "$artifacts" 2>&1 | tee "$probe_log"
probe_rc="${PIPESTATUS[0]}"
[ "$probe_rc" -eq 0 ] || fail "control probe failed (rc $probe_rc, log: $probe_log)"
[ -s "$probe_png" ] || fail "no CDP screenshot at $probe_png"
read -r pw ph pk psd < <(
  identify -format '%w %h %k %[fx:standard_deviation]\n' "$probe_png" | head -1
)
[ "$pw" -ge 800 ] || fail "CDP screenshot is only ${pw}px wide"
[ "$pk" -ge 100 ] || fail "CDP screenshot looks blank: $pk colours"
step "cdp.png" "${pw}x${ph}, $pk colours, sd $psd"
step "probe log" "$probe_log"

# ---------------------------------------------------------------------------
# Phase 3: keyboard focus (the blocker the product review hit).
#
# The page is a native CEF child window, so a click on it never reaches GTK and
# X decides which side gets the keystrokes. This phase drives real input with
# xdotool and reads the result back over CDP: type into a field through the
# page, and prove the address bar stayed out of it; then type into the address
# bar, Escape, click the page and type again.
# ---------------------------------------------------------------------------
say "keyboard focus"
for tool in xdotool xclip; do
  command -v "$tool" >/dev/null 2>&1 || fail "the focus probe needs $tool (real X input)"
done
focus_log="$artifacts/focus-probe.log"
focus_png="$artifacts/m3-focus-form.png"
rm -f "$focus_png" "$focus_log"
"$node_bin" "$root/scripts/focus-probe.mjs" \
  --bin "$bin" --display "$display" --artifacts "$artifacts" 2>&1 | tee "$focus_log"
focus_rc="${PIPESTATUS[0]}"
[ "$focus_rc" -eq 0 ] || fail "focus probe failed (rc $focus_rc, log: $focus_log)"
[ -s "$focus_png" ] || fail "no focus screenshot at $focus_png"
read -r fw fh fc fsd < <(
  identify -format '%w %h %k %[fx:standard_deviation]\n' "$focus_png" | head -1
)
[ "$fw" -ge 800 ] || fail "focus screenshot is only ${fw}px wide"
[ "$fc" -ge 100 ] || fail "focus screenshot looks blank: $fc colours"
step "typed form" "${fw}x${fh}, $fc colours, sd $fsd"
step "probe log" "$focus_log"

# ---------------------------------------------------------------------------
# Phase 4: profiles and handoff (the M4 product model).
#
# The probe runs its own host on its own data root and proves, in one pass:
#   * two spaces of the default profile share one storage tree ("sign in once"),
#   * a space in a created profile does not (separate dir, separate leveldb),
#   * handOff reveals the space, focuses its page and refuses every agent
#     mutation with data.reason EGO_TASK_SPACE_USER_IN_CONTROL until takeOver,
#     in both orders, while reads keep working,
#   * the banner appears (pixel band) and the typed text lands in the page,
#   * tabs + session survive switching to the other profile's space and back,
#   * a pre-M4 per-space storage dir is removed at startup,
#   * the login survives a restart.
# It writes artifacts/m4-handoff.png: the banner and a space with the user's
# session in one frame.
# ---------------------------------------------------------------------------
say "profiles + handoff (M4)"
profile_log="$artifacts/profile-probe.log"
profile_png="$artifacts/m4-handoff.png"
rm -f "$profile_png" "$profile_log"
"$node_bin" "$root/scripts/profile-probe.mjs" \
  --bin "$bin" --display "$display" --artifacts "$artifacts" 2>&1 | tee "$profile_log"
profile_rc="${PIPESTATUS[0]}"
[ "$profile_rc" -eq 0 ] || fail "profile probe failed (rc $profile_rc, log: $profile_log)"
[ -s "$profile_png" ] || fail "no handoff screenshot at $profile_png"
read -r hw hh hk hsd < <(
  identify -format '%w %h %k %[fx:standard_deviation]\n' "$profile_png" | head -1
)
[ "$hw" -ge 1200 ] || fail "handoff screenshot is only ${hw}px wide"
[ "$hh" -ge 700 ] || fail "handoff screenshot is only ${hh}px tall"
[ "$hk" -ge 500 ] || fail "handoff screenshot looks blank: $hk colours"
step "handoff.png" "${hw}x${hh}, $hk colours, sd $hsd"
step "probe log" "$profile_log"

# ---------------------------------------------------------------------------
# Stack guard sweep: no run in this script may report a smashed stack. CEF's
# zygote-forked children used to do it on every exit (see "interactive run"
# above); a genuine overflow in the host would land here as well.
# ---------------------------------------------------------------------------
say "stack guard"
guard_logs=("$log" "$sandbox_log" "$probe_log" "$interactive_log" "$focus_log" "$profile_log")
for runlog in "${guard_logs[@]}"; do
  [ -f "$runlog" ] || fail "expected a run log at $runlog"
  if grep -q "stack smashing" "$runlog"; then
    grep -n "stack smashing" "$runlog" >&2
    fail "'stack smashing detected' in $(basename "$runlog") — a process we ship aborted"
  fi
done
step "stack smashing" "0 occurrences in ${#guard_logs[@]} run logs"

printf '\n\033[1m[qa] OK\033[0m  %s\n' "$out"
printf '        %s\n' "$probe_png"
printf '        %s\n' "$profile_png"
printf '        build %ss, run log %s\n' "$build_seconds" "$log"
