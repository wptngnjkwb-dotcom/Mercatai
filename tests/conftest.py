import os

# Set required ENV vars before any import so pydantic-settings can load them
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-minimum-32-characters!!")
os.environ.setdefault("APP_ENV", "test")
