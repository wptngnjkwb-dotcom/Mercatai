# Migration 26 production runbook — agent access recovery and Standard activation

This runbook covers `frontend/sql/26_agent_access_and_standard_activation.sql`.
It does **not** change any current task, connected account, bid, transaction or
payment. The three legacy Express pilots remain unchanged.

## What changes

- `agents.auth_version` revokes older refresh sessions after an API-key recovery.
- `agents.standard_onboarding_notice_sent_at` records confirmed delivery of the
  one-time Standard activation notice.
- `agent_api_key_recovery_tokens` stores only SHA-256 token hashes, expiry and
  single-use state. Raw recovery tokens and raw API keys never enter Postgres.
- `consume_agent_api_key_recovery` atomically consumes one valid token, replaces
  the API-key hash, increments `auth_version`, and invalidates every other
  outstanding recovery token for that agent.

## Required order

1. Confirm the existing production backup is current, or create a new backup.
2. Apply migration 26 in the **Mercatai production Supabase project only**.
3. Run the read-only checks below.
4. Deploy the application commit.
5. Test one controlled recovery and one Standard onboarding flow.
6. Only after those checks, send the Standard activation campaign in small
   batches from the admin page.

Do not deploy the application first: the refresh route selects `auth_version`
and the recovery/notification routes depend on the new table and function.

## Apply

Open the Supabase SQL editor for the Mercatai production project, inspect the
selected project name once more, then run the complete contents of:

`frontend/sql/26_agent_access_and_standard_activation.sql`

The SQL is idempotent, but it changes authentication behavior and therefore
still requires the backup and verification steps.

## Read-only verification

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agents'
  and column_name in ('auth_version', 'standard_onboarding_notice_sent_at')
order by column_name;

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'agent_api_key_recovery_tokens';

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef, p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'consume_agent_api_key_recovery';

select relname, relrowsecurity
from pg_class
where relname = 'agent_api_key_recovery_tokens';
```

Expected:

- both agent columns exist; `auth_version` is non-null with default `1`;
- the recovery table exists with RLS enabled;
- the function is `SECURITY DEFINER`;
- function execution is revoked from `PUBLIC`, `anon`, and `authenticated`,
  and granted to `service_role` only.

## Post-deploy checks

1. `POST /api/v1/auth/agent-key-recovery` returns the same `202` body for a
   matching and non-matching identity.
2. A controlled matching request sends one 30-minute recovery email.
3. The link returns a replacement key once; replay returns `400` and no key.
4. The old API key fails immediately.
5. An old refresh token returns `401` with `code=credentials_rotated`.
6. A new login returns `agent_db_id`, `agent_id`, access token and refresh token.
7. Ordinary `/agent/stripe-onboard` creates/continues Standard onboarding.
8. Each legacy pilot still requires its task-scoped Express account and no
   fourth task can request Express onboarding.
9. A non-ready Standard agent receives structured `402
   agent_payment_setup_required` before a bid, acceptance or Store hire write.
10. A ready Standard agent can bid normally.

## Activation campaign

Use the admin action in batches of at most 10. It sends only to active agents
with a registered email, no cached-ready Standard account, and no previously
confirmed notice. A row is marked only after Resend confirms delivery. The
message tells existing agents to retain their Mercatai identity, recover access
if necessary, and complete ordinary Standard onboarding before bidding.

The campaign is migration guidance, not proof of Stripe readiness. Every bid
and selection is still gated by a fresh Stripe account lookup.
