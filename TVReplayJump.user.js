// ==UserScript==
// @name         TV Replay Jump
// @namespace    tv-replay-jump
// @version      1.2.1
// @description  Jump TradingView bar replay to the next preset-time candle or the next break of a defined range, plus a P&L ledger that survives replay resets — never lose your replay trading results again.
// @match        https://www.tradingview.com/chart/*
// @match        https://*.tradingview.com/chart/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/nejjie73/tv-replay-jump/main/TVReplayJump.user.js
// @downloadURL  https://raw.githubusercontent.com/nejjie73/tv-replay-jump/main/TVReplayJump.user.js
// @supportURL   https://github.com/nejjie73/tv-replay-jump/issues
// ==/UserScript==

// Batch-steps TV's bar replay using the same internal operation as the
// toolbar's step-forward button (so replay history/P&L is preserved), but
// server-batched. v1.1 adds Range Break mode: define a range window and jump
// straight to the next break of its high/low, with a per-day break cap and a
// cutoff time. Uses TV's undocumented replay API: may break after a
// TradingView update. Not affiliated with TradingView.
(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const GAP_START_ET = 17 * 60;
  const etFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const uw = v => (v && typeof v.value === 'function') ? v.value() : v;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const S = { cancel: false, busy: false, panel: null, dismissed: false };

  function todMin(sec, fmt) {
    let h = 0, m = 0;
    for (const p of fmt.formatToParts(new Date(sec * 1000))) {
      if (p.type === 'hour') h = +p.value;
      if (p.type === 'minute') m = +p.value;
    }
    return (h % 24) * 60 + m;
  }

  function resToMinutes(res) {
    if (/^\d+$/.test(res)) return +res;
    return null;
  }

  async function getCtx(setStatus) {
    const api = W.TradingViewApi;
    const ra = await api.replayApi();
    if (!uw(ra.isReplayStarted())) { setStatus('Replay is not active', true); return null; }
    const ch = api.activeChart();
    const barMin = resToMinutes(String(ch.resolution()));
    if (barMin === null) { setStatus('Chart must be on a minute-based timeframe', true); return null; }
    let tz = 'America/New_York';
    try { tz = ch.getTimezoneApi().getTimezone().id || tz; } catch (e) {}
    return {
      ra, barMin, tz,
      mgr: ra._replayUIController._replayManager,
      tzF: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }),
      showF: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }),
      cur() { return uw(this.ra.currentDate()); },
      fmt(sec) { return this.showF.format(new Date(sec * 1000)); }
    };
  }

  // Step `chunk` bars, then wait out the position update: the step promise can
  // resolve before currentDate moves, and during gap/weekend data loads
  // currentDate streams stale values — require it to advance and hold still.
  async function stepAndSettle(ctx, chunk, crossing) {
    const cur = ctx.cur();
    try { await ctx.mgr.doReplayStep(chunk); }
    catch (e) { return null; }
    let next = ctx.cur();
    const t0 = Date.now();
    while ((typeof next !== 'number' || next <= cur) && Date.now() - t0 < (crossing ? 45000 : 8000)) {
      await sleep(300);
      next = ctx.cur();
    }
    const stableMs = crossing ? 1500 : 350;
    let lastChange = Date.now();
    const tStable = Date.now();
    while (Date.now() - lastChange < stableMs && Date.now() - tStable < 30000) {
      await sleep(200);
      const again = ctx.cur();
      if (again !== next) { next = again; lastChange = Date.now(); }
    }
    return (typeof next === 'number' && next > cur) ? next : null;
  }

  // Advance to the next wall-clock occurrence of presetMin (chart tz).
  // Absolute-target: never rolls to the following day once the target is
  // passed; forward retarget only when the occurrence had no bar (weekend)
  // and the tape reopened before the preset time-of-day.
  async function jumpToTod(ctx, presetMin, setStatus) {
    let cur = ctx.cur();
    if (typeof cur !== 'number') { setStatus('Cannot read replay position', true); return null; }

    let d0 = (presetMin - todMin(cur, ctx.tzF) + 1440) % 1440;
    if (d0 === 0) d0 = 1440;
    let T = (Math.floor(cur / 60) + d0) * 60;

    for (let iter = 0; iter < 80; iter++) {
      if (S.cancel) { setStatus('Cancelled at ' + ctx.fmt(cur), true); return null; }

      const tod = todMin(cur, ctx.tzF);
      if (cur >= T) {
        const past = (tod - presetMin + 1440) % 1440;
        if (past < ctx.barMin) return cur;          // first bar at/after preset
        const ahead = (presetMin - tod + 1440) % 1440;
        if (ahead > 0 && ahead <= 720) {
          T = (Math.floor(cur / 60) + ahead) * 60;  // reopened before preset → same-session retarget
        } else {
          setStatus('Landed: ' + ctx.fmt(cur) + ' (' + past + 'm past preset — gap/holiday)', false, true);
          return cur;                               // overshoot: stop, never roll a day
        }
      }

      let dist = (presetMin - tod + 1440) % 1440;
      if (dist === 0) dist = 1440;
      let toGap = (GAP_START_ET - todMin(cur, etFmt) + 1440) % 1440;
      if (toGap === 0) toGap = 1440;

      const crossing = dist > toGap;
      const chunk = Math.max(1, Math.ceil(Math.min(dist, toGap) / ctx.barMin));
      setStatus('Stepping ' + chunk + ' bars from ' + ctx.fmt(cur) + '…');
      const next = await stepAndSettle(ctx, chunk, crossing);
      if (next === null) { setStatus('Reached end of data at ' + ctx.fmt(cur), true); return null; }
      cur = next;
    }
    setStatus('Gave up after 80 batches at ' + ctx.fmt(cur), true);
    return null;
  }

  async function jump(presetMin, setStatus, statusEl) {
    const ctx = await getCtx(setStatus);
    if (!ctx) return;
    const landed = await jumpToTod(ctx, presetMin, setStatus);
    if (landed !== null && !/past preset/.test(statusEl.textContent))
      setStatus('Landed: ' + ctx.fmt(landed), false, true);
  }

  // ---------- Range Break mode ----------

  function readBarsSince(epoch) {
    const out = [];
    try {
      const cw = W.TradingViewApi.activeChart()._chartWidget;
      cw.model().model().mainSeries().bars().each((i, v) => {
        const b = Array.isArray(v) ? v : (v && v.value);
        if (b && typeof b[0] === 'number' && b[0] >= epoch) out.push(b);
        return false;
      });
    } catch (e) {}
    return out;   // ascending [t, o, h, l, c, v]
  }

  // Break events over bars after the range window. A side re-arms only after
  // price comes fully back inside the range. byClose: a break requires the
  // bar to CLOSE beyond the range (a full bar-interval spent outside), not
  // just a wick pierce; re-arm is then close-based too.
  function scanBreaks(bars, H, L, byClose) {
    let state = 'inside';
    const ev = [];
    for (const b of bars) {
      const hi = byClose ? b[4] : b[2], lo = byClose ? b[4] : b[3];
      if (state === 'inside') {
        const up = hi > H, dn = lo < L;
        if (up || dn) {
          const dir = (up && dn) ? (b[4] >= b[1] ? 'up' : 'down') : (up ? 'up' : 'down');
          ev.push({ t: b[0], dir });
          state = dir === 'up' ? 'out_up' : 'out_down';
        }
      } else if (state === 'out_up') {
        if (lo < L) { ev.push({ t: b[0], dir: 'down' }); state = 'out_down'; }
        else if (hi <= H) state = 'inside';
      } else {
        if (hi > H) { ev.push({ t: b[0], dir: 'up' }); state = 'out_up'; }
        else if (lo >= L) state = 'inside';
      }
    }
    return ev;
  }

  async function rangeBreak(cfg, setStatus) {
    const ctx = await getCtx(setStatus);
    if (!ctx) return;
    const spanMin = (cfg.endMin - cfg.startMin + 1440) % 1440;
    if (spanMin === 0 || spanMin > 720) { setStatus('Range start must precede range end', true); return; }
    if (ctx.barMin > spanMin) { setStatus('Chart timeframe is coarser than the range', true); return; }

    for (let roll = 0; roll < 3; roll++) {
      if (S.cancel) { setStatus('Cancelled', true); return; }
      let cur = ctx.cur();
      if (typeof cur !== 'number') { setStatus('Cannot read replay position', true); return; }

      // Most recent range-end occurrence at/before cur; if we're before it
      // (or its window has no bars — weekend/holiday), advance to the next.
      const sinceEnd = (todMin(cur, ctx.tzF) - cfg.endMin + 1440) % 1440;
      let wEnd = (Math.floor(cur / 60) - sinceEnd) * 60;
      let wStart = wEnd - spanMin * 60;
      let win = readBarsSince(wStart).filter(b => b[0] < wEnd);
      const cutoff = wEnd + ((cfg.cutoffMin - cfg.endMin + 1440) % 1440) * 60;

      const needNext = win.length === 0 || cur >= cutoff ||
        scanBreaks(readBarsSince(wEnd).filter(b => b[0] < cutoff && b[0] <= cur),
          Math.max(...win.map(b => b[2])), Math.min(...win.map(b => b[3])), cfg.byClose).length >= cfg.maxBreaks;

      let cur0 = ctx.cur();                         // events at/before this are already consumed
      if (needNext) {
        setStatus('Advancing to next ' + cfg.endStr + ' range…');
        const landed = await jumpToTod(ctx, cfg.endMin, setStatus);
        if (landed === null) return;
        cur = landed;
        const s2 = (todMin(cur, ctx.tzF) - cfg.endMin + 1440) % 1440;
        wEnd = (Math.floor(cur / 60) - s2) * 60;
        wStart = wEnd - spanMin * 60;
        // the series lags the replay position after a big jump — wait until
        // the window is complete (both edges present) and its bar count holds
        // still, or a partial load yields a bogus range
        let lastCount = -1;
        for (let w = 0; w < 30; w++) {
          win = readBarsSince(wStart).filter(b => b[0] < wEnd);
          const slack = 3 * ctx.barMin * 60;
          const full = win.length > 0 &&
            win[0][0] <= wStart + slack &&
            win[win.length - 1][0] >= wEnd - slack;
          if (full && win.length === lastCount) break;
          lastCount = win.length;
          await sleep(400);
        }
        if (win.length === 0) continue;            // dead session — roll again
        cur0 = wEnd - 1;                            // fresh range: a break on its first bar counts
      }

      const H = Math.max(...win.map(b => b[2]));
      const L = Math.min(...win.map(b => b[3]));
      const cutoff2 = wEnd + ((cfg.cutoffMin - cfg.endMin + 1440) % 1440) * 60;
      const rng = ' (rng ' + L + '–' + H + ')';

      // Hunt: reveal bars and scan every one — detection is exact; batch size
      // only affects how precisely we stop ON the break bar. Batches scale
      // with distance-to-boundary in units of recent average bar range.
      for (let iter = 0; iter < 600; iter++) {
        if (S.cancel) { setStatus('Cancelled at ' + ctx.fmt(ctx.cur()), true); return; }
        // Never scan/step blind. Two series quirks: (1) the series lags the
        // replay position, and (2) a newly revealed head bar sits as an
        // o=h=l=c open-tick STUB, unchanged for ~1-1.2s, then its real OHLC
        // lands in one burst — a break on it is invisible until then. So:
        // wait for presence (position is next-bar-time − 1s, so the head
        // opens one bar-interval before position+1), scan once — a break
        // already visible is final (even a stub's open beyond the range
        // can't un-break, except close-mode where the close can come back) —
        // otherwise hold out the stub window anchored to when this head
        // first appeared, confirm with stable reads, and rescan.
        const posNow = ctx.cur();
        let head = null;
        for (let w = 0; w < 25; w++) {
          const nb = readBarsSince(wEnd);
          const h2 = nb[nb.length - 1];
          if (h2 && h2[0] >= posNow + 1 - ctx.barMin * 60) { head = h2; break; }
          await sleep(300);
        }
        let bars = readBarsSince(wEnd).filter(b => b[0] < cutoff2);
        let evs = scanBreaks(bars, H, L, cfg.byClose);
        let hit = evs.find(e => e.t > cur0);
        const headFreshHit = hit && head && hit.t === head[0];
        if ((!hit || (headFreshHit && cfg.byClose)) && head) {
          if (S.headT !== head[0]) { S.headT = head[0]; S.headAt = Date.now(); }
          const hold = S.headAt + 1900 - Date.now();
          if (hold > 0) await sleep(hold);
          let sig = null;
          for (let w = 0; w < 8; w++) {
            const nb = readBarsSince(wEnd);
            const h2 = nb[nb.length - 1];
            const s2 = h2 ? h2.join(',') : null;
            if (s2 !== null && s2 === sig) break;
            sig = s2;
            await sleep(250);
          }
          bars = readBarsSince(wEnd).filter(b => b[0] < cutoff2);
          evs = scanBreaks(bars, H, L, cfg.byClose);
          hit = evs.find(e => e.t > cur0);
        }
        if (hit) {
          const n = evs.filter(e => e.t <= hit.t).length;
          const lateBars = bars.filter(b => b[0] > hit.t).length;
          setStatus('Break ' + (hit.dir === 'up' ? '↑' : '↓') + ' #' + n + ' @ ' + ctx.fmt(hit.t) +
            (lateBars ? ' (+' + lateBars + ' bars past)' : '') + rng, false, true);
          return;
        }
        const last = bars[bars.length - 1];
        const cur1 = ctx.cur();
        if (cur1 >= cutoff2 || (last && last[0] + ctx.barMin * 60 >= cutoff2)) {
          setStatus('No break before ' + cfg.cutoffStr + rng + ' — click again for next day', false, true);
          return;
        }
        let chunk = 1;
        if (last && bars.length >= 3) {
          const tail = bars.slice(-14);
          const atr = tail.reduce((s, b) => s + (b[2] - b[3]), 0) / tail.length || 0;
          const c = last[4];
          // distance to the nearest price that changes the state machine:
          // inside → either boundary; outside → the far boundary (next break)
          // or the near one (re-arm), whichever is closer
          const dist = (c > H) ? Math.min(c - L, c - H) : (c < L) ? Math.min(H - c, L - c) : Math.min(H - c, c - L);
          if (atr > 0 && dist > 2 * atr) chunk = Math.min(10, Math.floor(dist / atr));
        }
        if (last) chunk = Math.max(1, Math.min(chunk, Math.floor((cutoff2 - last[0]) / (ctx.barMin * 60))));
        setStatus('Hunting break… ' + ctx.fmt(cur1) + rng);
        const next = await stepAndSettle(ctx, chunk, false);
        if (next === null) { setStatus('Reached end of data at ' + ctx.fmt(cur1), true); return; }
      }
      setStatus('Gave up hunting (600 batches)', true);
      return;
    }
    setStatus('No tradable range found in 3 sessions', true);
  }

  // ---------- Replay P&L ledger ----------
  // TV wipes Replay Trading results whenever the replay point moves backward
  // (the session resets server-side — unpreventable). This ledger snapshots
  // executions/P&L every 2s and BANKS the last snapshot the moment a wipe or
  // session end is detected, so results survive in localStorage + CSV.

  function ledgerLoad() {
    try { return JSON.parse(localStorage.getItem('tvj-ledger')) || { pl: 0, sessions: 0, entries: [] }; }
    catch (e) { return { pl: 0, sessions: 0, entries: [] }; }
  }
  function ledgerSave(l) { try { localStorage.setItem('tvj-ledger', JSON.stringify(l)); } catch (e) {} }
  function ledgerBank() {
    const live = S.live;
    if (!live || !live.ex.length) return;
    const l = ledgerLoad();
    l.pl += live.pl; l.sessions++;
    l.entries.push({ at: Date.now(), sym: live.sym, pl: live.pl, ex: live.ex.slice(0, 200) });
    if (l.entries.length > 100) l.entries = l.entries.slice(-100);
    ledgerSave(l);
    S.live = null;
  }
  function ledgerCsv() {
    const l = ledgerLoad();
    const rows = ['session,banked_at,symbol,exec_time_utc,side,qty,price,session_pl'];
    const all = l.entries.concat(S.live && S.live.ex.length ? [{ at: null, sym: S.live.sym, pl: S.live.pl, ex: S.live.ex }] : []);
    all.forEach((s, i) => {
      const at = s.at ? new Date(s.at).toISOString() : 'live';
      s.ex.forEach(e => rows.push([i + 1, at, s.sym, new Date(e.t * 1000).toISOString(), e.s > 0 ? 'buy' : 'sell', e.q, e.p, s.pl].join(',')));
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    a.download = 'replay_ledger.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function ledgerTick() {
    try {
      if (!S.ra) { const api = W.TradingViewApi; if (api) api.replayApi().then(ra => { S.ra = ra; }); return; }
      const el = S.panel && S.panel.querySelector('#tvj-pl');
      if (!el) return;
      let ex = [], pl = 0, active = false;
      if (uw(S.ra.isReplayStarted())) {
        const tc = S.ra._replayUIController.tradingUIController();
        const m = tc && tc.activeModel && tc.activeModel();
        if (m) {
          active = true;
          ex = uw(m.executions()) || [];
          const p = uw(m.realizedPL());
          pl = typeof p === 'number' ? p : 0;
        }
      }
      const live = S.live;
      if (live && live.ex.length && (ex.length < live.ex.length || (ex.length && live.firstId && ex[0].id !== live.firstId)))
        ledgerBank();                              // wipe/reset detected → bank the last snapshot
      if (!active && live && live.ex.length) ledgerBank();   // replay ended → bank
      if (ex.length) S.live = { ex: ex.map(e => ({ t: e.time_t, s: e.side, q: e.qty, p: e.price })), pl, firstId: ex[0].id, sym: ex[0].symbol };
      const l = ledgerLoad();
      const cur = S.live ? S.live.pl : 0;
      el.textContent = 'P&L live ' + (cur >= 0 ? '+' : '') + cur.toFixed(0) + ' | banked ' + (l.pl >= 0 ? '+' : '') + l.pl.toFixed(0) + ' (' + l.sessions + ')';
      el.style.color = (cur + l.pl) >= 0 ? '#4caf50' : '#f7525f';
    } catch (e) {}
  }

  // ---------- UI ----------
  function installPanel() {
    if (document.querySelector('#tvj-go')) return;
    const inpCss = 'background:#2a2e39;border:1px solid #434651;border-radius:4px;color:#d1d4dc;padding:3px 4px;font:inherit;color-scheme:dark;min-width:0';
    const btnCss = 'background:#2962ff;border:none;border-radius:4px;color:#fff;padding:5px 12px;font:inherit;font-weight:600;cursor:pointer';
    const panel = document.createElement('div');
    S.panel = panel;
    panel.style.cssText = 'position:fixed;top:64px;right:96px;z-index:2147483647;background:#1e222d;border:1px solid #434651;border-radius:8px;padding:8px 10px;font:12px -apple-system,"Trebuchet MS",Roboto,Ubuntu,sans-serif;color:#d1d4dc;box-shadow:0 2px 12px rgba(0,0,0,.45);user-select:none;width:236px;box-sizing:border-box';
    panel.innerHTML =
      '<div id="tvj-head" style="display:flex;align-items:center;gap:6px;cursor:move;margin-bottom:7px">' +
        '<span style="font-weight:600;flex:1">Replay Jump</span>' +
        '<span id="tvj-x" style="cursor:pointer;color:#787b86;padding:0 3px">✕</span></div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<input id="tvj-time" type="time" value="18:15" style="' + inpCss + ';flex:1">' +
        '<button id="tvj-go" style="' + btnCss + '">Jump ▶</button></div>' +
      '<div style="border-top:1px solid #2a2e39;margin:8px -10px 6px"></div>' +
      '<div style="color:#787b86;font-weight:600;margin-bottom:5px">Range Break</div>' +
      '<div style="display:flex;gap:4px;align-items:center;margin-bottom:5px">' +
        '<input id="tvj-rs" type="time" value="18:00" style="' + inpCss + ';flex:1">' +
        '<span style="color:#787b86;flex:none">–</span>' +
        '<input id="tvj-re" type="time" value="18:15" style="' + inpCss + ';flex:1"></div>' +
      '<div style="display:flex;gap:4px;align-items:center;margin-bottom:5px">' +
        '<span style="color:#787b86;flex:none">cut</span>' +
        '<input id="tvj-co" type="time" value="16:00" style="' + inpCss + ';flex:1">' +
        '<select id="tvj-cf" title="Break trigger: touch = wick pierce (how a stop order fills), close = bar must close beyond the range" style="' + inpCss + ';flex:none"><option selected>touch</option><option>close</option></select></div>' +
      '<div style="display:flex;gap:4px;align-items:center">' +
        '<span style="color:#787b86;flex:none">breaks/day</span>' +
        '<select id="tvj-mb" style="' + inpCss + ';flex:none"><option>1</option><option selected>2</option><option>3</option></select>' +
        '<button id="tvj-break" style="' + btnCss + ';flex:1;white-space:nowrap">Break ▶</button></div>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-top:7px">' +
        '<span id="tvj-pl" style="flex:1;color:#787b86">P&L —</span>' +
        '<span id="tvj-csv" title="Download all banked + live replay trades as CSV" style="cursor:pointer;color:#2962ff">csv</span>' +
        '<span id="tvj-clr" title="Clear the banked ledger (does not touch TV)" style="cursor:pointer;color:#787b86">clear</span></div>' +
      '<div id="tvj-status" style="margin-top:5px;color:#787b86;min-height:14px"></div>';
    document.body.appendChild(panel);

    const $ = id => panel.querySelector('#' + id);
    const statusEl = $('tvj-status'), goBtn = $('tvj-go'), breakBtn = $('tvj-break');
    const fields = { 'tvj-time': '18:15', 'tvj-rs': '18:00', 'tvj-re': '18:15', 'tvj-co': '16:00', 'tvj-mb': '2', 'tvj-cf': 'touch' };
    for (const id in fields) { try { $(id).value = localStorage.getItem(id) || fields[id]; } catch (e) {} }
    const saveFields = () => { for (const id in fields) { try { localStorage.setItem(id, $(id).value); } catch (e) {} } };

    const setStatus = (msg, isErr, isDone) => {
      statusEl.textContent = msg;
      statusEl.style.color = isErr ? '#f7525f' : (isDone ? '#4caf50' : '#787b86');
    };
    const toMin = v => { const p = v.split(':').map(Number); return isNaN(p[0]) ? null : p[0] * 60 + (p[1] || 0); };

    async function runBusy(btn, fn) {
      if (S.busy) { S.cancel = true; return; }
      saveFields();
      S.busy = true; S.cancel = false;
      const label = btn.textContent;
      btn.textContent = 'Cancel'; btn.style.background = '#f7525f';
      const other = btn === goBtn ? breakBtn : goBtn;
      other.disabled = true; other.style.opacity = '0.5';
      try { await fn(); }
      catch (e) { setStatus('Error: ' + (e && e.message || e), true); }
      S.busy = false; S.cancel = false;
      btn.textContent = label; btn.style.background = '#2962ff';
      other.disabled = false; other.style.opacity = '';
    }

    goBtn.onclick = () => runBusy(goBtn, async () => {
      const m = toMin($('tvj-time').value);
      if (m === null) { setStatus('Enter a time first', true); return; }
      await jump(m, setStatus, statusEl);
    });
    $('tvj-time').onkeydown = e => { if (e.key === 'Enter') goBtn.onclick(); };

    breakBtn.onclick = () => runBusy(breakBtn, async () => {
      const startMin = toMin($('tvj-rs').value), endMin = toMin($('tvj-re').value), cutoffMin = toMin($('tvj-co').value);
      if (startMin === null || endMin === null || cutoffMin === null) { setStatus('Fill range and cutoff times', true); return; }
      await rangeBreak({
        startMin, endMin, cutoffMin,
        maxBreaks: +$('tvj-mb').value || 2,
        byClose: $('tvj-cf').value === 'close',
        endStr: $('tvj-re').value, cutoffStr: $('tvj-co').value
      }, setStatus);
    });

    $('tvj-csv').onclick = ledgerCsv;
    $('tvj-clr').onclick = () => { ledgerSave({ pl: 0, sessions: 0, entries: [] }); };
    if (W.__tvjLedgerTimer) clearInterval(W.__tvjLedgerTimer);
    W.__tvjLedgerTimer = setInterval(ledgerTick, 2000);

    $('tvj-x').onclick = () => { panel.remove(); S.dismissed = true; };
    const head = $('tvj-head');
    head.onmousedown = e => {
      if (e.target.id === 'tvj-x') return;
      const r = panel.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = ev => { panel.style.left = (ev.clientX - ox) + 'px'; panel.style.top = (ev.clientY - oy) + 'px'; panel.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      e.preventDefault();
    };
  }

  // Wait for the chart app to boot, then keep the panel alive across TV's
  // SPA layout rebuilds. Closing with ✕ dismisses it until the next reload.
  const boot = setInterval(() => {
    if (typeof W.TradingViewApi !== 'undefined' && document.body) {
      clearInterval(boot);
      installPanel();
      setInterval(() => { if (!S.dismissed) installPanel(); }, 5000);
    }
  }, 1000);
})();
