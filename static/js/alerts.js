/**
 * alerts.js - Local browser price alerts.
 *
 * Alerts are stored in localStorage.  check(source, symbol, price) is called
 * from ChartPane._flash() on every price tick, using an in-memory cache to
 * avoid repeated localStorage reads during high-frequency HL updates.
 */

var AlertsManager = (function() {
  var STORE = 'mtc-alerts';
  var _cache = null;      // in-memory alert cache; null = needs reload
  var _toastT = null;

  // ── storage ────────────────────────────────────────────────────────────────
  function _load() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(localStorage.getItem(STORE)) || []; } catch (e) { _cache = []; }
    return _cache;
  }
  function _save(arr) {
    _cache = arr;
    localStorage.setItem(STORE, JSON.stringify(arr));
  }

  // ── price check (called on every tick) ────────────────────────────────────
  function check(source, symbol, price) {
    if (!price || isNaN(price)) return;
    var alerts = _load();
    var changed = false;
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      if (!a.enabled || a.triggered || a.symbol !== symbol) continue;
      var hit = a.condition === 'above' ? price >= a.price : price <= a.price;
      if (hit) {
        a.triggered = true;
        changed = true;
        _trigger(a, price);
      }
    }
    if (changed) { _save(alerts); _renderList(); }
  }

  function _trigger(alert, price) {
    var dir = alert.condition === 'above' ? '▲' : '▼';
    var msg = alert.symbol + ' ' + dir + ' ' + alert.price + '  (now ' + Number(price).toFixed(2) + ')';
    _toast(msg, true);
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification('Price Alert: ' + alert.symbol, { body: msg, icon: '' }); } catch (e) {}
    }
  }

  // ── public API ──────────────────────────────────────────────────────────────
  function addAlert(symbol, source, condition, price) {
    price = parseFloat(price);
    if (!symbol || isNaN(price)) { _toast('Enter a valid symbol and price.', false); return; }
    var arr = _load();
    arr.push({ id: Date.now(), symbol: symbol.toUpperCase(), source: source,
               condition: condition, price: price, enabled: true, triggered: false });
    _save(arr);
    _renderList();
    _toast('Alert set: ' + symbol + ' ' + condition + ' ' + price, false);
  }

  function deleteAlert(id) {
    _save(_load().filter(function(a) { return a.id !== id; }));
    _renderList();
  }

  function resetAlert(id) {
    var arr = _load();
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) { arr[i].triggered = false; break; } }
    _save(arr);
    _renderList();
  }

  function toggleAlert(id) {
    var arr = _load();
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) { arr[i].enabled = !arr[i].enabled; break; } }
    _save(arr);
    _renderList();
  }

  // ── modal ──────────────────────────────────────────────────────────────────
  function openPanel() {
    _prefillFromActive();
    _renderList();
    var m = document.getElementById('alerts-modal');
    if (m) m.classList.add('open');
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function closePanel() {
    var m = document.getElementById('alerts-modal');
    if (m) m.classList.remove('open');
  }

  function _prefillFromActive() {
    var pane = window.panes && window.panes[window._activePaneIndex || 0];
    if (!pane) return;
    var symEl = document.getElementById('alert-sym');
    var srcEl = document.getElementById('alert-src');
    var prEl  = document.getElementById('alert-price');
    if (symEl && !symEl.value) symEl.value = pane.symbol || '';
    if (srcEl) srcEl.value = pane.source || 'hyperliquid';
    if (prEl  && !prEl.value) prEl.value = pane.lastPrice ? pane.lastPrice.toFixed(2) : '';
  }

  function _renderList() {
    var box = document.getElementById('alerts-list');
    if (!box) return;
    var arr = _load();
    if (!arr.length) { box.innerHTML = '<div class="al-empty">No alerts. Add one above.</div>'; return; }
    box.innerHTML = arr.map(function(a) {
      var cls = a.triggered ? ' al-triggered' : (!a.enabled ? ' al-off' : '');
      return '<div class="al-row' + cls + '">' +
        '<span class="al-sym">' + a.symbol + '</span>' +
        '<span class="al-cond">' + (a.condition === 'above' ? '▲' : '▼') + '</span>' +
        '<span class="al-pr">' + a.price + '</span>' +
        '<span class="al-st">' + (a.triggered ? 'Fired' : a.enabled ? 'Active' : 'Off') + '</span>' +
        '<div class="al-acts">' +
          (a.triggered
            ? '<button class="al-btn" onclick="AlertsManager.resetAlert(' + a.id + ')">Reset</button>'
            : '') +
          '<button class="al-btn" onclick="AlertsManager.toggleAlert(' + a.id + ')">' +
            (a.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="al-btn al-del" onclick="AlertsManager.deleteAlert(' + a.id + ')">×</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── toast ──────────────────────────────────────────────────────────────────
  function _toast(msg, isAlert) {
    var t = document.getElementById('alert-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'alert-toast show' + (isAlert ? ' alert-fire' : '');
    clearTimeout(_toastT);
    _toastT = setTimeout(function() { t.className = 'alert-toast'; }, 5000);
  }

  function init() {
    var addBtn = document.getElementById('alert-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function() {
        addAlert(
          (document.getElementById('alert-sym')  || {}).value || '',
          (document.getElementById('alert-src')  || {}).value || 'hyperliquid',
          (document.getElementById('alert-cond') || {}).value || 'above',
          (document.getElementById('alert-price')|| {}).value || ''
        );
      });
    }
    var modal = document.getElementById('alerts-modal');
    if (modal) {
      modal.addEventListener('click', function(e) { if (e.target === modal) closePanel(); });
    }
    var closeBtn = document.getElementById('alerts-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    var openBtn = document.getElementById('alerts-btn');
    if (openBtn) openBtn.addEventListener('click', openPanel);
  }

  return {
    init:        init,
    check:       check,
    openPanel:   openPanel,
    closePanel:  closePanel,
    addAlert:    addAlert,
    deleteAlert: deleteAlert,
    resetAlert:  resetAlert,
    toggleAlert: toggleAlert,
  };
})();
