#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
timeout 15 "$EGO" nodejs <<'JS'
const task = await taskSpace("recover3")
const p = await task.newPage()
await p.goto("http://127.0.0.1:8781/dialogs.html")
console.log("clicking")
const r = await p.click("#alert")
console.log("receipt", JSON.stringify(r))
const t = Date.now()
console.log("title", await p.title(), "after_ms", Date.now() - t)
console.log("done")
JS
echo "exit=$?"
