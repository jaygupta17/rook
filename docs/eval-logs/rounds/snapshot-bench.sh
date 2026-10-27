#!/bin/bash
# Snapshot-quality measurement against the native app, over the control socket.
#
#   docs/eval-logs/rounds/snapshot-bench.sh [output-file]
#
# Starts the fixture server and the app on the private display, runs one agent
# round per page (Wikipedia, then the /big fixture) and writes one JSON line per
# page and scope. Run it before and after a change to runtime/snapshot.js to get
# the before/after table.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
out=${1:-/tmp/opencode/snapshot-bench.out}
base=/tmp/opencode/rook-snapshot-bench
node=${ROOK_NODE:-/tmp/opencode/node22/bin/node}
display=${ROOK_DISPLAY:-:121}

rm -rf "$base"
mkdir -p "$base/home" "$base/run" "$base/logs"
chmod 700 "$base/run"
export DISPLAY=$display
export HOME=$base/home
export XDG_RUNTIME_DIR=$base/run
export XDG_DATA_HOME=$base/home/.local/share
export XDG_CONFIG_HOME=$base/home/.config
export XDG_CACHE_HOME=$base/home/.cache
export EGO_BROWSER_STATE_DIR=$base/state
export ROOK_NODE=$node
export EGO_BROWSER_SDK_PATH=$here/vendor/ego-browser/dist/out/index.js

"$node" "$here/docs/eval-logs/fixtures-server.mjs" >"$base/logs/fixtures.log" 2>&1 &
fixtures=$!
"$here/host/build/bin/rook" >"$base/logs/app.log" 2>&1 &
app=$!
cleanup() {
    kill "$app" "$fixtures" 2>/dev/null
    wait "$app" "$fixtures" 2>/dev/null
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 400); do
    [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && break
    sleep 0.05
done
for _ in $(seq 1 80); do
    curl -sf "http://127.0.0.1:8781/" >/dev/null 2>&1 && break
    sleep 0.05
done
sleep 0.5

{
    SNAPSHOT_URL="https://en.wikipedia.org/wiki/Linux" SNAPSHOT_LABEL=wikipedia \
        ROOK_BACKEND=host "$here/bin/ego-browser" nodejs \
        --sdk-path "$here/vendor/ego-browser/dist/out/index.js" \
        < "$here/docs/eval-logs/rounds/snapshot-quality.mjs"
    SNAPSHOT_URL="http://127.0.0.1:8781/big" SNAPSHOT_LABEL=big \
        ROOK_BACKEND=host "$here/bin/ego-browser" nodejs \
        --sdk-path "$here/vendor/ego-browser/dist/out/index.js" \
        < "$here/docs/eval-logs/rounds/snapshot-quality.mjs"
} >"$out" 2>"$base/logs/measure.err"
status=$?
echo "exit=$status, output in $out"
tail -3 "$base/logs/measure.err" 2>/dev/null
