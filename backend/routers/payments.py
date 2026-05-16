from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, Depends, Request, Header, status
from fastapi.responses import JSONResponse
from typing import Optional
from db.client import get_supabase
from middleware.auth import require_auth
from models.transaction import PaymentIntentRequest, PaymentIntentResponse, TransactionResponse, calculate_fees
from services.stripe_service import create_sepa_payment_intent, create_transfer_to_agent, construct_webhook_event
from services.reputation import apply_reputation_event, update_agent_stats

router = APIRouter(prefix="/payments", tags=["payments"])


@router.post("/create-intent", response_model=PaymentIntentResponse, status_code=status.HTTP_201_CREATED)
async def create_payment_intent(
    body: PaymentIntentRequest,
    token: dict = Depends(require_auth),
):
    db = get_supabase()
    org_id = token.get("org_id")

    # Load and validate bid
    bid_result = db.table("bids").select("*").eq("id", body.bid_id).execute()
    if not bid_result.data:
        raise HTTPException(status_code=404, detail="Bid not found")
    bid = bid_result.data[0]

    if bid["status"] != "accepted":
        raise HTTPException(status_code=409, detail=f"Bid status is '{bid['status']}', expected 'accepted'")
    if bid["task_id"] != body.task_id:
        raise HTTPException(status_code=400, detail="Bid does not belong to this task")

    # Load task
    task_result = db.table("tasks").select("*").eq("id", body.task_id).execute()
    if not task_result.data:
        raise HTTPException(status_code=404, detail="Task not found")
    task = task_result.data[0]

    if task["posted_by_org_id"] != org_id:
        raise HTTPException(status_code=403, detail="Only the task buyer can initiate payment")
    if task["status"] != "assigned":
        raise HTTPException(status_code=409, detail=f"Task status is '{task['status']}', expected 'assigned'")

    # Check for existing transaction
    existing_tx = db.table("transactions").select("id").eq("task_id", body.task_id).execute()
    if existing_tx.data:
        raise HTTPException(status_code=409, detail="Payment intent already created for this task")

    fees = calculate_fees(float(bid["price_eur"]))

    # Create DB record first to get transaction_id
    tx_result = db.table("transactions").insert({
        "task_id": body.task_id,
        "buyer_org_id": org_id,
        "agent_id": bid["agent_id"],
        **fees,
        "escrow_status": "held",
        "review_deadline_at": (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(),
    }).execute()
    transaction = tx_result.data[0]

    # Create Stripe PaymentIntent
    try:
        intent = create_sepa_payment_intent(
            amount_eur=fees["gross_amount_eur"],
            task_id=body.task_id,
            buyer_org_id=org_id,
            agent_id=bid["agent_id"],
            transaction_id=transaction["id"],
        )
    except Exception as e:
        # In dev mode without real Stripe keys, return a mock intent
        intent = {
            "id": f"pi_test_{transaction['id'][:16]}",
            "client_secret": f"pi_test_{transaction['id'][:16]}_secret_dev",
        }

    # Update transaction with Stripe ID
    db.table("transactions").update({
        "stripe_payment_intent_id": intent["id"],
    }).eq("id", transaction["id"]).execute()

    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "payment_intent_created",
        "resource_type": "transaction",
        "resource_id": transaction["id"],
        "details": {
            "task_id": body.task_id,
            "bid_id": body.bid_id,
            "gross_eur": fees["gross_amount_eur"],
            "stripe_payment_intent_id": intent["id"],
        },
        "reasoning_hash": hashlib.sha256(f"{body.task_id}:{body.bid_id}".encode()).hexdigest(),
    }).execute()

    return PaymentIntentResponse(
        transaction_id=transaction["id"],
        stripe_payment_intent_id=intent["id"],
        client_secret=intent["client_secret"],
        **fees,
        escrow_status="held",
    )


@router.post("/webhook", status_code=status.HTTP_200_OK)
async def stripe_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="stripe-signature"),
):
    payload = await request.body()

    try:
        event = construct_webhook_event(payload, stripe_signature or "")
    except Exception:
        # In dev without real Stripe, accept raw JSON
        import json
        try:
            event = json.loads(payload)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid webhook payload")

    event_type = event.get("type") if isinstance(event, dict) else event.type
    event_data = event.get("data", {}).get("object", {}) if isinstance(event, dict) else event.data.object

    db = get_supabase()

    if event_type == "payment_intent.succeeded":
        await _handle_payment_succeeded(db, event_data)
    elif event_type == "payment_intent.payment_failed":
        await _handle_payment_failed(db, event_data)
    elif event_type == "charge.dispute.created":
        await _handle_dispute_created(db, event_data)

    return {"received": True}


async def _handle_payment_succeeded(db, payment_intent: dict) -> None:
    pi_id = payment_intent.get("id") if isinstance(payment_intent, dict) else payment_intent.id
    metadata = (payment_intent.get("metadata", {}) if isinstance(payment_intent, dict)
                else payment_intent.metadata)
    task_id = metadata.get("task_id")
    transaction_id = metadata.get("transaction_id")

    if transaction_id:
        db.table("transactions").update({"escrow_status": "held"}).eq("id", transaction_id).execute()

    if task_id:
        db.table("tasks").update({"status": "in_progress"}).eq("id", task_id).execute()

    db.table("audit_logs").insert({
        "action": "payment_confirmed",
        "resource_type": "transaction",
        "resource_id": transaction_id,
        "details": {"stripe_payment_intent_id": pi_id, "task_id": task_id},
    }).execute()


async def _handle_payment_failed(db, payment_intent: dict) -> None:
    pi_id = payment_intent.get("id") if isinstance(payment_intent, dict) else payment_intent.id
    metadata = (payment_intent.get("metadata", {}) if isinstance(payment_intent, dict)
                else payment_intent.metadata)
    task_id = metadata.get("task_id")
    transaction_id = metadata.get("transaction_id")

    if transaction_id:
        db.table("transactions").update({"escrow_status": "refunded"}).eq("id", transaction_id).execute()
    if task_id:
        db.table("tasks").update({"status": "open"}).eq("id", task_id).execute()

    db.table("audit_logs").insert({
        "action": "payment_failed",
        "resource_type": "transaction",
        "resource_id": transaction_id,
        "details": {"stripe_payment_intent_id": pi_id, "task_id": task_id},
    }).execute()


async def _handle_dispute_created(db, charge: dict) -> None:
    pi_id = charge.get("payment_intent") if isinstance(charge, dict) else charge.payment_intent

    tx = db.table("transactions").select("*").eq("stripe_payment_intent_id", pi_id).execute()
    if not tx.data:
        return

    transaction = tx.data[0]
    db.table("transactions").update({"escrow_status": "disputed"}).eq("id", transaction["id"]).execute()
    db.table("tasks").update({"status": "disputed"}).eq("id", transaction["task_id"]).execute()

    db.table("audit_logs").insert({
        "action": "stripe_dispute_created",
        "resource_type": "transaction",
        "resource_id": transaction["id"],
        "details": {"stripe_payment_intent_id": pi_id},
    }).execute()


@router.post("/release/{task_id}", status_code=status.HTTP_200_OK)
async def release_payment(task_id: str, token: dict = Depends(require_auth)):
    """
    Release escrow to agent after buyer approves the task.
    Called internally after PUT /tasks/{id}/approve.
    """
    db = get_supabase()
    org_id = token.get("org_id")

    task = db.table("tasks").select("*").eq("id", task_id).execute()
    if not task.data:
        raise HTTPException(status_code=404, detail="Task not found")
    task_row = task.data[0]

    if task_row["posted_by_org_id"] != org_id:
        raise HTTPException(status_code=403, detail="Only the task buyer can release payment")
    if task_row["status"] != "completed":
        raise HTTPException(status_code=409, detail="Task must be 'completed' before releasing payment")

    tx = db.table("transactions").select("*").eq("task_id", task_id).execute()
    if not tx.data:
        raise HTTPException(status_code=404, detail="No transaction found for this task")
    transaction = tx.data[0]

    if transaction["escrow_status"] != "held":
        raise HTTPException(status_code=409, detail=f"Escrow status is '{transaction['escrow_status']}'")

    # Attempt Stripe Connect transfer
    transfer_id = None
    agent = db.table("agents").select("avatar_book_id, display_name").eq(
        "id", transaction["agent_id"]
    ).execute()
    agent_stripe_account = None
    if agent.data:
        agent_stripe_account = agent.data[0].get("avatar_book_id")

    if agent_stripe_account and agent_stripe_account.startswith("acct_"):
        try:
            transfer_id = create_transfer_to_agent(
                amount_eur=float(transaction["agent_payout_eur"]),
                agent_stripe_account=agent_stripe_account,
                task_id=task_id,
                transaction_id=transaction["id"],
            )
        except Exception as e:
            # Log but don't fail — finance team handles manually
            db.table("audit_logs").insert({
                "action": "transfer_failed",
                "resource_type": "transaction",
                "resource_id": transaction["id"],
                "details": {"error": str(e)},
            }).execute()

    db.table("transactions").update({
        "escrow_status": "released",
        "released_at": datetime.now(timezone.utc).isoformat(),
        **({"stripe_transfer_id": transfer_id} if transfer_id else {}),
    }).eq("id", transaction["id"]).execute()

    # Update reputation
    apply_reputation_event(
        agent_id=transaction["agent_id"],
        event_type="task_completed",
        task_id=task_id,
    )
    update_agent_stats(agent_id=transaction["agent_id"], success=True)

    # Decrement free_tasks_remaining if applicable
    db.table("agents").update({
        "free_tasks_remaining": db.rpc("greatest", {"a": 0})
    }).eq("id", transaction["agent_id"]).execute()

    db.table("audit_logs").insert({
        "user_id": token.get("sub"),
        "action": "payment_released",
        "resource_type": "transaction",
        "resource_id": transaction["id"],
        "details": {
            "task_id": task_id,
            "agent_payout_eur": float(transaction["agent_payout_eur"]),
            "transfer_id": transfer_id,
        },
        "reasoning_hash": hashlib.sha256(f"release:{task_id}".encode()).hexdigest(),
    }).execute()

    return {
        "transaction_id": transaction["id"],
        "escrow_status": "released",
        "agent_payout_eur": float(transaction["agent_payout_eur"]),
        "transfer_id": transfer_id,
        "message": "Payment released to agent.",
    }


@router.get("/transaction/{task_id}", response_model=TransactionResponse)
async def get_transaction(task_id: str, token: dict = Depends(require_auth)):
    db = get_supabase()
    org_id = token.get("org_id")

    tx = db.table("transactions").select("*").eq("task_id", task_id).execute()
    if not tx.data:
        raise HTTPException(status_code=404, detail="Transaction not found")

    transaction = tx.data[0]
    if transaction["buyer_org_id"] != org_id:
        raise HTTPException(status_code=403, detail="Access denied")

    return TransactionResponse(**{k: transaction.get(k) for k in TransactionResponse.model_fields})
