from __future__ import annotations

import httpx
from config import settings


async def _send_email(to: str, subject: str, html: str) -> bool:
    if not settings.sendgrid_api_key or len(settings.sendgrid_api_key) < 10:
        print(f"[email] (SendGrid not configured) To: {to} | {subject}")
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                json={
                    "personalizations": [{"to": [{"email": to}]}],
                    "from": {"email": settings.from_email, "name": "Mercatai"},
                    "subject": subject,
                    "content": [{"type": "text/html", "value": html}],
                },
                headers={"Authorization": f"Bearer {settings.sendgrid_api_key}"},
            )
            return r.status_code == 202
    except Exception as e:
        print(f"[email] Failed: {e}")
        return False


async def send_agent_approval_request(
    owner_email: str,
    agent_id: str,
    agent_db_id: str,
    display_name: str,
    description: str,
    capabilities: list[str],
    avatar_book_verified: bool,
    approve_url: str,
) -> bool:
    html = f"""
<h2>New AI Agent Registration — Mercatai</h2>
<p>An agent has requested to join your Mercatai account.</p>
<table>
  <tr><td><b>Agent ID</b></td><td>{agent_id}</td></tr>
  <tr><td><b>Name</b></td><td>{display_name}</td></tr>
  <tr><td><b>AvatarBook verified</b></td><td>{"✅ Yes" if avatar_book_verified else "❌ No"}</td></tr>
  <tr><td><b>Capabilities</b></td><td>{", ".join(capabilities)}</td></tr>
</table>
<p><b>Description:</b><br>{description}</p>
<p>
  <a href="{approve_url}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">✅ Review &amp; Approve</a>
</p>
<p style="color:#6b7280;font-size:12px;">Mercatai — mercatai.cz</p>
"""
    return await _send_email(
        owner_email,
        f"[Mercatai] Agent approval required: {display_name}",
        html,
    )


async def send_agent_approval_result(
    owner_email: str, display_name: str, approved: bool, reason: str | None = None
) -> None:
    status = "approved ✅" if approved else "rejected ❌"
    html = f"""
<h2>Agent {status} — Mercatai</h2>
<p>The agent <b>{display_name}</b> has been {status}.</p>
{"<p><b>Reason:</b> " + reason + "</p>" if reason else ""}
<p><a href="https://mercatai.cz">Manage your agents →</a></p>
"""
    await _send_email(owner_email, f"[Mercatai] Agent {status}: {display_name}", html)


async def send_bid_notification(
    owner_email: str,
    task_title: str,
    agent_name: str,
    price_eur: float,
    delivery_hours: int,
    task_id: str,
) -> None:
    html = f"""
<h2>New bid on your task — Mercatai</h2>
<p>Task: <b>{task_title}</b></p>
<table>
  <tr><td><b>Agent</b></td><td>{agent_name}</td></tr>
  <tr><td><b>Price</b></td><td>€{price_eur:.2f}</td></tr>
  <tr><td><b>Delivery</b></td><td>{delivery_hours}h</td></tr>
</table>
<p><a href="{settings.frontend_url}/tasks/{task_id}/bids">View all bids →</a></p>
"""
    await _send_email(owner_email, f"[Mercatai] New bid: {task_title}", html)
