// ==UserScript==
// @name         TV Replay Jump
// @namespace    tv-replay-jump
// @version      1.0.0
// @description  Jump TradingView bar replay to the next preset-time candle (e.g. 18:15) without resetting your replay session or trades.
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
// server-batched — a full day lands in a couple of calls. Landing is exact on
// CME-style sessions (all gaps begin 17:00 ET). Uses TV's undocumented replay
// API: may break after a TradingView update. Not affiliated with TradingView.
(function () {
  'use strict';
  // Page window: with @grant none most managers run us in page context, but
  // fall back to unsafeWindow for sandboxed engines.
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const GAP_START_ET = 17 * 60;
  const etFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const uw = v => (v && typeof v.value === 'function') ? v.value() : v;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  function chartFmt(tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  const S = { cancel: false, busy: false, panel: null };

  async function jump(presetMin, setStatus) {
    const api = W.TradingViewApi;
    const ra = await api.replayApi();
    if (!uw(ra.isReplayStarted())) { setStatus('Replay is not active', true); return; }

    const ch = api.activeChart();
    const barMin = resToMinutes(String(ch.resolution()));
    if (barMin === null) { setStatus('Chart must be on a minute-based timeframe', true); return; }

    let tz = 'America/New_York';
    try { tz = ch.getTimezoneApi().getTimezone().id || tz; } catch (e) {}
    const tzF = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    const showF = chartFmt(tz);
    const mgr = ra._replayUIController._replayManager;

    let cur = uw(ra.currentDate());
    if (typeof cur !== 'number') { setStatus('Cannot read replay position', true); return; }

    // Absolute target: the next wall-clock preset occurrence. Once cur reaches
    // it we stop — retargeting forward is only allowed when the occurrence had
    // no bar (weekend/holiday) and the tape reopened BEFORE the preset
    // time-of-day. Passing the target never rolls the jump to the next day.
    let d0 = (presetMin - todMin(cur, tzF) + 1440) % 1440;
    if (d0 === 0) d0 = 1440;
    let T = (Math.floor(cur / 60) + d0) * 60;

    for (let iter = 0; iter < 80; iter++) {
      if (S.cancel) { setStatus('Cancelled at ' + showF.format(new Date(cur * 1000)), true); return; }

      const tod = todMin(cur, tzF);
      if (cur >= T) {
        const past = (tod - presetMin + 1440) % 1440;
        if (past < barMin) {
          setStatus('Landed: ' + showF.format(new Date(cur * 1000)), false, true);
          return;
        }
        const ahead = (presetMin - tod + 1440) % 1440;
        if (ahead > 0 && ahead <= 720) {
          T = (Math.floor(cur / 60) + ahead) * 60;
        } else {
          setStatus('Landed: ' + showF.format(new Date(cur * 1000)) + ' (' + past + 'm past preset — gap/holiday)', false, true);
          return;
        }
      }

      let dist = (presetMin - tod + 1440) % 1440;
      if (dist === 0) dist = 1440;
      let toGap = (GAP_START_ET - todMin(cur, etFmt) + 1440) % 1440;
      if (toGap === 0) toGap = 1440;

      const crossing = dist > toGap;
      const chunk = Math.max(1, Math.ceil(Math.min(dist, toGap) / barMin));
      setStatus('Stepping ' + chunk + ' bars from ' + showF.format(new Date(cur * 1000)) + '…');
      try { await mgr.doReplayStep(chunk); }
      catch (e) { setStatus('Step failed (end of data?) at ' + showF.format(new Date(cur * 1000)), true); return; }

      // The step promise can resolve before the position updates, and during
      // gap/weekend data loads currentDate streams stale values — wait for an
      // advance, then require the value to hold still before trusting it.
      let next = uw(ra.currentDate());
      const t0 = Date.now();
      while ((typeof next !== 'number' || next <= cur) && Date.now() - t0 < (crossing ? 20000 : 6000)) {
        await sleep(300);
        next = uw(ra.currentDate());
      }
      const stableMs = crossing ? 1500 : 350;
      let lastChange = Date.now();
      const tStable = Date.now();
      while (Date.now() - lastChange < stableMs && Date.now() - tStable < 30000) {
        await sleep(200);
        const again = uw(ra.currentDate());
        if (again !== next) { next = again; lastChange = Date.now(); }
      }
      if (typeof next !== 'number' || next <= cur) {
        setStatus('Reached end of data at ' + showF.format(new Date(cur * 1000)), true);
        return;
      }
      cur = next;
    }
    setStatus('Gave up after 80 batches at ' + showF.format(new Date(cur * 1000)), true);
  }

  function installPanel() {
    if (document.querySelector('#tvj-go')) return;
    const panel = document.createElement('div');
    S.panel = panel;
    panel.style.cssText = 'position:fixed;top:64px;right:96px;z-index:2147483647;background:#1e222d;border:1px solid #434651;border-radius:8px;padding:8px 10px;font:12px -apple-system,"Trebuchet MS",Roboto,Ubuntu,sans-serif;color:#d1d4dc;box-shadow:0 2px 12px rgba(0,0,0,.45);user-select:none;min-width:196px';
    panel.innerHTML =
      '<div id="tvj-head" style="display:flex;align-items:center;gap:6px;cursor:move;margin-bottom:7px">' +
        '<span style="font-weight:600;flex:1">Replay Jump</span>' +
        '<span id="tvj-x" style="cursor:pointer;color:#787b86;padding:0 3px">✕</span></div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<input id="tvj-time" type="time" value="18:15" style="background:#2a2e39;border:1px solid #434651;border-radius:4px;color:#d1d4dc;padding:4px 6px;font:inherit;color-scheme:dark">' +
        '<button id="tvj-go" style="background:#2962ff;border:none;border-radius:4px;color:#fff;padding:5px 12px;font:inherit;font-weight:600;cursor:pointer">Jump ▶</button></div>' +
      '<div id="tvj-status" style="margin-top:7px;color:#787b86;min-height:14px;max-width:230px"></div>';
    document.body.appendChild(panel);

    const $ = id => panel.querySelector('#' + id);
    const statusEl = $('tvj-status'), goBtn = $('tvj-go'), timeIn = $('tvj-time');
    try { timeIn.value = localStorage.getItem('tvj-preset') || '18:15'; } catch (e) {}

    const setStatus = (msg, isErr, isDone) => {
      statusEl.textContent = msg;
      statusEl.style.color = isErr ? '#f7525f' : (isDone ? '#4caf50' : '#787b86');
    };

    goBtn.onclick = async () => {
      if (S.busy) { S.cancel = true; return; }
      const parts = timeIn.value.split(':').map(Number);
      if (isNaN(parts[0])) { setStatus('Enter a time first', true); return; }
      try { localStorage.setItem('tvj-preset', timeIn.value); } catch (e) {}
      S.busy = true; S.cancel = false;
      goBtn.textContent = 'Cancel'; goBtn.style.background = '#f7525f';
      try { await jump(parts[0] * 60 + parts[1], setStatus); }
      catch (e) { setStatus('Error: ' + (e && e.message || e), true); }
      S.busy = false; S.cancel = false;
      goBtn.textContent = 'Jump ▶'; goBtn.style.background = '#2962ff';
    };
    timeIn.onkeydown = e => { if (e.key === 'Enter') goBtn.onclick(); };
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
