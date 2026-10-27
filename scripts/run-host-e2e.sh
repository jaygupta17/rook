#!/bin/sh
# Start the native app on the QA display and run one slice of the upstream
# end-to-end suite through the host backend.
#
#   scripts/run-host-e2e.sh '["environment initialization","task spaces and control"]'
#
# Env: ROOK_UPSTREAM (SDK checkout), ROOK_DISPLAY, ROOK_E2E_ONLY,
#      EGO_BROWSER_BUILD_ROOT (for a patched SDK built by scripts/build-sdk.sh).
#
# DISPLAY goes to the SDK process as well as the app: page.keyboard.paste runs
# its clipboard tool from the agent's own process, not inside the app.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
upstream=${ROOK_UPSTREAM:-$here/vendor/ego-browser}
display=${ROOK_DISPLAY:-:99}
only=${1:-}
if [ "$only" = "--all" ]; then
    only=""
elif [ -z "$only" ]; then
    only=${ROOK_E2E_ONLY:-'["environment initialization","task spaces and control","observation helpers"]'}
fi
node=${ROOK_NODE:-$(command -v node || true)}
[ -n "$node" ] || { echo "no node on PATH (set ROOK_NODE=/path/to/node22)" >&2; exit 1; }
bin=$here/host/build/bin/rook

[ -x "$bin" ] || {
    echo "no host binary at $bin (build host/ first: cmake -S host -B host/build -G Ninja && ninja -C host/build)" >&2
    exit 1
}
[ -d "$upstream/dist/out" ] || {
    echo "no SDK build at $upstream/dist/out (npm ci && npm run build there)" >&2
    exit 1
}

run_root=${ROOK_RUN_ROOT:-${TMPDIR:-/tmp}/rook-host-e2e}
rm -rf "$run_root"
mkdir -p "$run_root/run" "$run_root/data"
socket="$run_root/run/rook-$(id -u).sock"

echo "== app =="
DISPLAY=$display \
XDG_RUNTIME_DIR=$run_root/run \
XDG_DATA_HOME=$run_root/data \
HOME=$run_root \
    "$bin" --profile e2e --data-root "$run_root/data/rook" \
    >"$run_root/app.log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true' EXIT INT TERM

tries=0
while [ ! -S "$socket" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then
        echo "the app never opened $socket; see $run_root/app.log" >&2
        exit 1
    fi
    sleep 0.1
done
echo "app pid $app_pid, socket $socket"

echo "== e2e =="
cd "$upstream"
PATH=$(dirname "$node"):$PATH \
DISPLAY="$display" \
ROOK_BACKEND=host \
EGO_BROWSER_BUILD_ROOT="${EGO_BROWSER_BUILD_ROOT:-}" \
ROOK_HOST_SOCKET="$socket" \
EGO_BROWSER_REAL_E2E_CLI="$here/bin/ego-browser" \
EGO_BROWSER_REAL_E2E_ONLY="$only" \
    "$node" scripts/run-real-browser-e2e.mjs
