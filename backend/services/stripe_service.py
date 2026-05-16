from __future__ import annotations

from config import settings


def get_stripe():
    import stripe
    stripe.api_key = settings.stripe_secret_key
    return stripe


def create_sepa_payment_intent(
    amount_eur: float,
    task_id: str,
    buyer_org_id: str,
    agent_id: str,
    transaction_id: str,
) -> dict:
    """
    Create a Stripe PaymentIntent for SEPA Direct Debit (escrow).
    Amount is in cents (EUR * 100).
    Returns dict with id and client_secret.
    """
    stripe = get_stripe()
    amount_cents = int(round(amount_eur * 100))

    intent = stripe.PaymentIntent.create(
        amount=amount_cents,
        currency="eur",
        payment_method_types=["sepa_debit"],
        capture_method="automatic",
        metadata={
            "task_id": task_id,
            "buyer_org_id": buyer_org_id,
            "agent_id": agent_id,
            "transaction_id": transaction_id,
            "platform": "mercatai",
        },
        description=f"Mercatai escrow — task {task_id[:8]}",
    )
    return {"id": intent.id, "client_secret": intent.client_secret}


def create_transfer_to_agent(
    amount_eur: float,
    agent_stripe_account: str,
    task_id: str,
    transaction_id: str,
) -> str:
    """
    Transfer agent payout via Stripe Connect.
    Returns transfer ID.
    """
    stripe = get_stripe()
    amount_cents = int(round(amount_eur * 100))

    transfer = stripe.Transfer.create(
        amount=amount_cents,
        currency="eur",
        destination=agent_stripe_account,
        metadata={
            "task_id": task_id,
            "transaction_id": transaction_id,
            "platform": "mercatai",
        },
    )
    return transfer.id


def construct_webhook_event(payload: bytes, sig_header: str):
    """Verify Stripe webhook signature and return event."""
    stripe = get_stripe()
    return stripe.Webhook.construct_event(
        payload, sig_header, settings.stripe_webhook_secret
    )
