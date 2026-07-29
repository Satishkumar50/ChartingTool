"""
Multi-Timeframe Charts - Flask backend.

Symbol search strategy (hybrid):
  1. Local curated list is searched first (fast, name-aware, works offline).
  2. If local results < 5, Yahoo Finance live API is also queried so that
     ANY listed stock in the world can be found.
  For Hyperliquid, the full coin list is fetched from their /info API and cached.

Endpoints:
  GET /                      - serves index.html
  GET /api/history           - OHLCV data (cached)
  GET /api/price             - current price (yfinance polling)
  GET /api/symbols           - symbol list (backward compat)
  GET /api/search-symbols    - live hybrid symbol search
  GET /api/source-intervals  - valid intervals per source
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import data_source
import os
import time
import threading
import math

app = Flask(__name__, static_folder="static")
CORS(app)

# ── in-memory response cache ──────────────────────────────────────────────────
_cache: dict = {}
_cache_lock = threading.Lock()
_INTRADAY = {"1m", "5m", "15m", "30m", "1h", "4h"}

def _cache_ttl(interval: str) -> int:
    return 30 if interval in _INTRADAY else 300

def _cache_get(key):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry: return None
        data, exp = entry
        if time.time() > exp:
            del _cache[key]; return None
        return data

def _cache_set(key, data, ttl):
    with _cache_lock:
        _cache[key] = (data, time.time() + ttl)


# Optional Binance credentials (market data never needs these)
_bn_creds = {
    "api_key": os.environ.get("BINANCE_API_KEY", ""),
    "secret":  os.environ.get("BINANCE_SECRET",  ""),
}
if _bn_creds["api_key"]:
    data_source.set_binance_creds(_bn_creds["api_key"], _bn_creds["secret"])




# ── routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(app.static_folder, path)


@app.route("/api/history")
def history():
    symbol   = request.args.get("symbol",   "BTC")
    interval = request.args.get("interval", "1h")
    period   = request.args.get("period",   "60d")
    source   = request.args.get("source",   "hyperliquid")
    end_time = request.args.get("end",      None, type=int)  # Unix seconds; None = now
    key = (source, symbol, interval, period, end_time)
    cached = _cache_get(key)
    if cached is not None:
        return jsonify({"ok": True, "data": cached, "cached": True})
    try:
        raw = data_source.get_history(symbol, interval, period, source, end_time=end_time)
        # Safety net: drop any candle that still contains NaN/Inf
        # (primary NaN removal is in data_source.py; this is a belt-and-braces guard)
        candles = [c for c in raw
                   if all(not (isinstance(c.get(k), float) and
                               (math.isnan(c[k]) or math.isinf(c[k])))
                          for k in ("open", "high", "low", "close"))]
        _cache_set(key, candles, _cache_ttl(interval))
        return jsonify({"ok": True, "data": candles})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/price")
def price():
    symbol = request.args.get("symbol", "RELIANCE.NS")
    source = request.args.get("source", "yfinance")
    if source not in ("yfinance", "yfinance_us"):
        return jsonify({"ok": False, "error": f"Price polling not needed for {source}"}), 400
    try:
        data = data_source.get_price_yfinance(symbol)
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/symbols")
def symbols():
    """Backward-compat stub — symbols are now discovered via /api/search-symbols."""
    return jsonify({"ok": True, "symbols": []})


@app.route("/api/search-symbols")
def search_symbols():
    """Fully dynamic symbol search — queries live exchange/Yahoo APIs.

    Query params:
      q      - search string (empty = return live coin list for crypto; empty for stocks)
      source - optional filter: hyperliquid | binance | yfinance | yfinance_us
    """
    q      = request.args.get("q", "").strip()
    source = request.args.get("source", "")

    # ── no query: return live coin list for crypto sources; empty for stock sources ──
    if not q:
        try:
            if source == "binance":
                return jsonify({"ok": True, "symbols": data_source._get_bn_coins()[:30]})
            elif source == "hyperliquid":
                return jsonify({"ok": True, "symbols": data_source._get_hl_coins()[:30]})
        except Exception:
            pass
        return jsonify({"ok": True, "symbols": []})

    # ── live search ──
    try:
        if source == "binance":
            results = data_source.search_symbols_binance(q)
        elif source == "hyperliquid":
            results = data_source.search_symbols_hyperliquid(q)
        else:
            # Yahoo Finance covers NSE, BSE, US stocks, indices, commodities, forex
            yf_results = data_source.search_symbols_yfinance(q)
            if source in ("yfinance", "yfinance_us"):
                filtered = [r for r in yf_results if r["source"] == source]
                results = filtered if filtered else yf_results
            else:
                results = yf_results
    except Exception:
        results = []

    return jsonify({"ok": True, "symbols": results[:40]})


@app.route("/api/source-intervals")
def source_intervals():
    return jsonify({"ok": True, "intervals": data_source.SOURCE_INTERVALS})


@app.route("/api/binance-config", methods=["GET", "POST"])
def binance_config():
    """Save/retrieve optional Binance API credentials. Market data never requires these."""
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        _bn_creds["api_key"] = body.get("api_key", "").strip()
        _bn_creds["secret"]  = body.get("secret",  "").strip()
        data_source.set_binance_creds(_bn_creds["api_key"], _bn_creds["secret"])
        return jsonify({"ok": True, "message": "Credentials saved for this session."})
    masked = (_bn_creds["api_key"][:8] + "...") if _bn_creds["api_key"] else ""
    return jsonify({"ok": True, "configured": bool(_bn_creds["api_key"]), "api_key": masked})


@app.route("/api/batch-prices")
def batch_prices():
    """Return prices for a list of source:symbol pairs (for watchlist).
    Query param: items=yfinance:RELIANCE.NS,binance:BTC,...
    Response: { "prices": { "yfinance:RELIANCE.NS": {price, change, pct}, ... } }
    """
    items_str = request.args.get("items", "")
    if not items_str:
        return jsonify({"ok": True, "prices": {}})
    pairs = [p.strip() for p in items_str.split(",") if ":" in p]
    prices: dict = {}
    lock = threading.Lock()

    def _fetch_one(pair):
        source, _, sym = pair.partition(":")
        if not source or not sym:
            return
        key = source + ":" + sym
        try:
            if source in ("yfinance", "yfinance_us"):
                d = data_source.get_price_yfinance(sym)
                p   = d.get("price",      0.0)
                c   = d.get("change",     0.0)
                pct = d.get("change_pct", 0.0)
                # NaN/Inf breaks JSON serialisation — skip the symbol instead
                if not math.isfinite(p):
                    return
                with lock:
                    prices[key] = {
                        "price":  p,
                        "change": c   if math.isfinite(c)   else 0.0,
                        "pct":    pct if math.isfinite(pct) else 0.0,
                    }
            elif source == "binance":
                bn_sym = data_source._bn_normalize(sym)
                r = data_source._session.get(
                    data_source._BN_API + "/ticker/24hr",
                    params={"symbol": bn_sym}, timeout=5)
                r.raise_for_status()
                d = r.json()
                with lock:
                    prices[key] = {
                        "price":  float(d["lastPrice"]),
                        "change": float(d["priceChange"]),
                        "pct":    float(d["priceChangePercent"]),
                    }
        except Exception:
            pass  # missing price is non-fatal; watchlist row shows "—"

    # Fetch all symbols concurrently (cap at 100 per call)
    threads = [threading.Thread(target=_fetch_one, args=(pair,), daemon=True)
               for pair in pairs[:100]]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    return jsonify({"ok": True, "prices": prices})


# ── workspace persistence ────────────────────────────────────────────────────
_WS_FILE = os.path.join(os.path.dirname(__file__), "workspace_data.json")

@app.route("/api/workspaces", methods=["GET"])
def workspaces_get():
    """Return saved workspace data from disk."""
    try:
        if os.path.exists(_WS_FILE):
            with open(_WS_FILE, "r", encoding="utf-8") as f:
                import json
                data = json.load(f)
            return jsonify({"ok": True, "data": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "data": None})

@app.route("/api/workspaces", methods=["POST"])
def workspaces_save():
    """Save workspace data to disk."""
    try:
        import json
        body = request.get_json(silent=True)
        if body is None:
            return jsonify({"ok": False, "error": "empty body"}), 400
        with open(_WS_FILE, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── watchlist persistence ─────────────────────────────────────────────────────
_WL_FILE = os.path.join(os.path.dirname(__file__), "watchlist_data.json")

@app.route("/api/watchlist", methods=["GET"])
def watchlist_get():
    """Return saved watchlist data from disk."""
    try:
        if os.path.exists(_WL_FILE):
            with open(_WL_FILE, "r", encoding="utf-8") as f:
                import json
                data = json.load(f)
            return jsonify({"ok": True, "data": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "data": None})  # no file yet

@app.route("/api/watchlist", methods=["POST"])
def watchlist_save():
    """Save watchlist data to disk."""
    try:
        import json
        body = request.get_json(silent=True)
        if not body:
            return jsonify({"ok": False, "error": "empty body"}), 400
        with open(_WL_FILE, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Multi-Timeframe Charts  ->  http://localhost:{port}\n")
    app.run(debug=False, port=port, threaded=True)
