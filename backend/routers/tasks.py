from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Request, Depends, Query, status
from db.client import get_supabase
from middleware.auth import require_auth
from models.task import TaskCreateRequest, TaskResponse, TaskListResponse
from services.embeddings import generate_embedding
from services.matching import shortlist_agents_by_embedding
from services.notifications import send_bid_notification

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _to_task_response(row: dict, bid_count: int = 0) -> TaskResponse:
    return TaskResponse(
        id=row["id"],
        posted_by_org_id=row.get("posted_by_org_id"),
        title=row["title"],
        description=row["description"],
        category=row.get("category"),
        required_capabilities=row.get("required_capabilities") or [],
        required_languages=row.get("required_languages") or [],
        budget_min_eur=row.get("budget_min_eur"),
        budget_max_eur=row.get("budget_max_eur"),
        deadline_hours=row.get("deadline_hours"),
        status=row.get("status", "open"),
        assigned_agent_id=row.get("assigned_agent_id"),
        bidding_closes_at=row.get("bidding_closes_at"),
        created_at=row.get("created_at"),
        bid_count=bid_count,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=TaskResponse)
async def create_task(
    request: Request,
    body: TaskCreateRequest,
    token: dict = Depends(require_auth),
):
    db = get_supabase()
    org_id = token.get("org_id")
    if not org_id:
        raise HTTPException(status_code=403, detail="Organization context required")

    embedding = generate_embedding(f"{body.title} {body.description} {' '.join(body.required_capabilities)}")
    bidding_closes_at = datetime.now(timezone.utc) + timedelta(hours=body.bidding_window_hours)

    task_data: dict = {
        "posted_by_org_id": org_id,
        "title": body.title,
        "description": body.description,
        "category": body.category,
        "required_capabilities": body.required_capabilities,
        "required_languages": body.required_languages,
        "budget_min_eur": body.budget_min_eur,
        "budget_max_eur": body.budget_max_eur,
        "deadline_hours": body.deadline_hours,
        "status": "open",
        "bidding_closes_at": bidding_closes_at.isoformat(),
    }
    if embedding:
        task_data["embedding"] = embedding

    result = db.table("tasks").insert(task_data).execute()
    task = result.data[0]

    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "task_created",
        "resource_type": "task",
        "resource_id": task["id"],
        "details": {"title": body.title, "category": body.category, "budget_max": body.budget_max_eur},
        "reasoning_hash": hashlib.sha256(body.description.encode()).hexdigest(),
    }).execute()

    # Notify matching agents (best-effort)
    if embedding:
        _notify_matching_agents(db, task, embedding)

    return _to_task_response(task)


def _notify_matching_agents(db, task: dict, task_embedding: list[float]) -> None:
    """Find top matching agents via pgvector and note them for future MCP notification."""
    try:
        agents = db.table("agents").select(
            "id, display_name, embedding, is_approved, is_active"
        ).eq("is_approved", True).eq("is_active", True).execute()

        if not agents.data:
            return

        top = shortlist_agents_by_embedding(task_embedding, agents.data, top_k=5)
        for agent in top:
            db.table("audit_logs").insert({
                "agent_id": agent["id"],
                "action": "task_matched",
                "resource_type": "task",
                "resource_id": task["id"],
                "details": {"task_title": task["title"], "category": task.get("category")},
            }).execute()
    except Exception:
        pass


@router.get("", response_model=TaskListResponse)
async def list_tasks(
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
):
    db = get_supabase()
    query = db.table("tasks").select("*")

    if status:
        query = query.eq("status", status)
    if category:
        query = query.eq("category", category)

    offset = (page - 1) * per_page
    result = query.order("created_at", desc=True).range(offset, offset + per_page - 1).execute()

    tasks = [_to_task_response(row) for row in result.data]
    return TaskListResponse(tasks=tasks, total=len(tasks), page=page, per_page=per_page)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str):
    db = get_supabase()
    result = db.table("tasks").select("*").eq("id", task_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Task not found")

    bids = db.table("bids").select("id").eq("task_id", task_id).execute()
    return _to_task_response(result.data[0], bid_count=len(bids.data))


@router.get("/{task_id}/bids")
async def get_task_bids(task_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    task = db.table("tasks").select("id, posted_by_org_id, status").eq("id", task_id).execute()
    if not task.data:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.data[0]["posted_by_org_id"] != token.get("org_id"):
        raise HTTPException(status_code=403, detail="Only the task owner can view bids")

    bids = db.table("bids").select(
        "*, agents(id, display_name, reputation_score, tier, success_rate, total_tasks_completed)"
    ).eq("task_id", task_id).order("score", desc=True).execute()

    return {"task_id": task_id, "bids": bids.data, "total": len(bids.data)}


@router.post("/{task_id}/deliver", status_code=status.HTTP_200_OK)
async def deliver_task(task_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    task = db.table("tasks").select("*").eq("id", task_id).execute()
    if not task.data:
        raise HTTPException(status_code=404, detail="Task not found")

    task_row = task.data[0]
    if task_row["status"] != "in_progress":
        raise HTTPException(status_code=409, detail=f"Task is '{task_row['status']}', expected 'in_progress'")

    agent_id = token.get("agent_id")
    if task_row.get("assigned_agent_id") != agent_id:
        raise HTTPException(status_code=403, detail="Only the assigned agent can deliver")

    db.table("tasks").update({"status": "review"}).eq("id", task_id).execute()
    db.table("audit_logs").insert({
        "agent_id": agent_id,
        "action": "task_delivered",
        "resource_type": "task",
        "resource_id": task_id,
        "details": {"previous_status": "in_progress"},
    }).execute()

    return {"task_id": task_id, "status": "review", "message": "Task delivered. Buyer has 48h to approve."}


@router.put("/{task_id}/approve", status_code=status.HTTP_200_OK)
async def approve_task(task_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    task = db.table("tasks").select("*").eq("id", task_id).execute()
    if not task.data:
        raise HTTPException(status_code=404, detail="Task not found")

    task_row = task.data[0]
    if task_row["posted_by_org_id"] != token.get("org_id"):
        raise HTTPException(status_code=403, detail="Only the task buyer can approve")
    if task_row["status"] != "review":
        raise HTTPException(status_code=409, detail=f"Task is '{task_row['status']}', expected 'review'")

    db.table("tasks").update({"status": "completed"}).eq("id", task_id).execute()
    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "task_approved",
        "resource_type": "task",
        "resource_id": task_id,
        "details": {"agent_id": task_row.get("assigned_agent_id")},
    }).execute()

    return {"task_id": task_id, "status": "completed", "message": "Task approved. Escrow will be released."}


@router.put("/{task_id}/dispute", status_code=status.HTTP_200_OK)
async def dispute_task(task_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()

    task = db.table("tasks").select("*").eq("id", task_id).execute()
    if not task.data:
        raise HTTPException(status_code=404, detail="Task not found")

    task_row = task.data[0]
    if task_row["posted_by_org_id"] != token.get("org_id"):
        raise HTTPException(status_code=403, detail="Only the task buyer can open a dispute")
    if task_row["status"] not in ("review", "in_progress"):
        raise HTTPException(status_code=409, detail="Dispute can only be opened for tasks in review or in_progress")

    db.table("tasks").update({"status": "disputed"}).eq("id", task_id).execute()
    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "task_disputed",
        "resource_type": "task",
        "resource_id": task_id,
        "details": {"agent_id": task_row.get("assigned_agent_id")},
    }).execute()

    return {"task_id": task_id, "status": "disputed", "message": "Dispute opened. Mercatai team will review."}
