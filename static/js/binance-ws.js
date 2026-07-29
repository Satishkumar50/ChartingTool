/**
 * binance-ws.js - Binance WebSocket live price streaming.
 *
 * Uses a single persistent connection to wss://stream.binance.com:9443/ws
 * with dynamic SUBSCRIBE / UNSUBSCRIBE frames so multiple chart panes share
 * one socket.  Auto-reconnects and re-subscribes all active streams.
 *
 * Usage:
 *   var unsub = BinanceWS.subscribe("BTC", "1h", function(price, kline) { ... });
 *   unsub();  // when done
 */

var BinanceWS = (function () {
  var _ws      = null;
  var _subs    = {};      // streamName -> [callbacks]
  var _id      = 1;
  var _statCbs = [];
  var _retryT  = null;

  // Map UI interval labels -> Binance interval strings
  var _IV = {
    "1m":  "1m",  "5m":  "5m",  "15m": "15m", "30m": "30m",
    "1h":  "1h",  "4h":  "4h",
    "1D":  "1d",  "1W":  "1w",  "1M":  "1M",
  };

  // ── helpers ─────────────────────────────────────────────────────────────────

  function _norm(sym) {
    var s = sym.toUpperCase();
    var qs = ["USDT", "BUSD", "USDC", "BTC", "ETH", "BNB"];
    for (var i = 0; i < qs.length; i++) {
      if (s.slice(-qs[i].length) === qs[i]) return s;
    }
    return s + "USDT";
  }

  function _mkStream(sym, iv) {
    return _norm(sym).toLowerCase() + "@kline_" + (_IV[iv] || iv);
  }

  function _setStatus(s) {
    _statCbs.forEach(function (cb) { cb(s); });
  }

  function _send(obj) {
    if (_ws && _ws.readyState === 1 /* OPEN */) {
      _ws.send(JSON.stringify(obj));
    }
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────────────────

  function _connect() {
    if (_ws && _ws.readyState <= 1) return; // already open / connecting
    _ws = new WebSocket("wss://stream.binance.com:9443/ws");
    _setStatus("connecting");

    _ws.onopen = function () {
      _setStatus("connected");
      var streams = Object.keys(_subs);
      if (streams.length) {
        _send({ method: "SUBSCRIBE", params: streams, id: _id++ });
      }
    };

    _ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        // Ignore subscription confirmation / ping responses
        if (msg.result !== undefined || msg.id) return;
        if (msg.e !== "kline") return;
        var stream = msg.s.toLowerCase() + "@kline_" + msg.k.i;
        var cbs = _subs[stream];
        if (!cbs || !cbs.length) return;
        var price = parseFloat(msg.k.c);
        cbs.forEach(function (cb) { cb(price, msg.k); });
      } catch (e) {}
    };

    _ws.onerror = function () {};

    _ws.onclose = function () {
      _ws = null;
      _setStatus("disconnected");
      if (Object.keys(_subs).length) {
        _setStatus("reconnecting");
        clearTimeout(_retryT);
        _retryT = setTimeout(_connect, 3000);
      }
    };
  }

  // ── public API ───────────────────────────────────────────────────────────────

  function subscribe(sym, iv, cb) {
    var s     = _mkStream(sym, iv);
    var isNew = !_subs[s];
    if (!_subs[s]) _subs[s] = [];
    if (_subs[s].indexOf(cb) === -1) _subs[s].push(cb);

    if (!_ws || _ws.readyState > 1) {
      _connect();
    } else if (isNew && _ws.readyState === 1) {
      _send({ method: "SUBSCRIBE", params: [s], id: _id++ });
    }
    return function () { unsubscribe(sym, iv, cb); };
  }

  function unsubscribe(sym, iv, cb) {
    var s = _mkStream(sym, iv);
    if (!_subs[s]) return;
    _subs[s] = _subs[s].filter(function (c) { return c !== cb; });
    if (_subs[s].length === 0) {
      delete _subs[s];
      _send({ method: "UNSUBSCRIBE", params: [s], id: _id++ });
      if (!Object.keys(_subs).length && _ws) {
        _ws.close();
      }
    }
  }

  function onStatusChange(cb) { _statCbs.push(cb); }

  return {
    subscribe:      subscribe,
    unsubscribe:    unsubscribe,
    onStatusChange: onStatusChange,
    normalize:      _norm,
  };
})();
