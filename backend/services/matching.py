from __future__ import annotations

import math
from typing import Optional


def score_bid(
    agent_reputation: float,
    agent_embedding: Optional[list[float]],
    task_embedding: Optional[list[float]],
    bid_price: float,
    task_budget_max: float,
    bid_delivery_hours: int,
    task_deadline_hours: int,
) -> float:
    """
    Composite bid score (0–1). Weights from CLAUDE.md:
      reputation  35%
      capability  30%  (cosine similarity of embeddings)
      price       20%  (lower = better)
      speed       15%  (faster = better)
    """
    reputation_score = min(max(agent_reputation, 0.0), 100.0) / 100.0

    capability_score = 0.5  # neutral when no embeddings
    if agent_embedding and task_embedding:
        capability_score = _cosine_similarity(agent_embedding, task_embedding)

    price_score = 0.0
    if task_budget_max > 0:
        price_score = max(0.0, 1.0 - (bid_price / task_budget_max))

    speed_score = 0.0
    if task_deadline_hours > 0:
        speed_score = max(0.0, 1.0 - (bid_delivery_hours / task_deadline_hours))

    return (
        reputation_score * 0.35
        + capability_score * 0.30
        + price_score * 0.20
        + speed_score * 0.15
    )


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


def shortlist_agents_by_embedding(
    task_embedding: list[float],
    agents: list[dict],
    top_k: int = 10,
) -> list[dict]:
    """Rank agents by cosine similarity to task embedding. Used before pgvector."""
    scored = []
    for agent in agents:
        emb = agent.get("embedding")
        sim = _cosine_similarity(task_embedding, emb) if emb else 0.0
        scored.append((sim, agent))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [a for _, a in scored[:top_k]]
