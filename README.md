# Polymarket Live Odds

Minimal white-background, read-only dashboard for live Soccer, Cricket, and Tennis markets.

## Run
Requires Node.js 20+.
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Data sources and latency
- Gamma API discovers active, non-closed events and their market/token metadata. It requests one 500-item page without the rejected `order`/`ascending` parameters, then filters returned records to `live=true`; discovery coverage is limited to that page.
- The selected match uses one public CLOB market WebSocket for its outcome tokens. The socket closes when leaving the match or choosing another match.
- The dashboard is read-only and never places orders.
- Market WebSocket updates are the live price path. The event list is a discovery snapshot and currently refreshes when a sport is selected; it does not poll continuously in the background.

## Market mapping
Polymarket markets do not all use YES/NO outcomes. This project maps `outcomes[i]` to `clobTokenIds[i]` and preserves actual labels. It only displays outcomes that can be reliably mapped to the selected match's moneyline; it does not fabricate prices for missing tokens or mix in unrelated prop markets.

## Speed testing
Open the same market and token on the official website and dashboard. The WebSocket delivers public order-book updates; the displayed local render time is not end-to-end exchange latency. Compare repeated changes on the same token before drawing conclusions.

## Known limitations
Gamma live-status metadata and sports naming can vary. A zero-result response means the current discovery query did not identify matching events; it is not proof that no real-world games are underway. The public API and upstream availability can affect discovery latency and coverage.
