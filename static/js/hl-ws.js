/**
 * Singleton Hyperliquid WebSocket client.
 * Usage:
 *   window.hlWS.subscribeCandle("BTC", "1h", callback) → returns unsub fn
 *   window.hlWS.subscribeMids(callback)                → returns unsub fn
 *   window.hlWS.onStatusChange(fn)                     → called with "connecting"|"connected"|"disconnected"
 */
class HLWebSocket {
  constructor() {
    this._ws            = null;
    this._candle_subs   = new Map();  // "COIN:interval" → Set<fn>
    this._mid_subs      = new Set();
    this._status_subs   = new Set();
    this._reconnect_ms  = 2000;
    this._reconnect_t   = null;
    this._status        = "disconnected";
    this._connect();
  }

  _setStatus(s) {
    this._status = s;
    this._status_subs.forEach(fn => fn(s));
  }

  _connect() {
    clearTimeout(this._reconnect_t);
    this._setStatus("connecting");
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
    this._ws = ws;

    ws.onopen = () => {
      this._setStatus("connected");
      this._reconnect_ms = 2000;
      // Resubscribe to allMids
      this._send({ method: "subscribe", subscription: { type: "allMids" } });
      // Resubscribe to any active candle streams
      for (const key of this._candle_subs.keys()) {
        if (this._candle_subs.get(key).size > 0) {
          const [coin, interval] = key.split(":");
          this._send({ method: "subscribe", subscription: { type: "candle", coin, interval } });
        }
      }
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg.channel) return;

      if (msg.channel === "allMids" && msg.data?.mids) {
        this._mid_subs.forEach(fn => fn(msg.data.mids));
        return;
      }

      if (msg.channel === "candle" && msg.data) {
        const d    = msg.data;
        const coin = d.s;
        const iv   = d.i;
        const key  = `${coin}:${iv}`;
        this._candle_subs.get(key)?.forEach(fn => fn(d));
      }
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      this._setStatus("disconnected");
      this._reconnect_t = setTimeout(() => {
        this._reconnect_ms = Math.min(this._reconnect_ms * 1.5, 30000);
        this._connect();
      }, this._reconnect_ms);
    };
  }

  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  /** Subscribe to candle updates. Returns an unsubscribe function. */
  subscribeCandle(coin, interval, callback) {
    const key = `${coin}:${interval}`;
    if (!this._candle_subs.has(key)) {
      this._candle_subs.set(key, new Set());
    }
    const set = this._candle_subs.get(key);
    const wasEmpty = set.size === 0;
    set.add(callback);
    if (wasEmpty) {
      this._send({ method: "subscribe", subscription: { type: "candle", coin, interval } });
    }
    return () => {
      set.delete(callback);
      if (set.size === 0) {
        this._send({ method: "unsubscribe", subscription: { type: "candle", coin, interval } });
      }
    };
  }

  /** Subscribe to allMids price feed. Returns an unsubscribe function. */
  subscribeMids(callback) {
    this._mid_subs.add(callback);
    return () => this._mid_subs.delete(callback);
  }

  /** Register a status change listener ("connecting"|"connected"|"disconnected"). */
  onStatusChange(fn) {
    this._status_subs.add(fn);
    fn(this._status);
    return () => this._status_subs.delete(fn);
  }
}

window.hlWS = new HLWebSocket();
