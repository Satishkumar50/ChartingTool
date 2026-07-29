/**
 * draw-engine.js — Drawing overlay engine.
 *
 * Maintains a canvas overlay on each chart pane.
 * Drawings are stored per "source:symbol" key, shared across timeframes.
 * Coordinates saved as {time (UTC timestamp), price}, converted each render.
 *
 * Public API (used by chart-pane.js, draw-toolbar.js, shortcuts.js):
 *   DrawEngine.attach(pane)           — call in ChartPane._initChart()
 *   DrawEngine.detach(pane)           — call in ChartPane.destroy()
 *   DrawEngine.render(pane)           — force re-render
 *   DrawEngine.onSymbolChange(pane)   — call after _selectSymbol()
 *   DrawEngine.setTool(toolObj)       — activate a tool (DrawTools entry)
 *   DrawEngine.cancelTool()           — ESC / deselect
 *   DrawEngine.undo(pane)
 *   DrawEngine.redo(pane)
 *   DrawEngine.clearAll(pane)
 *   DrawEngine.deleteSelected()
 *   DrawEngine.toggleAllVisible()
 *   DrawEngine.setStyle({color,width,dash})
 *   DrawEngine.getStyle()
 *   DrawEngine.isAllVisible()
 */

var DrawEngine = (function () {
  'use strict';

  /* ── constants ──────────────────────────────────────────────────── */
  var STORE_PFX   = 'mtc-draw2-';   // separate from old drawings.js 'mtc-draw-N'
  var MAX_HISTORY = 30;
  var HIT_RADIUS  = 7;

  /* ── module state ───────────────────────────────────────────────── */
  // _panes[paneIndex] = { canvas, ctx, pane, ro, unsubs[], evts[] }
  var _panes  = {};

  // drawings in memory: { 'hyperliquid:BTC': [drawing, …] }
  var _store  = {};

  // undo/redo: { 'hyperliquid:BTC': { stack: [jsonStr, …], cursor: N } }
  var _hist   = {};

  // active tool
  var _tool      = null;   // DrawTools object
  var _toolState = null;   // { paneIdx, points[], preview }

  // selection
  var _sel      = null;    // drawing id
  var _selPane  = null;    // pane index

  // drag
  var _drag = null;        // { origPoints[], startX, startY, paneIdx }

  // global hide toggle
  var _allVisible = true;

  // current style defaults
  var _style = { color: '#388bfd', width: 1, dash: 'solid' };

  // shift-snap
  var _shiftHeld = false;
  document.addEventListener('keydown', function (e) { if (e.key === 'Shift') _shiftHeld = true; });
  document.addEventListener('keyup',   function (e) { if (e.key === 'Shift') _shiftHeld = false; });

  /* ── id generator ───────────────────────────────────────────────── */
  var _seq = 0;
  function _uid() { return 'd' + Date.now() + '_' + (++_seq); }

  /* ── storage helpers ────────────────────────────────────────────── */
  function _key(pane) { return pane.source + ':' + pane.symbol; }

  function _loadRaw(k) {
    try { return JSON.parse(localStorage.getItem(STORE_PFX + k)) || []; } catch (e) { return []; }
  }
  function _saveRaw(k) {
    try { localStorage.setItem(STORE_PFX + k, JSON.stringify(_store[k] || [])); } catch (e) {}
  }

  function _getDrawings(pane) {
    var k = _key(pane);
    if (!_store[k]) _store[k] = _loadRaw(k);
    return _store[k];
  }

  /* ── history helpers ────────────────────────────────────────────── */
  function _histFor(k) {
    if (!_hist[k]) _hist[k] = { stack: [], cursor: -1 };
    return _hist[k];
  }

  function _pushHist(pane) {
    var k = _key(pane);
    var h = _histFor(k);
    h.stack = h.stack.slice(0, h.cursor + 1);
    h.stack.push(JSON.stringify(_store[k] || []));
    if (h.stack.length > MAX_HISTORY) h.stack.shift();
    h.cursor = h.stack.length - 1;
  }

  function undo(pane) {
    var k = _key(pane);
    var h = _histFor(k);
    if (h.cursor <= 0) return;
    h.cursor--;
    _store[k] = JSON.parse(h.stack[h.cursor]);
    _saveRaw(k);
    _sel = null; _selPane = null;
    _renderAll(k);
  }

  function redo(pane) {
    var k = _key(pane);
    var h = _histFor(k);
    if (h.cursor >= h.stack.length - 1) return;
    h.cursor++;
    _store[k] = JSON.parse(h.stack[h.cursor]);
    _saveRaw(k);
    _sel = null; _selPane = null;
    _renderAll(k);
  }

  /* ── coordinate helpers ─────────────────────────────────────────── */
  function _toX(pane, time)  { try { return pane.chart.timeScale().timeToCoordinate(time); } catch (e) { return null; } }
  function _toY(pane, price) { try { return pane.candleSeries.priceToCoordinate(price); }   catch (e) { return null; } }
  function _fromX(pane, px)  { try { return pane.chart.timeScale().coordinateToTime(px); }  catch (e) { return null; } }
  function _fromY(pane, py)  { try { return pane.candleSeries.coordinateToPrice(py); }      catch (e) { return null; } }

  function _toXfn(pane) { return function (t) { return _toX(pane, t); }; }
  function _toYfn(pane) { return function (p) { return _toY(pane, p); }; }

  /* ── canvas attach ──────────────────────────────────────────────── */
  function attach(pane) {
    if (_panes[pane.index]) detach(pane);

    var wrap = pane.chartWrap;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    var canvas = document.createElement('canvas');
    canvas.className = 'draw-overlay';
    canvas.draggable = false;
    /* if a tool is active when pane is rebuilt, keep overlay capturing */
    var ptrEvt = _tool ? 'all' : 'none';
    var cur    = (_tool && _tool.cursor) ? _tool.cursor : (_tool ? 'crosshair' : 'default');
    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:' + ptrEvt + ';z-index:15;cursor:' + cur + ';';
    canvas.addEventListener('dragstart', function (e) { e.preventDefault(); });
    wrap.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    function _resize() {
      canvas.width  = wrap.clientWidth  || 400;
      canvas.height = wrap.clientHeight || 300;
      render(pane);
    }

    var ro = new ResizeObserver(_resize);
    ro.observe(wrap);
    _resize();

    /* LWC subscriptions for re-render on pan/zoom */
    function _rerender() { render(pane); }
    var u1 = pane.chart.timeScale().subscribeVisibleTimeRangeChange(_rerender);
    var u2 = pane.chart.subscribeCrosshairMove(function (p) {
      render(pane);
      if (_tool && _toolState && _toolState.paneIdx === pane.index && p && p.point) {
        var x = p.point.x, y = p.point.y;
        var time  = _fromX(pane, x);
        var price = _fromY(pane, y);
        if (time != null && price != null) {
          _toolState.preview = { time: time, price: price };
          render(pane);
        }
      }
    });

    /* Canvas events (active when tool is live) */
    function _onCanvasClick(e) {
      if (!_tool) return;
      /* lazily start toolState on first click pane */
      if (!_toolState) _toolState = { paneIdx: pane.index, points: [], preview: null };
      if (_toolState.paneIdx !== pane.index) return;
      var x = e.offsetX, y = e.offsetY;
      var time  = _fromX(pane, x);
      var price = _fromY(pane, y);
      if (time == null || price == null) return;
      if (_shiftHeld) price = _snapToOHLC(pane, time, price);
      _toolState.points.push({ time: time, price: price });
      if (_toolState.points.length >= _tool.minPoints) _finalizeTool(pane);
      else render(pane);
    }

    function _onCanvasMove(e) {
      if (!_tool) return;
      /* only preview on the pane where drawing started, or anywhere if not started */
      if (_toolState && _toolState.paneIdx !== pane.index) return;
      var x = e.offsetX, y = e.offsetY;
      var time  = _fromX(pane, x);
      var price = _fromY(pane, y);
      if (time != null && price != null) {
        if (!_toolState) _toolState = { paneIdx: pane.index, points: [], preview: null };
        _toolState.preview = { time: time, price: price };
        render(pane);
      }
    }

    function _onCanvasDblClick(e) {
      if (_tool) { _cancelTool(); return; }
    }

    function _onCanvasCtx(e) {
      if (_tool) { e.preventDefault(); e.stopPropagation(); _cancelTool(); return; }
    }

    /* chartWrap events (capture phase for selection/drag when no tool) */
    function _onWrapDown(e) {
      if (_tool) return;
      if (e.button !== 0) return;
      var r   = wrap.getBoundingClientRect();
      var x   = e.clientX - r.left, y = e.clientY - r.top;
      var hit = _hitTest(pane, x, y);
      if (hit) {
        e.stopPropagation();
        _sel = hit.id; _selPane = pane.index;
        if (!hit.locked) {
          var drawings = _getDrawings(pane);
          var orig = drawings.find(function (d) { return d.id === hit.id; });
          _drag = {
            paneIdx:    pane.index,
            startX:     x, startY: y,
            origPoints: JSON.parse(JSON.stringify(orig.points)),
          };
          canvas.style.pointerEvents = 'all';
        }
        render(pane);
      } else {
        if (_sel !== null) { _sel = null; _selPane = null; render(pane); }
      }
    }

    function _onWrapMove(e) {
      var r = wrap.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (_drag && _drag.paneIdx === pane.index) {
        var dx = x - _drag.startX, dy = y - _drag.startY;
        var drawings = _getDrawings(pane);
        var d = drawings.find(function (dr) { return dr.id === _sel; });
        if (d) {
          d.points = _drag.origPoints.map(function (pt) {
            var px = _toX(pane, pt.time), py = _toY(pane, pt.price);
            if (px == null || py == null) return pt;
            var newTime  = _fromX(pane, px + dx);
            var newPrice = _fromY(pane, py + dy);
            return { time: newTime || pt.time, price: newPrice != null ? newPrice : pt.price };
          });
          render(pane);
        }
        return;
      }
      /* Hover cursor */
      if (!_tool) {
        var hit = _hitTest(pane, x, y);
        wrap.style.cursor = hit ? (hit.locked ? 'default' : 'move') : '';
      }
    }

    function _onWrapUp(e) {
      if (_drag && _drag.paneIdx === pane.index) {
        _pushHist(pane);
        _saveRaw(_key(pane));
        _drag = null;
        canvas.style.pointerEvents = _tool ? 'all' : 'none';
      }
    }

    function _onWrapDbl(e) {
      if (_tool) return;
      var r   = wrap.getBoundingClientRect();
      var x   = e.clientX - r.left, y = e.clientY - r.top;
      var hit = _hitTest(pane, x, y);
      if (hit && hit.type === 'text') _editText(pane, hit);
      else if (hit) _showPropPanel(pane, hit, e.clientX, e.clientY);
    }

    function _onWrapCtx(e) {
      if (_tool) return;
      var r   = wrap.getBoundingClientRect();
      var x   = e.clientX - r.left, y = e.clientY - r.top;
      var hit = _hitTest(pane, x, y);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        _showDrawMenu(pane, hit, e.clientX, e.clientY);
      }
      /* else: let chart-pane.js context menu fire */
    }

    canvas.addEventListener('click',       _onCanvasClick);
    canvas.addEventListener('mousemove',   _onCanvasMove);
    canvas.addEventListener('dblclick',    _onCanvasDblClick);
    canvas.addEventListener('contextmenu', _onCanvasCtx);

    wrap.addEventListener('mousedown',   _onWrapDown, true);
    wrap.addEventListener('mousemove',   _onWrapMove);
    wrap.addEventListener('mouseup',     _onWrapUp);
    wrap.addEventListener('dblclick',    _onWrapDbl);
    wrap.addEventListener('contextmenu', _onWrapCtx, true);
    function _onDragStart(e) { e.preventDefault(); }
    wrap.addEventListener('dragstart',   _onDragStart, true);

    _panes[pane.index] = {
      canvas: canvas, ctx: ctx, pane: pane, ro: ro,
      unsubs: [u1, u2],
      evts: [
        [canvas, 'click',       _onCanvasClick,  false],
        [canvas, 'mousemove',   _onCanvasMove,   false],
        [canvas, 'dblclick',    _onCanvasDblClick, false],
        [canvas, 'contextmenu', _onCanvasCtx,    false],
        [wrap,   'mousedown',   _onWrapDown,     true],
        [wrap,   'mousemove',   _onWrapMove,     false],
        [wrap,   'mouseup',     _onWrapUp,       false],
        [wrap,   'dblclick',    _onWrapDbl,      false],
        [wrap,   'contextmenu', _onWrapCtx,      true],
        [wrap,   'dragstart',   _onDragStart,    true],
      ],
    };
  }

  function detach(pane) {
    var pd = _panes[pane.index];
    if (!pd) return;
    pd.ro.disconnect();
    pd.unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    pd.evts.forEach(function (ev) { ev[0].removeEventListener(ev[1], ev[2], ev[3]); });
    if (pd.canvas.parentNode) pd.canvas.parentNode.removeChild(pd.canvas);
    delete _panes[pane.index];
  }

  /* ── render ─────────────────────────────────────────────────────── */
  function render(pane) {
    var pd = _panes[pane.index];
    if (!pd) return;
    var ctx = pd.ctx, canvas = pd.canvas;
    var w   = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!_allVisible) return;
    if (!pane.symbol || !pane.source) return;

    var toX = _toXfn(pane), toY = _toYfn(pane);
    var drawings = _getDrawings(pane);
    drawings.forEach(function (d) {
      if (!d.visible) return;
      var tool = DrawTools.get(d.type);
      if (!tool) return;
      ctx.save();
      tool.render(ctx, d, toX, toY, w, h, d.id === _sel && _selPane === pane.index);
      ctx.restore();
    });

    /* preview in-progress drawing */
    if (_tool && _toolState && _toolState.paneIdx === pane.index && _toolState.preview) {
      ctx.save();
      _tool.renderPreview(ctx, _toolState, toX, toY, w, h);
      ctx.restore();
    }
  }

  function _renderAll(k) {
    Object.keys(_panes).forEach(function (idx) {
      var pd = _panes[idx];
      if (_key(pd.pane) === k) render(pd.pane);
    });
  }

  /* ── tool lifecycle ─────────────────────────────────────────────── */
  function setTool(tool) {
    _cancelTool();
    _tool      = tool;
    _sel       = null; _selPane = null;
    _toolState = null;
    /* enable overlay capture on all panes (tool draws on the clicked pane) */
    Object.keys(_panes).forEach(function (idx) {
      _panes[idx].canvas.style.pointerEvents = 'all';
      _panes[idx].canvas.style.cursor = tool.cursor || 'crosshair';
      _panes[idx].pane.chartWrap.style.cursor = tool.cursor || 'crosshair';
    });
  }

  function _startToolOnPane(pane) {
    _toolState = { paneIdx: pane.index, points: [], preview: null };
  }

  function _finalizeTool(pane) {
    if (!_tool || !_toolState) return;
    var drawing = {
      id:      _uid(),
      type:    _tool.id,
      points:  _toolState.points.slice(),
      style:   { color: _style.color, width: _style.width, dash: _style.dash },
      visible: true,
      locked:  false,
      meta:    {},
    };
    if (_tool.onCreate) _tool.onCreate(drawing);

    /* compute bar count for measure tool */
    if (_tool.id === 'measure' && pane._candles) {
      var t1 = drawing.points[0].time, t2 = drawing.points[1].time;
      var bars = pane._candles.filter(function (c) {
        return c.time >= Math.min(t1, t2) && c.time <= Math.max(t1, t2);
      }).length;
      drawing.meta.bars = bars;
    }

    _pushHist(pane);
    var k = _key(pane);
    _store[k] = _store[k] || [];
    _store[k].push(drawing);
    _saveRaw(k);
    _cancelTool();
    _renderAll(k);
  }

  function _cancelTool() {
    _toolState = null;
    if (_tool) {
      _tool = null;
      Object.keys(_panes).forEach(function (idx) {
        _panes[idx].canvas.style.pointerEvents = 'none';
        _panes[idx].canvas.style.cursor = '';
        _panes[idx].pane.chartWrap.style.cursor = '';
      });
      if (window.DrawToolbar) DrawToolbar.deactivate();
    }
  }

  /* ── first canvas click starts tool on that pane ────────────────── */
  /* (handled inside _onCanvasClick — it reads _tool and _toolState) */
  /* We patch _onCanvasClick above to call _startToolOnPane when needed */
  /* Actually let's fix: reroute click to also start toolState if null */

  /* ── OHLC snap ──────────────────────────────────────────────────── */
  function _snapToOHLC(pane, time, price) {
    var candles = pane._candles;
    if (!candles || !candles.length) return price;
    var best = null, bestDist = Infinity;
    candles.forEach(function (c) {
      var d = Math.abs(c.time - time);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    if (!best) return price;
    var opts = [best.open, best.high, best.low, best.close];
    var snap = opts[0], snapDist = Math.abs(price - opts[0]);
    opts.forEach(function (v) {
      var dist = Math.abs(price - v);
      if (dist < snapDist) { snapDist = dist; snap = v; }
    });
    return snap;
  }

  /* ── hit testing ────────────────────────────────────────────────── */
  function _hitTest(pane, x, y) {
    var drawings = _getDrawings(pane);
    var toX = _toXfn(pane), toY = _toYfn(pane);
    for (var i = drawings.length - 1; i >= 0; i--) {
      var d = drawings[i];
      if (!d.visible) continue;
      var tool = DrawTools.get(d.type);
      if (tool && tool.hitTest && tool.hitTest(d, x, y, toX, toY)) return d;
    }
    return null;
  }

  /* ── drawing operations ─────────────────────────────────────────── */
  function _remove(pane, id) {
    var k = _key(pane);
    _pushHist(pane);
    _store[k] = (_store[k] || []).filter(function (d) { return d.id !== id; });
    _saveRaw(k);
    if (_sel === id) { _sel = null; _selPane = null; }
    _renderAll(k);
  }

  function _duplicate(pane, id) {
    var k = _key(pane);
    var drawings = _getDrawings(pane);
    var orig = drawings.find(function (d) { return d.id === id; });
    if (!orig) return;
    _pushHist(pane);
    var copy = JSON.parse(JSON.stringify(orig));
    copy.id = _uid();
    copy.points = copy.points.map(function (pt) {
      return { time: pt.time, price: pt.price * 1.001 };
    });
    _store[k].push(copy);
    _saveRaw(k);
    _renderAll(k);
  }

  function _toggleHide(pane, id) {
    var drawings = _getDrawings(pane);
    var d = drawings.find(function (dr) { return dr.id === id; });
    if (!d) return;
    _pushHist(pane);
    d.visible = !d.visible;
    _saveRaw(_key(pane));
    _renderAll(_key(pane));
  }

  function _toggleLock(pane, id) {
    var drawings = _getDrawings(pane);
    var d = drawings.find(function (dr) { return dr.id === id; });
    if (!d) return;
    d.locked = !d.locked;
    _saveRaw(_key(pane));
    _renderAll(_key(pane));
  }

  function _bringFwd(pane, id) {
    var k = _key(pane), arr = _store[k] || [];
    var idx = arr.findIndex(function (d) { return d.id === id; });
    if (idx < arr.length - 1) {
      _pushHist(pane);
      var tmp = arr[idx]; arr[idx] = arr[idx + 1]; arr[idx + 1] = tmp;
      _saveRaw(k); _renderAll(k);
    }
  }

  function _sendBwd(pane, id) {
    var k = _key(pane), arr = _store[k] || [];
    var idx = arr.findIndex(function (d) { return d.id === id; });
    if (idx > 0) {
      _pushHist(pane);
      var tmp = arr[idx]; arr[idx] = arr[idx - 1]; arr[idx - 1] = tmp;
      _saveRaw(k); _renderAll(k);
    }
  }

  function clearAll(pane) {
    if (!confirm('Clear all drawings for ' + pane.symbol + '?')) return;
    var k = _key(pane);
    _pushHist(pane);
    _store[k] = [];
    _saveRaw(k);
    _sel = null; _selPane = null;
    _renderAll(k);
  }

  function toggleAllVisible() {
    _allVisible = !_allVisible;
    Object.keys(_panes).forEach(function (idx) { render(_panes[idx].pane); });
    return _allVisible;
  }

  function deleteSelected() {
    if (_sel == null || _selPane == null) return;
    var pd = _panes[_selPane];
    if (pd) _remove(pd.pane, _sel);
  }

  /* ── notify engine when symbol/source changes ───────────────────── */
  function onSymbolChange(pane) {
    _sel = null; _selPane = null;
    _cancelTool();
    render(pane);
  }

  /* ── drawing context menu ───────────────────────────────────────── */
  var _drawMenu = null;
  var _menuPane = null;
  var _menuId   = null;

  function _ensureDrawMenu() {
    if (_drawMenu) return;
    _drawMenu = document.createElement('div');
    _drawMenu.className = 'chart-ctx-menu draw-ctx-menu';
    _drawMenu.innerHTML = [
      '<button class="ctx-item dm-props">&#9998; Properties</button>',
      '<div class="ctx-sep"></div>',
      '<button class="ctx-item dm-hide">&#128065; Hide</button>',
      '<button class="ctx-item dm-lock">&#128274; Lock</button>',
      '<button class="ctx-item dm-dup">&#10697; Duplicate</button>',
      '<div class="ctx-sep"></div>',
      '<button class="ctx-item dm-fwd">&#8593; Bring Forward</button>',
      '<button class="ctx-item dm-bwd">&#8595; Send Backward</button>',
      '<div class="ctx-sep"></div>',
      '<button class="ctx-item dm-del">&#128465; Delete</button>',
    ].join('');
    document.body.appendChild(_drawMenu);
  }

  function _showDrawMenu(pane, drawing, cx, cy) {
    _ensureDrawMenu();
    _menuPane = pane;
    _menuId   = drawing.id;
    _sel = drawing.id; _selPane = pane.index;
    render(pane);

    _drawMenu.querySelector('.dm-hide').textContent = drawing.visible ? '👁 Hide' : '👁 Show';
    _drawMenu.querySelector('.dm-lock').textContent = drawing.locked  ? '🔓 Unlock' : '🔒 Lock';

    _drawMenu.style.left = cx + 'px';
    _drawMenu.style.top  = cy + 'px';
    _drawMenu.classList.add('visible');

    /* fresh clone to clear old listeners */
    var fresh = _drawMenu.cloneNode(true);
    _drawMenu.parentNode.replaceChild(fresh, _drawMenu);
    _drawMenu = fresh;

    function _close() { _drawMenu.classList.remove('visible'); }

    _drawMenu.querySelector('.dm-props').onclick = function (e) {
      e.stopPropagation(); _close();
      var d = (_store[_key(_menuPane)] || []).find(function (dr) { return dr.id === _menuId; });
      if (d) _showPropPanel(_menuPane, d, cx, cy);
    };
    _drawMenu.querySelector('.dm-hide').onclick  = function (e) { e.stopPropagation(); _close(); _toggleHide(_menuPane, _menuId); };
    _drawMenu.querySelector('.dm-lock').onclick  = function (e) { e.stopPropagation(); _close(); _toggleLock(_menuPane, _menuId); };
    _drawMenu.querySelector('.dm-dup').onclick   = function (e) { e.stopPropagation(); _close(); _duplicate(_menuPane, _menuId); };
    _drawMenu.querySelector('.dm-fwd').onclick   = function (e) { e.stopPropagation(); _close(); _bringFwd(_menuPane, _menuId); };
    _drawMenu.querySelector('.dm-bwd').onclick   = function (e) { e.stopPropagation(); _close(); _sendBwd(_menuPane, _menuId); };
    _drawMenu.querySelector('.dm-del').onclick   = function (e) { e.stopPropagation(); _close(); _remove(_menuPane, _menuId); };

    requestAnimationFrame(function () {
      var r = _drawMenu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  _drawMenu.style.left = (cx - r.width)  + 'px';
      if (r.bottom > window.innerHeight) _drawMenu.style.top  = (cy - r.height) + 'px';
    });

    document.addEventListener('click', _close, { once: true });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { _close(); document.removeEventListener('keydown', esc); }
    });
  }

  /* ── properties panel ───────────────────────────────────────────── */
  var _propPanel = null;

  function _ensurePropPanel() {
    if (_propPanel) return;
    _propPanel = document.createElement('div');
    _propPanel.className = 'draw-prop-panel';
    _propPanel.innerHTML = [
      '<div class="pp-title">Drawing Properties</div>',
      '<div class="pp-row"><label>Color</label><input type="color" class="pp-color"></div>',
      '<div class="pp-row"><label>Width</label>',
        '<select class="pp-width">',
          '<option value="1">1 px</option>',
          '<option value="2">2 px</option>',
          '<option value="3">3 px</option>',
          '<option value="4">4 px</option>',
          '<option value="5">5 px</option>',
        '</select>',
      '</div>',
      '<div class="pp-row"><label>Style</label>',
        '<select class="pp-dash">',
          '<option value="solid">Solid</option>',
          '<option value="dashed">Dashed</option>',
          '<option value="dotted">Dotted</option>',
        '</select>',
      '</div>',
      '<button class="pp-done">Done</button>',
    ].join('');
    document.body.appendChild(_propPanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') _propPanel.classList.remove('visible');
    });
  }

  function _showPropPanel(pane, drawing, cx, cy) {
    _ensurePropPanel();
    _propPanel.style.left = cx + 'px';
    _propPanel.style.top  = cy + 'px';
    _propPanel.classList.add('visible');

    var colorEl = _propPanel.querySelector('.pp-color');
    var widthEl = _propPanel.querySelector('.pp-width');
    var dashEl  = _propPanel.querySelector('.pp-dash');
    colorEl.value = drawing.style.color || '#388bfd';
    widthEl.value = drawing.style.width || 1;
    dashEl.value  = drawing.style.dash  || 'solid';

    function _apply() {
      drawing.style.color = colorEl.value;
      drawing.style.width = parseInt(widthEl.value) || 1;
      drawing.style.dash  = dashEl.value;
      _saveRaw(_key(pane));
      _renderAll(_key(pane));
    }
    colorEl.oninput  = _apply;
    widthEl.onchange = _apply;
    dashEl.onchange  = _apply;

    _propPanel.querySelector('.pp-done').onclick = function () {
      _propPanel.classList.remove('visible');
    };

    requestAnimationFrame(function () {
      var r = _propPanel.getBoundingClientRect();
      if (r.right  > window.innerWidth)  _propPanel.style.left = (cx - r.width)  + 'px';
      if (r.bottom > window.innerHeight) _propPanel.style.top  = (cy - r.height) + 'px';
    });
  }

  /* ── text editing ───────────────────────────────────────────────── */
  function _editText(pane, drawing) {
    var x = _toX(pane, drawing.points[0].time);
    var y = _toY(pane, drawing.points[0].price);
    if (x == null || y == null) return;
    var r = pane.chartWrap.getBoundingClientRect();

    var ta = document.createElement('textarea');
    ta.className   = 'draw-text-editor';
    ta.value       = drawing.meta.text || '';
    ta.style.left  = (r.left + x) + 'px';
    ta.style.top   = (r.top  + y - (drawing.meta.fontSize || 13)) + 'px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();

    function _commit() {
      var text = ta.value.trim();
      if (text !== drawing.meta.text) {
        _pushHist(pane);
        drawing.meta.text = text;
        _saveRaw(_key(pane));
        _renderAll(_key(pane));
      }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    }
    ta.addEventListener('blur', _commit);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { ta.value = drawing.meta.text || ''; ta.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
      e.stopPropagation();
    });
  }

  /* ── patch canvas click to lazily start tool on first pane click ── */
  /* (the _onCanvasClick closure calls _startToolOnPane if needed) */
  /* We need to hook this without breaking the closure.  We do it by  */
  /* checking inside the closure itself.  See the _onCanvasClick above */
  /* that already has: if (!_toolState) _startToolOnPane(pane);        */

  /* Actually let me expose a proper hook so the closure can call it.  */
  /* The closure already captures 'pane' and can call _startToolOnPane. */
  /* The closure above calls _startToolOnPane internally — wait, I     */
  /* didn't include that call!  Let me add it as a named function and  */
  /* refer to it.  The cleanest fix: check toolState and start it.    */

  /* ── global safety: release drag if mouse up anywhere ──────────── */
  document.addEventListener('mouseup', function () {
    if (_drag) {
      var pd = _panes[_drag.paneIdx];
      if (pd) {
        _pushHist(pd.pane);
        _saveRaw(_key(pd.pane));
        pd.canvas.style.pointerEvents = _tool ? 'all' : 'none';
      }
      _drag = null;
    }
  });

  /* ── public API ─────────────────────────────────────────────────── */
  return {
    attach:           attach,
    detach:           detach,
    render:           render,
    onSymbolChange:   onSymbolChange,
    setTool:          setTool,
    cancelTool:       _cancelTool,
    undo:             undo,
    redo:             redo,
    clearAll:         clearAll,
    toggleAllVisible: toggleAllVisible,
    deleteSelected:   deleteSelected,
    setStyle:         function (s) { Object.assign(_style, s); },
    getStyle:         function ()  { return Object.assign({}, _style); },
    isAllVisible:     function ()  { return _allVisible; },
    getSelected:      function ()  { return _sel; },
    showPropPanel:    _showPropPanel,
  };
})();
