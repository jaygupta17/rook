#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export DISPLAY=:120
ROOK_WID=$(xdotool search --name ' - Rook$' | head -1)
wmctrl -ia "$ROOK_WID"; sleep 0.4
xdotool mousemove 110 150 click 1; sleep 0.4
echo "window_before=$(xdotool getactivewindow getwindowname)"
import -window "$ROOK_WID" /tmp/opencode/rook-eval/shots/40-parallel-before.png

echo "=== two agent processes at once ==="
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/17-parallel-A.out 2>&1 &
const task = await taskSpace("par-A")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
await page.evaluate(() => localStorage.setItem("par-marker", "A"))
console.log("A space", task.spaceId, "result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("A cookie", await page.evaluate(() => document.cookie))
await page.waitForTimeout(2500)
console.log("A later marker", await page.evaluate(() => localStorage.getItem("par-marker")))
console.log("A cookie later", await page.evaluate(() => document.cookie))
console.log("A tabs", (await task.tabs()).map((t) => t.label + ":" + t.title).join("|"))
JS
A=$!
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/17-parallel-B.out 2>&1 &
const task = await taskSpace("par-B")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/private.html")
console.log("B space", task.spaceId, "result", await page.evaluate(() => document.getElementById("result").textContent))
console.log("B cookie", JSON.stringify(await page.evaluate(() => document.cookie)))
await page.evaluate(() => localStorage.setItem("par-marker", "B"))
await page.goto("http://127.0.0.1:8781/iframe.html")
await page.evaluate(() => localStorage.setItem("par-marker", "B2"))
await page.waitForTimeout(2500)
console.log("B marker", await page.evaluate(() => localStorage.getItem("par-marker")))
console.log("B cookie later", JSON.stringify(await page.evaluate(() => document.cookie)))
console.log("B tabs", (await task.tabs()).map((t) => t.label + ":" + t.title).join("|"))
JS
B=$!
sleep 1.2
echo "window_during=$(xdotool getactivewindow getwindowname)"
import -window "$ROOK_WID" /tmp/opencode/rook-eval/shots/41-parallel-during.png
wait $A; ra=$?
wait $B; rb=$?
echo "exit A=$ra B=$rb"
echo "window_after=$(xdotool getactivewindow getwindowname)"
import -window "$ROOK_WID" /tmp/opencode/rook-eval/shots/42-parallel-after.png
echo "--- A ---"; cat /tmp/opencode/rook-eval/logs/17-parallel-A.out
echo "--- B ---"; cat /tmp/opencode/rook-eval/logs/17-parallel-B.out
