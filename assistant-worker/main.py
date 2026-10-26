"""Assistant-mode Railway service (docs/assistant-mode-spec.md). SEPARATE from E's scheduler (railway-worker/).

It only calls the assistant's own Vercel routes and reads Alpaca's market-data stream. It never places, changes or
cancels an order, and it never calls E's /api/worker/run or /api/scan.
- every 15 s, 07:00-11:00 ET on weekdays: POST /api/assistant/alerts (push notifications for filter matches)
- every 5 min, 04:00-20:00 ET on weekdays, and once at 20:05: POST /api/assistant/import (manual fills, limits)
- Alpaca market-data stream, trading-status channel: halts and resumptions -> POST /api/assistant/halts
"""
import asyncio
import json
import logging
import os
from datetime import datetime, time
from zoneinfo import ZoneInfo

import httpx
import websockets
from fastapi import FastAPI
from fastapi.responses import JSONResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("assistant-worker")
app = FastAPI(title="aitrading assistant worker (no orders)")
ET = ZoneInfo("America/New_York")
state = {"alerts": None, "import": None, "stream": "not started", "haltsSent": 0, "errors": 0}
tasks: list[asyncio.Task] = []

# Alpaca trading-status codes: H = halted, T = trading; reason LUDP = limit-up/limit-down pause
HALT_CODES = {"H": "halted", "T": "resumed"}


def base_url() -> str:
    value = os.getenv("VERCEL_WORKER_URL", "https://hooyah-aitrading.vercel.app").strip().rstrip("/")  # existing name
    if not value.startswith("https://"):
        raise RuntimeError("VERCEL_WORKER_URL must be an https URL")
    return value


def headers() -> dict:
    secret = os.getenv("WORKER_RUN_SECRET", "").strip()  # existing secret, reused
    if not secret:
        raise RuntimeError("WORKER_RUN_SECRET is not set")
    return {"authorization": f"Bearer {secret}", "content-type": "application/json"}


def weekday(now: datetime) -> bool:
    return now.weekday() < 5


def in_window(now: datetime, start: time, end: time) -> bool:
    return weekday(now) and start <= now.time() < end


def map_status(msg: dict) -> dict | None:
    """One Alpaca status message (T == 's') -> a halts row, or None."""
    if msg.get("T") != "s" or not msg.get("S"):
        return None
    code = str(msg.get("sc") or "")
    reason = str(msg.get("rc") or msg.get("rm") or "")
    status = "luld" if "LUD" in reason.upper() and code != "T" else HALT_CODES.get(code)
    if not status:
        return None
    return {"symbol": msg["S"], "status": status, "reason": (msg.get("sm") or reason or code)[:120], "at": msg.get("t") or datetime.now(ET).isoformat()}


async def post(client: httpx.AsyncClient, path: str, payload: dict | None = None) -> dict:
    response = await client.post(f"{base_url()}{path}", headers=headers(), json=payload or {})
    return {"status": response.status_code, "body": response.text[:300]}


async def alerts_loop():
    async with httpx.AsyncClient(timeout=50) as client:
        while True:
            now = datetime.now(ET)
            if in_window(now, time(7, 0), time(11, 0)):
                try:
                    state["alerts"] = {"at": now.isoformat(), **(await post(client, "/api/assistant/alerts"))}
                except Exception as exc:  # noqa: BLE001 - keep the loop alive
                    state["errors"] += 1
                    log.warning("alerts failed: %s", exc)
                await asyncio.sleep(15 - datetime.now(ET).second % 15)
            else:
                await asyncio.sleep(30)


async def import_loop():
    async with httpx.AsyncClient(timeout=50) as client:
        last_evening: str | None = None
        while True:
            now = datetime.now(ET)
            evening_due = weekday(now) and now.time() >= time(20, 5) and last_evening != now.date().isoformat()
            if in_window(now, time(4, 0), time(20, 0)) or evening_due:
                try:
                    state["import"] = {"at": now.isoformat(), **(await post(client, "/api/assistant/import"))}
                    if evening_due:
                        last_evening = now.date().isoformat()
                except Exception as exc:  # noqa: BLE001
                    state["errors"] += 1
                    log.warning("import failed: %s", exc)
            await asyncio.sleep(300)


async def halt_stream():
    key = os.getenv("ALPACA_MANUAL_KEY", "").strip()
    secret = os.getenv("ALPACA_MANUAL_SECRET", "").strip()
    feed = "sip"
    if not key or not secret:
        state["stream"] = "no stream keys; halts fall back to the inferred status"
        return
    buffer: list[dict] = []
    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            now = datetime.now(ET)
            if not in_window(now, time(4, 0), time(20, 0)):
                state["stream"] = "sleeping"
                await asyncio.sleep(60)
                continue
            try:
                async with websockets.connect(f"wss://stream.data.alpaca.markets/v2/{feed}", ping_interval=20) as ws:
                    await ws.send(json.dumps({"action": "auth", "key": key, "secret": secret}))
                    await ws.send(json.dumps({"action": "subscribe", "statuses": ["*"]}))
                    state["stream"] = "connected"
                    while in_window(datetime.now(ET), time(4, 0), time(20, 0)):
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=5)
                            for msg in json.loads(raw):
                                if msg.get("T") == "error":
                                    state["stream"] = f"error {msg.get('code')}: {msg.get('msg')}"
                                    log.warning("stream error: %s", msg)
                                row = map_status(msg)
                                if row:
                                    buffer.append(row)
                        except asyncio.TimeoutError:
                            pass
                        if buffer:
                            rows, buffer = buffer[:500], buffer[500:]
                            await post(client, "/api/assistant/halts", {"rows": rows})
                            state["haltsSent"] += len(rows)
            except Exception as exc:  # noqa: BLE001 - reconnect after a pause
                state["stream"] = f"reconnecting after: {str(exc)[:120]}"
                await asyncio.sleep(15)


@app.on_event("startup")
async def start():
    tasks.extend([asyncio.create_task(alerts_loop()), asyncio.create_task(import_loop()), asyncio.create_task(halt_stream())])


@app.get("/health")
async def health():
    missing = [name for name in ("WORKER_RUN_SECRET", "ALPACA_MANUAL_KEY", "ALPACA_MANUAL_SECRET") if not os.getenv(name, "").strip()]
    return JSONResponse({"ok": not missing, "service": "assistant-worker", "placesOrders": False, "missing": missing, **state}, status_code=200 if not missing else 503)
