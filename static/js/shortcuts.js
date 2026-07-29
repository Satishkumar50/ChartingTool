/**
 * shortcuts.js - Keyboard shortcuts.
 * Shortcuts are suppressed when the user is typing in any input/select field.
 *
 * Keys:
 *   1 2 4 6 8   change chart count
 *   W           toggle watchlist
 *   S           focus symbol input on active pane
 *   T           focus timeframe selector on active pane
 *   I           toggle indicators panel on active pane
 *   Esc         close all open menus/panels
 */
/* ── drawing keyboard shortcuts (Ctrl combos) ──────────────────────── */
document.addEventListener('keydown', function(e) {
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (typeof DrawEngine === 'undefined') return;

  var pane = _activePane();

  /* Ctrl+Z — undo */
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    if (pane) { DrawEngine.undo(pane); e.preventDefault(); }
    return;
  }
  /* Ctrl+Shift+Z — redo */
  if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    if (pane) { DrawEngine.redo(pane); e.preventDefault(); }
    return;
  }
  /* Ctrl+D — duplicate selected */
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault();
    return; /* handled via right-click menu */
  }
});

document.addEventListener('keydown', function(e) {
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  var key = e.key;

  // 1, 2, 4, 6, 8 → change chart count
  if (['1','2','4','6','8'].indexOf(key) !== -1) {
    var n = parseInt(key);
    if (typeof window.buildGrid === 'function') {
      window.chartCount = n;
      localStorage.setItem('chart-count', n);
      window.setActiveBtn(n);
      window.buildGrid(n);
    }
    e.preventDefault();
    return;
  }

  switch (key.toLowerCase()) {
    case 'w':
      if (typeof WatchlistManager !== 'undefined') WatchlistManager.toggle();
      e.preventDefault();
      break;

    case 's': {
      var p = _activePane();
      if (p && p.symInput) { p.symInput.focus(); p.symInput.select(); e.preventDefault(); }
      break;
    }

    case 't': {
      var p2 = _activePane();
      if (p2 && p2.ivSel) { p2.ivSel.focus(); e.preventDefault(); }
      break;
    }

    case 'i': {
      var p3 = _activePane();
      if (p3) {
        var open = p3.indPanel.classList.toggle('open');
        p3.indBtn.classList.toggle('active', open);
        if (open && typeof p3._buildIndPanel === 'function') p3._buildIndPanel();
        e.preventDefault();
      }
      break;
    }

    case 'delete':
    case 'backspace':
      if (typeof DrawEngine !== 'undefined') { DrawEngine.deleteSelected(); e.preventDefault(); }
      break;

    case 'escape':
      // Cancel active drawing tool
      if (typeof DrawEngine !== 'undefined') DrawEngine.cancelTool();
      // Close all dropdowns and panels
      document.querySelectorAll('.sym-dropdown.visible').forEach(function(d) {
        d.classList.remove('visible');
      });
      if (typeof AlertsManager !== 'undefined') AlertsManager.closePanel();
      document.querySelectorAll('.ind-panel.open').forEach(function(d) {
        d.classList.remove('open');
      });
      break;
  }
});

function _activePane() {
  var idx = window._activePaneIndex || 0;
  return window.panes && window.panes[idx];
}
