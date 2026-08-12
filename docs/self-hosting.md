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

## 2. Database schema

Nothing to prepare. `docker-compose.yml` mounts `backend/db/schema.sql` and
the migrations in `frontend/sql/` straight into the database container's
init directory, so a fresh clone is ready to boot and there is only ever
one copy of each file to maintain.

> **These scripts run only on an empty data volume.** Postgres executes
> `/docker-entrypoint-initdb.d/*` on first initialisation and never again.
> An installation that is already running must apply new migrations by
> hand, for example:
>
> ```bash
> docker compose exec -T db psql -U postgres -d mercatai \
>   -f - < ../frontend/sql/10_payment_pending_status.sql
> ```
>
> To start over from scratch instead, `docker compose down -v` drops the
> volume — and with it all data.

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

> **Never paste `docker compose config` output into an issue, a chat or a
> pull request.** It interpolates `.env` and prints every secret in full —
> database password, JWT keys, `SUPABASE_SERVICE_ROLE_KEY` and your Stripe
> keys. Use `docker compose config --quiet` (validation only, no output) when
> you just want to check the file parses.

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

Payments only move out of the `pending` state when Stripe confirms them, so
this endpoint is required — without it every payment stalls.

Register an endpoint (Dashboard → Developers → Webhooks) at
`https://your-domain/api/v1/payments/stripe-webhook` subscribed to:

- `payment_intent.amount_capturable_updated`
- `payment_intent.processing`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`

Put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET` (it is
per-endpoint, not per-account) and the publishable key in
`STRIPE_PUBLISHABLE_KEY`, or the payment form will not load.

For local testing:

```bash
stripe listen --forward-to localhost:3000/api/v1/payments/stripe-webhook
```

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
