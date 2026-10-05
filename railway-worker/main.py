import asyncio
import hashlib
import json
import logging
import os
import uuid
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("aitrading-worker")
app = FastAPI(title="aitrading Railway worker")
ET = ZoneInfo("America/New_York")
scan_lock = asyncio.Lock()


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def is_common_stock_symbol(symbol: str) -> bool:
    return symbol.isalpha() and 1 <= len(symbol) <= 5 and not symbol.endswith(("W", "U"))


def supplemental_symbols() -> list[str]:
    return sorted({symbol for value in os.getenv("WATCHLIST_SYMBOLS", "").split(",") if (symbol := value.strip().upper()) and is_common_stock_symbol(symbol)})


async def discover_symbols(client: httpx.AsyncClient) -> list[str]:
    headers = {"APCA-API-KEY-ID": required("ALPACA_API_KEY"), "APCA-API-SECRET-KEY": required("ALPACA_API_SECRET")}
    data_url = required("ALPACA_DATA_URL").rstrip("/")
    try:
        response = await client.get(f"{data_url}/v1beta1/screener/stocks/movers", params={"top": int(os.getenv("MOVER_TOP", "50"))}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        movers = payload.get("gainers", []) + payload.get("losers", [])
        discovered = [symbol for item in movers if (symbol := item.get("symbol", "").strip().upper()) and is_common_stock_symbol(symbol)]
        combined = sorted(set(discovered + supplemental_symbols()))
        if combined:
            log.info("discovered=%d movers=%d supplemental=%d", len(combined), len(discovered), len(supplemental_symbols()))
            return combined
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("dynamic mover discovery failed; using supplemental watchlist: %s", exc)
    fallback = supplemental_symbols()
    if not fallback:
        raise RuntimeError("Mover discovery failed and WATCHLIST_SYMBOLS is empty")
    return fallback


def in_scan_window() -> bool:
    now = datetime.now(ET).time()
    return time(7, 0) <= now < time(15, 55)


def scan_interval_seconds() -> int:
    now = datetime.now(ET).time()
    minutes = now.hour * 60 + now.minute
    if minutes < 8 * 60:
        return 300
    if minutes < 9 * 60 + 30:
        return 600
    if minutes < 11 * 60:
        return 300
    if minutes < 13 * 60:
        return 900
    if minutes < 15 * 60 + 30:
        return 600
    return 30


def scan_id(symbol_list: list[str]) -> str:
    bucket = int(datetime.now(timezone.utc).timestamp()) // 300
    return hashlib.sha256(f"{bucket}:{','.join(symbol_list)}".encode()).hexdigest()[:24]


async def get_float(client: httpx.AsyncClient, symbol: str) -> tuple[float | None, str | None]:
    fmp = await client.get("https://financialmodelingprep.com/stable/profile", params={"symbol": symbol, "apikey": required("FMP_API_KEY")})
    if fmp.is_success:
        rows = fmp.json()
        row = rows[0] if isinstance(rows, list) and rows else rows if isinstance(rows, dict) else {}
        value = row.get("floatShares") or row.get("float") or row.get("sharesOutstanding")
        if isinstance(value, (int, float)) and value > 0:
            return float(value), "fmp"
    finnhub = await client.get("https://finnhub.io/api/v1/stock/profile2", params={"symbol": symbol, "token": required("FINNHUB_API_KEY")})
    if finnhub.is_success:
        value = finnhub.json().get("floatingShare")
        if isinstance(value, (int, float)) and value > 0:
            return float(value) * 1_000_000, "finnhub"
    return None, None


async def build_candidates(client: httpx.AsyncClient) -> tuple[list[dict], list[str]]:
    symbol_list = await discover_symbols(client)
    base = required("ALPACA_DATA_URL").rstrip("/")
    response = await client.get(f"{base}/v2/stocks/snapshots", params={"symbols": ",".join(symbol_list), "feed": os.getenv("ALPACA_DATA_FEED", "iex")}, headers={"APCA-API-KEY-ID": required("ALPACA_API_KEY"), "APCA-API-SECRET-KEY": required("ALPACA_API_SECRET")})
    response.raise_for_status()
    snapshots = response.json()
    candidates = []
    for symbol in symbol_list:
        snapshot = snapshots.get(symbol) or {}
        daily = snapshot.get("dailyTradeBar") or {}
        previous = snapshot.get("prevDailyBar") or {}
        quote = snapshot.get("latestQuote") or {}
        price = float((snapshot.get("latestTrade") or {}).get("p") or daily.get("c") or 0)
        volume = float(daily.get("v") or 0)
        average_volume = float(previous.get("v") or 0)
        if price <= 0:
            continue
        float_shares, float_source = await get_float(client, symbol)
        change = ((price - float(previous.get("c") or price)) / float(previous.get("c") or price)) * 100
        candidates.append({"symbol": symbol, "price": price, "bid": quote.get("bp"), "ask": quote.get("ap"), "volume": volume, "averageVolume": average_volume or None, "float": float_shares, "floatSource": float_source, "changePercent": change, "vwap": daily.get("vw"), "atr": None, "hasNews": False, "socialScore": 0})
    return candidates, symbol_list


async def send_scan() -> dict:
    if not in_scan_window():
        return {"status": "sleeping"}
    if scan_lock.locked():
        return {"status": "overlap_skipped"}
    async with scan_lock:
        async with httpx.AsyncClient(timeout=20) as client:
            candidates, symbol_list = await build_candidates(client)
            current_scan = scan_id(symbol_list)
            payload = {"candidates": candidates, "notify": True}
            url = required("VERCEL_WORKER_URL").rstrip("/") + "/api/worker/run"
            headers = {"Authorization": f"Bearer {required('WORKER_RUN_SECRET')}", "Content-Type": "application/json", "X-Scan-ID": current_scan}
            for attempt in range(3):
                try:
                    response = await client.post(url, headers=headers, json=payload)
                    if response.status_code == 401:
                        log.error("Worker rejected secret; stopping this scan")
                        return {"status": "unauthorized"}
                    if response.status_code == 503 and attempt < 2:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    body = response.json()
                    log.info("scan_id=%s response=%s", current_scan, body)
                    return {"status": "sent", "scan_id": current_scan, "response": body}
                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    if attempt == 2:
                        log.error("scan_id=%s failed: %s", current_scan, exc)
                        return {"status": "failed", "scan_id": current_scan}
                    await asyncio.sleep(2 ** attempt)
            return {"status": "failed", "scan_id": current_scan}


@app.get("/api/health")
async def health():
    required_names = ["ALPACA_API_KEY", "ALPACA_API_SECRET", "ALPACA_DATA_URL", "FMP_API_KEY", "FINNHUB_API_KEY", "VERCEL_WORKER_URL", "WORKER_RUN_SECRET"]
    missing = [name for name in required_names if not os.getenv(name, "").strip()]
    return JSONResponse({"ok": not missing, "service": "aitrading-worker", "missing": missing, "scanWindow": "07:00-15:55 America/New_York", "intervalSeconds": scan_interval_seconds(), "entryMonitorSeconds": 10}, status_code=200 if not missing else 503)


@app.post("/api/run-once")
async def run_once():
    return await send_scan()


async def scheduler():
    while True:
        try:
            result = await send_scan()
            log.info("scheduler result=%s", result)
        except Exception:
            log.exception("scheduler iteration failed")
        await asyncio.sleep(scan_interval_seconds())


@app.on_event("startup")
async def start_scheduler():
    asyncio.create_task(scheduler())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
