#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
"$EGO" nodejs <<'JS'
const task = await taskSpace("iframe")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/iframe.html")
const outer = await page.snapshot()
console.log("== viewport snapshot ==")
console.log(outer)
const frameRef = (outer.match(/iframe[^\n]*\[ref=(\d+)/) || [])[1]
const buttonRef = (outer.match(/button "Frame button" \[ref=(\d+)/) || [])[1]
console.log("frame_ref", frameRef, "button_ref", buttonRef)
if (frameRef) {
  console.log("== subtree at frame ref ==")
  console.log(await page.snapshot({ scope: "subtree", root: "@" + frameRef }))
}
await page.click("@" + buttonRef)
console.log("== after click ==")
console.log(await page.snapshot())
console.log("frame_result", await page.evaluate(() => document.getElementById("frame") ? "top-cannot-read" : "?"))
JS
echo "exit=$?"
