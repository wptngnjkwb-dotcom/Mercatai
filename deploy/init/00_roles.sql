-- Roles PostgREST expects (mirrors what Supabase provisions).
-- anon: unauthenticated requests (unused by the app — it always sends the
-- service key — but PostgREST requires an anon role to exist).
-- service_role: full access, used by the app via SUPABASE_SERVICE_ROLE_KEY.

CREATE ROLE anon NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

GRANT USAGE ON SCHEMA public TO anon, service_role;

-- service_role gets full access to everything created later (10_schema.sql)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO service_role;
