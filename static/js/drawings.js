/**
 * drawings.js - Per-pane horizontal price lines using LWC createPriceLine API.
 *
 * Usage:
 *   DrawingsManager.activateHLineTool(pane)  - click chart to place a line
 *   DrawingsManager.clearDrawings(pane)       - remove all lines
 *   DrawingsManager.restoreDrawings(pane)     - called after data loads
 *
 * TODO: Trendlines and rectangles require LWC custom primitives (plugin API)
 * and are left as a future enhancement.
 */

var DrawingsManager = (function() {
  var KEY = 'mtc-draw-';

  function _load(idx) {
    try { return JSON.parse(localStorage.getItem(KEY + idx)) || []; } catch (e) { return []; }
  }
  function _persist(idx, lines) {
    localStorage.setItem(KEY + idx, JSON.stringify(lines));
  }

  function _addLine(pane, price, color, label) {
    if (!pane.candleSeries) return null;
    try {
      var pl = pane.candleSeries.createPriceLine({
        price:            price,
        color:            color || '#f48024',
        lineWidth:        1,
        lineStyle:        LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title:            label || 'H-Line',
      });
      pane._drawLines = pane._drawLines || [];
      pane._drawLines.push({ pl: pl, price: price, color: color || '#f48024', label: label || 'H-Line' });
      return pl;
    } catch (e) { return null; }
  }

  function restoreDrawings(pane) {
    var saved = _load(pane.index);
    if (!saved.length) return;
    saved.forEach(function(d) { _addLine(pane, d.price, d.color, d.label); });
  }

  function activateHLineTool(pane) {
    if (!pane.chart) return;
    deactivateTool(pane);                         // clear any prior mode
    pane._drawMode = 'hline';
    pane.chartWrap.style.cursor = 'crosshair';
    pane.chartWrap.title = 'Click to place horizontal line';

    var handler = function(param) {
      if (!param || !param.point || !pane._drawMode) return;
      var price;
      try { price = pane.candleSeries.coordinateToPrice(param.point.y); } catch (e) { return; }
      if (price == null) return;
      price = Math.round(price * 10000) / 10000;
      _addLine(pane, price, '#f48024', 'H-Line');
      // Persist
      var lines = _load(pane.index);
      lines.push({ price: price, color: '#f48024', label: 'H-Line' });
      _persist(pane.index, lines);
      deactivateTool(pane);
    };

    pane._drawClickHandler = handler;
    pane.chart.subscribeClick(handler);
  }

  function deactivateTool(pane) {
    pane._drawMode = null;
    pane.chartWrap.style.cursor = '';
    pane.chartWrap.title = '';
    if (pane._drawClickHandler && pane.chart) {
      try { pane.chart.unsubscribeClick(pane._drawClickHandler); } catch (e) {}
      pane._drawClickHandler = null;
    }
  }

  function clearDrawings(pane) {
    if (!pane.candleSeries || !pane._drawLines) return;
    pane._drawLines.forEach(function(d) {
      try { pane.candleSeries.removePriceLine(d.pl); } catch (e) {}
    });
    pane._drawLines = [];
    _persist(pane.index, []);
  }

  return {
    restoreDrawings: restoreDrawings,
    activateHLineTool: activateHLineTool,
    deactivateTool: deactivateTool,
    clearDrawings: clearDrawings,
  };
})();
