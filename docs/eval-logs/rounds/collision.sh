#!/bin/bash
set -u
BASE=/tmp/opencode/rook-collision
rm -rf "$BASE"; mkdir -p "$BASE/home" "$BASE/run" "$BASE/state" "$BASE/logs"
chmod 700 "$BASE/run"
export DISPLAY=:121
export HOME=$BASE/home
export XDG_RUNTIME_DIR=$BASE/run
export XDG_DATA_HOME=$HOME/.local/share
export XDG_CONFIG_HOME=$HOME/.config
export XDG_CACHE_HOME=$HOME/.cache
export ROOK_CEF_EXTRA_FLAGS=password-store=basic
export EGO_BROWSER_STATE_DIR=$BASE/state
ROOK_BIN=/tmp/opencode/rook-eval/root/usr/bin/rook
EGO=/tmp/opencode/rook-eval/root/usr/bin/ego-browser

start_app() {
  "$ROOK_BIN" > "$BASE/logs/app-$1.log" 2>&1 &
  APPPID=$!
  for i in $(seq 1 200); do
    [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && break
    sleep 0.05
  done
  sleep 0.8
}
stop_app() {
  local w=$(xdotool search --name ' - Rook$' | head -1)
  wmctrl -ic "$w"
  for i in $(seq 1 100); do kill -0 "$APPPID" 2>/dev/null || break; sleep 0.1; done
}

start_app 1
"$EGO" nodejs <<'JS'
const t = await taskSpace("alpha")
const p = t.page("p1")
await p.goto("data:text/html,<title>ALPHA</title><h1>ALPHA</h1>")
await p.evaluate(() => { document.cookie = "who=alpha; Path=/; Max-Age=86400" })
console.log("phase1", t.spaceId, await p.title(), await p.evaluate(() => document.cookie))
JS
echo "phase1_exit=$?"
stop_app
echo "after phase1:"; python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-collision/state/spaces.json"));print([(s["id"],s["name"],s["hostSpaceId"]) for s in d["spaces"]])'

start_app 2
"$EGO" nodejs <<'JS'
const b = await taskSpace("beta")
const pb = b.page("p1")
await pb.goto("data:text/html,<title>BETA</title><h1>BETA</h1>")
await pb.evaluate(() => { document.cookie = "who=beta; Path=/; Max-Age=86400" })
console.log("phase2 beta", b.spaceId, await pb.title(), await pb.evaluate(() => document.cookie))
JS
echo "phase2_exit=$?"
echo "now resume alpha:"
"$EGO" nodejs <<'JS'
const a = await taskSpace("alpha")
const tabs = await a.tabs()
console.log("resumed alpha", a.spaceId, JSON.stringify(tabs.map((t) => ({ label: t.label, title: t.title, url: t.url }))))
if (tabs.length) {
  const p = tabs[0].label ? a.page(tabs[0].label) : await a.adopt(tabs[0].page)
  console.log("alpha sees", await p.title(), await p.evaluate(() => document.title), await p.evaluate(() => document.cookie))
}
JS
echo "alpha_resume_exit=$?"
echo "after phase2:"; python3 -c 'import json;d=json.load(open("/tmp/opencode/rook-collision/state/spaces.json"));print([(s["id"],s["name"],s["hostSpaceId"]) for s in d["spaces"]])'
