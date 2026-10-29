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
function eventTeams(title) {
  return String(title||"").replace(/^.*?:\\s*/,"").split(/\\s+(?:vs\\.?|v\\.?|versus)\\s+/i).map(x=>x.trim()).filter(Boolean);
}
function isMoneylineMarket(m,event) {
  const q=[m.question,m.groupItemTitle,m.slug,m.marketMetadata?.opticOddsSelection].filter(Boolean).join(" ").toLowerCase();
  const outcomes=arr(m.outcomes).map(x=>String(x?.label??x).trim().toLowerCase());
  const teams=eventTeams(event.title).map(x=>x.toLowerCase().replace(/[^a-z0-9]+/g," ").trim());
  const qn=" "+q.replace(/[^a-z0-9]+/g," ").trim()+" ";
  const teamOutcomeCount=teams.length===2?teams.filter(t=>outcomes.some(o=>o.replace(/[^a-z0-9]+/g," ").trim()===t)).length:0;
  const hasWinnerLanguage=/\\b(moneyline|match winner|match result|to win|win the match|winner)\\b/.test(q);
  const namesTeam=teams.some(t=>t&&qn.includes(" "+t+" "));
  const excluded=/\\b(over|under|total|handicap|spread|correct score|exact score|both teams|half.?time|first half|corners|cards|aces|sets|games|map|round|player prop|innings|wickets|run line|run total)\\b/.test(q);
  return !excluded && (teamOutcomeCount===2 || (hasWinnerLanguage&&namesTeam));
}
function normalizeEvent(e) {
  const markets=arr(e.markets)
    .filter(m=>m&&m.active!==false&&m.closed!==true&&isMoneylineMarket(m,e))
    .map(normalizeMarket).filter(m=>m.outcomes.length);
  return {
    id:String(e.id||e.slug||""), title:String(e.title||e.slug||"Match"),
    slug:String(e.slug||""), live:e.live===true||String(e.live).toLowerCase()==="true",
    markets
  };
}
async function fetchLiveEvents(sport) {
  // Ask Gamma for live events and require an explicit live flag. Scheduled matches
  // are not treated as live based only on start/end times.
  const url=new URL("/events",GAMMA);
  for(const [k,v] of Object.entries({active:"true",closed:"false",live:"true",limit:"500",offset:"0"})) url.searchParams.set(k,v);
  const response=await fetch(url,{signal:AbortSignal.timeout(TIMEOUT_MS),headers:{accept:"application/json"}});
  if(!response.ok) {
    const body=(await response.text()).slice(0,300);
    throw new Error("Gamma API HTTP "+response.status+(body?": "+body:""));
  }
  const data=await response.json();
  if(!Array.isArray(data)) throw new Error("Gamma API returned unexpected response");
  const seen=new Set();
  const events=data.filter(e=>{
    const id=String(e?.id||e?.slug||""); if(!id||seen.has(id)) return false; seen.add(id);
    const explicitLive=e.live===true||String(e.live).toLowerCase()==="true";
    return explicitLive&&e.closed!==true&&e.active!==false&&isSport(e,sport);
  }).map(normalizeEvent).filter(e=>e.markets.length);
  console.log("[events] sport="+sport+" gammaLiveRecords="+data.length+" liveMoneylineMatches="+events.length);
  return events;
}
app.get("/api/events",async(req,res)=>{
  const sport=String(req.query.sport||"soccer").toLowerCase();
  if(!["soccer","cricket","tennis"].includes(sport))return res.status(400).json({error:"Invalid sport"});
  const started=Date.now();
  try{
    const events=await fetchLiveEvents(sport);
    console.log("[events] sport="+sport+" count="+events.length+" durationMs="+(Date.now()-started));
    res.set("Cache-Control","no-store").json({sport,events,liveCount:events.length,checkedAt:Date.now(),source:"Gamma live events, one 500-event discovery page"});
  }catch(error){
    const detail=error?.name==="TimeoutError"||error?.name==="AbortError"?"Gamma API timed out after "+TIMEOUT_MS+"ms":String(error?.message||error);
    console.error("[events] sport="+sport+" failed after "+(Date.now()-started)+"ms: "+detail);
    res.status(502).json({error:"Event discovery failed",detail});
  }
});
app.listen(PORT,()=>console.log("Polymarket read-only odds dashboard listening on "+PORT));
