#!/bin/bash
# All rounds are children of this one shell, like an agent CLI that stays alive.
source /tmp/opencode/rook-eval/env.sh
NAME=recovery-eval

echo "=== round 1: dialogs handled ==="
"$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/dialogs.html")
const r1 = await page.click("#alert")
console.log("alert_receipt", JSON.stringify(r1))
console.log("info_dialog", JSON.stringify((await page.info()).dialog))
await page.acceptDialog()
console.log("after_alert", await page.evaluate(() => document.getElementById("r").textContent))
const r2 = await page.click("#confirm")
console.log("confirm_type", r2.dialog && r2.dialog.type)
await page.acceptDialog()
console.log("after_confirm", await page.evaluate(() => document.getElementById("r").textContent))
const r3 = await page.click("#prompt")
console.log("prompt_type", r3.dialog && r3.dialog.type)
await page.acceptDialog("typed-answer")
console.log("after_prompt", await page.evaluate(() => document.getElementById("r").textContent))
JS
echo "dialogs_exit=$?"

echo "=== round 2: broken selector ==="
"$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
const page = task.page("p1")
console.log("pages", JSON.stringify(await task.pages()))
await page.goto("http://127.0.0.1:8781/form.html")
const t = Date.now()
try { await page.click("#does-not-exist") } catch (e) { console.log("error_after_ms", Date.now() - t); console.log("error", e.message) }
JS
echo "broken_exit=$?"

echo "=== round 3: page navigates away, then stale selector ==="
"$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/nav.html")
await page.waitForTimeout(1200)
console.log("url_now", await page.url())
const t = Date.now()
try { await page.click("#before") } catch (e) { console.log("error_after_ms", Date.now() - t); console.log("error", e.message) }
JS
echo "navigated_exit=$?"

echo "=== round 4: stale ref after navigation ==="
"$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
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

echo "=== round 5: close the page while a wait is pending ==="
"$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/form.html")
const t = Date.now()
const waiting = page.waitForSelector("#never-appears", { timeout: 20000 }).then(
  () => "WAIT-RESOLVED",
  (e) => "WAIT-ERROR: " + e.message,
)
await page.waitForTimeout(300)
await page.close()
console.log("close_result", await waiting, "after_ms", Date.now() - t)
console.log("pages_now", JSON.stringify(await task.pages()))
JS
echo "close_midwait_exit=$?"

echo "=== round 6: unhandled alert (shell timeout 15s) ==="
timeout 15 "$EGO" nodejs <<JS
const task = await taskSpace("$NAME")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/dialogs.html")
console.log("clicking")
const r = await page.click("#alert")
console.log("receipt", JSON.stringify(r))
const t = Date.now()
console.log("title", await page.title(), "after_ms", Date.now() - t)
console.log("done")
JS
echo "unhandled_alert_exit=$?"
