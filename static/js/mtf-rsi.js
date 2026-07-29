/**
 * mtf-rsi.js - Multi-Timeframe RSI floating panel
 *
 * Reuses calculateRSI() from indicators.js (already global).
 * Fetches /api/history for each timeframe in parallel.
 * Refreshes every 15 s; also refreshes immediately when the active
 * pane changes symbol, source, or interval.
 *
 * Public API:
 *   MtfRsiWidget.init()          — call once from app.js init()
 *   MtfRsiWidget.refresh(pane)   — call when active pane changes
 */

var MtfRsiWidget = (function () {
  'use strict';

  // ── config ────────────────────────────────────────────────────────
  var TFS = ['1m','5m','15m','30m','1h','4h','1D','1W','1M'];

  var PERIOD = {
    '1m':'2d', '5m':'7d', '15m':'14d', '30m':'30d',
    '1h':'60d', '4h':'90d', '1D':'365d', '1W':'730d', '1M':'1825d'
  };

  // Which timeframes each source supports
  var SRC_TFS = {
    hyperliquid: ['1m','5m','15m','30m','1h','4h','1D','1W','1M'],
    binance:     ['1m','5m','15m','30m','1h','4h','1D','1W','1M'],
    yfinance:    ['1m','5m','15m','30m','1h','1D','1W','1M'],
    yfinance_us: ['1m','5m','15m','30m','1h','1D','1W','1M'],
  };

  var REFRESH_MS = 15000;

  // ── state ─────────────────────────────────────────────────────────
  var _sym   = '';
  var _src   = 'hyperliquid';
  var _curTf = '1h';
  var _isOpen = false;
  var _timer  = null;
  var _data   = {};   // { '1h': 63.71, '4h': null, … }
  var _panel  = null;
  var _btn    = null;

  // ── RSI helpers ───────────────────────────────────────────────────
  function _rsiLast(candles) {
    if (!candles || candles.length < 16) return null;
    var r = calculateRSI(candles, 14);
    return r.length ? Math.round(r[r.length - 1].value * 100) / 100 : null;
  }

  function _statusOf(v) {
    if (v == null) return { label: 'N/A',       cls: 'rsi-na' };
    if (v >= 70)   return { label: 'Overbought', cls: 'rsi-ob' };
    if (v >= 60)   return { label: 'Bullish',    cls: 'rsi-bu' };
    if (v >  40)   return { label: 'Neutral',    cls: 'rsi-ne' };
    if (v >  30)   return { label: 'Weak',       cls: 'rsi-wk' };
    return           { label: 'Oversold',         cls: 'rsi-os' };
  }

  // ── fetch one timeframe from /api/history ─────────────────────────
  function _fetchTf(tf) {
    if ((SRC_TFS[_src] || TFS).indexOf(tf) === -1) return Promise.resolve(null);
    return fetch(
      '/api/history?symbol=' + encodeURIComponent(_sym) +
      '&interval=' + tf +
      '&period='   + (PERIOD[tf] || '60d') +
      '&source='   + _src
    )
      .then(function(r) { return r.json(); })
      .then(function(j) { return j.ok && j.data ? _rsiLast(j.data) : null; })
      .catch(function()  { return null; });
  }

  // ── render table rows ─────────────────────────────────────────────
  function _render(loading) {
    var el = document.getElementById('mtf-rsi-rows');
    if (!el) return;

    el.innerHTML = TFS.map(function(tf) {
      var isCur = tf === _curTf;
      var v     = loading ? undefined : _data[tf];
      var st    = loading ? { label: '···', cls: '' } : _statusOf(v);
      var bw    = (!loading && v != null) ? Math.min(100, v).toFixed(0) + '%' : '0%';

      return (
        '<div class="mtf-row' + (isCur ? ' mtf-cur' : '') + '">' +
          '<span class="mtf-tf">' + tf + (isCur ? '<i class="mtf-dot"></i>' : '') + '</span>' +
          '<span class="mtf-rsi-val ' + st.cls + '">' +
            (loading ? '···' : v != null ? v.toFixed(2) : '—') +
          '</span>' +
          '<span class="mtf-status ' + st.cls + '">' + st.label + '</span>' +
        '</div>'
      );
    }).join('');
  }

  // ── refresh: fetch all TFs in parallel, then render ───────────────
  function _doRefresh() {
    if (!_isOpen || !_sym) return;
    _render(true);
    Promise.all(TFS.map(function(tf) {
      return _fetchTf(tf).then(function(v) { _data[tf] = v; });
    })).then(function() {
      _render(false);
      var dot = document.querySelector('.mtf-live-dot');
      if (dot) {
        dot.style.background = '#fff';
        setTimeout(function() { dot.style.background = ''; }, 250);
      }
    });
  }

  // ── toggle panel open / closed ────────────────────────────────────
  function _toggle() {
    _isOpen = !_isOpen;
    if (_panel) _panel.classList.toggle('mtf-visible', _isOpen);
    if (_btn)   _btn.classList.toggle('active', _isOpen);

    if (_isOpen) {
      _doRefresh();
      _timer = setInterval(_doRefresh, REFRESH_MS);
    } else {
      clearInterval(_timer);
      _timer = null;
    }
  }

  // ── public: call when active pane changes (symbol/source/interval) ─
  function refresh(pane) {
    if (!pane) return;

    var changed = pane.symbol !== _sym || pane.source !== _src;
    _sym   = pane.symbol   || '';
    _src   = pane.source   || 'hyperliquid';
    _curTf = pane.interval || '1h';

    if (changed) _data = {};

    var lbl = document.getElementById('mtf-rsi-sym');
    if (lbl) lbl.textContent = _sym || '—';

    if (_isOpen) {
      clearInterval(_timer);
      _doRefresh();
      _timer = setInterval(_doRefresh, REFRESH_MS);
    }
  }

  // ── drag to move ──────────────────────────────────────────────────
  function _initDrag() {
    var handle = _panel.querySelector('.mtf-hd');
    if (!handle) return;

    var dragging = false, offX = 0, offY = 0;

    handle.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      dragging = true;
      var rect = _panel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      // Switch from right-anchored to left-anchored positioning
      _panel.style.right  = 'auto';
      _panel.style.left   = rect.left + 'px';
      _panel.style.top    = rect.top  + 'px';
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var x = e.clientX - offX;
      var y = e.clientY - offY;
      // Clamp inside viewport
      x = Math.max(0, Math.min(window.innerWidth  - _panel.offsetWidth,  x));
      y = Math.max(0, Math.min(window.innerHeight - _panel.offsetHeight, y));
      _panel.style.left = x + 'px';
      _panel.style.top  = y + 'px';
    });

    document.addEventListener('mouseup', function() {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = '';
    });
  }

  // ── init: bind toggle button and close button ─────────────────────
  function init() {
    _panel = document.getElementById('mtf-rsi-panel');
    _btn   = document.getElementById('mtf-rsi-btn');
    if (_btn) _btn.addEventListener('click', _toggle);

    var closeBtn = document.getElementById('mtf-rsi-close');
    if (closeBtn) closeBtn.addEventListener('click', _toggle);

    _initDrag();
  }

  return { init: init, refresh: refresh };

})();
