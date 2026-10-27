#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone
echo "backend: $("$EGO" backend | head -1)"
"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/21-standalone-tasks.out 2>&1
const fs = await import("node:fs/promises")
const task = await taskSpace("s-tasks")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
console.log("form_title", await page.title())
await page.fill("#name", "Jay Gupta")
await page.fill("#email", "jay@example.com")
await page.fill("#about", "standalone review round, October")
await page.selectOption("#month", { label: "October" })
await page.click("#agree")
await page.click("#submit")
await page.waitForSelector("#result", { state: "visible", timeout: 5000 })
console.log("form_result", await page.evaluate(() => document.getElementById("result").textContent))

const t = Date.now()
const shot = await page.screenshot({ path: "/tmp/opencode/rook-eval/shots/50-standalone-form.png" })
console.log("screenshot_ms", Date.now() - t, "path", shot, "bytes", (await fs.stat(shot)).size)

await page.goto("http://127.0.0.1:8781/big")
const big = await page.snapshot()
console.log("big_snapshot_chars", big.length, "lines", big.split("\n").length)
for (let i = 0; i < 3; i++) {
  const t0 = Date.now()
  await page.snapshot()
  console.log("big_snapshot_ms", Date.now() - t0)
}
const t1 = Date.now()
await page.click("#b600")
console.log("big_click_ms", Date.now() - t1, "result", await page.evaluate(() => document.getElementById("big-result").textContent))
JS
echo "exit=$?"
