import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const GAMMA = "https://gamma-api.polymarket.com";
const TIMEOUT_MS = 8000;

app.use(express.static("public"));
app.get("/api/health", (_req,res) => res.json({ok:true,now:Date.now()}));

const arr = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const x=JSON.parse(v); return Array.isArray(x)?x:[]; } catch {} }
  return [];
};
function eventText(e) {
  const tags=arr(e.tags).map(t=>typeof t==="string"?t:(t?.label||t?.slug||"")).join(" ");
  return [e.title,e.slug,e.description,e.series?.title,e.sport?.name,tags].filter(Boolean).join(" ").toLowerCase();
}
function isSport(e,sport) {
  const t=eventText(e);
  if(sport==="soccer") return /soccer|football|premier league|epl|la liga|champions league|serie a|bundesliga|mls|uefa|fa cup|liga mx|copa/.test(t);
  if(sport==="cricket") return /cricket|\bipl\b|\bt20\b|\bodi\b|test match|big bash|ashes|ranji|county championship|women|\btest\b|one day cup|premier cup|premier league|super league|contintent cup|continental cup|world cup|sub regional qualifier|tour of|vs\.?|versus/.test(t);
  if(sport==="tennis") return /tennis|atp|wta|challenger|wimbledon|roland garros|us open|australian open|grand slam/.test(t);
  return false;
}
function normalizeMarket(m) {
  const outcomes=arr(m.outcomes), ids=arr(m.clobTokenIds ?? m.clob_token_ids);
  return {
    id:String(m.id||m.conditionId||m.slug||""),
    question:String(m.question||m.groupItemTitle||m.slug||""),
    selection:String(m.marketMetadata?.opticOddsSelection||m.groupItemTitle||""),
    slug:String(m.slug||""),
    outcomes:outcomes.map((label,i)=>({label:String(label),tokenId:ids[i]?String(ids[i]):""})).filter(o=>o.tokenId)
  };
}
function normalizeEvent(e) {
  return {
    id:String(e.id||e.slug||""), title:String(e.title||e.slug||"Match"),
    slug:String(e.slug||""), live:e.live===true||String(e.live).toLowerCase()==="true",
    markets:arr(e.markets).filter(m=>m&&m.active!==false&&m.closed!==true).map(normalizeMarket).filter(m=>m.outcomes.length)
  };
}
async function fetchLiveEvents(sport) {
  // /events supports active/closed/order/limit/offset. Do not send live=true:
  // that filter is not accepted consistently by Gamma's events endpoint (422).
  // Keep pages small and parallel so live events are not buried beyond page one.
  const pageSize=100;
  async function fetchPage(offset) {
    const url=new URL("/events",GAMMA);
    for(const [k,v] of Object.entries({
      active:"true",closed:"false",limit:String(pageSize),
      offset:String(offset),order:"volume_24hr",ascending:"false"
    })) url.searchParams.set(k,v);
    const response=await fetch(url,{signal:AbortSignal.timeout(TIMEOUT_MS),headers:{accept:"application/json"}});
    if(!response.ok) {
      const body=(await response.text()).slice(0,300);
      throw new Error("Gamma API HTTP "+response.status+(body?": "+body:""));
    }
    const data=await response.json();
    if(!Array.isArray(data)) throw new Error("Gamma API returned unexpected response");
    return data;
  }
  const pages=await Promise.allSettled([0,100,200,300,400].map(fetchPage));
  const all=[];
  const failures=[];
  for(let i=0;i<pages.length;i++){
    const p=pages[i];
    if(p.status==="fulfilled") all.push(...p.value);
    else failures.push("offset "+(i*pageSize)+": "+String(p.reason?.message||p.reason));
  }
  if(!all.length) throw new Error(failures.join("; ")||"Gamma returned no event records");
  if(failures.length) console.warn("[events] partial Gamma pages: "+failures.join(" | "));
  const seen=new Set();
  return all.filter(e=>{
    const id=String(e?.id||e?.slug||"");if(!id||seen.has(id))return false;seen.add(id);
    const title=String(e.title||"").trim();
    const isChildMarket=/\s-\s*(more markets|exact score|correct score|half.?time result|halftime result|first half|player props|corners|cards)\s*$/i.test(title);
    const isHeadToHead=/\b(vs\.?|v\.?|versus)\b/i.test(title);
    return (e.live===true||String(e.live).toLowerCase()==="true")&&e.closed!==true&&e.active!==false&&!isChildMarket&&(sport==="cricket"||isHeadToHead)&&isSport(e,sport);
  }).map(normalizeEvent).filter(e=>e.markets.length);
}
app.get("/api/events",async(req,res)=>{
  const sport=String(req.query.sport||"soccer").toLowerCase();
  if(!["soccer","cricket","tennis"].includes(sport))return res.status(400).json({error:"Invalid sport"});
  const started=Date.now();
  try{
    const events=await fetchLiveEvents(sport);
    console.log("[events] sport="+sport+" count="+events.length+" durationMs="+(Date.now()-started));
    res.set("Cache-Control","no-store").json({sport,events,liveCount:events.length,checkedAt:Date.now(),source:"Gamma live events, single-page 500 cap"});
  }catch(error){
    const detail=error?.name==="TimeoutError"||error?.name==="AbortError"?"Gamma API timed out after "+TIMEOUT_MS+"ms":String(error?.message||error);
    console.error("[events] sport="+sport+" failed after "+(Date.now()-started)+"ms: "+detail);
    res.status(502).json({error:"Event discovery failed",detail});
  }
});
app.listen(PORT,()=>console.log("Polymarket read-only odds dashboard listening on "+PORT));
