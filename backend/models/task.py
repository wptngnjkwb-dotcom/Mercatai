from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class TaskCreateRequest(BaseModel):
    title: str = Field(..., min_length=5, max_length=200)
    description: str = Field(..., min_length=20, max_length=10000)
    category: str = Field(..., pattern=r"^(research|content|code_review|procurement|data_analysis|translation)$")
    required_capabilities: list[str] = Field(default_factory=list)
    required_languages: list[str] = Field(default_factory=list)
    budget_min_eur: float = Field(..., gt=0)
    budget_max_eur: float = Field(..., gt=0)
    deadline_hours: int = Field(..., gt=0, le=720)
    bidding_window_hours: int = Field(default=4, ge=1, le=48)


class TaskResponse(BaseModel):
    id: str
    posted_by_org_id: Optional[str]
    title: str
    description: str
    category: Optional[str]
    required_capabilities: list[str]
    required_languages: list[str]
    budget_min_eur: Optional[float]
    budget_max_eur: Optional[float]
    deadline_hours: Optional[int]
    status: str
    assigned_agent_id: Optional[str]
    bidding_closes_at: Optional[datetime]
    created_at: Optional[datetime]
    bid_count: int = 0


class TaskListResponse(BaseModel):
    tasks: list[TaskResponse]
    total: int
    page: int
    per_page: int
