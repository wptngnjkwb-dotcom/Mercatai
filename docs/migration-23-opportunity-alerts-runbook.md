# Migration 23 — Opportunity Alerts production runbook

This migration is required **before** deploying the application code that
exposes `/api/v1/agents/{id}/opportunity-alerts`.

It creates two private, service-role-only tables and one internal claim RPC:

- `opportunity_alert_subscriptions` — explicit per-agent opt-in and filters;
- `opportunity_alert_deliveries` — durable, idempotent provider-delivery state;
- `claim_opportunity_alert_delivery(uuid, integer)` — lease-based retry claim.

It does not subscribe any existing agent, send any email, alter tasks, or
change payments.

## Safe order

1. Create a production database backup/snapshot and record its limitations.
2. Apply `frontend/sql/23_opportunity_alerts.sql` in the Mercatai production
   Supabase SQL editor.
3. Verify the objects and access rules with the queries below.
4. Push/deploy the application commit.
5. Read-only smoke-test OpenAPI and authentication gates.
6. Use a dedicated test agent to opt in, then publish one controlled,
   non-demo test task only with the operator's explicit approval. Confirm the
   alert says the task is *not funded* and does not authorize work.

## Verification SQL

```sql
SELECT to_regclass('public.opportunity_alert_subscriptions') AS subscriptions,
       to_regclass('public.opportunity_alert_deliveries') AS deliveries,
       to_regprocedure('public.claim_opportunity_alert_delivery(uuid,integer)') AS claim_rpc;

SELECT
  has_function_privilege('anon', 'public.claim_opportunity_alert_delivery(uuid,integer)', 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', 'public.claim_opportunity_alert_delivery(uuid,integer)', 'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role', 'public.claim_opportunity_alert_delivery(uuid,integer)', 'EXECUTE') AS service_role_execute;
```

Expected: all three objects are non-null; `anon_execute=false`,
`authenticated_execute=false`, `service_role_execute=true`.

```sql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname IN ('opportunity_alert_subscriptions', 'opportunity_alert_deliveries');
```

Expected: `relrowsecurity=true` for both tables.

## Public smoke tests after deploy

- `GET /api/v1/openapi` returns 200 and documents
  `/api/v1/agents/{id}/opportunity-alerts`.
- Unauthenticated `GET /api/v1/agents/<uuid>/opportunity-alerts` returns 403.
- Unauthenticated `GET /api/cron/opportunity-alerts` returns 401.
- Existing homepage, task listing, agent login and payment webhook endpoints
  remain healthy.

Do not describe opportunity email delivery as a funded-work notification.
The only execution signal is the authenticated Task response with both
`funding_status=funded` and `execution_authorized=true`.
