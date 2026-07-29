/**
 * workspaces.js - Named workspace save / load / delete using localStorage.
 *
 * A workspace captures: chart count, theme, and per-pane {source, symbol,
 * interval, enabled indicators}.  Loading a workspace writes pane state to
 * localStorage *before* calling buildGrid() so the constructor's
 * _restoreAndLoad() picks up the correct values automatically.
 */

var WorkspaceManager = (function() {
  var STORE = 'mtc-workspaces';

  function _all() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }

  function _write(ws) {
    localStorage.setItem(STORE, JSON.stringify(ws));
    // sync to server file (workspace_data.json)
    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ws),
    }).catch(function() {});  // silent — localStorage is the fallback
  }

  function _capture() {
    return {
      chartCount: window.chartCount || 4,
      theme:      window.currentTheme || 'dark',
      panes: (window.panes || []).map(function(p) {
        return {
          source:     p.source,
          symbol:     p.symbol,
          interval:   p.interval,
          indicators: JSON.parse(JSON.stringify(p.indicatorMgr ? (p.indicatorMgr._enabled || {}) : {})),
        };
      }),
    };
  }

  function refresh() {
    var sel = document.getElementById('ws-select');
    if (!sel) return;
    var names = Object.keys(_all());
    sel.innerHTML = '<option value="">-- Workspace --</option>' +
      names.map(function(n) {
        return '<option value="' + _esc(n) + '">' + n + '</option>';
      }).join('');
  }

  function save() {
    var name = prompt('Save workspace as:', 'My Workspace');
    if (!name || !name.trim()) return;
    name = name.trim();
    var ws = _all();
    ws[name] = _capture();
    _write(ws);
    refresh();
    _toast('Workspace "' + name + '" saved.');
  }

  function load(name) {
    var data = _all()[name];
    if (!data) return;

    // Write per-pane state to localStorage BEFORE buildGrid so constructors pick it up
    var count = data.chartCount || 4;
    var panesData = data.panes || [];
    for (var i = 0; i < count; i++) {
      var pd = panesData[i];
      if (pd) {
        localStorage.setItem('pane-' + i, JSON.stringify({
          source: pd.source, symbol: pd.symbol, interval: pd.interval,
        }));
        if (pd.indicators) {
          localStorage.setItem('inds-' + i, JSON.stringify(pd.indicators));
        }
      }
    }

    window.applyTheme(data.theme || 'dark');
    window.chartCount = count;
    localStorage.setItem('chart-count', count);
    window.setActiveBtn(count);
    window.buildGrid(count);
    _toast('Workspace "' + name + '" loaded.');
  }

  function del(name) {
    if (!name) { alert('Select a workspace first.'); return; }
    if (!confirm('Delete workspace "' + name + '"?')) return;
    var ws = _all();
    delete ws[name];
    _write(ws);
    refresh();
  }

  var _lastSelected = '';

  function init() {
    refresh();
    var sel  = document.getElementById('ws-select');
    var save = document.getElementById('ws-save-btn');
    var del_ = document.getElementById('ws-del-btn');

    if (sel) sel.addEventListener('change', function() {
      if (sel.value) {
        _lastSelected = sel.value;
        load(sel.value);
        sel.value = '';
      }
    });
    if (save) save.addEventListener('click', save_fn);
    if (del_) del_.addEventListener('click', function() {
      var name = (document.getElementById('ws-select').value) || _lastSelected;
      del(name);
      _lastSelected = '';
    });

    // load from server file — authoritative copy across all browsers
    fetch('/api/workspaces')
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j.ok && j.data && typeof j.data === 'object') {
          // merge server data into localStorage (server wins for any matching key)
          var local  = _all();
          var merged = Object.assign({}, local, j.data);
          localStorage.setItem(STORE, JSON.stringify(merged));
          refresh();
        } else if (j.ok && !j.data) {
          // no file yet — seed it from current localStorage
          var existing = _all();
          if (Object.keys(existing).length) {
            fetch('/api/workspaces', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(existing),
            }).catch(function() {});
          }
        }
      })
      .catch(function() {});  // server unavailable — localStorage copy is fine
  }

  // Use named function to avoid naming conflict with variable `save`
  function save_fn() { save(); }

  function _esc(s) { return s.replace(/"/g, '&quot;'); }

  function _toast(msg) {
    var t = document.getElementById('alert-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'alert-toast show';
    setTimeout(function() { t.className = 'alert-toast'; }, 3000);
  }

  return { init: init, save: save, load: load, delete: del, refresh: refresh };
})();
