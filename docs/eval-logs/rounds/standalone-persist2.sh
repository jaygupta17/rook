#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone-persist
rm -rf "$EGO_BROWSER_STATE_DIR"; mkdir -p "$EGO_BROWSER_STATE_DIR"
echo "=== round 1 login ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("persist-iso")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("result", await page.evaluate(() => document.getElementById("result").textContent), "cookie", await page.evaluate(() => document.cookie))
JS
echo "login_exit=$?"
bpid=$(node -e 'const b=require(process.argv[1]); console.log(b.browsers.Default.pid)' "$EGO_BROWSER_STATE_DIR/browsers.json")
echo "browser_pid=$bpid alive=$(kill -0 $bpid 2>/dev/null && echo yes || echo no)"
echo "=== shutdown ==="
"$EGO" shutdown
sleep 1
echo "browser_alive_after=$(kill -0 $bpid 2>/dev/null && echo yes || echo no)"
echo "=== round 2 same space after shutdown ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("persist-iso")
console.log("space", task.spaceId, "pages", JSON.stringify(await task.pages()), "tabs", JSON.stringify(await task.tabs()))
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("result", await page.evaluate(() => document.getElementById("result").textContent), "cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "round2_exit=$?"
