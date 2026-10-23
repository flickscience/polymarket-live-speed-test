
import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);
const browserWss = new WebSocketServer({ noServer: true });
const PORT = Number(process.env.PORT || 3000);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const REQUEST_TIMEOUT_MS = 15000;

app.use(express.static("public"));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: Date.now() });
});

const arr = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function eventText(e) {
  const tags = arr(e.tags)
    .map(t => typeof t === "string" ? t : t?.label || t?.slug || "")
    .join(" ");

  return [
    e.title,
    e.slug,
    e.description,
    e.series?.title,
    e.sport?.name,
    tags
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSport(e, sport) {
  const t = eventText(e);

  if (sport === "soccer") {
    return /soccer|football|premier league|epl|la liga|champions league|serie a|bundesliga|mls|uefa|fa cup/.test(t);
  }

  if (sport === "cricket") {
    return /cricket|ipl|t20|odi|test match|big bash|ashes|ranji/.test(t);
  }

  if (sport === "tennis") {
    return /tennis|atp|wta|challenger|wimbledon|roland garros|us open|australian open|grand slam/.test(t);
  }

  return false;
}

function outcomeTokens(m) {
  const outcomes = arr(m.outcomes);
  const ids = arr(m.clobTokenIds ?? m.clob_token_ids);

  const paired = outcomes
    .map((label, i) => ({
      label: String(label),
      tokenId: ids[i] ? String(ids[i]) : ""
    }))
    .filter(x => x.tokenId);

  const yi = paired.findIndex(
    x => x.label.toLowerCase() === "yes"
  );

  const ni = paired.findIndex(
    x => x.label.toLowerCase() === "no"
  );

  if (yi >= 0 && ni >= 0) {
    return {
      kind: "binary",
      yesToken: paired[yi].tokenId,
      noToken: paired[ni].tokenId,
      outcomes: paired
    };
  }

  return {
    kind: "outcomes",
    yesToken: "",
    noToken: "",
    outcomes: paired
  };
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
  const markets = arr(e.markets)
    .filter(m => m && m.active !== false && m.closed !== true)
    .map(normalizeMarket)
    .filter(m => m.outcomes.length > 0);

  return {
    id: String(e.id || e.slug || ""),
    title: String(e.title || e.slug || "Match"),
    slug: String(e.slug || ""),
    live: e.live === true || String(e.live).toLowerCase() === "true",
    markets
  };
}

async function fetchLiveEvents(sport) {
  const url = new URL("/events", GAMMA);

  const params = {
    active: "true",
    closed: "false",
    live: "true",
    limit: "100",
    order: "volume24hr",
    ascending: "false"
  };

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Gamma API HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Gamma API returned an unexpected response");
  }

  const seen = new Set();

  return data
    .filter(e => {
      const id = String(e?.id || e?.slug || "");

      if (!id || seen.has(id)) return false;
      seen.add(id);

      const isLive =
        e?.live === true ||
        String(e?.live).toLowerCase() === "true";

      return (
        isLive &&
        e.closed !== true &&
        e.active !== false &&
        isSport(e, sport)
      );
    })
    .map(normalizeEvent)
    .filter(e => e.markets.length > 0);
}

app.get("/api/events", async (req, res) => {
  const sport = String(req.query.sport || "soccer").toLowerCase();

  if (!["soccer", "cricket", "tennis"].includes(sport)) {
    return res.status(400).json({ error: "Invalid sport" });
  }

  const started = Date.now();

  try {
    const events = await fetchLiveEvents(sport);

    console.log(
      `[events] sport=${sport} count=${events.length} durationMs=${Date.now() - started}`
    );

    res.json({
      sport,
      events,
      liveCount: events.length,
      checkedAt: Date.now(),
      source: "Gamma live=true"
    });
  } catch (error) {
    const detail =
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? `Gamma API timed out after ${REQUEST_TIMEOUT_MS}ms`
        : String(error?.message || error);

    console.error(
      `[events] sport=${sport} failed after ${Date.now() - started}ms: ${detail}`
    );

    res.status(502).json({
      error: "Event discovery failed",
      detail
    });
  }
});

const browserClients = new Set();
const subscribedTokens = new Set();

let upstream;
let reconnectTimer;
let pingTimer;

function sendAll(payload) {
  const raw = JSON.stringify(payload);

  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function sendSubscription(ids) {
  if (!ids.length || upstream?.readyState !== WebSocket.OPEN) return;

  for (let i = 0; i < ids.length; i += 300) {
    upstream.send(JSON.stringify({
      assets_ids: ids.slice(i, i + 300),
      type: "market",
      custom_feature_enabled: true
    }));
  }
}

function connectUpstream() {
  clearTimeout(reconnectTimer);

  try {
    upstream?.terminate();
  } catch {}

  upstream = new WebSocket(CLOB_WS);

  upstream.on("open", () => {
    console.log("[clob-ws] connected");

    sendAll({ kind: "feed", status: "connected" });
    sendSubscription([...subscribedTokens]);

    clearInterval(pingTimer);

    pingTimer = setInterval(() => {
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send("PING");
      }
    }, 10000);
  });

  upstream.on("message", raw => {
    const message = raw.toString();

    if (message === "PONG" || message === "pong") return;

    try {
      sendAll({
        kind: "market",
        data: JSON.parse(message),
        receivedAt: Date.now()
      });
    } catch {}
  });

  upstream.on("close", () => {
    clearInterval(pingTimer);

    sendAll({ kind: "feed", status: "reconnecting" });

    reconnectTimer = setTimeout(connectUpstream, 2000);
  });

  upstream.on("error", error => {
    console.error(`[clob-ws] ${error.message}`);

    try {
      upstream?.close();
    } catch {}
  });
}

browserWss.on("connection", ws => {
  browserClients.add(ws);

  ws.send(JSON.stringify({
    kind: "feed",
    status: upstream?.readyState === WebSocket.OPEN
      ? "connected"
      : "connecting"
  }));

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.kind !== "subscribe" || !Array.isArray(msg.tokens)) {
        return;
      }

      const fresh = msg.tokens
        .map(String)
        .filter(t => t && !subscribedTokens.has(t));

      fresh.forEach(t => subscribedTokens.add(t));

      sendSubscription(fresh);
    } catch {}
  });

  ws.on("close", () => {
    browserClients.delete(ws);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    browserWss.handleUpgrade(req, socket, head, ws => {
      browserWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

connectUpstream();

server.listen(PORT, () => {
  console.log(`Speed-test dashboard listening on ${PORT}`);
});
