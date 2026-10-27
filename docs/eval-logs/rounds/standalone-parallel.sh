#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone2
echo "=== standalone parallel ==="
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/25-standalone-par-A.out 2>&1 &
const task = await taskSpace("sp-par-A")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
await page.evaluate(() => localStorage.setItem("m", "A"))
console.log("A", task.spaceId, await page.evaluate(() => document.getElementById("result").textContent), await page.evaluate(() => document.cookie))
await page.waitForTimeout(2000)
console.log("A later", await page.evaluate(() => localStorage.getItem("m")), await page.evaluate(() => document.cookie))
JS
A=$!
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/25-standalone-par-B.out 2>&1 &
const task = await taskSpace("sp-par-B")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
await page.evaluate(() => localStorage.setItem("m", "B"))
console.log("B", task.spaceId, await page.evaluate(() => document.getElementById("result").textContent), JSON.stringify(await page.evaluate(() => document.cookie)))
await page.waitForTimeout(2000)
console.log("B later", await page.evaluate(() => localStorage.getItem("m")), JSON.stringify(await page.evaluate(() => document.cookie)))
JS
B=$!
wait $A; ra=$?; wait $B; rb=$?
echo "exit A=$ra B=$rb"
echo "--- A ---"; cat /tmp/opencode/rook-eval/logs/25-standalone-par-A.out
echo "--- B ---"; cat /tmp/opencode/rook-eval/logs/25-standalone-par-B.out
