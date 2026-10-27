#!/bin/bash
# Session persistence across a clean app close/relaunch, in one long-lived agent parent.
source /tmp/opencode/rook-eval/env.sh
export DISPLAY=:120
exec > >(tee "$ROOK_LOGS/08-persist2.out") 2>&1

start_app() {
  local log=$1
  local t0=$(date +%s%N)
  nohup "$ROOK_BIN" > "$log" 2>&1 &
  echo $! > /tmp/opencode/rook-eval/rook.pid
  for i in $(seq 1 200); do
    "$EGO" backend 2>/dev/null | grep -q "backend: host" && { local t1=$(date +%s%N); echo "app_ready_ms=$(( (t1-t0)/1000000 ))"; return 0; }
    sleep 0.05
  done
  echo "app did not become ready"; return 1
}

close_app() {
  local wid t0 t1
  wid=$(xdotool search --name ' - Rook$' | head -1)
  echo "closing window $wid"
  t0=$(date +%s%N)
  wmctrl -ic "$wid"
  for i in $(seq 1 200); do
    kill -0 "$(cat /tmp/opencode/rook-eval/rook.pid)" 2>/dev/null || { t1=$(date +%s%N); echo "app_close_ms=$(( (t1-t0)/1000000 ))"; return 0; }
    sleep 0.05
  done
  echo "app did not close"; return 1
}

echo "=== launch 1 ==="
start_app "$ROOK_LOGS/rook-run5.log"
sleep 0.6

echo "=== round 1: sign in inside an agent space ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("persist-space")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("space", task.spaceId, "result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("cookie", await page.evaluate(() => document.cookie))
JS
echo "round1_exit=$?"

DB="$HOME/.local/share/rook/profiles/default/persist-space/Cookies"
echo "while_running_rows=$(sqlite3 "$DB" 'select count(*) from cookies;' 2>&1)"

echo "=== close 1 ==="
close_app
echo "after_close_rows=$(sqlite3 "$DB" 'select count(*) from cookies;' 2>&1)"
sqlite3 "$DB" "select host_key,name,expires_utc from cookies;" 2>&1

echo "=== launch 2 ==="
start_app "$ROOK_LOGS/rook-run6.log"
sleep 0.6

echo "=== round 2: same space name after relaunch ==="
"$EGO" nodejs <<'JS'
console.log("spaces after relaunch", JSON.stringify((await listTaskSpaces()).map(s => s.id + ":" + s.name)))
const task = await taskSpace("persist-space")
console.log("new space id", task.spaceId, "pages", JSON.stringify(await task.pages()), "tabs", JSON.stringify(await task.tabs()))
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("cookie", await page.evaluate(() => document.cookie))
JS
echo "round2_exit=$?"

echo "=== round 3: a different space must not share the cookie ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("other-space")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("other result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("other cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "round3_exit=$?"
