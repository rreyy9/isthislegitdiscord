-- One-time setup on the real PostgreSQL service.
-- Creates a dedicated application role and database so the app never uses the
-- postgres superuser. Run once as the postgres superuser:
--
--   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f prisma\setup-postgres.sql
--
-- It will prompt for the postgres password you set during installation.

-- Dedicated login role for the app. The password here is a local-development
-- credential, not the superuser password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_app') THEN
    CREATE ROLE chat_app LOGIN PASSWORD 'chat_app_local_dev_pw';
  END IF;
END
$$;

-- Dedicated database, owned by that role.
SELECT 'CREATE DATABASE chat OWNER chat_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'chat')\gexec

-- Make sure the role can use the public schema on a fresh database.
\connect chat
GRANT ALL ON SCHEMA public TO chat_app;
ALTER SCHEMA public OWNER TO chat_app;
