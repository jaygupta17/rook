#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
"$EGO" nodejs <<'JS'
const task = await taskSpace("popup")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/popup.html")
console.log("== before ==")
console.log(await page.snapshot())
const wait = page.waitForEvent("popup", { timeout: 5000 })
const receipt = await page.click("#open")
console.log("receipt", JSON.stringify(receipt))
const pop = await wait
await pop.waitForLoadState()
console.log("popup", JSON.stringify({ label: pop.label, url: await pop.url(), openedBy: pop.openedBy, targetId: pop.targetId }))
console.log("child_window_opener", await pop.evaluate(() => String(window.opener === null ? "null" : typeof window.opener)))
console.log("opener_window_open_return", await page.evaluate(() => document.getElementById("status").textContent))
console.log("tabs", JSON.stringify(await task.tabs()))
console.log("== child snapshot ==")
console.log(await pop.snapshot())
await pop.fill("#child-input", "driven from the opener's agent")
await pop.click("#child-btn")
console.log("child_result", await pop.evaluate(() => document.getElementById("child-result").textContent))
console.log("child_input", await pop.evaluate(() => document.getElementById("child-input").value))
JS
echo "exit=$?"
