/**
 * chart-pane.js
 *
 * ChartPane - one self-contained trading chart pane.
 * Manages: LWC chart, searchable symbol input, live subscriptions,
 *          indicator panel, error/loading UI, localStorage persistence.
 */

// ── shared context menu (one instance for all panes) ─────────────────────────
var _ctxMenu       = null;
var _ctxMenuTarget = null;

function _initCtxMenu() {
  if (_ctxMenu) return;
  _ctxMenu = document.createElement("div");
  _ctxMenu.className = "chart-ctx-menu";
  _ctxMenu.innerHTML =
    '<button class="ctx-item ctx-reset">&#8635; Reset Chart View</button>' +
    '<div class="ctx-sep"></div>' +
    '<button class="ctx-item ctx-export">&#11015; Export PNG</button>';
  document.body.appendChild(_ctxMenu);

  _ctxMenu.querySelector(".ctx-reset").addEventListener("click", function(e) {
    e.stopPropagation();
    if (_ctxMenuTarget && _ctxMenuTarget.chart) _ctxMenuTarget.chart.timeScale().fitContent();
    _ctxMenu.classList.remove("visible"); _ctxMenuTarget = null;
  });
  _ctxMenu.querySelector(".ctx-export").addEventListener("click", function(e) {
    e.stopPropagation();
    if (_ctxMenuTarget) _exportPNG(_ctxMenuTarget);
    _ctxMenu.classList.remove("visible"); _ctxMenuTarget = null;
  });

  document.addEventListener("click", function() {
    if (_ctxMenu) _ctxMenu.classList.remove("visible");
    _ctxMenuTarget = null;
  });
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && _ctxMenu) { _ctxMenu.classList.remove("visible"); _ctxMenuTarget = null; }
  });
}

function _exportPNG(pane) {
  var canvases = pane.chartWrap.querySelectorAll("canvas");
  if (!canvases.length) return;
  var w = canvases[0].width || 800;
  var h = canvases[0].height || 400;
  var merged = document.createElement("canvas");
  merged.width = w; merged.height = h;
  var ctx = merged.getContext("2d");
  var isDark = document.documentElement.getAttribute("data-theme") !== "light";
  ctx.fillStyle = isDark ? "#0d1117" : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  canvases.forEach(function(c) { try { ctx.drawImage(c, 0, 0); } catch(e) {} });
  var date = new Date().toISOString().slice(0, 10);
  var a = document.createElement("a");
  a.download = (pane.symbol || "chart") + "_" + (pane.interval || "") + "_" + date + ".png";
  a.href = merged.toDataURL("image/png");
  a.click();
}

function _showCtxMenu(pane, x, y) {
  _initCtxMenu();
  _ctxMenuTarget = pane;
  _ctxMenu.style.left = x + "px";
  _ctxMenu.style.top  = y + "px";
  _ctxMenu.classList.add("visible");
  requestAnimationFrame(function() {
    var r = _ctxMenu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  _ctxMenu.style.left = (x - r.width)  + "px";
    if (r.bottom > window.innerHeight) _ctxMenu.style.top  = (y - r.height) + "px";
  });
}

// ── chart theme helper ────────────────────────────────────────────────────────
function _getChartTheme() {
  var light = document.documentElement.getAttribute("data-theme") === "light";
  return {
    layout: {
      background: { type: "solid", color: light ? "#ffffff" : "#0d1117" },
      textColor:  light ? "#131722" : "#d1d4dc",
    },
    grid: {
      vertLines: { color: light ? "#eaecf2" : "#1a1f2e" },
      horzLines: { color: light ? "#eaecf2" : "#1a1f2e" },
    },
    rightPriceScale: { borderColor: light ? "#c4c8d4" : "#2a2e39" },
    timeScale: { borderColor: light ? "#c4c8d4" : "#2a2e39", timeVisible: true, secondsVisible: false },
  };
}

// ── period per interval ───────────────────────────────────────────────────────
var _PERIOD_MAP = {
  "1m":  "1d",
  "5m":  "7d",
  "15m": "14d",
  "30m": "30d",
  "1h":  "60d",
  "4h":  "90d",
  "1D":  "365d",
  "1W":  "730d",
  "1M":  "1825d",
};

// Hyperliquid WS uses lowercase "1d"/"1w"; UI labels use "1D"/"1W"
var _HL_IV_WS = { "1D": "1d", "1W": "1w" };

// Intervals available per source
var _SOURCE_INTERVALS = {
  "hyperliquid": ["1m","5m","15m","30m","1h","4h","1D","1W","1M"],
  "binance":     ["1m","5m","15m","30m","1h","4h","1D","1W","1M"],
  "yfinance":    ["1m","5m","15m","30m","1h","1D","1W","1M"],
  "yfinance_us": ["1m","5m","15m","30m","1h","1D","1W","1M"],
};

// Indicator panel definition
var _IND_GROUPS = [
  { label: "Trend",      items: ["SMA20","SMA50","SMA200","EMA20","EMA50","EMA200"] },
  { label: "Oscillator", items: ["RSI","MACD"] },
  { label: "Volume",     items: ["VOLUME","OBV","VWAP"] },
  { label: "Volatility", items: ["BB","ATR"] },
  { label: "Advanced",   items: ["VOL_PROFILE","FVG","OB","PIVOT"] },
];

var _IND_LABELS = {
  SMA20:"SMA 20",SMA50:"SMA 50",SMA200:"SMA 200",
  EMA20:"EMA 20",EMA50:"EMA 50",EMA200:"EMA 200",
  RSI:"RSI",MACD:"MACD",VWAP:"VWAP",BB:"Bollinger",ATR:"ATR",
  VOLUME:"Volume",OBV:"OBV",
  VOL_PROFILE:"Vol Profile",FVG:"FVG",OB:"Order Blocks",PIVOT:"Pivot Points",
};

// ── ChartPane ─────────────────────────────────────────────────────────────────
function ChartPane(container, index) {
  this.container    = container;
  this.index        = index;
  this.source       = "hyperliquid";
  this.symbol       = "BTC";
  this.interval     = "1h";
  this.lastPrice    = null;
  this.dayOpen      = null;
  this._candles     = [];
  this._searchTimer = null;
  this._indTimer    = null;

  // LWC
  this.chart        = null;
  this.candleSeries = null;
  this.volSeries    = null;
  this.indicatorMgr = null;

  // Live cleanup refs
  this.pollTimer  = null;
  this._liveTimer = null;
  this.unsubC     = null;
  this.unsubM     = null;
  this.unsubBn    = null;
  this.resizeObs  = null;

  // Lazy historical loading state
  this._oldestTime       = null;   // Unix seconds of oldest loaded candle
  this._historyLoading   = false;  // fetch in flight
  this._historyExhausted = false;  // no more data upstream
  this._histRangeHandler = null;   // stored so we can unsubscribe

  this._render();
  this._initChart();
  this._bindControls();
  this._restoreAndLoad();
}

// ── DOM ───────────────────────────────────────────────────────────────────────
ChartPane.prototype._render = function() {
  this.container.innerHTML = [
    '<div class="pane-header">',
    '  <div class="ticker-bar">',
    '    <span class="t-symbol">--</span>',
    '    <span class="t-price">--.--</span>',
    '    <span class="t-change neutral">0.00%</span>',
    '  </div>',
    '  <div class="pane-controls">',
    '    <select class="ctrl ctrl-source">',
    '      <option value="hyperliquid">Crypto (HL)</option>',
    '      <option value="binance">Crypto (Binance)</option>',
    '      <option value="yfinance_us">US Stocks</option>',
    '      <option value="yfinance">India NSE</option>',
    '    </select>',
    '    <div class="sym-wrap">',
    '      <input type="text" class="ctrl sym-input" placeholder="Symbol..." autocomplete="off" spellcheck="false">',
    '    </div>',
    '    <select class="ctrl ctrl-interval"></select>',
    '    <button class="ind-btn" title="Toggle indicators">Ind</button>',
    '    <button class="ind-eye-btn" title="Hide / Show indicators">&#128065;</button>',
    '    <button class="expand-btn" title="Expand chart (E)">',
    '      <svg viewBox="0 0 12 12"><polyline points="4,1 1,1 1,4"/><polyline points="8,1 11,1 11,4"/><polyline points="4,11 1,11 1,8"/><polyline points="8,11 11,11 11,8"/></svg>',
    '    </button>',
    '  </div>',
    '</div>',
    '<div class="ind-panel"></div>',
    '<div class="chart-wrap">',
    '  <div class="loading-overlay">Loading...</div>',
    '  <div class="history-loading">Loading older data…</div>',
    '  <div class="error-overlay hidden">',
    '    <div class="error-msg"></div>',
    '    <button class="retry-btn">Retry</button>',
    '  </div>',
    '</div>',
  ].join("");

  this.tickerEl   = this.container.querySelector(".ticker-bar");
  this.tSymbol    = this.container.querySelector(".t-symbol");
  this.tPrice     = this.container.querySelector(".t-price");
  this.tChange    = this.container.querySelector(".t-change");
  this.srcSel     = this.container.querySelector(".ctrl-source");
  this.symInput   = this.container.querySelector(".sym-input");
  this.ivSel      = this.container.querySelector(".ctrl-interval");
  this.indBtn     = this.container.querySelector(".ind-btn");
  this.indEyeBtn  = this.container.querySelector(".ind-eye-btn");
  this.expandBtn  = this.container.querySelector(".expand-btn");
  this.indPanel   = this.container.querySelector(".ind-panel");
  this.chartWrap  = this.container.querySelector(".chart-wrap");
  this.loadingEl     = this.container.querySelector(".loading-overlay");
  this.histLoadingEl = this.container.querySelector(".history-loading");
  this.errorEl       = this.container.querySelector(".error-overlay");
  this.errorMsgEl = this.container.querySelector(".error-msg");
  this.retryBtn   = this.container.querySelector(".retry-btn");

  // Dropdown is appended to body so overflow:hidden ancestors can't clip it
  this.symDropdown = document.createElement("div");
  this.symDropdown.className = "sym-dropdown";
  document.body.appendChild(this.symDropdown);
};

// ── LWC init ──────────────────────────────────────────────────────────────────
ChartPane.prototype._initChart = function() {
  var themeOpts = _getChartTheme();
  themeOpts.crosshair = { mode: LightweightCharts.CrosshairMode.Normal };
  themeOpts.width  = this.chartWrap.clientWidth;
  themeOpts.height = this.chartWrap.clientHeight;
  this.chart = LightweightCharts.createChart(this.chartWrap, themeOpts);

  this.candleSeries = this.chart.addCandlestickSeries({
    upColor:      "#26a69a",
    downColor:    "#ef5350",
    borderVisible: false,
    wickUpColor:   "#26a69a",
    wickDownColor: "#ef5350",
  });

  this.volSeries = this.chart.addHistogramSeries({
    priceFormat:  { type: "volume" },
    priceScaleId: "vol",
  });
  this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  this.indicatorMgr = new IndicatorManager(
    this.chart, this.chartWrap, this.candleSeries, this.volSeries, this.index
  );

  // Attach drawing overlay
  if (typeof DrawEngine !== "undefined") DrawEngine.attach(this);

  // Right-click context menu (only fires when no drawing was hit)
  var self = this;
  this.chartWrap.addEventListener("contextmenu", function(e) {
    e.preventDefault();
    _showCtxMenu(self, e.clientX, e.clientY);
  });

  // Resize observer
  this.resizeObs = new ResizeObserver(function() {
    if (!this.chart) return;
    this.chart.applyOptions({ width: this.chartWrap.clientWidth, height: this.chartWrap.clientHeight });
  }.bind(this));
  this.resizeObs.observe(this.chartWrap);

  // Lazy-load older history when user scrolls to within 50 bars of the left edge
  var self = this;
  this._histRangeHandler = function(range) {
    if (!range || self._historyLoading || self._historyExhausted) return;
    if (range.from < 50) self._fetchOlderHistory();
  };
  this.chart.timeScale().subscribeVisibleLogicalRangeChange(this._histRangeHandler);
};

// ── Indicator panel ───────────────────────────────────────────────────────────
ChartPane.prototype._buildIndPanel = function() {
  var self = this;
  var html = "";
  _IND_GROUPS.forEach(function(group) {
    html += '<div class="ind-group">';
    html += '<span class="ind-group-label">' + group.label + '</span>';
    group.items.forEach(function(name) {
      var on = self.indicatorMgr.isEnabled(name) ? " on" : "";
      html += '<button class="ind-toggle' + on + '" data-ind="' + name + '">' + (_IND_LABELS[name] || name) + '</button>';
    });
    html += '</div>';
  });
  this.indPanel.innerHTML = html;

  this.indPanel.querySelectorAll(".ind-toggle").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var name = btn.dataset.ind;
      var nowOn = !btn.classList.contains("on");
      btn.classList.toggle("on", nowOn);
      self.indicatorMgr.setEnabled(name, nowOn);
      if (nowOn && self._candles.length) {
        self.indicatorMgr.update(self._candles, self.interval);
      }
    });
  });
};

// ── controls binding ──────────────────────────────────────────────────────────
ChartPane.prototype._bindControls = function() {
  var self = this;

  // Source change
  this.srcSel.addEventListener("change", function() {
    self.source = self.srcSel.value;
    self._populateIntervals(null);
    self.symInput.value = "";
    self._saveState();
  });

  // Interval change
  this.ivSel.addEventListener("change", function() {
    self.interval = self.ivSel.value;
    self._saveState();
    if (self.symbol) self._load();
    if (window.MtfRsiWidget && self.index === window._activePaneIndex) MtfRsiWidget.refresh(self);
  });

  // Symbol search input
  this.symInput.addEventListener("input", function() {
    clearTimeout(self._searchTimer);
    var q = self.symInput.value.trim();
    if (!q) { self._hideDropdown(); return; }
    // Short debounce (120ms) so suggestions appear quickly
    self._searchTimer = setTimeout(function() { self._fetchSuggestions(q); }, 120);
  });

  this.symInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      self._hideDropdown();
      var typed = self.symInput.value.trim().toUpperCase();
      if (typed) { self._selectSymbol(typed, self.source); }
    }
    if (e.key === "Escape") self._hideDropdown();
  });

  this.symInput.addEventListener("blur", function() {
    // Delay so click on dropdown item can fire first
    setTimeout(function() { self._hideDropdown(); }, 200);
  });

  // Indicator panel toggle
  this.indBtn.addEventListener("click", function() {
    var isOpen = self.indPanel.classList.toggle("open");
    self.indBtn.classList.toggle("active", isOpen);
    if (isOpen) self._buildIndPanel();
  });

  // Indicator eye toggle (hide / show all indicator series)
  this._indVisible = true;
  if (this.indEyeBtn) {
    this.indEyeBtn.addEventListener("click", function() {
      self._indVisible = !self._indVisible;
      if (self.indicatorMgr && typeof self.indicatorMgr.setAllVisible === "function") {
        self.indicatorMgr.setAllVisible(self._indVisible);
      }
      self.indEyeBtn.classList.toggle("active", !self._indVisible);
      self.indEyeBtn.title = self._indVisible ? "Hide indicators" : "Show indicators";
    });
  }

  // Expand / collapse button
  if (this.expandBtn) {
    this.expandBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      if (typeof window._toggleExpandPane === "function") window._toggleExpandPane(self.index);
    });
  }

  // Retry button
  this.retryBtn.addEventListener("click", function() {
    self._clearError();
    self._load();
  });

  // Active pane selection on click
  this.container.addEventListener("click", function() {
    if (typeof window._onPaneClick === "function") window._onPaneClick(self.index);
  });
};

ChartPane.prototype._populateIntervals = function(keepInterval) {
  var ivs = _SOURCE_INTERVALS[this.source] || ["1m","5m","15m","1h","1D","1W"];
  this.ivSel.innerHTML = ivs.map(function(v) {
    return '<option value="' + v + '">' + v + '</option>';
  }).join("");
  var target = (keepInterval && ivs.indexOf(keepInterval) !== -1) ? keepInterval : "1h";
  this.ivSel.value = target;
  this.interval    = target;
};

// ── symbol search dropdown ────────────────────────────────────────────────────
ChartPane.prototype._fetchSuggestions = function(q) {
  var self = this;
  // Always search both: source-filtered (priority) + cross-source (for name matches like "Wi"→Wipro)
  var urlSrc   = "/api/search-symbols?q=" + encodeURIComponent(q) + "&source=" + self.source;
  var urlCross = "/api/search-symbols?q=" + encodeURIComponent(q);

  Promise.all([
    fetch(urlSrc).then(function(r) { return r.json(); }).catch(function() { return {ok:false,symbols:[]}; }),
    fetch(urlCross).then(function(r) { return r.json(); }).catch(function() { return {ok:false,symbols:[]}; }),
  ]).then(function(results) {
    var srcItems   = (results[0].symbols || []);
    var crossItems = (results[1].symbols || []).filter(function(s) {
      return !srcItems.some(function(x) { return x.symbol === s.symbol; });
    });
    // Source-matched items first, then cross-source extras
    self._showDropdown(srcItems.concat(crossItems));
  });
};

ChartPane.prototype._showDropdown = function(items) {
  var self = this;
  if (!items.length) { this._hideDropdown(); return; }

  // Position using fixed coords from the input so overflow:hidden ancestors don't clip
  var rect = this.symInput.getBoundingClientRect();
  this.symDropdown.style.top   = (rect.bottom + 2) + "px";
  this.symDropdown.style.left  = rect.left + "px";
  this.symDropdown.style.width = Math.max(280, rect.width) + "px";

  var html = "";
  items.slice(0, 30).forEach(function(item) {
    html += '<div class="sym-item" data-sym="' + item.symbol + '" data-src="' + item.source + '">' +
      '<span class="sym-item-sym">' + item.symbol + '</span>' +
      '<span class="sym-item-name">' + item.name + '</span>' +
      '<span class="sym-item-cat">' + item.category + '</span>' +
      '</div>';
  });
  this.symDropdown.innerHTML = html;
  this.symDropdown.classList.add("visible");

  this.symDropdown.querySelectorAll(".sym-item").forEach(function(el) {
    el.addEventListener("mousedown", function(e) {
      e.preventDefault(); // prevent blur firing before click
      self._selectSymbol(el.dataset.sym, el.dataset.src);
    });
  });
};

ChartPane.prototype._hideDropdown = function() {
  this.symDropdown.classList.remove("visible");
  this.symDropdown.innerHTML = "";
};

ChartPane.prototype._selectSymbol = function(sym, src) {
  this._hideDropdown();
  if (src && src !== this.source) {
    this.source = src;
    this.srcSel.value = src;
    this._populateIntervals(this.interval);
  }
  this.symbol = sym;
  this.symInput.value = sym;
  this._saveState();
  if (typeof DrawEngine !== "undefined") DrawEngine.onSymbolChange(this);
  this._load();
  if (window.MtfRsiWidget && this.index === window._activePaneIndex) MtfRsiWidget.refresh(this);
};

// ── state persistence ─────────────────────────────────────────────────────────
ChartPane.prototype._saveState = function() {
  localStorage.setItem("pane-" + this.index, JSON.stringify({
    source: this.source, symbol: this.symbol, interval: this.interval,
  }));
};

ChartPane.prototype._restoreAndLoad = function() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem("pane-" + this.index)); } catch(e) {}

  if (saved && saved.source) {
    this.source = saved.source;
    this.srcSel.value = this.source;
  }
  this._populateIntervals(saved ? saved.interval : "1h");

  if (saved && saved.symbol) {
    this.symbol = saved.symbol;
    this.symInput.value = saved.symbol;
  } else {
    // Default symbols per source
    var defaults = { hyperliquid: "BTC", binance: "BTC", yfinance_us: "AAPL", yfinance: "RELIANCE.NS" };
    this.symbol = defaults[this.source] || "BTC";
    this.symInput.value = this.symbol;
  }

  this._load();
};

// ── ticker % reference ────────────────────────────────────────────────────────
// For intraday: use first candle of the current day as reference (day open).
// For 1D/1W/1M: use previous candle close.
ChartPane.prototype._getReferencePrice = function(candles) {
  if (!candles || candles.length < 2) return null;
  var intraday = ["1m","5m","15m","30m","1h","4h"].indexOf(this.interval) !== -1;
  if (intraday) {
    var now = Math.floor(Date.now() / 1000);
    var todayStart = now - (now % 86400);  // UTC midnight
    for (var i = 0; i < candles.length; i++) {
      if (candles[i].time >= todayStart) return candles[i].open;
    }
    return candles[candles.length - 2].close; // fallback to prev close
  }
  // Daily and above: previous candle close
  return candles[candles.length - 2].close;
};

// ── data loading ──────────────────────────────────────────────────────────────
ChartPane.prototype._load = function() {
  var self = this;
  self._cleanup();
  self._clearError();
  self._setLoading(true);
  self._candles = [];
  self._oldestTime       = null;
  self._historyLoading   = false;
  self._historyExhausted = false;
  self.tSymbol.textContent = self.symbol.replace(".NS","");

  var period = _PERIOD_MAP[self.interval] || "60d";
  var url = "/api/history?symbol=" + encodeURIComponent(self.symbol) +
            "&interval=" + self.interval +
            "&period="   + period +
            "&source="   + self.source;

  // 30-second frontend timeout — prevents the loading overlay getting stuck
  // when the backend (e.g. Yahoo Finance) stalls a connection.
  var ctrl       = typeof AbortController !== "undefined" ? new AbortController() : null;
  var abortTimer = ctrl ? setTimeout(function() { ctrl.abort(); }, 30000) : null;

  fetch(url, ctrl ? { signal: ctrl.signal } : {})
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (!j.ok) throw new Error(j.error || "No data returned");
      if (!j.data || j.data.length === 0) throw new Error("No candles for " + self.symbol + " " + self.interval);

      var candles = j.data;
      self._candles = candles;
      self._oldestTime = candles[0].time;

      self.candleSeries.setData(candles);
      self.volSeries.setData(candles.map(function(c) {
        return { time: c.time, value: c.volume,
                 color: c.close >= c.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" };
      }));

      var last = candles[candles.length - 1];
      var ref  = self._getReferencePrice(candles);
      self.lastPrice = last.close;
      self.dayOpen   = ref;
      self._updateTicker(last.close, ref || last.open);

      // Re-render drawing overlay after new data loads
      if (typeof DrawEngine !== "undefined") DrawEngine.render(self);

      // Calculate indicators
      self.indicatorMgr.update(candles, self.interval);
    })
    .catch(function(e) {
      var msg = (e && e.name === "AbortError")
        ? "Request timed out — data source may be slow.\nClick Retry in a moment."
        : self.source + " | " + self.symbol + " | " + self.interval + "\n" + (e ? e.message : "Unknown error");
      self._showError(msg);
    })
    .finally(function() {
      clearTimeout(abortTimer);
      self._setLoading(false);
      if (self.source === "hyperliquid") {
        self._subscribeHL();
        self._startLivePoller();
      } else if (self.source === "binance") {
        self._subscribeBinance();
        self._startLivePoller();
      } else {
        self._startPoll();
      }
    });
};

// ── lazy historical loading ───────────────────────────────────────────────────

ChartPane.prototype._setHistoryLoading = function(on) {
  this._historyLoading = on;
  if (this.histLoadingEl) this.histLoadingEl.classList.toggle('visible', on);
};

ChartPane.prototype._fetchOlderHistory = function() {
  var self = this;
  if (self._historyLoading || self._historyExhausted || !self._oldestTime) return;

  self._setHistoryLoading(true);

  var period  = _PERIOD_MAP[self.interval] || "60d";
  var endTime = self._oldestTime - 1;   // one second before oldest candle

  var url = "/api/history?symbol=" + encodeURIComponent(self.symbol) +
            "&interval=" + self.interval +
            "&period="   + period +
            "&source="   + self.source +
            "&end="      + endTime;

  var ctrl       = typeof AbortController !== "undefined" ? new AbortController() : null;
  var abortTimer = ctrl ? setTimeout(function() { ctrl.abort(); }, 30000) : null;

  fetch(url, ctrl ? { signal: ctrl.signal } : {})
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (!j.ok || !j.data || !j.data.length) {
        self._historyExhausted = true;
        return;
      }

      // Keep only candles strictly older than what we already have
      var newCandles = j.data.filter(function(c) { return c.time < self._oldestTime; });
      if (!newCandles.length) {
        self._historyExhausted = true;
        return;
      }

      var merged = newCandles.concat(self._candles);
      self._candles    = merged;
      self._oldestTime = merged[0].time;

      self.candleSeries.setData(merged);
      self.volSeries.setData(merged.map(function(c) {
        return { time: c.time, value: c.volume,
                 color: c.close >= c.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" };
      }));

      // Recalculate indicators with full merged dataset
      if (self._candles.length) self.indicatorMgr.update(self._candles, self.interval);
    })
    .catch(function() {
      // Silent fail — user can scroll again to retry
    })
    .finally(function() {
      clearTimeout(abortTimer);
      self._setHistoryLoading(false);
    });
};

// ── Hyperliquid live feed ─────────────────────────────────────────────────────
ChartPane.prototype._subscribeHL = function() {
  var self = this;
  var coin = this.symbol;
  // Convert UI label to Hyperliquid WS interval ("1D"→"1d", "1W"→"1w")
  var iv   = _HL_IV_WS[this.interval] || this.interval;

  this.unsubC = window.hlWS.subscribeCandle(coin, iv, function(d) {
    // d fields: t (ms), T, s, i, o, c, h, l, v, n
    var newTime = Math.floor(d.t / 1000);
    var c = {
      time:  newTime,
      open:  parseFloat(d.o),
      high:  parseFloat(d.h),
      low:   parseFloat(d.l),
      close: parseFloat(d.c),
      volume: parseFloat(d.v),
    };
    self.candleSeries.update(c);

    // Keep _candles in sync - update last or append new bucket
    if (self._candles.length > 0) {
      var last = self._candles[self._candles.length - 1];
      if (newTime === last.time) {
        self._candles[self._candles.length - 1] = c;
      } else if (newTime > last.time) {
        self._candles.push(c);
        // Debounced indicator recalculation on new candle
        self._scheduleIndicatorUpdate();
      }
    }
  });

  this.unsubM = window.hlWS.subscribeMids(function(mids) {
    var p = mids[coin];
    if (p != null) self._flash(parseFloat(p));
  });
};

// ── Binance live feed ─────────────────────────────────────────────────────────
ChartPane.prototype._subscribeBinance = function() {
  var self = this;
  if (typeof BinanceWS === "undefined") return;

  this.unsubBn = BinanceWS.subscribe(this.symbol, this.interval, function(price, k) {
    var newTime = Math.floor(parseInt(k.t) / 1000);
    var c = {
      time:   newTime,
      open:   parseFloat(k.o),
      high:   parseFloat(k.h),
      low:    parseFloat(k.l),
      close:  parseFloat(k.c),
      volume: parseFloat(k.v),
    };
    self.candleSeries.update(c);

    if (self._candles.length > 0) {
      var last = self._candles[self._candles.length - 1];
      if (newTime === last.time) {
        self._candles[self._candles.length - 1] = c;
      } else if (newTime > last.time) {
        self._candles.push(c);
        self._scheduleIndicatorUpdate();
      }
    }

    self._flash(price);
    self._updateTicker(price, self.dayOpen != null ? self.dayOpen : price);
  });
};

// ── REST-based live candle poller (safety net for WS gaps) ───────────────────
ChartPane.prototype._startLivePoller = function() {
  var self = this;
  var intraday = ["1m","5m","15m","30m","1h","4h"];
  var ms = intraday.indexOf(self.interval) !== -1
         ? (["1m","5m","15m","30m"].indexOf(self.interval) !== -1 ? 15000 : 30000)
         : 60000;   // daily/weekly/monthly: every 60s

  self._liveTimer = setInterval(function() {
    var shortPeriod = intraday.indexOf(self.interval) !== -1 ? "1d" : "7d";
    fetch("/api/history?symbol=" + encodeURIComponent(self.symbol) +
          "&interval=" + self.interval + "&period=" + shortPeriod +
          "&source=" + self.source)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j.ok || !j.data || !j.data.length) return;
        var latest = j.data[j.data.length - 1];
        try {
          self.candleSeries.update(latest);
          self.volSeries.update({
            time:  latest.time,
            value: latest.volume,
            color: latest.close >= latest.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
          });
        } catch (e) {}
        self._flash(latest.close);
        self._updateTicker(latest.close, self.dayOpen != null ? self.dayOpen : latest.open);
      }).catch(function() {});
  }, ms);
};

ChartPane.prototype._scheduleIndicatorUpdate = function() {
  var self = this;
  clearTimeout(self._indTimer);
  self._indTimer = setTimeout(function() {
    if (self._candles.length) self.indicatorMgr.update(self._candles, self.interval);
  }, 2000);
};

// ── yfinance polling ──────────────────────────────────────────────────────────
ChartPane.prototype._startPoll = function() {
  var self = this;
  function doPoll() {
    fetch("/api/price?symbol=" + encodeURIComponent(self.symbol) + "&source=" + self.source)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j.ok) return;
        var price = j.price;
        self._flash(price);
        self._updateTicker(price, self.dayOpen != null ? self.dayOpen : price);
        // Update the live candle on the chart so traders see movement without refreshing
        if (self._candles.length > 0) {
          var last = self._candles[self._candles.length - 1];
          var updated = {
            time:   last.time,
            open:   last.open,
            high:   Math.max(last.high, price),
            low:    Math.min(last.low,  price),
            close:  price,
            volume: last.volume,
          };
          try {
            self.candleSeries.update(updated);
            self.volSeries.update({
              time:  last.time,
              value: last.volume,
              color: price >= last.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
            });
          } catch (e) {}
        }
      })
      .catch(function() {});
  }
  doPoll();
  this.pollTimer = setInterval(doPoll, 30000);
};

// ── ticker + price flash ──────────────────────────────────────────────────────
ChartPane.prototype._flash = function(newPrice) {
  if (this.lastPrice == null) { this.lastPrice = newPrice; return; }
  // Check price alerts on every tick
  if (typeof AlertsManager !== "undefined") AlertsManager.check(this.source, this.symbol, newPrice);
  var dir = newPrice > this.lastPrice ? "up" : newPrice < this.lastPrice ? "down" : null;
  this.lastPrice = newPrice;
  this.tPrice.textContent = this._fmt(newPrice);
  if (!dir) return;
  this.tickerEl.classList.remove("flash-up","flash-down");
  void this.tickerEl.offsetWidth;
  this.tickerEl.classList.add(dir === "up" ? "flash-up" : "flash-down");
  setTimeout(function() { this.tickerEl.classList.remove("flash-up","flash-down"); }.bind(this), 650);
};

ChartPane.prototype._updateTicker = function(price, refPrice) {
  var pct  = refPrice && refPrice !== price ? (price - refPrice) / refPrice * 100 : 0;
  var sign = pct >= 0 ? "+" : "";
  this.tPrice.textContent  = this._fmt(price);
  this.tChange.textContent = sign + pct.toFixed(2) + "%";
  this.tChange.className   = "t-change " + (pct > 0 ? "up" : pct < 0 ? "down" : "neutral");
};

ChartPane.prototype._fmt = function(p) {
  if (p >= 1000) return p.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(2);
  return p.toFixed(6);
};

// ── loading / error UI ────────────────────────────────────────────────────────
ChartPane.prototype._setLoading = function(on) {
  this.loadingEl.classList.toggle("hidden", !on);
};

ChartPane.prototype._showError = function(msg) {
  this.errorMsgEl.textContent = msg;
  this.errorEl.classList.remove("hidden");
};

ChartPane.prototype._clearError = function() {
  this.errorEl.classList.add("hidden");
  this.errorMsgEl.textContent = "";
};

// ── theme ─────────────────────────────────────────────────────────────────────
ChartPane.prototype.applyTheme = function() {
  if (this.chart) this.chart.applyOptions(_getChartTheme());
  var isDark = document.documentElement.getAttribute("data-theme") !== "light";
  if (this.indicatorMgr) this.indicatorMgr.applyTheme(isDark);
};

// ── cleanup ───────────────────────────────────────────────────────────────────
ChartPane.prototype._cleanup = function() {
  if (this.unsubC)     { this.unsubC();                 this.unsubC     = null; }
  if (this.unsubM)     { this.unsubM();                 this.unsubM     = null; }
  if (this.unsubBn)    { this.unsubBn();                this.unsubBn    = null; }
  if (this.pollTimer)  { clearInterval(this.pollTimer); this.pollTimer  = null; }
  if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
  clearTimeout(this._indTimer);
};

ChartPane.prototype.destroy = function() {
  this._cleanup();
  this._hideDropdown();
  if (this.symDropdown && this.symDropdown.parentNode) {
    this.symDropdown.parentNode.removeChild(this.symDropdown);
  }
  if (typeof DrawEngine !== "undefined") DrawEngine.detach(this);
  if (this.indicatorMgr) { this.indicatorMgr.destroy(); }
  if (this.resizeObs)    { this.resizeObs.disconnect(); }
  if (this.chart && this._histRangeHandler) {
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._histRangeHandler);
  }
  if (this.chart)        { this.chart.remove(); this.chart = null; }
};
