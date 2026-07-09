const express = require("express");
const session = require("express-session");
const multer  = require("multer");
const http    = require("http");
const WebSocket = require("ws");
const fs      = require("fs");
const path    = require("path");
const { spawn } = require("child_process");
const archiver  = require("archiver");
const unzipper  = require("unzipper");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "admin123";
const BOT_DIR        = process.env.BOT_DIR        || path.join(__dirname, "bot");
const PORT           = process.env.PORT            || 3000;

if (!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR, { recursive: true });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "s3cr3t_k3y_2024",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: "/tmp/uploads/" });

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/login");
}

// ─── BOT PROCESS ─────────────────────────────────────────────────────────────
let botProcess = null;
let botLogs    = [];
const MAX_LOGS = 500;

function addLog(line) {
  const entry = `[${new Date().toLocaleTimeString("bn-BD")}] ${line}`;
  botLogs.push(entry);
  if (botLogs.length > MAX_LOGS) botLogs.shift();
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "log", data: entry }));
  });
}

function startBot() {
  if (botProcess) return { ok: false, msg: "বট ইতিমধ্যে চলছে" };
  const indexFile = fs.existsSync(path.join(BOT_DIR, "index.js"))
    ? "index.js"
    : fs.existsSync(path.join(BOT_DIR, "app.js"))
    ? "app.js"
    : null;
  if (!indexFile) return { ok: false, msg: "index.js বা app.js পাওয়া যায়নি" };

  botProcess = spawn("node", [indexFile], { cwd: BOT_DIR, env: { ...process.env } });
  botProcess.stdout.on("data", d => addLog(d.toString().trim()));
  botProcess.stderr.on("data", d => addLog("⚠️ " + d.toString().trim()));
  botProcess.on("exit", code => {
    addLog(`🔴 বট বন্ধ হয়েছে (code: ${code})`);
    botProcess = null;
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "status", running: false }));
    });
  });
  addLog("🟢 বট চালু হয়েছে");
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "status", running: true }));
  });
  return { ok: true, msg: "বট চালু হয়েছে" };
}

function stopBot() {
  if (!botProcess) return { ok: false, msg: "বট চলছে না" };
  botProcess.kill("SIGTERM");
  botProcess = null;
  addLog("🔴 বট বন্ধ করা হয়েছে");
  return { ok: true, msg: "বট বন্ধ হয়েছে" };
}

// ─── ROUTES: AUTH ─────────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  if (req.session.loggedIn) return res.redirect("/");
  res.send(loginPage());
});

app.post("/login", (req, res) => {
  if (req.body.password === PANEL_PASSWORD) {
    req.session.loggedIn = true;
    res.redirect("/");
  } else {
    res.send(loginPage("❌ পাসওয়ার্ড ভুল হয়েছে"));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ─── ROUTES: DASHBOARD ───────────────────────────────────────────────────────
app.get("/", auth, (req, res) => res.send(dashboardPage()));

// ─── ROUTES: BOT CONTROL ─────────────────────────────────────────────────────
app.post("/api/bot/start",   auth, (req, res) => res.json(startBot()));
app.post("/api/bot/stop",    auth, (req, res) => res.json(stopBot()));
app.post("/api/bot/restart", auth, (req, res) => {
  stopBot();
  setTimeout(() => res.json(startBot()), 1500);
});
app.get("/api/bot/status", auth, (req, res) => {
  res.json({ running: !!botProcess });
});
app.get("/api/bot/logs", auth, (req, res) => res.json({ logs: botLogs }));

// ─── ROUTES: FILE MANAGER ────────────────────────────────────────────────────
app.get("/api/files", auth, (req, res) => {
  const rel = req.query.path || "";
  const dir  = path.join(BOT_DIR, rel);
  if (!dir.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  try {
    const items = fs.readdirSync(dir).map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, isDir: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
    });
    res.json({ items, current: rel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/file/read", auth, (req, res) => {
  const full = path.join(BOT_DIR, req.query.path || "");
  if (!full.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  try { res.json({ content: fs.readFileSync(full, "utf8") }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/file/save", auth, (req, res) => {
  const full = path.join(BOT_DIR, req.body.path || "");
  if (!full.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.body.content || "");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/file/delete", auth, (req, res) => {
  const full = path.join(BOT_DIR, req.body.path || "");
  if (!full.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  try {
    fs.rmSync(full, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/file/mkdir", auth, (req, res) => {
  const full = path.join(BOT_DIR, req.body.path || "");
  if (!full.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  try { fs.mkdirSync(full, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/file/rename", auth, (req, res) => {
  const from = path.join(BOT_DIR, req.body.from || "");
  const to   = path.join(BOT_DIR, req.body.to   || "");
  if (!from.startsWith(BOT_DIR) || !to.startsWith(BOT_DIR))
    return res.status(403).json({ error: "Access denied" });
  try { fs.renameSync(from, to); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload
app.post("/api/file/upload", auth, upload.single("file"), async (req, res) => {
  const dir  = path.join(BOT_DIR, req.body.path || "");
  if (!dir.startsWith(BOT_DIR)) return res.status(403).json({ error: "Access denied" });
  const dest = path.join(dir, req.file.originalname);
  if (req.file.originalname.endsWith(".zip")) {
    fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: dir }))
      .on("close", () => { fs.unlinkSync(req.file.path); res.json({ ok: true, msg: "ZIP extract হয়েছে" }); })
      .on("error", e => res.status(500).json({ error: e.message }));
  } else {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  }
});

// Download
app.get("/api/file/download", auth, (req, res) => {
  const full = path.join(BOT_DIR, req.query.path || "");
  if (!full.startsWith(BOT_DIR)) return res.status(403).end();
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(full)}.zip"`);
    const archive = archiver("zip");
    archive.pipe(res);
    archive.directory(full, false);
    archive.finalize();
  } else {
    res.download(full);
  }
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "status", running: !!botProcess }));
  ws.send(JSON.stringify({ type: "logs",   data: botLogs }));
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Panel চলছে: http://localhost:${PORT}`));

// ══════════════════════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

function loginPage(error = "") {
  return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);font-family:'Segoe UI',sans-serif}
.card{background:rgba(255,255,255,.07);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.15);
  border-radius:20px;padding:48px 40px;width:100%;max-width:400px;text-align:center}
.logo{font-size:48px;margin-bottom:12px}
h1{color:#fff;font-size:22px;font-weight:700;margin-bottom:6px}
p{color:rgba(255,255,255,.5);font-size:13px;margin-bottom:32px}
input{width:100%;padding:14px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.08);color:#fff;font-size:15px;outline:none;margin-bottom:16px}
input::placeholder{color:rgba(255,255,255,.4)}
button{width:100%;padding:14px;border-radius:12px;border:none;
  background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:16px;
  font-weight:700;cursor:pointer;transition:.2s}
button:hover{opacity:.9;transform:translateY(-1px)}
.err{background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.3);
  color:#ff8080;padding:10px 16px;border-radius:10px;font-size:13px;margin-bottom:16px}
</style></head><body>
<div class="card">
  <div class="logo">🤖</div>
  <h1>Bot Panel</h1>
  <p>পাসওয়ার্ড দিয়ে ঢুকুন</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="পাসওয়ার্ড লিখুন" autofocus required>
    <button type="submit">প্রবেশ করুন →</button>
  </form>
</div>
</body></html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',sans-serif;min-height:100vh}
/* NAV */
nav{background:#161b22;border-bottom:1px solid #30363d;padding:0 20px;display:flex;align-items:center;height:56px;gap:8px;position:sticky;top:0;z-index:100}
.nav-logo{font-size:22px;margin-right:8px}
.nav-title{font-weight:700;font-size:16px;color:#fff;margin-right:auto}
.nav-btn{padding:7px 16px;border-radius:8px;border:1px solid #30363d;background:transparent;
  color:#8b949e;font-size:13px;cursor:pointer;transition:.2s;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.nav-btn:hover{background:#21262d;color:#e6edf3}
.nav-btn.danger{border-color:#f8514922;color:#f85149}
.nav-btn.danger:hover{background:#f8514910}
/* TABS */
.tabs{display:flex;border-bottom:1px solid #30363d;background:#161b22;padding:0 20px;gap:4px}
.tab{padding:12px 18px;font-size:14px;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;transition:.2s}
.tab.active{color:#58a6ff;border-color:#58a6ff}
.tab:hover:not(.active){color:#e6edf3}
/* MAIN */
.main{padding:20px;max-width:1200px;margin:0 auto}
.section{display:none}.section.active{display:block}
/* STATUS CARD */
.status-bar{display:flex;align-items:center;gap:16px;background:#161b22;border:1px solid #30363d;
  border-radius:12px;padding:16px 20px;margin-bottom:20px}
.status-dot{width:10px;height:10px;border-radius:50%;background:#f85149;flex-shrink:0}
.status-dot.on{background:#3fb950;box-shadow:0 0 8px #3fb950}
.status-text{font-size:14px;color:#8b949e;flex:1}
.status-text b{color:#e6edf3}
.ctrl-btn{padding:9px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:.2s}
.btn-start{background:#238636;color:#fff}.btn-start:hover{background:#2ea043}
.btn-stop{background:#b62324;color:#fff}.btn-stop:hover{background:#f85149}
.btn-restart{background:#9e6a03;color:#fff}.btn-restart:hover{background:#d29922}
/* LOGS */
.log-box{background:#010409;border:1px solid #30363d;border-radius:12px;padding:16px;
  height:380px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.7}
.log-line{color:#8b949e;word-break:break-all}
.log-line.green{color:#3fb950}
.log-line.red{color:#f85149}
.log-line.yellow{color:#d29922}
/* FILE MANAGER */
.fm-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.fm-path{background:#21262d;border:1px solid #30363d;border-radius:8px;padding:8px 14px;
  font-size:13px;color:#8b949e;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-btn{padding:8px 14px;border-radius:8px;border:1px solid #30363d;background:#21262d;
  color:#e6edf3;font-size:13px;cursor:pointer;transition:.2s;white-space:nowrap}
.fm-btn:hover{background:#30363d}
.fm-btn.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.fm-btn.primary:hover{background:#388bfd}
.fm-btn.danger{border-color:#f8514930;color:#f85149}
.fm-btn.danger:hover{background:#f8514910}
.fm-list{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}
.fm-item{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #21262d;
  cursor:pointer;transition:.15s}
.fm-item:last-child{border-bottom:none}
.fm-item:hover{background:#21262d}
.fm-icon{font-size:18px;flex-shrink:0;width:24px;text-align:center}
.fm-name{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-size{font-size:11px;color:#6e7681;white-space:nowrap}
.fm-actions{display:flex;gap:4px;opacity:0;transition:.15s}
.fm-item:hover .fm-actions{opacity:1}
.fm-action{padding:4px 8px;border-radius:6px;border:none;background:transparent;
  color:#8b949e;font-size:11px;cursor:pointer;transition:.15s}
.fm-action:hover{background:#30363d;color:#e6edf3}
.fm-action.del{color:#f85149}
.fm-action.del:hover{background:#f8514910}
/* EDITOR */
.editor-header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.editor-filename{flex:1;font-size:14px;color:#58a6ff;font-weight:600;overflow:hidden;text-overflow:ellipsis}
textarea#editor{width:100%;height:440px;background:#010409;border:1px solid #30363d;border-radius:12px;
  padding:16px;color:#e6edf3;font-family:monospace;font-size:13px;line-height:1.7;resize:vertical;outline:none}
/* MODAL */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:28px;width:90%;max-width:420px}
.modal h3{font-size:16px;margin-bottom:16px;color:#e6edf3}
.modal input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid #30363d;
  background:#0d1117;color:#e6edf3;font-size:14px;outline:none;margin-bottom:14px}
.modal-btns{display:flex;gap:8px;justify-content:flex-end}
/* UPLOAD */
.upload-area{border:2px dashed #30363d;border-radius:12px;padding:32px;text-align:center;
  cursor:pointer;transition:.2s;margin-bottom:16px}
.upload-area:hover{border-color:#58a6ff;background:#58a6ff08}
.upload-area p{color:#8b949e;font-size:14px;margin-top:8px}
/* TOAST */
.toast{position:fixed;bottom:24px;right:24px;background:#238636;color:#fff;padding:12px 20px;
  border-radius:10px;font-size:14px;z-index:999;opacity:0;transition:.3s;pointer-events:none}
.toast.show{opacity:1}
.toast.err{background:#b62324}
</style>
</head><body>

<nav>
  <span class="nav-logo">🤖</span>
  <span class="nav-title">Bot Panel</span>
  <a href="/logout" class="nav-btn danger">🚪 লগআউট</a>
</nav>

<div class="tabs">
  <div class="tab active" onclick="switchTab('dashboard')">📊 Dashboard</div>
  <div class="tab" onclick="switchTab('files')">📁 ফাইল ম্যানেজার</div>
  <div class="tab" onclick="switchTab('upload')">⬆️ আপলোড</div>
</div>

<!-- DASHBOARD -->
<div class="main">
<div id="tab-dashboard" class="section active">
  <div class="status-bar">
    <div class="status-dot" id="statusDot"></div>
    <div class="status-text">বট: <b id="statusText">চেক করছে...</b></div>
    <button class="ctrl-btn btn-start"   onclick="botAction('start')">▶ চালু</button>
    <button class="ctrl-btn btn-stop"    onclick="botAction('stop')">⏹ বন্ধ</button>
    <button class="ctrl-btn btn-restart" onclick="botAction('restart')">🔄 রিস্টার্ট</button>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-size:13px;color:#8b949e">📋 Live Logs</span>
    <button class="fm-btn" onclick="clearLogs()">🗑 মুছুন</button>
  </div>
  <div class="log-box" id="logBox"></div>
</div>

<!-- FILE MANAGER -->
<div id="tab-files" class="section">
  <div id="editorView" style="display:none">
    <div class="editor-header">
      <button class="fm-btn" onclick="closeEditor()">← ফিরে যান</button>
      <span class="editor-filename" id="editorFile"></span>
      <button class="fm-btn primary" onclick="saveFile()">💾 সেভ করুন</button>
    </div>
    <textarea id="editor"></textarea>
  </div>
  <div id="fileView">
    <div class="fm-bar">
      <div class="fm-path" id="currentPath">/ (root)</div>
      <button class="fm-btn primary" onclick="showMkdir()">📁 নতুন ফোল্ডার</button>
      <button class="fm-btn primary" onclick="showNewFile()">📄 নতুন ফাইল</button>
    </div>
    <div class="fm-list" id="fileList">লোড হচ্ছে...</div>
  </div>
</div>

<!-- UPLOAD -->
<div id="tab-upload" class="section">
  <div class="upload-area" onclick="document.getElementById('fileInput').click()" id="uploadArea">
    <div style="font-size:40px">📦</div>
    <p>ক্লিক করুন বা ফাইল টেনে আনুন</p>
    <p style="font-size:12px;margin-top:4px">ZIP ফাইল আপলোড করলে অটো extract হবে</p>
  </div>
  <input type="file" id="fileInput" style="display:none" onchange="uploadFile(this.files[0])">
  <div id="uploadStatus"></div>
</div>
</div>

<!-- MODALS -->
<div class="modal-bg" id="mkdirModal">
  <div class="modal">
    <h3>📁 নতুন ফোল্ডার</h3>
    <input type="text" id="mkdirName" placeholder="ফোল্ডারের নাম">
    <div class="modal-btns">
      <button class="fm-btn" onclick="closeModal('mkdirModal')">বাতিল</button>
      <button class="fm-btn primary" onclick="mkdir()">তৈরি করুন</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="newFileModal">
  <div class="modal">
    <h3>📄 নতুন ফাইল</h3>
    <input type="text" id="newFileName" placeholder="ফাইলের নাম (যেমন: test.js)">
    <div class="modal-btns">
      <button class="fm-btn" onclick="closeModal('newFileModal')">বাতিল</button>
      <button class="fm-btn primary" onclick="createFile()">তৈরি করুন</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="renameModal">
  <div class="modal">
    <h3>✏️ নাম পরিবর্তন</h3>
    <input type="text" id="renameInput" placeholder="নতুন নাম">
    <div class="modal-btns">
      <button class="fm-btn" onclick="closeModal('renameModal')">বাতিল</button>
      <button class="fm-btn primary" onclick="doRename()">পরিবর্তন করুন</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ── STATE ──
let currentDir = "";
let currentEditPath = "";
let renameFrom = "";
let ws;

// ── TABS ──
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t,i) => t.classList.toggle("active", ["dashboard","files","upload"][i]===name));
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.getElementById("tab-"+name).classList.add("active");
  if (name==="files") loadFiles(currentDir);
}

// ── WEBSOCKET ──
function connectWS() {
  const proto = location.protocol==="https:"?"wss":"ws";
  ws = new WebSocket(proto+"://"+location.host);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type==="log")    appendLog(msg.data);
    if (msg.type==="logs")   msg.data.forEach(appendLog);
    if (msg.type==="status") updateStatus(msg.running);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

function appendLog(line) {
  const box = document.getElementById("logBox");
  const div = document.createElement("div");
  div.className = "log-line" + (line.includes("🟢")||line.includes("✅")?" green":line.includes("🔴")||line.includes("⚠️")?" red":line.includes("🔄")?" yellow":"");
  div.textContent = line;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function clearLogs() { document.getElementById("logBox").innerHTML=""; }

function updateStatus(running) {
  document.getElementById("statusDot").className  = "status-dot"+(running?" on":"");
  document.getElementById("statusText").textContent = running?"✅ চলছে":"🔴 বন্ধ";
}

// ── BOT CONTROL ──
async function botAction(action) {
  const res = await fetch("/api/bot/"+action,{method:"POST"});
  const d   = await res.json();
  toast(d.msg, d.ok);
  if (action==="restart") setTimeout(()=>fetch("/api/bot/status").then(r=>r.json()).then(d=>updateStatus(d.running)),2000);
}

// ── FILE MANAGER ──
async function loadFiles(dir) {
  currentDir = dir;
  document.getElementById("currentPath").textContent = "/"+dir || "/ (root)";
  document.getElementById("fileView").style.display="block";
  document.getElementById("editorView").style.display="none";
  const res  = await fetch("/api/files?path="+encodeURIComponent(dir));
  const data = await res.json();
  const list = document.getElementById("fileList");
  list.innerHTML = "";

  if (dir) {
    const up = document.createElement("div");
    up.className="fm-item";
    up.innerHTML='<span class="fm-icon">⬆️</span><span class="fm-name">.. (উপরে)</span>';
    up.onclick = () => loadFiles(dir.split("/").slice(0,-1).join("/"));
    list.appendChild(up);
  }

  if (!data.items || !data.items.length) {
    list.innerHTML += '<div style="padding:24px;text-align:center;color:#6e7681;font-size:13px">📭 ফোল্ডার খালি</div>';
    return;
  }

  [...data.items].sort((a,b)=>(b.isDir-a.isDir)||(a.name.localeCompare(b.name))).forEach(item => {
    const fullPath = dir ? dir+"/"+item.name : item.name;
    const el = document.createElement("div");
    el.className = "fm-item";
    el.innerHTML = \`
      <span class="fm-icon">\${item.isDir?"📁":fileIcon(item.name)}</span>
      <span class="fm-name">\${item.name}</span>
      <span class="fm-size">\${item.isDir?"":fmtSize(item.size)}</span>
      <div class="fm-actions">
        \${!item.isDir?'<button class="fm-action" onclick="event.stopPropagation();editFile(\\''+fullPath+'\\')">✏️ এডিট</button>':''}
        <button class="fm-action" onclick="event.stopPropagation();downloadItem('\${fullPath}')">⬇️</button>
        <button class="fm-action" onclick="event.stopPropagation();showRename('\${fullPath}','\${item.name}')">✏️</button>
        <button class="fm-action del" onclick="event.stopPropagation();deleteItem('\${fullPath}','\${item.name}')">🗑</button>
      </div>\`;
    if (item.isDir) el.onclick = () => loadFiles(fullPath);
    else el.onclick = () => editFile(fullPath);
    list.appendChild(el);
  });
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  return {js:"📜",json:"📋",md:"📝",txt:"📝",env:"🔐",log:"📋",jpg:"🖼",png:"🖼",gif:"🖼"}[ext]||"📄";
}
function fmtSize(b) {
  if(b<1024) return b+"B"; if(b<1048576) return (b/1024).toFixed(1)+"KB"; return (b/1048576).toFixed(1)+"MB";
}

async function editFile(p) {
  const res  = await fetch("/api/file/read?path="+encodeURIComponent(p));
  const data = await res.json();
  if (data.error) return toast("ফাইল খোলা যায়নি: "+data.error, false);
  currentEditPath = p;
  document.getElementById("editorFile").textContent = p;
  document.getElementById("editor").value = data.content;
  document.getElementById("fileView").style.display   = "none";
  document.getElementById("editorView").style.display = "block";
}

function closeEditor() {
  document.getElementById("editorView").style.display="none";
  document.getElementById("fileView").style.display  ="block";
}

async function saveFile() {
  const content = document.getElementById("editor").value;
  const res     = await fetch("/api/file/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:currentEditPath,content})});
  const data    = await res.json();
  toast(data.ok?"✅ সেভ হয়েছে":"❌ "+data.error, data.ok);
}

async function deleteItem(p, name) {
  if (!confirm(\`"\${name}" ডিলিট করবেন?\`)) return;
  const res  = await fetch("/api/file/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})});
  const data = await res.json();
  toast(data.ok?"🗑 ডিলিট হয়েছে":"❌ "+data.error, data.ok);
  if (data.ok) loadFiles(currentDir);
}

function downloadItem(p) { window.open("/api/file/download?path="+encodeURIComponent(p)); }

// MKDIR
function showMkdir() { document.getElementById("mkdirName").value=""; document.getElementById("mkdirModal").classList.add("open"); }
async function mkdir() {
  const name = document.getElementById("mkdirName").value.trim();
  if (!name) return;
  const fullPath = currentDir ? currentDir+"/"+name : name;
  const res  = await fetch("/api/file/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fullPath})});
  const data = await res.json();
  closeModal("mkdirModal");
  toast(data.ok?"📁 ফোল্ডার তৈরি হয়েছে":"❌ "+data.error, data.ok);
  if (data.ok) loadFiles(currentDir);
}

// NEW FILE
function showNewFile() { document.getElementById("newFileName").value=""; document.getElementById("newFileModal").classList.add("open"); }
async function createFile() {
  const name = document.getElementById("newFileName").value.trim();
  if (!name) return;
  const fullPath = currentDir ? currentDir+"/"+name : name;
  const res  = await fetch("/api/file/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fullPath,content:""})});
  const data = await res.json();
  closeModal("newFileModal");
  if (data.ok) { toast("📄 ফাইল তৈরি হয়েছে", true); editFile(fullPath); }
  else toast("❌ "+data.error, false);
}

// RENAME
function showRename(p, name) { renameFrom=p; document.getElementById("renameInput").value=name; document.getElementById("renameModal").classList.add("open"); }
async function doRename() {
  const newName = document.getElementById("renameInput").value.trim();
  if (!newName) return;
  const dir  = renameFrom.includes("/") ? renameFrom.split("/").slice(0,-1).join("/") : "";
  const to   = dir ? dir+"/"+newName : newName;
  const res  = await fetch("/api/file/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:renameFrom,to})});
  const data = await res.json();
  closeModal("renameModal");
  toast(data.ok?"✅ নাম পরিবর্তন হয়েছে":"❌ "+data.error, data.ok);
  if (data.ok) loadFiles(currentDir);
}

function closeModal(id) { document.getElementById(id).classList.remove("open"); }

// UPLOAD
async function uploadFile(file) {
  if (!file) return;
  const status = document.getElementById("uploadStatus");
  status.innerHTML = '<p style="color:#d29922;font-size:13px">⏳ আপলোড হচ্ছে...</p>';
  const fd = new FormData();
  fd.append("file", file);
  fd.append("path", currentDir);
  const res  = await fetch("/api/file/upload",{method:"POST",body:fd});
  const data = await res.json();
  status.innerHTML = data.ok
    ? '<p style="color:#3fb950;font-size:13px">✅ '+(data.msg||"আপলোড সম্পন্ন")+'</p>'
    : '<p style="color:#f85149;font-size:13px">❌ '+data.error+'</p>';
  document.getElementById("fileInput").value="";
  if (data.ok) loadFiles(currentDir);
}

// DRAG DROP
const ua = document.getElementById("uploadArea");
ua.addEventListener("dragover", e => { e.preventDefault(); ua.style.borderColor="#58a6ff"; });
ua.addEventListener("dragleave", () => { ua.style.borderColor="#30363d"; });
ua.addEventListener("drop", e => { e.preventDefault(); ua.style.borderColor="#30363d"; uploadFile(e.dataTransfer.files[0]); });

// TOAST
function toast(msg, ok=true) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = "toast show"+(ok?"":" err");
  setTimeout(()=>t.className="toast",3000);
}

// INIT
connectWS();
fetch("/api/bot/status").then(r=>r.json()).then(d=>updateStatus(d.running));
</script>
</body></html>`;
}
