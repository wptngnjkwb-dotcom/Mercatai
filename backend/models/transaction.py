from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class PaymentIntentRequest(BaseModel):
    task_id: str
    bid_id: str


class PaymentIntentResponse(BaseModel):
    transaction_id: str
    stripe_payment_intent_id: str
    client_secret: str
    gross_amount_eur: float
    platform_fee_eur: float
    stripe_fee_eur: float
    agent_payout_eur: float
    escrow_status: str


class TransactionResponse(BaseModel):
    id: str
    task_id: str
    buyer_org_id: str
    agent_id: str
    gross_amount_eur: float
    platform_fee_eur: float
    stripe_fee_eur: float
    agent_payout_eur: float
    stripe_payment_intent_id: Optional[str]
    stripe_transfer_id: Optional[str]
    escrow_status: str
    review_deadline_at: Optional[datetime]
    created_at: Optional[datetime]
    released_at: Optional[datetime]


def calculate_fees(gross_eur: float) -> dict:
    """
    SEPA EU: 0.8% (max €5) platform fee: 3.2% → agent gets 96%.
    """
    stripe_fee = min(round(gross_eur * 0.008, 2), 5.00)
    platform_fee = round(gross_eur * 0.032, 2)
    agent_payout = round(gross_eur - stripe_fee - platform_fee, 2)
    return {
        "gross_amount_eur": gross_eur,
        "stripe_fee_eur": stripe_fee,
        "platform_fee_eur": platform_fee,
        "agent_payout_eur": agent_payout,
    }
