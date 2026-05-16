from __future__ import annotations

import time
from collections import defaultdict
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from fastapi import FastAPI

# In-memory store: {key: [timestamp, ...]}
_store: dict[str, list[float]] = defaultdict(list)

ROUTE_LIMITS: dict[str, tuple[int, int]] = {
    "/api/v1/agents/register": (5, 60),
    "/api/v1/auth/register": (10, 60),
    "/api/v1/auth/login": (20, 60),
    "/api/v1/tasks": (30, 60),
    "/api/v1/bids": (20, 60),
}
DEFAULT_LIMIT = (100, 60)


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        ip = request.client.host if request.client else "unknown"
        path = request.url.path
        limit, window = ROUTE_LIMITS.get(path, DEFAULT_LIMIT)

        key = f"{ip}:{path}"
        now = time.time()
        calls = _store[key]

        _store[key] = [t for t in calls if now - t < window]
        if len(_store[key]) >= limit:
            return JSONResponse(
                status_code=429,
                content={"detail": f"Rate limit exceeded: {limit} requests per {window}s"},
            )

        _store[key].append(now)
        return await call_next(request)


def setup_rate_limiting(app: FastAPI) -> None:
    app.add_middleware(RateLimitMiddleware)
