#!/bin/bash
# The reviewer's restart-collision reproduction (rounds/collision3.sh), run
# against the *packaged* tree instead of the build tree.
#
# collision3.sh drives /tmp/opencode/rook-eval/root, which was the unpacked
# 0.3.0~m3 .deb: a name that looked current around a payload built before the
# space-id fix, so it reproduced the blocker. This script unpacks the 0.4.0
# package with dpkg-deb -x and drives exactly the same three rounds through the
# launchers inside it. No install, no sudo, no root-owned files touched.
#
# What must happen: each app run numbers its spaces from sp1, so alpha (run 1)
# and beta (run 2) both land on host space sp2. Resuming alpha in run 3 must
# show ALPHA, and beta must still show BETA. Before the fix, alpha saw BETA.
#
#   docs/eval-logs/rounds/collision5.sh                      # newest 0.4.0 deb
#   docs/eval-logs/rounds/collision5.sh path/to/file.deb out.txt
#
# Exit 0 = the packaged app kept the spaces apart; 1 = wrong space; 2 = setup.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
deb=${1:-$here/packaging/out/rook_0.4.0_amd64.deb}
out=${2:-/tmp/opencode/collision5.out}
base=/tmp/opencode/rook-packaged
root=$base/root
failures=0

if [ ! -f "$deb" ]; then
    echo "collision5: no package at $deb (build it with packaging/build-deb.sh)" >&2
    exit 2
fi

# --- a display, private by default -------------------------------------------
# The reviewer's script assumed :121 was already running. Start our own so this
# is reproducible on a box where nothing is up, and never capture a stranger's
# windows: the probes below only read page titles, but a shared display makes a
# failed run ambiguous.
display=${ROOK_DISPLAY:-}
xvfb_pid=""
if [ -z "$display" ]; then
    xvfb_bin=${XVFB_BIN:-$(command -v Xvfb || true)}
    if [ -z "$xvfb_bin" ]; then
        echo "collision5: no Xvfb on PATH and ROOK_DISPLAY unset (set XVFB_BIN=... or ROOK_DISPLAY=:121)" >&2
        exit 2
    fi
    mkdir -p "$base"
    for n in $(seq 150 175); do
        [ -e "/tmp/.X11-unix/X$n" ] && continue
        LD_LIBRARY_PATH="${XVFB_LIB:+$XVFB_LIB:}${LD_LIBRARY_PATH:-}" \
            "$xvfb_bin" ":$n" -screen 0 1280x820x24 -nolisten tcp -ac \
            >"$base/xvfb.log" 2>&1 &
        xvfb_pid=$!
        for _ in $(seq 1 40); do
            xdpyinfo -display ":$n" >/dev/null 2>&1 && { display=":$n"; break; }
            sleep 0.25
        done
        [ -n "$display" ] && break
        kill "$xvfb_pid" 2>/dev/null
        xvfb_pid=""
    done
    [ -n "$display" ] || { echo "collision5: could not start an Xvfb on :150-:175" >&2; exit 2; }
fi

# --- unpack the package ------------------------------------------------------
rm -rf "$base/home" "$base/run" "$base/logs" "$base/state"
rm -rf "$root"
mkdir -p "$base/home" "$base/run" "$base/logs" "$base/state"
chmod 700 "$base/run"
dpkg-deb -x "$deb" "$root" || { echo "collision5: dpkg-deb -x failed" >&2; exit 2; }

# The packaged launchers, and nothing from the build tree: no ROOK_NODE (the
# package's own node), no EGO_BROWSER_SDK_PATH (the package's own sdk/index.js).
export DISPLAY=$display
export HOME=$base/home
export XDG_RUNTIME_DIR=$base/run
export XDG_DATA_HOME=$base/home/.local/share
export XDG_CONFIG_HOME=$base/home/.config
export XDG_CACHE_HOME=$base/home/.cache
export ROOK_CEF_EXTRA_FLAGS=password-store=basic
export EGO_BROWSER_STATE_DIR=$base/state
export ROOK_BACKEND=host
unset ROOK_NODE EGO_BROWSER_SDK_PATH ROOK_LIB 2>/dev/null
rook_bin=$root/usr/bin/rook
ego=$root/usr/bin/ego-browser

app_pid=""
start_app() {
    "$rook_bin" >"$base/logs/app-$1.log" 2>&1 &
    app_pid=$!
    for _ in $(seq 1 200); do
        [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && break
        sleep 0.05
    done
    sleep 0.8
}
stop_app() {
    [ -n "$app_pid" ] || return 0
    kill -TERM "$app_pid" 2>/dev/null
    for _ in $(seq 1 100); do
        kill -0 "$app_pid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill -9 "$app_pid" 2>/dev/null
    app_pid=""
}
cleanup() {
    stop_app
    [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null
    return 0
}
trap cleanup EXIT INT TERM

expect() { # $1 = what, $2 = got, $3 = want
    if [ "$2" = "$3" ]; then
        echo "  ok   $1 = $2"
    else
        echo "  FAIL $1 = [$2], expected [$3]"
        failures=$((failures + 1))
    fi
}

{
    echo "package   $deb"
    echo "sha256    $(sha256sum "$deb" | cut -d' ' -f1)"
    echo "version   $(dpkg-deb -f "$deb" Version)"
    echo "unpacked  $root"
    echo "display   $display"
    echo

    echo "== app run 1: alpha =="
    start_app 1
    grep -m1 '^\[rook\] rook ' "$base/logs/app-1.log" | sed 's/^/  banner: /'
    alpha1=$("$ego" nodejs <<'JS'
const t = await taskSpace("alpha");
const p = t.page("p1");
await p.goto("data:text/html,<title>ALPHA</title><h1>ALPHA page</h1>");
console.log(t.spaceId + " " + (await p.title()));
JS
)
    echo "  phase1 $alpha1"
    expect "run 1 alpha title" "${alpha1#* }" "ALPHA"
    python3 - "$base/state/spaces.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("  host ids after phase1", [[s["id"], s["name"], s.get("hostSpaceId")] for s in d["spaces"]])
PY
    stop_app
    echo "  app1_alive_after_stop=$(kill -0 "$app_pid" 2>/dev/null && echo yes || echo no)"

    echo
    echo "== app run 2: beta takes sp2 too =="
    start_app 2
    beta1=$("$ego" nodejs <<'JS'
const b = await taskSpace("beta");
const p = b.page("p1");
await p.goto("data:text/html,<title>BETA</title><h1>BETA page</h1>");
console.log(b.spaceId + " " + (await p.title()));
JS
)
    echo "  phase2 $beta1"
    expect "run 2 beta title" "${beta1#* }" "BETA"
    python3 - "$base/state/spaces.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("  host ids after phase2", [[s["id"], s["name"], s.get("hostSpaceId")] for s in d["spaces"]])
PY

    echo
    echo "== resume alpha while the collided id is live =="
    alpha2=$("$ego" nodejs <<'JS'
const a = await taskSpace("alpha");
const tabs = await a.tabs();
console.log("tabs " + JSON.stringify(tabs.map((t) => ({ label: t.label, title: t.title }))));
if (!tabs.length) {
  console.log("title (no tabs)");
} else {
  const p = tabs[0].label ? a.page(tabs[0].label) : await a.adopt(tabs[0].page);
  console.log("title " + (await p.title()));
}
JS
)
    printf '%s\n' "$alpha2" | sed 's/^/  /'
    expect "alpha actually sees" "$(printf '%s\n' "$alpha2" | sed -n 's/^title //p')" "ALPHA"

    echo
    echo "== beta still sees its own tab =="
    beta2=$("$ego" nodejs <<'JS'
const b = await taskSpace("beta");
const tabs = await b.tabs();
console.log("tabs " + JSON.stringify(tabs.map((t) => ({ label: t.label, title: t.title }))));
if (!tabs.length) {
  console.log("(no tabs)");
} else {
  const p = tabs[0].label ? b.page(tabs[0].label) : await b.adopt(tabs[0].page);
  console.log(await p.title());
}
JS
)
    printf '%s\n' "$beta2" | sed 's/^/  /'
    expect "beta sees" "$(printf '%s\n' "$beta2" | tail -1)" "BETA"
    stop_app

    echo
    if [ "$failures" -eq 0 ]; then
        echo "PASS: packaged app kept alpha and beta apart across the restart"
    else
        echo "FAIL: $failures check(s) failed"
    fi
} >"$out" 2>&1

cat "$out"
[ "$failures" -eq 0 ] || exit 1
