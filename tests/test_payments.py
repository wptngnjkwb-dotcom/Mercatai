import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

from main import app

client = TestClient(app)


def _make_token(org_id: str = "org-1", sub: str = "user-1") -> str:
    from middleware.auth import create_access_token
    return create_access_token({"sub": sub, "org_id": org_id})


# ── fee calculation unit tests ─────────────────────────────

def test_fee_calculation_standard():
    from models.transaction import calculate_fees
    fees = calculate_fees(100.0)
    assert fees["gross_amount_eur"] == 100.0
    assert fees["stripe_fee_eur"] == 0.80
    assert fees["platform_fee_eur"] == 3.20
    assert fees["agent_payout_eur"] == 96.00


def test_fee_calculation_sepa_cap():
    """SEPA fee is capped at €5."""
    from models.transaction import calculate_fees
    fees = calculate_fees(1000.0)
    assert fees["stripe_fee_eur"] == 5.00
    assert fees["platform_fee_eur"] == 32.00
    assert fees["agent_payout_eur"] == 963.00


def test_fee_calculation_small_amount():
    from models.transaction import calculate_fees
    fees = calculate_fees(50.0)
    assert fees["stripe_fee_eur"] == 0.40
    assert fees["platform_fee_eur"] == 1.60
    assert fees["agent_payout_eur"] == 48.00


def test_agent_payout_always_96_percent_below_cap():
    from models.transaction import calculate_fees
    for amount in [10.0, 50.0, 100.0, 200.0, 400.0]:
        fees = calculate_fees(amount)
        pct = fees["agent_payout_eur"] / fees["gross_amount_eur"]
        assert abs(pct - 0.96) < 0.001, f"Expected 96% at €{amount}, got {pct:.4f}"


# ── reputation unit tests ──────────────────────────────────

def test_calculate_tier():
    from services.reputation import _calculate_tier
    assert _calculate_tier(0) == 1
    assert _calculate_tier(59) == 1
    assert _calculate_tier(60) == 2
    assert _calculate_tier(74) == 2
    assert _calculate_tier(75) == 3
    assert _calculate_tier(89) == 3
    assert _calculate_tier(90) == 4
    assert _calculate_tier(100) == 4


@patch("services.reputation.get_supabase")
def test_apply_reputation_event(mock_db):
    db = MagicMock()
    mock_db.return_value = db

    chain = MagicMock()
    chain.select.return_value = chain
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = MagicMock(data=[{"reputation_score": 50.0}])
    db.table.return_value = chain

    new_score = __import__("services.reputation", fromlist=["apply_reputation_event"]).apply_reputation_event(
        agent_id="agent-1",
        event_type="task_completed",
        task_id="task-1",
    )
    assert new_score == 58.0


@patch("services.reputation.get_supabase")
def test_reputation_capped_at_100(mock_db):
    db = MagicMock()
    mock_db.return_value = db
    chain = MagicMock()
    chain.select.return_value = chain
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = MagicMock(data=[{"reputation_score": 98.0}])
    db.table.return_value = chain

    from services.reputation import apply_reputation_event
    new_score = apply_reputation_event("agent-1", "task_completed")
    assert new_score == 100.0


@patch("services.reputation.get_supabase")
def test_reputation_capped_at_0(mock_db):
    db = MagicMock()
    mock_db.return_value = db
    chain = MagicMock()
    chain.select.return_value = chain
    chain.insert.return_value = chain
    chain.update.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = MagicMock(data=[{"reputation_score": 5.0}])
    db.table.return_value = chain

    from services.reputation import apply_reputation_event
    new_score = apply_reputation_event("agent-1", "dispute_lost")
    assert new_score == 0.0


# ── payment endpoints ──────────────────────────────────────

def test_create_intent_requires_auth():
    r = client.post("/api/v1/payments/create-intent", json={"task_id": "x", "bid_id": "y"})
    assert r.status_code == 401


def test_release_requires_auth():
    r = client.post("/api/v1/payments/release/task-id")
    assert r.status_code == 401


def test_get_transaction_requires_auth():
    r = client.get("/api/v1/payments/transaction/task-id")
    assert r.status_code == 401


def test_webhook_bad_payload():
    r = client.post("/api/v1/payments/webhook", content=b"not-json")
    assert r.status_code in (200, 400)


@patch("routers.payments.get_supabase")
def test_create_intent_bid_not_found(mock_db):
    token = _make_token()
    db = MagicMock()
    mock_db.return_value = db
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.execute.return_value = MagicMock(data=[])
    db.table.return_value = chain

    r = client.post(
        "/api/v1/payments/create-intent",
        json={"task_id": "task-1", "bid_id": "bid-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404


@patch("routers.payments.get_supabase")
def test_create_intent_bid_not_accepted(mock_db):
    token = _make_token()
    db = MagicMock()
    mock_db.return_value = db

    bid_chain = MagicMock()
    bid_chain.select.return_value = bid_chain
    bid_chain.eq.return_value = bid_chain
    bid_chain.execute.return_value = MagicMock(data=[{
        "id": "bid-1", "task_id": "task-1", "agent_id": "agent-1",
        "price_eur": 300.0, "status": "pending",
    }])
    db.table.return_value = bid_chain

    r = client.post(
        "/api/v1/payments/create-intent",
        json={"task_id": "task-1", "bid_id": "bid-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 409


@patch("routers.payments.get_supabase")
@patch("routers.payments.create_sepa_payment_intent")
def test_create_intent_happy_path(mock_stripe, mock_db):
    token = _make_token(org_id="org-1")
    db = MagicMock()
    mock_db.return_value = db

    mock_stripe.return_value = {"id": "pi_test123", "client_secret": "pi_test123_secret"}

    call_returns = {
        "bids": MagicMock(data=[{
            "id": "bid-1", "task_id": "task-1", "agent_id": "agent-1",
            "price_eur": 100.0, "status": "accepted",
        }]),
        "tasks": MagicMock(data=[{
            "id": "task-1", "posted_by_org_id": "org-1",
            "status": "assigned", "assigned_agent_id": "agent-1",
        }]),
        "transactions_check": MagicMock(data=[]),
        "transactions_insert": MagicMock(data=[{
            "id": "tx-1", "task_id": "task-1", "buyer_org_id": "org-1",
            "agent_id": "agent-1", "gross_amount_eur": 100.0,
            "stripe_fee_eur": 0.80, "platform_fee_eur": 3.20,
            "agent_payout_eur": 96.00, "escrow_status": "held",
        }]),
    }

    table_calls = []
    def table_side(name):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.insert.return_value = chain
        chain.update.return_value = chain
        chain.eq.return_value = chain

        table_calls.append(name)
        count = table_calls.count(name)

        if name == "bids":
            chain.execute.return_value = call_returns["bids"]
        elif name == "tasks":
            chain.execute.return_value = call_returns["tasks"]
        elif name == "transactions" and count == 1:
            chain.execute.return_value = call_returns["transactions_check"]
        elif name == "transactions" and count == 2:
            chain.execute.return_value = call_returns["transactions_insert"]
        elif name == "transactions":
            chain.execute.return_value = MagicMock(data=[])
        else:
            chain.execute.return_value = MagicMock(data=[{"id": "log-1"}])
        return chain

    db.table.side_effect = table_side

    r = client.post(
        "/api/v1/payments/create-intent",
        json={"task_id": "task-1", "bid_id": "bid-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201
    data = r.json()
    assert data["gross_amount_eur"] == 100.0
    assert data["agent_payout_eur"] == 96.0
    assert "client_secret" in data
