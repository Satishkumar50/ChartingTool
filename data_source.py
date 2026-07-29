"""
Pluggable data source module.

UI interval labels used throughout the system:
  1m  5m  15m  30m  1h  4h  1D  1W  1M

Each source maps these labels to its own interval strings.
Hyperliquid does NOT support 1M - callers must filter it out before reaching here.

To add a new broker:
  1. Write get_history_<name>(symbol, interval_label, period) -> list[dict]
  2. Write the interval label mapping for your broker
  3. Add to _SOURCE_MAP at the bottom
"""

import math
import yfinance as yf
import pandas as pd
import requests as _req

# ── SSL / session setup ───────────────────────────────────────────────────────
# Try certifi (pip install certifi) for proper CA bundle on Windows.
# Falls back to system default. Only disables verification if both fail.

class _TimeoutAdapter(_req.adapters.HTTPAdapter):
    """Injects a default timeout on every request so yfinance/HL calls never hang.

    requests.Session always passes timeout=None explicitly, so setdefault() would
    not override it.  We must check for None and replace it.
    """
    def send(self, *args, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = 20
        return super().send(*args, **kwargs)


def _build_session() -> _req.Session:
    """
    Build a shared requests Session.
    On Windows, Python's certifi CA bundle often cannot verify certificates from
    APIs like Hyperliquid and yfinance because Windows uses its own system CA store.
    verify=False is the correct pragmatic fix for a local-only development tool
    where there is no deployment and no security risk from MITM on localhost.
    A warning is printed once on startup.
    """
    import warnings
    s = _req.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0"})
    # 20-second wall-clock cap on every outbound request (prevents yfinance hangs)
    s.mount("https://", _TimeoutAdapter())
    s.mount("http://",  _TimeoutAdapter())
    # Try certifi first; fall back to disabling verification on Windows CA failures
    try:
        import certifi
        s.verify = certifi.where()
    except ImportError:
        s.verify = False
        warnings.warn(
            "SSL verification disabled (certifi not found). "
            "Run: pip install certifi", stacklevel=2
        )
    return s

_session = _build_session()

def _ensure_ssl_works():
    """Test SSL and silently fall back to verify=False if certifi doesn't help."""
    global _session
    try:
        _session.head("https://query1.finance.yahoo.com", timeout=6)
    except Exception as e:
        if "SSL" in str(e) or "certificate" in str(e).lower():
            print("[data_source] Windows CA issue detected - disabling SSL verification for local dev.")
            _session.verify = False

_ensure_ssl_works()

# ── helpers ───────────────────────────────────────────────────────────────────

def _period_to_days(period: str) -> int:
    table = {
        "1d": 1, "5d": 5, "7d": 7, "14d": 14, "30d": 30,
        "60d": 60, "90d": 90, "180d": 180, "365d": 365,
        "730d": 730, "1825d": 1825,
        "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365,
    }
    if period in table:
        return table[period]
    if period.endswith("d"):
        return int(period[:-1])
    return 60


def _dedup_sort(candles: list) -> list:
    seen: set = set()
    out = []
    for c in sorted(candles, key=lambda x: x["time"]):
        if c["time"] not in seen:
            seen.add(c["time"])
            out.append(c)
    return out


def _to_unix(ts) -> int:
    if hasattr(ts, "timestamp"):
        return int(ts.timestamp())
    return int(pd.Timestamp(ts).timestamp())


# ── yfinance interval mapping ─────────────────────────────────────────────────
# Maps frontend UI label -> yfinance interval string.
# Note: 4h is NOT supported by yfinance (omitted intentionally).

_YF_IV: dict[str, str] = {
    "1m":  "1m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "1D":  "1d",
    "1W":  "1wk",
    "1M":  "1mo",
}

# Maximum look-back period yfinance allows per interval
_YF_PERIOD_CAP: dict[str, str] = {
    "1m":  "7d",
    "5m":  "60d",
    "15m": "60d",
    "30m": "60d",
    "1h":  "730d",
    "1d":  "max",
    "1wk": "max",
    "1mo": "max",
}


# ── yfinance (Indian stocks, US equities, indices, commodities, forex) ────────

def get_history_yfinance(symbol: str, interval: str, period: str,
                         end_time: int | None = None) -> list[dict]:
    from datetime import datetime, timezone, timedelta
    yf_iv = _YF_IV.get(interval)
    if yf_iv is None:
        raise ValueError(f"Interval '{interval}' is not supported by yfinance. "
                         f"Supported: {list(_YF_IV)}")

    cap = _YF_PERIOD_CAP.get(yf_iv, "730d")
    days = _period_to_days(period)
    if cap != "max" and days > _period_to_days(cap):
        days = _period_to_days(cap)

    try:
        ticker = yf.Ticker(symbol, session=_session)
        if end_time is not None:
            end_dt   = datetime.fromtimestamp(end_time, tz=timezone.utc)
            start_dt = end_dt - timedelta(days=days)
            df = ticker.history(start=start_dt, end=end_dt, interval=yf_iv)
        else:
            df = ticker.history(period=f"{days}d" if days < 3650 else "max",
                                interval=yf_iv)
    except Exception as e:
        raise

    if df.empty:
        return []

    df = df.reset_index()
    candles = []
    for _, row in df.iterrows():
        ts = row.get("Datetime") or row.get("Date")
        o = float(row["Open"])
        h = float(row["High"])
        l = float(row["Low"])
        c = float(row["Close"])
        # Skip candles where any OHLC field is NaN (gaps, circuit breakers, etc.)
        # NaN would serialize as bare NaN which is not valid JSON.
        if math.isnan(o) or math.isnan(h) or math.isnan(l) or math.isnan(c):
            continue
        vol = row.get("Volume", 0)
        candles.append({
            "time":   _to_unix(ts),
            "open":   round(o, 4),
            "high":   round(h, 4),
            "low":    round(l, 4),
            "close":  round(c, 4),
            "volume": 0 if (vol != vol) else int(vol),  # vol != vol is NaN check
        })
    return _dedup_sort(candles)


def get_price_yfinance(symbol: str) -> dict:
    ticker = yf.Ticker(symbol, session=_session)
    try:
        fi    = ticker.fast_info
        price = float(fi.last_price)
        if not math.isfinite(price):
            raise ValueError("NaN price from fast_info")
        prev  = float(fi.previous_close) if fi.previous_close else price
        if not math.isfinite(prev):
            prev = price
    except Exception:
        df = ticker.history(period="5d", interval="1d")
        if df.empty:
            return {"symbol": symbol, "price": 0.0, "change": 0.0, "change_pct": 0.0}
        price = float(df["Close"].iloc[-1])
        prev  = float(df["Close"].iloc[-2]) if len(df) > 1 else price
    change = price - prev
    pct    = (change / prev * 100) if prev else 0.0
    return {
        "symbol":     symbol,
        "price":      round(price,  4),
        "change":     round(change, 4),
        "change_pct": round(pct,    2),
    }


# ── Hyperliquid interval mapping ──────────────────────────────────────────────
# Maps frontend UI label -> Hyperliquid REST/WS interval string.
# 1M (monthly) is intentionally excluded - Hyperliquid does not support it.

_HL_IV: dict[str, str] = {
    "1m":  "1m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "4h":  "4h",
    "1D":  "1d",
    "1W":  "1w",
    # "1M" handled by aggregating daily candles (see get_history_hyperliquid)
}

_HL_API = "https://api.hyperliquid.xyz/info"


def _aggregate_monthly(candles: list) -> list:
    """Roll daily candles up into monthly OHLCV candles."""
    from datetime import datetime, timezone
    buckets: dict = {}
    for c in candles:
        dt  = datetime.fromtimestamp(c["time"], tz=timezone.utc)
        key = (dt.year, dt.month)
        if key not in buckets:
            buckets[key] = []
        buckets[key].append(c)
    result = []
    for key in sorted(buckets.keys()):
        grp = buckets[key]
        result.append({
            "time":   grp[0]["time"],
            "open":   grp[0]["open"],
            "high":   max(c["high"]   for c in grp),
            "low":    min(c["low"]    for c in grp),
            "close":  grp[-1]["close"],
            "volume": sum(c["volume"] for c in grp),
        })
    return result


def get_history_hyperliquid(symbol: str, interval: str, period: str,
                            end_time: int | None = None) -> list[dict]:
    if interval == "1M":
        # Hyperliquid has no native monthly endpoint.
        # Build monthly candles by aggregating ~5 years of daily data.
        daily = get_history_hyperliquid(symbol, "1D", "1825d", end_time=end_time)
        return _aggregate_monthly(daily)

    hl_iv = _HL_IV.get(interval)
    if hl_iv is None:
        raise ValueError(f"Interval '{interval}' is not supported by Hyperliquid. "
                         f"Supported: {list(_HL_IV)}")

    import time as _time
    days   = _period_to_days(period)
    end_ms = int(end_time * 1000) if end_time is not None else int(_time.time() * 1000)
    st_ms  = end_ms - days * 86_400_000

    payload = {
        "type": "candleSnapshot",
        "req": {
            "coin":      symbol,
            "interval":  hl_iv,
            "startTime": st_ms,
            "endTime":   end_ms,
        },
    }

    try:
        resp = _session.post(_HL_API, json=payload, timeout=15)
        resp.raise_for_status()
    except _req.exceptions.SSLError:
        # Auto-disable SSL verification and retry once
        _session.verify = False
        resp = _session.post(_HL_API, json=payload, timeout=15)
        resp.raise_for_status()

    candles = []
    for c in resp.json():
        candles.append({
            "time":   int(c["t"] // 1000),
            "open":   float(c["o"]),
            "high":   float(c["h"]),
            "low":    float(c["l"]),
            "close":  float(c["c"]),
            "volume": float(c["v"]),
        })
    return _dedup_sort(candles)


# ── Binance interval mapping ──────────────────────────────────────────────────

_BN_IV: dict[str, str] = {
    "1m":  "1m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "4h":  "4h",
    "1D":  "1d",
    "1W":  "1w",
    "1M":  "1M",
}

_BN_API = "https://api.binance.com/api/v3"

# Optional Binance credentials (market data works without them)
_bn_api_key: str = ""
_bn_secret:  str = ""


def set_binance_creds(api_key: str, secret: str) -> None:
    global _bn_api_key, _bn_secret
    _bn_api_key = api_key.strip()
    _bn_secret  = secret.strip()


def _bn_normalize(symbol: str) -> str:
    """Add USDT suffix unless a known quote asset is already present as a suffix
    AND there is a non-empty base asset before it (e.g. ETHBTC yes, BTC alone no)."""
    s = symbol.upper().strip()
    for q in ("USDT", "BUSD", "USDC", "BTC", "ETH", "BNB"):
        if s.endswith(q) and len(s) > len(q):
            return s
    return s + "USDT"


# Cache for Binance tradeable symbols (refreshed every hour)
_bn_coins_cache: list = []
_bn_coins_ts:    float = 0.0


def _get_bn_coins() -> list[dict]:
    """Fetch all USDT-denominated TRADING pairs from Binance exchangeInfo, cached 1 h."""
    global _bn_coins_cache, _bn_coins_ts
    if _bn_coins_cache and _time_mod.time() - _bn_coins_ts < 3600:
        return _bn_coins_cache
    try:
        resp = _session.get(_BN_API + "/exchangeInfo", timeout=15)
        resp.raise_for_status()
        syms = resp.json().get("symbols", [])
        _bn_coins_cache = [
            {
                "symbol":   s["baseAsset"],
                "name":     s["baseAsset"],
                "category": "Crypto (Binance)",
                "source":   "binance",
            }
            for s in syms
            if s.get("quoteAsset") == "USDT" and s.get("status") == "TRADING"
        ]
        _bn_coins_ts = _time_mod.time()
    except Exception:
        pass
    return _bn_coins_cache


def search_symbols_binance(q: str) -> list[dict]:
    """Search Binance USDT pairs by base asset symbol."""
    coins = _get_bn_coins()
    q_up  = q.upper()
    starts   = [c for c in coins if c["symbol"].upper().startswith(q_up)]
    contains = [c for c in coins if q_up in c["symbol"].upper()
                and not c["symbol"].upper().startswith(q_up)]
    return (starts + contains)[:25]


# ── broker stubs (add your implementation here) ───────────────────────────────

def get_history_alpaca(symbol: str, interval: str, period: str,
                       end_time: int | None = None) -> list[dict]:
    """TODO: pip install alpaca-trade-api; set APCA_API_KEY_ID + APCA_API_SECRET_KEY."""
    raise NotImplementedError("Alpaca not yet configured")


def get_history_binance(symbol: str, interval: str, period: str,
                        end_time: int | None = None) -> list[dict]:
    """Fetch OHLCV from Binance public REST API. No API key required for market data."""
    bn_iv = _BN_IV.get(interval)
    if bn_iv is None:
        raise ValueError(f"Interval '{interval}' not supported by Binance. Supported: {list(_BN_IV)}")

    days     = _period_to_days(period)
    end_ms   = int(end_time * 1000) if end_time is not None else int(_time_mod.time() * 1000)
    start_ms = end_ms - days * 86_400_000
    bn_sym   = _bn_normalize(symbol)

    candles: list = []
    cur_start = start_ms

    while cur_start < end_ms and len(candles) < 3000:
        params = {
            "symbol":    bn_sym,
            "interval":  bn_iv,
            "startTime": cur_start,
            "endTime":   end_ms,
            "limit":     1000,
        }
        try:
            resp = _session.get(_BN_API + "/klines", params=params, timeout=15)
            resp.raise_for_status()
        except _req.exceptions.SSLError:
            _session.verify = False
            resp = _session.get(_BN_API + "/klines", params=params, timeout=15)
            resp.raise_for_status()

        raw = resp.json()
        if isinstance(raw, dict):
            raise ValueError(f"Binance: {raw.get('msg', str(raw))}")
        if not raw:
            break

        for c in raw:
            o, h, l, cl, v = float(c[1]), float(c[2]), float(c[3]), float(c[4]), float(c[5])
            if math.isnan(o) or math.isnan(h) or math.isnan(l) or math.isnan(cl):
                continue
            candles.append({
                "time":   int(c[0] // 1000),
                "open":   round(o,  8),
                "high":   round(h,  8),
                "low":    round(l,  8),
                "close":  round(cl, 8),
                "volume": round(v,  4),
            })

        if len(raw) < 1000:
            break
        cur_start = int(raw[-1][6]) + 1  # after last candle's closeTime

    return _dedup_sort(candles)


def get_history_zerodha(symbol: str, interval: str, period: str,
                        end_time: int | None = None) -> list[dict]:
    """TODO: pip install kiteconnect; set ZERODHA_API_KEY + ZERODHA_ACCESS_TOKEN."""
    raise NotImplementedError("Zerodha not yet configured")


def get_history_polygon(symbol: str, interval: str, period: str,
                        end_time: int | None = None) -> list[dict]:
    """TODO: pip install polygon-api-client; set POLYGON_API_KEY."""
    raise NotImplementedError("Polygon not yet configured")


def get_history_trading212(symbol: str, interval: str, period: str,
                           end_time: int | None = None) -> list[dict]:
    """TODO: set TRADING212_API_KEY env var."""
    raise NotImplementedError("Trading212 not yet configured")


# ── router ────────────────────────────────────────────────────────────────────

_SOURCE_MAP = {
    "yfinance":    get_history_yfinance,
    "yfinance_us": get_history_yfinance,   # same engine; US tickers have no .NS suffix
    "hyperliquid": get_history_hyperliquid,
    "alpaca":      get_history_alpaca,
    "binance":     get_history_binance,
    "zerodha":     get_history_zerodha,
    "polygon":     get_history_polygon,
    "trading212":  get_history_trading212,
}

# Intervals supported per source (used by frontend to build dropdowns)
SOURCE_INTERVALS: dict[str, list[str]] = {
    "hyperliquid": ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"],
    "yfinance":    ["1m", "5m", "15m", "30m", "1h", "1D", "1W", "1M"],
    "yfinance_us": ["1m", "5m", "15m", "30m", "1h", "1D", "1W", "1M"],
    "binance":     ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"],
}


def get_history(symbol: str, interval: str, period: str, source: str,
                end_time: int | None = None) -> list[dict]:
    """Main entry point. Raises ValueError for unknown source or unsupported interval."""
    fn = _SOURCE_MAP.get(source)
    if fn is None:
        raise ValueError(f"Unknown source '{source}'. Available: {list(_SOURCE_MAP)}")
    return fn(symbol, interval, period, end_time=end_time)


# Mapping from UI interval label to Hyperliquid WS interval string
def ui_to_hl_ws_interval(ui_label: str) -> str:
    iv = _HL_IV.get(ui_label)
    if iv is None:
        raise ValueError(f"'{ui_label}' not supported on Hyperliquid")
    return iv


# ── Live symbol search ────────────────────────────────────────────────────────

import time as _time_mod

# Cache for Hyperliquid coin list (refreshed every hour)
_hl_coins_cache: list = []
_hl_coins_ts: float  = 0.0

def _get_hl_coins() -> list[dict]:
    """Fetch all available Hyperliquid perp coins and cache for 1 hour."""
    global _hl_coins_cache, _hl_coins_ts
    if _hl_coins_cache and _time_mod.time() - _hl_coins_ts < 3600:
        return _hl_coins_cache
    try:
        resp = _session.post(_HL_API, json={"type": "meta"}, timeout=10)
        resp.raise_for_status()
        universe = resp.json().get("universe", [])
        _hl_coins_cache = [
            {"symbol": u["name"], "name": u["name"], "category": "Crypto", "source": "hyperliquid"}
            for u in universe
        ]
        _hl_coins_ts = _time_mod.time()
    except Exception:
        pass  # return whatever was cached last
    return _hl_coins_cache


_YF_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"

def _yf_quote_to_dict(q: dict) -> dict | None:
    """Convert a Yahoo Finance search quote into our standard symbol dict."""
    symbol = q.get("symbol", "").strip()
    if not symbol:
        return None
    # Skip warrants, rights, notes, preferred shares
    q_type = q.get("quoteType", "")
    if q_type in ("OPTION", "WARRANT", "RIGHT", "NOTE"):
        return None

    name     = (q.get("shortname") or q.get("longname") or symbol).strip()
    exchange = q.get("exchDisp", "")
    type_dis = q.get("typeDisp", "")

    # Categorise by exchange / suffix
    if symbol.endswith(".NS") or symbol.endswith(".BO"):
        if q_type == "INDEX":
            category, source = "India Indices", "yfinance"
        else:
            category = "India NSE" if symbol.endswith(".NS") else "India BSE"
            source   = "yfinance"
    elif symbol.startswith("^"):
        if any(x in exchange for x in ("NSE", "NSI", "BSE")):
            category, source = "India Indices", "yfinance"
        else:
            category, source = "US Indices", "yfinance_us"
    elif "=F" in symbol:
        category, source = "Commodities", "yfinance_us"
    elif "=X" in symbol:
        category, source = "Forex", "yfinance_us"
    elif exchange in ("NYSE", "NASDAQ", "NYSEArca", "NGM", "NMS", "PCX"):
        category, source = "US Stocks", "yfinance_us"
    elif ".L" in symbol:
        category, source = "UK Stocks", "yfinance_us"
    elif ".DE" in symbol or ".F" in symbol:
        category, source = "German Stocks", "yfinance_us"
    else:
        category = exchange or type_dis or "Other"
        source   = "yfinance_us"

    return {"symbol": symbol, "name": name, "category": category, "source": source}


def search_symbols_yfinance(q: str, max_results: int = 25) -> list[dict]:
    """Search Yahoo Finance for any ticker matching q (live API call)."""
    params = {
        "q":           q,
        "quotesCount": max_results,
        "newsCount":   0,
        "enableFuzzyQuery": "true",
        "enableEnhancedTrivialQuery": "true",
    }
    try:
        resp = _session.get(_YF_SEARCH_URL, params=params, timeout=8)
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
        results = []
        for quote in quotes:
            d = _yf_quote_to_dict(quote)
            if d:
                results.append(d)
        return results
    except Exception:
        return []


def search_symbols_hyperliquid(q: str) -> list[dict]:
    """Search Hyperliquid coins by symbol name."""
    coins = _get_hl_coins()
    q_up  = q.upper()
    # Exact starts-with first, then contains
    starts = [c for c in coins if c["symbol"].upper().startswith(q_up)]
    contains = [c for c in coins if q_up in c["symbol"].upper() and not c["symbol"].upper().startswith(q_up)]
    return (starts + contains)[:25]
