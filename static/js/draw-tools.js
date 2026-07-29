/**
 * draw-tools.js — Drawing tool definitions (14 tools).
 *
 * Each tool exports: id, label, cursor, minPoints, icon (SVG string),
 * render(ctx, drawing, toX, toY, w, h, selected),
 * renderPreview(ctx, state, toX, toY, w, h),
 * hitTest(drawing, x, y, toX, toY),
 * onCreate(drawing)  — optional, set default meta/style.
 */

var DrawTools = (function () {
  'use strict';

  var _map = {};

  /* ── drawing utilities ──────────────────────────────────────────── */

  function _applyStyle(ctx, style) {
    ctx.strokeStyle = style.color || '#388bfd';
    ctx.lineWidth   = style.width || 1;
    ctx.globalAlpha = (style.opacity != null) ? style.opacity : 1;
    if (style.dash === 'dashed') ctx.setLineDash([6, 3]);
    else if (style.dash === 'dotted') ctx.setLineDash([2, 3]);
    else ctx.setLineDash([]);
  }

  function _handles(ctx, pts, color) {
    ctx.fillStyle   = '#fff';
    ctx.strokeStyle = color || '#388bfd';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    pts.forEach(function (p) {
      if (p[0] == null || p[1] == null) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  /* project a line (x1,y1)→(x2,y2) to both canvas edges, returns [[x,y],[x,y]] */
  function _extendLine(x1, y1, x2, y2, w, h) {
    if (Math.abs(x2 - x1) < 0.5) return [[x1, 0], [x1, h]]; // vertical
    var m  = (y2 - y1) / (x2 - x1);
    var b  = y1 - m * x1;
    var pts = [];
    var candidates = [
      [0,      b],
      [w,      m * w + b],
      [(0 - b) / m,     0],
      [(h - b) / m,     h],
    ];
    candidates.forEach(function (p) {
      if (p[0] >= -1 && p[0] <= w + 1 && p[1] >= -1 && p[1] <= h + 1) pts.push(p);
    });
    /* de-dupe */
    var out = [];
    pts.forEach(function (p) {
      if (!out.length || Math.abs(p[0] - out[0][0]) > 1 || Math.abs(p[1] - out[0][1]) > 1) out.push(p);
    });
    return out.length >= 2 ? [out[0], out[1]] : [[x1, y1], [x2, y2]];
  }

  function _lineDist(x1, y1, x2, y2, px, py) {
    var len2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    var t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / len2));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
  }

  function _previewLine(ctx, x1, y1, x2, y2, color) {
    ctx.strokeStyle = color || '#388bfd';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 3]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.fillStyle = color || '#388bfd';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x1, y1, 3, 0, Math.PI * 2); ctx.fill();
  }

  function _reg(t) { _map[t.id] = t; }

  /* ── 1. Trend Line ──────────────────────────────────────────────── */
  _reg({
    id: 'trendline', label: 'Trend Line', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="16" x2="17" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3" cy="16" r="2" fill="currentColor"/><circle cx="17" cy="4" r="2" fill="currentColor"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price);
      var x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      _applyStyle(ctx, d.style);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.stroke();
      if (sel) _handles(ctx, [[x1, y1], [x2, y2]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var x1 = toX(p1.time), y1 = toY(p1.price);
      var x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      _previewLine(ctx, x1, y1, x2, y2);
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price);
      var x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      return _lineDist(x1, y1, x2, y2, x, y) < 7;
    },
  });

  /* ── 2. Horizontal Line ─────────────────────────────────────────── */
  _reg({
    id: 'hline', label: 'Horizontal Line', cursor: 'crosshair', minPoints: 1,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="10" y1="6" x2="10" y2="14" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var y = toY(d.points[0].price);
      if (y == null) return;
      _applyStyle(ctx, d.style);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle   = d.style.color || '#388bfd';
      ctx.font        = '10px monospace';
      ctx.textAlign   = 'right';
      ctx.fillText(d.points[0].price.toFixed(4), w - 4, y - 3);
      ctx.textAlign   = 'left';
      if (sel) _handles(ctx, [[w / 2, y]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY, w) {
      if (!state.preview) return;
      var y = toY(state.preview.price);
      if (y == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    },
    hitTest: function (d, x, y, toX, toY) {
      var py = toY(d.points[0].price);
      return py != null && Math.abs(y - py) < 7;
    },
  });

  /* ── 3. Vertical Line ───────────────────────────────────────────── */
  _reg({
    id: 'vline', label: 'Vertical Line', cursor: 'crosshair', minPoints: 1,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="10" y1="2" x2="10" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="6" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var x = toX(d.points[0].time);
      if (x == null) return;
      _applyStyle(ctx, d.style);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      if (sel) _handles(ctx, [[x, h / 2]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY, w, h) {
      if (!state.preview) return;
      var x = toX(state.preview.time);
      if (x == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    },
    hitTest: function (d, x, y, toX) {
      var px = toX(d.points[0].time);
      return px != null && Math.abs(x - px) < 7;
    },
  });

  /* ── 4. Ray ─────────────────────────────────────────────────────── */
  _reg({
    id: 'ray', label: 'Ray', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="15" x2="17" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="5 2"/><circle cx="3" cy="15" r="2" fill="currentColor"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price);
      var x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      var ext = _extendLine(x1, y1, x2, y2, w, h);
      var dx = x2 - x1, dy = y2 - y1;
      var endPt = null;
      ext.forEach(function (p) { if ((p[0] - x1) * dx + (p[1] - y1) * dy > 0) endPt = p; });
      _applyStyle(ctx, d.style);
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(endPt ? endPt[0] : x2, endPt ? endPt[1] : y2); ctx.stroke();
      if (sel) _handles(ctx, [[x1, y1], [x2, y2]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      _previewLine(ctx, x1, y1, x2, y2);
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      return _lineDist(x1, y1, x2, y2, x, y) < 7;
    },
  });

  /* ── 5. Arrow ───────────────────────────────────────────────────── */
  _reg({
    id: 'arrow', label: 'Arrow', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="4" y1="16" x2="14" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polygon points="14,6 10,8 12,12" fill="currentColor"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      _applyStyle(ctx, d.style);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      var ang = Math.atan2(y2 - y1, x2 - x1);
      var al = 13;
      ctx.setLineDash([]); ctx.fillStyle = d.style.color || '#388bfd'; ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - al * Math.cos(ang - 0.45), y2 - al * Math.sin(ang - 0.45));
      ctx.lineTo(x2 - al * Math.cos(ang + 0.45), y2 - al * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
      if (sel) _handles(ctx, [[x1, y1], [x2, y2]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      _previewLine(ctx, x1, y1, x2, y2);
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      return _lineDist(x1, y1, x2, y2, x, y) < 9;
    },
  });

  /* ── 6. Rectangle ───────────────────────────────────────────────── */
  _reg({
    id: 'rect', label: 'Rectangle', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="14" height="10" stroke="currentColor" stroke-width="1.5" rx="1"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      var rx = Math.min(x1, x2), ry = Math.min(y1, y2), rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      _applyStyle(ctx, d.style);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle   = d.style.color || '#388bfd';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = d.style.opacity != null ? d.style.opacity : 1;
      ctx.strokeRect(rx, ry, rw, rh);
      if (sel) _handles(ctx, [[x1, y1], [x2, y2], [x1, y2], [x2, y1]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.7;
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      return x >= Math.min(x1, x2) - 4 && x <= Math.max(x1, x2) + 4 &&
             y >= Math.min(y1, y2) - 4 && y <= Math.max(y1, y2) + 4;
    },
  });

  /* ── 7. Circle / Ellipse ────────────────────────────────────────── */
  _reg({
    id: 'circle', label: 'Circle', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="10" cy="10" rx="7" ry="5" stroke="currentColor" stroke-width="1.5"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var cx = toX(p1.time), cy = toY(p1.price), ex = toX(p2.time), ey = toY(p2.price);
      if (cx == null || ex == null) return;
      var rx = Math.abs(ex - cx), ry = Math.abs(ey - cy);
      if (rx < 1 || ry < 1) return;
      _applyStyle(ctx, d.style);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle   = d.style.color || '#388bfd';
      ctx.fill();
      ctx.globalAlpha = d.style.opacity != null ? d.style.opacity : 1;
      ctx.stroke();
      if (sel) _handles(ctx, [[cx, cy], [ex, ey], [cx - rx, cy], [cx, cy - ry]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var cx = toX(p1.time), cy = toY(p1.price), ex = toX(p2.time), ey = toY(p2.price);
      if (cx == null || ex == null) return;
      var rx = Math.max(Math.abs(ex - cx), 1), ry = Math.max(Math.abs(ey - cy), 1);
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var cx = toX(p1.time), cy = toY(p1.price), ex = toX(p2.time), ey = toY(p2.price);
      if (cx == null || ex == null) return false;
      var rx = Math.abs(ex - cx), ry = Math.abs(ey - cy);
      if (rx < 1 || ry < 1) return false;
      var norm = ((x - cx) / rx) * ((x - cx) / rx) + ((y - cy) / ry) * ((y - cy) / ry);
      return norm >= 0.5 && norm <= 1.6;
    },
  });

  /* ── 8. Text / Label ────────────────────────────────────────────── */
  _reg({
    id: 'text', label: 'Text', cursor: 'text', minPoints: 1,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="3" y="15" font-size="14" font-weight="bold" fill="currentColor" font-family="serif">T</text></svg>',
    onCreate: function (d) { d.meta.text = ''; d.meta.fontSize = 13; },
    render: function (ctx, d, toX, toY, w, h, sel) {
      var x = toX(d.points[0].time), y = toY(d.points[0].price);
      if (x == null || y == null) return;
      var text = d.meta.text || (sel ? 'Double-click to edit' : '');
      if (!text) return;
      var fs    = d.meta.fontSize || 13;
      var lines = text.split('\n');
      var lh    = fs + 4;
      ctx.font      = 'bold ' + fs + 'px sans-serif';
      ctx.fillStyle = d.style.color || '#388bfd';
      ctx.globalAlpha = d.style.opacity != null ? d.style.opacity : 1;
      ctx.setLineDash([]);
      lines.forEach(function (l, i) { ctx.fillText(l, x, y + lh * i); });
      if (sel) {
        var maxW = 0;
        lines.forEach(function (l) { maxW = Math.max(maxW, ctx.measureText(l).width); });
        ctx.strokeStyle = d.style.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.globalAlpha = 0.8;
        ctx.strokeRect(x - 3, y - fs - 2, maxW + 6, lh * lines.length + 4);
      }
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.preview) return;
      var x = toX(state.preview.time), y = toY(state.preview.price);
      if (x == null || y == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.globalAlpha = 0.7;
      ctx.strokeRect(x - 2, y - 14, 60, 18);
    },
    hitTest: function (d, x, y, toX, toY) {
      var px = toX(d.points[0].time), py = toY(d.points[0].price);
      if (px == null || py == null) return false;
      var text = d.meta.text || '';
      var fs   = d.meta.fontSize || 13;
      var lh   = fs + 4;
      var lines = text.split('\n');
      var w    = Math.max(lines.length ? text.length * fs * 0.55 : 40, 30);
      return x >= px - 4 && x <= px + w && y >= py - fs - 2 && y <= py + lh * lines.length + 2;
    },
  });

  /* ── 9. Fibonacci Retracement ───────────────────────────────────── */
  var FIBO_R_LEVELS  = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
  var FIBO_R_COLORS  = ['#f23645', '#ff9800', '#ffeb3b', '#26a69a', '#26a69a', '#ff9800', '#f23645'];

  _reg({
    id: 'fibr', label: 'Fib Retracement', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="4"  x2="18" y2="4"  stroke="#f44" stroke-width="1"/><line x1="2" y1="8"  x2="18" y2="8"  stroke="#fa0" stroke-width="1"/><line x1="2" y1="12" x2="18" y2="12" stroke="#4a4" stroke-width="1"/><line x1="2" y1="16" x2="18" y2="16" stroke="#f44" stroke-width="1"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      var priceDiff = p1.price - p2.price;
      var prevY = null;
      ctx.setLineDash([]);
      FIBO_R_LEVELS.forEach(function (lvl, i) {
        var price = p2.price + priceDiff * lvl;
        var fy    = toY(price);
        if (fy == null) return;
        var col = FIBO_R_COLORS[i];
        if (prevY != null) {
          ctx.fillStyle = col; ctx.globalAlpha = 0.04;
          ctx.fillRect(0, Math.min(fy, prevY), w, Math.abs(fy - prevY));
        }
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
        ctx.fillStyle = col; ctx.font = '9px monospace'; ctx.globalAlpha = 1;
        ctx.fillText(lvl.toFixed(3) + '  ' + price.toFixed(4), w - 118, fy - 2);
        prevY = fy;
      });
      if (sel) _handles(ctx, [[x1, y1], [x2, y2]], d.style.color || FIBO_R_COLORS[3]);
    },
    renderPreview: function (ctx, state, toX, toY, w) {
      if (!state.points.length || !state.preview) return;
      var y1 = toY(state.points[0].price), y2 = toY(state.preview.price);
      if (y1 == null || y2 == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.5;
      [y1, y2].forEach(function (fy) {
        ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
      });
    },
    hitTest: function (d, x, y, toX, toY) {
      var priceDiff = d.points[0].price - d.points[1].price;
      for (var i = 0; i < FIBO_R_LEVELS.length; i++) {
        var price = d.points[1].price + priceDiff * FIBO_R_LEVELS[i];
        var fy = toY(price);
        if (fy != null && Math.abs(y - fy) < 7) return true;
      }
      return false;
    },
  });

  /* ── 10. Fibonacci Extension ────────────────────────────────────── */
  var FIBO_E_LEVELS = [1.0, 1.272, 1.414, 1.618, 2.0, 2.618];

  _reg({
    id: 'fibe', label: 'Fib Extension', cursor: 'crosshair', minPoints: 3,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="4"  x2="18" y2="4"  stroke="#f44" stroke-width="1"/><line x1="2" y1="9"  x2="18" y2="9"  stroke="#fa0" stroke-width="1"/><line x1="2" y1="14" x2="18" y2="14" stroke="#4a4" stroke-width="1"/><text x="13" y="19" font-size="5" fill="currentColor">ext</text></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      if (d.points.length < 3) return;
      var p1 = d.points[0], p2 = d.points[1], p3 = d.points[2];
      var x3 = toX(p3.time);
      var range = Math.abs(p1.price - p2.price);
      var dir   = p2.price < p1.price ? 1 : -1;
      ctx.setLineDash([]);
      FIBO_E_LEVELS.forEach(function (lvl, i) {
        var price = p3.price - dir * range * lvl;
        var fy    = toY(price);
        if (fy == null) return;
        var col = FIBO_R_COLORS[Math.min(i, FIBO_R_COLORS.length - 1)];
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke();
        ctx.fillStyle = col; ctx.font = '9px monospace'; ctx.globalAlpha = 1;
        ctx.fillText(lvl.toFixed(3) + '  ' + price.toFixed(4), w - 118, fy - 2);
      });
      if (sel && x3 != null) _handles(ctx, [[toX(p1.time), toY(p1.price)], [toX(p2.time), toY(p2.price)], [x3, toY(p3.price)]], d.style.color || FIBO_R_COLORS[3]);
    },
    renderPreview: function (ctx, state, toX, toY, w) {
      if (!state.preview) return;
      var y = toY(state.preview.price);
      if (y == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (state.points.length >= 1) {
        var y0 = toY(state.points[0].price);
        if (y0 != null) { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke(); }
      }
      if (state.points.length >= 2) {
        var y1 = toY(state.points[1].price);
        if (y1 != null) { ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(w, y1); ctx.stroke(); }
      }
    },
    hitTest: function (d, x, y, toX, toY) {
      if (d.points.length < 3) return false;
      var range = Math.abs(d.points[0].price - d.points[1].price);
      var dir   = d.points[1].price < d.points[0].price ? 1 : -1;
      for (var i = 0; i < FIBO_E_LEVELS.length; i++) {
        var price = d.points[2].price - dir * range * FIBO_E_LEVELS[i];
        var fy = toY(price);
        if (fy != null && Math.abs(y - fy) < 7) return true;
      }
      return false;
    },
  });

  /* ── 11. Parallel Channel ───────────────────────────────────────── */
  _reg({
    id: 'channel', label: 'Parallel Channel', cursor: 'crosshair', minPoints: 3,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="14" x2="18" y2="6"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="2" y1="18" x2="18" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 2"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      if (d.points.length < 3) return;
      var p1 = d.points[0], p2 = d.points[1], p3 = d.points[2];
      var x1 = toX(p1.time), y1 = toY(p1.price);
      var x2 = toX(p2.time), y2 = toY(p2.price);
      var x3 = toX(p3.time), y3 = toY(p3.price);
      if (x1 == null || x2 == null || x3 == null) return;
      var offset = y3 - y1;
      _applyStyle(ctx, d.style);
      var e1 = _extendLine(x1, y1, x2, y2, w, h);
      var e2 = _extendLine(x1, y1 + offset, x2, y2 + offset, w, h);
      ctx.beginPath(); ctx.moveTo(e1[0][0], e1[0][1]); ctx.lineTo(e1[1][0], e1[1][1]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(e2[0][0], e2[0][1]); ctx.lineTo(e2[1][0], e2[1][1]); ctx.stroke();
      ctx.globalAlpha = 0.05;
      ctx.fillStyle   = d.style.color || '#388bfd';
      ctx.beginPath();
      ctx.moveTo(e1[0][0], e1[0][1]); ctx.lineTo(e1[1][0], e1[1][1]);
      ctx.lineTo(e2[1][0], e2[1][1]); ctx.lineTo(e2[0][0], e2[0][1]);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      if (sel) _handles(ctx, [[x1, y1], [x2, y2], [x3, y3]], d.style.color);
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.preview) return;
      var pts = state.points;
      var xp = toX(state.preview.time), yp = toY(state.preview.price);
      if (xp == null || yp == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.7;
      if (pts.length >= 1) {
        var x1 = toX(pts[0].time), y1 = toY(pts[0].price);
        if (x1 != null) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(xp, yp); ctx.stroke(); }
      }
    },
    hitTest: function (d, x, y, toX, toY) {
      if (d.points.length < 2) return false;
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      if (_lineDist(x1, y1, x2, y2, x, y) < 8) return true;
      if (d.points[2]) {
        var off = toY(d.points[2].price) - y1;
        if (_lineDist(x1, y1 + off, x2, y2 + off, x, y) < 8) return true;
      }
      return false;
    },
  });

  /* ── 12. Measure Tool ───────────────────────────────────────────── */
  _reg({
    id: 'measure', label: 'Measure', cursor: 'crosshair', minPoints: 2,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="14" height="10" stroke="currentColor" stroke-width="1" stroke-dasharray="3 2"/><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1"/><line x1="3" y1="5" x2="3" y2="15" stroke="currentColor" stroke-width="1"/><line x1="17" y1="5" x2="17" y2="15" stroke="currentColor" stroke-width="1"/></svg>',
    render: function (ctx, d, toX, toY, w, h, sel) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      var rx = Math.min(x1, x2), ry = Math.min(y1, y2), rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
      ctx.fillStyle = '#388bfd'; ctx.globalAlpha = 0.07; ctx.setLineDash([]);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      var priceDiff  = p2.price - p1.price;
      var pct        = (priceDiff / p1.price * 100).toFixed(2);
      var sign       = priceDiff >= 0 ? '+' : '';
      var bx = (x1 + x2) / 2, by = Math.min(y1, y2) - 6;
      var line1 = sign + priceDiff.toFixed(4) + '  ' + sign + pct + '%';
      var bars  = d.meta.bars || '';
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(13,17,23,0.88)'; ctx.globalAlpha = 1;
      var bw2 = 140, bh2 = bars ? 32 : 20;
      ctx.fillRect(bx - bw2 / 2, by - bh2, bw2, bh2);
      ctx.textAlign = 'center';
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = priceDiff >= 0 ? '#26a69a' : '#f23645';
      ctx.fillText(line1, bx, by - (bars ? bh2 - 12 : 4));
      if (bars) { ctx.fillStyle = '#888'; ctx.font = '9px sans-serif'; ctx.fillText(bars + ' bars', bx, by - 4); }
      ctx.textAlign = 'left';
    },
    renderPreview: function (ctx, state, toX, toY) {
      if (!state.points.length || !state.preview) return;
      var p1 = state.points[0], p2 = state.preview;
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return;
      ctx.fillStyle = '#388bfd'; ctx.globalAlpha = 0.07; ctx.setLineDash([]);
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    },
    hitTest: function (d, x, y, toX, toY) {
      var p1 = d.points[0], p2 = d.points[1];
      var x1 = toX(p1.time), y1 = toY(p1.price), x2 = toX(p2.time), y2 = toY(p2.price);
      if (x1 == null || x2 == null) return false;
      return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) &&
             y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
    },
  });

  /* ── 13. Long Position ──────────────────────────────────────────── */
  _reg({
    id: 'longpos', label: 'Long Position', cursor: 'crosshair', minPoints: 1,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="10" x2="18" y2="10" stroke="#388bfd" stroke-width="1.5"/><rect x="2" y="4" width="16" height="6" fill="#26a69a" opacity="0.25"/><rect x="2" y="10" width="16" height="6" fill="#f23645" opacity="0.25"/><polygon points="10,1 13.5,5 6.5,5" fill="#26a69a"/></svg>',
    onCreate: function (d) {
      var entry  = d.points[0].price;
      d.meta.sl  = parseFloat((entry * 0.98).toPrecision(6));
      d.meta.tp  = parseFloat((entry * 1.04).toPrecision(6));
    },
    render: function (ctx, d, toX, toY, w, h, sel) {
      var entry = d.points[0].price;
      var sl    = d.meta.sl != null ? d.meta.sl : entry * 0.98;
      var tp    = d.meta.tp != null ? d.meta.tp : entry * 1.04;
      var x1    = toX(d.points[0].time) || 0;
      var ye    = toY(entry), ys = toY(sl), yt = toY(tp);
      if (ye == null || ys == null || yt == null) return;
      var x2 = w;
      ctx.setLineDash([]);
      ctx.fillStyle = '#26a69a'; ctx.globalAlpha = 0.1;
      ctx.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye));
      ctx.fillStyle = '#f23645'; ctx.globalAlpha = 0.1;
      ctx.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye));
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
      var rows = [[ye, '#388bfd', 'Entry', entry], [ys, '#f23645', 'Stop', sl], [yt, '#26a69a', 'Target', tp]];
      rows.forEach(function (r) {
        ctx.strokeStyle = r[1]; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x1, r[0]); ctx.lineTo(x2, r[0]); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = r[1]; ctx.font = 'bold 10px sans-serif';
        ctx.fillText(r[2] + ': ' + r[3].toFixed(4), x2 - 130, r[0] - 3);
      });
      var risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText('R:R  1:' + (risk > 0 ? (reward / risk).toFixed(2) : '?'), x1 + 4, ye - 5);
      if (sel) _handles(ctx, [[x1, ye], [x1, ys], [x1, yt]], '#388bfd');
    },
    renderPreview: function (ctx, state, toX, toY, w, h) {
      if (!state.preview) return;
      var y = toY(state.preview.price);
      if (y == null) return;
      ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#26a69a'; ctx.globalAlpha = 0.08;
      ctx.fillRect(0, Math.max(0, y - 50), w, 50);
      ctx.fillStyle = '#f23645';
      ctx.fillRect(0, y, w, Math.min(50, h - y));
      ctx.globalAlpha = 1;
    },
    hitTest: function (d, x, y, toX, toY) {
      var entry = d.points[0].price, sl = d.meta.sl, tp = d.meta.tp;
      var ye = toY(entry), ys = toY(sl), yt = toY(tp);
      if (ye == null) return false;
      return Math.abs(y - ye) < 7 || (ys != null && Math.abs(y - ys) < 7) || (yt != null && Math.abs(y - yt) < 7);
    },
  });

  /* ── 14. Short Position ─────────────────────────────────────────── */
  _reg({
    id: 'shortpos', label: 'Short Position', cursor: 'crosshair', minPoints: 1,
    icon: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="10" x2="18" y2="10" stroke="#f23645" stroke-width="1.5"/><rect x="2" y="4"  width="16" height="6" fill="#f23645" opacity="0.25"/><rect x="2" y="10" width="16" height="6" fill="#26a69a" opacity="0.25"/><polygon points="10,19 13.5,15 6.5,15" fill="#f23645"/></svg>',
    onCreate: function (d) {
      var entry  = d.points[0].price;
      d.meta.sl  = parseFloat((entry * 1.02).toPrecision(6));
      d.meta.tp  = parseFloat((entry * 0.96).toPrecision(6));
    },
    render: function (ctx, d, toX, toY, w, h, sel) {
      var entry = d.points[0].price;
      var sl    = d.meta.sl != null ? d.meta.sl : entry * 1.02;
      var tp    = d.meta.tp != null ? d.meta.tp : entry * 0.96;
      var x1    = toX(d.points[0].time) || 0;
      var ye    = toY(entry), ys = toY(sl), yt = toY(tp);
      if (ye == null || ys == null || yt == null) return;
      var x2 = w;
      ctx.setLineDash([]);
      ctx.fillStyle = '#26a69a'; ctx.globalAlpha = 0.1;
      ctx.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye));
      ctx.fillStyle = '#f23645'; ctx.globalAlpha = 0.1;
      ctx.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye));
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
      var rows = [[ye, '#f23645', 'Entry', entry], [ys, '#ef5350', 'Stop', sl], [yt, '#26a69a', 'Target', tp]];
      rows.forEach(function (r) {
        ctx.strokeStyle = r[1]; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x1, r[0]); ctx.lineTo(x2, r[0]); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = r[1]; ctx.font = 'bold 10px sans-serif';
        ctx.fillText(r[2] + ': ' + r[3].toFixed(4), x2 - 130, r[0] - 3);
      });
      var risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText('R:R  1:' + (risk > 0 ? (reward / risk).toFixed(2) : '?'), x1 + 4, ye - 5);
      if (sel) _handles(ctx, [[x1, ye], [x1, ys], [x1, yt]], '#f23645');
    },
    renderPreview: function (ctx, state, toX, toY, w, h) {
      if (!state.preview) return;
      var y = toY(state.preview.price);
      if (y == null) return;
      ctx.strokeStyle = '#f23645'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = '#f23645'; ctx.globalAlpha = 0.08;
      ctx.fillRect(0, Math.max(0, y - 50), w, 50);
      ctx.fillStyle = '#26a69a';
      ctx.fillRect(0, y, w, Math.min(50, h - y));
      ctx.globalAlpha = 1;
    },
    hitTest: function (d, x, y, toX, toY) {
      var entry = d.points[0].price, sl = d.meta.sl, tp = d.meta.tp;
      var ye = toY(entry), ys = toY(sl), yt = toY(tp);
      if (ye == null) return false;
      return Math.abs(y - ye) < 7 || (ys != null && Math.abs(y - ys) < 7) || (yt != null && Math.abs(y - yt) < 7);
    },
  });

  /* ── public API ─────────────────────────────────────────────────── */
  return {
    get:  function (id)  { return _map[id] || null; },
    all:  function ()    { return Object.keys(_map).map(function (k) { return _map[k]; }); },
  };
})();
