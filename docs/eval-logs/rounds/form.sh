#!/bin/bash
# Two agent rounds in one long-lived parent, the way an agent CLI spawns the CLI.
source /tmp/opencode/rook-eval/env.sh

echo "=== round 1: open + snapshot ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("form2")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
console.log("space", task.spaceId, "title", await page.title())
console.log(await page.snapshot())
JS
echo "round1_exit=$?"

echo "=== round 2: fill + submit ==="
t0=$(date +%s%N)
"$EGO" nodejs <<'JS'
const task = await taskSpace("form2")
const page = task.page("p1")
const t = Date.now()
await page.fill("@1", "Jay Gupta")
await page.fill("@2", "jay@example.com")
await page.fill("@3", "written during the independent product review, October")
await page.selectOption("#month", { label: "October" })
await page.click("@9")
await page.click("@10")
await page.waitForSelector("#result", { state: "visible", timeout: 5000 })
console.log("action_ms", Date.now() - t)
console.log(await page.snapshot())
JS
rc=$?
t1=$(date +%s%N)
echo "round2_exit=$rc round2_wall_ms=$(( (t1-t0)/1000000 ))"
