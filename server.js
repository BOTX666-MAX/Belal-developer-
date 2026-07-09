const express = require("express");
const session = require("express-session");
const multer  = require("multer");
const http    = require("http");
const WebSocket = require("ws");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const { spawn, execSync } = require("child_process");
const archiver  = require("archiver");
const unzipper  = require("unzipper");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── CONFIG ──
const CFG_FILE = path.join(__dirname, "panel.config.json");
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE,"utf8")); } catch { return {}; }
}
function saveCfg(obj) { fs.writeFileSync(CFG_FILE, JSON.stringify(obj,null,2)); }
let cfg = loadCfg();

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || cfg.password || "admin123";
const BOT_DIR        = path.join(__dirname, "bot");
const LOG_FILE       = path.join(__dirname, "panel.log");
const STATS_FILE     = path.join(__dirname, "stats.json");
const PORT           = process.env.PORT || 3000;

if (!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR, { recursive: true });

// ── STATS ──
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE,"utf8")); }
  catch { return { starts:0, crashes:0, totalUptime:0, history:[], loginAttempts:{} }; }
}
function saveStats(s) { try { fs.writeFileSync(STATS_FILE, JSON.stringify(s,null,2)); } catch {} }
let stats = loadStats();

// ── MIDDLEWARE ──
app.use(express.json({ limit:"500mb" }));
app.use(express.urlencoded({ extended:true, limit:"500mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "belal_2024_secret",
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 7*24*60*60*1000 }
}));

const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null,"/tmp/"),
  filename: (req,file,cb) => cb(null, Date.now()+"_"+file.originalname)
});
const upload = multer({ storage, limits:{ fileSize:500*1024*1024 } });

function auth(req,res,next) {
  if (req.session.loggedIn) return next();
  res.redirect("/login");
}

function safeJoin(base, rel) {
  const full = path.resolve(base, rel||"");
  if (!full.startsWith(path.resolve(base))) throw new Error("Access denied");
  return full;
}

// ── BOT ──
let botProcess  = null;
let botLogs     = [];
let botStartTime = null;
let autoRestart  = cfg.autoRestart || false;
let restartTimer = null;
const MAX_LOGS   = 2000;

function broadcast(data) {
  wss.clients.forEach(c => { if (c.readyState===WebSocket.OPEN) c.send(JSON.stringify(data)); });
}

function addLog(text, type="info") {
  const entry = { time: new Date().toLocaleTimeString("bn-BD"), text, type, ts: Date.now() };
  botLogs.push(entry);
  if (botLogs.length > MAX_LOGS) botLogs.shift();
  broadcast({ type:"log", data:entry });
  // write to file
  try { fs.appendFileSync(LOG_FILE, `[${entry.time}] [${type}] ${text}\n`); } catch {}
}

function startBot(reason="manual") {
  if (botProcess) return { ok:false, msg:"বট ইতিমধ্যে চলছে" };
  const indexFile = ["index.js","app.js","main.js","bot.js","start.js"]
    .find(f => fs.existsSync(path.join(BOT_DIR,f)));
  if (!indexFile) return { ok:false, msg:"index.js পাওয়া যায়নি — বট আপলোড করুন" };

  if (!fs.existsSync(path.join(BOT_DIR,"node_modules"))) {
    try {
      addLog("📦 npm install চলছে...","warn");
      execSync("npm install", { cwd:BOT_DIR, timeout:120000 });
      addLog("✅ npm install সম্পন্ন","success");
    } catch(e) { addLog("⚠️ npm install সমস্যা: "+e.message,"error"); }
  }

  botProcess = spawn("node",[indexFile],{ cwd:BOT_DIR, env:{...process.env,FORCE_COLOR:"1"} });
  botStartTime = Date.now();
  stats.starts++;
  addLog(`🟢 বট চালু (${reason}) — ${indexFile}`,"success");
  broadcast({ type:"status", running:true });

  botProcess.stdout.on("data", d => addLog(d.toString().trim(),"info"));
  botProcess.stderr.on("data", d => addLog(d.toString().trim(),"error"));
  botProcess.on("exit", (code,signal) => {
    const upSec = botStartTime ? Math.floor((Date.now()-botStartTime)/1000) : 0;
    stats.totalUptime += upSec;
    stats.history.push({ date:new Date().toISOString(), uptime:upSec, code });
    if (stats.history.length > 50) stats.history.shift();
    if (code !== 0 && code !== null) stats.crashes++;
    saveStats(stats);
    addLog(`🔴 বট বন্ধ (code:${code||signal}, uptime:${fmtSec(upSec)})`,"error");
    botProcess = null; botStartTime = null;
    broadcast({ type:"status", running:false });
    if (autoRestart && code !== 0 && code !== null) {
      addLog("🔄 Auto-restart: ১০ সেকেন্ড পরে চালু হবে...","warn");
      restartTimer = setTimeout(() => startBot("auto-restart"), 10000);
    }
  });
  saveStats(stats);
  return { ok:true, msg:"বট চালু হয়েছে" };
}

function stopBot() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!botProcess) return { ok:false, msg:"বট চলছে না" };
  botProcess.kill("SIGTERM");
  botProcess = null; botStartTime = null;
  addLog("🔴 বট বন্ধ করা হয়েছে","warn");
  broadcast({ type:"status", running:false });
  return { ok:true, msg:"বট বন্ধ হয়েছে" };
}

function fmtSec(s) {
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return h>0?`${h}h ${m}m`:m>0?`${m}m ${sec}s`:`${sec}s`;
}

// ── LOGIN PROTECTION ──
function checkLoginAttempt(ip) {
  const now = Date.now();
  if (!stats.loginAttempts[ip]) stats.loginAttempts[ip] = { count:0, until:0 };
  const a = stats.loginAttempts[ip];
  if (a.until > now) return { blocked:true, wait: Math.ceil((a.until-now)/1000) };
  if (a.count >= 5) { a.until = now + 5*60*1000; a.count = 0; saveStats(stats); return { blocked:true, wait:300 }; }
  return { blocked:false };
}
function failLogin(ip) {
  if (!stats.loginAttempts[ip]) stats.loginAttempts[ip] = { count:0, until:0 };
  stats.loginAttempts[ip].count++;
  saveStats(stats);
}
function clearLogin(ip) { delete stats.loginAttempts[ip]; saveStats(stats); }

// ── AUTH ROUTES ──
app.get("/login", (req,res) => { if (req.session.loggedIn) return res.redirect("/"); res.send(loginHTML()); });
app.post("/login", (req,res) => {
  const ip = req.ip;
  const chk = checkLoginAttempt(ip);
  if (chk.blocked) return res.json({ ok:false, msg:`❌ ${chk.wait} সেকেন্ড অপেক্ষা করুন` });
  if (req.body.password === PANEL_PASSWORD) {
    clearLogin(ip); req.session.loggedIn = true;
    res.json({ ok:true });
  } else {
    failLogin(ip);
    const rem = 5 - (stats.loginAttempts[ip]?.count||0);
    res.json({ ok:false, msg:`❌ ভুল পাসওয়ার্ড। আর ${rem} বার চেষ্টা করতে পারবেন।` });
  }
});
app.get("/logout", (req,res) => { req.session.destroy(); res.redirect("/login"); });

// ── MAIN ──
app.get("/", auth, (req,res) => res.send(dashHTML()));

// ── BOT API ──
app.post("/api/bot/start",   auth, (req,res) => res.json(startBot()));
app.post("/api/bot/stop",    auth, (req,res) => res.json(stopBot()));
app.post("/api/bot/restart", auth, (req,res) => { stopBot(); setTimeout(()=>res.json(startBot("restart")),2000); });
app.get("/api/bot/status",   auth, (req,res) => {
  const uptime = botStartTime ? Math.floor((Date.now()-botStartTime)/1000) : 0;
  res.json({ running:!!botProcess, uptime });
});
app.get("/api/bot/logs",     auth, (req,res) => res.json({ logs:botLogs }));
app.post("/api/bot/clearlogs", auth, (req,res) => { botLogs=[]; broadcast({type:"clearLogs"}); res.json({ok:true}); });
app.post("/api/bot/install", auth, (req,res) => {
  if (!fs.existsSync(path.join(BOT_DIR,"package.json"))) return res.json({ok:false,msg:"package.json নেই"});
  try {
    addLog("📦 npm install চলছে...","warn");
    execSync("npm install",{cwd:BOT_DIR,timeout:120000});
    addLog("✅ সব package install হয়েছে","success");
    res.json({ok:true,msg:"npm install সম্পন্ন"});
  } catch(e) { addLog("❌ npm install ব্যর্থ: "+e.message,"error"); res.json({ok:false,msg:e.message}); }
});

// Auto-restart toggle
app.post("/api/bot/autorestart", auth, (req,res) => {
  autoRestart = !!req.body.enabled;
  cfg.autoRestart = autoRestart; saveCfg(cfg);
  res.json({ok:true, enabled:autoRestart});
});

// Download log file
app.get("/api/bot/downloadlog", auth, (req,res) => {
  if (fs.existsSync(LOG_FILE)) res.download(LOG_FILE,"bot.log");
  else res.status(404).send("No log file");
});

// Clear log file
app.post("/api/bot/clearlogfile", auth, (req,res) => {
  try { fs.writeFileSync(LOG_FILE,""); res.json({ok:true}); } catch(e) { res.json({ok:false,msg:e.message}); }
});

// ── FILE API ──
app.get("/api/files", auth, (req,res) => {
  try {
    const dir = safeJoin(BOT_DIR, req.query.path||"");
    if (!fs.existsSync(dir)) return res.json({items:[],current:req.query.path||""});
    const items = fs.readdirSync(dir).map(name => {
      const full = path.join(dir,name), stat = fs.statSync(full);
      return { name, isDir:stat.isDirectory(), size:stat.size, mtime:stat.mtime, ext:path.extname(name).toLowerCase() };
    }).sort((a,b)=>(b.isDir-a.isDir)||a.name.localeCompare(b.name));
    res.json({items, current:req.query.path||""});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/file/read", auth, (req,res) => {
  try {
    const full = safeJoin(BOT_DIR, req.query.path);
    const stat = fs.statSync(full);
    if (stat.size > 5*1024*1024) return res.json({error:"ফাইল অনেক বড় (5MB+)"});
    res.json({content:fs.readFileSync(full,"utf8"), size:stat.size});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/save", auth, (req,res) => {
  try {
    const full = safeJoin(BOT_DIR, req.body.path);
    fs.mkdirSync(path.dirname(full),{recursive:true});
    // backup
    if (fs.existsSync(full) && cfg.autoBackup !== false) {
      const bk = full+".bak"; fs.copyFileSync(full,bk);
    }
    fs.writeFileSync(full, req.body.content||"");
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/delete", auth, (req,res) => {
  try { fs.rmSync(safeJoin(BOT_DIR,req.body.path),{recursive:true,force:true}); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/mkdir", auth, (req,res) => {
  try { fs.mkdirSync(safeJoin(BOT_DIR,req.body.path),{recursive:true}); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/rename", auth, (req,res) => {
  try { fs.renameSync(safeJoin(BOT_DIR,req.body.from),safeJoin(BOT_DIR,req.body.to)); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/newfile", auth, (req,res) => {
  try {
    const full = safeJoin(BOT_DIR,req.body.path);
    if (fs.existsSync(full)) return res.json({ok:false,msg:"ফাইল ইতিমধ্যে আছে"});
    fs.mkdirSync(path.dirname(full),{recursive:true});
    fs.writeFileSync(full, req.body.content||"");
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/file/copy", auth, (req,res) => {
  try {
    const from = safeJoin(BOT_DIR,req.body.from);
    const to   = safeJoin(BOT_DIR,req.body.to);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      execSync(`cp -r "${from}" "${to}"`);
    } else { fs.copyFileSync(from,to); }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/file/download", auth, (req,res) => {
  try {
    const full = safeJoin(BOT_DIR,req.query.path);
    if (fs.statSync(full).isDirectory()) {
      res.setHeader("Content-Disposition",`attachment; filename="${path.basename(full)}.zip"`);
      const arc = archiver("zip",{zlib:{level:9}}); arc.pipe(res);
      arc.directory(full,false); arc.finalize();
    } else { res.download(full); }
  } catch(e) { res.status(500).send(e.message); }
});

// search files
app.get("/api/file/search", auth, (req,res) => {
  const q = (req.query.q||"").toLowerCase();
  if (!q) return res.json({results:[]});
  const results = [];
  function walk(dir, rel) {
    try {
      fs.readdirSync(dir).forEach(name => {
        const full = path.join(dir,name), relPath = rel?rel+"/"+name:name;
        const stat = fs.statSync(full);
        if (name.toLowerCase().includes(q)) results.push({name,path:relPath,isDir:stat.isDirectory(),size:stat.size});
        if (stat.isDirectory() && results.length<100) walk(full,relPath);
      });
    } catch {}
  }
  walk(BOT_DIR,"");
  res.json({results:results.slice(0,50)});
});

// search in file content
app.get("/api/file/grep", auth, (req,res) => {
  const q = (req.query.q||"").toLowerCase();
  if (!q) return res.json({results:[]});
  const results = [];
  function walk(dir,rel) {
    try {
      fs.readdirSync(dir).forEach(name => {
        const full = path.join(dir,name), relPath=rel?rel+"/"+name:name;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full,relPath); return; }
        if (stat.size > 500*1024) return;
        try {
          const lines = fs.readFileSync(full,"utf8").split("\n");
          lines.forEach((line,i) => {
            if (line.toLowerCase().includes(q)) results.push({file:relPath,line:i+1,content:line.trim()});
          });
        } catch {}
      });
    } catch {}
  }
  walk(BOT_DIR,"");
  res.json({results:results.slice(0,100)});
});

// backup full bot
app.get("/api/backup", auth, (req,res) => {
  res.setHeader("Content-Disposition",`attachment; filename="bot-backup-${Date.now()}.zip"`);
  const arc = archiver("zip",{zlib:{level:9}});
  arc.pipe(res); arc.directory(BOT_DIR,false); arc.finalize();
});

// upload + extract
app.post("/api/file/upload", auth, upload.single("file"), async (req,res) => {
  try {
    const targetDir = safeJoin(BOT_DIR, req.body.path||"");
    fs.mkdirSync(targetDir,{recursive:true});
    if (req.file.originalname.endsWith(".zip")) {
      await new Promise((resolve,reject) => {
        fs.createReadStream(req.file.path)
          .pipe(unzipper.Extract({path:targetDir}))
          .on("close",resolve).on("error",reject);
      });
      fs.unlinkSync(req.file.path);
      const mac = path.join(targetDir,"__MACOSX");
      if (fs.existsSync(mac)) fs.rmSync(mac,{recursive:true});
      addLog(`📦 ZIP extract → ${req.body.path||"/"}`, "success");
      res.json({ok:true,msg:"ZIP extract সম্পন্ন ✅"});
    } else {
      fs.copyFileSync(req.file.path, path.join(targetDir,req.file.originalname));
      fs.unlinkSync(req.file.path);
      res.json({ok:true,msg:"ফাইল আপলোড ✅"});
    }
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ENV ──
app.get("/api/env", auth, (req,res) => {
  const f = path.join(BOT_DIR,".env");
  res.json({content: fs.existsSync(f)?fs.readFileSync(f,"utf8"):""});
});
app.post("/api/env/save", auth, (req,res) => {
  try { fs.writeFileSync(path.join(BOT_DIR,".env"),req.body.content||""); res.json({ok:true}); }
  catch(e) { res.json({ok:false,msg:e.message}); }
});

// ── SETTINGS ──
app.get("/api/settings", auth, (req,res) => res.json(cfg));
app.post("/api/settings/save", auth, (req,res) => {
  const { theme, autoRestart:ar, autoBackup, panelName, scheduleRestart, scheduleTime } = req.body;
  if (theme) cfg.theme = theme;
  if (ar !== undefined) { cfg.autoRestart = !!ar; autoRestart = !!ar; }
  if (autoBackup !== undefined) cfg.autoBackup = !!autoBackup;
  if (panelName) cfg.panelName = panelName;
  if (scheduleRestart !== undefined) cfg.scheduleRestart = !!scheduleRestart;
  if (scheduleTime) cfg.scheduleTime = scheduleTime;
  saveCfg(cfg);
  res.json({ok:true});
});
app.post("/api/settings/password", auth, (req,res) => {
  const {current,newPass} = req.body;
  if (current !== PANEL_PASSWORD && current !== cfg.password) return res.json({ok:false,msg:"বর্তমান পাসওয়ার্ড ভুল"});
  if (!newPass || newPass.length < 4) return res.json({ok:false,msg:"নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষর"});
  cfg.password = newPass; saveCfg(cfg);
  res.json({ok:true,msg:"পাসওয়ার্ড পরিবর্তন হয়েছে"});
});

// ── STATS ──
app.get("/api/stats", auth, (req,res) => {
  const uptime = botStartTime ? Math.floor((Date.now()-botStartTime)/1000) : 0;
  res.json({ ...stats, currentUptime:uptime, autoRestart,
    memMB: Math.round(process.memoryUsage().rss/1024/1024),
    serverUptime: Math.floor(process.uptime()),
    node: process.version,
    botFiles: fs.existsSync(BOT_DIR) ? countFiles(BOT_DIR) : 0
  });
});

function countFiles(dir) {
  let c=0;
  try { fs.readdirSync(dir).forEach(f=>{ const s=fs.statSync(path.join(dir,f)); c+=s.isDirectory()?countFiles(path.join(dir,f)):1; }); } catch {}
  return c;
}

// ── SCHEDULE RESTART ──
function checkSchedule() {
  if (!cfg.scheduleRestart || !cfg.scheduleTime) return;
  const [h,m] = cfg.scheduleTime.split(":").map(Number);
  const now = new Date();
  if (now.getHours()===h && now.getMinutes()===m && now.getSeconds()<10) {
    if (botProcess) { stopBot(); setTimeout(()=>startBot("schedule"),3000); addLog("⏰ Scheduled restart হয়েছে","warn"); }
  }
}
setInterval(checkSchedule, 10000);

// ── WS ──
wss.on("connection", ws => {
  ws.send(JSON.stringify({type:"status",running:!!botProcess}));
  ws.send(JSON.stringify({type:"logs",data:botLogs}));
});

server.listen(PORT, ()=>console.log(`Panel: http://localhost:${PORT}`));

// ════════════════════ HTML ════════════════════

function loginHTML() {
  return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070710;font-family:'Segoe UI',sans-serif;overflow:hidden}
.bg{position:fixed;inset:0}
.orb{position:absolute;border-radius:50%;filter:blur(100px);opacity:.25;animation:fl 8s ease-in-out infinite}
.o1{width:500px;height:500px;background:#6c63ff;top:-150px;left:-150px}
.o2{width:400px;height:400px;background:#ff6584;bottom:-100px;right:-100px;animation-delay:4s}
.o3{width:250px;height:250px;background:#43e97b;top:50%;left:40%;animation-delay:2s}
@keyframes fl{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-40px) scale(1.1)}}
.card{position:relative;z-index:1;background:rgba(255,255,255,.04);backdrop-filter:blur(40px);
  border:1px solid rgba(255,255,255,.08);border-radius:28px;padding:56px 48px;width:100%;max-width:420px;text-align:center}
.logo{width:88px;height:88px;margin:0 auto 22px;background:linear-gradient(135deg,#6c63ff,#ff6584);
  border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:40px;
  box-shadow:0 0 60px rgba(108,99,255,.5);animation:pulse 3s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 40px rgba(108,99,255,.4)}50%{box-shadow:0 0 80px rgba(108,99,255,.8)}}
h1{color:#fff;font-size:26px;font-weight:900;margin-bottom:4px;letter-spacing:-.5px}
.sub{color:rgba(255,255,255,.35);font-size:13px;margin-bottom:40px}
.field{position:relative;margin-bottom:14px}
.field input{width:100%;padding:16px 18px 16px 48px;border-radius:14px;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.06);color:#fff;font-size:15px;outline:none;transition:.3s}
.field input:focus{border-color:#6c63ff;background:rgba(108,99,255,.12);box-shadow:0 0 0 3px rgba(108,99,255,.15)}
.field .ico{position:absolute;left:15px;top:50%;transform:translateY(-50%);font-size:18px}
.btn{width:100%;padding:16px;border-radius:14px;border:none;
  background:linear-gradient(135deg,#6c63ff,#ff6584);color:#fff;font-size:16px;
  font-weight:800;cursor:pointer;transition:.3s;letter-spacing:.3px;margin-top:4px}
.btn:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(108,99,255,.5)}
.err{background:rgba(255,94,94,.08);border:1px solid rgba(255,94,94,.2);color:#ff8080;
  padding:12px;border-radius:12px;font-size:13px;margin-bottom:14px;display:none}
.err.show{display:block}
</style></head><body>
<div class="bg"><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div></div>
<div class="card">
  <div class="logo">🤖</div>
  <h1>Bot Panel</h1>
  <p class="sub">তোমার বট কন্ট্রোল সেন্টার</p>
  <div class="err" id="err"></div>
  <div class="field"><span class="ico">🔐</span><input type="password" id="pw" placeholder="পাসওয়ার্ড" autofocus></div>
  <button class="btn" onclick="doLogin()">প্রবেশ করুন →</button>
</div>
<script>
async function doLogin(){
  const pw=document.getElementById("pw").value;
  const r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"password="+encodeURIComponent(pw)});
  const d=await r.json();
  if(d.ok) location.href="/";
  else{const e=document.getElementById("err");e.textContent=d.msg;e.classList.add("show");}
}
document.getElementById("pw").addEventListener("keydown",e=>e.key==="Enter"&&doLogin());
</script></body></html>`;
}

function dashHTML() {
  const panelName = cfg.panelName || "BELAL Bot Panel";
  return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070710">
<link rel="manifest" href="data:application/json,${encodeURIComponent(JSON.stringify({name:panelName,short_name:"BotPanel",start_url:"/",display:"standalone",background_color:"#070710",theme_color:"#6c63ff",icons:[{src:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>",sizes:"any",type:"image/svg+xml"}]}))}" />
<title>${panelName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#070710;--surface:#0f0f1a;--card:#161625;--card2:#1c1c2e;--border:#252538;
  --text:#e2e2f0;--muted:#6b6b90;--accent:#6c63ff;--accent2:#ff6584;
  --green:#43e97b;--red:#ff5e5e;--yellow:#ffd93d;--blue:#4fc3f7;--orange:#ff9a3c
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',sans-serif;min-height:100vh;overflow-x:hidden}
/* SIDEBAR */
.sidebar{position:fixed;left:0;top:0;bottom:0;width:230px;background:var(--surface);
  border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100;transition:.3s}
.sb-logo{padding:18px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
.sb-logo .ico{width:36px;height:36px;background:linear-gradient(135deg,var(--accent),var(--accent2));
  border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.sb-logo .name{font-weight:800;font-size:14px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-logo .ver{font-size:10px;color:var(--muted)}
.sb-section{padding:14px 20px 4px;font-size:10px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:10px;padding:11px 20px;cursor:pointer;
  transition:.15s;border-left:3px solid transparent;color:var(--muted);font-size:13.5px;user-select:none}
.nav-item:hover{background:rgba(108,99,255,.08);color:var(--text)}
.nav-item.active{background:rgba(108,99,255,.12);border-left-color:var(--accent);color:var(--accent)}
.nav-item .ni{font-size:16px;width:20px;text-align:center;flex-shrink:0}
.sb-footer{margin-top:auto;padding:14px;border-top:1px solid var(--border)}
.sb-status{display:flex;align-items:center;gap:8px;padding:10px;background:var(--card);
  border-radius:10px;margin-bottom:10px;font-size:12px}
.sb-dot{width:8px;height:8px;border-radius:50%;background:var(--red);flex-shrink:0}
.sb-dot.on{background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.logout-btn{width:100%;padding:9px;border-radius:10px;border:1px solid rgba(255,94,94,.25);
  background:transparent;color:var(--red);font-size:13px;cursor:pointer;transition:.2s}
.logout-btn:hover{background:rgba(255,94,94,.08)}
/* MAIN */
.main{margin-left:230px;padding:22px;min-height:100vh}
/* HEADER */
.pg-header{margin-bottom:20px}
.pg-title{font-size:20px;font-weight:800;color:#fff}
.pg-sub{font-size:12px;color:var(--muted);margin-top:3px}
/* SECTIONS */
.section{display:none}.section.active{display:block}
/* STAT CARDS */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;transition:.2s}
.stat-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.sc-icon{font-size:24px;margin-bottom:8px}
.sc-val{font-size:22px;font-weight:800;color:#fff}
.sc-label{font-size:11px;color:var(--muted);margin-top:2px}
/* BOT STATUS BAR */
.bot-bar{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:18px}
.bot-bar-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.status-pill{display:flex;align-items:center;gap:8px;background:var(--card2);border-radius:99px;padding:8px 16px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--red);flex-shrink:0}
.dot.on{background:var(--green);box-shadow:0 0 8px var(--green);animation:blink 2s infinite}
.status-txt{font-size:14px;font-weight:700}
.bot-uptime{font-size:11px;color:var(--muted)}
.ctrl{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.cbtn{padding:9px 16px;border-radius:10px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:.2s;display:flex;align-items:center;gap:5px}
.cbtn:hover{transform:translateY(-1px);filter:brightness(1.1)}
.btn-start{background:linear-gradient(135deg,#43e97b,#38f9d7);color:#000}
.btn-stop{background:linear-gradient(135deg,#ff5e5e,#ff9a9e);color:#fff}
.btn-restart{background:linear-gradient(135deg,#ffd93d,#ff9a3c);color:#000}
.btn-install{background:linear-gradient(135deg,#4fc3f7,#6c63ff);color:#fff}
.btn-backup{background:linear-gradient(135deg,#a18cd1,#fbc2eb);color:#000}
/* AUTO RESTART TOGGLE */
.ar-row{display:flex;align-items:center;gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.toggle{position:relative;width:40px;height:22px;flex-shrink:0}
.toggle input{display:none}
.toggle-bg{position:absolute;inset:0;background:var(--border);border-radius:99px;cursor:pointer;transition:.3s}
.toggle input:checked+.toggle-bg{background:var(--green)}
.toggle-dot{position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none}
.toggle input:checked~.toggle-dot{transform:translateX(18px)}
/* LOGS */
.log-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.log-box{background:#03030a;border:1px solid var(--border);border-radius:14px;padding:14px;
  height:430px;overflow-y:auto;font-family:'Courier New',monospace;font-size:12px}
.log-box::-webkit-scrollbar{width:4px}
.log-box::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.log-entry{display:flex;gap:8px;padding:2px 0;line-height:1.65}
.lt{color:var(--muted);white-space:nowrap;flex-shrink:0;font-size:11px}
.lx{word-break:break-all}
.log-info .lx{color:#b0b8c8}
.log-success .lx{color:var(--green)}
.log-error .lx{color:var(--red)}
.log-warn .lx{color:var(--yellow)}
.log-filter-bar{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.lf-btn{padding:5px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;
  color:var(--muted);font-size:12px;cursor:pointer;transition:.15s}
.lf-btn.active,.lf-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
/* FILE MANAGER */
.fm-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.path-bar{background:var(--card);border:1px solid var(--border);border-radius:10px;
  padding:8px 14px;font-size:13px;color:var(--muted);flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden}
.pp{color:var(--accent);cursor:pointer;white-space:nowrap}.pp:hover{text-decoration:underline}
.ps{color:var(--muted)}
.tbtn{padding:8px 13px;border-radius:9px;border:1px solid var(--border);background:var(--card);
  color:var(--text);font-size:12px;cursor:pointer;transition:.15s;white-space:nowrap;display:flex;align-items:center;gap:5px}
.tbtn:hover{background:var(--border)}
.tbtn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.tbtn.primary:hover{opacity:.85}
.tbtn.danger{border-color:rgba(255,94,94,.25);color:var(--red)}
.tbtn.danger:hover{background:rgba(255,94,94,.08)}
.tbtn.success{background:var(--green);border-color:var(--green);color:#000}
/* SEARCH BAR */
.search-bar{display:flex;gap:8px;margin-bottom:12px}
.search-input{flex:1;padding:9px 14px;border-radius:10px;border:1px solid var(--border);
  background:var(--card);color:var(--text);font-size:13px;outline:none;transition:.2s}
.search-input:focus{border-color:var(--accent)}
/* FILE GRID */
.fg{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.fg-header{display:grid;grid-template-columns:1fr 80px 130px 110px;padding:9px 16px;
  border-bottom:1px solid var(--border);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.fr{display:grid;grid-template-columns:1fr 80px 130px 110px;padding:10px 16px;
  border-bottom:1px solid rgba(255,255,255,.02);cursor:pointer;transition:.12s;align-items:center}
.fr:last-child{border-bottom:none}
.fr:hover{background:rgba(108,99,255,.06)}
.fr.sel{background:rgba(108,99,255,.1)}
.fname{display:flex;align-items:center;gap:9px;font-size:13px;overflow:hidden}
.fname span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ficon{font-size:16px;flex-shrink:0;width:22px;text-align:center}
.fsize,.fdate{font-size:11px;color:var(--muted)}
.factions{display:flex;gap:3px;justify-content:flex-end;opacity:0;transition:.12s}
.fr:hover .factions{opacity:1}
.fa{padding:5px 7px;border-radius:6px;border:none;background:transparent;color:var(--muted);font-size:11px;cursor:pointer;transition:.12s}
.fa:hover{background:var(--border);color:var(--text)}
.fa.del:hover{background:rgba(255,94,94,.1);color:var(--red)}
.empty{padding:48px;text-align:center;color:var(--muted)}
.empty .eb{font-size:44px;margin-bottom:10px}
/* EDITOR */
.ed-bar{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap;background:var(--card)}
.ed-file{flex:1;font-size:13px;color:var(--accent);font-weight:700;overflow:hidden;text-overflow:ellipsis}
.ed-lang{font-size:11px;color:var(--muted);background:var(--border);padding:3px 8px;border-radius:6px}
.ed-saved{font-size:11px;color:var(--green)}
#codeEditor{width:100%;height:480px;background:#020208;border:none;border:1px solid var(--border);border-top:none;border-radius:0 0 14px 14px;
  padding:16px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:vertical;outline:none;tab-size:2}
/* UPLOAD */
.upload-zone{border:2px dashed var(--border);border-radius:16px;padding:52px 24px;
  text-align:center;cursor:pointer;transition:.3s;background:var(--card)}
.upload-zone:hover,.upload-zone.drag{border-color:var(--accent);background:rgba(108,99,255,.05)}
.uz-icon{font-size:56px;margin-bottom:16px}
.prog-wrap{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-top:16px;display:none}
.prog-top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px}
.prog-bg{background:var(--border);border-radius:99px;height:8px;overflow:hidden}
.prog{height:100%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:99px;transition:width .2s;width:0}
/* STATS CHART */
.history-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}
.history-item{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--card);border-radius:10px;border:1px solid var(--border);font-size:12px}
.history-item .hi-date{color:var(--muted);white-space:nowrap}
.history-item .hi-up{color:var(--green);font-weight:700}
.history-item .hi-code{margin-left:auto;color:var(--yellow)}
/* SETTINGS */
.settings-grid{display:grid;gap:14px}
.setting-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px}
.setting-title{font-size:13px;font-weight:700;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.setting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.setting-row:last-child{border-bottom:none;padding-bottom:0}
.sr-label{font-size:13px;color:var(--text)}
.sr-sub{font-size:11px;color:var(--muted);margin-top:2px}
.s-input{padding:8px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;outline:none;transition:.2s}
.s-input:focus{border-color:var(--accent)}
.theme-btns{display:flex;gap:6px}
.theme-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:12px;cursor:pointer;transition:.15s}
.theme-btn.active{border-color:var(--accent);color:var(--accent)}
/* MODAL */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:500;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
.modal-bg.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px;width:90%;max-width:460px;animation:mIn .2s ease}
@keyframes mIn{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}
.modal h3{font-size:16px;font-weight:800;margin-bottom:18px;color:#fff}
.modal input,.modal select,.modal textarea{width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px;outline:none;margin-bottom:12px;transition:.2s}
.modal input:focus,.modal select:focus{border-color:var(--accent)}
.modal-btns{display:flex;gap:8px;justify-content:flex-end}
/* TOAST */
.toast-wrap{position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:999;pointer-events:none}
.toast{background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:12px 16px;
  font-size:13px;display:flex;align-items:center;gap:8px;animation:tIn .3s ease;min-width:200px;max-width:300px;
  box-shadow:0 8px 32px rgba(0,0,0,.5);pointer-events:auto}
@keyframes tIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
.toast.success{border-color:rgba(67,233,123,.25);color:var(--green)}
.toast.error{border-color:rgba(255,94,94,.25);color:var(--red)}
.toast.warn{border-color:rgba(255,217,61,.25);color:var(--yellow)}
/* MOBILE */
.ham{display:none;position:fixed;top:12px;left:12px;z-index:200;background:var(--surface);
  border:1px solid var(--border);border-radius:10px;padding:8px 10px;cursor:pointer;font-size:17px}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .main{margin-left:0;padding:14px;padding-top:56px}
  .ham{display:block}
  .fg-header,.fsize,.fdate{display:none}
  .fr{grid-template-columns:1fr 110px}
  .stat-grid{grid-template-columns:repeat(2,1fr)}
  .ctrl{margin-left:0;width:100%}
}
</style></head><body>

<button class="ham" onclick="toggleSB()">☰</button>

<div class="sidebar" id="sb">
  <div class="sb-logo">
    <div class="ico">🤖</div>
    <div><div class="name" id="panelNameDisplay">${panelName}</div><div class="ver">v2.0 Pro</div></div>
  </div>
  <div class="sb-section">মনিটর</div>
  <div class="nav-item active" onclick="nav('dashboard')"><span class="ni">📊</span> Dashboard</div>
  <div class="nav-item" onclick="nav('logs')"><span class="ni">📋</span> Live Logs</div>
  <div class="nav-item" onclick="nav('stats')"><span class="ni">📈</span> Statistics</div>
  <div class="sb-section">ফাইল</div>
  <div class="nav-item" onclick="nav('files')"><span class="ni">📁</span> File Manager</div>
  <div class="nav-item" onclick="nav('upload')"><span class="ni">⬆️</span> আপলোড</div>
  <div class="nav-item" onclick="nav('search')"><span class="ni">🔍</span> ফাইল খোঁজা</div>
  <div class="sb-section">কনফিগ</div>
  <div class="nav-item" onclick="nav('env')"><span class="ni">⚙️</span> Environment</div>
  <div class="nav-item" onclick="nav('settings')"><span class="ni">🔧</span> Settings</div>
  <div class="sb-footer">
    <div class="sb-status">
      <div class="sb-dot" id="sbDot"></div>
      <div style="font-size:12px;color:var(--muted)" id="sbStatus">চেক করছে...</div>
    </div>
    <button class="logout-btn" onclick="location.href='/logout'">🚪 লগআউট</button>
  </div>
</div>

<div class="main">

<!-- DASHBOARD -->
<div id="sec-dashboard" class="section active">
  <div class="pg-header"><div class="pg-title">📊 Dashboard</div><div class="pg-sub">বটের সার্বিক অবস্থা</div></div>
  <div class="stat-grid">
    <div class="stat-card"><div class="sc-icon">💾</div><div class="sc-val" id="c-mem">--</div><div class="sc-label">Memory (MB)</div></div>
    <div class="stat-card"><div class="sc-icon">⏱️</div><div class="sc-val" id="c-sup">--</div><div class="sc-label">Server Uptime</div></div>
    <div class="stat-card"><div class="sc-icon">📦</div><div class="sc-val" id="c-files">--</div><div class="sc-label">মোট ফাইল</div></div>
    <div class="stat-card"><div class="sc-icon">🚀</div><div class="sc-val" id="c-starts">--</div><div class="sc-label">মোট Start</div></div>
    <div class="stat-card"><div class="sc-icon">💥</div><div class="sc-val" id="c-crashes">--</div><div class="sc-label">Crash</div></div>
    <div class="stat-card"><div class="sc-icon">🕐</div><div class="sc-val" id="c-totup">--</div><div class="sc-label">মোট Uptime</div></div>
  </div>
  <div class="bot-bar">
    <div class="bot-bar-top">
      <div class="status-pill">
        <div class="dot" id="statusDot"></div>
        <div><div class="status-txt" id="statusTxt">চেক করছে...</div><div class="bot-uptime" id="botUp"></div></div>
      </div>
      <div class="ctrl">
        <button class="cbtn btn-start"   onclick="botAct('start')">▶ চালু</button>
        <button class="cbtn btn-stop"    onclick="botAct('stop')">⏹ বন্ধ</button>
        <button class="cbtn btn-restart" onclick="botAct('restart')">🔄 রিস্টার্ট</button>
        <button class="cbtn btn-install" onclick="npmInst()">📦 npm install</button>
        <button class="cbtn btn-backup"  onclick="doBackup()">💾 Backup</button>
      </div>
    </div>
    <div class="ar-row">
      <label class="toggle"><input type="checkbox" id="arToggle" onchange="toggleAR(this.checked)"><div class="toggle-bg"></div><div class="toggle-dot"></div></label>
      <div><div style="font-size:13px">Auto Restart</div><div style="font-size:11px;color:var(--muted)">Crash হলে অটো চালু হবে</div></div>
    </div>
  </div>
</div>

<!-- LOGS -->
<div id="sec-logs" class="section">
  <div class="pg-header"><div class="pg-title">📋 Live Logs</div><div class="pg-sub">বটের রিয়েলটাইম আউটপুট</div></div>
  <div class="log-filter-bar">
    <button class="lf-btn active" onclick="setFilter('all',this)">সব</button>
    <button class="lf-btn" onclick="setFilter('success',this)">✅ Success</button>
    <button class="lf-btn" onclick="setFilter('error',this)">❌ Error</button>
    <button class="lf-btn" onclick="setFilter('warn',this)">⚠️ Warning</button>
  </div>
  <div class="log-toolbar">
    <span style="font-size:12px;color:var(--muted)">📋 <span id="logCnt">0</span> লাইন</span>
    <button class="tbtn" onclick="toggleAS()" id="asBtn">↓ অটো স্ক্রল</button>
    <button class="tbtn" onclick="window.open('/api/bot/downloadlog')">⬇️ Download</button>
    <button class="tbtn danger" onclick="clearLogs()">🗑 মুছুন</button>
  </div>
  <div class="log-box" id="logBox"></div>
</div>

<!-- STATS -->
<div id="sec-stats" class="section">
  <div class="pg-header"><div class="pg-title">📈 Statistics</div><div class="pg-sub">বটের ইতিহাস</div></div>
  <div class="stat-grid" id="statsGrid"></div>
  <div style="margin-top:16px">
    <div style="font-size:14px;font-weight:700;margin-bottom:10px">📅 Restart ইতিহাস</div>
    <div class="history-list" id="historyList"></div>
  </div>
</div>

<!-- FILE MANAGER -->
<div id="sec-files" class="section">
  <div class="pg-header"><div class="pg-title">📁 File Manager</div><div class="pg-sub">বটের ফাইল ম্যানেজ করুন</div></div>
  <div id="edView" style="display:none">
    <div class="ed-bar">
      <button class="tbtn" onclick="closeEd()">← ফিরে যান</button>
      <span class="ed-file" id="edFile"></span>
      <span class="ed-lang" id="edLang"></span>
      <span class="ed-saved" id="edSaved" style="display:none">✓ সেভ হয়েছে</span>
      <button class="tbtn primary" onclick="saveFile()">💾 সেভ (Ctrl+S)</button>
      <button class="tbtn" onclick="downloadF(curEditPath)">⬇️</button>
    </div>
    <textarea id="codeEditor" spellcheck="false"></textarea>
  </div>
  <div id="fmView">
    <div class="fm-bar">
      <div class="path-bar" id="pathBar">📁 root</div>
      <button class="tbtn primary" onclick="showMod('mkdir')">📁+</button>
      <button class="tbtn primary" onclick="showMod('newfile')">📄+</button>
      <button class="tbtn" onclick="loadFiles(curDir)">🔄</button>
    </div>
    <div class="fg">
      <div class="fg-header"><div>নাম</div><div>সাইজ</div><div>পরিবর্তন</div><div>কাজ</div></div>
      <div id="fileList"></div>
    </div>
  </div>
</div>

<!-- UPLOAD -->
<div id="sec-upload" class="section">
  <div class="pg-header"><div class="pg-title">⬆️ আপলোড</div><div class="pg-sub">ZIP সহ যেকোনো ফাইল</div></div>
  <div class="upload-zone" id="uzOne" onclick="document.getElementById('fInput').click()">
    <div class="uz-icon">📦</div>
    <h3 style="font-size:16px;font-weight:700;margin-bottom:6px">ক্লিক করুন বা ড্র্যাগ করুন</h3>
    <p style="color:var(--muted);font-size:13px">ZIP আপলোড করলে অটো extract হবে</p>
    <p style="color:var(--blue);font-size:12px;margin-top:6px">সর্বোচ্চ ৫০০MB সাপোর্ট</p>
  </div>
  <input type="file" id="fInput" style="display:none" onchange="uploadF(this.files[0])">
  <div class="prog-wrap" id="progWrap">
    <div class="prog-top"><span id="upFN">আপলোড হচ্ছে...</span><span id="upPct">0%</span></div>
    <div class="prog-bg"><div class="prog" id="progBar"></div></div>
    <div id="upSt" style="font-size:12px;color:var(--muted);margin-top:6px"></div>
  </div>
</div>

<!-- SEARCH -->
<div id="sec-search" class="section">
  <div class="pg-header"><div class="pg-title">🔍 ফাইল খোঁজা</div><div class="pg-sub">নাম বা কন্টেন্ট দিয়ে সার্চ করুন</div></div>
  <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
    <button class="tbtn primary" id="searchModeBtn" onclick="switchSearchMode('name')">📄 নাম দিয়ে</button>
    <button class="tbtn" id="grepModeBtn" onclick="switchSearchMode('grep')">🔤 কন্টেন্ট দিয়ে</button>
  </div>
  <div class="search-bar">
    <input class="search-input" type="text" id="searchQ" placeholder="খোঁজুন..." oninput="doSearch()">
  </div>
  <div id="searchResults"></div>
</div>

<!-- ENV -->
<div id="sec-env" class="section">
  <div class="pg-header"><div class="pg-title">⚙️ Environment</div><div class="pg-sub">বটের .env ফাইল</div></div>
  <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
    <button class="tbtn primary" onclick="saveEnv()">💾 সেভ</button>
    <button class="tbtn" onclick="loadEnv()">🔄 রিলোড</button>
    <button class="tbtn" onclick="addEnvLine()">➕ নতুন লাইন</button>
  </div>
  <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden">
    <textarea id="envEditor" spellcheck="false" style="width:100%;height:380px;background:#020208;border:none;padding:16px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:vertical;outline:none" placeholder="TOKEN=your_token&#10;COOKIE=your_cookie&#10;PREFIX=!&#10;ADMIN_ID=123456"></textarea>
  </div>
  <div style="margin-top:10px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;font-size:12px;color:var(--muted)">
    💡 প্রতি লাইনে: <code style="color:var(--accent)">KEY=VALUE</code> &nbsp;|&nbsp; # দিয়ে comment করুন
  </div>
</div>

<!-- SETTINGS -->
<div id="sec-settings" class="section">
  <div class="pg-header"><div class="pg-title">🔧 Settings</div><div class="pg-sub">Panel কাস্টমাইজ করুন</div></div>
  <div class="settings-grid">
    <div class="setting-card">
      <div class="setting-title">🎨 Panel সেটিংস</div>
      <div class="setting-row">
        <div><div class="sr-label">Panel এর নাম</div><div class="sr-sub">Sidebar এ দেখাবে</div></div>
        <input class="s-input" type="text" id="sName" placeholder="Bot Panel">
      </div>
      <div class="setting-row">
        <div><div class="sr-label">Theme</div><div class="sr-sub">রঙ পরিবর্তন করুন</div></div>
        <div class="theme-btns">
          <button class="theme-btn active" onclick="setTheme('default',this)">Default</button>
          <button class="theme-btn" onclick="setTheme('blue',this)">Blue</button>
          <button class="theme-btn" onclick="setTheme('green',this)">Green</button>
          <button class="theme-btn" onclick="setTheme('red',this)">Red</button>
        </div>
      </div>
      <div style="margin-top:12px"><button class="tbtn primary" onclick="saveSettings()">💾 Settings সেভ</button></div>
    </div>
    <div class="setting-card">
      <div class="setting-title">🤖 Bot সেটিংস</div>
      <div class="setting-row">
        <div><div class="sr-label">Auto Restart</div><div class="sr-sub">Crash হলে অটো চালু</div></div>
        <label class="toggle"><input type="checkbox" id="sAR" onchange="toggleAR(this.checked)"><div class="toggle-bg"></div><div class="toggle-dot"></div></label>
      </div>
      <div class="setting-row">
        <div><div class="sr-label">Auto Backup</div><div class="sr-sub">Save করলে .bak রাখবে</div></div>
        <label class="toggle"><input type="checkbox" id="sABak"><div class="toggle-bg"></div><div class="toggle-dot"></div></label>
      </div>
      <div class="setting-row">
        <div><div class="sr-label">Schedule Restart</div><div class="sr-sub">প্রতিদিন নির্দিষ্ট সময়ে</div></div>
        <label class="toggle"><input type="checkbox" id="sSched"><div class="toggle-bg"></div><div class="toggle-dot"></div></label>
      </div>
      <div class="setting-row">
        <div><div class="sr-label">Restart সময়</div><div class="sr-sub">24 ঘণ্টা format</div></div>
        <input class="s-input" type="time" id="sSchedTime" value="03:00">
      </div>
      <div style="margin-top:12px"><button class="tbtn primary" onclick="saveBotSettings()">💾 সেভ</button></div>
    </div>
    <div class="setting-card">
      <div class="setting-title">🔐 পাসওয়ার্ড পরিবর্তন</div>
      <div class="setting-row">
        <div class="sr-label">বর্তমান পাসওয়ার্ড</div>
        <input class="s-input" type="password" id="sCurPw" placeholder="বর্তমান পাসওয়ার্ড">
      </div>
      <div class="setting-row">
        <div class="sr-label">নতুন পাসওয়ার্ড</div>
        <input class="s-input" type="password" id="sNewPw" placeholder="নতুন পাসওয়ার্ড">
      </div>
      <div style="margin-top:12px"><button class="tbtn primary" onclick="changePw()">🔐 পরিবর্তন করুন</button></div>
    </div>
    <div class="setting-card">
      <div class="setting-title">🛠️ Maintenance</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="tbtn" onclick="doBackup()">💾 Full Backup</button>
        <button class="tbtn danger" onclick="clearLogFile()">🗑 Log File মুছুন</button>
      </div>
    </div>
  </div>
</div>

</div><!-- /main -->

<!-- MODALS -->
<div class="modal-bg" id="mod-mkdir">
  <div class="modal"><h3>📁 নতুন ফোল্ডার</h3>
    <input type="text" id="mkN" placeholder="ফোল্ডারের নাম">
    <div class="modal-btns"><button class="tbtn" onclick="closeMod('mkdir')">বাতিল</button><button class="tbtn primary" onclick="doMkdir()">তৈরি</button></div>
  </div>
</div>
<div class="modal-bg" id="mod-newfile">
  <div class="modal"><h3>📄 নতুন ফাইল</h3>
    <input type="text" id="nfN" placeholder="ফাইলের নাম (test.js)">
    <div class="modal-btns"><button class="tbtn" onclick="closeMod('newfile')">বাতিল</button><button class="tbtn primary" onclick="doNewFile()">তৈরি</button></div>
  </div>
</div>
<div class="modal-bg" id="mod-rename">
  <div class="modal"><h3>✏️ নাম পরিবর্তন</h3>
    <input type="text" id="rnV" placeholder="নতুন নাম">
    <div class="modal-btns"><button class="tbtn" onclick="closeMod('rename')">বাতিল</button><button class="tbtn primary" onclick="doRename()">পরিবর্তন</button></div>
  </div>
</div>
<div class="modal-bg" id="mod-copy">
  <div class="modal"><h3>📋 Copy করুন</h3>
    <input type="text" id="cpTo" placeholder="কোথায় copy করবেন (path)">
    <div class="modal-btns"><button class="tbtn" onclick="closeMod('copy')">বাতিল</button><button class="tbtn primary" onclick="doCopy()">Copy</button></div>
  </div>
</div>

<div class="toast-wrap" id="toastWrap"></div>

<script>
// STATE
let curDir="", curEditPath="", renameFrom="", copyFrom="";
let autoScroll=true, logFilter="all", searchMode="name";
let ws, refreshInterval;

// SIDEBAR
function toggleSB(){document.getElementById("sb").classList.toggle("open")}
function nav(id){
  document.querySelectorAll(".nav-item").forEach((n,i)=>n.classList.toggle("active",["dashboard","logs","stats","files","upload","search","env","settings"][i]===id));
  document.querySelectorAll(".section").forEach(s=>s.classList.remove("active"));
  document.getElementById("sec-"+id).classList.add("active");
  document.getElementById("sb").classList.remove("open");
  if(id==="files") loadFiles(curDir);
  if(id==="env")   loadEnv();
  if(id==="stats") loadStats();
  if(id==="settings") loadSettings();
}

// WS
function connectWS(){
  const proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(proto+"://"+location.host);
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==="log")      appendLog(m.data);
    if(m.type==="logs")     {document.getElementById("logBox").innerHTML="";m.data.forEach(appendLog);}
    if(m.type==="status")   updateStatus(m.running);
    if(m.type==="clearLogs"){document.getElementById("logBox").innerHTML="";document.getElementById("logCnt").textContent="0";}
  };
  ws.onclose=()=>setTimeout(connectWS,3000);
}

function appendLog(e){
  if(logFilter!=="all"&&e.type!==logFilter) return;
  const box=document.getElementById("logBox");
  const d=document.createElement("div");
  d.className="log-entry log-"+(e.type||"info");
  d.dataset.type=e.type||"info";
  d.innerHTML='<span class="lt">'+e.time+'</span><span class="lx">'+esc(e.text)+'</span>';
  box.appendChild(d);
  const c=document.getElementById("logCnt");
  if(c) c.textContent=box.children.length;
  if(autoScroll) box.scrollTop=box.scrollHeight;
}

function esc(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

function setFilter(f,btn){
  logFilter=f;
  document.querySelectorAll(".lf-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  const box=document.getElementById("logBox");
  box.querySelectorAll(".log-entry").forEach(el=>{
    el.style.display=(f==="all"||el.dataset.type===f)?"flex":"none";
  });
}

function clearLogs(){fetch("/api/bot/clearlogs",{method:"POST"});}
function toggleAS(){autoScroll=!autoScroll;document.getElementById("asBtn").textContent=autoScroll?"↓ অটো স্ক্রল":"↕ ম্যানুয়াল";}
function clearLogFile(){if(!confirm("Log file মুছবেন?"))return;fetch("/api/bot/clearlogfile",{method:"POST"}).then(r=>r.json()).then(d=>toast(d.ok?"✅ Log file মুছা হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error"));}

// STATUS
function updateStatus(running){
  document.querySelectorAll(".dot").forEach(d=>d.className="dot"+(running?" on":""));
  document.getElementById("statusTxt").textContent=running?"✅ বট চলছে":"🔴 বট বন্ধ";
  document.getElementById("sbStatus").textContent=running?"✅ চলছে":"🔴 বন্ধ";
  document.getElementById("sbDot").className="sb-dot"+(running?" on":"");
}

function fmtT(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return h>0?h+"h "+m+"m":m>0?m+"m "+sc+"s":sc+"s";}

async function refreshDash(){
  const [st,bs]=await Promise.all([fetch("/api/stats").then(r=>r.json()),fetch("/api/bot/status").then(r=>r.json())]);
  document.getElementById("c-mem").textContent=st.memMB;
  document.getElementById("c-sup").textContent=fmtT(st.serverUptime);
  document.getElementById("c-files").textContent=st.botFiles;
  document.getElementById("c-starts").textContent=st.starts||0;
  document.getElementById("c-crashes").textContent=st.crashes||0;
  document.getElementById("c-totup").textContent=fmtT((st.totalUptime||0)+(bs.uptime||0));
  updateStatus(bs.running);
  if(bs.running&&bs.uptime>0){
    document.getElementById("botUp").textContent="চলছে: "+fmtT(bs.uptime);
  } else document.getElementById("botUp").textContent="";
  const ar=document.getElementById("arToggle");
  if(ar) ar.checked=st.autoRestart;
  const sar=document.getElementById("sAR");
  if(sar) sar.checked=st.autoRestart;
}

// BOT ACTIONS
async function botAct(action){
  toast("⏳ "+action+"...","warn");
  const d=await fetch("/api/bot/"+action,{method:"POST"}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
}

async function npmInst(){
  toast("📦 npm install শুরু...","warn");
  const d=await fetch("/api/bot/install",{method:"POST"}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
}

function doBackup(){window.open("/api/backup");}

async function toggleAR(v){
  await fetch("/api/bot/autorestart",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:v})});
  toast(v?"✅ Auto Restart চালু":"⚠️ Auto Restart বন্ধ",v?"success":"warn");
  const ar1=document.getElementById("arToggle"), ar2=document.getElementById("sAR");
  if(ar1) ar1.checked=v; if(ar2) ar2.checked=v;
}

// FILE MANAGER
function ficon(name,isDir){
  if(isDir) return "📁";
  const ext=name.split(".").pop().toLowerCase();
  return {js:"📜",mjs:"📜",cjs:"📜",json:"📋",md:"📝",txt:"📄",env:"🔐",log:"📋",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",mp3:"🎵",mp4:"🎬",zip:"📦",html:"🌐",css:"🎨",ts:"📘",py:"🐍",sh:"⚡",xml:"📋",yml:"⚙️",yaml:"⚙️",lock:"🔒"}[ext]||"📄";
}

function fsz(b){if(!b)return"—";if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB";}
function fdt(d){return new Date(d).toLocaleDateString("bn-BD",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}

function buildPath(dir){
  const bar=document.getElementById("pathBar");
  const parts=dir?dir.split("/"):[];
  let html='<span class="pp" onclick="loadFiles(\\'\\')">📁 root</span>';
  let acc="";
  parts.forEach(p=>{acc+=(acc?"/":"")+p;const c=acc;html+='<span class="ps"> / </span><span class="pp" onclick="loadFiles(\\''+c+'\\')">'+p+'</span>';});
  bar.innerHTML=html;
}

async function loadFiles(dir){
  curDir=dir||"";buildPath(curDir);
  document.getElementById("fmView").style.display="block";
  document.getElementById("edView").style.display="none";
  const data=await fetch("/api/files?path="+encodeURIComponent(curDir)).then(r=>r.json());
  const list=document.getElementById("fileList");
  list.innerHTML="";
  if(curDir){
    const up=document.createElement("div");up.className="fr";
    up.innerHTML='<div class="fname"><span class="ficon">⬆️</span><span>.. উপরে</span></div><div></div><div></div><div></div>';
    up.onclick=()=>loadFiles(curDir.split("/").slice(0,-1).join("/"));
    list.appendChild(up);
  }
  if(!data.items?.length){list.innerHTML='<div class="empty"><div class="eb">📭</div><div>ফোল্ডার খালি</div></div>';return;}
  data.items.forEach(item=>{
    const fp=curDir?curDir+"/"+item.name:item.name;
    const row=document.createElement("div");row.className="fr";
    row.innerHTML='<div class="fname"><span class="ficon">'+ficon(item.name,item.isDir)+'</span><span>'+item.name+'</span></div>'
      +'<div class="fsize">'+fsz(item.size)+'</div>'
      +'<div class="fdate">'+fdt(item.mtime)+'</div>'
      +'<div class="factions">'
      +(item.isDir?'':'<button class="fa" onclick="event.stopPropagation();editF(\\''+fp+'\\')">✏️</button>')
      +'<button class="fa" onclick="event.stopPropagation();downloadF(\\''+fp+'\\')">⬇️</button>'
      +'<button class="fa" onclick="event.stopPropagation();showRename(\\''+fp+'\\',\\''+item.name+'\\')">🔤</button>'
      +'<button class="fa" onclick="event.stopPropagation();showCopy(\\''+fp+'\\')">📋</button>'
      +'<button class="fa del" onclick="event.stopPropagation();delItem(\\''+fp+'\\',\\''+item.name+'\\')">🗑</button>'
      +'</div>';
    if(item.isDir) row.onclick=()=>loadFiles(fp);
    else row.onclick=()=>editF(fp);
    list.appendChild(row);
  });
}

function langExt(n){const e=n.split(".").pop().toLowerCase();return{js:"JavaScript",json:"JSON",md:"Markdown",html:"HTML",css:"CSS",py:"Python",ts:"TypeScript",sh:"Shell",env:"ENV",txt:"Text",yml:"YAML",xml:"XML"}[e]||e.toUpperCase();}

async function editF(p){
  const d=await fetch("/api/file/read?path="+encodeURIComponent(p)).then(r=>r.json());
  if(d.error) return toast("❌ "+d.error,"error");
  curEditPath=p;
  document.getElementById("edFile").textContent=p;
  document.getElementById("edLang").textContent=langExt(p);
  document.getElementById("edSaved").style.display="none";
  document.getElementById("codeEditor").value=d.content;
  document.getElementById("fmView").style.display="none";
  document.getElementById("edView").style.display="block";
}

function closeEd(){document.getElementById("edView").style.display="none";document.getElementById("fmView").style.display="block";}

async function saveFile(){
  const content=document.getElementById("codeEditor").value;
  const d=await fetch("/api/file/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:curEditPath,content})}).then(r=>r.json());
  if(d.ok){const s=document.getElementById("edSaved");s.style.display="inline";setTimeout(()=>s.style.display="none",2500);}
  toast(d.ok?"✅ সেভ হয়েছে":"❌ "+d.error,d.ok?"success":"error");
}

function downloadF(p){window.open("/api/file/download?path="+encodeURIComponent(p));}

async function delItem(p,name){
  if(!confirm('"'+name+'" ডিলিট করবেন?'))return;
  const d=await fetch("/api/file/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})}).then(r=>r.json());
  toast(d.ok?"🗑 ডিলিট হয়েছে":"❌ "+d.error,d.ok?"success":"error");
  if(d.ok) loadFiles(curDir);
}

// MODALS
function showMod(id){document.getElementById("mod-"+id).classList.add("open");setTimeout(()=>document.querySelector("#mod-"+id+" input")?.focus(),50);}
function closeMod(id){document.getElementById("mod-"+id).classList.remove("open");}

async function doMkdir(){
  const n=document.getElementById("mkN").value.trim();if(!n)return;
  const fp=curDir?curDir+"/"+n:n;
  const d=await fetch("/api/file/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp})}).then(r=>r.json());
  closeMod("mkdir");toast(d.ok?"📁 তৈরি হয়েছে":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);
}

async function doNewFile(){
  const n=document.getElementById("nfN").value.trim();if(!n)return;
  const fp=curDir?curDir+"/"+n:n;
  const d=await fetch("/api/file/newfile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp,content:""})}).then(r=>r.json());
  closeMod("newfile");if(d.ok){toast("📄 তৈরি হয়েছে","success");nav("files");editF(fp);}else toast("❌ "+d.error,"error");
}

function showRename(p,name){renameFrom=p;document.getElementById("rnV").value=name;showMod("rename");}
async function doRename(){
  const n=document.getElementById("rnV").value.trim();if(!n)return;
  const dir=renameFrom.includes("/")?renameFrom.split("/").slice(0,-1).join("/"):"";
  const to=dir?dir+"/"+n:n;
  const d=await fetch("/api/file/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:renameFrom,to})}).then(r=>r.json());
  closeMod("rename");toast(d.ok?"✅ নাম পরিবর্তন":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);
}

function showCopy(p){copyFrom=p;document.getElementById("cpTo").value=p+"_copy";showMod("copy");}
async function doCopy(){
  const to=document.getElementById("cpTo").value.trim();if(!to)return;
  const d=await fetch("/api/file/copy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:copyFrom,to})}).then(r=>r.json());
  closeMod("copy");toast(d.ok?"📋 Copy হয়েছে":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);
}

// UPLOAD
async function uploadF(file){
  if(!file)return;
  const pw=document.getElementById("progWrap"),pb=document.getElementById("progBar"),
        pp=document.getElementById("upPct"),ps=document.getElementById("upSt"),fn=document.getElementById("upFN");
  pw.style.display="block";fn.textContent=file.name;pb.style.width="0%";pp.textContent="0%";ps.textContent="আপলোড হচ্ছে...";
  const fd=new FormData();fd.append("file",file);fd.append("path",curDir||"");
  const xhr=new XMLHttpRequest();xhr.open("POST","/api/file/upload");
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);pb.style.width=p+"%";pp.textContent=p+"%";ps.textContent=fsz(e.loaded)+" / "+fsz(e.total);}};
  xhr.onload=()=>{
    const d=JSON.parse(xhr.responseText);
    if(d.ok){pb.style.width="100%";pp.textContent="100%";ps.innerHTML='<span style="color:var(--green)">✅ '+(d.msg||"সম্পন্ন")+'</span>';toast("✅ "+(d.msg||"আপলোড সম্পন্ন"),"success");}
    else{ps.innerHTML='<span style="color:var(--red)">❌ '+d.error+'</span>';toast("❌ "+d.error,"error");}
    document.getElementById("fInput").value="";
  };
  xhr.onerror=()=>{ps.innerHTML='<span style="color:var(--red)">❌ নেটওয়ার্ক সমস্যা</span>';};
  xhr.send(fd);
}
const uz=document.getElementById("uzOne");
uz.addEventListener("dragover",e=>{e.preventDefault();uz.classList.add("drag");});
uz.addEventListener("dragleave",()=>uz.classList.remove("drag"));
uz.addEventListener("drop",e=>{e.preventDefault();uz.classList.remove("drag");uploadF(e.dataTransfer.files[0]);});

// SEARCH
function switchSearchMode(m){
  searchMode=m;
  document.getElementById("searchModeBtn").className="tbtn"+(m==="name"?" primary":"");
  document.getElementById("grepModeBtn").className="tbtn"+(m==="grep"?" primary":"");
  doSearch();
}
let searchTimeout;
function doSearch(){clearTimeout(searchTimeout);searchTimeout=setTimeout(async()=>{
  const q=document.getElementById("searchQ").value.trim();
  if(!q){document.getElementById("searchResults").innerHTML="";return;}
  const url=searchMode==="name"?"/api/file/search?q="+encodeURIComponent(q):"/api/file/grep?q="+encodeURIComponent(q);
  const d=await fetch(url).then(r=>r.json());
  const res=d.results||[];
  if(!res.length){document.getElementById("searchResults").innerHTML='<div style="padding:24px;text-align:center;color:var(--muted)">📭 কিছু পাওয়া যায়নি</div>';return;}
  document.getElementById("searchResults").innerHTML=res.map(r=>
    searchMode==="name"
      ?'<div class="fr" onclick="'+(r.isDir?"loadFiles('"+r.path+"')":"editF('"+r.path+"')")+'"><div class="fname"><span class="ficon">'+ficon(r.name,r.isDir)+'</span><span>'+r.path+'</span></div><div class="fsize">'+fsz(r.size)+'</div><div></div><div></div></div>'
      :'<div class="fr" onclick="editF(\''+r.file+'\')"><div class="fname" style="flex-direction:column;align-items:flex-start;gap:2px"><span style="color:var(--accent);font-size:12px">'+r.file+':'+r.line+'</span><span style="font-size:12px;color:var(--muted)">'+esc(r.content.substring(0,80))+'</span></div><div></div><div></div><div></div></div>'
  ).join("");
},300);}

// ENV
async function loadEnv(){const d=await fetch("/api/env").then(r=>r.json());document.getElementById("envEditor").value=d.content||"";}
async function saveEnv(){
  const content=document.getElementById("envEditor").value;
  const d=await fetch("/api/env/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content})}).then(r=>r.json());
  toast(d.ok?"✅ .env সেভ হয়েছে":"❌ "+d.msg,d.ok?"success":"error");
}
function addEnvLine(){const t=document.getElementById("envEditor");t.value+=(t.value&&!t.value.endsWith("\n")?"\n":"")+"KEY=VALUE";t.focus();}

// STATS
async function loadStats(){
  const d=await fetch("/api/stats").then(r=>r.json());
  document.getElementById("statsGrid").innerHTML=[
    {icon:"🚀",val:d.starts||0,label:"মোট Start"},
    {icon:"💥",val:d.crashes||0,label:"Crash"},
    {icon:"⏱️",val:fmtT(d.totalUptime||0),label:"মোট Uptime"},
    {icon:"💾",val:d.memMB+"MB",label:"Memory"},
    {icon:"📦",val:d.botFiles,label:"ফাইল"},
    {icon:"🖥️",val:d.node,label:"Node.js"}
  ].map(c=>'<div class="stat-card"><div class="sc-icon">'+c.icon+'</div><div class="sc-val">'+c.val+'</div><div class="sc-label">'+c.label+'</div></div>').join("");
  const hist=d.history||[];
  document.getElementById("historyList").innerHTML=hist.length?[...hist].reverse().slice(0,20).map(h=>
    '<div class="history-item"><div class="hi-date">'+new Date(h.date).toLocaleString("bn-BD")+'</div><div class="hi-up">'+fmtT(h.uptime)+'</div><div class="hi-code">code:'+h.code+'</div></div>'
  ).join(""):'<div style="padding:20px;text-align:center;color:var(--muted)">ইতিহাস নেই</div>';
}

// SETTINGS
async function loadSettings(){
  const d=await fetch("/api/settings").then(r=>r.json());
  document.getElementById("sName").value=d.panelName||"";
  document.getElementById("sAR").checked=d.autoRestart||false;
  document.getElementById("sABak").checked=d.autoBackup!==false;
  document.getElementById("sSched").checked=d.scheduleRestart||false;
  document.getElementById("sSchedTime").value=d.scheduleTime||"03:00";
}
async function saveSettings(){
  const name=document.getElementById("sName").value.trim();
  const d=await fetch("/api/settings/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({panelName:name})}).then(r=>r.json());
  if(d.ok&&name) document.getElementById("panelNameDisplay").textContent=name;
  toast(d.ok?"✅ Settings সেভ":"❌ ব্যর্থ",d.ok?"success":"error");
}
async function saveBotSettings(){
  const body={autoRestart:document.getElementById("sAR").checked,autoBackup:document.getElementById("sABak").checked,scheduleRestart:document.getElementById("sSched").checked,scheduleTime:document.getElementById("sSchedTime").value};
  const d=await fetch("/api/settings/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
  toast(d.ok?"✅ সেভ হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error");
}
async function changePw(){
  const current=document.getElementById("sCurPw").value, newPass=document.getElementById("sNewPw").value;
  const d=await fetch("/api/settings/password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current,newPass})}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
  if(d.ok){document.getElementById("sCurPw").value="";document.getElementById("sNewPw").value="";}
}

function setTheme(t,btn){
  document.querySelectorAll(".theme-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  const themes={default:{accent:"#6c63ff"},blue:{accent:"#4fc3f7"},green:{accent:"#43e97b"},red:{accent:"#ff5e5e"}};
  if(themes[t]) document.documentElement.style.setProperty("--accent",themes[t].accent);
}

// TOAST
function toast(msg,type="success"){
  const w=document.getElementById("toastWrap"),el=document.createElement("div");
  el.className="toast "+type;el.textContent=msg;w.appendChild(el);
  setTimeout(()=>{el.style.opacity="0";el.style.transform="translateX(120%)";el.style.transition=".3s";setTimeout(()=>el.remove(),300);},3500);
}

// KEYBOARD
document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==="s"&&curEditPath){e.preventDefault();saveFile();}
  if(e.key==="Escape") document.querySelectorAll(".modal-bg.open").forEach(m=>m.classList.remove("open"));
});

// INIT
connectWS();
refreshDash();
refreshInterval=setInterval(refreshDash,10000);
</script>
</body></html>`;
}
