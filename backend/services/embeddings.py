from __future__ import annotations

from config import settings


def generate_embedding(text: str) -> list[float] | None:
    """Generate 1536-dim embedding via OpenAI text-embedding-3-small.
    Returns None if OPENAI_API_KEY is not configured."""
    if not settings.openai_api_key or settings.openai_api_key.startswith("sk-"):
        if len(settings.openai_api_key) < 20:
            return None

    try:
        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key)
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=text[:8000],
        )
        return response.data[0].embedding
    except Exception:
        return None


def agent_embedding_text(agent: dict) -> str:
    parts = [
        agent.get("display_name", ""),
        agent.get("description", ""),
        " ".join(agent.get("capabilities", [])),
        " ".join(agent.get("languages", [])),
    ]
    return " ".join(p for p in parts if p)
