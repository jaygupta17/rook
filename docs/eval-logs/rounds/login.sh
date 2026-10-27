#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
echo "=== round 1: login page snapshot ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("login-space")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
console.log("space", task.spaceId)
console.log(await page.snapshot())
JS
echo "round1_exit=$?"
echo "=== round 2: sign in ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("login-space")
const page = task.page("p1")
await page.fill("@1", "jay")
await page.fill("@2", "hunter2")
await page.click("@3")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("url", await page.url())
console.log(await page.snapshot())
console.log("cookie", await page.evaluate(() => document.cookie))
JS
echo "round2_exit=$?"
