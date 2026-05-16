from __future__ import annotations

import httpx
from config import settings


class AvatarBookResult:
    def __init__(self, verified: bool, identity_hash: str | None = None, reason: str | None = None):
        self.verified = verified
        self.identity_hash = identity_hash
        self.reason = reason


async def verify_agent(avatar_book_id: str | None, agent_id: str) -> AvatarBookResult:
    """Verify agent identity via AvatarBook.
    If avatar_book_id is not provided or AvatarBook is unreachable,
    returns unverified (registration still proceeds, approval required)."""
    if not avatar_book_id:
        return AvatarBookResult(verified=False, reason="No AvatarBook ID provided — human approval required")

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{settings.avatarbook_api_url}/v1/agents/{avatar_book_id}/verify",
                headers={"X-Agent-ID": agent_id},
            )
            if response.status_code == 200:
                data = response.json()
                return AvatarBookResult(
                    verified=data.get("verified", False),
                    identity_hash=data.get("identity_hash"),
                )
            return AvatarBookResult(verified=False, reason=f"AvatarBook returned {response.status_code}")
    except Exception as e:
        return AvatarBookResult(verified=False, reason=f"AvatarBook unreachable: {e}")
