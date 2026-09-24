const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,x-ingest-secret","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8",...cors}});
const esc=s=>String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function send(env,to,subject,html){
  const r=await fetch("https://api.brevo.com/v3/smtp/email",{method:"POST",headers:{"content-type":"application/json","api-key":env.BREVO_API_KEY},body:JSON.stringify({sender:{email:env.BREVO_FROM_EMAIL,name:env.BREVO_FROM_NAME||"CinePing"},to:[{email:to}],subject,htmlContent:html})});
  if(!r.ok) throw new Error("mail failed");
}
function match(a,s){
  if(a.city && a.city.toLowerCase()!==s.city.toLowerCase()) return false;
  if(a.movie && a.movie.toLowerCase()!==s.movie.toLowerCase()) return false;
  const ts=JSON.parse(a.theatres||"[]");
  if(ts.length && !ts.some(x=>x.toLowerCase()===s.theatre.toLowerCase())) return false;
  if(a.language && a.language!=="Any" && !(s.languages||[]).includes(a.language)) return false;
  if(a.format && a.format!=="Any" && !(s.formats||[]).includes(a.format)) return false;
  if(a.time_pref==="FDFS only" && !s.isFdfs) return false;
  return true;
}
export default {async fetch(req,env){
  if(req.method==="OPTIONS") return new Response("",{headers:cors});
  const u=new URL(req.url);
  if(u.pathname==="/api/health") return json({ok:true,service:"cineping-alert-api"});
  if(u.pathname==="/api/alerts"&&req.method==="POST"){
    try{
      const b=await req.json();
      if(!b.email||!b.movie) return json({error:"email and movie are required"},400);
      const id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID();
      await env.DB.prepare("INSERT INTO alerts(id,email,movie,city,theatres,language,format,time_pref,source,status,manage_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))").bind(id,b.email.trim().toLowerCase(),b.movie.trim(),b.city||"",JSON.stringify(b.theatres||[]),b.language||"Any",b.format||"Any",b.time||"Any time",b.source||"Any","active",token).run();
      await send(env,b.email.trim().toLowerCase(),"CinePing alert armed","<p>Your alert for <strong>"+esc(b.movie)+"</strong> in <strong>"+esc(b.city||"India")+"</strong> is active.</p><p>CinePing will email you when an authorised showtime feed matches.</p>");
      return json({id},201);
    }catch(e){return json({error:"could not create alert"},500);}
  }
  if(u.pathname==="/api/provider-events"&&req.method==="POST"){
    if(req.headers.get("x-ingest-secret")!==env.INGEST_SECRET) return json({error:"unauthorized"},401);
    try{
      const b=await req.json(); if(!Array.isArray(b.shows)) return json({error:"shows[] required"},400);
      const all=await env.DB.prepare("SELECT * FROM alerts WHERE status='active'").all(); let sent=0;
      for(const s of b.shows){
        for(const a of (all.results||[])){
          if(!match(a,s)) continue;
          const key=a.id+"|"+(s.source||"")+"|"+(s.bookingUrl||"")+"|"+s.date+"|"+s.time;
          const exists=await env.DB.prepare("SELECT id FROM deliveries WHERE dedupe_key=?").bind(key).first();
          if(exists) continue;
          await send(env,a.email,"Tickets live: "+s.movie+" · "+s.theatre,"<p><strong>Tickets are live.</strong></p><p>"+esc(s.movie)+" · "+esc(s.theatre)+" · "+esc(s.date)+" · "+esc(s.time)+"</p>"+(s.bookingUrl?"<p><a href='"+esc(s.bookingUrl)+"'>Open official booking page →</a></p>":""));
          await env.DB.prepare("INSERT INTO deliveries(id,alert_id,dedupe_key,delivered_at) VALUES(?,?,?,datetime('now'))").bind(crypto.randomUUID(),a.id,key).run();
          sent++;
        }
      }
      return json({sent});
    }catch(e){return json({error:"ingest failed"},500);}
  }
  return json({error:"not found"},404);
}};