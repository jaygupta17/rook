#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
APP=$(cat /tmp/opencode/rook-eval/rook.pid)
echo "app_pid=$APP"
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/29-crash-round1.out 2>&1 &
const task = await taskSpace("crash")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
console.log("round1 ready", task.spaceId, await page.title())
await page.waitForTimeout(60000)
console.log("round1 finished")
JS
CLI=$!
echo "cli_pid=$CLI"
sleep 3
echo "killing bridge $CLI"
kill -9 "$CLI" 2>/dev/null
wait "$CLI" 2>/dev/null
sleep 1
kill -0 "$APP" 2>/dev/null && echo "app_alive=yes" || echo "app_alive=no"
"$EGO" backend | head -1
echo "=== new round after bridge kill ==="
timeout 20 "$EGO" nodejs <<'JS'
const task = await taskSpace("crash")
console.log("tabs", JSON.stringify(await task.tabs()))
const tabs = await task.tabs()
const tab = tabs.find((t) => t.url.includes("form.html")) || tabs[0]
const page = tab.label ? task.page(tab.label) : await task.adopt(tab.page)
await page.goto("http://127.0.0.1:8781/clip.html")
console.log("recovered", page.label, await page.title(), await page.evaluate(() => document.getElementById("ta").tagName))
JS
echo "recover_exit=$?"
