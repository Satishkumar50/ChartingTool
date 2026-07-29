/**
 * draw-toolbar.js — Floating draggable drawing tools panel.
 *
 * Renders a vertical panel with 14 tool buttons (SVG icons),
 * color/width controls, global hide and clear-all buttons.
 *
 * Public API:
 *   DrawToolbar.init()      — call once from app.js
 *   DrawToolbar.deactivate() — deselect all tool buttons
 */

var DrawToolbar = (function () {
  'use strict';

  /* ordered list defines toolbar layout */
  var TOOL_GROUPS = [
    {
      label: 'Lines',
      tools: ['trendline', 'hline', 'vline', 'ray', 'arrow'],
    },
    {
      label: 'Shapes',
      tools: ['rect', 'circle'],
    },
    {
      label: 'Text',
      tools: ['text'],
    },
    {
      label: 'Fibonacci',
      tools: ['fibr', 'fibe'],
    },
    {
      label: 'Advanced',
      tools: ['channel', 'measure', 'longpos', 'shortpos'],
    },
  ];

  var _panel  = null;
  var _active = null;  /* currently active tool id */

  /* ── build panel HTML ───────────────────────────────────────────── */
  function _buildHTML() {
    var html = [
      '<div class="dt-header" title="Drag to move">',
      '  <span class="dt-title">Draw</span>',
      '  <button class="dt-close" title="Close">&#215;</button>',
      '</div>',
      '<div class="dt-style-bar">',
      '  <input type="color" class="dt-color" value="#388bfd" title="Line color">',
      '  <select class="dt-width" title="Line width">',
      '    <option value="1">1</option>',
      '    <option value="2">2</option>',
      '    <option value="3">3</option>',
      '  </select>',
      '</div>',
      '<div class="dt-actions">',
      '  <button class="dt-act dt-hide-all" title="Show / Hide all drawings">&#128065;</button>',
      '  <button class="dt-act dt-clear-all" title="Clear all drawings">&#128465;</button>',
      '</div>',
    ];

    TOOL_GROUPS.forEach(function (grp) {
      html.push('<div class="dt-sep" title="' + grp.label + '"></div>');
      html.push('<div class="dt-group">');
      grp.tools.forEach(function (id) {
        var tool = DrawTools.get(id);
        if (!tool) return;
        html.push(
          '<button class="dt-tool-btn" data-tool="' + id + '" title="' + tool.label + '">' +
          tool.icon +
          '</button>'
        );
      });
      html.push('</div>');
    });

    return html.join('');
  }

  /* ── init ───────────────────────────────────────────────────────── */
  function init() {
    _panel = document.getElementById('draw-toolbar');
    if (!_panel) return;

    _panel.innerHTML = _buildHTML();

    /* toggle visibility via header button */
    var openBtn = document.getElementById('draw-toolbar-btn');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        _panel.classList.toggle('dt-open');
        openBtn.classList.toggle('active', _panel.classList.contains('dt-open'));
      });
    }

    /* close X inside panel */
    _panel.querySelector('.dt-close').addEventListener('click', function () {
      _panel.classList.remove('dt-open');
      if (openBtn) openBtn.classList.remove('active');
      _deactivate();
      DrawEngine.cancelTool();
    });

    /* color picker */
    var colorEl = _panel.querySelector('.dt-color');
    colorEl.addEventListener('input', function () {
      DrawEngine.setStyle({ color: colorEl.value });
    });

    /* line width */
    var widthEl = _panel.querySelector('.dt-width');
    widthEl.addEventListener('change', function () {
      DrawEngine.setStyle({ width: parseInt(widthEl.value) || 1 });
    });

    /* hide-all toggle */
    var hideBtn = _panel.querySelector('.dt-hide-all');
    hideBtn.addEventListener('click', function () {
      var visible = DrawEngine.toggleAllVisible();
      hideBtn.classList.toggle('dt-act-active', !visible);
      hideBtn.title = visible ? 'Hide all drawings' : 'Show all drawings';
    });

    /* clear-all */
    var clearBtn = _panel.querySelector('.dt-clear-all');
    clearBtn.addEventListener('click', function () {
      var pane = _activePane();
      if (pane) DrawEngine.clearAll(pane);
    });

    /* tool buttons */
    _panel.querySelectorAll('.dt-tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.tool;
        if (_active === id) {
          _deactivate();
          DrawEngine.cancelTool();
        } else {
          _activateTool(id);
        }
      });
    });

    _initDrag();
  }

  function _activateTool(id) {
    var tool = DrawTools.get(id);
    if (!tool) return;
    _active = id;
    _panel.querySelectorAll('.dt-tool-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === id);
    });
    var pane = _activePane();
    if (pane) DrawEngine.setTool(tool);
  }

  function deactivate() { _deactivate(); }

  function _deactivate() {
    _active = null;
    if (_panel) {
      _panel.querySelectorAll('.dt-tool-btn').forEach(function (b) {
        b.classList.remove('active');
      });
    }
  }

  function _activePane() {
    var idx = window._activePaneIndex != null ? window._activePaneIndex : 0;
    return window.panes && window.panes[idx];
  }

  /* ── draggable panel ────────────────────────────────────────────── */
  function _initDrag() {
    var hd = _panel.querySelector('.dt-header');
    if (!hd) return;
    var dragging = false, offX = 0, offY = 0;

    hd.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      var r = _panel.getBoundingClientRect();
      _panel.style.right = 'auto';
      _panel.style.left  = r.left + 'px';
      _panel.style.top   = r.top  + 'px';
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var x = Math.max(0, Math.min(window.innerWidth  - _panel.offsetWidth,  e.clientX - offX));
      var y = Math.max(0, Math.min(window.innerHeight - _panel.offsetHeight, e.clientY - offY));
      _panel.style.left = x + 'px';
      _panel.style.top  = y + 'px';
    });

    document.addEventListener('mouseup', function () { dragging = false; });
  }

  return { init: init, deactivate: deactivate };
})();
