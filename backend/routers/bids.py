from __future__ import annotations

import hashlib
from fastapi import APIRouter, HTTPException, Depends, status
from db.client import get_supabase
from middleware.auth import require_auth
from models.bid import BidCreateRequest, BidResponse
from services.matching import score_bid
from services.notifications import send_bid_notification

router = APIRouter(prefix="/bids", tags=["bids"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=BidResponse)
async def submit_bid(body: BidCreateRequest, token: dict = Depends(require_auth)):
    agent_id = token.get("agent_id")
    if not agent_id:
        raise HTTPException(status_code=403, detail="Agent token required to bid")
    db = get_supabase()

    # Load agent
    agent_result = db.table("agents").select(
        "id, is_approved, is_active, reputation_score, embedding, free_tasks_remaining, tier"
    ).eq("id", agent_id).execute()
    if not agent_result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent = agent_result.data[0]

    if not agent.get("is_approved"):
        raise HTTPException(status_code=403, detail="Agent not approved yet")
    if not agent.get("is_active"):
        raise HTTPException(status_code=403, detail="Agent is inactive")

    # Load task
    task_result = db.table("tasks").select("*").eq("id", body.task_id).execute()
    if not task_result.data:
        raise HTTPException(status_code=404, detail="Task not found")
    task = task_result.data[0]

    if task["status"] not in ("open", "bidding"):
        raise HTTPException(status_code=409, detail=f"Task is '{task['status']}' — bidding closed")

    if body.price_eur > (task.get("budget_max_eur") or float("inf")):
        raise HTTPException(
            status_code=422,
            detail=f"Bid price €{body.price_eur} exceeds task budget max €{task.get('budget_max_eur')}",
        )

    # Check duplicate bid
    existing = db.table("bids").select("id").eq("task_id", body.task_id).eq("agent_id", agent_id).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Agent already submitted a bid for this task")

    # Score the bid
    computed_score = score_bid(
        agent_reputation=agent.get("reputation_score", 50.0),
        agent_embedding=agent.get("embedding"),
        task_embedding=task.get("embedding"),
        bid_price=body.price_eur,
        task_budget_max=float(task.get("budget_max_eur") or 0),
        bid_delivery_hours=body.delivery_hours,
        task_deadline_hours=int(task.get("deadline_hours") or 1),
    )

    bid_result = db.table("bids").insert({
        "task_id": body.task_id,
        "agent_id": agent_id,
        "price_eur": body.price_eur,
        "delivery_hours": body.delivery_hours,
        "approach_summary": body.approach_summary,
        "score": round(computed_score, 4),
        "status": "pending",
    }).execute()
    bid = bid_result.data[0]

    # Move task to bidding state
    if task["status"] == "open":
        db.table("tasks").update({"status": "bidding"}).eq("id", body.task_id).execute()

    db.table("audit_logs").insert({
        "agent_id": agent_id,
        "action": "bid_submitted",
        "resource_type": "bid",
        "resource_id": bid["id"],
        "details": {
            "task_id": body.task_id,
            "price_eur": body.price_eur,
            "score": round(computed_score, 4),
        },
        "reasoning_hash": hashlib.sha256(body.approach_summary.encode()).hexdigest(),
    }).execute()

    # Notify task owner (best-effort)
    try:
        org = db.table("organizations").select("name").eq(
            "id", task["posted_by_org_id"]
        ).execute()
        if org.data:
            owner_email = org.data[0]["name"].removeprefix("org:")
            await send_bid_notification(
                owner_email=owner_email,
                task_title=task["title"],
                agent_name=agent.get("display_name", agent_id),
                price_eur=body.price_eur,
                delivery_hours=body.delivery_hours,
                task_id=body.task_id,
            )
    except Exception:
        pass

    return BidResponse(
        id=bid["id"],
        task_id=bid["task_id"],
        agent_id=bid["agent_id"],
        price_eur=bid["price_eur"],
        delivery_hours=bid["delivery_hours"],
        approach_summary=bid.get("approach_summary"),
        score=bid.get("score"),
        status=bid["status"],
        submitted_at=bid.get("submitted_at"),
    )


@router.put("/{bid_id}/accept", status_code=status.HTTP_200_OK)
async def accept_bid(bid_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    bid_result = db.table("bids").select("*").eq("id", bid_id).execute()
    if not bid_result.data:
        raise HTTPException(status_code=404, detail="Bid not found")
    bid = bid_result.data[0]

    task_result = db.table("tasks").select("*").eq("id", bid["task_id"]).execute()
    if not task_result.data:
        raise HTTPException(status_code=404, detail="Task not found")
    task = task_result.data[0]

    if task["posted_by_org_id"] != token.get("org_id"):
        raise HTTPException(status_code=403, detail="Only the task buyer can accept bids")
    if task["status"] not in ("open", "bidding"):
        raise HTTPException(status_code=409, detail="Task is no longer accepting bid decisions")

    # Accept this bid, reject all others
    db.table("bids").update({"status": "accepted"}).eq("id", bid_id).execute()
    db.table("bids").update({"status": "rejected"}).eq("task_id", bid["task_id"]).neq("id", bid_id).execute()

    # Assign task to agent
    db.table("tasks").update({
        "status": "assigned",
        "assigned_agent_id": bid["agent_id"],
    }).eq("id", bid["task_id"]).execute()

    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "bid_accepted",
        "resource_type": "bid",
        "resource_id": bid_id,
        "details": {"task_id": bid["task_id"], "agent_id": bid["agent_id"], "price_eur": bid["price_eur"]},
    }).execute()

    return {
        "bid_id": bid_id,
        "task_id": bid["task_id"],
        "agent_id": bid["agent_id"],
        "status": "accepted",
        "message": "Bid accepted. Task assigned to agent. Proceed to payment to start work.",
    }


@router.put("/{bid_id}/reject", status_code=status.HTTP_200_OK)
async def reject_bid(bid_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    bid_result = db.table("bids").select("*").eq("id", bid_id).execute()
    if not bid_result.data:
        raise HTTPException(status_code=404, detail="Bid not found")
    bid = bid_result.data[0]

    task_result = db.table("tasks").select("posted_by_org_id").eq("id", bid["task_id"]).execute()
    if not task_result.data or task_result.data[0]["posted_by_org_id"] != token.get("org_id"):
        raise HTTPException(status_code=403, detail="Only the task buyer can reject bids")

    db.table("bids").update({"status": "rejected"}).eq("id", bid_id).execute()

    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "bid_rejected",
        "resource_type": "bid",
        "resource_id": bid_id,
        "details": {"task_id": bid["task_id"]},
    }).execute()

    return {"bid_id": bid_id, "status": "rejected"}
