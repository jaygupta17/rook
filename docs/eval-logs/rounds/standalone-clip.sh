#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
export DISPLAY=:120
export ROOK_BACKEND=standalone
export ROOK_HEADFUL=1
export EGO_BROWSER_STATE_DIR=/tmp/opencode/rook-eval/state-standalone-headful
mkdir -p "$EGO_BROWSER_STATE_DIR"
printf 'ORIGINAL-CLIP' | xclip -selection clipboard
echo "before=$(xclip -selection clipboard -o 2>&1)"
"$EGO" nodejs <<'JS'
const task = await taskSpace("sh-clip")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/clip.html")
await page.click("#ta")
await page.keyboard.paste("standalone pasted text")
console.log("textarea", JSON.stringify(await page.evaluate(() => document.getElementById("ta").value)))
await page.click("#ce")
await page.keyboard.paste({ text: "fallback", html: "<b>standalone bold</b>" })
console.log("ce_html", JSON.stringify(await page.evaluate(() => document.getElementById("ce").innerHTML)))
JS
echo "exit=$?"
sleep 0.5
echo "after=$(xclip -selection clipboard -o 2>&1)"
