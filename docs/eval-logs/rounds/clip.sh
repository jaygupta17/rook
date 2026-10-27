#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export DISPLAY=:120
printf 'ORIGINAL-CLIP' | xclip -selection clipboard
echo "clipboard_before=$(xclip -selection clipboard -o 2>&1)"
"$EGO" nodejs <<'JS'
const task = await taskSpace("clip")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/clip.html")
await page.click("#ta")
await page.keyboard.paste("pasted text 42")
console.log("textarea_value", JSON.stringify(await page.evaluate(() => document.getElementById("ta").value)))
await page.click("#ce")
await page.keyboard.paste("editable plain text")
console.log("ce_text", JSON.stringify(await page.evaluate(() => document.getElementById("ce").textContent)))
console.log("ce_html", JSON.stringify(await page.evaluate(() => document.getElementById("ce").innerHTML)))
await page.click("#ce")
await page.keyboard.press("Control+A")
await page.keyboard.paste({ text: "fallback text", html: "<b>bold html</b>" })
console.log("ce_rich_text", JSON.stringify(await page.evaluate(() => document.getElementById("ce").textContent)))
console.log("ce_rich_html", JSON.stringify(await page.evaluate(() => document.getElementById("ce").innerHTML)))
JS
echo "exit=$?"
sleep 0.5
echo "clipboard_after=$(xclip -selection clipboard -o 2>&1)"
