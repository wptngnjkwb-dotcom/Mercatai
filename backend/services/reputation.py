from __future__ import annotations

from db.client import get_supabase

SCORE_DELTAS = {
    "task_completed": 8.0,
    "task_completed_late": 3.0,
    "task_failed": -5.0,
    "dispute_lost": -15.0,
    "fraud_detected": -25.0,
    "positive_review": 1.0,
}


def apply_reputation_event(agent_id: str, event_type: str, task_id: str | None = None) -> float:
    """Record reputation event and update agent score. Returns new score."""
    db = get_supabase()

    delta = SCORE_DELTAS.get(event_type, 0.0)
    if delta == 0.0:
        return _get_current_score(db, agent_id)

    # Map internal event types to DB CHECK constraint values
    db_event_type = _to_db_event_type(event_type)

    db.table("reputation_events").insert({
        "agent_id": agent_id,
        "event_type": db_event_type,
        "score_delta": delta,
        "task_id": task_id,
    }).execute()

    agent = db.table("agents").select("reputation_score").eq("id", agent_id).execute()
    if not agent.data:
        return 50.0

    current = float(agent.data[0]["reputation_score"])
    new_score = max(0.0, min(100.0, current + delta))

    new_tier = _calculate_tier(new_score)

    db.table("agents").update({
        "reputation_score": new_score,
        "tier": new_tier,
    }).eq("id", agent_id).execute()

    return new_score


def _to_db_event_type(event_type: str) -> str:
    mapping = {
        "task_completed": "task_completed",
        "task_completed_late": "task_completed",
        "task_failed": "task_failed",
        "dispute_lost": "dispute_lost",
        "positive_review": "positive_review",
        "fraud_detected": "fraud_detected",
    }
    return mapping.get(event_type, "task_completed")


def _get_current_score(db, agent_id: str) -> float:
    result = db.table("agents").select("reputation_score").eq("id", agent_id).execute()
    return float(result.data[0]["reputation_score"]) if result.data else 50.0


def _calculate_tier(score: float) -> int:
    if score >= 90:
        return 4
    if score >= 75:
        return 3
    if score >= 60:
        return 2
    return 1


def update_agent_stats(agent_id: str, success: bool) -> None:
    """Increment task counters and recalculate success_rate."""
    db = get_supabase()
    agent = db.table("agents").select(
        "total_tasks_completed, success_rate"
    ).eq("id", agent_id).execute()
    if not agent.data:
        return

    total = agent.data[0]["total_tasks_completed"] + 1
    old_rate = float(agent.data[0]["success_rate"])
    new_rate = round(((old_rate * (total - 1)) + (1.0 if success else 0.0)) / total, 4)

    db.table("agents").update({
        "total_tasks_completed": total,
        "success_rate": new_rate,
    }).eq("id", agent_id).execute()
