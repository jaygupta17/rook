#!/bin/bash
set -u
BASE=/tmp/opencode/rook-review2-collision
rm -rf "$BASE"; mkdir -p "$BASE"/{home,run,state,data,logs}; chmod 700 "$BASE/run"
export DISPLAY=:122
export HOME=$BASE/home
export XDG_RUNTIME_DIR=$BASE/run
export XDG_DATA_HOME=$BASE/home/.local/share
export XDG_CONFIG_HOME=$BASE/home/.config
export XDG_CACHE_HOME=$BASE/home/.cache
export ROOK_CEF_RUNTIME=/home/user/projects/ego-lite-linux/host/cef-runtime
export LD_LIBRARY_PATH=$ROOK_CEF_RUNTIME
export ROOK_NODE=/tmp/opencode/node22/bin/node
export PATH=/tmp/opencode/node22/bin:$PATH
export ROOK_CEF_EXTRA_FLAGS=password-store=basic
export ROOK_BACKEND=host
export EGO_BROWSER_SDK_PATH=/home/user/projects/ego-lite-linux/vendor/ego-browser/dist/out/index.js
export EGO_BROWSER_STATE_DIR=$BASE/state
ROOK_BIN=/home/user/projects/ego-lite-linux/host/build/bin/rook
EGO=/home/user/projects/ego-lite-linux/bin/ego-browser

start_app() {
  "$ROOK_BIN" --data-root "$BASE/data" > "$BASE/logs/app-$1.log" 2>&1 &
  APPPID=$!
  for i in $(seq 1 300); do [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && break; sleep 0.05; done
  sleep 0.8
}
stop_app() {
  kill -TERM "$APPPID" 2>/dev/null
  for i in $(seq 1 100); do kill -0 "$APPPID" 2>/dev/null || return; sleep 0.1; done
  kill -9 "$APPPID" 2>/dev/null
}

start_app 1
"$EGO" nodejs <<'JS'
const t = await taskSpace("alpha")
const p = t.page("p1")
await p.goto("data:text/html,<title>ALPHA</title><h1>ALPHA page</h1>")
console.log("phase1", t.spaceId, await p.title())
JS
echo "phase1_exit=$?"
python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-review2-collision/state/spaces.json"));print("after phase1",[(s["id"],s["name"],s.get("hostSpaceId"),s.get("hostInstance"),s.get("recentTabUrls")) for s in d["spaces"]])'
stop_app

start_app 2
"$EGO" nodejs <<'JS'
const b = await taskSpace("beta")
const p = b.page("p1")
await p.goto("data:text/html,<title>BETA</title><h1>BETA page</h1>")
console.log("phase2 beta", b.spaceId, await p.title())
JS
echo "phase2_exit=$?"
python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-review2-collision/state/spaces.json"));print("after phase2",[(s["id"],s["name"],s.get("hostSpaceId"),s.get("hostInstance")) for s in d["spaces"]])'
echo "resume alpha:"
"$EGO" nodejs <<'JS'
const a = await taskSpace("alpha")
const tabs = await a.tabs()
console.log("resumed alpha", a.spaceId, JSON.stringify(tabs.map(t=>({label:t.label,title:t.title,url:t.url}))))
if (tabs.length) { const p = tabs[0].label ? a.page(tabs[0].label) : await a.adopt(tabs[0].page); console.log("alpha actually sees", await p.title()) }
JS
echo "alpha_resume_exit=$?"
stop_app
