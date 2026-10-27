#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone2
echo "=== standalone login ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-persist")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("result", await page.evaluate(() => document.getElementById("result").textContent), "cookie", await page.evaluate(() => document.cookie))
JS
echo "login_exit=$?"
echo "=== standalone second process, same Chrome alive ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-persist")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("result", await page.evaluate(() => document.getElementById("result").textContent), "cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "second_exit=$?"
echo "=== shutdown chrome, then same space name ==="
"$EGO" shutdown
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-persist")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("result", await page.evaluate(() => document.getElementById("result").textContent), "cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "after_shutdown_exit=$?"
