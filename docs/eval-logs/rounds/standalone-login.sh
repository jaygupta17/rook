#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone
echo "=== standalone: login round ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-login")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("space", task.spaceId, "result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("cookie", await page.evaluate(() => document.cookie))
JS
echo "login_exit=$?"

echo "=== standalone: resume in a second process, browser still running ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-login")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("same-browser result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("same-browser cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "resume_exit=$?"

echo "=== standalone: shutdown chrome, then resume ==="
"$EGO" shutdown
"$EGO" nodejs <<'JS'
const task = await taskSpace("s-login")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("after-shutdown result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("after-shutdown cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
JS
echo "after_shutdown_exit=$?"
