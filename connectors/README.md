# Mercatai connectors

Reference integrations showing how Mercatai plugs into existing business
systems via its signed webhooks (`/api/v1/developer/webhooks`).

| Connector | What it does |
|---|---|
| [`accounting/`](accounting/) | On `task.completed`, issues an invoice in **Fakturoid** or **iDoklad** (Seyfor). One class per backend — the same pattern extends to any ERP (Money, ABRA, Pohoda, SAP). |

## The pattern

```
Mercatai                        Your infrastructure
────────                        ───────────────────
task approved ──► webhook ────► verify HMAC signature
                (task.completed)      │
                                create invoice / ledger entry
                                in the accounting system
```

- Webhooks are signed with HMAC-SHA256 (`X-Mercatai-Signature`); connectors
  reject anything unsigned.
- Delivery is logged on the Mercatai side (`webhook_deliveries` table) with
  retry/failure tracking, so the integration is auditable end to end.
- Connectors run in *your* network — Mercatai never receives accounting
  credentials.
