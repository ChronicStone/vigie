-- The role Vigie reads the app's database with. Run as a superuser, and again after each migration:
-- a new table or column stays unreadable until then, which is the safe way round.
--   psql "$DATABASE_URL" -v password="'choose-one'" -f deploy/app-readonly.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vigie_ro') THEN CREATE ROLE vigie_ro LOGIN; END IF;
END $$;
ALTER ROLE vigie_ro PASSWORD :password;
ALTER ROLE vigie_ro SET default_transaction_read_only = on;
ALTER ROLE vigie_ro SET statement_timeout = '30s';
ALTER ROLE vigie_ro CONNECTION LIMIT 5;
GRANT USAGE ON SCHEMA public TO vigie_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vigie_ro;
DO $$
DECLARE row record;
BEGIN
  FOR row IN
    SELECT table_name, string_agg(quote_ident(column_name), ', ') AS columns
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      -- Keep this list the same as SECRET_COLUMN in server/lib/appdb.ts.
      AND NOT (column_name ~* '(password|passwd|secret|token|hash|otp|credential|api_?key|private_?key|salt|secure_?code|webdoc)'
               AND column_name !~* '(expires_?at|revoked_?at|access_?mode)$')
      AND table_name <> 'verification'
    GROUP BY table_name
  LOOP
    EXECUTE format('GRANT SELECT (%s) ON %I TO vigie_ro', row.columns, row.table_name);
  END LOOP;
END $$;
