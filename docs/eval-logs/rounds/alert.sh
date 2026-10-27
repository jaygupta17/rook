#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
echo "=== unhandled alert: does the next command hang? ==="
timeout 20 "$EGO" nodejs <<'JS'
const task = await taskSpace("alert-block")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/dialogs.html")
const r = await page.click("#alert")
console.log("receipt", JSON.stringify(r))
const t = Date.now()
console.log("title", await page.title(), "after_ms", Date.now() - t)
console.log("done")
JS
echo "unhandled_alert_exit=$?"
