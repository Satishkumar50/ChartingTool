/**
 * sync.js - Crosshair synchronization across all visible chart panes.
 *
 * How it works:
 *   Each ChartPane registers with CrosshairSync after its chart is created.
 *   When any chart's crosshair moves, this module finds the nearest candle
 *   at that timestamp in every other pane and calls setCrosshairPosition().
 *   A _syncing flag prevents the re-entrant loop that would otherwise occur.
 */

var CrosshairSync = (function() {
  var _panes   = [];
  var _syncing = false;

  function _nearest(candles, time) {
    if (!candles || !candles.length) return null;
    var lo = 0, hi = candles.length - 1;
    while (lo < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (candles[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    // compare with neighbor for closest match
    if (lo > 0 &&
        Math.abs(candles[lo - 1].time - time) < Math.abs(candles[lo].time - time)) {
      lo--;
    }
    return candles[lo] || null;
  }

  function _register(pane) {
    if (!pane || !pane.chart) return;
    var handler = function(param) {
      if (_syncing || !param || !param.time) return;
      _syncAll(pane, param.time);
    };
    pane.chart.subscribeCrosshairMove(handler);
    pane._chHandler = handler;
  }

  function _unregister(pane) {
    if (pane && pane._chHandler && pane.chart) {
      try { pane.chart.unsubscribeCrosshairMove(pane._chHandler); } catch (e) {}
    }
    if (pane) pane._chHandler = null;
    _panes = _panes.filter(function(p) { return p !== pane; });
  }

  function _syncAll(src, time) {
    _syncing = true;
    for (var i = 0; i < _panes.length; i++) {
      var p = _panes[i];
      if (p === src || !p.chart || !p.candleSeries || !p._candles.length) continue;
      var c = _nearest(p._candles, time);
      if (c) {
        try { p.chart.setCrosshairPosition(c.close, c.time, p.candleSeries); } catch (e) {}
      }
    }
    _syncing = false;
  }

  return {
    /** Replace entire pane set (call after every buildGrid). */
    rebuild: function(newPanes) {
      // Clean up old handlers
      for (var i = 0; i < _panes.length; i++) {
        var p = _panes[i];
        if (p._chHandler && p.chart) {
          try { p.chart.unsubscribeCrosshairMove(p._chHandler); } catch (e) {}
          p._chHandler = null;
        }
      }
      _panes = [];
      for (var j = 0; j < newPanes.length; j++) {
        _panes.push(newPanes[j]);
        _register(newPanes[j]);
      }
    },

    /** Unregister a single pane (call from ChartPane.destroy). */
    remove: function(pane) { _unregister(pane); },
  };
})();
