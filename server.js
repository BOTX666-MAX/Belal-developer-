const express = require("express");
const session = require("express-session");
const multer  = require("multer");
const http    = require("http");
const WebSocket = require("ws");
const fs      = require("fs");
const path    = require("path");
const { spawn, execSync } = require("child_process");
const archiver  = require("archiver");
const unzipper  = require("unzipper");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const CFG_FILE = path.join(__dirname, "panel.config.json");
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE,"utf8")); } catch { return {}; } }
function saveCfg(o) { fs.writeFileSync(CFG_FILE, JSON.stringify(o,null,2)); }
let cfg = loadCfg();

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || cfg.password || "admin123";
const BOT_DIR  = path.join(__dirname, "bot");
const LOG_FILE = path.join(__dirname, "panel.log");
const STATS_FILE = path.join(__dirname, "stats.json");
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR, { recursive: true });

function loadStats() { try { return JSON.parse(fs.readFileSync(STATS_FILE,"utf8")); } catch { return { starts:0, crashes:0, totalUptime:0, history:[], loginAttempts:{} }; } }
function saveStats(s) { try { fs.writeFileSync(STATS_FILE, JSON.stringify(s,null,2)); } catch {} }
let stats = loadStats();

app.use(express.json({ limit:"500mb" }));
app.use(express.urlencoded({ extended:true, limit:"500mb" }));
app.use(session({ secret: process.env.SESSION_SECRET || "belal_2024", resave:false, saveUninitialized:false, cookie:{ maxAge:7*24*60*60*1000 } }));

const storage = multer.diskStorage({ destination:(req,file,cb)=>cb(null,"/tmp/"), filename:(req,file,cb)=>cb(null,Date.now()+"_"+file.originalname) });
const upload = multer({ storage, limits:{ fileSize:500*1024*1024 } });

function auth(req,res,next) { if (req.session.loggedIn) return next(); res.redirect("/login"); }
function safeJoin(base,rel) { const f=path.resolve(base,rel||""); if (!f.startsWith(path.resolve(base))) throw new Error("Access denied"); return f; }

let botProcess=null, botLogs=[], botStartTime=null, autoRestart=cfg.autoRestart||false, restartTimer=null;
const MAX_LOGS=2000;

function broadcast(data) { wss.clients.forEach(c=>{ if(c.readyState===WebSocket.OPEN) c.send(JSON.stringify(data)); }); }

function addLog(text,type="info") {
  const entry={ time:new Date().toLocaleTimeString("bn-BD"), text, type, ts:Date.now() };
  botLogs.push(entry); if(botLogs.length>MAX_LOGS) botLogs.shift();
  broadcast({ type:"log", data:entry });
  try { fs.appendFileSync(LOG_FILE, `[${entry.time}] [${type}] ${text}\n`); } catch {}
}

function fmtSec(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60; return h>0?h+"h "+m+"m":m>0?m+"m "+sc+"s":sc+"s"; }

function startBot(reason="manual") {
  if (botProcess) return { ok:false, msg:"বট ইতিমধ্যে চলছে" };
  const idx=["index.js","app.js","main.js","bot.js","start.js"].find(f=>fs.existsSync(path.join(BOT_DIR,f)));
  if (!idx) return { ok:false, msg:"index.js পাওয়া যায়নি — বট আপলোড করুন" };
  if (!fs.existsSync(path.join(BOT_DIR,"node_modules"))) {
    try { addLog("📦 npm install চলছে...","warn"); execSync("npm install",{cwd:BOT_DIR,timeout:120000}); addLog("✅ npm install সম্পন্ন","success"); }
    catch(e) { addLog("⚠️ npm install সমস্যা: "+e.message,"error"); }
  }
  botProcess=spawn("node",[idx],{cwd:BOT_DIR,env:{...process.env,FORCE_COLOR:"1"}});
  botStartTime=Date.now(); stats.starts++; saveStats(stats);
  addLog(`🟢 বট চালু (${reason}) — ${idx}`,"success");
  broadcast({type:"status",running:true});
  botProcess.stdout.on("data",d=>addLog(d.toString().trim(),"info"));
  botProcess.stderr.on("data",d=>addLog(d.toString().trim(),"error"));
  botProcess.on("exit",(code,signal)=>{
    const up=botStartTime?Math.floor((Date.now()-botStartTime)/1000):0;
    stats.totalUptime+=up; stats.history.push({date:new Date().toISOString(),uptime:up,code});
    if(stats.history.length>50) stats.history.shift();
    if(code!==0&&code!==null) stats.crashes++;
    saveStats(stats);
    addLog(`🔴 বট বন্ধ (code:${code||signal}, uptime:${fmtSec(up)})`,"error");
    botProcess=null; botStartTime=null; broadcast({type:"status",running:false});
    if(autoRestart&&code!==0&&code!==null) { addLog("🔄 Auto-restart: ১০ সেকেন্ড পরে...","warn"); restartTimer=setTimeout(()=>startBot("auto-restart"),10000); }
  });
  return { ok:true, msg:"বট চালু হয়েছে" };
}

function stopBot() {
  if(restartTimer){clearTimeout(restartTimer);restartTimer=null;}
  if(!botProcess) return {ok:false,msg:"বট চলছে না"};
  botProcess.kill("SIGTERM"); botProcess=null; botStartTime=null;
  addLog("🔴 বট বন্ধ করা হয়েছে","warn"); broadcast({type:"status",running:false});
  return {ok:true,msg:"বট বন্ধ হয়েছে"};
}

// AUTH
app.get("/login",(req,res)=>{ if(req.session.loggedIn) return res.redirect("/"); res.send(loginHTML()); });
app.post("/login",(req,res)=>{
  if(req.body.password===PANEL_PASSWORD){ req.session.loggedIn=true; res.json({ok:true}); }
  else res.json({ok:false,msg:"❌ ভুল পাসওয়ার্ড"});
});
app.get("/logout",(req,res)=>{ req.session.destroy(); res.redirect("/login"); });
app.get("/"  ,auth,(req,res)=>res.send(mainHTML()));

// BOT API
app.post("/api/bot/start",   auth,(req,res)=>res.json(startBot()));
app.post("/api/bot/stop",    auth,(req,res)=>res.json(stopBot()));
app.post("/api/bot/restart", auth,(req,res)=>{stopBot();setTimeout(()=>res.json(startBot("restart")),2000);});
app.get("/api/bot/status",   auth,(req,res)=>res.json({running:!!botProcess,uptime:botStartTime?Math.floor((Date.now()-botStartTime)/1000):0}));
app.get("/api/bot/logs",     auth,(req,res)=>res.json({logs:botLogs}));
app.post("/api/bot/clearlogs",auth,(req,res)=>{botLogs=[];broadcast({type:"clearLogs"});res.json({ok:true});});
app.post("/api/bot/install", auth,(req,res)=>{
  if(!fs.existsSync(path.join(BOT_DIR,"package.json"))) return res.json({ok:false,msg:"package.json নেই"});
  try { addLog("📦 npm install চলছে...","warn"); execSync("npm install",{cwd:BOT_DIR,timeout:120000}); addLog("✅ সম্পন্ন","success"); res.json({ok:true,msg:"npm install সম্পন্ন"}); }
  catch(e){ addLog("❌ npm install ব্যর্থ: "+e.message,"error"); res.json({ok:false,msg:e.message}); }
});
app.post("/api/bot/autorestart",auth,(req,res)=>{ autoRestart=!!req.body.enabled; cfg.autoRestart=autoRestart; saveCfg(cfg); res.json({ok:true,enabled:autoRestart}); });
app.get("/api/bot/downloadlog",auth,(req,res)=>{ if(fs.existsSync(LOG_FILE)) res.download(LOG_FILE,"bot.log"); else res.status(404).send("No log"); });
app.post("/api/bot/clearlogfile",auth,(req,res)=>{ try{fs.writeFileSync(LOG_FILE,"");res.json({ok:true});}catch(e){res.json({ok:false,msg:e.message});} });
app.get("/api/stats",auth,(req,res)=>{
  res.json({...stats,currentUptime:botStartTime?Math.floor((Date.now()-botStartTime)/1000):0,autoRestart,
    memMB:Math.round(process.memoryUsage().rss/1024/1024),serverUptime:Math.floor(process.uptime()),
    node:process.version,botFiles:fs.existsSync(BOT_DIR)?countFiles(BOT_DIR):0});
});
function countFiles(dir){let c=0;try{fs.readdirSync(dir).forEach(f=>{const s=fs.statSync(path.join(dir,f));c+=s.isDirectory()?countFiles(path.join(dir,f)):1;});}catch{}return c;}
app.get("/api/backup",auth,(req,res)=>{
  res.setHeader("Content-Disposition",`attachment; filename="bot-backup-${Date.now()}.zip"`);
  const arc=archiver("zip",{zlib:{level:9}});arc.pipe(res);arc.directory(BOT_DIR,false);arc.finalize();
});

// FILE API
app.get("/api/files",auth,(req,res)=>{
  try{const dir=safeJoin(BOT_DIR,req.query.path||"");if(!fs.existsSync(dir))return res.json({items:[],current:""});
  const items=fs.readdirSync(dir).map(name=>{const f=path.join(dir,name),s=fs.statSync(f);return{name,isDir:s.isDirectory(),size:s.size,mtime:s.mtime};}).sort((a,b)=>(b.isDir-a.isDir)||a.name.localeCompare(b.name));
  res.json({items,current:req.query.path||""});}catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/file/read",auth,(req,res)=>{
  try{const f=safeJoin(BOT_DIR,req.query.path),s=fs.statSync(f);if(s.size>5*1024*1024)return res.json({error:"ফাইল অনেক বড়"});res.json({content:fs.readFileSync(f,"utf8")});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/file/save",auth,(req,res)=>{
  try{const f=safeJoin(BOT_DIR,req.body.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,req.body.content||"");res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/file/delete",auth,(req,res)=>{try{fs.rmSync(safeJoin(BOT_DIR,req.body.path),{recursive:true,force:true});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/file/mkdir",auth,(req,res)=>{try{fs.mkdirSync(safeJoin(BOT_DIR,req.body.path),{recursive:true});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/file/rename",auth,(req,res)=>{try{fs.renameSync(safeJoin(BOT_DIR,req.body.from),safeJoin(BOT_DIR,req.body.to));res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/file/newfile",auth,(req,res)=>{
  try{const f=safeJoin(BOT_DIR,req.body.path);if(fs.existsSync(f))return res.json({ok:false,msg:"ফাইল আছে"});fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,req.body.content||"");res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/file/download",auth,(req,res)=>{
  try{const f=safeJoin(BOT_DIR,req.query.path);if(fs.statSync(f).isDirectory()){res.setHeader("Content-Disposition",`attachment; filename="${path.basename(f)}.zip"`);const a=archiver("zip",{zlib:{level:9}});a.pipe(res);a.directory(f,false);a.finalize();}else res.download(f);}
  catch(e){res.status(500).send(e.message);}
});
app.post("/api/file/upload",auth,upload.single("file"),async(req,res)=>{
  try{const t=safeJoin(BOT_DIR,req.body.path||"");fs.mkdirSync(t,{recursive:true});
  if(req.file.originalname.endsWith(".zip")){
    const tmpX="/tmp/extract_"+Date.now();
    fs.mkdirSync(tmpX,{recursive:true});
    await new Promise((resolve,reject)=>fs.createReadStream(req.file.path).pipe(unzipper.Extract({path:tmpX})).on("close",resolve).on("error",reject));
    fs.unlinkSync(req.file.path);
    const mac=path.join(tmpX,"__MACOSX");if(fs.existsSync(mac))fs.rmSync(mac,{recursive:true,force:true});
    const entries=fs.readdirSync(tmpX).filter(f=>!f.startsWith("."));
    let srcDir=tmpX;
    if(entries.length===1){const s=path.join(tmpX,entries[0]);if(fs.statSync(s).isDirectory())srcDir=s;}
    fs.readdirSync(srcDir).forEach(name=>{const from=path.join(srcDir,name),to=path.join(t,name);if(fs.existsSync(to))fs.rmSync(to,{recursive:true,force:true});fs.renameSync(from,to);});
    fs.rmSync(tmpX,{recursive:true,force:true});
    addLog("📦 ZIP extract সম্পন্ন → "+(req.body.path||"/"),"success");res.json({ok:true,msg:"ZIP extract সম্পন্ন ✅"});
  }else{fs.copyFileSync(req.file.path,path.join(t,req.file.originalname));fs.unlinkSync(req.file.path);res.json({ok:true,msg:"আপলোড সম্পন্ন ✅"});}
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/file/search",auth,(req,res)=>{
  const q=(req.query.q||"").toLowerCase();if(!q)return res.json({results:[]});
  const results=[];function walk(dir,rel){try{fs.readdirSync(dir).forEach(name=>{const f=path.join(dir,name),rp=rel?rel+"/"+name:name,s=fs.statSync(f);if(name.toLowerCase().includes(q))results.push({name,path:rp,isDir:s.isDirectory(),size:s.size});if(s.isDirectory()&&results.length<100)walk(f,rp);});}catch{}}
  walk(BOT_DIR,"");res.json({results:results.slice(0,50)});
});
app.get("/api/env",auth,(req,res)=>{const f=path.join(BOT_DIR,".env");res.json({content:fs.existsSync(f)?fs.readFileSync(f,"utf8"):""});});
app.post("/api/env/save",auth,(req,res)=>{try{fs.writeFileSync(path.join(BOT_DIR,".env"),req.body.content||"");res.json({ok:true});}catch(e){res.json({ok:false,msg:e.message});} });
app.get("/api/settings",auth,(req,res)=>res.json(cfg));
app.post("/api/settings/save",auth,(req,res)=>{Object.assign(cfg,req.body);saveCfg(cfg);res.json({ok:true});});
app.post("/api/settings/password",auth,(req,res)=>{
  const{current,newPass}=req.body;
  if(current!==PANEL_PASSWORD&&current!==cfg.password)return res.json({ok:false,msg:"বর্তমান পাসওয়ার্ড ভুল"});
  if(!newPass||newPass.length<4)return res.json({ok:false,msg:"কমপক্ষে ৪ অক্ষর"});
  cfg.password=newPass;saveCfg(cfg);res.json({ok:true,msg:"পাসওয়ার্ড পরিবর্তন হয়েছে"});
});

wss.on("connection",ws=>{ws.send(JSON.stringify({type:"status",running:!!botProcess}));ws.send(JSON.stringify({type:"logs",data:botLogs}));});
server.listen(PORT,()=>console.log("Panel: http://localhost:"+PORT));

// ═══════════════ HTML ═══════════════

function loginHTML(){return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090f;font-family:'Segoe UI',sans-serif}
.bg{position:fixed;inset:0;overflow:hidden}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.2;animation:fl 8s ease-in-out infinite}
.o1{width:400px;height:400px;background:#6c63ff;top:-100px;left:-100px}
.o2{width:300px;height:300px;background:#ff6584;bottom:-80px;right:-80px;animation-delay:4s}
@keyframes fl{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
.card{position:relative;z-index:1;background:rgba(255,255,255,.04);backdrop-filter:blur(30px);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:48px 36px;width:90%;max-width:380px;text-align:center}
.logo{width:80px;height:80px;margin:0 auto 20px;background:linear-gradient(135deg,#6c63ff,#ff6584);border-radius:22px;display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 0 50px rgba(108,99,255,.4);animation:p 3s ease-in-out infinite}
@keyframes p{0%,100%{box-shadow:0 0 30px rgba(108,99,255,.4)}50%{box-shadow:0 0 70px rgba(108,99,255,.8)}}
h1{color:#fff;font-size:22px;font-weight:900;margin-bottom:4px}
.sub{color:rgba(255,255,255,.35);font-size:13px;margin-bottom:32px}
input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#fff;font-size:15px;outline:none;margin-bottom:12px;transition:.3s}
input:focus{border-color:#6c63ff;background:rgba(108,99,255,.1)}
button{width:100%;padding:14px;border-radius:12px;border:none;background:linear-gradient(135deg,#6c63ff,#ff6584);color:#fff;font-size:15px;font-weight:800;cursor:pointer;transition:.3s}
button:hover{opacity:.9;transform:translateY(-1px)}
.err{background:rgba(255,94,94,.1);border:1px solid rgba(255,94,94,.2);color:#ff8080;padding:10px;border-radius:10px;font-size:13px;margin-bottom:12px;display:none}
.err.show{display:block}
</style></head><body>
<div class="bg"><div class="orb o1"></div><div class="orb o2"></div></div>
<div class="card">
  <div class="logo">🤖</div>
  <h1>Bot Panel</h1>
  <p class="sub">তোমার বট কন্ট্রোল সেন্টার</p>
  <div class="err" id="err"></div>
  <input type="password" id="pw" placeholder="🔐 পাসওয়ার্ড লিখুন" autofocus>
  <button onclick="login()">প্রবেশ করুন →</button>
</div>
<script>
async function login(){
  const r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"password="+encodeURIComponent(document.getElementById("pw").value)});
  const d=await r.json();
  if(d.ok)location.href="/";
  else{const e=document.getElementById("err");e.textContent=d.msg;e.classList.add("show");}
}
document.getElementById("pw").addEventListener("keydown",e=>e.key==="Enter"&&login());
</script></body></html>`;}

function mainHTML(){
const pname=cfg.panelName||"Bot Panel";
return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${pname}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#09090f;--s1:#0f0f1a;--s2:#161625;--s3:#1c1c2e;--bd:#252538;--tx:#e0e0f0;--mu:#6b6b90;--ac:#6c63ff;--gr:#3fd68a;--rd:#ff5555;--yw:#ffd93d;--bl:#4fc3f7}
body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',sans-serif;min-height:100vh;overflow-x:hidden}
/* TOP NAV */
.topnav{position:fixed;top:0;left:0;right:0;height:56px;background:var(--s1);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 16px;z-index:100;gap:12px}
.tn-logo{width:34px;height:34px;background:linear-gradient(135deg,var(--ac),#ff6584);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.tn-title{font-size:15px;font-weight:800;color:#fff;flex:1}
.tn-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mu)}
.tn-dot{width:8px;height:8px;border-radius:50%;background:var(--rd);flex-shrink:0}
.tn-dot.on{background:var(--gr);box-shadow:0 0 6px var(--gr);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.tn-logout{padding:7px 12px;border-radius:8px;border:1px solid rgba(255,85,85,.3);background:transparent;color:var(--rd);font-size:12px;cursor:pointer}
/* BOTTOM TAB BAR */
.tabbar{position:fixed;bottom:0;left:0;right:0;height:64px;background:var(--s1);border-top:1px solid var(--bd);display:flex;align-items:center;z-index:100;padding:0 4px;padding-bottom:env(safe-area-inset-bottom)}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;padding:8px 4px;border-radius:10px;transition:.15s;color:var(--mu);border:none;background:transparent}
.tab.active{color:var(--ac)}
.tab .ti{font-size:20px}
.tab .tl{font-size:10px;font-weight:600}
/* MAIN CONTENT */
.main{padding:72px 14px 80px;min-height:100vh}
/* PAGES */
.page{display:none}.page.active{display:block}
/* CARDS */
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.card{background:var(--s2);border:1px solid var(--bd);border-radius:14px;padding:14px}
.ci{font-size:26px;margin-bottom:6px}
.cv{font-size:20px;font-weight:800;color:#fff}
.cl{font-size:11px;color:var(--mu);margin-top:2px}
/* BOT CONTROL */
.bot-card{background:var(--s2);border:1px solid var(--bd);border-radius:16px;padding:16px;margin-bottom:14px}
.status-row{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.sdot{width:12px;height:12px;border-radius:50%;background:var(--rd);flex-shrink:0}
.sdot.on{background:var(--gr);box-shadow:0 0 10px var(--gr);animation:blink 2s infinite}
.stxt{font-size:15px;font-weight:700}
.sup{font-size:11px;color:var(--mu)}
.btn-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.btn{padding:12px;border-radius:12px;border:none;font-size:13px;font-weight:700;cursor:pointer;transition:.2s;display:flex;align-items:center;justify-content:center;gap:6px;width:100%}
.btn:active{transform:scale(.97)}
.btn-start{background:linear-gradient(135deg,#3fd68a,#38f9d7);color:#000}
.btn-stop{background:linear-gradient(135deg,#ff5555,#ff9a9e);color:#fff}
.btn-restart{background:linear-gradient(135deg,#ffd93d,#ff9a3c);color:#000}
.btn-install{background:linear-gradient(135deg,#4fc3f7,#6c63ff);color:#fff}
.btn-backup{background:linear-gradient(135deg,#a18cd1,#fbc2eb);color:#000}
.btn-outline{background:transparent;border:1px solid var(--bd);color:var(--tx)}
/* TOGGLE */
.tog-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--bd);margin-top:4px}
.tog{position:relative;width:42px;height:24px;flex-shrink:0}
.tog input{display:none}
.togbg{position:absolute;inset:0;background:var(--bd);border-radius:99px;cursor:pointer;transition:.3s}
.tog input:checked+.togbg{background:var(--gr)}
.togdot{position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none}
.tog input:checked~.togdot{transform:translateX(18px)}
/* LOGS */
.log-topbar{display:flex;gap:8px;margin-bottom:10px;overflow-x:auto;padding-bottom:4px}
.lf{padding:6px 12px;border-radius:8px;border:1px solid var(--bd);background:transparent;color:var(--mu);font-size:12px;cursor:pointer;white-space:nowrap}
.lf.active{background:var(--ac);color:#fff;border-color:var(--ac)}
.log-box{background:#03030a;border:1px solid var(--bd);border-radius:14px;padding:12px;height:calc(100vh - 220px);overflow-y:auto;font-family:'Courier New',monospace;font-size:12px}
.log-box::-webkit-scrollbar{width:3px}
.log-box::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px}
.le{display:flex;gap:6px;padding:2px 0;line-height:1.6}
.lt{color:var(--mu);white-space:nowrap;font-size:11px;flex-shrink:0}
.lx{word-break:break-all}
.log-info .lx{color:#b8c0d0}
.log-success .lx{color:var(--gr)}
.log-error .lx{color:var(--rd)}
.log-warn .lx{color:var(--yw)}
/* FILE MANAGER */
.pathbar{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--mu);margin-bottom:10px;overflow-x:auto;white-space:nowrap}
.pp{color:var(--ac);cursor:pointer}.pp:hover{text-decoration:underline}
.fm-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.flist{background:var(--s2);border:1px solid var(--bd);border-radius:14px;overflow:hidden}
.frow{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.03);cursor:pointer;transition:.1s}
.frow:last-child{border-bottom:none}
.frow:active{background:rgba(108,99,255,.08)}
.frow-info{flex:1;overflow:hidden}
.frow-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frow-meta{font-size:11px;color:var(--mu);margin-top:2px}
.frow-acts{display:flex;gap:4px;flex-shrink:0}
.fa{padding:6px 8px;border-radius:7px;border:none;background:var(--s3);color:var(--mu);font-size:12px;cursor:pointer}
.fa.del{color:var(--rd)}
.ficon{font-size:22px;flex-shrink:0}
.empty{padding:40px;text-align:center;color:var(--mu)}
.empty .eb{font-size:40px;margin-bottom:8px}
/* EDITOR */
.ed-header{background:var(--s2);border:1px solid var(--bd);border-radius:12px 12px 0 0;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ed-fname{flex:1;font-size:12px;color:var(--ac);font-weight:700;overflow:hidden;text-overflow:ellipsis}
#codeEd{width:100%;height:calc(100vh - 240px);background:#020208;border:1px solid var(--bd);border-top:none;border-radius:0 0 12px 12px;padding:14px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:none;outline:none;tab-size:2}
/* UPLOAD */
.upzone{border:2px dashed var(--bd);border-radius:16px;padding:44px 20px;text-align:center;cursor:pointer;background:var(--s2);transition:.2s;margin-bottom:14px}
.upzone:active,.upzone.drag{border-color:var(--ac);background:rgba(108,99,255,.05)}
.upzone .ui{font-size:48px;margin-bottom:12px}
.prog-wrap{background:var(--s2);border:1px solid var(--bd);border-radius:14px;padding:16px;display:none}
.prog-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px}
.prog-bg{background:var(--bd);border-radius:99px;height:8px;overflow:hidden}
.prog{height:100%;background:linear-gradient(90deg,var(--ac),var(--gr));border-radius:99px;transition:width .2s;width:0}
/* SEARCH */
.sinput{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:14px;outline:none;margin-bottom:12px;transition:.2s}
.sinput:focus{border-color:var(--ac)}
.srow{padding:12px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;margin-bottom:6px;cursor:pointer}
.srow:active{background:var(--s3)}
.srow-path{font-size:11px;color:var(--ac);margin-bottom:3px}
.srow-text{font-size:12px;color:var(--mu)}
/* ENV */
#envEd{width:100%;height:300px;background:#020208;border:1px solid var(--bd);border-radius:12px;padding:14px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:vertical;outline:none;margin-bottom:10px}
/* SETTINGS */
.sc{background:var(--s2);border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:12px}
.sc-title{font-size:13px;font-weight:700;color:#fff;margin-bottom:14px}
.srow2{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.srow2:last-child{border-bottom:none;padding-bottom:0}
.sl{font-size:13px}.sl2{font-size:11px;color:var(--mu);margin-top:2px}
.sinp{padding:8px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--s1);color:var(--tx);font-size:13px;outline:none;max-width:180px}
.sinp:focus{border-color:var(--ac)}
/* MODAL */
.mbg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:500;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)}
.mbg.open{display:flex}
.modal{background:var(--s2);border:1px solid var(--bd);border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:500px;animation:mIn .25s ease}
@keyframes mIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
.modal h3{font-size:15px;font-weight:800;margin-bottom:16px;color:#fff}
.modal input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--bd);background:var(--s1);color:var(--tx);font-size:14px;outline:none;margin-bottom:12px}
.modal input:focus{border-color:var(--ac)}
.modal-btns{display:flex;gap:8px}
/* TOAST */
.tw{position:fixed;top:66px;right:12px;display:flex;flex-direction:column;gap:6px;z-index:999;pointer-events:none;max-width:280px}
.toast{background:var(--s3);border:1px solid var(--bd);border-radius:12px;padding:10px 14px;font-size:13px;animation:tIn .3s ease;box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:auto}
@keyframes tIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
.toast.success{border-color:rgba(63,214,138,.3);color:var(--gr)}
.toast.error{border-color:rgba(255,85,85,.3);color:var(--rd)}
.toast.warn{border-color:rgba(255,217,61,.3);color:var(--yw)}
/* SECTION TITLE */
.pg-title{font-size:16px;font-weight:800;color:#fff;margin-bottom:14px}
.tbtn{padding:8px 12px;border-radius:9px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.tbtn.p{background:var(--ac);border-color:var(--ac);color:#fff}
.tbtn.d{border-color:rgba(255,85,85,.3);color:var(--rd)}
</style></head><body>

<!-- TOP NAV -->
<div class="topnav">
  <div class="tn-logo">🤖</div>
  <div class="tn-title">${pname}</div>
  <div class="tn-status"><div class="tn-dot" id="tnDot"></div><span id="tnStatus">লোড হচ্ছে...</span></div>
  <button class="tn-logout" onclick="location.href='/logout'">বের হন</button>
</div>

<!-- MAIN -->
<div class="main">

<!-- HOME -->
<div id="pg-home" class="page active">
  <div class="card-grid">
    <div class="card"><div class="ci">💾</div><div class="cv" id="cMem">--</div><div class="cl">Memory MB</div></div>
    <div class="card"><div class="ci">⏱️</div><div class="cv" id="cSup">--</div><div class="cl">Server Uptime</div></div>
    <div class="card"><div class="ci">📦</div><div class="cv" id="cFiles">--</div><div class="cl">ফাইল</div></div>
    <div class="card"><div class="ci">🚀</div><div class="cv" id="cStarts">--</div><div class="cl">মোট Start</div></div>
  </div>
  <div class="bot-card">
    <div class="status-row">
      <div class="sdot" id="sDot"></div>
      <div><div class="stxt" id="sTxt">চেক করছে...</div><div class="sup" id="sUp"></div></div>
    </div>
    <div class="btn-grid">
      <button class="btn btn-start"   onclick="botAct('start')">▶ চালু</button>
      <button class="btn btn-stop"    onclick="botAct('stop')">⏹ বন্ধ</button>
      <button class="btn btn-restart" onclick="botAct('restart')">🔄 রিস্টার্ট</button>
      <button class="btn btn-install" onclick="npmInst()">📦 npm install</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      <button class="btn btn-backup" onclick="doBackup()">💾 Backup</button>
      <button class="btn btn-outline" onclick="openLogs()">📋 লগ দেখুন</button>
    </div>
    <div class="tog-row">
      <div><div style="font-size:13px">Auto Restart</div><div style="font-size:11px;color:var(--mu)">Crash হলে অটো চালু</div></div>
      <label class="tog"><input type="checkbox" id="arTog" onchange="toggleAR(this.checked)"><div class="togbg"></div><div class="togdot"></div></label>
    </div>
  </div>
  <!-- STATS -->
  <div style="background:var(--s2);border:1px solid var(--bd);border-radius:16px;padding:16px">
    <div style="font-size:13px;font-weight:700;margin-bottom:10px">📈 সাম্প্রতিক ইতিহাস</div>
    <div id="histList"><div style="font-size:12px;color:var(--mu);text-align:center;padding:16px">ডেটা লোড হচ্ছে...</div></div>
  </div>
</div>

<!-- LOGS -->
<div id="pg-logs" class="page">
  <div class="log-topbar">
    <button class="lf active" onclick="setLF('all',this)">সব</button>
    <button class="lf" onclick="setLF('success',this)">✅ Success</button>
    <button class="lf" onclick="setLF('error',this)">❌ Error</button>
    <button class="lf" onclick="setLF('warn',this)">⚠️ Warning</button>
    <button class="lf" onclick="clearLogs()">🗑 মুছুন</button>
    <button class="lf" onclick="window.open('/api/bot/downloadlog')">⬇️ Download</button>
  </div>
  <div class="log-box" id="logBox"></div>
</div>

<!-- FILES -->
<div id="pg-files" class="page">
  <div id="edView" style="display:none">
    <div class="ed-header">
      <button class="tbtn" onclick="closeEd()">← ফিরে</button>
      <span class="ed-fname" id="edFile"></span>
      <button class="tbtn p" onclick="saveFile()">💾 সেভ</button>
      <button class="tbtn" onclick="downloadF(curEditPath)">⬇️</button>
    </div>
    <textarea id="codeEd" spellcheck="false"></textarea>
  </div>
  <div id="fmView">
    <div class="pathbar" id="pathBar">📁 root</div>
    <div class="fm-actions">
      <button class="tbtn p" onclick="showMod('mkdir')">📁+ ফোল্ডার</button>
      <button class="tbtn p" onclick="showMod('newfile')">📄+ ফাইল</button>
      <button class="tbtn" onclick="loadFiles(curDir)">🔄</button>
    </div>
    <!-- SEARCH IN FILES -->
    <input class="sinput" type="text" id="fSearchQ" placeholder="🔍 ফাইল খোঁজুন..." oninput="doFSearch()" style="margin-bottom:10px">
    <div id="fSearchResults" style="display:none;margin-bottom:10px"></div>
    <div class="flist" id="fileList"></div>
  </div>
</div>

<!-- UPLOAD -->
<div id="pg-upload" class="page">
  <div class="pg-title">⬆️ আপলোড</div>
  <div class="upzone" id="upZone" onclick="document.getElementById('fInp').click()">
    <div class="ui">📦</div>
    <div style="font-size:15px;font-weight:700;margin-bottom:6px">ক্লিক বা ড্র্যাগ করুন</div>
    <div style="color:var(--mu);font-size:13px">ZIP আপলোড করলে অটো extract হবে</div>
    <div style="color:var(--bl);font-size:12px;margin-top:6px">সর্বোচ্চ ৫০০MB</div>
  </div>
  <input type="file" id="fInp" style="display:none" onchange="uploadF(this.files[0])">
  <div class="prog-wrap" id="progWrap">
    <div class="prog-top"><span id="upFN">আপলোড হচ্ছে...</span><span id="upPct">0%</span></div>
    <div class="prog-bg"><div class="prog" id="progBar"></div></div>
    <div id="upSt" style="font-size:12px;color:var(--mu);margin-top:6px"></div>
  </div>
</div>

<!-- MORE (ENV + SETTINGS) -->
<div id="pg-more" class="page">
  <!-- ENV -->
  <div class="sc">
    <div class="sc-title">⚙️ Environment (.env)</div>
    <textarea id="envEd" spellcheck="false" placeholder="TOKEN=your_token&#10;COOKIE=your_cookie&#10;PREFIX=!"></textarea>
    <div style="display:flex;gap:8px">
      <button class="tbtn p" onclick="saveEnv()">💾 সেভ</button>
      <button class="tbtn" onclick="loadEnv()">🔄 রিলোড</button>
    </div>
  </div>
  <!-- SETTINGS -->
  <div class="sc">
    <div class="sc-title">🔧 Settings</div>
    <div class="srow2">
      <div><div class="sl">Panel এর নাম</div></div>
      <input class="sinp" type="text" id="sName" placeholder="${pname}">
    </div>
    <div class="srow2">
      <div><div class="sl">Auto Restart</div><div class="sl2">Crash হলে অটো চালু</div></div>
      <label class="tog"><input type="checkbox" id="sAR" onchange="toggleAR(this.checked)"><div class="togbg"></div><div class="togdot"></div></label>
    </div>
    <div class="srow2">
      <div><div class="sl">Schedule Restart</div><div class="sl2">প্রতিদিন নির্দিষ্ট সময়ে</div></div>
      <label class="tog"><input type="checkbox" id="sSched"><div class="togbg"></div><div class="togdot"></div></label>
    </div>
    <div class="srow2">
      <div><div class="sl">Restart সময়</div></div>
      <input class="sinp" type="time" id="sTime" value="03:00">
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="tbtn p" onclick="saveSettings()">💾 সেভ</button>
    </div>
  </div>
  <!-- PASSWORD -->
  <div class="sc">
    <div class="sc-title">🔐 পাসওয়ার্ড পরিবর্তন</div>
    <div class="srow2">
      <div class="sl">বর্তমান</div>
      <input class="sinp" type="password" id="sCur" placeholder="বর্তমান পাসওয়ার্ড">
    </div>
    <div class="srow2">
      <div class="sl">নতুন</div>
      <input class="sinp" type="password" id="sNew" placeholder="নতুন পাসওয়ার্ড">
    </div>
    <div style="margin-top:12px">
      <button class="tbtn p" onclick="changePw()">🔐 পরিবর্তন করুন</button>
    </div>
  </div>
  <!-- MAINTENANCE -->
  <div class="sc">
    <div class="sc-title">🛠️ Maintenance</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="tbtn" onclick="doBackup()">💾 Full Backup</button>
      <button class="tbtn d" onclick="clearLogFile()">🗑 Log মুছুন</button>
    </div>
  </div>
</div>

</div><!-- /main -->

<!-- BOTTOM TAB BAR -->
<div class="tabbar">
  <button class="tab active" onclick="goTab('home',this)"><span class="ti">🏠</span><span class="tl">হোম</span></button>
  <button class="tab" onclick="goTab('logs',this)"><span class="ti">📋</span><span class="tl">লগ</span></button>
  <button class="tab" onclick="goTab('files',this)"><span class="ti">📁</span><span class="tl">ফাইল</span></button>
  <button class="tab" onclick="goTab('upload',this)"><span class="ti">⬆️</span><span class="tl">আপলোড</span></button>
  <button class="tab" onclick="goTab('more',this)"><span class="ti">⚙️</span><span class="tl">আরো</span></button>
</div>

<!-- MODALS -->
<div class="mbg" id="mod-mkdir"><div class="modal"><h3>📁 নতুন ফোল্ডার</h3><input type="text" id="mkN" placeholder="ফোল্ডারের নাম"><div class="modal-btns"><button class="tbtn" onclick="closeMod('mkdir')">বাতিল</button><button class="tbtn p" onclick="doMkdir()">তৈরি করুন</button></div></div></div>
<div class="mbg" id="mod-newfile"><div class="modal"><h3>📄 নতুন ফাইল</h3><input type="text" id="nfN" placeholder="ফাইলের নাম (test.js)"><div class="modal-btns"><button class="tbtn" onclick="closeMod('newfile')">বাতিল</button><button class="tbtn p" onclick="doNewFile()">তৈরি করুন</button></div></div></div>
<div class="mbg" id="mod-rename"><div class="modal"><h3>✏️ নাম পরিবর্তন</h3><input type="text" id="rnV" placeholder="নতুন নাম"><div class="modal-btns"><button class="tbtn" onclick="closeMod('rename')">বাতিল</button><button class="tbtn p" onclick="doRename()">পরিবর্তন</button></div></div></div>

<div class="tw" id="tw"></div>

<script>
// STATE
let curDir="",curEditPath="",renameFrom="",logFilter="all",autoScroll=true;
let ws;

// TABS
function goTab(id,btn){
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.getElementById("pg-"+id).classList.add("active");
  if(id==="files") loadFiles(curDir);
  if(id==="more"){loadEnv();loadSettings();}
  if(id==="logs") document.getElementById("logBox").scrollTop=document.getElementById("logBox").scrollHeight;
}

function openLogs(){
  document.querySelectorAll(".tab").forEach((t,i)=>t.classList.toggle("active",i===1));
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.getElementById("pg-logs").classList.add("active");
}

// WS
function connectWS(){
  const proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(proto+"://"+location.host);
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==="log") appendLog(m.data);
    if(m.type==="logs"){document.getElementById("logBox").innerHTML="";m.data.forEach(appendLog);}
    if(m.type==="status") updateStatus(m.running);
    if(m.type==="clearLogs") document.getElementById("logBox").innerHTML="";
  };
  ws.onclose=()=>setTimeout(connectWS,3000);
}

function appendLog(e){
  if(logFilter!=="all"&&e.type!==logFilter) return;
  const box=document.getElementById("logBox");
  const d=document.createElement("div");
  d.className="le log-"+(e.type||"info");d.dataset.type=e.type||"info";
  d.innerHTML='<span class="lt">'+e.time+'</span><span class="lx">'+esc(e.text)+'</span>';
  box.appendChild(d);
  if(autoScroll) box.scrollTop=box.scrollHeight;
}

function esc(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

function setLF(f,btn){
  logFilter=f;
  document.querySelectorAll(".lf").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".le").forEach(el=>el.style.display=(f==="all"||el.dataset.type===f)?"flex":"none");
}

function clearLogs(){fetch("/api/bot/clearlogs",{method:"POST"});}
function clearLogFile(){if(!confirm("Log file মুছবেন?"))return;fetch("/api/bot/clearlogfile",{method:"POST"}).then(r=>r.json()).then(d=>toast(d.ok?"✅ মুছা হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error"));}

// STATUS
function updateStatus(running){
  document.querySelectorAll(".sdot,.tn-dot").forEach(d=>d.className=(d.classList.contains("tn-dot")?"tn-dot":"sdot")+(running?" on":""));
  const st=document.getElementById("sTxt");if(st) st.textContent=running?"✅ বট চলছে":"🔴 বট বন্ধ";
  const ts=document.getElementById("tnStatus");if(ts) ts.textContent=running?"✅ চলছে":"🔴 বন্ধ";
}

function fmtT(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return h>0?h+"h "+m+"m":m>0?m+"m "+sc+"s":sc+"s";}
function fsz(b){if(!b)return"—";if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB";}
function fdt(d){return new Date(d).toLocaleDateString("bn-BD",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}

async function refreshAll(){
  const[st,bs]=await Promise.all([fetch("/api/stats").then(r=>r.json()),fetch("/api/bot/status").then(r=>r.json())]);
  document.getElementById("cMem").textContent=st.memMB;
  document.getElementById("cSup").textContent=fmtT(st.serverUptime);
  document.getElementById("cFiles").textContent=st.botFiles;
  document.getElementById("cStarts").textContent=st.starts||0;
  updateStatus(bs.running);
  const sup=document.getElementById("sUp");if(sup) sup.textContent=bs.running&&bs.uptime>0?"চলছে: "+fmtT(bs.uptime):"";
  const ar=document.getElementById("arTog");if(ar) ar.checked=st.autoRestart||false;
  const sar=document.getElementById("sAR");if(sar) sar.checked=st.autoRestart||false;
  // history
  const hist=(st.history||[]).slice().reverse().slice(0,5);
  document.getElementById("histList").innerHTML=hist.length
    ?hist.map(h=>'<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px"><span style="color:var(--mu)">'+new Date(h.date).toLocaleString("bn-BD").substring(0,16)+'</span><span style="color:var(--gr)">'+fmtT(h.uptime)+'</span></div>').join("")
    :'<div style="font-size:12px;color:var(--mu);text-align:center;padding:10px">কোনো ইতিহাস নেই</div>';
}

// BOT
async function botAct(a){
  toast("⏳ "+a+"...","warn");
  const d=await fetch("/api/bot/"+a,{method:"POST"}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
}
async function npmInst(){toast("📦 npm install শুরু...","warn");const d=await fetch("/api/bot/install",{method:"POST"}).then(r=>r.json());toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");}
function doBackup(){window.open("/api/backup");}
async function toggleAR(v){
  await fetch("/api/bot/autorestart",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:v})});
  toast(v?"✅ Auto Restart চালু":"⚠️ বন্ধ",v?"success":"warn");
  [document.getElementById("arTog"),document.getElementById("sAR")].forEach(el=>{if(el)el.checked=v;});
}

// FILE MANAGER
function ficon(name,isDir){
  if(isDir)return"📁";
  const e=name.split(".").pop().toLowerCase();
  return{js:"📜",json:"📋",md:"📝",txt:"📄",env:"🔐",log:"📋",jpg:"🖼",png:"🖼",gif:"🖼",mp3:"🎵",mp4:"🎬",zip:"📦",html:"🌐",css:"🎨",ts:"📘",py:"🐍",sh:"⚡",yml:"⚙️"}[e]||"📄";
}

function buildPath(dir){
  const bar=document.getElementById("pathBar");
  const parts=dir?dir.split("/"):[];
  let html='<span class="pp" onclick="loadFiles(\\'\\')">📁 root</span>';
  let acc="";
  parts.forEach(p=>{acc+=(acc?"/":"")+p;const c=acc;html+=' / <span class="pp" onclick="loadFiles(\\''+c+'\\')">'+p+'</span>';});
  bar.innerHTML=html;
}

async function loadFiles(dir){
  curDir=dir||"";buildPath(curDir);
  document.getElementById("fmView").style.display="block";
  document.getElementById("edView").style.display="none";
  document.getElementById("fSearchResults").style.display="none";
  document.getElementById("fSearchQ").value="";
  const data=await fetch("/api/files?path="+encodeURIComponent(curDir)).then(r=>r.json());
  const list=document.getElementById("fileList");list.innerHTML="";
  if(curDir){
    const up=document.createElement("div");up.className="frow";
    up.innerHTML='<span class="ficon">⬆️</span><div class="frow-info"><div class="frow-name">.. উপরে যান</div></div>';
    up.onclick=()=>loadFiles(curDir.split("/").slice(0,-1).join("/"));
    list.appendChild(up);
  }
  if(!data.items?.length){list.innerHTML='<div class="empty"><div class="eb">📭</div><div>ফোল্ডার খালি</div></div>';return;}
  data.items.forEach(item=>{
    const fp=curDir?curDir+"/"+item.name:item.name;
    const row=document.createElement("div");row.className="frow";
    row.innerHTML='<span class="ficon">'+ficon(item.name,item.isDir)+'</span>'
      +'<div class="frow-info"><div class="frow-name">'+item.name+'</div><div class="frow-meta">'+fsz(item.size)+(item.mtime?" · "+fdt(item.mtime):"")+'</div></div>'
      +'<div class="frow-acts">'
      +(item.isDir?'':'<button class="fa" onclick="event.stopPropagation();editF(\\''+fp+'\\')">✏️</button>')
      +'<button class="fa" onclick="event.stopPropagation();downloadF(\\''+fp+'\\')">⬇️</button>'
      +'<button class="fa" onclick="event.stopPropagation();showRename(\\''+fp+'\\',\\''+item.name+'\\')">🔤</button>'
      +'<button class="fa del" onclick="event.stopPropagation();delItem(\\''+fp+'\\',\\''+item.name+'\\')">🗑</button>'
      +'</div>';
    if(item.isDir) row.onclick=()=>loadFiles(fp);
    else row.onclick=()=>editF(fp);
    list.appendChild(row);
  });
}

async function editF(p){
  const d=await fetch("/api/file/read?path="+encodeURIComponent(p)).then(r=>r.json());
  if(d.error)return toast("❌ "+d.error,"error");
  curEditPath=p;
  document.getElementById("edFile").textContent=p.split("/").pop();
  document.getElementById("codeEd").value=d.content;
  document.getElementById("fmView").style.display="none";
  document.getElementById("edView").style.display="block";
}
function closeEd(){document.getElementById("edView").style.display="none";document.getElementById("fmView").style.display="block";}
async function saveFile(){
  const d=await fetch("/api/file/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:curEditPath,content:document.getElementById("codeEd").value})}).then(r=>r.json());
  toast(d.ok?"✅ সেভ হয়েছে":"❌ "+d.error,d.ok?"success":"error");
}
function downloadF(p){window.open("/api/file/download?path="+encodeURIComponent(p));}
async function delItem(p,name){
  if(!confirm('"'+name+'" ডিলিট করবেন?'))return;
  const d=await fetch("/api/file/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})}).then(r=>r.json());
  toast(d.ok?"🗑 ডিলিট":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);
}

// FILE SEARCH
let fsTimeout;
function doFSearch(){
  const q=document.getElementById("fSearchQ").value.trim();
  const res=document.getElementById("fSearchResults");
  if(!q){res.style.display="none";return;}
  clearTimeout(fsTimeout);fsTimeout=setTimeout(async()=>{
    const d=await fetch("/api/file/search?q="+encodeURIComponent(q)).then(r=>r.json());
    if(!d.results?.length){res.style.display="block";res.innerHTML='<div style="font-size:12px;color:var(--mu);padding:10px;text-align:center">📭 পাওয়া যায়নি</div>';return;}
    res.style.display="block";
    res.innerHTML=d.results.map(r=>'<div class="srow" onclick="'+(r.isDir?"loadFiles('"+r.path+"')":"editF('"+r.path+"')")+'"><div class="srow-path">'+ficon(r.name,r.isDir)+' '+r.path+'</div><div class="srow-text">'+fsz(r.size)+'</div></div>').join("");
  },300);
}

// MODALS
function showMod(id){document.getElementById("mod-"+id).classList.add("open");setTimeout(()=>document.querySelector("#mod-"+id+" input")?.focus(),100);}
function closeMod(id){document.getElementById("mod-"+id).classList.remove("open");}
async function doMkdir(){const n=document.getElementById("mkN").value.trim();if(!n)return;const fp=curDir?curDir+"/"+n:n;const d=await fetch("/api/file/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp})}).then(r=>r.json());closeMod("mkdir");toast(d.ok?"📁 তৈরি":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);}
async function doNewFile(){const n=document.getElementById("nfN").value.trim();if(!n)return;const fp=curDir?curDir+"/"+n:n;const d=await fetch("/api/file/newfile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp,content:""})}).then(r=>r.json());closeMod("newfile");if(d.ok){toast("📄 তৈরি","success");editF(fp);}else toast("❌ "+d.error,"error");}
function showRename(p,name){renameFrom=p;document.getElementById("rnV").value=name;showMod("rename");}
async function doRename(){const n=document.getElementById("rnV").value.trim();if(!n)return;const dir=renameFrom.includes("/")?renameFrom.split("/").slice(0,-1).join("/"):"";const to=dir?dir+"/"+n:n;const d=await fetch("/api/file/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:renameFrom,to})}).then(r=>r.json());closeMod("rename");toast(d.ok?"✅ নাম পরিবর্তন":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);}

// UPLOAD
async function uploadF(file){
  if(!file)return;
  const pw=document.getElementById("progWrap"),pb=document.getElementById("progBar"),pp=document.getElementById("upPct"),ps=document.getElementById("upSt"),fn=document.getElementById("upFN");
  pw.style.display="block";fn.textContent=file.name;pb.style.width="0%";pp.textContent="0%";ps.textContent="আপলোড শুরু হচ্ছে...";
  const fd=new FormData();fd.append("file",file);fd.append("path",curDir||"");
  const xhr=new XMLHttpRequest();xhr.open("POST","/api/file/upload");
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);pb.style.width=p+"%";pp.textContent=p+"%";ps.textContent=fsz(e.loaded)+" / "+fsz(e.total);}};
  xhr.onload=()=>{const d=JSON.parse(xhr.responseText);if(d.ok){pb.style.width="100%";pp.textContent="100%";ps.innerHTML='<span style="color:var(--gr)">✅ '+(d.msg||"সম্পন্ন")+'</span>';toast("✅ "+(d.msg||"আপলোড সম্পন্ন"),"success");}else{ps.innerHTML='<span style="color:var(--rd)">❌ '+d.error+'</span>';toast("❌ "+d.error,"error");}document.getElementById("fInp").value="";};
  xhr.send(fd);
}
const uz=document.getElementById("upZone");
uz.addEventListener("dragover",e=>{e.preventDefault();uz.classList.add("drag");});
uz.addEventListener("dragleave",()=>uz.classList.remove("drag"));
uz.addEventListener("drop",e=>{e.preventDefault();uz.classList.remove("drag");uploadF(e.dataTransfer.files[0]);});

// ENV
async function loadEnv(){const d=await fetch("/api/env").then(r=>r.json());document.getElementById("envEd").value=d.content||"";}
async function saveEnv(){const d=await fetch("/api/env/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:document.getElementById("envEd").value})}).then(r=>r.json());toast(d.ok?"✅ .env সেভ":"❌ "+d.msg,d.ok?"success":"error");}

// SETTINGS
async function loadSettings(){const d=await fetch("/api/settings").then(r=>r.json());document.getElementById("sName").value=d.panelName||"";document.getElementById("sAR").checked=d.autoRestart||false;document.getElementById("sSched").checked=d.scheduleRestart||false;document.getElementById("sTime").value=d.scheduleTime||"03:00";}
async function saveSettings(){const body={panelName:document.getElementById("sName").value,autoRestart:document.getElementById("sAR").checked,scheduleRestart:document.getElementById("sSched").checked,scheduleTime:document.getElementById("sTime").value};const d=await fetch("/api/settings/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());toast(d.ok?"✅ সেভ হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error");}
async function changePw(){const d=await fetch("/api/settings/password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current:document.getElementById("sCur").value,newPass:document.getElementById("sNew").value})}).then(r=>r.json());toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");if(d.ok){document.getElementById("sCur").value="";document.getElementById("sNew").value="";}}

// TOAST
function toast(msg,type="success"){const w=document.getElementById("tw"),el=document.createElement("div");el.className="toast "+type;el.textContent=msg;w.appendChild(el);setTimeout(()=>{el.style.opacity="0";el.style.transition=".3s";setTimeout(()=>el.remove(),300);},3500);}

// KEYBOARD
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="s"&&curEditPath){e.preventDefault();saveFile();}if(e.key==="Escape")document.querySelectorAll(".mbg.open").forEach(m=>m.classList.remove("open"));});

// INIT
connectWS();
refreshAll();
setInterval(refreshAll,10000);
</script>
</body></html>`;}
