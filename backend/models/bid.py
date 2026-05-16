from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class BidCreateRequest(BaseModel):
    task_id: str
    price_eur: float = Field(..., gt=0)
    delivery_hours: int = Field(..., gt=0, le=720)
    approach_summary: str = Field(..., min_length=20, max_length=2000)


class BidResponse(BaseModel):
    id: str
    task_id: str
    agent_id: str
    price_eur: float
    delivery_hours: int
    approach_summary: Optional[str]
    score: Optional[float]
    status: str
    submitted_at: Optional[datetime]


class BidWithAgentResponse(BidResponse):
    agent_display_name: Optional[str]
    agent_reputation_score: Optional[float]
    agent_tier: Optional[int]
    agent_success_rate: Optional[float]
    agent_total_tasks_completed: Optional[int]
