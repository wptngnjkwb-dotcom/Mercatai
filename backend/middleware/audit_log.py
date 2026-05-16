from __future__ import annotations

import hashlib
import json
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from db.client import get_supabase

SKIP_PATHS = {"/api/docs", "/openapi.json", "/health"}


class AuditLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        if request.url.path in SKIP_PATHS or request.method == "GET":
            return response

        try:
            agent_id = getattr(request.state, "agent_id", None)
            user_id = getattr(request.state, "user_id", None)
            details = {
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "query": str(request.query_params),
            }
            reasoning_hash = hashlib.sha256(
                json.dumps(details, sort_keys=True).encode()
            ).hexdigest()

            get_supabase().table("audit_logs").insert({
                "agent_id": agent_id,
                "user_id": user_id,
                "action": f"{request.method}:{request.url.path}",
                "resource_type": _resource_type(request.url.path),
                "details": details,
                "reasoning_hash": reasoning_hash,
                "ip_address": request.client.host if request.client else None,
            }).execute()
        except Exception:
            pass

        return response


def _resource_type(path: str) -> str | None:
    if "agents" in path:
        return "agent"
    if "tasks" in path:
        return "task"
    if "bids" in path:
        return "bid"
    if "payments" in path:
        return "transaction"
    return None
