import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../backend"))

from main import app

client = TestClient(app)


# ── discovery ──────────────────────────────────────────────

def test_agent_json():
    r = client.get("/.well-known/agent.json")
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "Mercatai"
    assert data["fee_percent"] == 3.2
    assert "register_endpoint" in data


def test_skill_md():
    r = client.get("/SKILL.md")
    assert r.status_code == 200
    assert "Mercatai" in r.text


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ── agent registration ──────────────────────────────────────

VALID_AGENT = {
    "agent_id": "test-agent-001",
    "display_name": "Test Agent",
    "description": "A test agent for automated testing of the Mercatai platform.",
    "capabilities": ["research", "data_analysis"],
    "languages": ["en", "cs"],
    "owner_email": "owner@example.com",
}


def _mock_db_chain(return_data: list):
    """Build a mock Supabase chained call: .table().select/insert().eq().execute()"""
    mock_result = MagicMock()
    mock_result.data = return_data
    mock_chain = MagicMock()
    mock_chain.execute.return_value = mock_result
    mock_chain.eq.return_value = mock_chain
    mock_chain.select.return_value = mock_chain
    mock_chain.insert.return_value = mock_chain
    mock_chain.update.return_value = mock_chain
    return mock_chain


@patch("routers.agents.get_supabase")
@patch("routers.agents.verify_agent", new_callable=AsyncMock)
@patch("routers.agents.generate_embedding", return_value=None)
@patch("routers.agents.send_agent_approval_request", new_callable=AsyncMock)
def test_register_agent_happy_path(mock_email, mock_embed, mock_ab, mock_db):
    from services.avatarbook import AvatarBookResult

    mock_ab.return_value = AvatarBookResult(verified=False, reason="No ID")
    mock_email.return_value = True

    db = MagicMock()
    mock_db.return_value = db

    # agents.select (uniqueness check) → empty
    no_data = MagicMock()
    no_data.data = []

    # organizations.insert → org with id
    org_result = MagicMock()
    org_result.data = [{"id": "org-uuid-1"}]

    # agents.insert → agent row
    agent_result = MagicMock()
    agent_result.data = [{"id": "agent-uuid-1", "agent_id": "test-agent-001"}]

    # audit_logs.insert → ok
    audit_result = MagicMock()
    audit_result.data = [{"id": "log-uuid-1"}]

    call_count = [0]
    def table_side_effect(name):
        chain = MagicMock()
        chain.select.return_value = chain
        chain.insert.return_value = chain
        chain.eq.return_value = chain

        if name == "agents" and call_count[0] == 0:
            chain.execute.return_value = no_data
            call_count[0] += 1
        elif name == "organizations":
            chain.execute.return_value = org_result
        elif name == "agents":
            chain.execute.return_value = agent_result
        elif name == "audit_logs":
            chain.execute.return_value = audit_result
        else:
            chain.execute.return_value = audit_result
        return chain

    db.table.side_effect = table_side_effect

    r = client.post("/api/v1/agents/register", json=VALID_AGENT)
    assert r.status_code == 201
    data = r.json()
    assert data["agent_id"] == "test-agent-001"
    assert data["is_approved"] is False


def test_register_agent_invalid_id():
    bad = {**VALID_AGENT, "agent_id": "INVALID ID with spaces!"}
    r = client.post("/api/v1/agents/register", json=bad)
    assert r.status_code == 422


def test_register_agent_missing_fields():
    r = client.post("/api/v1/agents/register", json={"agent_id": "x"})
    assert r.status_code == 422


def test_get_agent_not_found():
    with patch("routers.agents.get_supabase") as mock_db:
        db = MagicMock()
        mock_db.return_value = db
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        result = MagicMock()
        result.data = []
        chain.execute.return_value = result
        db.table.return_value = chain

        r = client.get("/api/v1/agents/nonexistent-uuid")
        assert r.status_code == 404


def test_approve_requires_auth():
    r = client.put("/api/v1/agents/some-id/approve", json={"approved": True})
    assert r.status_code == 401
