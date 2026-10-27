#!/bin/bash
# The restart-collision reproduction from docs/evaluation.md ("Blocker — stale
# space records collide with new host space ids after a restart"), run against
# the tree's own app and CLI instead of the packaged .deb.
#
#   docs/eval-logs/rounds/collision4.sh [output-file]
#
# Two app runs on the same state directory. Each run numbers its spaces from
# `sp1`, so alpha (run 1) and beta (run 2) both end up as `sp2`; the third round
# resumes alpha and must see ALPHA, never BETA.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
out=${1:-/tmp/opencode/collision4.out}
base=/tmp/opencode/rook-collision4
node=${ROOK_NODE:-/tmp/opencode/node22/bin/node}
display=${ROOK_DISPLAY:-:121}

rm -rf "$base"
mkdir -p "$base/home" "$base/run" "$base/logs" "$base/state"
chmod 700 "$base/run"
export DISPLAY=$display
export HOME=$base/home
export XDG_RUNTIME_DIR=$base/run
export XDG_DATA_HOME=$base/home/.local/share
export XDG_CONFIG_HOME=$base/home/.config
export XDG_CACHE_HOME=$base/home/.cache
export ROOK_CEF_EXTRA_FLAGS=password-store=basic
export EGO_BROWSER_STATE_DIR=$base/state
export ROOK_BACKEND=host
export EGO_BROWSER_SDK_PATH=$here/vendor/ego-browser/dist/out/index.js
export ROOK_NODE=$node
rook_bin=$here/host/build/bin/rook
ego=$here/bin/ego-browser

app_pid=
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
    kill -TERM "$app_pid" 2>/dev/null
    for _ in $(seq 1 100); do
        kill -0 "$app_pid" 2>/dev/null || return
        sleep 0.1
    done
    kill -9 "$app_pid" 2>/dev/null
}
trap 'stop_app' EXIT INT TERM

{
    echo "== app run 1: alpha =="
    start_app 1
    "$ego" nodejs <<'JS'
const t = await taskSpace("alpha");
const p = t.page("p1");
await p.goto("data:text/html,<title>ALPHA</title><h1>ALPHA page</h1>");
console.log("phase1", t.spaceId, await p.title());
JS
    echo "phase1_exit=$?"
    python3 - "$base/state/spaces.json" <<'PY2'
import json, sys
state = json.load(open(sys.argv[1]))
print("host ids after phase1", [[s["id"], s["name"], s.get("hostSpaceId"), s.get("hostInstance")] for s in state["spaces"]])
PY2
    stop_app
    echo "app1_alive_after_stop=$(kill -0 "$app_pid" 2>/dev/null && echo yes || echo no)"

    echo "== app run 2: beta takes sp2 =="
    start_app 2
    "$ego" nodejs <<'JS'
const b = await taskSpace("beta");
const p = b.page("p1");
await p.goto("data:text/html,<title>BETA</title><h1>BETA page</h1>");
console.log("phase2 beta", b.spaceId, await p.title());
JS
    echo "phase2_exit=$?"
    python3 - "$base/state/spaces.json" <<'PY2'
import json, sys
state = json.load(open(sys.argv[1]))
print("host ids after phase2", [[s["id"], s["name"], s.get("hostSpaceId"), s.get("hostInstance")] for s in state["spaces"]])
PY2

    echo "== resume alpha after the restart =="
    "$ego" nodejs <<'JS'
const a = await taskSpace("alpha");
const tabs = await a.tabs();
console.log("resumed alpha", a.spaceId, JSON.stringify(tabs.map((t) => ({ label: t.label, title: t.title }))));
if (tabs.length) {
  const p = tabs[0].label ? a.page(tabs[0].label) : await a.adopt(tabs[0].page);
  console.log("alpha actually sees", await p.title());
  if ((await p.title()) !== "ALPHA") throw new Error("WRONG SPACE: alpha sees " + (await p.title()));
}
JS
    echo "alpha_resume_exit=$?"
    python3 - "$base/state/spaces.json" <<'PY2'
import json, sys
state = json.load(open(sys.argv[1]))
print("host ids after resume", [[s["id"], s["name"], s.get("hostSpaceId"), s.get("hostInstance")] for s in state["spaces"]])
PY2

    echo "== beta still sees its own tab =="
    "$ego" nodejs <<'JS'
const b = await taskSpace("beta");
const p = b.page("p1");
const title = await p.title();
console.log("beta sees", title);
if (title !== "BETA") throw new Error("WRONG SPACE: beta sees " + title);
JS
    echo "beta_resume_exit=$?"
    stop_app
} >"$out" 2>&1
cat "$out"
