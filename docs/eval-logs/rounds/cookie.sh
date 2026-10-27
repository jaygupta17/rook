#!/bin/bash
source /tmp/opencode/rook-eval/env.sh
echo "=== login in a fresh space via server Set-Cookie ==="
"$EGO" nodejs <<'JS'
const task = await taskSpace("ck1")
const page = task.page("p1")
await page.goto("http://127.0.0.1:8781/login.html")
await page.fill("#user", "jay")
await page.fill("#pass", "hunter2")
await page.click("#login")
await page.waitForURL("**/private.html", { timeout: 5000 })
console.log("space", task.spaceId, "cookie", await page.evaluate(() => document.cookie))
console.log("result", await page.evaluate(() => document.getElementById("result").textContent))
JS
echo "login_exit=$?"
DB="$HOME/.local/share/rook/profiles/default/ck1/Cookies"
echo "immediately rows=$(sqlite3 "$DB" 'select count(*) from cookies;' 2>&1)"
sleep 15
echo "after 15s rows=$(sqlite3 "$DB" 'select count(*) from cookies;' 2>&1) mtime=$(stat -c%y "$DB")"
sqlite3 "$DB" "select host_key,name,expires_utc from cookies;" 2>&1
