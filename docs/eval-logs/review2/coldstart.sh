#!/bin/bash
# Cold start from a packaged tree.
#
# Every run gets a brand-new Xvfb display and a brand-new profile directory,
# because that is exactly what used to stall: the first Rook window on a display
# with no accessibility bus used to sit for ~15.7 s and capture a blank frame.
# A warm second run proved nothing, so this script never reuses a display.
#
#   docs/eval-logs/review2/coldstart.sh <unpacked-root-or-AppImage> <label> [runs]
#
# <unpacked-root>: a dpkg-deb -x root or an extracted AppDir (has usr/bin/rook).
# <AppImage>:      the .AppImage itself; run with APPIMAGE_EXTRACT_AND_RUN=1.
#
# Prints one line per run and fails if any run is slow, blank, or loads no page.
set -u

target=${1:?usage: coldstart.sh <unpacked-root-or-AppImage> <label> [runs]}
label=${2:-payload}
runs=${3:-3}
here=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
out=${OUT:-/tmp/opencode/coldstart-$label.out}
slow_limit=${SLOW_LIMIT:-5}     # seconds; the old behaviour was 15.7 s

case "$target" in
  *.AppImage) rook=$target; appimage=1 ;;
  *)          rook=$target/usr/bin/rook; appimage=0 ;;
esac
[ -x "$rook" ] || { echo "coldstart: no runnable rook at $rook" >&2; exit 2; }

xvfb_bin=${XVFB_BIN:-$(command -v Xvfb || true)}
[ -n "$xvfb_bin" ] || { echo "coldstart: no Xvfb (set XVFB_BIN and XVFB_LIB)" >&2; exit 2; }

work=$(mktemp -d /tmp/opencode/cold-start.XXXXXX) || exit 2
xvfb_pid=""
cleanup() {
    [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null
    [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null
}
trap cleanup EXIT INT TERM

# One fixture server for every run: the pages have to load over HTTP, a data:
# URL would hide a network-service stall.
port=$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here/host/fixtures" \
    >"$work/fixtures.log" 2>&1 &
server_pid=$!
base="http://127.0.0.1:$port"

fail=0
{
    echo "cold start — $label"
    echo "payload   $target"
    [ "$appimage" = 1 ] && echo "sha256    $(sha256sum "$target" | cut -d' ' -f1)"
    echo "fixture   $base/notes.html + $base/isolation.html?label=cold"
    echo "rule      every run: fresh Xvfb display, fresh profile dir; expect < ${slow_limit}s, > 500 colours, >= 1 page"
    echo
    printf '%-5s %-10s %-6s %-8s %-9s %-7s %s\n' run display exit wall colours pages frame
} > "$out"

n=0
while [ "$n" -lt "$runs" ]; do
    n=$((n + 1))
    # A display nobody has used: skip any socket that already exists.
    display=""
    for d in $(seq 200 260); do
        [ -e "/tmp/.X11-unix/X$d" ] && continue
        LD_LIBRARY_PATH="${XVFB_LIB:+$XVFB_LIB:}${LD_LIBRARY_PATH:-}" \
            "$xvfb_bin" ":$d" -screen 0 1440x900x24 -nolisten tcp -ac \
            >"$work/xvfb-$d.log" 2>&1 &
        xvfb_pid=$!
        for _ in $(seq 1 40); do
            xdpyinfo -display ":$d" >/dev/null 2>&1 && { display=":$d"; break; }
            sleep 0.25
        done
        [ -n "$display" ] && break
        kill "$xvfb_pid" 2>/dev/null; xvfb_pid=""
    done
    [ -n "$display" ] || { echo "coldstart: no free display" >&2; exit 2; }

    run_dir="$work/run$n"
    mkdir -p "$run_dir/data" "$run_dir/run" "$run_dir/home"
    chmod 700 "$run_dir/run"
    png="$run_dir/shot.png"

    t0=$(date +%s%N)
    DISPLAY="$display" HOME="$run_dir/home" \
        XDG_DATA_HOME="$run_dir/data" XDG_RUNTIME_DIR="$run_dir/run" \
        APPIMAGE_EXTRACT_AND_RUN=1 timeout 120 "$rook" \
            --screenshot "$png" \
            --space "You=$base/notes.html" \
            --space "Agent 1=$base/isolation.html?label=cold" \
            --verify-isolation >"$run_dir/app.log" 2>&1
    rc=$?
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))

    colours=$(identify -format '%k' "$png" 2>/dev/null || echo 0)
    pages=$(grep -c 'loaded (http' "$run_dir/app.log" || true)
    store=$(grep -c '^\[isolation\].*localStorage=' "$run_dir/app.log" || true)
    verdict="ok"
    if [ "$rc" -ne 0 ]; then verdict="FAIL exit $rc"; fail=$((fail + 1)); fi
    if awk -v ms="$ms" -v limit="$slow_limit" 'BEGIN { exit (ms > limit * 1000) ? 0 : 1 }'; then
        verdict="FAIL slow"; fail=$((fail + 1))
    fi
    if [ "$colours" -lt 500 ]; then verdict="FAIL blank"; fail=$((fail + 1)); fi
    if [ "$pages" -lt 1 ]; then verdict="FAIL no page"; fail=$((fail + 1)); fi

    printf '%-5s %-10s %-6s %-8s %-9s %-7s %s\n' \
        "$n" "$display" "$rc" "$(awk -v ms="$ms" 'BEGIN { printf "%.2fs", ms/1000 }')" \
        "$colours" "$pages" "$verdict" >> "$out"
    cp "$png" "$work/shot-$n.png" 2>/dev/null
    echo "  run $n: storage lines $store, log $run_dir/app.log" >> "$out"

    kill "$xvfb_pid" 2>/dev/null; wait "$xvfb_pid" 2>/dev/null; xvfb_pid=""
    # Wait for the socket to go away, so the next run cannot inherit the display.
    for _ in $(seq 1 40); do [ -e "/tmp/.X11-unix/X${display#:}" ] || break; sleep 0.1; done
done

{
    echo
    if [ "$fail" -eq 0 ]; then
        echo "PASS: $runs of $runs cold starts were fast (< ${slow_limit}s), painted, and loaded a page"
    else
        echo "FAIL: $fail check(s) failed"
    fi
} >> "$out"

cat "$out"
[ "$fail" -eq 0 ] || exit 1
