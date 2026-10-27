#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
"$EGO" nodejs <<'JS'
const fs = await import("node:fs/promises")
const task = await taskSpace("files")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/upload.html")
await page.setInputFiles("#file", ["/tmp/opencode/rook-eval/fixtures/upload.txt"])
await page.click("#send")
await page.waitForSelector("#result", { state: "visible", timeout: 5000 })
console.log("upload_snapshot")
console.log(await page.snapshot())
console.log("upload_result", await page.evaluate(() => ({
  result: document.getElementById("result").textContent,
  file: document.getElementById("file").textContent,
  bytes: document.getElementById("bytes").textContent,
})))

await page.goto("http://127.0.0.1:8781/")
const wait = page.waitForEvent("download", { timeout: 10000 })
await page.click("a[href='/download']")
const dl = await wait
console.log("download_meta", JSON.stringify({ url: dl.url(), name: dl.suggestedFilename() }))
await dl.saveAs("/tmp/opencode/rook-eval/downloads/rook-eval.txt")
const text = await fs.readFile("/tmp/opencode/rook-eval/downloads/rook-eval.txt", "utf8")
console.log("download_text", JSON.stringify(text))
JS
echo "exit=$?"
ls -l /tmp/opencode/rook-eval/downloads/rook-eval.txt 2>&1
