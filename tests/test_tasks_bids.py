import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

from main import app

client = TestClient(app)

VALID_TASK = {
    "title": "Research EU AI Act compliance requirements",
    "description": "We need a comprehensive analysis of EU AI Act compliance requirements for our SaaS product, including risk categories and obligations.",
    "category": "research",
    "required_capabilities": ["research", "legal_analysis"],
    "required_languages": ["en"],
    "budget_min_eur": 100.0,
    "budget_max_eur": 500.0,
    "deadline_hours": 48,
    "bidding_window_hours": 4,
}

VALID_BID = {
    "task_id": "task-uuid-1",
    "price_eur": 350.0,
    "delivery_hours": 36,
    "approach_summary": "I will analyze the full EU AI Act text, identify applicable risk categories for your product, and provide a structured compliance checklist with action items.",
}


def _make_token(org_id: str = "org-1", sub: str = "user-1") -> str:
    from middleware.auth import create_access_token
    return create_access_token({"sub": sub, "org_id": org_id})


def _make_agent_token(agent_id: str = "agent-uuid-1") -> str:
    from middleware.auth import create_access_token
    return create_access_token({"sub": agent_id, "agent_id": agent_id})


# ── matching engine unit tests ─────────────────────────────

def test_score_bid_no_embeddings():
    from services.matching import score_bid
    score = score_bid(
        agent_reputation=75.0,
        agent_embedding=None,
        task_embedding=None,
        bid_price=350.0,
        task_budget_max=500.0,
        bid_delivery_hours=36,
        task_deadline_hours=48,
    )
    assert 0.0 <= score <= 1.0


def test_score_bid_perfect():
    from services.matching import score_bid
    score = score_bid(
        agent_reputation=100.0,
        agent_embedding=None,
        task_embedding=None,
        bid_price=0.01,
        task_budget_max=500.0,
        bid_delivery_hours=1,
        task_deadline_hours=48,
    )
    assert score > 0.7


def test_score_bid_clamped():
    from services.matching import score_bid
    score = score_bid(
        agent_reputation=150.0,
        agent_embedding=None,
        task_embedding=None,
        bid_price=0.0,
        task_budget_max=0.0,
        bid_delivery_hours=0,
        task_deadline_hours=0,
    )
    assert 0.0 <= score <= 1.0


def test_cosine_similarity():
    from services.matching import _cosine_similarity
    a = [1.0, 0.0, 0.0]
    b = [1.0, 0.0, 0.0]
    assert abs(_cosine_similarity(a, b) - 1.0) < 0.001

    c = [0.0, 1.0, 0.0]
    assert abs(_cosine_similarity(a, c)) < 0.001


# ── task endpoints ─────────────────────────────────────────

def test_create_task_requires_auth():
    r = client.post("/api/v1/tasks", json=VALID_TASK)
    assert r.status_code == 401


def test_create_task_invalid_category():
    token = _make_token()
    bad = {**VALID_TASK, "category": "invalid_category"}
    r = client.post("/api/v1/tasks", json=bad, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 422


@patch("routers.tasks.get_supabase")
@patch("routers.tasks.generate_embedding", return_value=None)
def test_create_task_happy_path(mock_embed, mock_db):
    token = _make_token(org_id="org-1")
    db = MagicMock()
    mock_db.return_value = db

    task_row = {
        "id": "task-uuid-1", "posted_by_org_id": "org-1",
        "title": VALID_TASK["title"], "description": VALID_TASK["description"],
        "category": "research", "required_capabilities": ["research"],
        "required_languages": ["en"], "budget_min_eur": 100.0, "budget_max_eur": 500.0,
        "deadline_hours": 48, "status": "open", "assigned_agent_id": None,
        "bidding_closes_at": None, "created_at": None,
    }
    chain = MagicMock()
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = MagicMock(data=[task_row])
    db.table.return_value = chain

    r = client.post("/api/v1/tasks", json=VALID_TASK, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201
    assert r.json()["title"] == VALID_TASK["title"]
    assert r.json()["status"] == "open"


def test_get_task_not_found():
    with patch("routers.tasks.get_supabase") as mock_db:
        db = MagicMock()
        mock_db.return_value = db
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.execute.return_value = MagicMock(data=[])
        db.table.return_value = chain

        r = client.get("/api/v1/tasks/nonexistent")
        assert r.status_code == 404


@patch("routers.tasks.get_supabase")
def test_list_tasks(mock_db):
    db = MagicMock()
    mock_db.return_value = db
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.order.return_value = chain
    chain.range.return_value = chain
    chain.execute.return_value = MagicMock(data=[])
    db.table.return_value = chain

    r = client.get("/api/v1/tasks")
    assert r.status_code == 200
    assert "tasks" in r.json()


# ── bid endpoints ─────────────────────────────────────────

def test_submit_bid_requires_agent_token():
    token = _make_token()  # org token, no agent_id
    r = client.post("/api/v1/bids", json=VALID_BID, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_submit_bid_requires_auth():
    r = client.post("/api/v1/bids", json=VALID_BID)
    assert r.status_code == 401


def test_accept_bid_requires_auth():
    r = client.put("/api/v1/bids/some-id/accept")
    assert r.status_code == 401


def test_reject_bid_requires_auth():
    r = client.put("/api/v1/bids/some-id/reject")
    assert r.status_code == 401


def test_bid_missing_fields():
    token = _make_agent_token()
    r = client.post("/api/v1/bids", json={"task_id": "x"}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 422
