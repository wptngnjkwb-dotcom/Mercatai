from __future__ import annotations

import hashlib
from fastapi import APIRouter, HTTPException, Request, Depends, status
from db.client import get_supabase
from middleware.auth import require_auth
from models.agent import AgentRegisterRequest, AgentApproveRequest, AgentResponse
from services.avatarbook import verify_agent
from services.notifications import send_agent_approval_request, send_agent_approval_result
from services.embeddings import generate_embedding, agent_embedding_text
from config import settings

router = APIRouter(prefix="/agents", tags=["agents"])


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register_agent(request: Request, body: AgentRegisterRequest):
    db = get_supabase()

    # Check agent_id uniqueness
    existing = db.table("agents").select("id").eq("agent_id", body.agent_id).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail=f"Agent ID '{body.agent_id}' already registered")

    # Create or find owner org (minimal — full auth in Phase 2 uses JWT)
    org_result = db.table("organizations").insert({
        "name": f"org:{body.owner_email}",
        "verification_level": "anonymous",
    }).execute()
    org_id = org_result.data[0]["id"]

    # AvatarBook verification (async, non-blocking for registration)
    ab_result = await verify_agent(body.avatar_book_id, body.agent_id)

    # Generate embedding for matching engine
    text = agent_embedding_text({
        "display_name": body.display_name,
        "description": body.description,
        "capabilities": body.capabilities,
        "languages": body.languages,
    })
    embedding = generate_embedding(text)

    # Insert agent
    agent_data = {
        "agent_id": body.agent_id,
        "owner_org_id": org_id,
        "display_name": body.display_name,
        "description": body.description,
        "capabilities": body.capabilities,
        "languages": body.languages,
        "avatar_book_id": body.avatar_book_id,
        "monthly_spending_limit_eur": body.monthly_spending_limit_eur,
        "verification_level": "basic" if ab_result.verified else "anonymous",
        "is_approved": False,
        "is_active": True,
    }
    if embedding:
        agent_data["embedding"] = embedding

    agent_result = db.table("agents").insert(agent_data).execute()
    agent = agent_result.data[0]

    # Audit log
    db.table("audit_logs").insert({
        "agent_id": agent["id"],
        "action": "agent_registered",
        "resource_type": "agent",
        "resource_id": agent["id"],
        "details": {
            "agent_id": body.agent_id,
            "owner_email": body.owner_email,
            "avatar_book_verified": ab_result.verified,
            "capabilities": body.capabilities,
        },
        "reasoning_hash": hashlib.sha256(body.description.encode()).hexdigest(),
    }).execute()

    # Send approval email to owner
    approve_url = f"{settings.app_url}/api/v1/agents/{agent['id']}/approve"
    await send_agent_approval_request(
        owner_email=body.owner_email,
        agent_id=body.agent_id,
        agent_db_id=agent["id"],
        display_name=body.display_name,
        description=body.description,
        capabilities=body.capabilities,
        avatar_book_verified=ab_result.verified,
        approve_url=approve_url,
    )

    return {
        "id": agent["id"],
        "agent_id": body.agent_id,
        "is_approved": False,
        "avatar_book_verified": ab_result.verified,
        "message": f"Registration received. Approval email sent to {body.owner_email}.",
    }


@router.get("/{agent_db_id}", response_model=AgentResponse)
async def get_agent(agent_db_id: str):
    db = get_supabase()
    result = db.table("agents").select("*").eq("id", agent_db_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    a = result.data[0]
    return AgentResponse(
        id=a["id"],
        agent_id=a["agent_id"],
        display_name=a.get("display_name"),
        description=a.get("description"),
        capabilities=a.get("capabilities") or [],
        languages=a.get("languages") or [],
        verification_level=a.get("verification_level", "anonymous"),
        reputation_score=a.get("reputation_score", 50.0),
        tier=a.get("tier", 1),
        avatar_book_id=a.get("avatar_book_id"),
        free_tasks_remaining=a.get("free_tasks_remaining", 10),
        total_tasks_completed=a.get("total_tasks_completed", 0),
        success_rate=a.get("success_rate", 0.0),
        is_active=a.get("is_active", True),
        is_approved=a.get("is_approved", False),
        registered_at=a.get("registered_at"),
        last_seen_at=a.get("last_seen_at"),
    )


@router.put("/{agent_db_id}/approve", status_code=status.HTTP_200_OK)
async def approve_agent(
    agent_db_id: str,
    body: AgentApproveRequest,
    token: dict = Depends(require_auth),
):
    db = get_supabase()

    result = db.table("agents").select("*").eq("id", agent_db_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent = result.data[0]

    if agent.get("is_approved") and body.approved:
        raise HTTPException(status_code=409, detail="Agent already approved")

    db.table("agents").update({
        "is_approved": body.approved,
        "is_active": body.approved,
        "verification_level": "basic" if body.approved else "anonymous",
    }).eq("id", agent_db_id).execute()

    db.table("audit_logs").insert({
        "agent_id": agent_db_id,
        "user_id": token.get("sub"),
        "action": "agent_approved" if body.approved else "agent_rejected",
        "resource_type": "agent",
        "resource_id": agent_db_id,
        "details": {"approved": body.approved, "reason": body.reason},
    }).execute()

    # Notify agent owner (best-effort, we stored email in org name as org:email)
    org = db.table("organizations").select("name").eq("id", agent["owner_org_id"]).execute()
    if org.data:
        owner_email = org.data[0]["name"].removeprefix("org:")
        await send_agent_approval_result(
            owner_email=owner_email,
            display_name=agent.get("display_name", agent["agent_id"]),
            approved=body.approved,
            reason=body.reason,
        )

    return {
        "id": agent_db_id,
        "is_approved": body.approved,
        "message": "Agent approved and activated." if body.approved else "Agent rejected.",
    }


@router.get("/{agent_db_id}/tasks")
async def get_agent_tasks(agent_db_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    agent = db.table("agents").select("id, is_approved, tier").eq("id", agent_db_id).execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not agent.data[0].get("is_approved"):
        raise HTTPException(status_code=403, detail="Agent not approved yet")

    tasks = db.table("tasks").select("*").in_(
        "status", ["open", "bidding"]
    ).order("created_at", desc=True).limit(50).execute()

    return {"tasks": tasks.data, "total": len(tasks.data)}
