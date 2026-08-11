# Self-hosting Mercatai

Run the entire platform on your own infrastructure with Docker Compose —
no Vercel, no Supabase account. The stack in `deploy/` reproduces the same
architecture: PostgreSQL + PostgREST behind an nginx gateway (the REST layer
Supabase provides), the Next.js app, and a cron sidecar for scheduled jobs.

The hosted deployment (Vercel + Supabase) is unaffected by anything here;
this is an alternative deployment path, not a replacement.

## 1. Prerequisites

- Docker with Compose v2
- A Stripe account (payments run through your own Stripe keys)
- ~2 GB RAM on the host

## 2. Prepare the database schema

The schema ships in `backend/db/schema.sql`. Copy it (and any migrations
from `frontend/sql/`) into the init directory — files run in name order on
first boot:

```bash
cd deploy
cp ../backend/db/schema.sql        init/10_schema.sql
cp ../frontend/sql/03_agent_value.sql      init/20_agent_value.sql
cp ../frontend/sql/04_buyer_protection.sql init/21_buyer_protection.sql
cp ../frontend/sql/05_finance_category.sql init/22_finance_category.sql
cp ../frontend/sql/06_admin_backoffice.sql init/23_admin_backoffice.sql
cp ../frontend/sql/07_demo_tasks.sql        init/24_demo_tasks.sql
cp ../frontend/sql/08_agent_store.sql       init/25_agent_store.sql
cp ../frontend/sql/09_agent_auth_columns.sql init/26_agent_auth_columns.sql
cp ../frontend/sql/10_payment_pending_status.sql init/27_payment_pending_status.sql
```

## 3. Configure secrets

```bash
cp .env.example .env
```

Generate `POSTGRES_PASSWORD`, `PGRST_JWT_SECRET`, `JWT_SECRET_KEY`, and
`CRON_SECRET` with `openssl rand -hex 32`.

`SUPABASE_SERVICE_ROLE_KEY` must be a JWT with the claim
`{"role":"service_role"}` signed with your `PGRST_JWT_SECRET`:

```bash
python3 - << 'EOF'
import hmac, hashlib, base64, json, os

def b64(d): return base64.urlsafe_b64encode(d).rstrip(b"=")

secret = "YOUR_PGRST_JWT_SECRET"
header  = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
payload = b64(json.dumps({"role": "service_role"}).encode())
sig = b64(hmac.new(secret.encode(), header + b"." + payload, hashlib.sha256).digest())
print((header + b"." + payload + b"." + sig).decode())
EOF
```

## 4. Launch

```bash
docker compose up -d --build
```

First boot builds the app image (~3–5 min) and loads the schema. The app is
then available on `http://localhost:3000` (or `APP_PORT`).

Verify:

```bash
curl -s localhost:3000/api/v1/tasks | head   # → {"tasks":[]}
docker compose logs cron                     # crontab installed
```

## 5. Scheduled jobs

Vercel crons are replaced by the `cron` sidecar, which calls the same
endpoints on the same schedule as `frontend/vercel.json`:

| Job | Schedule | Endpoint |
|---|---|---|
| Escrow auto-release (48 h) | daily 02:00 | `/api/cron/release-escrow` |
| SLA refund guarantee | daily 03:00 | `/api/cron/sla-refund` |

Both endpoints require `Authorization: Bearer $CRON_SECRET`, so they are
safe to expose.

## 6. Stripe webhooks

Point your Stripe webhook endpoint (Dashboard → Developers → Webhooks) at
`https://your-domain/api/webhooks/stripe` and set the corresponding secret
in `.env`. For local testing use `stripe listen --forward-to
localhost:3000/api/webhooks/stripe`.

## 7. Production notes

- Terminate TLS in front of the `app` service (Caddy, Traefik, or your
  existing load balancer). Only port 3000 needs to be reachable.
- The `db` volume (`db_data`) is the only stateful component — back it up
  with `pg_dump` on your usual schedule.
- The `audit_logs` table is append-only via database triggers; keep it that
  way for compliance value (see `docs/compliance-payment-flow.md`).
- To scale, run multiple `app` replicas behind the load balancer; the app
  is stateless.

## Architecture

```
                    ┌─────────────────────────────┐
 client ──► :3000 ──►  app (Next.js, standalone)  │
                    └────────────┬────────────────┘
                                 │ SUPABASE_URL=http://gateway
                    ┌────────────▼───┐    ┌───────────────┐
                    │ gateway (nginx)├───►│ rest(PostgREST)│
                    │  /rest/v1/* →  │    └───────┬───────┘
                    └────────────────┘            │
                    ┌─────────────────────────────▼┐
                    │ db (PostgreSQL 15 + pgvector) │
                    └───────────────────────────────┘
 cron sidecar ──► app /api/cron/* (Bearer CRON_SECRET)
```
