# Production runbook — migration 24 (Standard accounts by default)

This migration changes the connected-account responsibility model for future
payments. Apply it before deploying the matching application code.

## Intended result

- Every task defaults to `standard_agent_liability`.
- Only these three existing pilot tasks remain
  `legacy_express_platform_liability`:
  - `e427ab6c-62fa-473f-8e84-93003b13a47f`
  - `49a315bc-70ea-409d-b46d-d60ac369e23a`
  - `2ee876c6-ebc7-489e-b138-306ecdb32eaf`
- Existing Express account IDs are preserved. They are not converted or
  copied into Standard fields.
- Existing agents add a separate Standard account by completing ordinary
  onboarding without a `task_id`.
- A client cannot select Express. The task-scoped exception is resolved from
  server data and requires the exact assigned pilot task.

## Safe deployment order

1. Create and verify a production database backup.
2. Record read-only pre-migration counts for agents, tasks and transactions.
3. Apply `frontend/sql/24_standard_accounts_and_pilot_express.sql` in the
   Mercatai production Supabase project.
4. Run the verification queries below.
5. In Vercel, set both `STRIPE_CONNECT_ENABLED_COUNTRIES` and
   `STRIPE_DIRECT_CHARGE_COUNTRIES` to the reviewed Standard rollout list:
   `AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,LI,NO,GB`.
   This deliberately adds HR/LI and removes IS from the old Express-derived
   value. The three pilot Express tasks remain task-scoped and server-gated.
6. Deploy the application commit.
7. Confirm public Task responses expose `stripe_account_requirement` and
   ordinary onboarding reports `stripe_account_type=standard`.
8. Create one isolated Stripe test-mode Standard account and verify card,
   refund/dispute and payout handling before announcing the model broadly.

Do not deploy the code first: it reads the new columns and calls
`bind_payment_charge_context_v2`.

## Verification SQL

```sql
select count(*) as standard_accounts
from agents
where stripe_standard_account_id is not null;

select id, stripe_account_requirement
from tasks
where stripe_account_requirement = 'legacy_express_platform_liability'
order by id;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname in (
  'tasks_stripe_account_requirement_check',
  'tasks_legacy_express_pilot_only_check',
  'transactions_stripe_account_requirement_check'
)
order by conname;

select p.proname, p.proacl
from pg_proc p
where p.proname = 'bind_payment_charge_context_v2';
```

Expected immediately after migration:

- `standard_accounts` may be zero; Standard accounts are created only after
  the holder starts ordinary onboarding.
- the legacy task query returns exactly the three IDs above;
- all three constraints exist;
- the RPC is executable only by `service_role`, not `PUBLIC`, `anon` or
  `authenticated`.

## Rollback boundary

Do not drop the Standard columns or RPC once a Standard account or a payment
with `stripe_account_requirement=standard_agent_liability` exists. A code
rollback must continue to understand both account columns and the frozen
transaction requirement.
