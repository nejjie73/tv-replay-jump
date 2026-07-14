# TV Replay Jump

A tiny userscript that adds a **Jump ▶** button to TradingView's chart: enter a
time (like `18:15`), click, and Bar Replay fast-forwards to the **next day's
candle at that time** — without resetting your replay session, trades, or P&L.

If you backtest with Bar Replay you know the problem: when you finish reviewing
a day, getting to the next session means either letting autoplay grind through
hundreds of bars (and often overshooting your spot), or using *select bar* —
which wipes your Replay Trading history. This fixes that.

## How it works

It drives the same internal "step forward" operation as the replay toolbar
button — just batched, so a full day of 1-minute bars lands in a couple of
server calls. Because it's *stepping*, TradingView treats it exactly like you
clicking forward, and your replay session stays intact. Landing is exact: it
never blind-crosses a session gap, so it stops on the first candle at/after
your preset time (Fridays with no evening session roll to Sunday's candle,
like the real tape).

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
   (Chrome / Edge / Firefox / Brave).
2. **Let Tampermonkey run userscripts** — Chrome and Edge block this by
   default, and the script will silently do nothing until you allow it:
   - Right-click the Tampermonkey icon → **Manage extension** → enable
     **Allow user scripts** (Chrome 138+ / recent Edge), **or**
   - open `chrome://extensions` (Edge: `edge://extensions`) and turn on
     **Developer mode** (top-right in Chrome, left sidebar in Edge).
   - Restart the browser after toggling. Firefox needs neither step.
3. Click **[Install TV Replay Jump](https://raw.githubusercontent.com/nejjie73/tv-replay-jump/main/TVReplayJump.user.js)**
   — Tampermonkey will show an install screen; click **Install**.
4. Open (or reload) any [TradingView chart](https://www.tradingview.com/chart/).
   The panel appears top-right (drag it by its header; ✕ hides it until the
   next reload).

Not seeing the panel? It's almost always step 2 — verify by clicking the
Tampermonkey icon while on the chart tab: it should list "TV Replay Jump"
as active with a badge count of 1.

Updates are automatic — Tampermonkey checks this repo and pulls new versions.

## Usage

- Start **Bar Replay** as usual and review your day.
- Set your time (it's remembered), hit **Jump ▶** or press Enter.
- Click again while it's running to cancel.
- Clicking while already sitting on the preset candle advances to the next day.

## Notes & limitations

- **Browser TradingView only** — the desktop app can't run userscripts.
- Minute-based chart timeframes (1m, 5m, 15m, 60m…). The time is interpreted
  in your **chart's timezone**.
- Same-day jumps are near-instant; jumps that cross the session close or a
  weekend take ~20–30 s while TradingView loads the data.
- Session-gap handling is tuned for CME-style hours (gaps begin 17:00 ET).
  Other assets work too; in rare cases a gap right before your target lands a
  few bars past it — the status line says so instead of skipping onward.
- How far back Bar Replay goes on intraday charts depends on your TradingView
  plan.
- Uses TradingView's internal (undocumented) replay API. It does nothing your
  own clicks wouldn't — but a TradingView update could break it someday. If it
  stops working, [open an issue](https://github.com/nejjie73/tv-replay-jump/issues).

Not affiliated with TradingView. Use at your own risk.

## License

MIT
