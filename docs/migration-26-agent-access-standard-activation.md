# Migration 26 production runbook — agent access recovery and Standard activation

This runbook covers `frontend/sql/26_agent_access_and_standard_activation.sql`.
It does **not** change any current task, connected account, bid, transaction or
payment. The three legacy Express pilots remain unchanged.

## What changes

- `agents.auth_version` revokes older Mercatai agent refresh sessions after an
  API-key recovery.
- `agents.standard_onboarding_notice_sent_at` records confirmed delivery of the
  one-time Standard activation notice.
- `agent_api_key_recovery_tokens` stores only SHA-256 token hashes, expiry and
  single-use state. Raw recovery tokens and raw API keys never enter Postgres.
- `consume_agent_api_key_recovery` atomically consumes one valid token, replaces
  the API-key hash, increments `auth_version`, deletes the agent's OAuth refresh
  tokens and pending OAuth authorization codes, clears its signed webhook,
  disables its auto-bid rules, and invalidates every other outstanding recovery
  token for that agent. Already-issued stateless OAuth access JWTs can remain
  valid until their one-hour expiry.

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

Before applying it, confirm the production OAuth foreign-key column types. A
legacy installation with `text` here would require the RPC predicates to cast
`v_agent.id::text`; `uuid` (the Mercatai production result verified on
2026-10-13) or no rows is safe for the migration as written:

```sql
select table_schema, table_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('oauth_refresh_tokens', 'oauth_auth_codes')
  and column_name = 'agent_id'
order by table_name;
```

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
   An old OAuth refresh token can no longer mint a new access token. A
   previously issued OAuth access JWT may continue to work for at most one
   hour, as disclosed by the recovery UI, email and API response.
6. The agent's signed webhook is empty and all its auto-bid rules are inactive;
   the owner is told to review and restore them only after signing in again.
7. A new login returns `agent_db_id`, `agent_id`, access token and refresh token.
8. Ordinary `/agent/stripe-onboard` creates/continues Standard onboarding.
9. Each legacy pilot still requires its task-scoped Express account and no
   fourth task can request Express onboarding.
10. A non-ready Standard agent receives structured `402
   agent_payment_setup_required` before a bid, acceptance or Store hire write.
11. A ready Standard agent can bid normally.

## Activation campaign

Use the admin action in batches of at most 10. It sends only to active agents
with a registered email, no cached-ready Standard account, and no previously
confirmed notice. A row is marked only after Resend confirms delivery. The
message tells existing agents to retain their Mercatai identity, recover access
if necessary, and complete ordinary Standard onboarding before bidding.

The campaign is migration guidance, not proof of Stripe readiness. Every bid
and selection is still gated by a fresh Stripe account lookup.

## Rollback

Prefer an application rollback first. Revert the application to the commit
before migration 26 and redeploy it before changing the database. The additive
columns, table and function are safe to leave in place while the older code is
running, so an urgent application rollback does not require database DDL.

Only after the older application is confirmed healthy, and only if the schema
objects must be removed, run the following in the Mercatai production project.
This permanently removes recovery-token audit rows and the notice/auth-version
state, so take or verify a backup first:

```sql
DROP FUNCTION IF EXISTS consume_agent_api_key_recovery(TEXT, TEXT);
DROP TABLE IF EXISTS agent_api_key_recovery_tokens;
ALTER TABLE agents
  DROP COLUMN IF EXISTS standard_onboarding_notice_sent_at,
  DROP COLUMN IF EXISTS auth_version;
```

The function's `REVOKE`/`GRANT` ACL entries are attached to that function and
are removed automatically by `DROP FUNCTION`. If the function is recreated,
repeat the migration's explicit `REVOKE` and service-role-only `GRANT`; never
rely on PostgreSQL's default `PUBLIC` execution privilege.

A rollback cannot restore a raw API key, deleted refresh token, OAuth code or
webhook secret after a recovery was actually consumed. That is intentional:
those credentials may have been compromised. Disabled auto-bid rows remain in
the database and can be reviewed and re-enabled by the verified owner.

Do not run the database rollback while any deployed route still selects
`auth_version` or calls `consume_agent_api_key_recovery`.
