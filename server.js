"use strict";
const express   = require("express");
const session   = require("express-session");
const multer    = require("multer");
const http      = require("http");
const WebSocket = require("ws");
const fs        = require("fs");
const path      = require("path");
const { spawn, execSync } = require("child_process");
const archiver  = require("archiver");
const unzipper  = require("unzipper");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── CONFIG ──
const CFG  = path.join(__dirname, "panel.config.json");
const BDIR = path.join(__dirname, "bot");
const LFILE= path.join(__dirname, "panel.log");
const SFILE= path.join(__dirname, "stats.json");
const PORT = process.env.PORT || 3000;

function loadJ(f,def={}){try{return JSON.parse(fs.readFileSync(f,"utf8"));}catch{return def;}}
function saveJ(f,d){try{fs.writeFileSync(f,JSON.stringify(d,null,2));}catch{}}
let cfg   = loadJ(CFG);
let stats = loadJ(SFILE,{starts:0,crashes:0,totalUptime:0,history:[],loginAttempts:{}});

const PASS = process.env.PANEL_PASSWORD || cfg.password || "admin123";
if(!fs.existsSync(BDIR)) fs.mkdirSync(BDIR,{recursive:true});

// ── MIDDLEWARE ──
app.use(express.json({limit:"500mb"}));
app.use(express.urlencoded({extended:true,limit:"500mb"}));
app.use(session({secret:process.env.SESSION_SECRET||"belal_bot_2024",resave:false,saveUninitialized:false,cookie:{maxAge:7*24*60*60*1000}}));
const upload = multer({storage:multer.diskStorage({destination:(r,f,cb)=>cb(null,"/tmp/"),filename:(r,f,cb)=>cb(null,Date.now()+"_"+f.originalname)}),limits:{fileSize:500*1024*1024}});

const auth = (req,res,next) => req.session.ok ? next() : res.redirect("/login");
const safe = (base,rel) => { const f=path.resolve(base,rel||""); if(!f.startsWith(path.resolve(base))) throw new Error("Access denied"); return f; };

// ── BOT ──
let botProc=null, botLogs=[], botStart=null, autoRestart=cfg.autoRestart||false, rsTimer=null;

function bc(d){wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(JSON.stringify(d));});}

function log(text,type="info"){
  const e={time:new Date().toLocaleTimeString("bn-BD"),text,type,ts:Date.now()};
  botLogs.push(e); if(botLogs.length>2000) botLogs.shift();
  bc({type:"log",data:e});
  try{fs.appendFileSync(LFILE,`[${e.time}][${type}] ${text}\n`);}catch{}
}

function fmtS(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return h>0?h+"h "+m+"m":m>0?m+"m "+sc+"s":sc+"s";}

function startBot(by="manual"){
  if(botProc) return {ok:false,msg:"বট ইতিমধ্যে চলছে"};
  const idx=["index.js","app.js","main.js","bot.js","start.js"].find(f=>fs.existsSync(path.join(BDIR,f)));
  if(!idx) return {ok:false,msg:"index.js পাওয়া যায়নি — বট আপলোড করুন"};
  if(!fs.existsSync(path.join(BDIR,"node_modules"))){
    try{log("📦 npm install চলছে...","warn");execSync("npm install",{cwd:BDIR,timeout:180000});log("✅ npm install সম্পন্ন","success");}
    catch(e){log("⚠️ npm install সমস্যা: "+e.message,"error");}
  }
  botProc=spawn("node",[idx],{cwd:BDIR,env:{...process.env,FORCE_COLOR:"1"}});
  botStart=Date.now(); stats.starts++; saveJ(SFILE,stats);
  log(`🟢 বট চালু (${by}) — ${idx}`,"success"); bc({type:"status",running:true});
  botProc.stdout.on("data",d=>log(d.toString().trim(),"info"));
  botProc.stderr.on("data",d=>log(d.toString().trim(),"error"));
  botProc.on("exit",(code,sig)=>{
    const up=botStart?Math.floor((Date.now()-botStart)/1000):0;
    stats.totalUptime+=up; stats.history.push({date:new Date().toISOString(),uptime:up,code:code||sig});
    if(stats.history.length>100) stats.history.shift();
    if(code!==0&&code!==null) stats.crashes++;
    saveJ(SFILE,stats);
    log(`🔴 বট বন্ধ (code:${code||sig}, uptime:${fmtS(up)})`,"error");
    botProc=null; botStart=null; bc({type:"status",running:false});
    if(autoRestart&&code!==0&&code!==null){log("🔄 Auto-restart ১০ সেকেন্ড পরে...","warn");rsTimer=setTimeout(()=>startBot("auto-restart"),10000);}
  });
  return {ok:true,msg:"বট চালু হয়েছে"};
}

function stopBot(){
  if(rsTimer){clearTimeout(rsTimer);rsTimer=null;}
  if(!botProc) return {ok:false,msg:"বট চলছে না"};
  botProc.kill("SIGTERM"); botProc=null; botStart=null;
  log("🔴 বট বন্ধ করা হয়েছে","warn"); bc({type:"status",running:false});
  return {ok:true,msg:"বট বন্ধ হয়েছে"};
}

// ── AUTH ──
app.get("/login",(req,res)=>{if(req.session.ok)return res.redirect("/");res.send(loginHTML());});
app.post("/login",(req,res)=>{
  if(req.body.password===PASS){req.session.ok=true;res.json({ok:true});}
  else res.json({ok:false,msg:"❌ ভুল পাসওয়ার্ড"});
});
app.get("/logout",(req,res)=>{req.session.destroy();res.redirect("/login");});
app.get("/"   ,auth,(req,res)=>res.send(mainHTML()));

// ── BOT API ──
app.post("/api/bot/start",   auth,(req,res)=>res.json(startBot()));
app.post("/api/bot/stop",    auth,(req,res)=>res.json(stopBot()));
app.post("/api/bot/restart", auth,(req,res)=>{stopBot();setTimeout(()=>res.json(startBot("restart")),2000);});
app.get("/api/bot/status",   auth,(req,res)=>res.json({running:!!botProc,uptime:botStart?Math.floor((Date.now()-botStart)/1000):0}));
app.get("/api/bot/logs",     auth,(req,res)=>res.json({logs:botLogs}));
app.post("/api/bot/clearlogs",auth,(req,res)=>{botLogs=[];bc({type:"clearLogs"});res.json({ok:true});});
app.post("/api/bot/install", auth,(req,res)=>{
  if(!fs.existsSync(path.join(BDIR,"package.json"))) return res.json({ok:false,msg:"package.json নেই"});
  try{log("📦 npm install চলছে...","warn");execSync("npm install",{cwd:BDIR,timeout:180000});log("✅ সম্পন্ন","success");res.json({ok:true,msg:"npm install সম্পন্ন"});}
  catch(e){log("❌ npm install ব্যর্থ: "+e.message,"error");res.json({ok:false,msg:e.message});}
});
app.post("/api/bot/autorestart",auth,(req,res)=>{autoRestart=!!req.body.enabled;cfg.autoRestart=autoRestart;saveJ(CFG,cfg);res.json({ok:true,enabled:autoRestart});});
app.get("/api/bot/downloadlog",auth,(req,res)=>{if(fs.existsSync(LFILE))res.download(LFILE,"bot.log");else res.status(404).send("No log");});
app.post("/api/bot/clearlogfile",auth,(req,res)=>{try{fs.writeFileSync(LFILE,"");res.json({ok:true});}catch(e){res.json({ok:false,msg:e.message});}});
app.get("/api/stats",auth,(req,res)=>{
  function countF(d){let c=0;try{fs.readdirSync(d).forEach(f=>{const s=fs.statSync(path.join(d,f));c+=s.isDirectory()?countF(path.join(d,f)):1;});}catch{}return c;}
  res.json({...stats,running:!!botProc,currentUptime:botStart?Math.floor((Date.now()-botStart)/1000):0,autoRestart,
    memMB:Math.round(process.memoryUsage().rss/1024/1024),serverUptime:Math.floor(process.uptime()),node:process.version,botFiles:countF(BDIR)});
});
app.get("/api/backup",auth,(req,res)=>{
  res.setHeader("Content-Disposition",`attachment; filename="bot-backup-${Date.now()}.zip"`);
  const a=archiver("zip",{zlib:{level:9}});a.pipe(res);a.directory(BDIR,false);a.finalize();
});

// ── FILES ──
app.get("/api/files",auth,(req,res)=>{
  try{
    const dir=safe(BDIR,req.query.path||"");
    if(!fs.existsSync(dir))return res.json({items:[],current:req.query.path||""});
    const items=fs.readdirSync(dir).map(name=>{
      const f=path.join(dir,name),s=fs.statSync(f);
      return{name,isDir:s.isDirectory(),size:s.size,mtime:s.mtime,ext:path.extname(name).toLowerCase()};
    }).sort((a,b)=>(b.isDir-a.isDir)||a.name.localeCompare(b.name));
    res.json({items,current:req.query.path||""});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/file/read",auth,(req,res)=>{
  try{const f=safe(BDIR,req.query.path),s=fs.statSync(f);if(s.size>5*1024*1024)return res.json({error:"ফাইল অনেক বড় (5MB+)"});res.json({content:fs.readFileSync(f,"utf8")});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/file/save",auth,(req,res)=>{
  try{const f=safe(BDIR,req.body.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,req.body.content||"");res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/file/delete",auth,(req,res)=>{try{fs.rmSync(safe(BDIR,req.body.path),{recursive:true,force:true});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/file/mkdir",auth,(req,res)=>{try{fs.mkdirSync(safe(BDIR,req.body.path),{recursive:true});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/file/rename",auth,(req,res)=>{
  try{
    const from=safe(BDIR,req.body.from),to=safe(BDIR,req.body.to);
    // cross-device safe
    const sf=fs.statSync(from);
    if(sf.isDirectory()){
      function cpR(s,d){fs.mkdirSync(d,{recursive:true});fs.readdirSync(s).forEach(n=>{const ss=path.join(s,n),dd=path.join(d,n);fs.statSync(ss).isDirectory()?cpR(ss,dd):fs.copyFileSync(ss,dd);});}
      cpR(from,to); fs.rmSync(from,{recursive:true,force:true});
    } else { fs.copyFileSync(from,to); fs.unlinkSync(from); }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/file/newfile",auth,(req,res)=>{
  try{const f=safe(BDIR,req.body.path);if(fs.existsSync(f))return res.json({ok:false,msg:"ফাইল আছে"});fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,req.body.content||"");res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/file/download",auth,(req,res)=>{
  try{const f=safe(BDIR,req.query.path);if(fs.statSync(f).isDirectory()){res.setHeader("Content-Disposition",`attachment; filename="${path.basename(f)}.zip"`);const a=archiver("zip",{zlib:{level:9}});a.pipe(res);a.directory(f,false);a.finalize();}else res.download(f);}
  catch(e){res.status(500).send(e.message);}
});

// ── UPLOAD (cross-device safe) ──
app.post("/api/file/upload",auth,upload.single("file"),async(req,res)=>{
  try{
    const t=safe(BDIR,req.body.path||"");
    fs.mkdirSync(t,{recursive:true});
    if(req.file.originalname.endsWith(".zip")){
      const tmpX=path.join("/tmp","xtr_"+Date.now());
      fs.mkdirSync(tmpX,{recursive:true});
      await new Promise((ok,fail)=>fs.createReadStream(req.file.path).pipe(unzipper.Extract({path:tmpX})).on("close",ok).on("error",fail));
      try{fs.unlinkSync(req.file.path);}catch{}
      // cleanup junk
      ["__MACOSX",".DS_Store"].forEach(j=>{const jj=path.join(tmpX,j);if(fs.existsSync(jj))fs.rmSync(jj,{recursive:true,force:true});});
      // auto-flatten single root folder
      const entries=fs.readdirSync(tmpX).filter(f=>!f.startsWith("."));
      let src=tmpX;
      if(entries.length===1){const s=path.join(tmpX,entries[0]);if(fs.statSync(s).isDirectory())src=s;}
      // cross-device safe recursive copy
      function cpR(s,d){
        fs.mkdirSync(d,{recursive:true});
        fs.readdirSync(s).forEach(n=>{
          const ss=path.join(s,n),dd=path.join(d,n);
          if(fs.statSync(ss).isDirectory()) cpR(ss,dd);
          else fs.copyFileSync(ss,dd);
        });
      }
      cpR(src,t);
      try{fs.rmSync(tmpX,{recursive:true,force:true});}catch{}
      log("📦 ZIP extract সম্পন্ন → "+(req.body.path||"/"),"success");
      res.json({ok:true,msg:"ZIP extract সম্পন্ন ✅ সব ফাইল সাজানো হয়েছে"});
    } else {
      const dst=path.join(t,req.file.originalname);
      fs.copyFileSync(req.file.path,dst);
      try{fs.unlinkSync(req.file.path);}catch{}
      res.json({ok:true,msg:"ফাইল আপলোড সম্পন্ন ✅"});
    }
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/file/search",auth,(req,res)=>{
  const q=(req.query.q||"").toLowerCase();if(!q)return res.json({results:[]});
  const results=[];
  function walk(dir,rel){try{fs.readdirSync(dir).forEach(name=>{const f=path.join(dir,name),rp=rel?rel+"/"+name:name,s=fs.statSync(f);if(name.toLowerCase().includes(q))results.push({name,path:rp,isDir:s.isDirectory(),size:s.size});if(s.isDirectory()&&results.length<100)walk(f,rp);});}catch{}}
  walk(BDIR,"");res.json({results:results.slice(0,50)});
});

// ── ENV ──
app.get("/api/env",auth,(req,res)=>{const f=path.join(BDIR,".env");res.json({content:fs.existsSync(f)?fs.readFileSync(f,"utf8"):""});});
app.post("/api/env/save",auth,(req,res)=>{try{fs.writeFileSync(path.join(BDIR,".env"),req.body.content||"");res.json({ok:true});}catch(e){res.json({ok:false,msg:e.message});}});

// ── SETTINGS ──
app.get("/api/settings",auth,(req,res)=>res.json(cfg));
app.post("/api/settings/save",auth,(req,res)=>{Object.assign(cfg,req.body);saveJ(CFG,cfg);if(req.body.autoRestart!==undefined)autoRestart=!!req.body.autoRestart;res.json({ok:true});});
app.post("/api/settings/password",auth,(req,res)=>{
  const{current,newPass}=req.body;
  if(current!==PASS&&current!==cfg.password)return res.json({ok:false,msg:"বর্তমান পাসওয়ার্ড ভুল"});
  if(!newPass||newPass.length<4)return res.json({ok:false,msg:"কমপক্ষে ৪ অক্ষর"});
  cfg.password=newPass;saveJ(CFG,cfg);res.json({ok:true,msg:"পাসওয়ার্ড পরিবর্তন হয়েছে"});
});

// ── COOKIE HELPER ──
app.post("/api/cookie/save",auth,(req,res)=>{
  try{
    const cookie=req.body.cookie||"";
    // appstate.json format চেক
    let appstate;
    try{appstate=JSON.parse(cookie);}catch{appstate=null;}
    if(appstate && Array.isArray(appstate)){
      fs.writeFileSync(path.join(BDIR,"appstate.json"),JSON.stringify(appstate,null,2));
      res.json({ok:true,msg:"Appstate সেভ হয়েছে ✅"});
    } else {
      // plain cookie string → .env এ COOKIE= হিসেবে সেভ
      const envFile=path.join(BDIR,".env");
      let env=fs.existsSync(envFile)?fs.readFileSync(envFile,"utf8"):"";
      if(env.includes("COOKIE=")) env=env.replace(/COOKIE=.*/,"COOKIE="+cookie);
      else env+="\nCOOKIE="+cookie;
      fs.writeFileSync(envFile,env.trim());
      res.json({ok:true,msg:"Cookie .env এ সেভ হয়েছে ✅"});
    }
  }catch(e){res.json({ok:false,msg:e.message});}
});

// ── WS ──
wss.on("connection",ws=>{ws.send(JSON.stringify({type:"status",running:!!botProc}));ws.send(JSON.stringify({type:"logs",data:botLogs}));});

// ── SCHEDULE ──
setInterval(()=>{
  if(!cfg.scheduleRestart||!cfg.scheduleTime)return;
  const[h,m]=cfg.scheduleTime.split(":").map(Number),now=new Date();
  if(now.getHours()===h&&now.getMinutes()===m&&now.getSeconds()<10&&botProc){stopBot();setTimeout(()=>startBot("schedule"),3000);log("⏰ Scheduled restart","warn");}
},10000);

server.listen(PORT,()=>console.log("Panel: http://localhost:"+PORT));

// ════════════════════════════════════════
// HTML
// ════════════════════════════════════════
function loginHTML(){return `<!DOCTYPE html><html lang="bn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Panel — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070e;font-family:'Segoe UI',sans-serif;overflow:hidden}
.bg{position:fixed;inset:0}
.orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.18;animation:fl 8s ease-in-out infinite}
.o1{width:500px;height:500px;background:#6c63ff;top:-150px;left:-150px}
.o2{width:350px;height:350px;background:#ff6584;bottom:-100px;right:-100px;animation-delay:4s}
.o3{width:200px;height:200px;background:#43e97b;top:40%;left:45%;animation-delay:2s}
@keyframes fl{0%,100%{transform:scale(1) rotate(0deg)}50%{transform:scale(1.2) rotate(10deg)}}
.card{position:relative;z-index:1;background:rgba(255,255,255,.04);backdrop-filter:blur(40px);border:1px solid rgba(255,255,255,.08);border-radius:28px;padding:52px 40px;width:90%;max-width:400px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.logo{width:90px;height:90px;margin:0 auto 22px;background:linear-gradient(135deg,#6c63ff,#ff6584);border-radius:26px;display:flex;align-items:center;justify-content:center;font-size:40px;box-shadow:0 0 60px rgba(108,99,255,.5);animation:pulse 3s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 40px rgba(108,99,255,.4)}50%{box-shadow:0 0 90px rgba(108,99,255,.9)}}
h1{color:#fff;font-size:24px;font-weight:900;margin-bottom:4px}
.sub{color:rgba(255,255,255,.3);font-size:13px;margin-bottom:36px}
input{width:100%;padding:15px 18px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#fff;font-size:15px;outline:none;margin-bottom:14px;transition:.3s;letter-spacing:.5px}
input:focus{border-color:#6c63ff;background:rgba(108,99,255,.1);box-shadow:0 0 0 3px rgba(108,99,255,.15)}
.btn{width:100%;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#6c63ff,#ff6584);color:#fff;font-size:16px;font-weight:800;cursor:pointer;transition:.3s}
.btn:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(108,99,255,.5)}
.btn:active{transform:translateY(0)}
.err{background:rgba(255,85,85,.1);border:1px solid rgba(255,85,85,.2);color:#ff8080;padding:11px;border-radius:10px;font-size:13px;margin-bottom:14px;display:none}
.err.show{display:block}
</style></head><body>
<div class="bg"><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div></div>
<div class="card">
  <div class="logo">🤖</div>
  <h1>Bot Panel</h1>
  <p class="sub">তোমার বট কন্ট্রোল সেন্টার</p>
  <div class="err" id="err"></div>
  <input type="password" id="pw" placeholder="🔐 পাসওয়ার্ড লিখুন" autofocus>
  <button class="btn" onclick="login()">প্রবেশ করুন →</button>
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
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#07070e">
<title>${pname}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#07070e;--s1:#0d0d18;--s2:#141424;--s3:#1a1a2e;--bd:#232338;--tx:#dde0f0;--mu:#5a5a80;--ac:#6c63ff;--gr:#3ecf8e;--rd:#f05252;--yw:#f0b429;--bl:#38bdf8;--or:#fb923c}
body{background:var(--bg);color:var(--tx);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}

/* TOP BAR */
.top{position:fixed;top:0;left:0;right:0;height:54px;background:rgba(13,13,24,.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 14px;z-index:200;gap:10px}
.top-logo{width:34px;height:34px;background:linear-gradient(135deg,var(--ac),#ff6584);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;box-shadow:0 0 20px rgba(108,99,255,.4)}
.top-name{font-size:15px;font-weight:800;color:#fff;flex:1}
.top-pill{display:flex;align-items:center;gap:6px;background:var(--s2);border:1px solid var(--bd);border-radius:99px;padding:5px 12px;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--rd);flex-shrink:0;transition:.3s}
.dot.on{background:var(--gr);box-shadow:0 0 8px var(--gr);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.top-out{padding:7px 12px;border-radius:8px;border:1px solid rgba(240,82,82,.3);background:transparent;color:var(--rd);font-size:12px;cursor:pointer;transition:.2s}
.top-out:hover{background:rgba(240,82,82,.1)}

/* BOTTOM TAB */
.tabs{position:fixed;bottom:0;left:0;right:0;background:rgba(13,13,24,.97);backdrop-filter:blur(20px);border-top:1px solid var(--bd);display:grid;grid-template-columns:repeat(5,1fr);height:60px;z-index:200;padding-bottom:env(safe-area-inset-bottom)}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;border:none;background:transparent;color:var(--mu);transition:.2s;position:relative}
.tab.active{color:var(--ac)}
.tab .ti{font-size:22px;line-height:1}
.tab .tl{font-size:9px;font-weight:700;letter-spacing:.3px}
.tab::after{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:2px;background:var(--ac);border-radius:0 0 3px 3px;transition:.2s}
.tab.active::after{width:40px}

/* PAGES */
.main{padding:66px 12px 72px;min-height:100vh}
.page{display:none}.page.active{display:block}
.pg-title{font-size:16px;font-weight:800;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* STAT CARDS */
.sg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.sc{background:linear-gradient(135deg,var(--s2),var(--s3));border:1px solid var(--bd);border-radius:16px;padding:14px;transition:.2s}
.sc:hover{border-color:var(--ac);transform:translateY(-1px)}
.sc-i{font-size:26px;margin-bottom:6px}
.sc-v{font-size:22px;font-weight:900;color:#fff}
.sc-l{font-size:11px;color:var(--mu);margin-top:2px}

/* BOT CONTROL */
.bc{background:var(--s2);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}
.bst{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding:12px;background:var(--s3);border-radius:12px}
.bst-info{flex:1}
.bst-txt{font-size:14px;font-weight:700}
.bst-up{font-size:11px;color:var(--mu);margin-top:2px}
.bg2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bg3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px}
.btn{width:100%;padding:12px 8px;border-radius:12px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:.2s;display:flex;align-items:center;justify-content:center;gap:5px}
.btn:active{transform:scale(.96)}
.b-start{background:linear-gradient(135deg,#3ecf8e,#22d3ee);color:#000}
.b-stop{background:linear-gradient(135deg,#f05252,#fb7185);color:#fff}
.b-restart{background:linear-gradient(135deg,#f0b429,#fb923c);color:#000}
.b-npm{background:linear-gradient(135deg,#38bdf8,#6c63ff);color:#fff}
.b-backup{background:linear-gradient(135deg,#a78bfa,#ec4899);color:#fff}
.b-ghost{background:transparent;border:1px solid var(--bd);color:var(--tx)}
.b-danger{background:transparent;border:1px solid rgba(240,82,82,.3);color:var(--rd)}

/* TOGGLE */
.tog-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--bd);margin-top:8px}
.tog{position:relative;width:44px;height:24px;flex-shrink:0}
.tog input{display:none}
.tog-bg{position:absolute;inset:0;background:var(--bd);border-radius:99px;cursor:pointer;transition:.3s}
.tog input:checked+.tog-bg{background:var(--gr)}
.tog-dot{position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:.3s;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.tog input:checked~.tog-dot{transform:translateX(20px)}

/* COOKIE SECTION */
.cookie-box{background:var(--s2);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}
.cookie-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.cookie-sub{font-size:12px;color:var(--mu);margin-bottom:12px}
textarea.cookie-input{width:100%;height:90px;background:var(--s3);border:1px solid var(--bd);border-radius:12px;padding:12px;color:var(--tx);font-family:'Courier New',monospace;font-size:11px;resize:none;outline:none;transition:.2s;line-height:1.5}
textarea.cookie-input:focus{border-color:var(--ac)}

/* HISTORY */
.hist{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto}
.hi{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--s2);border-radius:10px;border:1px solid var(--bd);font-size:11px}
.hi-date{color:var(--mu);flex:1}
.hi-up{color:var(--gr);font-weight:700}
.hi-code{color:var(--yw)}

/* LOGS */
.log-bar{display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;padding-bottom:2px}
.log-bar::-webkit-scrollbar{display:none}
.lf{padding:6px 12px;border-radius:8px;border:1px solid var(--bd);background:transparent;color:var(--mu);font-size:12px;cursor:pointer;white-space:nowrap;transition:.15s}
.lf.on{background:var(--ac);color:#fff;border-color:var(--ac)}
.lf:hover:not(.on){color:var(--tx)}
.lbox{background:#020209;border:1px solid var(--bd);border-radius:14px;padding:12px;height:calc(100vh - 200px);overflow-y:auto;font-family:'Courier New',monospace;font-size:11.5px}
.lbox::-webkit-scrollbar{width:3px}
.lbox::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px}
.le{display:flex;gap:6px;padding:2px 0;line-height:1.65}
.lt{color:var(--mu);white-space:nowrap;font-size:10px;flex-shrink:0}
.lx{word-break:break-all}
.li .lx{color:#9ca3af}
.ls .lx{color:var(--gr)}
.lr .lx{color:var(--rd)}
.lw .lx{color:var(--yw)}

/* FILE MANAGER */
.pathbar{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--mu);margin-bottom:10px;overflow-x:auto;white-space:nowrap;display:flex;align-items:center;gap:4px}
.pathbar::-webkit-scrollbar{display:none}
.pp{color:var(--ac);cursor:pointer;font-weight:600}
.pp:hover{text-decoration:underline}
.fm-acts{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.tbtn{padding:8px 13px;border-radius:9px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:12px;cursor:pointer;white-space:nowrap;transition:.15s;display:inline-flex;align-items:center;gap:4px}
.tbtn:hover{background:var(--s3)}
.tbtn.p{background:var(--ac);border-color:var(--ac);color:#fff}
.tbtn.d{border-color:rgba(240,82,82,.3);color:var(--rd)}
.tbtn.d:hover{background:rgba(240,82,82,.08)}
.sinput{width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-size:13px;outline:none;margin-bottom:10px;transition:.2s}
.sinput:focus{border-color:var(--ac)}
.flist{background:var(--s2);border:1px solid var(--bd);border-radius:14px;overflow:hidden}
.frow{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.03);cursor:pointer;transition:.12s}
.frow:last-child{border-bottom:none}
.frow:active{background:rgba(108,99,255,.07)}
.fi{font-size:20px;flex-shrink:0;width:26px;text-align:center}
.fn{flex:1;overflow:hidden}
.fn-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.fn-meta{font-size:10px;color:var(--mu);margin-top:2px}
.fa{display:flex;gap:3px;flex-shrink:0}
.fab{padding:6px 8px;border-radius:7px;border:none;background:var(--s3);color:var(--mu);font-size:12px;cursor:pointer;transition:.12s}
.fab:hover{background:var(--bd);color:var(--tx)}
.fab.del:hover{background:rgba(240,82,82,.15);color:var(--rd)}
.empty-fm{padding:48px;text-align:center;color:var(--mu)}
.empty-fm .ei{font-size:44px;margin-bottom:10px}

/* EDITOR */
.ed-top{background:var(--s2);border:1px solid var(--bd);border-radius:14px 14px 0 0;padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ed-fn{flex:1;font-size:12px;color:var(--ac);font-weight:700;overflow:hidden;text-overflow:ellipsis}
.ed-lang{font-size:10px;color:var(--mu);background:var(--s3);padding:3px 8px;border-radius:6px}
#ced{width:100%;height:calc(100vh - 230px);background:#010108;border:1px solid var(--bd);border-top:none;border-radius:0 0 14px 14px;padding:14px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:none;outline:none;tab-size:2}

/* UPLOAD */
.upzone{border:2px dashed var(--bd);border-radius:18px;padding:48px 20px;text-align:center;cursor:pointer;background:var(--s2);transition:.3s;margin-bottom:14px}
.upzone:active,.upzone.drag{border-color:var(--ac);background:rgba(108,99,255,.06)}
.uz-i{font-size:54px;margin-bottom:14px;animation:bounce 2s ease-in-out infinite}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.prog-wrap{background:var(--s2);border:1px solid var(--bd);border-radius:14px;padding:18px;display:none}
.prog-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px}
.prog-bg{background:var(--bd);border-radius:99px;height:8px;overflow:hidden}
.prog{height:100%;background:linear-gradient(90deg,var(--ac),var(--gr));border-radius:99px;transition:width .2s;width:0}

/* ENV */
#envEd{width:100%;height:260px;background:#010108;border:1px solid var(--bd);border-radius:12px;padding:14px;color:#e6edf3;font-family:'Courier New',monospace;font-size:13px;line-height:1.8;resize:vertical;outline:none;margin-bottom:10px;transition:.2s}
#envEd:focus{border-color:var(--ac)}

/* SETTINGS */
.set-card{background:var(--s2);border:1px solid var(--bd);border-radius:16px;padding:16px;margin-bottom:12px}
.set-title{font-size:13px;font-weight:700;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.set-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04);gap:10px}
.set-row:last-child{border-bottom:none;padding-bottom:0}
.sr-l{font-size:13px;flex:1}
.sr-s{font-size:11px;color:var(--mu);margin-top:2px}
.sinp{padding:8px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--s1);color:var(--tx);font-size:12px;outline:none;max-width:160px;transition:.2s}
.sinp:focus{border-color:var(--ac)}

/* MODAL */
.mbg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:500;align-items:flex-end;justify-content:center;backdrop-filter:blur(6px)}
.mbg.open{display:flex}
.modal{background:var(--s2);border:1px solid var(--bd);border-radius:22px 22px 0 0;padding:24px;width:100%;max-width:520px;animation:mIn .25s ease;padding-bottom:max(24px,env(safe-area-inset-bottom))}
@keyframes mIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
.modal h3{font-size:15px;font-weight:800;margin-bottom:16px;color:#fff;text-align:center}
.modal input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--bd);background:var(--s1);color:var(--tx);font-size:14px;outline:none;margin-bottom:12px;transition:.2s}
.modal input:focus{border-color:var(--ac)}
.modal-btns{display:flex;gap:8px}

/* TOAST */
.tw{position:fixed;top:62px;right:12px;display:flex;flex-direction:column;gap:6px;z-index:999;pointer-events:none;max-width:260px}
.toast{background:var(--s3);border-radius:12px;padding:10px 14px;font-size:12px;animation:tIn .3s ease;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:auto;border-left:3px solid var(--bd)}
@keyframes tIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
.toast.success{border-left-color:var(--gr);color:var(--gr)}
.toast.error{border-left-color:var(--rd);color:var(--rd)}
.toast.warn{border-left-color:var(--yw);color:var(--yw)}

/* SEARCH RESULTS */
.srow{padding:12px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:10px;margin-bottom:6px;cursor:pointer;transition:.12s}
.srow:active{background:var(--s3)}
.srow-p{font-size:11px;color:var(--ac);margin-bottom:3px;font-weight:600}
.srow-m{font-size:12px;color:var(--mu)}
</style></head><body>

<!-- TOP -->
<div class="top">
  <div class="top-logo">🤖</div>
  <div class="top-name">${pname}</div>
  <div class="top-pill"><div class="dot" id="tDot"></div><span id="tStatus">লোড...</span></div>
  <button class="top-out" onclick="location.href='/logout'">বের হন</button>
</div>

<!-- MAIN -->
<div class="main">

<!-- HOME -->
<div id="pg-home" class="page active">
  <div class="sg">
    <div class="sc"><div class="sc-i">💾</div><div class="sc-v" id="cMem">--</div><div class="sc-l">Memory MB</div></div>
    <div class="sc"><div class="sc-i">⏱️</div><div class="sc-v" id="cSup">--</div><div class="sc-l">Server Uptime</div></div>
    <div class="sc"><div class="sc-i">📦</div><div class="sc-v" id="cFiles">--</div><div class="sc-l">বট ফাইল</div></div>
    <div class="sc"><div class="sc-i">🚀</div><div class="sc-v" id="cStarts">--</div><div class="sc-l">মোট Start</div></div>
  </div>

  <!-- COOKIE QUICK ADD -->
  <div class="cookie-box">
    <div class="cookie-title">🍪 Facebook Cookie / Appstate</div>
    <div class="cookie-sub">Cookie বা appstate.json paste করুন → বট চালু করুন</div>
    <textarea class="cookie-input" id="cookieInput" placeholder='[{"key":"c_user","value":"..."}] অথবা plain cookie string'></textarea>
    <button class="btn b-start" style="margin-top:8px" onclick="saveCookie()">✅ Cookie সেভ ও বট চালু করুন</button>
  </div>

  <!-- BOT CONTROL -->
  <div class="bc">
    <div class="bst">
      <div class="dot" id="sDot"></div>
      <div class="bst-info">
        <div class="bst-txt" id="sTxt">চেক করছে...</div>
        <div class="bst-up" id="sUp"></div>
      </div>
    </div>
    <div class="bg2">
      <button class="btn b-start"   onclick="botAct('start')">▶ চালু</button>
      <button class="btn b-stop"    onclick="botAct('stop')">⏹ বন্ধ</button>
    </div>
    <div class="bg3" style="margin-top:8px">
      <button class="btn b-restart" onclick="botAct('restart')">🔄 রিস্টার্ট</button>
      <button class="btn b-npm"     onclick="npmInst()">📦 npm</button>
      <button class="btn b-backup"  onclick="doBackup()">💾 Backup</button>
    </div>
    <div class="tog-row">
      <div><div style="font-size:13px;font-weight:600">Auto Restart</div><div style="font-size:11px;color:var(--mu);margin-top:2px">Crash হলে অটো চালু</div></div>
      <label class="tog"><input type="checkbox" id="arTog" onchange="toggleAR(this.checked)"><div class="tog-bg"></div><div class="tog-dot"></div></label>
    </div>
  </div>

  <!-- HISTORY -->
  <div class="bc">
    <div class="pg-title">📈 Restart ইতিহাস</div>
    <div class="hist" id="histList"><div style="font-size:12px;color:var(--mu);text-align:center;padding:16px">লোড হচ্ছে...</div></div>
  </div>
</div>

<!-- LOGS -->
<div id="pg-logs" class="page">
  <div class="log-bar">
    <button class="lf on" onclick="setLF('all',this)">📋 সব</button>
    <button class="lf" onclick="setLF('success',this)">✅ Success</button>
    <button class="lf" onclick="setLF('error',this)">❌ Error</button>
    <button class="lf" onclick="setLF('warn',this)">⚠️ Warning</button>
    <button class="lf" onclick="clearLogs()">🗑 মুছুন</button>
    <button class="lf" onclick="window.open('/api/bot/downloadlog')">⬇️ Download</button>
  </div>
  <div class="lbox" id="lbox"></div>
</div>

<!-- FILES -->
<div id="pg-files" class="page">
  <div id="edView" style="display:none">
    <div class="ed-top">
      <button class="tbtn" onclick="closeEd()">← ফিরে</button>
      <span class="ed-fn" id="edFn"></span>
      <span class="ed-lang" id="edLang"></span>
      <button class="tbtn p" onclick="saveFile()">💾 সেভ</button>
      <button class="tbtn" onclick="dlF(curEdit)">⬇️</button>
    </div>
    <textarea id="ced" spellcheck="false"></textarea>
  </div>
  <div id="fmView">
    <div class="pathbar" id="pathBar">📁 root</div>
    <div class="fm-acts">
      <button class="tbtn p" onclick="showM('mkdir')">📁+</button>
      <button class="tbtn p" onclick="showM('newfile')">📄+</button>
      <button class="tbtn" onclick="loadFiles(curDir)">🔄</button>
    </div>
    <input class="sinput" type="text" id="fq" placeholder="🔍 ফাইল খোঁজুন..." oninput="doFS()">
    <div id="fsRes" style="display:none;margin-bottom:10px"></div>
    <div class="flist" id="flist"></div>
  </div>
</div>

<!-- UPLOAD -->
<div id="pg-upload" class="page">
  <div class="pg-title">⬆️ আপলোড</div>
  <div class="upzone" id="upZone" onclick="document.getElementById('fInp').click()">
    <div class="uz-i">📦</div>
    <div style="font-size:15px;font-weight:700;margin-bottom:6px">ক্লিক বা ড্র্যাগ করুন</div>
    <div style="color:var(--mu);font-size:13px">ZIP আপলোড করলে অটো extract হবে</div>
    <div style="color:var(--bl);font-size:12px;margin-top:8px;font-weight:600">সর্বোচ্চ ৫০০MB • GitHub এর মতো সাজানো হবে</div>
  </div>
  <input type="file" id="fInp" style="display:none" onchange="uploadF(this.files[0])">
  <div class="prog-wrap" id="progWrap">
    <div class="prog-top"><span id="upFN">আপলোড হচ্ছে...</span><span id="upPct">0%</span></div>
    <div class="prog-bg"><div class="prog" id="progBar"></div></div>
    <div id="upSt" style="font-size:12px;color:var(--mu);margin-top:6px"></div>
  </div>
</div>

<!-- MORE -->
<div id="pg-more" class="page">
  <!-- ENV -->
  <div class="set-card">
    <div class="set-title">⚙️ Environment (.env)</div>
    <textarea id="envEd" spellcheck="false" placeholder="TOKEN=xxx&#10;COOKIE=xxx&#10;PREFIX=!&#10;ADMIN_ID=123456"></textarea>
    <div style="display:flex;gap:8px">
      <button class="tbtn p" onclick="saveEnv()">💾 সেভ</button>
      <button class="tbtn" onclick="loadEnv()">🔄 রিলোড</button>
    </div>
  </div>
  <!-- SETTINGS -->
  <div class="set-card">
    <div class="set-title">🔧 Settings</div>
    <div class="set-row">
      <div><div class="sr-l">Panel নাম</div></div>
      <input class="sinp" type="text" id="sName" placeholder="${pname}">
    </div>
    <div class="set-row">
      <div><div class="sr-l">Auto Restart</div><div class="sr-s">Crash হলে অটো</div></div>
      <label class="tog"><input type="checkbox" id="sAR" onchange="toggleAR(this.checked)"><div class="tog-bg"></div><div class="tog-dot"></div></label>
    </div>
    <div class="set-row">
      <div><div class="sr-l">Schedule Restart</div><div class="sr-s">প্রতিদিন নির্দিষ্ট সময়ে</div></div>
      <label class="tog"><input type="checkbox" id="sSched"><div class="tog-bg"></div><div class="tog-dot"></div></label>
    </div>
    <div class="set-row">
      <div><div class="sr-l">Restart সময়</div></div>
      <input class="sinp" type="time" id="sTime" value="03:00">
    </div>
    <div style="margin-top:14px">
      <button class="tbtn p" onclick="saveSettings()">💾 সেভ</button>
    </div>
  </div>
  <!-- PASSWORD -->
  <div class="set-card">
    <div class="set-title">🔐 পাসওয়ার্ড পরিবর্তন</div>
    <div class="set-row"><div class="sr-l">বর্তমান</div><input class="sinp" type="password" id="sCur" placeholder="বর্তমান"></div>
    <div class="set-row"><div class="sr-l">নতুন</div><input class="sinp" type="password" id="sNew" placeholder="নতুন (কমপক্ষে ৪)"></div>
    <div style="margin-top:14px"><button class="tbtn p" onclick="changePw()">🔐 পরিবর্তন</button></div>
  </div>
  <!-- MAINTENANCE -->
  <div class="set-card">
    <div class="set-title">🛠️ Maintenance</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="tbtn" onclick="doBackup()">💾 Full Backup</button>
      <button class="tbtn d" onclick="clearLogFile()">🗑 Log মুছুন</button>
    </div>
  </div>
</div>

</div>

<!-- BOTTOM TABS -->
<div class="tabs">
  <button class="tab active" onclick="goTab('home',this)"><span class="ti">🏠</span><span class="tl">হোম</span></button>
  <button class="tab" onclick="goTab('logs',this)"><span class="ti">📋</span><span class="tl">লগ</span></button>
  <button class="tab" onclick="goTab('files',this)"><span class="ti">📁</span><span class="tl">ফাইল</span></button>
  <button class="tab" onclick="goTab('upload',this)"><span class="ti">⬆️</span><span class="tl">আপলোড</span></button>
  <button class="tab" onclick="goTab('more',this)"><span class="ti">⚙️</span><span class="tl">আরো</span></button>
</div>

<!-- MODALS -->
<div class="mbg" id="mod-mkdir"><div class="modal"><h3>📁 নতুন ফোল্ডার</h3><input type="text" id="mkN" placeholder="ফোল্ডারের নাম"><div class="modal-btns"><button class="tbtn" onclick="closeM('mkdir')">বাতিল</button><button class="tbtn p" onclick="doMkdir()">তৈরি করুন</button></div></div></div>
<div class="mbg" id="mod-newfile"><div class="modal"><h3>📄 নতুন ফাইল</h3><input type="text" id="nfN" placeholder="ফাইলের নাম (test.js)"><div class="modal-btns"><button class="tbtn" onclick="closeM('newfile')">বাতিল</button><button class="tbtn p" onclick="doNewFile()">তৈরি করুন</button></div></div></div>
<div class="mbg" id="mod-rename"><div class="modal"><h3>✏️ নাম পরিবর্তন</h3><input type="text" id="rnV" placeholder="নতুন নাম"><div class="modal-btns"><button class="tbtn" onclick="closeM('rename')">বাতিল</button><button class="tbtn p" onclick="doRename()">পরিবর্তন</button></div></div></div>

<div class="tw" id="tw"></div>

<script>
// STATE
let curDir="",curEdit="",renameFrom="",logFilter="all",autoScroll=true;
let ws;

// TABS
function goTab(id,btn){
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.getElementById("pg-"+id).classList.add("active");
  if(id==="files") loadFiles(curDir);
  if(id==="more"){loadEnv();loadSettings();}
  if(id==="logs") document.getElementById("lbox").scrollTop=document.getElementById("lbox").scrollHeight;
}

// WS
function connectWS(){
  const proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(proto+"://"+location.host);
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==="log") appendLog(m.data);
    if(m.type==="logs"){document.getElementById("lbox").innerHTML="";m.data.forEach(appendLog);}
    if(m.type==="status") updateStatus(m.running);
    if(m.type==="clearLogs") document.getElementById("lbox").innerHTML="";
  };
  ws.onclose=()=>setTimeout(connectWS,3000);
}

function appendLog(e){
  if(logFilter!=="all"&&e.type!==logFilter)return;
  const box=document.getElementById("lbox");
  const d=document.createElement("div");
  const cls={info:"li",success:"ls",error:"lr",warn:"lw"}[e.type||"info"]||"li";
  d.className="le "+cls; d.dataset.t=e.type||"info";
  d.innerHTML='<span class="lt">'+e.time+'</span><span class="lx">'+esc(e.text)+'</span>';
  box.appendChild(d);
  if(autoScroll) box.scrollTop=box.scrollHeight;
}

function esc(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function setLF(f,btn){logFilter=f;document.querySelectorAll(".lf").forEach(b=>b.classList.remove("on"));btn.classList.add("on");document.querySelectorAll(".le").forEach(el=>el.style.display=(f==="all"||el.dataset.t===f)?"flex":"none");}
function clearLogs(){fetch("/api/bot/clearlogs",{method:"POST"});}
function clearLogFile(){if(!confirm("Log file মুছবেন?"))return;fetch("/api/bot/clearlogfile",{method:"POST"}).then(r=>r.json()).then(d=>toast(d.ok?"✅ মুছা হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error"));}

// STATUS
function updateStatus(running){
  [document.getElementById("sDot"),document.getElementById("tDot")].forEach(d=>{if(d){d.className="dot"+(running?" on":"");}});
  const st=document.getElementById("sTxt");if(st) st.textContent=running?"✅ বট চলছে":"🔴 বট বন্ধ";
  const ts=document.getElementById("tStatus");if(ts) ts.textContent=running?"✅ চলছে":"🔴 বন্ধ";
}

function fmtT(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return h>0?h+"h "+m+"m":m>0?m+"m "+sc+"s":sc+"s";}
function fsz(b){if(!b||b===0)return"—";if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB";}
function fdt(d){try{return new Date(d).toLocaleDateString("bn-BD",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}catch{return"";}}

async function refresh(){
  try{
    const[st,bs]=await Promise.all([fetch("/api/stats").then(r=>r.json()),fetch("/api/bot/status").then(r=>r.json())]);
    document.getElementById("cMem").textContent=st.memMB||"--";
    document.getElementById("cSup").textContent=fmtT(st.serverUptime||0);
    document.getElementById("cFiles").textContent=st.botFiles||0;
    document.getElementById("cStarts").textContent=st.starts||0;
    updateStatus(bs.running);
    const sup=document.getElementById("sUp");
    if(sup) sup.textContent=bs.running&&bs.uptime>0?"⏱ চলছে: "+fmtT(bs.uptime):"";
    [document.getElementById("arTog"),document.getElementById("sAR")].forEach(el=>{if(el)el.checked=st.autoRestart||false;});
    const hist=(st.history||[]).slice().reverse().slice(0,8);
    const hl=document.getElementById("histList");
    if(hl) hl.innerHTML=hist.length
      ?hist.map(h=>'<div class="hi"><span class="hi-date">'+new Date(h.date).toLocaleString("bn-BD").substring(0,16)+'</span><span class="hi-up">'+fmtT(h.uptime)+'</span><span class="hi-code">'+h.code+'</span></div>').join("")
      :'<div style="font-size:12px;color:var(--mu);text-align:center;padding:12px">কোনো ইতিহাস নেই</div>';
  }catch{}
}

// BOT
async function botAct(a){
  toast("⏳ "+{start:"চালু",stop:"বন্ধ",restart:"রিস্টার্ট"}[a]+" করছে...","warn");
  const d=await fetch("/api/bot/"+a,{method:"POST"}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
  setTimeout(refresh,2500);
}
async function npmInst(){toast("📦 npm install শুরু...","warn");const d=await fetch("/api/bot/install",{method:"POST"}).then(r=>r.json());toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");}
function doBackup(){window.open("/api/backup");}
async function toggleAR(v){
  await fetch("/api/bot/autorestart",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:v})});
  toast(v?"✅ Auto Restart চালু":"⚠️ Auto Restart বন্ধ",v?"success":"warn");
  [document.getElementById("arTog"),document.getElementById("sAR")].forEach(el=>{if(el)el.checked=v;});
}

// COOKIE
async function saveCookie(){
  const c=document.getElementById("cookieInput").value.trim();
  if(!c)return toast("❌ Cookie লিখুন","error");
  const d=await fetch("/api/cookie/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cookie:c})}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
  if(d.ok){document.getElementById("cookieInput").value="";setTimeout(()=>botAct("start"),1000);}
}

// FILE ICONS
function ficon(name,isDir){
  if(isDir)return"📁";
  const e=name.split(".").pop().toLowerCase();
  return{js:"📜",mjs:"📜",cjs:"📜",json:"📋",md:"📝",txt:"📄",env:"🔐",log:"📋",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",webp:"🖼",mp3:"🎵",mp4:"🎬",zip:"📦",tar:"📦",gz:"📦",html:"🌐",css:"🎨",ts:"📘",py:"🐍",sh:"⚡",bat:"⚡",yml:"⚙️",yaml:"⚙️",xml:"📋",lock:"🔒",gitignore:"👁️",npmrc:"⚙️"}[e]||"📄";
}

function langFromExt(n){const e=n.split(".").pop().toLowerCase();return{js:"JavaScript",json:"JSON",md:"Markdown",html:"HTML",css:"CSS",py:"Python",ts:"TypeScript",sh:"Shell",env:"ENV",txt:"Text",yml:"YAML",xml:"XML",gitignore:"GitIgnore"}[e]||e.toUpperCase();}

function buildPath(dir){
  const bar=document.getElementById("pathBar");
  const parts=dir?dir.split("/"):[];
  let html='<span class="pp" onclick="loadFiles(\\'\\')">📁 root</span>';
  let acc="";
  parts.forEach(p=>{acc+=(acc?"/":"")+p;const c=acc;html+='<span style="color:var(--mu)"> / </span><span class="pp" onclick="loadFiles(\\''+c+'\\')">'+p+'</span>';});
  bar.innerHTML=html;
}

async function loadFiles(dir){
  curDir=dir||"";buildPath(curDir);
  document.getElementById("fmView").style.display="block";
  document.getElementById("edView").style.display="none";
  document.getElementById("fsRes").style.display="none";
  document.getElementById("fq").value="";
  const data=await fetch("/api/files?path="+encodeURIComponent(curDir)).then(r=>r.json());
  const list=document.getElementById("flist");list.innerHTML="";
  if(curDir){
    const up=document.createElement("div");up.className="frow";
    up.innerHTML='<span class="fi">⬆️</span><div class="fn"><div class="fn-name">.. উপরে যান</div></div>';
    up.onclick=()=>loadFiles(curDir.split("/").slice(0,-1).join("/"));
    list.appendChild(up);
  }
  if(!data.items?.length){list.innerHTML='<div class="empty-fm"><div class="ei">📭</div><div>ফোল্ডার খালি</div></div>';return;}
  data.items.forEach(item=>{
    const fp=curDir?curDir+"/"+item.name:item.name;
    const row=document.createElement("div");row.className="frow";
    row.innerHTML='<span class="fi">'+ficon(item.name,item.isDir)+'</span>'
      +'<div class="fn"><div class="fn-name">'+item.name+'</div><div class="fn-meta">'+fsz(item.size)+(item.mtime?" · "+fdt(item.mtime):"")+'</div></div>'
      +'<div class="fa">'
      +(item.isDir?'':'<button class="fab" onclick="event.stopPropagation();editF(\\''+fp+'\\')">✏️</button>')
      +'<button class="fab" onclick="event.stopPropagation();dlF(\\''+fp+'\\')">⬇️</button>'
      +'<button class="fab" onclick="event.stopPropagation();showRename(\\''+fp+'\\',\\''+item.name+'\\')">🔤</button>'
      +'<button class="fab del" onclick="event.stopPropagation();delItem(\\''+fp+'\\',\\''+item.name+'\\')">🗑</button>'
      +'</div>';
    if(item.isDir) row.onclick=()=>loadFiles(fp);
    else row.onclick=()=>editF(fp);
    list.appendChild(row);
  });
}

async function editF(p){
  const d=await fetch("/api/file/read?path="+encodeURIComponent(p)).then(r=>r.json());
  if(d.error)return toast("❌ "+d.error,"error");
  curEdit=p;
  document.getElementById("edFn").textContent=p.split("/").pop();
  document.getElementById("edLang").textContent=langFromExt(p);
  document.getElementById("ced").value=d.content;
  document.getElementById("fmView").style.display="none";
  document.getElementById("edView").style.display="block";
}
function closeEd(){document.getElementById("edView").style.display="none";document.getElementById("fmView").style.display="block";}
async function saveFile(){
  const d=await fetch("/api/file/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:curEdit,content:document.getElementById("ced").value})}).then(r=>r.json());
  toast(d.ok?"✅ সেভ হয়েছে":"❌ "+d.error,d.ok?"success":"error");
}
function dlF(p){window.open("/api/file/download?path="+encodeURIComponent(p));}
async function delItem(p,name){
  if(!confirm('"'+name+'" ডিলিট করবেন?'))return;
  const d=await fetch("/api/file/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})}).then(r=>r.json());
  toast(d.ok?"🗑 ডিলিট":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);
}

// FILE SEARCH
let fst;
function doFS(){
  const q=document.getElementById("fq").value.trim();
  const res=document.getElementById("fsRes");
  if(!q){res.style.display="none";return;}
  clearTimeout(fst);fst=setTimeout(async()=>{
    const d=await fetch("/api/file/search?q="+encodeURIComponent(q)).then(r=>r.json());
    if(!d.results?.length){res.style.display="block";res.innerHTML='<div style="font-size:12px;color:var(--mu);padding:10px;text-align:center">📭 পাওয়া যায়নি</div>';return;}
    res.style.display="block";
    res.innerHTML=d.results.map(r=>'<div class="srow" onclick="'+(r.isDir?"loadFiles('"+r.path+"')":"editF('"+r.path+"')")+'"><div class="srow-p">'+ficon(r.name,r.isDir)+" "+r.path+'</div><div class="srow-m">'+fsz(r.size)+'</div></div>').join("");
  },300);
}

// MODALS
function showM(id){document.getElementById("mod-"+id).classList.add("open");setTimeout(()=>document.querySelector("#mod-"+id+" input")?.focus(),100);}
function closeM(id){document.getElementById("mod-"+id).classList.remove("open");}
async function doMkdir(){const n=document.getElementById("mkN").value.trim();if(!n)return;const fp=curDir?curDir+"/"+n:n;const d=await fetch("/api/file/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp})}).then(r=>r.json());closeM("mkdir");toast(d.ok?"📁 তৈরি":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);}
async function doNewFile(){const n=document.getElementById("nfN").value.trim();if(!n)return;const fp=curDir?curDir+"/"+n:n;const d=await fetch("/api/file/newfile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp,content:""})}).then(r=>r.json());closeM("newfile");if(d.ok){toast("📄 তৈরি","success");editF(fp);}else toast("❌ "+d.error,"error");}
function showRename(p,name){renameFrom=p;document.getElementById("rnV").value=name;showM("rename");}
async function doRename(){const n=document.getElementById("rnV").value.trim();if(!n)return;const dir=renameFrom.includes("/")?renameFrom.split("/").slice(0,-1).join("/"):"";const to=dir?dir+"/"+n:n;const d=await fetch("/api/file/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:renameFrom,to})}).then(r=>r.json());closeM("rename");toast(d.ok?"✅ নাম পরিবর্তন":"❌ "+d.error,d.ok?"success":"error");if(d.ok)loadFiles(curDir);}

// UPLOAD
async function uploadF(file){
  if(!file)return;
  const pw=document.getElementById("progWrap"),pb=document.getElementById("progBar"),pp=document.getElementById("upPct"),ps=document.getElementById("upSt"),fn=document.getElementById("upFN");
  pw.style.display="block";fn.textContent=file.name;pb.style.width="0%";pp.textContent="0%";ps.textContent="প্রস্তুত হচ্ছে...";
  const fd=new FormData();fd.append("file",file);fd.append("path",curDir||"");
  const xhr=new XMLHttpRequest();xhr.open("POST","/api/file/upload");
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);pb.style.width=p+"%";pp.textContent=p+"%";ps.textContent=fsz(e.loaded)+" / "+fsz(e.total);}};
  xhr.onload=()=>{
    const d=JSON.parse(xhr.responseText);
    if(d.ok){pb.style.width="100%";pp.textContent="100%";ps.innerHTML='<span style="color:var(--gr)">✅ '+(d.msg||"সম্পন্ন")+'</span>';toast("✅ "+(d.msg||"আপলোড সম্পন্ন"),"success");}
    else{ps.innerHTML='<span style="color:var(--rd)">❌ '+(d.error||"ব্যর্থ")+'</span>';toast("❌ "+(d.error||"আপলোড ব্যর্থ"),"error");}
    document.getElementById("fInp").value="";
  };
  xhr.onerror=()=>{ps.innerHTML='<span style="color:var(--rd)">❌ নেটওয়ার্ক সমস্যা</span>';};
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
async function loadSettings(){
  const d=await fetch("/api/settings").then(r=>r.json());
  document.getElementById("sName").value=d.panelName||"";
  document.getElementById("sAR").checked=d.autoRestart||false;
  document.getElementById("sSched").checked=d.scheduleRestart||false;
  document.getElementById("sTime").value=d.scheduleTime||"03:00";
}
async function saveSettings(){
  const body={panelName:document.getElementById("sName").value,autoRestart:document.getElementById("sAR").checked,scheduleRestart:document.getElementById("sSched").checked,scheduleTime:document.getElementById("sTime").value};
  const d=await fetch("/api/settings/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
  toast(d.ok?"✅ সেভ হয়েছে":"❌ ব্যর্থ",d.ok?"success":"error");
}
async function changePw(){
  const d=await fetch("/api/settings/password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current:document.getElementById("sCur").value,newPass:document.getElementById("sNew").value})}).then(r=>r.json());
  toast(d.ok?"✅ "+d.msg:"❌ "+d.msg,d.ok?"success":"error");
  if(d.ok){document.getElementById("sCur").value="";document.getElementById("sNew").value="";}
}

// TOAST
function toast(msg,type="success"){
  const w=document.getElementById("tw"),el=document.createElement("div");
  el.className="toast "+type;el.textContent=msg;w.appendChild(el);
  setTimeout(()=>{el.style.opacity="0";el.style.transition=".3s";setTimeout(()=>el.remove(),300);},4000);
}

// KEYBOARD
document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==="s"&&curEdit){e.preventDefault();saveFile();}
  if(e.key==="Escape") document.querySelectorAll(".mbg.open").forEach(m=>m.classList.remove("open"));
});

// INIT
connectWS();
refresh();
setInterval(refresh,10000);
</script>
</body></html>`;}
