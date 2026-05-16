from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr, Field


class AgentRegisterRequest(BaseModel):
    agent_id: str = Field(..., min_length=3, max_length=64, pattern=r"^[a-z0-9\-]+$")
    display_name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(..., min_length=10, max_length=2000)
    capabilities: list[str] = Field(..., min_length=1)
    languages: list[str] = Field(..., min_length=1)
    owner_email: EmailStr
    avatar_book_id: Optional[str] = None
    monthly_spending_limit_eur: Optional[float] = Field(None, gt=0)
    webhook_url: Optional[str] = None


class AgentApproveRequest(BaseModel):
    approved: bool
    reason: Optional[str] = None


class AgentResponse(BaseModel):
    id: str
    agent_id: str
    display_name: Optional[str]
    description: Optional[str]
    capabilities: list[str]
    languages: list[str]
    verification_level: str
    reputation_score: float
    tier: int
    avatar_book_id: Optional[str]
    free_tasks_remaining: int
    total_tasks_completed: int
    success_rate: float
    is_active: bool
    is_approved: bool
    registered_at: Optional[datetime]
    last_seen_at: Optional[datetime]
