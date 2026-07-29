/**
 * app.js - Dashboard orchestrator.
 * Manages chart count, active pane, apply-to-all, market status,
 * theme, and wires together all feature modules.
 */

var GRID_COLS = { 1:1, 2:2, 4:2, 6:3, 8:4 };
var GRID_ROWS = { 1:1, 2:1, 4:2, 6:2, 8:2 };

var panes          = [];
var chartCount     = 4;
var grid           = null;
var currentTheme   = localStorage.getItem('theme') || 'dark';
window._activePaneIndex = 0;

// ── theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  var sun  = document.getElementById('theme-icon-sun');
  var moon = document.getElementById('theme-icon-moon');
  if (sun)  sun.style.display  = theme === 'dark' ? '' : 'none';
  if (moon) moon.style.display = theme === 'dark' ? 'none' : '';
  panes.forEach(function(p) { if (typeof p.applyTheme === 'function') p.applyTheme(); });
}

// ── chart count ──────────────────────────────────────────────────────────────
function setActiveBtn(count) {
  document.querySelectorAll('.count-btn').forEach(function(b) {
    b.classList.toggle('active', parseInt(b.dataset.count) === count);
  });
}

function buildGrid(count) {
  // Exit expand mode before rebuilding
  _expandedPaneIndex = -1;
  grid.classList.remove('grid-expanded');

  panes.forEach(function(p) { p.destroy(); });
  panes = [];
  grid.innerHTML = '';

  grid.style.gridTemplateColumns = 'repeat(' + GRID_COLS[count] + ', 1fr)';
  grid.style.gridTemplateRows    = 'repeat(' + GRID_ROWS[count] + ', 1fr)';

  for (var i = 0; i < count; i++) {
    var div = document.createElement('div');
    div.className = 'chart-pane';
    grid.appendChild(div);
    panes.push(new ChartPane(div, i));
  }

  // Rebuild crosshair sync after all charts exist
  if (typeof CrosshairSync !== 'undefined') CrosshairSync.rebuild(panes);

  // Mark first pane as active
  _setActivePane(0);
}

// ── active pane ──────────────────────────────────────────────────────────────
function _setActivePane(idx) {
  window._activePaneIndex = idx;
  panes.forEach(function(p) { p.container.classList.remove('active-pane'); });
  if (panes[idx]) {
    panes[idx].container.classList.add('active-pane');
    if (window.MtfRsiWidget) MtfRsiWidget.refresh(panes[idx]);
  }
}

// Called by ChartPane when clicked
window._onPaneClick = function(idx) { _setActivePane(idx); };

// ── expand / collapse single chart ───────────────────────────────────────────
var _expandedPaneIndex = -1;

function _expandPane(idx) {
  _expandedPaneIndex = idx;
  panes.forEach(function(p) { p.container.classList.remove('pane-focused'); });
  if (!panes[idx]) return;
  panes[idx].container.classList.add('pane-focused');
  grid.classList.add('grid-expanded');

  // Swap button to collapse icon
  var btn = panes[idx].expandBtn;
  if (btn) {
    btn.title = 'Exit expanded view (E / Esc)';
    btn.innerHTML = '<svg viewBox="0 0 12 12"><polyline points="1,4 1,1 4,1"/><polyline points="11,4 11,1 8,1"/><polyline points="1,8 1,11 4,11"/><polyline points="11,8 11,11 8,11"/></svg>';
  }

  // Force chart resize after CSS layout change
  setTimeout(function() {
    if (panes[idx] && panes[idx].chart) {
      panes[idx].chart.applyOptions({
        width:  panes[idx].chartWrap.clientWidth,
        height: panes[idx].chartWrap.clientHeight,
      });
    }
  }, 30);
}

function _collapsePane() {
  var prev = _expandedPaneIndex;
  _expandedPaneIndex = -1;
  grid.classList.remove('grid-expanded');
  panes.forEach(function(p) { p.container.classList.remove('pane-focused'); });

  // Restore expand icon on previously expanded pane
  if (panes[prev] && panes[prev].expandBtn) {
    panes[prev].expandBtn.title = 'Expand chart (E)';
    panes[prev].expandBtn.innerHTML = '<svg viewBox="0 0 12 12"><polyline points="4,1 1,1 1,4"/><polyline points="8,1 11,1 11,4"/><polyline points="4,11 1,11 1,8"/><polyline points="8,11 11,11 11,8"/></svg>';
  }

  // Resize all charts back
  setTimeout(function() {
    panes.forEach(function(p) {
      if (p.chart) p.chart.applyOptions({ width: p.chartWrap.clientWidth, height: p.chartWrap.clientHeight });
    });
  }, 30);
}

window._toggleExpandPane = function(idx) {
  if (_expandedPaneIndex === idx) { _collapsePane(); } else { _expandPane(idx); }
};

// Escape key exits expanded view
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _expandedPaneIndex !== -1) {
    // Only if no modal or dropdown is open
    if (!document.querySelector('.modal-overlay.open')) _collapsePane();
  }
  // 'E' key toggles expand on the active pane
  if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
    window._toggleExpandPane(window._activePaneIndex);
  }
});

// ── apply-to-all ──────────────────────────────────────────────────────────────
function _activePane() {
  return panes[window._activePaneIndex] || panes[0];
}

function applySymbolToAll() {
  var src = _activePane();
  if (!src) return;
  panes.forEach(function(p) {
    if (p === src) return;
    if (src.source !== p.source) {
      p.source = src.source;
      p.srcSel.value = src.source;
      p._populateIntervals(p.interval);
    }
    p.symbol = src.symbol;
    p.symInput.value = src.symbol;
    p._saveState();
    p._load();
  });
}

function applyTimeframeToAll() {
  var src = _activePane();
  if (!src) return;
  var ivs = window._SOURCE_INTERVALS || {};
  panes.forEach(function(p) {
    if (p === src) return;
    var srcIvs = ivs[p.source] || [];
    var iv = (srcIvs.indexOf(src.interval) !== -1) ? src.interval : '1h';
    p.interval = iv;
    p.ivSel.value = iv;
    p._saveState();
    p._load();
  });
}

function applyIndicatorsToAll() {
  var src = _activePane();
  if (!src || !src.indicatorMgr) return;
  var enabled = src.indicatorMgr._enabled || {};
  panes.forEach(function(p) {
    if (p === src || !p.indicatorMgr) return;
    Object.keys(enabled).forEach(function(name) {
      p.indicatorMgr.setEnabled(name, !!enabled[name]);
    });
    if (p._candles && p._candles.length) {
      p.indicatorMgr.update(p._candles, p.interval);
    }
    if (p.indPanel && p.indPanel.classList.contains('open')) {
      p._buildIndPanel();
    }
    localStorage.setItem('inds-' + p.index, JSON.stringify(enabled));
  });
}

function applySourceToAll() {
  var src = _activePane();
  if (!src) return;
  panes.forEach(function(p) {
    if (p === src) return;
    p.source = src.source;
    p.srcSel.value = src.source;
    p._populateIntervals(p.interval);
    p._saveState();
    if (p.symbol) p._load();
  });
}

// ── market session status ─────────────────────────────────────────────────────
function _updateMarketStatus() {
  var now = new Date();
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;

  // IST = UTC + 5h30m
  var ist = new Date(utc + 5.5 * 3600000);
  var nseOpen = ist.getDay() >= 1 && ist.getDay() <= 5 &&
    (ist.getHours() > 9  || (ist.getHours() === 9  && ist.getMinutes() >= 15)) &&
    (ist.getHours() < 15 || (ist.getHours() === 15 && ist.getMinutes() <= 30));

  // ET (EDT = UTC-4, EST = UTC-5); simple DST check March-Nov
  var month  = now.getUTCMonth();
  var etOff  = (month >= 2 && month <= 10) ? -4 : -5;
  var et     = new Date(utc + etOff * 3600000);
  var usOpen = et.getDay() >= 1 && et.getDay() <= 5 &&
    (et.getHours() > 9  || (et.getHours() === 9  && et.getMinutes() >= 30)) &&
    et.getHours() < 16;

  var nseDot = document.getElementById('nse-dot');
  var usDot  = document.getElementById('us-dot');
  var nseLbl = document.getElementById('nse-lbl');
  var usLbl  = document.getElementById('us-lbl');

  if (nseDot) nseDot.className = 'mkt-dot ' + (nseOpen ? 'mkt-open' : 'mkt-closed');
  if (usDot)  usDot.className  = 'mkt-dot ' + (usOpen  ? 'mkt-open' : 'mkt-closed');
  if (nseLbl) nseLbl.title = 'NSE India: ' + (nseOpen ? 'Open' : 'Closed') + ' (approx)';
  if (usLbl)  usLbl.title  = 'US Market: ' + (usOpen  ? 'Open' : 'Closed') + ' (approx)';
}

// ── init ──────────────────────────────────────────────────────────────────────
function init() {
  grid = document.getElementById('chart-grid');

  applyTheme(currentTheme);

  var saved = parseInt(localStorage.getItem('chart-count'));
  if ([1,2,4,6,8].indexOf(saved) !== -1) chartCount = saved;

  setActiveBtn(chartCount);
  buildGrid(chartCount);

  // Count buttons
  document.querySelectorAll('.count-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var n = parseInt(this.dataset.count);
      if (n === chartCount) return;
      chartCount = n;
      localStorage.setItem('chart-count', n);
      setActiveBtn(n);
      buildGrid(n);
    });
  });

  // Theme toggle
  var themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.addEventListener('click', function() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // HL WS status
  var dot   = document.getElementById('hl-dot');
  var label = document.getElementById('hl-label');
  if (window.hlWS) {
    window.hlWS.onStatusChange(function(s) {
      if (dot)   dot.className   = 'status-dot ' + s;
      if (label) label.textContent = s === 'connected' ? 'Hyperliquid WS'
                                   : s === 'connecting' ? 'Connecting...' : 'Reconnecting...';
    });
  }

  // Binance WS status (reuses same dot when Binance charts are active)
  if (typeof BinanceWS !== 'undefined') {
    BinanceWS.onStatusChange(function(s) {
      var bnBtn = document.getElementById('bn-settings-btn');
      if (bnBtn) bnBtn.title = 'Binance: ' + s;
    });
  }

  // Binance credentials modal
  _initBinanceSettings();

  // Apply-to-all buttons
  var asSym = document.getElementById('apply-sym-btn');
  var asTF  = document.getElementById('apply-tf-btn');
  var asSrc = document.getElementById('apply-src-btn');
  var asInd = document.getElementById('apply-ind-btn');
  if (asSym) asSym.addEventListener('click', applySymbolToAll);
  if (asTF)  asTF.addEventListener('click',  applyTimeframeToAll);
  if (asSrc) asSrc.addEventListener('click', applySourceToAll);
  if (asInd) asInd.addEventListener('click', applyIndicatorsToAll);

  // Market status (update now + every 60s)
  _updateMarketStatus();
  setInterval(_updateMarketStatus, 60000);

  // Feature modules
  if (typeof WorkspaceManager !== 'undefined') WorkspaceManager.init();
  if (typeof WatchlistManager !== 'undefined') WatchlistManager.init();
  if (typeof AlertsManager    !== 'undefined') AlertsManager.init();
  if (typeof MtfRsiWidget     !== 'undefined') MtfRsiWidget.init();
  if (typeof DrawToolbar      !== 'undefined') DrawToolbar.init();
}

// ── Binance credentials settings ─────────────────────────────────────────────
function _initBinanceSettings() {
  var modal    = document.getElementById('bn-settings-modal');
  var openBtn  = document.getElementById('bn-settings-btn');
  var closeBtn = document.getElementById('bn-settings-close');
  var saveBtn  = document.getElementById('bn-save-btn');
  var clearBtn = document.getElementById('bn-clear-btn');
  var statusEl = document.getElementById('bn-status-msg');

  if (openBtn && modal) {
    openBtn.addEventListener('click', function() {
      modal.classList.add('open');
      // Prefill if already configured
      fetch('/api/binance-config')
        .then(function(r) { return r.json(); })
        .then(function(j) {
          var keyEl = document.getElementById('bn-api-key');
          if (j.configured && keyEl && !keyEl.value) keyEl.placeholder = j.api_key + '... (configured)';
        }).catch(function() {});
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', function() { if (modal) modal.classList.remove('open'); });
  if (modal) modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.remove('open'); });

  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      var key = (document.getElementById('bn-api-key')    || {}).value || '';
      var sec = (document.getElementById('bn-api-secret') || {}).value || '';
      fetch('/api/binance-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ api_key: key, secret: sec }),
      })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (statusEl) { statusEl.textContent = j.ok ? 'Saved successfully.' : ('Error: ' + j.error); }
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
      })
      .catch(function() { if (statusEl) statusEl.textContent = 'Save failed.'; });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      var k = document.getElementById('bn-api-key');
      var s = document.getElementById('bn-api-secret');
      if (k) k.value = '';
      if (s) s.value = '';
      fetch('/api/binance-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ api_key: '', secret: '' }),
      }).catch(function() {});
      if (statusEl) { statusEl.textContent = 'Credentials cleared.'; }
      setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
    });
  }
}

document.addEventListener('DOMContentLoaded', init);

// Expose globals needed by other modules
window.panes        = panes;
window.chartCount   = chartCount;
window.currentTheme = currentTheme;
window.applyTheme   = applyTheme;
window.buildGrid    = buildGrid;
window.setActiveBtn = setActiveBtn;
