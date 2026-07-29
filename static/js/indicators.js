/**
 * indicators.js - Technical indicator calculations + IndicatorManager
 *
 * Math functions are pure (no LWC dependency) and receive full candle arrays.
 * IndicatorManager owns all LWC series for a single chart pane and handles
 * layout, theme, enable/disable, and update lifecycle.
 *
 * Supported indicators
 * --------------------
 * Overlays (on main price scale):
 *   SMA20, SMA50, SMA200, EMA20, EMA50, EMA200, BB, VWAP
 *
 * Oscillators (separate sub-panes):
 *   RSI, MACD, ATR, OBV
 *
 * Canvas overlays (drawn on HTML canvas):
 *   VOL_PROFILE, FVG, OB
 *
 * Volume histogram (always present, toggling hides/shows it):
 *   VOLUME
 */

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

function calculateSMA(candles, period) {
  var result = [];
  for (var i = period - 1; i < candles.length; i++) {
    var sum = 0;
    for (var j = 0; j < period; j++) sum += candles[i - j].close;
    result.push({ time: candles[i].time, value: sum / period });
  }
  return result;
}

function calculateEMA(candles, period) {
  if (candles.length < period) return [];
  var k = 2 / (period + 1);
  var result = [];
  // Seed with SMA of first `period` bars
  var seed = 0;
  for (var i = 0; i < period; i++) seed += candles[i].close;
  var ema = seed / period;
  result.push({ time: candles[period - 1].time, value: ema });
  for (var i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    result.push({ time: candles[i].time, value: ema });
  }
  return result;
}

function calculateBollingerBands(candles, period, mult) {
  period = period || 20;
  mult   = mult   || 2;
  var upper = [], middle = [], lower = [];
  for (var i = period - 1; i < candles.length; i++) {
    var slice = candles.slice(i - period + 1, i + 1).map(function(c) { return c.close; });
    var mean  = slice.reduce(function(a, b) { return a + b; }, 0) / period;
    var variance = slice.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / period;
    var std   = Math.sqrt(variance);
    var t = candles[i].time;
    middle.push({ time: t, value: mean });
    upper.push(  { time: t, value: mean + mult * std });
    lower.push(  { time: t, value: mean - mult * std });
  }
  return { upper: upper, middle: middle, lower: lower };
}

function calculateRSI(candles, period) {
  period = period || 14;
  if (candles.length <= period) return [];
  var gains = 0, losses = 0;
  for (var i = 1; i <= period; i++) {
    var diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;
  var result = [];
  var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push({ time: candles[period].time, value: 100 - 100 / (1 + rs) });
  for (var i = period + 1; i < candles.length; i++) {
    var diff = candles[i].close - candles[i - 1].close;
    var g = diff > 0 ? diff : 0;
    var l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
  }
  return result;
}

function calculateMACD(candles, fast, slow, sigLen) {
  fast   = fast   || 12;
  slow   = slow   || 26;
  sigLen = sigLen || 9;
  var fastEMA = calculateEMA(candles, fast);
  var slowEMA = calculateEMA(candles, slow);
  // Align by time
  var fastMap = {};
  fastEMA.forEach(function(p) { fastMap[p.time] = p.value; });
  var macdLine = [];
  slowEMA.forEach(function(p) {
    if (fastMap[p.time] != null) {
      macdLine.push({ time: p.time, value: fastMap[p.time] - p.value });
    }
  });
  if (macdLine.length < sigLen) return { macd: [], signal: [], hist: [] };
  // Signal = EMA(macdLine, sigLen)
  var k = 2 / (sigLen + 1);
  var seed = macdLine.slice(0, sigLen).reduce(function(s, p) { return s + p.value; }, 0) / sigLen;
  var sig = seed;
  var signal = [{ time: macdLine[sigLen - 1].time, value: sig }];
  for (var i = sigLen; i < macdLine.length; i++) {
    sig = macdLine[i].value * k + sig * (1 - k);
    signal.push({ time: macdLine[i].time, value: sig });
  }
  // Align and build histogram
  var sigMap = {};
  signal.forEach(function(p) { sigMap[p.time] = p.value; });
  var hist = macdLine.filter(function(p) { return sigMap[p.time] != null; })
    .map(function(p) {
      var h = p.value - sigMap[p.time];
      return { time: p.time, value: h, color: h >= 0 ? "#26a69a" : "#ef5350" };
    });
  return { macd: macdLine, signal: signal, hist: hist };
}

function calculateVWAP(candles) {
  // VWAP resets at the start of each day (unix midnight UTC boundary)
  var result = [];
  var cumPV = 0, cumV = 0;
  var lastDay = -1;
  for (var i = 0; i < candles.length; i++) {
    var c = candles[i];
    var day = Math.floor(c.time / 86400);
    if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
    var tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV  += c.volume;
    if (cumV > 0) result.push({ time: c.time, value: cumPV / cumV });
  }
  return result;
}

function calculateATR(candles, period) {
  period = period || 14;
  if (candles.length < 2) return [];
  var trs = [];
  for (var i = 1; i < candles.length; i++) {
    var c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothing
  var atr = trs.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  var result = [{ time: candles[period].time, value: atr }];
  for (var i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result.push({ time: candles[i + 1].time, value: atr });
  }
  return result;
}

function calculateOBV(candles) {
  var result = [];
  var obv = 0;
  for (var i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close)      obv += candles[i].volume;
      else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    }
    result.push({ time: candles[i].time, value: obv });
  }
  return result;
}

function calculatePivotPoints(candles, interval) {
  if (!candles || candles.length < 2) return null;
  var prevH, prevL, prevC;
  var isIntraday = ["1m","5m","15m","30m","1h","4h"].indexOf(interval) !== -1;
  if (isIntraday) {
    var dayGroups = {};
    candles.forEach(function(c) {
      var day = Math.floor(c.time / 86400);
      if (!dayGroups[day]) dayGroups[day] = [];
      dayGroups[day].push(c);
    });
    var days = Object.keys(dayGroups).sort(function(a, b) { return +a - +b; });
    if (days.length < 2) return null;
    var pd = dayGroups[days[days.length - 2]];
    prevH = Math.max.apply(null, pd.map(function(c) { return c.high; }));
    prevL = Math.min.apply(null, pd.map(function(c) { return c.low;  }));
    prevC = pd[pd.length - 1].close;
  } else {
    var prev = candles[candles.length - 2];
    prevH = prev.high; prevL = prev.low; prevC = prev.close;
  }
  var PP = (prevH + prevL + prevC) / 3;
  return {
    PP: PP,
    R1: 2*PP - prevL,           S1: 2*PP - prevH,
    R2: PP + (prevH - prevL),   S2: PP - (prevH - prevL),
    R3: prevH + 2*(PP - prevL), S3: prevL - 2*(prevH - PP),
  };
}

function calculateVolumeProfile(candles, numBuckets) {
  numBuckets = numBuckets || 24;
  if (!candles.length) return [];
  var lo = Infinity, hi = -Infinity;
  candles.forEach(function(c) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); });
  var range = hi - lo;
  if (range === 0) return [];
  var buckets = [];
  for (var i = 0; i < numBuckets; i++) buckets.push(0);
  candles.forEach(function(c) {
    var tp = (c.high + c.low + c.close) / 3;
    var idx = Math.min(numBuckets - 1, Math.floor((tp - lo) / range * numBuckets));
    buckets[idx] += c.volume;
  });
  var maxVol = Math.max.apply(null, buckets);
  var avgVol = buckets.reduce(function(a, b) { return a + b; }, 0) / numBuckets;
  var poc = buckets.indexOf(maxVol);
  return buckets.map(function(vol, i) {
    var price = lo + (i + 0.5) * range / numBuckets;
    return {
      price:  price,
      volume: vol,
      pct:    maxVol > 0 ? vol / maxVol : 0,
      isPOC:  i === poc,
      isHVN:  vol > avgVol * 1.5,
      isLVN:  vol < avgVol * 0.5 && vol > 0,
    };
  });
}

function detectFairValueGaps(candles, maxGaps) {
  maxGaps = maxGaps || 20;
  var gaps = [];
  for (var i = 1; i < candles.length - 1; i++) {
    var prev = candles[i - 1], cur = candles[i], next = candles[i + 1];
    if (prev.high < next.low) {
      // Bullish FVG: gap between prev high and next low
      gaps.push({ type: "bull", top: next.low, bottom: prev.high, time: cur.time });
    } else if (prev.low > next.high) {
      // Bearish FVG: gap between next high and prev low
      gaps.push({ type: "bear", top: prev.low, bottom: next.high, time: cur.time });
    }
  }
  // Return most recent gaps
  return gaps.slice(-maxGaps);
}

function detectOrderBlocks(candles, lookback) {
  lookback = lookback || 50;
  var slice = candles.slice(-lookback);
  var blocks = [];
  var avgBody = 0;
  slice.forEach(function(c) { avgBody += Math.abs(c.close - c.open); });
  avgBody /= slice.length || 1;

  for (var i = 1; i < slice.length - 2; i++) {
    var c = slice[i];
    var bodySize = Math.abs(c.close - c.open);
    if (bodySize < avgBody * 0.5) continue; // skip small candles

    // Bullish OB: bearish candle followed by strong bullish move
    var nextMove = slice[i + 1].close - slice[i + 1].open;
    if (c.close < c.open && nextMove > avgBody) {
      blocks.push({ type: "bull", top: c.open, bottom: c.close, time: c.time });
    }
    // Bearish OB: bullish candle followed by strong bearish move
    if (c.close > c.open && -nextMove > avgBody) {
      blocks.push({ type: "bear", top: c.close, bottom: c.open, time: c.time });
    }
  }
  return blocks.slice(-15);
}


// ─────────────────────────────────────────────────────────────────────────────
// Canvas overlay for Volume Profile, FVG, Order Blocks
// ─────────────────────────────────────────────────────────────────────────────

function CanvasOverlay(chart, chartWrap, candleSeries) {
  this.chart        = chart;
  this.chartWrap    = chartWrap;
  this.candleSeries = candleSeries;
  this.canvas       = document.createElement("canvas");
  this.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:3";
  chartWrap.appendChild(this.canvas);
  this._data = null;

  this._redraw = this._redraw.bind(this);
  chart.timeScale().subscribeVisibleLogicalRangeChange(this._redraw);
  chart.subscribeCrosshairMove(this._redraw);

  // Resize the canvas whenever the wrapper changes size
  this._resizeObs = new ResizeObserver(this._redraw);
  this._resizeObs.observe(chartWrap);
}

CanvasOverlay.prototype._redraw = function() {
  var w = this.chartWrap.clientWidth;
  var h = this.chartWrap.clientHeight;
  this.canvas.width  = w;
  this.canvas.height = h;
  var ctx = this.canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (this._data) this._draw(ctx, w, h);
};

CanvasOverlay.prototype._priceToY = function(price) {
  try { return this.candleSeries.priceToCoordinate(price); } catch(e) { return null; }
};

CanvasOverlay.prototype.setData = function(data) {
  this._data = data;
  this._redraw();
};

CanvasOverlay.prototype.destroy = function() {
  this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._redraw);
  this.chart.unsubscribeCrosshairMove(this._redraw);
  this._resizeObs.disconnect();
  this.canvas.remove();
};

// Volume Profile overlay
function VolumeProfileOverlay(chart, chartWrap, candleSeries) {
  CanvasOverlay.call(this, chart, chartWrap, candleSeries);
  this._isDark = true;
}
VolumeProfileOverlay.prototype = Object.create(CanvasOverlay.prototype);

VolumeProfileOverlay.prototype._draw = function(ctx, w, h) {
  var buckets = this._data;
  if (!buckets || !buckets.length) return;
  var barMaxWidth = Math.min(w * 0.18, 90);
  for (var i = 0; i < buckets.length; i++) {
    var b = buckets[i];
    var y = this._priceToY(b.price);
    if (y == null || y < 0 || y > h) continue;
    var barW = b.pct * barMaxWidth;
    if (barW < 1) continue;
    var barH = Math.max(2, h / buckets.length - 1);
    if (b.isPOC) {
      ctx.fillStyle = "rgba(255, 200, 50, 0.75)";
    } else if (b.isHVN) {
      ctx.fillStyle = this._isDark ? "rgba(56,139,253,0.50)" : "rgba(26,86,219,0.45)";
    } else {
      ctx.fillStyle = this._isDark ? "rgba(56,139,253,0.22)" : "rgba(26,86,219,0.18)";
    }
    ctx.fillRect(0, y - barH / 2, barW, barH);
  }
};

// Fair Value Gap overlay
function FVGOverlay(chart, chartWrap, candleSeries) {
  CanvasOverlay.call(this, chart, chartWrap, candleSeries);
  this._isDark = true;
}
FVGOverlay.prototype = Object.create(CanvasOverlay.prototype);

FVGOverlay.prototype._draw = function(ctx, w, h) {
  var gaps = this._data;
  if (!gaps || !gaps.length) return;
  for (var i = 0; i < gaps.length; i++) {
    var g = gaps[i];
    var yTop    = this._priceToY(g.top);
    var yBottom = this._priceToY(g.bottom);
    if (yTop == null || yBottom == null) continue;
    var gapH = Math.abs(yBottom - yTop);
    if (gapH < 1) continue;
    var y = Math.min(yTop, yBottom);
    ctx.fillStyle = g.type === "bull"
      ? "rgba(38,166,154,0.18)"
      : "rgba(239,83,80,0.18)";
    ctx.fillRect(0, y, w, gapH);
    // Border line at gap edges
    ctx.strokeStyle = g.type === "bull" ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, yTop);    ctx.lineTo(w, yTop);    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, yBottom); ctx.lineTo(w, yBottom); ctx.stroke();
    ctx.setLineDash([]);
  }
};

// Order Block overlay
function OBOverlay(chart, chartWrap, candleSeries) {
  CanvasOverlay.call(this, chart, chartWrap, candleSeries);
  this._isDark = true;
}
OBOverlay.prototype = Object.create(CanvasOverlay.prototype);

OBOverlay.prototype._draw = function(ctx, w, h) {
  var blocks = this._data;
  if (!blocks || !blocks.length) return;
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var yTop    = this._priceToY(b.top);
    var yBottom = this._priceToY(b.bottom);
    if (yTop == null || yBottom == null) continue;
    var bH = Math.abs(yBottom - yTop);
    if (bH < 1) continue;
    var y = Math.min(yTop, yBottom);
    ctx.fillStyle = b.type === "bull"
      ? "rgba(38,166,154,0.14)"
      : "rgba(239,83,80,0.14)";
    ctx.fillRect(0, y, w, bH);
    ctx.strokeStyle = b.type === "bull" ? "#26a69a" : "#ef5350";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, y, w, bH);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = b.type === "bull" ? "#26a69a" : "#ef5350";
    ctx.fillText(b.type === "bull" ? "Bull OB" : "Bear OB", 4, y + 12);
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// IndicatorManager
// ─────────────────────────────────────────────────────────────────────────────

var IND_OVERLAYS    = ["SMA20","SMA50","SMA200","EMA20","EMA50","EMA200","BB","VWAP"];
var IND_OSCILLATORS = ["RSI","MACD","ATR","OBV"];
var IND_CANVAS      = ["VOL_PROFILE","FVG","OB"];
var IND_PRICE_LINES = ["PIVOT"];

var _PIVOT_COLORS = {
  PP: "#9E9E9E",
  R1: "#ef5350", R2: "#e53935", R3: "#c62828",
  S1: "#26a69a", S2: "#00897b", S3: "#00695c",
};

// Sub-pane height fractions (of total chart height)
var _OSC_H = 0.18;
var _VOL_H = 0.08;

function _computeMargins(activeOscs) {
  var n = activeOscs.length;
  var totalOsc = n * _OSC_H;
  var margins = {
    right: { top: 0.02, bottom: totalOsc + _VOL_H },
    vol:   { top: 1 - totalOsc - _VOL_H, bottom: totalOsc }
  };
  for (var i = 0; i < n; i++) {
    var bottom = (n - 1 - i) * _OSC_H;
    var top    = 1 - _OSC_H - bottom;
    margins[activeOscs[i].toLowerCase()] = { top: top, bottom: bottom };
  }
  return margins;
}

var _OVERLAY_COLORS = {
  SMA20:  "#f48024",
  SMA50:  "#2962ff",
  SMA200: "#e91e63",
  EMA20:  "#ff9800",
  EMA50:  "#4caf50",
  EMA200: "#9c27b0",
  VWAP:   "#00bcd4",
};

/**
 * IndicatorManager
 * @param {IChartApi} chart
 * @param {HTMLElement} chartWrap
 * @param {ISeriesApi} candleSeries
 * @param {ISeriesApi} volSeries
 * @param {number} paneIndex
 */
function IndicatorManager(chart, chartWrap, candleSeries, volSeries, paneIndex) {
  this.chart        = chart;
  this.chartWrap    = chartWrap;
  this.candleSeries = candleSeries;
  this.volSeries    = volSeries;
  this.paneIndex    = paneIndex;

  this._enabled  = {};  // name -> bool
  this._series   = {};  // name -> ISeriesApi or {line,signal,hist} for MACD
  this._overlays = {};  // name -> CanvasOverlay
  this._dark     = true;

  // Load saved enabled state from localStorage
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem("inds-" + paneIndex)); } catch(e) {}
  if (saved && typeof saved === "object") this._enabled = saved;
}

IndicatorManager.prototype._saveEnabled = function() {
  localStorage.setItem("inds-" + this.paneIndex, JSON.stringify(this._enabled));
};

IndicatorManager.prototype.isEnabled = function(name) {
  return !!this._enabled[name];
};

IndicatorManager.prototype.setEnabled = function(name, on) {
  this._enabled[name] = !!on;
  this._saveEnabled();
  if (!on) {
    this._removeSeries(name);
    if (IND_OSCILLATORS.indexOf(name) !== -1) this._relayout();
  }
  // Creation happens in update() below
};

IndicatorManager.prototype._relayout = function() {
  var activeOscs = IND_OSCILLATORS.filter(function(n) { return this._enabled[n]; }, this);
  var margins = _computeMargins(activeOscs);
  try { this.chart.priceScale("right").applyOptions({ scaleMargins: margins.right }); } catch(e) {}
  try { this.chart.priceScale("vol").applyOptions(  { scaleMargins: margins.vol   }); } catch(e) {}
  var self = this;
  activeOscs.forEach(function(n) {
    try { self.chart.priceScale(n.toLowerCase()).applyOptions({ scaleMargins: margins[n.toLowerCase()] }); } catch(e) {}
  });
};

IndicatorManager.prototype._removeSeries = function(name) {
  var s = this._series[name];
  if (!s) return;
  try {
    if (name === "MACD") {
      if (s.hist)   this.chart.removeSeries(s.hist);
      if (s.macd)   this.chart.removeSeries(s.macd);
      if (s.signal) this.chart.removeSeries(s.signal);
    } else if (name === "BB") {
      if (s.upper)  this.chart.removeSeries(s.upper);
      if (s.middle) this.chart.removeSeries(s.middle);
      if (s.lower)  this.chart.removeSeries(s.lower);
    } else if (name === "PIVOT") {
      var self = this;
      ["PP","R1","R2","R3","S1","S2","S3"].forEach(function(k) {
        if (s[k]) try { self.candleSeries.removePriceLine(s[k]); } catch(e) {}
      });
    } else {
      this.chart.removeSeries(s);
    }
  } catch(e) {}
  delete this._series[name];

  var ov = this._overlays[name];
  if (ov) { ov.destroy(); delete this._overlays[name]; }
};

IndicatorManager.prototype._lineOpts = function(color, scaleId, title, width) {
  return {
    color:        color,
    lineWidth:    width || 1,
    priceScaleId: scaleId || "right",
    lastValueVisible: false,
    priceLineVisible: false,
    title: title || "",
  };
};

IndicatorManager.prototype._histOpts = function(scaleId) {
  return {
    priceScaleId:     scaleId,
    lastValueVisible: false,
    priceLineVisible: false,
  };
};

/**
 * Call after candles load or on live update.
 * Creates missing series, sets data, redraws canvas overlays.
 */
IndicatorManager.prototype.update = function(candles, interval) {
  if (!candles || !candles.length) return;
  var self = this;

  // ── Overlays ──
  ["SMA20","SMA50","SMA200"].forEach(function(name) {
    if (!self._enabled[name]) return;
    var period = parseInt(name.replace("SMA",""), 10);
    if (!self._series[name]) {
      self._series[name] = self.chart.addLineSeries(
        self._lineOpts(_OVERLAY_COLORS[name], "right", name, name === "SMA200" ? 1.5 : 1));
    }
    self._series[name].setData(calculateSMA(candles, period));
  });

  ["EMA20","EMA50","EMA200"].forEach(function(name) {
    if (!self._enabled[name]) return;
    var period = parseInt(name.replace("EMA",""), 10);
    if (!self._series[name]) {
      self._series[name] = self.chart.addLineSeries(
        self._lineOpts(_OVERLAY_COLORS[name], "right", name, name === "EMA200" ? 1.5 : 1));
    }
    self._series[name].setData(calculateEMA(candles, period));
  });

  if (self._enabled["VWAP"]) {
    var isIntraday = ["1m","5m","15m","30m","1h","4h"].indexOf(interval) !== -1;
    if (isIntraday) {
      if (!self._series["VWAP"]) {
        self._series["VWAP"] = self.chart.addLineSeries(
          self._lineOpts(_OVERLAY_COLORS["VWAP"], "right", "VWAP", 1.5));
      }
      self._series["VWAP"].setData(calculateVWAP(candles));
    } else if (self._series["VWAP"]) {
      self._removeSeries("VWAP");
    }
  }

  if (self._enabled["BB"]) {
    var bb = calculateBollingerBands(candles, 20, 2);
    if (!self._series["BB"]) {
      var bbColor = self._dark ? "rgba(150,120,255,0.8)" : "rgba(100,60,220,0.8)";
      var bbFill  = self._dark ? "rgba(150,120,255,0.08)" : "rgba(100,60,220,0.08)";
      self._series["BB"] = {
        upper:  self.chart.addLineSeries(self._lineOpts(bbColor, "right", "BB Upper", 1)),
        middle: self.chart.addLineSeries(self._lineOpts(bbColor, "right", "BB Mid",   1)),
        lower:  self.chart.addLineSeries(self._lineOpts(bbColor, "right", "BB Lower", 1)),
      };
    }
    self._series["BB"].upper.setData(bb.upper);
    self._series["BB"].middle.setData(bb.middle);
    self._series["BB"].lower.setData(bb.lower);
  }

  // ── Pivot Points ──
  if (self._enabled["PIVOT"]) {
    if (self._series["PIVOT"]) self._removeSeries("PIVOT");
    var pivots = calculatePivotPoints(candles, interval);
    if (pivots) {
      var pvLines = {};
      Object.keys(_PIVOT_COLORS).forEach(function(k) {
        pvLines[k] = self.candleSeries.createPriceLine({
          price: pivots[k],
          color: _PIVOT_COLORS[k],
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: k,
        });
      });
      self._series["PIVOT"] = pvLines;
    }
  }

  // ── Oscillators ──
  if (self._enabled["RSI"]) {
    if (!self._series["RSI"]) {
      self._relayout();
      var rsiS = self.chart.addLineSeries({
        color: "#f48024", lineWidth: 1.5,
        priceScaleId: "rsi",
        lastValueVisible: true, priceLineVisible: false, title: "RSI(14)",
      });
      self.chart.priceScale("rsi").applyOptions({
        scaleMargins: _computeMargins(IND_OSCILLATORS.filter(function(n) { return self._enabled[n]; }))["rsi"] || { top: 0.82, bottom: 0 },
        borderVisible: true,
      });
      self._series["RSI"] = rsiS;
    }
    self._series["RSI"].setData(calculateRSI(candles, 14));
  }

  if (self._enabled["MACD"]) {
    var macdData = calculateMACD(candles, 12, 26, 9);
    if (!self._series["MACD"]) {
      self._relayout();
      self._series["MACD"] = {
        hist:   self.chart.addHistogramSeries(Object.assign(self._histOpts("macd"), { title: "MACD Hist" })),
        macd:   self.chart.addLineSeries({ color: "#2962ff", lineWidth: 1, priceScaleId: "macd", lastValueVisible: false, priceLineVisible: false, title: "MACD" }),
        signal: self.chart.addLineSeries({ color: "#ef5350", lineWidth: 1, priceScaleId: "macd", lastValueVisible: false, priceLineVisible: false, title: "Signal" }),
      };
    }
    self._series["MACD"].hist.setData(macdData.hist);
    self._series["MACD"].macd.setData(macdData.macd);
    self._series["MACD"].signal.setData(macdData.signal);
  }

  if (self._enabled["ATR"]) {
    if (!self._series["ATR"]) {
      self._relayout();
      self._series["ATR"] = self.chart.addLineSeries({
        color: "#ff9800", lineWidth: 1,
        priceScaleId: "atr",
        lastValueVisible: true, priceLineVisible: false, title: "ATR(14)",
      });
    }
    self._series["ATR"].setData(calculateATR(candles, 14));
  }

  if (self._enabled["OBV"]) {
    if (!self._series["OBV"]) {
      self._relayout();
      self._series["OBV"] = self.chart.addLineSeries({
        color: "#00bcd4", lineWidth: 1,
        priceScaleId: "obv",
        lastValueVisible: true, priceLineVisible: false, title: "OBV",
      });
    }
    self._series["OBV"].setData(calculateOBV(candles));
  }

  // Relayout after all oscillators are created
  self._relayout();

  // ── Volume (toggle show/hide) ──
  if (self.volSeries) {
    // VOLUME toggle just shows/hides existing series
    // (Vol series is always created by ChartPane; we just control applyOptions)
    self.volSeries.applyOptions({ visible: self._enabled["VOLUME"] !== false });
  }

  // ── Canvas overlays ──
  if (self._enabled["VOL_PROFILE"]) {
    if (!self._overlays["VOL_PROFILE"]) {
      var vp = new VolumeProfileOverlay(self.chart, self.chartWrap, self.candleSeries);
      vp._isDark = self._dark;
      self._overlays["VOL_PROFILE"] = vp;
    }
    self._overlays["VOL_PROFILE"].setData(calculateVolumeProfile(candles, 24));
  }

  if (self._enabled["FVG"]) {
    if (!self._overlays["FVG"]) {
      var fvg = new FVGOverlay(self.chart, self.chartWrap, self.candleSeries);
      fvg._isDark = self._dark;
      self._overlays["FVG"] = fvg;
    }
    self._overlays["FVG"].setData(detectFairValueGaps(candles, 20));
  }

  if (self._enabled["OB"]) {
    if (!self._overlays["OB"]) {
      var ob = new OBOverlay(self.chart, self.chartWrap, self.candleSeries);
      ob._isDark = self._dark;
      self._overlays["OB"] = ob;
    }
    self._overlays["OB"].setData(detectOrderBlocks(candles, 50));
  }

  // Remove canvas overlays that were disabled
  ["VOL_PROFILE","FVG","OB"].forEach(function(name) {
    if (!self._enabled[name] && self._overlays[name]) {
      self._overlays[name].destroy();
      delete self._overlays[name];
    }
  });
};

IndicatorManager.prototype.setAllVisible = function(visible) {
  var self = this;
  Object.keys(this._series).forEach(function(name) {
    var s = self._series[name];
    if (!s) return;
    try {
      if (name === 'MACD') {
        if (s.hist)   s.hist.applyOptions({visible: visible});
        if (s.macd)   s.macd.applyOptions({visible: visible});
        if (s.signal) s.signal.applyOptions({visible: visible});
      } else if (name === 'BB') {
        if (s.upper)  s.upper.applyOptions({visible: visible});
        if (s.middle) s.middle.applyOptions({visible: visible});
        if (s.lower)  s.lower.applyOptions({visible: visible});
      } else if (name !== 'PIVOT') {
        s.applyOptions({visible: visible});
      }
    } catch(e) {}
  });
  Object.keys(this._overlays).forEach(function(name) {
    var ov = self._overlays[name];
    if (ov && ov.canvas) ov.canvas.style.display = visible ? '' : 'none';
  });
};

IndicatorManager.prototype.applyTheme = function(isDark) {
  this._dark = isDark;
  // Update canvas overlay theme flags
  var self = this;
  Object.keys(this._overlays).forEach(function(k) { self._overlays[k]._isDark = isDark; });
};

IndicatorManager.prototype.destroy = function() {
  var self = this;
  var allNames = IND_OVERLAYS.concat(IND_OSCILLATORS).concat(IND_CANVAS).concat(IND_PRICE_LINES).concat(["VOLUME"]);
  allNames.forEach(function(n) { self._removeSeries(n); });
};
