import asyncio
import hmac
import logging
import math
import os
import sys
import threading
import uuid
from datetime import datetime, time, timedelta
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
watchdog_task: asyncio.Task | None = None
scheduler_started_at: datetime | None = None
last_sleep_event_date: str | None = None
scheduler_heartbeat = {
    "lastTickAt": None,
    "lastTickResult": "sleeping",
    "consecutiveErrors": 0,
}
SCHEDULER_HEARTBEAT_INTERVAL_SECONDS = 15


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


def authorized(request: Request) -> bool:
    secret = os.getenv("WORKER_RUN_SECRET", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    supplied = authorization.removeprefix("Bearer ").strip()
    return bool(secret and supplied and hmac.compare_digest(secret, supplied))


def lease_result_for_worker_status(status: str | None, successful: bool) -> str:
    if status == "sleeping":
        return "sleeping"
    if status == "overlap_skipped":
        return "busy"
    if status == "cadence_skipped":
        return "cooldown"
    if successful and status == "paper_decisions_ready":
        return "acquired"
    return "error"


async def post_worker_run(client: httpx.AsyncClient, candidates: list[dict], current_scan: str, trigger_source: str, scan_started_at: str | None = None) -> dict:
    url = f"{vercel_worker_url()}/api/worker/run"
    headers = {
        "Authorization": f"Bearer {os.getenv('WORKER_RUN_SECRET', '').strip()}",
        "Content-Type": "application/json",
        "X-Scan-ID": current_scan,
        "X-Trigger-Source": trigger_source,
    }
    payload = {"candidates": candidates, "notify": False, "scanId": current_scan, "scanStartedAt": scan_started_at, "triggerSource": trigger_source}

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
                "leaseResult": lease_result_for_worker_status(
                    body.get("status") if isinstance(body, dict) else None,
                    response.is_success,
                ),
                "symbolCount": len(candidates),
                "rowsWritten": body.get("scanRowsWritten", 0) if isinstance(body, dict) else 0,
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

    result = await post_worker_run(client, [], str(uuid.uuid4()), "railway-scheduler")
    if result.get("status") == "sent":
        last_sleep_event_date = event_date
    return result


async def send_scan(trigger_source: str = "railway-scheduler") -> dict:
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
                current_scan = scan_data.get("scanId")
                if not isinstance(current_scan, str) or not current_scan:
                    current_scan = str(uuid.uuid4())
                scan_started_at = scan_data.get("scanStartedAt")
                return await post_worker_run(
                    client,
                    candidates,
                    current_scan,
                    trigger_source,
                    scan_started_at if isinstance(scan_started_at, str) else None,
                )
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
        "deploySha": os.getenv("RAILWAY_GIT_COMMIT_SHA") or None,
        "missing": missing,
        "workerUrlConfigured": bool(upstream_url),
        "scanWindow": "07:00-15:55 America/New_York",
        "scanIntervalSeconds": scan_interval_seconds(now),
        "lastTickAt": scheduler_heartbeat["lastTickAt"],
        "lastTickResult": scheduler_heartbeat["lastTickResult"],
        "consecutiveErrors": scheduler_heartbeat["consecutiveErrors"],
        "liveTradingEnabled": False,
    }, status_code=200 if not missing else 503)


@app.post("/api/run-once")
async def run_once(request: Request):
    if not authorized(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    return await send_scan("manual")


def scheduler_result(result: dict) -> str:
    lease_result = result.get("leaseResult")
    if lease_result in {"acquired", "busy", "cooldown", "sleeping", "error"}:
        return lease_result
    status = result.get("status")
    if status == "sleeping" or status == "sleep_event_already_sent":
        return "sleeping"
    if status == "overlap_skipped":
        return "busy"
    if status == "cadence_skipped":
        return "cooldown"
    return "error"


async def refresh_scheduler_heartbeat_during_tick():
    while True:
        await asyncio.sleep(SCHEDULER_HEARTBEAT_INTERVAL_SECONDS)
        scheduler_heartbeat["lastTickAt"] = datetime.now(ET).isoformat()


async def scheduler():
    while True:
        tick_started = datetime.now(ET)
        tick_started_monotonic = asyncio.get_running_loop().time()
        scheduler_heartbeat["lastTickAt"] = tick_started.isoformat()
        heartbeat_task = asyncio.create_task(refresh_scheduler_heartbeat_during_tick())
        result: dict = {}
        tick_result = "error"
        try:
            result = await send_scan()
            tick_result = scheduler_result(result)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("scheduler tick raised an exception")
            tick_result = "error"
        finally:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
            tick_completed = datetime.now(ET)
            duration_ms = max(0, round((asyncio.get_running_loop().time() - tick_started_monotonic) * 1000))
            scheduler_heartbeat["lastTickAt"] = tick_completed.isoformat()
            scheduler_heartbeat["lastTickResult"] = tick_result
            scheduler_heartbeat["consecutiveErrors"] = (
                scheduler_heartbeat["consecutiveErrors"] + 1 if tick_result == "error" else 0
            )
            symbol_count = result.get("symbolCount", 0)
            rows_written = result.get("rowsWritten", 0)
            log.info(
                "scheduler tick start=%s lease_result=%s symbol_count=%s rows_written=%s duration_ms=%d",
                tick_started.isoformat(),
                tick_result,
                symbol_count if isinstance(symbol_count, int) else 0,
                rows_written if isinstance(rows_written, int) else 0,
                duration_ms,
            )

        try:
            await asyncio.sleep(scan_interval_seconds())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("scheduler delay failed; retrying in one second")
            await asyncio.sleep(1)


def asyncio_exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    exception = context.get("exception")
    if exception is not None:
        log.critical(
            "unhandled asyncio exception: %s",
            context.get("message", "background task failed"),
            exc_info=(type(exception), exception, exception.__traceback__),
        )
    else:
        log.critical("unhandled asyncio exception: %s", context)


def install_process_exception_handlers() -> None:
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(asyncio_exception_handler)

    def uncaught_exception(exc_type, exc_value, exc_traceback):
        log.critical("uncaught process exception", exc_info=(exc_type, exc_value, exc_traceback))
        sys.__excepthook__(exc_type, exc_value, exc_traceback)

    def uncaught_thread_exception(args):
        log.critical(
            "uncaught thread exception in %s",
            args.thread.name if args.thread else "unknown thread",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )
        threading.__excepthook__(args)

    sys.excepthook = uncaught_exception
    threading.excepthook = uncaught_thread_exception


async def scheduler_watchdog():
    while True:
        await asyncio.sleep(15)
        now = datetime.now(ET)
        if not is_scan_window(now):
            continue

        heartbeat_at = scheduler_heartbeat["lastTickAt"]
        last_tick = datetime.fromisoformat(heartbeat_at) if heartbeat_at else scheduler_started_at
        if last_tick is None:
            continue
        stale_seconds = (now - last_tick).total_seconds()
        if stale_seconds > 90:
            log.critical("scheduler stalled stale_seconds=%.1f; exiting for Railway restart", stale_seconds)
            for handler in logging.getLogger().handlers:
                handler.flush()
            os._exit(1)


@app.on_event("startup")
async def start_scheduler():
    global scheduler_task, watchdog_task, scheduler_started_at
    install_process_exception_handlers()
    scheduler_started_at = datetime.now(ET)
    scheduler_task = asyncio.create_task(scheduler(), name="market-scan-scheduler")
    watchdog_task = asyncio.create_task(scheduler_watchdog(), name="market-scan-watchdog")


@app.on_event("shutdown")
async def stop_scheduler():
    tasks = [task for task in (scheduler_task, watchdog_task) if task is not None]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
