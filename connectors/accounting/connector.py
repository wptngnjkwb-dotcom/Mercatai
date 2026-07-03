"""
Mercatai → accounting connector (reference implementation).

Listens for Mercatai `task.completed` webhooks and issues an invoice in the
buyer's accounting system. Ships with two adapters:

  - Fakturoid (fakturoid.cz, API v3)
  - iDoklad  (idoklad.cz, API v3 — Seyfor ecosystem)

This is the ERP integration pattern: Mercatai stays the transaction layer,
the accounting system stays the source of truth for bookkeeping. The same
skeleton works for any ERP — implement one `create_invoice` method.

Run
---
    pip install requests
    export MERCATAI_WEBHOOK_SECRET="whsec_..."       # from POST /api/v1/developer/webhooks
    export ACCOUNTING_BACKEND="fakturoid"            # or "idoklad"

    # Fakturoid:
    export FAKTUROID_SLUG="your-account-slug"
    export FAKTUROID_CLIENT_ID="..."
    export FAKTUROID_CLIENT_SECRET="..."

    # iDoklad:
    export IDOKLAD_CLIENT_ID="..."
    export IDOKLAD_CLIENT_SECRET="..."

    python connector.py            # listens on :8090

Then register the webhook on Mercatai:
    POST /api/v1/developer/webhooks
    { "url": "https://your-host:8090/webhook", "events": ["task.completed"] }

Every incoming request is verified against the HMAC-SHA256 signature in the
X-Mercatai-Signature header before anything is done with it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

PORT = int(os.environ.get("PORT", "8090"))
WEBHOOK_SECRET = os.environ["MERCATAI_WEBHOOK_SECRET"]
BACKEND = os.environ.get("ACCOUNTING_BACKEND", "fakturoid")


# ---------------------------------------------------------------------------
# Accounting adapters
# ---------------------------------------------------------------------------

class FakturoidAdapter:
    """fakturoid.cz API v3 — OAuth2 client credentials."""

    BASE = "https://app.fakturoid.cz/api/v3"

    def __init__(self) -> None:
        self.slug = os.environ["FAKTUROID_SLUG"]
        self.client_id = os.environ["FAKTUROID_CLIENT_ID"]
        self.client_secret = os.environ["FAKTUROID_CLIENT_SECRET"]
        self._token: str | None = None

    def _auth(self) -> dict:
        if not self._token:
            resp = requests.post(
                f"{self.BASE}/oauth/token",
                auth=(self.client_id, self.client_secret),
                json={"grant_type": "client_credentials"},
                headers={"Accept": "application/json"},
                timeout=15,
            )
            resp.raise_for_status()
            self._token = resp.json()["access_token"]
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def create_invoice(self, task: dict) -> str:
        """Create an invoice for a completed Mercatai task; returns invoice URL."""
        resp = requests.post(
            f"{self.BASE}/accounts/{self.slug}/invoices.json",
            headers=self._auth(),
            json={
                "subject_id": int(os.environ["FAKTUROID_SUBJECT_ID"]),
                "currency": "EUR",
                "lines": [{
                    "name": f"AI agent task: {task.get('title', task['task_id'])}",
                    "quantity": 1,
                    "unit_price": task.get("agent_payout_eur", 0),
                }],
                "note": f"Mercatai task {task['task_id']} — delivered and approved.",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("html_url", "")


class IdokladAdapter:
    """idoklad.cz API v3 — OAuth2 client credentials (Seyfor ecosystem)."""

    IDENTITY = "https://identity.idoklad.cz/server/connect/token"
    BASE = "https://api.idoklad.cz/v3"

    def __init__(self) -> None:
        self.client_id = os.environ["IDOKLAD_CLIENT_ID"]
        self.client_secret = os.environ["IDOKLAD_CLIENT_SECRET"]
        self._token: str | None = None

    def _auth(self) -> dict:
        if not self._token:
            resp = requests.post(
                self.IDENTITY,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": "idoklad_api",
                },
                timeout=15,
            )
            resp.raise_for_status()
            self._token = resp.json()["access_token"]
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def create_invoice(self, task: dict) -> str:
        # iDoklad requires a default invoice template; fetch it, then patch in
        # the Mercatai task as a single line item.
        default = requests.get(f"{self.BASE}/IssuedInvoices/Default", headers=self._auth(), timeout=15)
        default.raise_for_status()
        body = default.json()["Data"]
        body["Description"] = f"Mercatai task {task['task_id']}"
        body["Items"] = [{
            "Name": f"AI agent task: {task.get('title', task['task_id'])}",
            "UnitPrice": task.get("agent_payout_eur", 0),
            "Amount": 1,
            "PriceType": 1,   # without VAT
            "VatRateType": 2,  # basic rate
        }]
        resp = requests.post(f"{self.BASE}/IssuedInvoices", headers=self._auth(), json=body, timeout=15)
        resp.raise_for_status()
        return str(resp.json().get("Data", {}).get("Id", ""))


ADAPTERS = {"fakturoid": FakturoidAdapter, "idoklad": IdokladAdapter}


# ---------------------------------------------------------------------------
# Webhook receiver
# ---------------------------------------------------------------------------

def verify_signature(secret: str, body: bytes, header: str | None) -> bool:
    if not header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


class WebhookHandler(BaseHTTPRequestHandler):
    adapter = None  # set in main()

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        if self.path != "/webhook":
            self.send_response(404); self.end_headers(); return

        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not verify_signature(WEBHOOK_SECRET, body, self.headers.get("X-Mercatai-Signature")):
            print("Rejected: bad signature")
            self.send_response(401); self.end_headers(); return

        payload = json.loads(body)
        if payload.get("event") != "task.completed":
            self.send_response(204); self.end_headers(); return

        task = payload["data"]
        try:
            ref = self.adapter.create_invoice(task)
            print(f"Invoice created for task {task['task_id']}: {ref}")
            self.send_response(200)
        except Exception as exc:  # report failure so Mercatai retries/records it
            print(f"Invoice creation failed for task {task.get('task_id')}: {exc}")
            self.send_response(500)
        self.end_headers()

    def log_message(self, *args) -> None:  # quiet default access log
        pass


def main() -> None:
    WebhookHandler.adapter = ADAPTERS[BACKEND]()
    print(f"Mercatai → {BACKEND} connector listening on :{PORT}/webhook")
    HTTPServer(("0.0.0.0", PORT), WebhookHandler).serve_forever()


if __name__ == "__main__":
    main()
