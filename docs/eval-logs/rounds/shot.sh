#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
t0=$(date +%s%N)
"$EGO" nodejs <<'JS'
const task = await taskSpace("shot")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
const t = Date.now()
const path = await page.screenshot({ path: "/tmp/opencode/rook-eval/shots/20-skill-form.png" })
console.log("path", path, "ms", Date.now() - t)
console.log("size", (await (await import("node:fs/promises")).stat(path)).size)
JS
rc=$?; t1=$(date +%s%N); echo "exit=$rc wall_ms=$(( (t1-t0)/1000000 ))"
identify /tmp/opencode/rook-eval/shots/20-skill-form.png 2>&1
