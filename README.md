# Polymarket Live Speed Test

Minimal white-background, read-only dashboard for Soccer, Cricket, and Tennis.

## Run
Requires Node.js 20+.
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Market mapping
Polymarket markets do not all use YES/NO outcomes. This project maps `outcomes[i]` to `clobTokenIds[i]` and preserves the actual labels. Only markets whose actual outcomes are YES and NO receive binary BACK/LAY-equivalent columns. Team/player/other multi-outcome markets show each real outcome and its own best ask and decimal odds; the app does not fabricate a NO price.

## Speed test
Open the same market and same token on the official website and dashboard. The public WebSocket feed shows order-book updates; the displayed render time is local UI render time, not end-to-end exchange latency. Compare repeated price changes before concluding which view is faster.

## Limits
The public Gamma discovery currently fetches the first 500 active events ordered by 24-hour volume. Public API coverage and live-status metadata may be incomplete. No orders are placed, and no private API credentials are needed for this read-only market-data display.
