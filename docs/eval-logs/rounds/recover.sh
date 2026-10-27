#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
echo "=== dialogs handled ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("recover")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/dialogs.html")
const r1 = await page.click("#alert")
console.log("alert_receipt", JSON.stringify(r1))
console.log("info", JSON.stringify(await page.info()))
await page.acceptDialog()
console.log("after_alert", await page.evaluate(() => document.getElementById("r").textContent))
const r2 = await page.click("#confirm")
console.log("confirm_receipt", JSON.stringify(r2))
await page.acceptDialog()
console.log("after_confirm", await page.evaluate(() => document.getElementById("r").textContent))
const r3 = await page.click("#prompt")
console.log("prompt_receipt", JSON.stringify(r3))
await page.acceptDialog("typed-answer")
console.log("after_prompt", await page.evaluate(() => document.getElementById("r").textContent))
JS
echo "dialogs_exit=$?"

echo "=== broken selector ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("recover")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
const t = Date.now()
try { await page.click("#does-not-exist") } catch (e) { console.log("error_after_ms", Date.now() - t); console.log("error", e.message); console.log("code", e.code || e.error_code) }
JS
echo "broken_exit=$?"

echo "=== page navigates away mid-round ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("recover")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/nav.html")
await page.waitForTimeout(1200)
console.log("url_now", await page.url())
const t = Date.now()
try { await page.click("#before") } catch (e) { console.log("error_after_ms", Date.now() - t); console.log("error", e.message) }
JS
echo "navigated_exit=$?"

echo "=== stale ref after navigation ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("recover")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
const snap = await page.snapshot()
const ref = (snap.match(/textbox "Name" \[ref=(\d+)/) || [])[1]
console.log("ref", ref)
await page.goto("http://127.0.0.1:8781/clip.html")
const t = Date.now()
try { await page.fill("@" + ref, "stale") } catch (e) { console.log("error_after_ms", Date.now() - t); console.log("error", e.message) }
JS
echo "stale_ref_exit=$?"
