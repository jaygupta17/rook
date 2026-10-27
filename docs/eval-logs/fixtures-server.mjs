import http from "node:http";

const PORT = Number(process.env.FIXTURE_PORT || 8781);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px}label{display:block;margin:12px 0 4px}
input,textarea,select{font-size:16px;padding:6px;width:320px}
button{font-size:16px;padding:8px 16px;margin-top:16px}</style></head>
<body><h1 id="h">${title}</h1>${body}</body></html>`;
}

function send(res, code, html, headers = {}) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

function cookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(
    raw.split(";").map((p) => p.trim().split("=")).filter((p) => p.length === 2),
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/") return send(res, 200, page("Fixture home", `<p id="home">home</p><ul>
<li><a href="/form.html">form</a></li><li><a href="/login.html">login</a></li>
<li><a href="/popup.html">popup</a></li><li><a href="/iframe.html">iframe</a></li>
<li><a href="/upload.html">upload</a></li><li><a href="/clip.html">clip</a></li>
<li><a href="/dialogs.html">dialogs</a></li><li><a href="/nav.html">nav</a></li>
<li><a href="/download">download</a></li></ul>`));

  if (p === "/form.html") return send(res, 200, page("Profile form", `
<form method="POST" action="/form-result">
  <label for="name">Name</label><input id="name" name="name" autocomplete="off">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off">
  <label for="about">About</label><textarea id="about" name="about" rows="3"></textarea>
  <label for="month">Month</label>
  <select id="month" name="month">
    <option value="">-- choose --</option>
    <option value="jan">January</option>
    <option value="oct">October</option>
    <option value="dec">December</option>
  </select>
  <label><input type="checkbox" id="agree" name="agree" value="yes" style="width:auto"> I agree</label>
  <button type="submit" id="submit">Submit form</button>
</form>`));

  if (p === "/form-result" && req.method === "POST") {
    const body = (await readBody(req)).toString();
    const q = new URLSearchParams(body);
    const ok = q.get("name") === "Jay Gupta" && q.get("email") === "jay@example.com"
      && (q.get("about") || "").includes("review") && q.get("month") === "oct"
      && q.get("agree") === "yes";
    return send(res, 200, page("Form result", `
<p id="result">${ok ? "FORM-OK" : "FORM-BAD"}</p>
<pre id="values">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`));
  }

  if (p === "/login.html") return send(res, 200, page("Sign in", `
<form method="POST" action="/login">
  <label for="user">Username</label><input id="user" name="user" autocomplete="off">
  <label for="pass">Password</label><input id="pass" name="pass" type="password">
  <button type="submit" id="login">Sign in</button>
</form>`));

  if (p === "/login" && req.method === "POST") {
    const q = new URLSearchParams((await readBody(req)).toString());
    if (q.get("user") === "jay" && q.get("pass") === "hunter2") {
      res.writeHead(302, {
        "set-cookie": "sid=ok-123; Path=/; Max-Age=86400; SameSite=Lax",
        location: "/private.html",
      });
      return res.end();
    }
    return send(res, 401, page("Sign in failed", `<p id="result">LOGIN-BAD</p>`));
  }

  if (p === "/private.html") {
    const ok = cookies(req).sid === "ok-123";
    return send(res, ok ? 200 : 401, page(ok ? "Private area" : "Denied",
      `<p id="result">${ok ? "PRIVATE-OK" : "PRIVATE-DENIED"}</p>
       <p id="cookie">${req.headers.cookie || "no cookie"}</p>`));
  }

  if (p === "/logout") {
    res.writeHead(302, { "set-cookie": "sid=; Path=/; Max-Age=0", location: "/private.html" });
    return res.end();
  }

  if (p === "/popup.html") return send(res, 200, page("Popup opener", `
<p id="status">not opened</p>
<button id="open" onclick="const w=window.open('/popup-child.html','kid','width=560,height=480');document.getElementById('status').textContent='window.open returned: '+(w===null?'null':typeof w)">Open popup</button>`));

  if (p === "/popup-child.html") return send(res, 200, page("Popup child", `
<p id="opener">opener-null: <span id="openerval"></span></p>
<p id="name">window-name: <span id="nameval"></span></p>
<input id="child-input" placeholder="child input">
<button id="child-btn" onclick="document.getElementById('child-result').textContent='CHILD-CLICKED'">Child button</button>
<p id="child-result">not clicked</p>
<script>
document.getElementById('openerval').textContent=String(window.opener===null?'null':typeof window.opener);
document.getElementById('nameval').textContent=String(window.name);
</script>`));

  if (p === "/iframe.html") return send(res, 200, page("Outer iframe page", `
<p id="outer">outer ready</p>
<iframe id="frame" title="cross origin frame" src="http://127.0.0.2:${PORT}/frame.html" width="640" height="360"></iframe>`));

  if (p === "/frame.html") return send(res, 200, page("Frame content", `
<p id="frame-marker">FRAME-LOADED</p>
<label for="frame-input">Frame input</label><input id="frame-input">
<button id="frame-btn" onclick="document.getElementById('frame-result').textContent='CLICKED-IN-FRAME'">Frame button</button>
<p id="frame-result">not clicked</p>`));

  if (p === "/upload.html") return send(res, 200, page("Upload", `
<form method="POST" action="/upload-result" enctype="multipart/form-data">
  <label for="file">File</label><input id="file" type="file" name="file">
  <button type="submit" id="send">Upload</button>
</form>`));

  if (p === "/upload-result" && req.method === "POST") {
    const body = await readBody(req);
    const text = body.toString("latin1");
    const m = text.match(/filename="([^"]*)"/);
    const content = text.split(/\r\n\r\n/).slice(1).join("\r\n\r\n");
    return send(res, 200, page("Upload result",
      `<p id="result">UPLOAD-OK</p><p id="file">${m ? m[1] : "none"}</p><p id="bytes">${content.length}</p>`));
  }

  if (p === "/clip.html") return send(res, 200, page("Clipboard", `
<label for="ta">Textarea</label><textarea id="ta" rows="3"></textarea>
<label>Contenteditable</label>
<div id="ce" contenteditable="true" style="border:1px solid #888;min-height:60px;width:420px;padding:6px"></div>`));

  if (p === "/dialogs.html") return send(res, 200, page("Dialogs", `
<button id="alert" onclick="alert('ALERT-OK')">Alert</button>
<button id="confirm" onclick="document.getElementById('r').textContent = confirm('CONFIRM?')?'CONFIRM-TRUE':'CONFIRM-FALSE'">Confirm</button>
<button id="prompt" onclick="document.getElementById('r').textContent = 'PROMPT:' + prompt('PROMPT?','')">Prompt</button>
<p id="r">idle</p>`));

  if (p === "/nav.html") return send(res, 200, page("Navigates away", `
<p id="before">before navigation</p>
<button id="stay" onclick="document.getElementById('before').textContent='STILL-HERE'">Stay</button>
<script>setTimeout(()=>{location.href='/form.html'},800)</script>`));

  if (p === "/big") {
    let rows = "";
    for (let i = 0; i < 1200; i++) {
      rows += `<div class="row"><span>row ${i}</span><button id="b${i}" onclick="document.getElementById('big-result').textContent='BIG-CLICKED-${i}'">ok ${i}</button></div>`;
    }
    return send(res, 200, page("Big page", `<p id="big-result">not clicked</p><div id="rows">${rows}</div>`));
  }

  if (p === "/download") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": "attachment; filename=\"rook-eval.txt\"",
    });
    return res.end("rook-download-payload-42\n");
  }

  return send(res, 404, page("Not found", `<p>404 ${p}</p>`));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`fixtures on http://127.0.0.1:${PORT} (also 127.0.0.2:${PORT})`);
});
