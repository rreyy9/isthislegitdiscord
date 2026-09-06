-- One-time setup on the real PostgreSQL service.
-- Creates a dedicated application role and database so the app never uses the
-- postgres superuser. Run once as the postgres superuser:
--
--   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f prisma\setup-postgres.sql
--
-- It will prompt for the postgres password you set during installation.
--
-- The installer passes a generated password instead:
--
--   psql -U postgres -v app_password=<generated> -f setup-postgres.sql
--
-- so an installed server does not share a credential with every other copy of
-- this repository. Run by hand with no variable, it falls back to the
-- development password below -- which is published in this repository and is
-- therefore only ever appropriate for a local dev database.
\if :{?app_password}
\else
  \set app_password 'chat_app_local_dev_pw'
\endif

-- Dedicated login role for the app, created if missing and its password set
-- either way. The password is interpolated through quote_literal rather than
-- pasted in, and the statement is built as text because psql does not
-- substitute variables inside a dollar-quoted DO block.
SELECT 'CREATE ROLE chat_app LOGIN PASSWORD ' || quote_literal(:'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chat_app')\gexec

-- Always applied, so a re-run repairs a role whose password has drifted from
-- what DATABASE_URL believes. On an upgrade the installer passes the password
-- it read back out of the existing .env, making this a no-op.
SELECT 'ALTER ROLE chat_app WITH PASSWORD ' || quote_literal(:'app_password')\gexec

-- Dedicated database, owned by that role.
SELECT 'CREATE DATABASE chat OWNER chat_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'chat')\gexec

-- Make sure the role can use the public schema on a fresh database.
\connect chat
GRANT ALL ON SCHEMA public TO chat_app;
ALTER SCHEMA public OWNER TO chat_app;
