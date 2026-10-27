#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export ROOK_BACKEND=standalone
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone2
rm -rf "$EGO_BROWSER_STATE_DIR"; mkdir -p "$EGO_BROWSER_STATE_DIR"

"$EGO" nodejs <<'JS' > /tmp/opencode/rook-eval/logs/24-standalone-popup-iframe-files.out 2>&1
const fs = await import("node:fs/promises")

// popup
{
  const task = await taskSpace("sp-popup")
  const page = task.page("p1")
  await page.goto("http://127.0.0.1:8781/popup.html")
  const wait = page.waitForEvent("popup", { timeout: 5000 })
  await page.click("#open")
  const pop = await wait
  await pop.waitForLoadState()
  console.log("popup_url", await pop.url())
  console.log("popup_opener", await pop.evaluate(() => String(window.opener === null ? "null" : typeof window.opener)))
  console.log("opener_status", await page.evaluate(() => document.getElementById("status").textContent))
  await pop.fill("#child-input", "standalone child")
  await pop.click("#child-btn")
  console.log("popup_child_result", await pop.evaluate(() => document.getElementById("child-result").textContent))
}

// iframe
{
  const task = await taskSpace("sp-iframe")
  const page = task.page("p1")
  await page.goto("http://127.0.0.1:8781/iframe.html")
  const s = await page.snapshot()
  const ref = (s.match(/button "Frame button" \[ref=(\d+)/) || [])[1]
  console.log("iframe_has_child", s.includes("FRAME-LOADED"), "button_ref", ref)
  await page.click("@" + ref)
  console.log("iframe_clicked", (await page.snapshot()).includes("CLICKED-IN-FRAME"))
}

// files
{
  const task = await taskSpace("sp-files")
  const page = task.page("p1")
  await page.goto("http://127.0.0.1:8781/upload.html")
  await page.setInputFiles("#file", ["/tmp/opencode/rook-eval/fixtures/upload.txt"])
  await page.click("#send")
  await page.waitForSelector("#result", { state: "visible", timeout: 5000 })
  console.log("upload", await page.evaluate(() => document.getElementById("result").textContent), await page.evaluate(() => document.getElementById("file").textContent))
  await page.goto("http://127.0.0.1:8781/")
  const wait = page.waitForEvent("download", { timeout: 10000 })
  await page.click("a[href='/download']")
  const dl = await wait
  await dl.saveAs("/tmp/opencode/rook-eval/downloads/standalone.txt")
  console.log("download", await dl.suggestedFilename(), JSON.stringify(await fs.readFile("/tmp/opencode/rook-eval/downloads/standalone.txt", "utf8")))
}
JS
echo "exit=$?"
