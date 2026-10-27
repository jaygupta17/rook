#!/bin/bash
set -u
BASE=/tmp/opencode/rook-collision3
rm -rf "$BASE"; mkdir -p "$BASE/home" "$BASE/run" "$BASE/state" "$BASE/logs"; chmod 700 "$BASE/run"
export DISPLAY=:121
export HOME=$BASE/home XDG_RUNTIME_DIR=$BASE/run XDG_DATA_HOME=$BASE/home/.local/share XDG_CONFIG_HOME=$BASE/home/.config XDG_CACHE_HOME=$BASE/home/.cache
export ROOK_CEF_EXTRA_FLAGS=password-store=basic EGO_BROWSER_STATE_DIR=$BASE/state
ROOK_BIN=/tmp/opencode/rook-eval/root/usr/bin/rook
EGO=/tmp/opencode/rook-eval/root/usr/bin/ego-browser
start_app() {
  "$ROOK_BIN" > "$BASE/logs/app-$1.log" 2>&1 & APPPID=$!
  for i in $(seq 1 200); do [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && break; sleep 0.05; done
  sleep 0.8
}
stop_app() { kill -TERM "$APPPID" 2>/dev/null; for i in $(seq 1 100); do kill -0 "$APPPID" 2>/dev/null || return; sleep 0.1; done; kill -9 "$APPPID" 2>/dev/null; }
start_app 1
"$EGO" nodejs <<'JS'
const t = await taskSpace("alpha"); const p = t.page("p1")
await p.goto("data:text/html,<title>ALPHA</title><h1>ALPHA page</h1>")
console.log("phase1", t.spaceId, await p.title())
JS
echo "phase1_exit=$?"
python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-collision3/state/spaces.json"));print("host ids after phase1",[(s["id"],s["name"],s["hostSpaceId"]) for s in d["spaces"]])'
stop_app
echo "app1_alive_after_stop=$(kill -0 $APPPID 2>/dev/null && echo yes || echo no)"
start_app 2
"$EGO" nodejs <<'JS'
const b = await taskSpace("beta"); const p = b.page("p1")
await p.goto("data:text/html,<title>BETA</title><h1>BETA page</h1>")
console.log("phase2 beta", b.spaceId, await p.title())
JS
echo "phase2_exit=$?"
python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-collision3/state/spaces.json"));print("host ids after phase2",[(s["id"],s["name"],s["hostSpaceId"]) for s in d["spaces"]])'
"$EGO" nodejs <<'JS'
const a = await taskSpace("alpha"); const tabs = await a.tabs()
console.log("resumed alpha", a.spaceId, JSON.stringify(tabs.map(t=>({label:t.label,title:t.title}))))
if (tabs.length) { const p = tabs[0].label ? a.page(tabs[0].label) : await a.adopt(tabs[0].page); console.log("alpha actually sees", await p.title()) }
JS
echo "alpha_resume_exit=$?"
stop_app
