import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);
const browserWss = new WebSocketServer({ noServer: true });
const PORT = Number(process.env.PORT || 3000);
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

app.use(express.static("public"));
app.get("/api/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

const arr = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch {} }
  return [];
};
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function eventText(e) {
  const tags = arr(e.tags).map(t => typeof t === "string" ? t : t?.label || t?.slug || "").join(" ");
  return [e.title, e.slug, e.description, e.series?.title, e.sport?.name, tags].filter(Boolean).join(" ").toLowerCase();
}
function isSport(e, sport) {
  const t = eventText(e);
  if (sport === "soccer") return /soccer|football|premier league|epl|la liga|champions league|serie a|bundesliga|mls|uefa|fa cup/.test(t);
  if (sport === "cricket") return /cricket|ipl|t20|odi|test match|big bash|ashes|ranji/.test(t);
  if (sport === "tennis") return /tennis|atp|wta|challenger|wimbledon|roland garros|us open|australian open|grand slam/.test(t);
  return false;
}
function liveFlag(e) {
  const blob = JSON.stringify([e.live, e.ended, e.eventMetadata, e.sportsMarketType, e.series]).toLowerCase();
  return e.live === true || (e.ended === false && (/\blive\b|in-play|inplay/.test(eventText(e)) || blob.includes('"live":true')));
}
function outcomeTokens(m) {
  // Polymarket CLOB tokens map to actual market outcomes. Only YES/NO markets
  // can be treated as binary YES/NO directly; team/player outcomes must retain their labels.
  const outcomes = arr(m.outcomes);
  const ids = arr(m.clobTokenIds ?? m.clob_token_ids);
  const paired = outcomes.map((label, i) => ({ label: String(label), tokenId: ids[i] ? String(ids[i]) : "" }))
    .filter(x => x.tokenId);
  const yi = paired.findIndex(x => x.label.toLowerCase() === "yes");
  const ni = paired.findIndex(x => x.label.toLowerCase() === "no");
  if (yi >= 0 && ni >= 0) return { kind: "binary", yesToken: paired[yi].tokenId, noToken: paired[ni].tokenId, outcomes: paired };
  return { kind: "outcomes", yesToken: "", noToken: "", outcomes: paired };
}
function normalizeMarket(m) {
  const mapped = outcomeTokens(m);
  return {
    id: String(m.id || m.conditionId || m.slug || ""),
    question: String(m.question || m.groupItemTitle || m.slug || "Market"),
    slug: String(m.slug || ""),
    marketType: mapped.kind,
    outcomes: mapped.outcomes,
    yesToken: mapped.yesToken,
    noToken: mapped.noToken,
    volume: num(m.volumeNum ?? m.volume) ?? 0,
    liquidity: num(m.liquidityNum ?? m.liquidity) ?? 0
  };
}
function normalizeEvent(e) {
  const markets = arr(e.markets).filter(m => m && m.active !== false && m.closed !== true)
    .map(normalizeMarket)
    .filter(m => m.outcomes.length > 0);
  return {
    id: String(e.id || e.slug || ""),
    title: String(e.title || e.slug || "Match"),
    slug: String(e.slug || ""),
    live: liveFlag(e),
    markets
  };
}
app.get("/api/events", async (req, res) => {
  const sport = String(req.query.sport || "soccer").toLowerCase();
  if (!["soccer", "cricket", "tennis"].includes(sport)) return res.status(400).json({ error: "Invalid sport" });
  try {
    // Parallel event pages keep initial discovery responsive. This is not a guarantee of every live event.
    const pages = await Promise.all([0, 100, 200, 300, 400].map(async offset => {
      const u = new URL("/events", GAMMA);
      for (const [k, v] of Object.entries({ active: "true", closed: "false", limit: "100", offset: String(offset), order: "volume24hr", ascending: "false" })) u.searchParams.set(k, v);
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    }));
    const seen = new Set();
    const events = pages.flat().filter(e => {
      const id = String(e?.id || e?.slug || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return e && e.closed !== true && e.active !== false && isSport(e, sport);
    }).map(normalizeEvent).filter(e => e.markets.length);
    events.sort((a, b) => Number(b.live) - Number(a.live));
    res.json({ sport, events, liveCount: events.filter(e => e.live).length, checkedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: "Event discovery failed", detail: e.message });
  }
});
app.get("/api/book/:token", async (req, res) => {
  try {
    const u = new URL("/book", CLOB);
    u.searchParams.set("token_id", req.params.token);
    const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw Error(`CLOB ${r.status}`);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: "Book request failed", detail: e.message });
  }
});

const browserClients = new Set();
const subscribedTokens = new Set();
let upstream;
let reconnectTimer;
function sendAll(payload) {
  const raw = JSON.stringify(payload);
  for (const client of browserClients) if (client.readyState === WebSocket.OPEN) client.send(raw);
}
function sendSubscription(ids) {
  if (!ids.length || upstream?.readyState !== WebSocket.OPEN) return;
  for (let i = 0; i < ids.length; i += 300) {
    upstream.send(JSON.stringify({ assets_ids: ids.slice(i, i + 300), type: "market", custom_feature_enabled: true }));
  }
}
function connectUpstream() {
  clearTimeout(reconnectTimer);
  upstream = new WebSocket(CLOB_WS);
  upstream.on("open", () => {
    sendAll({ kind: "feed", status: "connected" });
    sendSubscription([...subscribedTokens]);
    upstream.pingTimer = setInterval(() => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send("PING");
    }, 10000);
  });
  upstream.on("message", raw => {
    const text = raw.toString();
    if (text === "PONG" || text === "pong") return;
    try { sendAll({ kind: "market", data: JSON.parse(text), receivedAt: Date.now() }); } catch {}
  });
  upstream.on("close", () => {
    clearInterval(upstream?.pingTimer);
    sendAll({ kind: "feed", status: "reconnecting" });
    reconnectTimer = setTimeout(connectUpstream, 1000);
  });
  upstream.on("error", () => { try { upstream?.close(); } catch {} });
}
browserWss.on("connection", ws => {
  browserClients.add(ws);
  ws.send(JSON.stringify({ kind: "feed", status: upstream?.readyState === WebSocket.OPEN ? "connected" : "connecting" }));
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.kind !== "subscribe" || !Array.isArray(msg.tokens)) return;
      const fresh = msg.tokens.map(String).filter(t => t && !subscribedTokens.has(t));
      fresh.forEach(t => subscribedTokens.add(t));
      sendSubscription(fresh);
    } catch {}
  });
  ws.on("close", () => browserClients.delete(ws));
});
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") browserWss.handleUpgrade(req, socket, head, ws => browserWss.emit("connection", ws, req));
  else socket.destroy();
});
connectUpstream();
server.listen(PORT, () => console.log(`Speed-test dashboard listening on ${PORT}`));
