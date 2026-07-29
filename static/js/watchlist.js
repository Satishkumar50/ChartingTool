/**
 * watchlist.js — Tabs + collapsible sections watchlist.
 *
 * Structure:
 *   Tabs  — named lists (add / rename / delete)
 *   Sections — collapsible groups within each tab (add / rename / delete)
 *   Rows  — symbol + name + live price; drag to reorder within section;
 *            right-click → "Move to section" to move between sections
 *
 * Storage keys (prefix mtc-wl2- avoids conflict with old mtc-watchlist):
 *   mtc-wl2-tabs    → JSON array of tab names
 *   mtc-wl2-active  → active tab name
 *   mtc-wl2-tab-{n} → { sections: [{name, collapsed, items:[{symbol,name,source}]}] }
 *
 * Live prices:
 *   Hyperliquid → hlWS.subscribeMids() real-time
 *   Others      → /api/batch-prices every 15 s
 */

var WatchlistManager = (function () {
  'use strict';

  /* ── constants ──────────────────────────────────────────────────── */
  var STORE_TABS   = 'mtc-wl2-tabs';
  var STORE_ACTIVE = 'mtc-wl2-active';
  var STORE_TAB    = 'mtc-wl2-tab-';
  var STORE_OLD    = 'mtc-watchlist';   // migrated from old flat list
  var ROW_H        = 44;
  var POLL_MS      = 15000;

  var DEFAULT_TABS = ['Crypto', 'NSE India', 'US Stocks'];
  var DEFAULT_DATA = {
    'Crypto': { sections: [{ name: 'Watchlist', collapsed: false, items: [
      { symbol: 'BTC',  name: 'Bitcoin',   source: 'hyperliquid' },
      { symbol: 'ETH',  name: 'Ethereum',  source: 'hyperliquid' },
      { symbol: 'SOL',  name: 'Solana',    source: 'hyperliquid' },
    ]}]},
    'NSE India': { sections: [{ name: 'Watchlist', collapsed: false, items: [
      { symbol: 'RELIANCE.NS', name: 'Reliance Industries', source: 'yfinance' },
      { symbol: '^NSEI',       name: 'NIFTY 50',            source: 'yfinance' },
    ]}]},
    'US Stocks': { sections: [{ name: 'Watchlist', collapsed: false, items: [
      { symbol: 'AAPL',  name: 'Apple Inc.',         source: 'yfinance_us' },
      { symbol: 'NVDA',  name: 'NVIDIA Corporation', source: 'yfinance_us' },
      { symbol: 'GC=F',  name: 'Gold Futures',       source: 'yfinance_us' },
    ]}]},
  };

  /* ── state ──────────────────────────────────────────────────────── */
  var _tabs        = [];
  var _activeTab   = '';
  var _tabData     = {};
  var _prices      = {};
  var _open        = false;
  var _drag        = null;
  var _priceTimer  = null;
  var _hlUnsubMids = null;
  var _pendingImport = null;
  var _srchTimer   = null;
  var _srchDrop    = null;
  var _ctxMenu       = null;
  var _lastDragMoved = false;   // suppresses section collapse click after a drag
  var _focusedEl     = null;    // currently keyboard-focused .wl-row element

  var _tabsBar   = null;
  var _container = null;
  var _dropLine  = null;

  /* ── storage ────────────────────────────────────────────────────── */
  var _serverSaveTimer = null;
  var _dotResetTimer   = null;

  function _setSaveDot(state, label) {
    var dot = document.getElementById('wl-save-dot');
    if (!dot) return;
    dot.className = state;
    dot.title     = label;
  }

  function _serverSave() {
    clearTimeout(_serverSaveTimer);
    clearTimeout(_dotResetTimer);
    _setSaveDot('pending', 'Saving…');
    _serverSaveTimer = setTimeout(function () {
      var payload = { tabs: _tabs, active: _activeTab, tabData: _tabData };
      fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) {
          _setSaveDot('saved', 'Saved to file');
          _dotResetTimer = setTimeout(function () { _setSaveDot('', 'Saved'); }, 2500);
        } else {
          _setSaveDot('error', 'Save failed');
        }
      })
      .catch(function () {
        _setSaveDot('error', 'Save failed — server unreachable');
        _dotResetTimer = setTimeout(function () { _setSaveDot('', 'Saved'); }, 4000);
      });
    }, 600);
  }

  function _saveTabs() {
    localStorage.setItem(STORE_TABS,   JSON.stringify(_tabs));
    localStorage.setItem(STORE_ACTIVE, _activeTab);
    _serverSave();
  }

  function _saveTab(name) {
    localStorage.setItem(STORE_TAB + name, JSON.stringify(_tabData[name]));
    _serverSave();
  }

  function _loadTabData(name) {
    try {
      var d = JSON.parse(localStorage.getItem(STORE_TAB + name));
      if (d && Array.isArray(d.sections)) return d;
    } catch (e) {}
    return { sections: [{ name: 'Watchlist', collapsed: false, items: [] }] };
  }

  function _loadAll() {
    try {
      var tabs = JSON.parse(localStorage.getItem(STORE_TABS));
      if (tabs && tabs.length) {
        _tabs      = tabs;
        _activeTab = localStorage.getItem(STORE_ACTIVE) || _tabs[0];
        if (_tabs.indexOf(_activeTab) === -1) _activeTab = _tabs[0];
        _tabs.forEach(function (t) { _tabData[t] = _loadTabData(t); });
        return;
      }
    } catch (e) {}
    _migrateDefaults();
  }

  function _migrateDefaults() {
    _tabs      = DEFAULT_TABS.slice();
    _activeTab = _tabs[0];
    _tabs.forEach(function (t) {
      _tabData[t] = JSON.parse(JSON.stringify(DEFAULT_DATA[t]));
    });
    /* migrate old flat watchlist into a "Migrated" section of first tab */
    try {
      var old = JSON.parse(localStorage.getItem(STORE_OLD));
      if (old && old.length) {
        var migItems = old.map(function (x) {
          return { symbol: x.symbol, name: x.name || x.symbol, source: x.source || _autoSrc(x.symbol) };
        });
        _tabData[_tabs[0]].sections.push({ name: 'Migrated', collapsed: false, items: migItems });
      }
    } catch (e) {}
    _saveTabs();
    _tabs.forEach(function (t) { _saveTab(t); });
  }

  /* ── helpers ────────────────────────────────────────────────────── */
  function _sections() {
    return (_tabData[_activeTab] && _tabData[_activeTab].sections) || [];
  }

  function _allItems() {
    var all = [];
    _sections().forEach(function (s) { s.items.forEach(function (it) { all.push(it); }); });
    return all;
  }

  function _autoSrc(sym) {
    if (!sym) return 'hyperliquid';
    var s = sym.toUpperCase();
    if (s.endsWith('.NS') || s.endsWith('.BO')) return 'yfinance';
    if (s.startsWith('^'))                      return 'yfinance';
    if (s.includes('=F') || s.includes('=X'))   return 'yfinance_us';
    return 'hyperliquid';
  }

  function _fmtPrice(p) {
    if (p == null || isNaN(p)) return '—';
    var abs = Math.abs(p);
    var dp  = abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
    return p.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  function _fmtChange(chg, pct) {
    if (chg == null || isNaN(chg)) return { text: '—', cls: '' };
    var sign = chg >= 0 ? '+' : '';
    var dp   = Math.abs(chg) < 0.01 ? 5 : Math.abs(chg) < 1 ? 3 : 2;
    var text = sign + chg.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) +
               '  ' + (chg >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    return { text: text, cls: chg >= 0 ? 'wl-up' : 'wl-dn' };
  }

  /* ── tab bar ────────────────────────────────────────────────────── */
  function _renderTabs() {
    if (!_tabsBar) return;
    _tabsBar.innerHTML = '';

    _tabs.forEach(function (name) {
      var btn = document.createElement('button');
      btn.className = 'wl-tab' + (name === _activeTab ? ' active' : '');

      var nameSpan = document.createElement('span');
      nameSpan.className   = 'wl-tab-name';
      nameSpan.textContent = name;

      var xSpan = document.createElement('span');
      xSpan.className   = 'wl-tab-x';
      xSpan.innerHTML   = '&times;';
      xSpan.title       = 'Delete list';

      btn.appendChild(nameSpan);
      btn.appendChild(xSpan);

      btn.addEventListener('click', function (e) {
        if (e.target === xSpan || xSpan.contains(e.target)) {
          e.stopPropagation();
          _deleteTab(name);
        } else {
          _switchTab(name);
        }
      });

      nameSpan.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        _renameTabInline(btn, name);
      });

      _tabsBar.appendChild(btn);
    });

    var addBtn = document.createElement('button');
    addBtn.className   = 'wl-tab-add';
    addBtn.title       = 'Add new list';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', _addTab);
    _tabsBar.appendChild(addBtn);
  }

  function _switchTab(name) {
    if (name === _activeTab) return;
    _activeTab = name;
    localStorage.setItem(STORE_ACTIVE, _activeTab);
    _renderTabs();
    _renderSections();
    _restartPrices();
  }

  function _addTab() {
    var name = prompt('New list name:');
    if (!name || !name.trim()) return;
    name = name.trim();
    if (_tabs.indexOf(name) !== -1) { _showToast('A list named "' + name + '" already exists.'); return; }
    _tabs.push(name);
    _tabData[name] = { sections: [{ name: 'Watchlist', collapsed: false, items: [] }] };
    _saveTab(name);
    _saveTabs();
    _switchTab(name);
  }

  function _deleteTab(name) {
    if (_tabs.length <= 1) { _showToast('Cannot delete the last list.'); return; }
    if (!confirm('Delete list "' + name + '" and all its symbols?')) return;
    var idx = _tabs.indexOf(name);
    _tabs.splice(idx, 1);
    delete _tabData[name];
    localStorage.removeItem(STORE_TAB + name);
    if (_activeTab === name) _activeTab = _tabs[Math.max(0, idx - 1)];
    _saveTabs();
    _renderTabs();
    _renderSections();
    _restartPrices();
  }

  function _renameTabInline(btn, oldName) {
    var nameSpan = btn.querySelector('.wl-tab-name');
    var inp = document.createElement('input');
    inp.className = 'wl-tab-input';
    inp.value     = oldName;
    btn.replaceChild(inp, nameSpan);
    inp.focus(); inp.select();

    function _commit() {
      var newName = inp.value.trim();
      if (newName && newName !== oldName) {
        if (_tabs.indexOf(newName) !== -1) { _showToast('Name already used.'); }
        else {
          var i = _tabs.indexOf(oldName);
          _tabs[i] = newName;
          _tabData[newName] = _tabData[oldName];
          delete _tabData[oldName];
          localStorage.removeItem(STORE_TAB + oldName);
          _saveTab(newName);
          if (_activeTab === oldName) _activeTab = newName;
          _saveTabs();
        }
      }
      _renderTabs();
      _renderSections();
    }
    inp.addEventListener('blur', _commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { inp.blur(); }
      if (e.key === 'Escape') { inp.value = oldName; inp.blur(); }
    });
  }

  /* ── sections ───────────────────────────────────────────────────── */
  function _renderSections() {
    if (!_container) return;

    /* detach old dropLine if present */
    if (_dropLine && _dropLine.parentNode) _dropLine.parentNode.removeChild(_dropLine);

    _focusedEl = null;   // DOM is being rebuilt; old reference is stale
    _container.innerHTML = '';

    var secs = _sections();

    if (!secs.length) {
      var empty = document.createElement('div');
      empty.className   = 'wl-empty';
      empty.textContent = 'No sections yet.';
      _container.appendChild(empty);
    }

    secs.forEach(function (sec, si) {
      _container.appendChild(_buildSecHeader(sec, si));
      if (!sec.collapsed) {
        sec.items.forEach(function (item, ii) {
          _container.appendChild(_buildRow(item, si, ii));
        });
      }
    });

    /* drop line lives inside container */
    if (!_dropLine) {
      _dropLine = document.createElement('div');
      _dropLine.className = 'wl-drop-line';
    }
    _dropLine.style.display = 'none';
    _container.appendChild(_dropLine);

    /* add section button */
    var addSec = document.createElement('button');
    addSec.className = 'wl-add-sec';
    addSec.innerHTML  = '<span class="wl-add-sec-plus">+</span> Add section';
    addSec.addEventListener('click', _addSection);
    _container.appendChild(addSec);

    _updateAllPrices();
  }

  function _buildSecHeader(sec, si) {
    var hd = document.createElement('div');
    hd.className  = 'wl-sec-hd' + (sec.collapsed ? ' collapsed' : '');
    hd.dataset.si = si;

    var arrow = document.createElement('span');
    arrow.className   = 'wl-sec-arrow';
    arrow.textContent = '▶';

    var nameEl = document.createElement('span');
    nameEl.className   = 'wl-sec-name';
    nameEl.textContent = sec.name;

    var countEl = document.createElement('span');
    countEl.className   = 'wl-sec-count';
    countEl.textContent = sec.items.length;

    var acts = document.createElement('div');
    acts.className = 'wl-sec-acts';

    var renBtn = document.createElement('button');
    renBtn.className   = 'wl-sec-act';
    renBtn.title       = 'Rename section';
    renBtn.textContent = '✎';
    renBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _renameSectionInline(hd, sec, si);
    });

    var delBtn = document.createElement('button');
    delBtn.className   = 'wl-sec-act';
    delBtn.title       = 'Delete section';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _deleteSection(si);
    });

    acts.appendChild(renBtn);
    acts.appendChild(delBtn);
    hd.appendChild(arrow);
    hd.appendChild(nameEl);
    hd.appendChild(countEl);
    hd.appendChild(acts);

    hd.addEventListener('click', function () {
      if (_lastDragMoved) { _lastDragMoved = false; return; }
      sec.collapsed = !sec.collapsed;
      _saveTab(_activeTab);
      _renderSections();
    });

    hd.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.classList.contains('wl-sec-act')) return;
      _onSecHeaderMouseDown(e, si);
    });

    return hd;
  }

  function _renameSectionInline(hd, sec, si) {
    var nameEl = hd.querySelector('.wl-sec-name');
    if (!nameEl) return;
    var inp = document.createElement('input');
    inp.className = 'wl-sec-input';
    inp.value     = sec.name;
    hd.replaceChild(inp, nameEl);
    inp.focus(); inp.select();

    function _commit() {
      var v = inp.value.trim();
      if (v) { sec.name = v; _saveTab(_activeTab); }
      _renderSections();
    }
    inp.addEventListener('blur', _commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  inp.blur();
      if (e.key === 'Escape') { inp.value = sec.name; inp.blur(); }
    });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function _addSection() {
    var name = prompt('Section name:');
    if (!name || !name.trim()) return;
    _sections().push({ name: name.trim(), collapsed: false, items: [] });
    _saveTab(_activeTab);
    _renderSections();
  }

  function _deleteSection(si) {
    var secs = _sections();
    var sec  = secs[si];
    if (!sec) return;
    if (sec.items.length && !confirm('Delete section "' + sec.name + '" and its ' + sec.items.length + ' symbol(s)?')) return;
    secs.splice(si, 1);
    _saveTab(_activeTab);
    _renderSections();
  }

  /* ── rows ───────────────────────────────────────────────────────── */
  function _buildRow(item, si, ii) {
    var el = document.createElement('div');
    el.className     = 'wl-row';
    el.dataset.si    = si;
    el.dataset.ii    = ii;

    var key    = item.source + ':' + item.symbol;
    var pd     = _prices[key];
    var prTxt  = pd ? _fmtPrice(pd.price)          : '—';
    var chgObj = pd ? _fmtChange(pd.change, pd.pct) : { text: '—', cls: '' };

    el.innerHTML =
      '<div class="wl-left">' +
        '<span class="wl-sym">'  + item.symbol       + '</span>' +
        '<span class="wl-name">' + (item.name || '') + '</span>' +
      '</div>' +
      '<div class="wl-right">' +
        '<span class="wl-price">'              + prTxt         + '</span>' +
        '<span class="wl-chg ' + chgObj.cls + '">' + chgObj.text + '</span>' +
      '</div>' +
      '<button class="wl-rm" title="Remove">&times;</button>';

    el.addEventListener('click', function (e) {
      if (e.target.classList.contains('wl-rm')) return;
      _setFocus(el);
      _loadIntoActive(item);
    });
    el.querySelector('.wl-rm').addEventListener('click', function (e) {
      e.stopPropagation();
      _removeItem(si, ii);
    });
    el.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('wl-rm')) return;
      if (e.button !== 0) return;
      _onRowMouseDown(e, si, ii);
    });
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      _showRowCtxMenu(e, si, ii, item);
    });

    return el;
  }

  function _updateRowPrice(el, item) {
    var key    = item.source + ':' + item.symbol;
    var pd     = _prices[key];
    var pEl    = el.querySelector('.wl-price');
    var cEl    = el.querySelector('.wl-chg');
    if (pEl) pEl.textContent = pd ? _fmtPrice(pd.price) : '—';
    if (cEl && pd) {
      var obj = _fmtChange(pd.change, pd.pct);
      cEl.textContent = obj.text;
      cEl.className   = 'wl-chg ' + obj.cls;
    }
  }

  function _updateAllPrices() {
    if (!_container) return;
    var secs = _sections();
    _container.querySelectorAll('.wl-row').forEach(function (el) {
      var si  = parseInt(el.dataset.si);
      var ii  = parseInt(el.dataset.ii);
      var sec = secs[si];
      if (sec && sec.items[ii]) _updateRowPrice(el, sec.items[ii]);
    });
  }

  /* ── load into chart ─────────────────────────────────────────────── */
  function _loadIntoActive(item) {
    var idx  = window._activePaneIndex || 0;
    var pane = window.panes && window.panes[idx];
    if (pane && typeof pane._selectSymbol === 'function') {
      pane._selectSymbol(item.symbol, item.source);
    }
  }

  /* ── keyboard focus / navigation ────────────────────────────────── */
  function _setFocus(el) {
    if (_focusedEl) _focusedEl.classList.remove('wl-focused');
    _focusedEl = el || null;
    if (_focusedEl) {
      _focusedEl.classList.add('wl-focused');
      _focusedEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function _moveFocus(dir) {
    if (!_container) return;
    // only visible (non-collapsed) rows
    var rows = Array.from(_container.querySelectorAll('.wl-row'));
    if (!rows.length) return;
    var cur = _focusedEl ? rows.indexOf(_focusedEl) : -1;
    var next = cur === -1 ? (dir > 0 ? 0 : rows.length - 1)
                          : (cur + dir + rows.length) % rows.length;
    var el = rows[next];
    _setFocus(el);
    var secs = _sections();
    var si = parseInt(el.dataset.si);
    var ii = parseInt(el.dataset.ii);
    if (secs[si] && secs[si].items[ii]) _loadIntoActive(secs[si].items[ii]);
  }

  /* ── item management ─────────────────────────────────────────────── */
  function _removeItem(si, ii) {
    var sec = _sections()[si];
    if (!sec) return;
    sec.items.splice(ii, 1);
    _saveTab(_activeTab);
    _renderSections();
    _restartPrices();
  }

  /* ── row right-click context menu ────────────────────────────────── */
  function _showRowCtxMenu(e, si, ii, item) {
    _hideCtxMenu();
    var secs = _sections();
    var menu = document.createElement('div');
    menu.className = 'wl-ctx-menu';
    menu.style.cssText = 'position:fixed;top:' + e.clientY + 'px;left:' + e.clientX + 'px;z-index:9999;';

    if (secs.length > 1) {
      var hd = document.createElement('div');
      hd.className   = 'wl-ctx-item wl-ctx-hd';
      hd.textContent = 'Move to section';
      menu.appendChild(hd);

      secs.forEach(function (sec, idx) {
        if (idx === si) return;
        var it = document.createElement('div');
        it.className   = 'wl-ctx-item wl-ctx-sub';
        it.textContent = sec.name;
        it.addEventListener('mousedown', function (ev) {
          ev.preventDefault();
          var movedItem = _sections()[si].items.splice(ii, 1)[0];
          _sections()[idx].items.push(movedItem);
          _saveTab(_activeTab);
          _renderSections();
          _hideCtxMenu();
        });
        menu.appendChild(it);
      });

      var sep = document.createElement('div');
      sep.className = 'wl-ctx-sep';
      menu.appendChild(sep);
    }

    var rm = document.createElement('div');
    rm.className   = 'wl-ctx-item wl-ctx-danger';
    rm.textContent = 'Remove';
    rm.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      _removeItem(si, ii);
      _hideCtxMenu();
    });
    menu.appendChild(rm);

    document.body.appendChild(menu);
    _ctxMenu = menu;

    /* keep inside viewport */
    var r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = (e.clientX - r.width)  + 'px';
    if (r.bottom > window.innerHeight) menu.style.top  = (e.clientY - r.height) + 'px';

    setTimeout(function () {
      document.addEventListener('mousedown', _hideCtxMenu, { once: true });
    }, 0);
  }

  function _hideCtxMenu() {
    if (_ctxMenu && _ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
    _ctxMenu = null;
  }

  /* ── drag — rows (cross-section) and section headers ────────────── */
  function _onRowMouseDown(e, si, startII) {
    var ghost = document.createElement('div');
    ghost.className   = 'wl-ghost';
    ghost.style.width = _container.offsetWidth + 'px';
    ghost.innerHTML   = e.currentTarget.innerHTML;
    document.body.appendChild(ghost);
    ghost.style.top  = (e.clientY - ROW_H / 2) + 'px';
    ghost.style.left = _container.getBoundingClientRect().left + 'px';

    _drag = { type: 'row', si: si, startII: startII, targetSI: si, targetII: startII,
              ghost: ghost, startY: e.clientY, moved: false };
    e.currentTarget.classList.add('wl-dragging');

    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup',   _onDragEnd);
  }

  function _onSecHeaderMouseDown(e, si) {
    var sec   = _sections()[si];
    if (!sec) return;
    var ghost = document.createElement('div');
    ghost.className   = 'wl-ghost wl-ghost-sec';
    ghost.style.width = _container.offsetWidth + 'px';
    ghost.textContent = sec.name + ' (' + sec.items.length + ')';
    document.body.appendChild(ghost);
    ghost.style.top  = (e.clientY - 14) + 'px';
    ghost.style.left = _container.getBoundingClientRect().left + 'px';

    _drag = { type: 'section', startSI: si, targetSI: si,
              ghost: ghost, startY: e.clientY, moved: false };

    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup',   _onDragEnd);
  }

  function _onDragMove(e) {
    if (!_drag) return;
    if (!_drag.moved && Math.abs(e.clientY - _drag.startY) < 5) return;
    _drag.moved = true;

    if (_drag.type === 'section') {
      _drag.ghost.style.top = (e.clientY - 14) + 'px';
      var st = _computeSecDropTarget(e.clientY);
      _drag.targetSI = st.si;
      _dropLine.style.display = 'block';
      _dropLine.style.top     = st.lineY + 'px';
    } else {
      _drag.ghost.style.top = (e.clientY - ROW_H / 2) + 'px';
      var rt = _computeRowDropTarget(e.clientY);
      _drag.targetSI = rt.si;
      _drag.targetII = rt.ii;
      _dropLine.style.display = 'block';
      _dropLine.style.top     = rt.lineY + 'px';
    }
  }

  function _onDragEnd() {
    if (!_drag) return;
    _dropLine.style.display = 'none';
    if (_drag.ghost) _drag.ghost.remove();

    if (_drag.moved) {
      _lastDragMoved = true;
      var secs = _sections();

      if (_drag.type === 'section') {
        var from = _drag.startSI;
        var to   = _drag.targetSI;
        if (to !== from && to !== from + 1) {
          var sec      = secs.splice(from, 1)[0];
          var insertAt = to > from ? to - 1 : to;
          secs.splice(insertAt, 0, sec);
          _saveTab(_activeTab);
          _renderSections();
        }
      } else {
        var srcSec  = secs[_drag.si];
        var dstSec  = secs[_drag.targetSI];
        var fromII  = _drag.startII;
        var toII    = _drag.targetII;
        var sameSec = _drag.si === _drag.targetSI;

        if (srcSec && dstSec) {
          if (!sameSec) {
            /* cross-section move */
            var moved = srcSec.items.splice(fromII, 1)[0];
            dstSec.items.splice(toII, 0, moved);
            _saveTab(_activeTab);
            _renderSections();
          } else if (toII !== fromII && toII !== fromII + 1) {
            /* reorder within same section */
            var item     = srcSec.items.splice(fromII, 1)[0];
            var insertAt2 = toII > fromII ? toII - 1 : toII;
            srcSec.items.splice(insertAt2, 0, item);
            _saveTab(_activeTab);
            _renderSections();
          }
        }
      }
    }

    _container.querySelectorAll('.wl-dragging').forEach(function (el) { el.classList.remove('wl-dragging'); });
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup',   _onDragEnd);
    _drag = null;
  }

  /* Compute where a dragged ROW should land — scans all section headers + rows */
  function _computeRowDropTarget(clientY) {
    var secs     = _sections();
    var contRect = _container.getBoundingClientRect();
    var elements = Array.prototype.filter.call(_container.children, function (el) {
      return el.classList.contains('wl-row') || el.classList.contains('wl-sec-hd');
    });

    /* default: end of last section */
    var lastSI  = secs.length - 1;
    var result  = { si: lastSI < 0 ? 0 : lastSI, ii: lastSI < 0 ? 0 : secs[lastSI].items.length, lineY: 0 };
    if (elements.length) {
      var last = elements[elements.length - 1].getBoundingClientRect();
      result.lineY = last.bottom - contRect.top + _container.scrollTop;
    }

    for (var i = 0; i < elements.length; i++) {
      var el   = elements[i];
      var rect = el.getBoundingClientRect();
      var mid  = rect.top + rect.height / 2;

      if (el.classList.contains('wl-sec-hd')) {
        var hsi = parseInt(el.dataset.si);
        if (clientY < mid) {
          /* above this header → drop at top of this section */
          return { si: hsi, ii: 0, lineY: rect.top - contRect.top + _container.scrollTop };
        }
        /* entered this section; default to its end */
        result = { si: hsi, ii: secs[hsi] ? secs[hsi].items.length : 0,
                   lineY: rect.bottom - contRect.top + _container.scrollTop };
      } else {
        var rsi = parseInt(el.dataset.si);
        var rii = parseInt(el.dataset.ii);
        if (clientY < mid) {
          return { si: rsi, ii: rii, lineY: rect.top - contRect.top + _container.scrollTop };
        }
        result = { si: rsi, ii: rii + 1, lineY: rect.bottom - contRect.top + _container.scrollTop };
      }
    }
    return result;
  }

  /* Compute where a dragged SECTION HEADER should land */
  function _computeSecDropTarget(clientY) {
    var secs     = _sections();
    var contRect = _container.getBoundingClientRect();
    var headers  = Array.prototype.slice.call(_container.querySelectorAll('.wl-sec-hd'));

    var result = { si: secs.length, lineY: 0 };
    if (headers.length) {
      var last = headers[headers.length - 1].getBoundingClientRect();
      result.lineY = last.bottom - contRect.top + _container.scrollTop;
    }

    for (var i = 0; i < headers.length; i++) {
      var rect = headers[i].getBoundingClientRect();
      var mid  = rect.top + rect.height / 2;
      if (clientY < mid) {
        return { si: i, lineY: rect.top - contRect.top + _container.scrollTop };
      }
      result = { si: i + 1, lineY: rect.bottom - contRect.top + _container.scrollTop };
    }
    return result;
  }

  /* ── prices ──────────────────────────────────────────────────────── */
  function _subscribeHL() {
    if (!window.hlWS) return;
    _hlUnsubMids = window.hlWS.subscribeMids(function (mids) {
      _allItems().forEach(function (item) {
        if (item.source !== 'hyperliquid') return;
        var np   = parseFloat(mids[item.symbol]);
        if (isNaN(np)) return;
        var key  = 'hyperliquid:' + item.symbol;
        var prev = _prices[key];
        if (!prev) {
          _prices[key] = { price: np, change: 0, pct: 0, _open: np };
        } else {
          var ch = np - prev._open;
          _prices[key] = { price: np, change: ch, pct: prev._open ? ch / prev._open * 100 : 0, _open: prev._open };
        }
      });
      _updateAllPrices();
    });
  }

  function _startPoll() {
    function _poll() {
      var nonHL = _allItems().filter(function (it) { return it.source !== 'hyperliquid'; });
      if (!nonHL.length) return;
      var params = nonHL.map(function (it) { return encodeURIComponent(it.source + ':' + it.symbol); }).join(',');
      fetch('/api/batch-prices?items=' + params)
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j.prices) { Object.assign(_prices, j.prices); _updateAllPrices(); } })
        .catch(function () {});
    }
    _poll();
    _priceTimer = setInterval(_poll, POLL_MS);
  }

  function _stopPrices() {
    if (_priceTimer)  { clearInterval(_priceTimer); _priceTimer = null; }
    if (_hlUnsubMids) { _hlUnsubMids(); _hlUnsubMids = null; }
  }

  function _restartPrices() { _stopPrices(); _subscribeHL(); _startPoll(); }

  /* ── CSV export ─────────────────────────────────────────────────── */
  function _exportCSV() {
    var lines = ['symbol,name,source,section'];
    _sections().forEach(function (sec) {
      sec.items.forEach(function (item) {
        var name = (item.name || '').replace(/"/g, '""');
        if (name.indexOf(',') !== -1) name = '"' + name + '"';
        lines.push([item.symbol, name, item.source, sec.name].join(','));
      });
    });
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    var a    = document.createElement('a');
    a.href   = URL.createObjectURL(blob);
    a.download = (_activeTab || 'watchlist').replace(/[^a-z0-9_-]/gi, '_') + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ── CSV import ─────────────────────────────────────────────────── */
  function _parseCSVLine(line) {
    var cols = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }

  function _parseCSV(text) {
    var lines    = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    var isHeader = lines.length && lines[0].toLowerCase().replace(/"/g, '').split(',')[0].trim() === 'symbol';
    var data     = isHeader ? lines.slice(1) : lines;
    var parsed   = [];
    data.forEach(function (line) {
      if (!line.trim()) return;
      var cols    = _parseCSVLine(line);
      var sym     = (cols[0] || '').toUpperCase().trim();
      if (!sym) return;
      var name    = (cols[1] || sym).trim();
      var src     = (cols[2] || '').trim() || _autoSrc(sym);
      var secName = (cols[3] || 'Imported').trim();
      parsed.push({ symbol: sym, name: name, source: src, section: secName });
    });
    return parsed;
  }

  function _onFileSelected(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      var parsed   = _parseCSV(ev.target.result);
      var existing = new Set(_allItems().map(function (x) { return x.symbol; }));
      var dupes    = parsed.filter(function (p) { return existing.has(p.symbol); }).length;
      _pendingImport = parsed;
      var sumEl = document.getElementById('wl-import-summary');
      if (sumEl) {
        sumEl.textContent = 'Found ' + parsed.length + ' symbol' + (parsed.length !== 1 ? 's' : '') +
          ' (' + (parsed.length - dupes) + ' new, ' + dupes + ' duplicates)';
      }
      var modal = document.getElementById('wl-import-modal');
      if (modal) modal.classList.add('open');
    };
    reader.readAsText(file);
  }

  function _doImport(mode) {
    if (!_pendingImport) return;
    var existing = new Set(_allItems().map(function (x) { return x.symbol; }));
    var added = 0, skipped = 0;

    if (mode === 'replace') _tabData[_activeTab].sections = [];

    _pendingImport.forEach(function (p) {
      if (existing.has(p.symbol)) { skipped++; return; }
      existing.add(p.symbol); added++;
      var secs = _sections();
      var sec  = null;
      for (var i = 0; i < secs.length; i++) { if (secs[i].name === p.section) { sec = secs[i]; break; } }
      if (!sec) { sec = { name: p.section, collapsed: false, items: [] }; secs.push(sec); }
      sec.items.push({ symbol: p.symbol, name: p.name, source: p.source });
    });

    _pendingImport = null;
    _saveTab(_activeTab);
    _renderSections();
    _restartPrices();

    var modal = document.getElementById('wl-import-modal');
    if (modal) modal.classList.remove('open');
    _showToast('Imported ' + added + ', skipped ' + skipped + ' duplicate' + (skipped !== 1 ? 's' : '') + '.');
  }

  function _showToast(msg) {
    var t = document.getElementById('alert-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(function () { t.classList.remove('visible'); }, 3500);
  }

  /* ── search ─────────────────────────────────────────────────────── */
  function _initSearch() {
    var input = document.getElementById('wl-search-input');
    if (!input) return;

    _srchDrop = document.createElement('div');
    _srchDrop.className = 'sym-dropdown';
    document.body.appendChild(_srchDrop);

    input.addEventListener('input', function () {
      clearTimeout(_srchTimer);
      var q = input.value.trim();
      if (!q) { _srchDrop.classList.remove('visible'); return; }
      _srchTimer = setTimeout(function () {
        var base = '/api/search-symbols?q=' + encodeURIComponent(q);
        var fetch_ = function(url) { return fetch(url).then(function(r){return r.json();}).catch(function(){return {symbols:[]};}) };
        Promise.all([
          fetch_(base),
          fetch_(base + '&source=hyperliquid'),
          fetch_(base + '&source=binance'),
        ]).then(function(results) {
            var seen = {}, res = [];
            results.forEach(function(j) {
              (j.symbols || []).forEach(function(s) {
                if (!seen[s.symbol]) { seen[s.symbol] = true; res.push(s); }
              });
            });
            if (!res.length) { _srchDrop.classList.remove('visible'); return; }
            var rect = input.getBoundingClientRect();
            _srchDrop.style.cssText = 'top:' + (rect.bottom + 2) + 'px;left:' + rect.left + 'px;width:240px;';
            _srchDrop.innerHTML = res.slice(0, 15).map(function (s) {
              return '<div class="sym-item" data-sym="' + s.symbol +
                '" data-src="' + s.source +
                '" data-name="' + (s.name || '').replace(/"/g, '&quot;') + '">' +
                '<span class="sym-item-sym">' + s.symbol + '</span>' +
                '<span class="sym-item-name">' + (s.name || '') + '</span>' +
                '<span class="sym-item-cat">' + (s.category || '') + '</span>' +
                '</div>';
            }).join('');
            _srchDrop.classList.add('visible');
            _srchDrop.querySelectorAll('.sym-item').forEach(function (el) {
              el.addEventListener('mousedown', function (ev) {
                ev.preventDefault();
                addItem(el.dataset.sym, el.dataset.src, el.dataset.name);
                input.value = '';
                _srchDrop.classList.remove('visible');
              });
            });
        });
      }, 150);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var q = input.value.trim();
        if (q) { addItem(q.toUpperCase(), '', ''); input.value = ''; _srchDrop.classList.remove('visible'); }
      }
      if (e.key === 'Escape') _srchDrop.classList.remove('visible');
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { _srchDrop.classList.remove('visible'); }, 200);
    });
  }

  /* ── public API ─────────────────────────────────────────────────── */
  function addItem(sym, src, name) {
    sym = (sym || '').trim().toUpperCase();
    if (!sym) return;
    if (_allItems().some(function (x) { return x.symbol === sym; })) return;
    var secs   = _sections();
    if (!secs.length) secs.push({ name: 'Watchlist', collapsed: false, items: [] });
    var target = null;
    for (var i = 0; i < secs.length; i++) { if (!secs[i].collapsed) { target = secs[i]; break; } }
    if (!target) target = secs[0];
    target.items.push({ symbol: sym, source: src || _autoSrc(sym), name: name || sym });
    _saveTab(_activeTab);
    _renderSections();
    _restartPrices();
  }

  function toggle() {
    _open = !_open;
    var panel = document.getElementById('watchlist-panel');
    if (panel) panel.classList.toggle('wl-open', _open);
    var ob = document.getElementById('wl-open-btn');
    if (ob) ob.classList.toggle('active', _open);
    if (_open) _renderSections();
  }

  function isOpen() { return _open; }

  function _applyServerData(data) {
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
    _tabs      = data.tabs;
    _activeTab = (data.active && data.tabs.indexOf(data.active) !== -1)
                   ? data.active : data.tabs[0];
    _tabData   = {};
    _tabs.forEach(function (t) {
      var td = data.tabData && data.tabData[t];
      _tabData[t] = (td && Array.isArray(td.sections)) ? td
                  : { sections: [{ name: 'Watchlist', collapsed: false, items: [] }] };
    });
    // mirror to localStorage so next load is instant even without server
    localStorage.setItem(STORE_TABS,   JSON.stringify(_tabs));
    localStorage.setItem(STORE_ACTIVE, _activeTab);
    _tabs.forEach(function (t) {
      localStorage.setItem(STORE_TAB + t, JSON.stringify(_tabData[t]));
    });
    return true;
  }

  function init() {
    /* inject tab bar between header and search */
    _tabsBar = document.createElement('div');
    _tabsBar.id = 'wl-tabs-bar';
    var panel  = document.getElementById('watchlist-panel');
    var search = document.getElementById('wl-search-input');
    if (panel && search) panel.insertBefore(_tabsBar, search);

    _container = document.getElementById('watchlist-items');
    if (!_container) return;

    // load from localStorage immediately (instant render)
    _loadAll();
    _renderTabs();
    _renderSections();

    // then check server — if it has data, re-render with authoritative copy
    fetch('/api/watchlist')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.data) {
          // server has a file — apply it as the authoritative copy
          if (_applyServerData(j.data)) {
            _renderTabs();
            _renderSections();
            _restartPrices();
          }
          _setSaveDot('saved', 'Saved to file');
          _dotResetTimer = setTimeout(function () { _setSaveDot('', 'Saved'); }, 2000);
        } else if (j.ok && !j.data) {
          // no file yet — write current localStorage data to server immediately
          _serverSave();
        }
      })
      .catch(function () {});  // server unavailable — localStorage copy is fine
    _initSearch();

    var toggleBtn = document.getElementById('wl-toggle-btn');
    if (toggleBtn) toggleBtn.addEventListener('click', toggle);
    var openBtn = document.getElementById('wl-open-btn');
    if (openBtn) openBtn.addEventListener('click', toggle);

    var importBtn = document.getElementById('wl-import-btn');
    var fileInput = document.getElementById('wl-file-input');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) { _onFileSelected(fileInput.files[0]); fileInput.value = ''; }
      });
    }

    var exportBtn = document.getElementById('wl-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', _exportCSV);

    var addBtn     = document.getElementById('wl-import-add-btn');
    var replaceBtn = document.getElementById('wl-import-replace-btn');
    var cancelBtn  = document.getElementById('wl-import-cancel');
    var modal      = document.getElementById('wl-import-modal');
    if (addBtn)     addBtn.addEventListener('click',     function () { _doImport('add'); });
    if (replaceBtn) replaceBtn.addEventListener('click', function () { _doImport('replace'); });
    if (cancelBtn)  cancelBtn.addEventListener('click',  function () { if (modal) modal.classList.remove('open'); _pendingImport = null; });
    if (modal)      modal.addEventListener('click', function (e) { if (e.target === modal) { modal.classList.remove('open'); _pendingImport = null; } });

    _subscribeHL();
    _startPoll();

    /* ── watchlist keyboard navigation ─────────────────────────────── */
    document.addEventListener('keydown', function (e) {
      if (!_open) return;
      // ignore if typing in any input / select / editable element
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (document.activeElement && document.activeElement.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        _moveFocus(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _moveFocus(-1);
      } else if (e.key === 'Enter' && _focusedEl) {
        e.preventDefault();
        var si   = parseInt(_focusedEl.dataset.si);
        var ii   = parseInt(_focusedEl.dataset.ii);
        var secs = _sections();
        if (secs[si] && secs[si].items[ii]) _loadIntoActive(secs[si].items[ii]);
      }
    });
  }

  return { init: init, toggle: toggle, isOpen: isOpen, addItem: addItem };
})();
