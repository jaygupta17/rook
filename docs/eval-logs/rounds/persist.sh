#!/bin/bash
# One long-lived agent parent: verify login, close the app like a user, relaunch, re-check.
source /tmp/opencode/rook-eval/env.sh
LOG=$ROOK_LOGS/06-persist.out
exec > >(tee "$LOG") 2>&1

echo "=== before restart: is the space still signed in? ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("login-space")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("before", await page.evaluate(() => document.getElementById("result").textContent), "space", task.spaceId)
JS
echo "before_exit=$?"

echo "=== closing the app window ==="
wid=$(xdotool search --name ' - Rook$' | head -1)
echo "window=$wid"
xdotool windowclose "$wid"
for i in $(seq 1 100); do
  if ! kill -0 "$(cat /tmp/opencode/rook-eval/rook.pid)" 2>/dev/null; then echo "app exited after ${i}00ms"; break; fi
  sleep 0.1
done
kill -0 "$(cat /tmp/opencode/rook-eval/rook.pid)" 2>/dev/null && echo "APP STILL ALIVE"
ls "$XDG_RUNTIME_DIR"

echo "=== relaunching ==="
t0=$(date +%s%N)
nohup "$ROOK_BIN" > "$ROOK_LOGS/rook-run2.log" 2>&1 &
echo $! > /tmp/opencode/rook-eval/rook.pid
for i in $(seq 1 200); do
  [ -S "$XDG_RUNTIME_DIR/rook-$(id -u).sock" ] && { t1=$(date +%s%N); break; }
  sleep 0.05
done
echo "relaunch_socket_ms=$(( (t1-t0)/1000000 )) pid=$(cat /tmp/opencode/rook-eval/rook.pid)"
sleep 1

echo "=== after restart ==="
"$EGO" nodejs <<'JS'
const spaces = await listTaskSpaces()
console.log("spaces", JSON.stringify(spaces))
const task = await taskSpace("login-space")
console.log("resumed", task.spaceId, "pages", JSON.stringify(await task.pages()), "tabs", JSON.stringify(await task.tabs()))
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("after", await page.evaluate(() => document.getElementById("result").textContent))
console.log("cookie", await page.evaluate(() => document.cookie))
console.log(await page.snapshot())
JS
echo "after_exit=$?"
