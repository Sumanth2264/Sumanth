/**
 * CinePing API — Cloudflare Worker + D1 + Brevo
 * Free-first backend for the public GitHub Pages site.
 * Live movie data must come from an authorised provider/feed.
 */
const H = {
  "content-type":"application/json; charset=utf-8",
  "access-control-allow-origin":"*",
  "access-control-allow-methods":"GET,POST,OPTIONS",
  "access-control-allow-headers":"content-type,x-ingest-secret",
  "cache-control":"no-store"
};
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null,{headers:H});
    const u=new URL(request.url);
    try {
      if (request.method==="GET" && (u.pathname==="/"||u.pathname==="/health")) {
        const row=await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status != 'DELETED'").first();
        return json({ok:true,service:"CinePing",alerts:Number(row?.n||0)});
      }
      if (request.method==="POST" && u.pathname==="/alerts") return await createAlert(request,env);
      if (request.method==="GET" && u.pathname==="/alerts") return await listAlerts(request,env);
      if (request.method==="POST" && u.pathname==="/alerts/update") return await updateAlert(request,env);
      if (request.method==="POST" && u.pathname==="/ingest") return await ingest(request,env);
      return json({ok:false,error:"Not found"},404);
    } catch(e) {
      console.error(e);
      return json({ok:false,error:"Server error"},500);
    }
  },
  async scheduled(controller,env,ctx) {
    if (!env.CHECK_FEED_URL) return;
    ctx.waitUntil(checkFeed(env));
  }
};

async function createAlert(request,env){
  const b=await safeJson(request), email=normEmail(b.email), movie=clean(b.movie,140), city=clean(b.city,80);
  if (!validEmail(email)||!movie||!city) return json({ok:false,error:"Valid email, movie and city are required."},400);
  if (String(b.website||"").trim()) return json({ok:true});
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE email=?1 AND status IN ('ARMED','PAUSED')").bind(email).first();
  if(Number(count?.n||0)>=25) return json({ok:false,error:"Maximum 25 active alerts per email."},429);
  const last=await env.DB.prepare("SELECT created_at FROM alerts WHERE email=?1 ORDER BY created_at DESC LIMIT 1").bind(email).first();
  if(last?.created_at && Date.now()-Number(last.created_at)<600000) return json({ok:false,error:"Please wait a few minutes before creating another alert."},429);
  const id=crypto.randomUUID(), token=token_();
  await env.DB.prepare("INSERT INTO alerts (id,email,movie,city,theatres,language,format,time_pref,date_pref,sources,manage_token,status,created_at,last_match_key,last_match_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ARMED',?12,'',0)")
    .bind(id,email,movie,city,JSON.stringify(arr(b.theatres).slice(0,30)),clean(b.language,40)||"Any",clean(b.format,40)||"Any",clean(b.time,60)||"Any time",clean(b.date,60)||"Any date",JSON.stringify(arr(b.sources).slice(0,5)),token,Date.now()).run();
  await sendMail(env,email,"CinePing alert armed — "+movie,"<h2>CinePing alert armed</h2><p>Your watch for <b>"+html(movie)+"</b> in <b>"+html(city)+"</b> is active.</p><p>You'll be notified when an authorised showtime feed matches it.</p>");
  return json({ok:true,alertId:id,manageToken:token,status:"ARMED"});
}

async function listAlerts(request,env){
  const u=new URL(request.url),email=normEmail(u.searchParams.get("email")),token=String(u.searchParams.get("token")||"");
  if(!validEmail(email)||!token)return json({ok:false,error:"Email and token are required."},400);
  const rows=await env.DB.prepare("SELECT id,email,movie,city,theatres,language,format,time_pref,date_pref,sources,status,created_at,last_match_at FROM alerts WHERE email=?1 AND manage_token=?2 AND status!='DELETED' ORDER BY created_at DESC").bind(email,token).all();
  return json({ok:true,alerts:(rows.results||[]).map(r=>({id:r.id,email:r.email,movie:r.movie,city:r.city,theatres:safeJson(r.theatres,[]),language:r.language,format:r.format,time:r.time_pref,date:r.date_pref,sources:safeJson(r.sources,[]),status:r.status,createdAt:r.created_at,lastMatchAt:r.last_match_at}))});
}

async function updateAlert(request,env){
  const b=await safeJson(request),id=clean(b.alertId,100),token=clean(b.manageToken,120),action=String(b.action||"").toLowerCase();
  if(!id||!token||!["pause","resume","delete"].includes(action)) return json({ok:false,error:"Invalid alert update."},400);
  const status=action==="delete"?"DELETED":action==="pause"?"PAUSED":"ARMED";
  const r=await env.DB.prepare("UPDATE alerts SET status=?1 WHERE id=?2 AND manage_token=?3").bind(status,id,token).run();
  if(!r.meta?.changes)return json({ok:false,error:"Alert not found."},404);
  return json({ok:true,status});
}

async function ingest(request,env){
  if((request.headers.get("x-ingest-secret")||"")!==String(env.INGEST_SECRET||""))return json({ok:false,error:"Unauthorised"},401);
  const b=await safeJson(request),shows=Array.isArray(b.shows)?b.shows.slice(0,5000):[];
  const rows=await env.DB.prepare("SELECT * FROM alerts WHERE status='ARMED'").all(); let sent=0;
  for(const a of rows.results||[]){
    const m=shows.find(s=>matches(a,s)); if(!m)continue;
    const key=b64([m.source,m.movie,m.city,m.theatre,m.date,m.time,m.bookingUrl].join("|"));
    if(a.last_match_key===key && Date.now()-Number(a.last_match_at||0)<86400000)continue;
    await sendMail(env,a.email,"CinePing match: "+a.movie,"<h2>🎬 CinePing match found</h2><p>Your watch for <b>"+html(a.movie)+"</b> matched a show.</p><p><b>"+html(m.theatre)+"</b><br>"+html(m.city)+" · "+html(m.date)+" · "+html(m.time)+"<br>"+html(m.language)+" · "+html(m.format)+" · "+html(m.source)+"</p>"+(m.bookingUrl?'<p><a href="'+html(m.bookingUrl)+'">Open official booking</a></p>':"")+"<p style='font-size:12px;color:#777'>Complete booking on the official provider website.</p>");
    await env.DB.prepare("UPDATE alerts SET last_match_key=?1,last_match_at=?2 WHERE id=?3").bind(key,Date.now(),a.id).run(); sent++;
  }
  return json({ok:true,matched:sent});
}

async function checkFeed(env){
  const r=await fetch(env.CHECK_FEED_URL,{headers:env.CHECK_FEED_HEADER?{Authorization:env.CHECK_FEED_HEADER}:{}});
  if(!r.ok)throw new Error("Feed HTTP "+r.status);
  const b=await r.json(); const fake=new Request("https://cineping.internal/ingest",{method:"POST",headers:{"content-type":"application/json","x-ingest-secret":String(env.INGEST_SECRET||"")},body:JSON.stringify({shows:Array.isArray(b)?b:b.shows})});
  await ingest(fake,env);
}

function matches(a,s){
  const same=(x,y)=>String(x||"").trim().toLowerCase()===String(y||"").trim().toLowerCase();
  if(!same(a.movie,s.movie)||!same(a.city,s.city))return false;
  const ts=safeJson(a.theatres,[]); if(ts.length&&!ts.some(t=>same(t,s.theatre)))return false;
  if(a.language&&a.language!=="Any"&&!same(a.language,s.language))return false;
  if(a.format&&a.format!=="Any"&&!same(a.format,s.format))return false;
  const ss=safeJson(a.sources,[]); if(ss.length&&!ss.some(x=>same(x,s.source)))return false;
  if(a.time_pref==="FDFS only"&&String(s.tag||"").toUpperCase()!=="FDFS")return false;
  return true;
}
async function sendMail(env,to,subject,htmlContent){
  if(!env.BREVO_API_KEY||!env.BREVO_FROM_EMAIL){console.log("BREVO_NOT_CONFIGURED",to,subject);return;}
  const r=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"content-type":"application/json","api-key":env.BREVO_API_KEY},body:JSON.stringify({sender:{name:env.BREVO_FROM_NAME||"CinePing",email:env.BREVO_FROM_EMAIL},to:[{email:to}],subject,htmlContent})});
  if(!r.ok)throw new Error("Brevo HTTP "+r.status);
}
async function safeJson(request){try{return await request.json()}catch{return {}}}
function json(x,status=200){return new Response(JSON.stringify(x),{status,headers:H})}
function normEmail(x){return String(x||"").trim().toLowerCase()}
function validEmail(x){return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(x)}
function clean(x,n){return String(x==null?"":x).replace(/[<>]/g,"").trim().slice(0,n)}
function arr(x){return Array.isArray(x)?x:[]}
function safeJson(x,f){try{return JSON.parse(String(x||""))||f}catch{return f}}
function b64(x){return btoa(unescape(encodeURIComponent(String(x))))}
function token_(){const a=new Uint8Array(32);crypto.getRandomValues(a);return b64(String.fromCharCode(...a))}
function html(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
