import asyncio
import hashlib
import hmac
import logging
import math
import os
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("aitrading-worker")
app = FastAPI(title="aitrading Railway worker")
ET = ZoneInfo("America/New_York")
DEFAULT_VERCEL_WORKER_URL = "https://hooyah-aitrading.vercel.app"
scan_lock = asyncio.Lock()
scheduler_task: asyncio.Task | None = None
last_sleep_event_date: str | None = None


def vercel_worker_url() -> str:
    value = os.getenv("VERCEL_WORKER_URL", DEFAULT_VERCEL_WORKER_URL).strip().rstrip("/")
    if not value.startswith(("https://", "http://")):
        raise RuntimeError("VERCEL_WORKER_URL must be an HTTP(S) URL")
    return value


def is_scan_window(now: datetime | None = None) -> bool:
    current = (now or datetime.now(ET)).astimezone(ET)
    return current.weekday() < 5 and time(7, 0) <= current.time() < time(15, 55)


def is_sleep_event_window(now: datetime | None = None) -> bool:
    current = (now or datetime.now(ET)).astimezone(ET)
    return current.weekday() < 5 and time(15, 55) <= current.time() < time(16, 0)


def next_market_open(now: datetime) -> datetime:
    current = now.astimezone(ET)
    target = current.replace(hour=7, minute=0, second=0, microsecond=0)
    if current.weekday() < 5 and current < target:
        return target

    target = (current + timedelta(days=1)).replace(hour=7, minute=0, second=0, microsecond=0)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    return target


def scan_interval_seconds(now: datetime | None = None) -> int:
    current = (now or datetime.now(ET)).astimezone(ET)
    if is_scan_window(current):
        period = 15 if current.time() < time(11, 0) else 30
    elif is_sleep_event_window(current):
        period = 15
    else:
        return max(15, min(3600, math.ceil((next_market_open(current) - current).total_seconds())))

    elapsed_in_period = current.second + current.microsecond / 1_000_000
    return max(1, math.ceil(period - elapsed_in_period % period))


def scan_id(candidates: list[dict]) -> str:
    bucket = int(datetime.now(timezone.utc).timestamp()) // 30
    symbols = ",".join(sorted(str(candidate.get("symbol", "")) for candidate in candidates))
    return hashlib.sha256(f"{bucket}:{symbols}".encode()).hexdigest()[:24]


def authorized(request: Request) -> bool:
    secret = os.getenv("WORKER_RUN_SECRET", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    supplied = authorization.removeprefix("Bearer ").strip()
    return bool(secret and supplied and hmac.compare_digest(secret, supplied))


async def post_worker_run(client: httpx.AsyncClient, candidates: list[dict], current_scan: str) -> dict:
    url = f"{vercel_worker_url()}/api/worker/run"
    headers = {
        "Authorization": f"Bearer {os.getenv('WORKER_RUN_SECRET', '').strip()}",
        "Content-Type": "application/json",
        "X-Scan-ID": current_scan,
    }
    payload = {"candidates": candidates, "notify": False}

    for attempt in range(3):
        try:
            response = await client.post(url, headers=headers, json=payload)
            body = response.json() if response.content else {}
            if response.status_code == 401:
                log.error("worker endpoint rejected the configured shared secret")
                return {"status": "unauthorized", "httpStatus": response.status_code}
            if response.status_code >= 500 and attempt < 2:
                await asyncio.sleep(2 ** attempt)
                continue
            result = {
                "status": "sent" if response.is_success else "worker_failed",
                "scan_id": current_scan,
                "httpStatus": response.status_code,
                "workerStatus": body.get("status") if isinstance(body, dict) else None,
            }
            log.info("scan_id=%s worker_status=%s http_status=%d", current_scan, result["workerStatus"], response.status_code)
            return result
        except (httpx.TimeoutException, httpx.NetworkError, ValueError) as exc:
            if attempt == 2:
                log.error("scan_id=%s worker request failed: %s", current_scan, exc)
                return {"status": "failed", "scan_id": current_scan}
            await asyncio.sleep(2 ** attempt)

    return {"status": "failed", "scan_id": current_scan}


async def send_sleep_event(client: httpx.AsyncClient, now: datetime) -> dict:
    global last_sleep_event_date
    event_date = now.astimezone(ET).date().isoformat()
    if last_sleep_event_date == event_date:
        return {"status": "sleep_event_already_sent"}

    result = await post_worker_run(client, [], f"{event_date}-sleep")
    if result.get("status") == "sent":
        last_sleep_event_date = event_date
    return result


async def send_scan() -> dict:
    now = datetime.now(ET)
    in_session = is_scan_window(now)
    if not in_session and not is_sleep_event_window(now):
        return {"status": "sleeping"}
    if scan_lock.locked():
        return {"status": "overlap_skipped"}

    async with scan_lock:
        async with httpx.AsyncClient(timeout=25) as client:
            if not in_session:
                return await send_sleep_event(client, now)

            try:
                response = await client.get(f"{vercel_worker_url()}/api/scan", params={"top": 25})
                if not response.is_success:
                    log.warning("market scan endpoint returned %d", response.status_code)
                    return {"status": "scan_failed", "httpStatus": response.status_code}
                scan_data = response.json()
                if scan_data.get("sleeping"):
                    return {"status": "sleeping"}
                raw_candidates = scan_data.get("candidates", [])
                candidates = [item for item in raw_candidates if isinstance(item, dict)] if isinstance(raw_candidates, list) else []
                return await post_worker_run(client, candidates, scan_id(candidates))
            except (httpx.TimeoutException, httpx.NetworkError, ValueError) as exc:
                log.error("market scan request failed: %s", exc)
                return {"status": "scan_failed"}


@app.get("/health")
async def liveness():
    return {"ok": True, "service": "aitrading-worker"}


@app.get("/api/health")
async def health():
    missing = []
    if not os.getenv("WORKER_RUN_SECRET", "").strip():
        missing.append("WORKER_RUN_SECRET")
    try:
        upstream_url = vercel_worker_url()
    except RuntimeError:
        upstream_url = ""
        missing.append("VERCEL_WORKER_URL")
    now = datetime.now(ET)
    return JSONResponse({
        "ok": not missing,
        "ready": not missing,
        "service": "aitrading-worker",
        "missing": missing,
        "workerUrlConfigured": bool(upstream_url),
        "scanWindow": "07:00-15:55 America/New_York",
        "scanIntervalSeconds": scan_interval_seconds(now),
        "liveTradingEnabled": False,
    }, status_code=200 if not missing else 503)


@app.post("/api/run-once")
async def run_once(request: Request):
    if not authorized(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
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
    global scheduler_task
    scheduler_task = asyncio.create_task(scheduler())


@app.on_event("shutdown")
async def stop_scheduler():
    if scheduler_task is not None:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
