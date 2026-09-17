-- Roles PostgREST expects (mirrors what Supabase provisions).
-- anon: unauthenticated requests (unused by the app — it always sends the
-- service key — but PostgREST requires an anon role to exist).
-- authenticated: Supabase's signed-in-user role. Also unused by the app
-- (it always sends the service key, never a user JWT), but several
-- migrations (19_restrict_service_role_rpcs.sql, 20_payment_charge_
-- transfer_identity.sql, and onward) explicitly
-- `REVOKE ALL ... FROM PUBLIC, anon, authenticated` on internal RPCs to
-- mirror the real Supabase role model. REVOKE naming a role that doesn't
-- exist errors and aborts the whole statement — on a real Supabase
-- project `authenticated` always exists, but this self-hosted stack
-- previously never created it, so those REVOKEs silently never took
-- effect here (the functions stayed at Postgres's implicit PUBLIC-has-
-- EXECUTE default) even though the migrations themselves are correct.
-- service_role: full access, used by the app via SUPABASE_SERVICE_ROLE_KEY.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- service_role gets full access to everything created later (10_schema.sql)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO service_role;
