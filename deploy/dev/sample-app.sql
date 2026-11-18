-- A small database with the real Acme column names, so the Database page and task rows can be tried locally. Never used in production.
CREATE TYPE task_state AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED', 'SKIPPED');
CREATE TABLE account (id text PRIMARY KEY, name text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, "adminRole" text NOT NULL, "accountId" text REFERENCES account(id), "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE task (id text PRIMARY KEY, kind text NOT NULL, key text NOT NULL, state task_state NOT NULL, attempts int NOT NULL DEFAULT 0, "accountId" text REFERENCES account(id), "runAt" timestamptz NOT NULL, payload jsonb, result jsonb, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX task_due_idx ON task ("runAt", id) WHERE state = 'QUEUED';
CREATE INDEX task_kind_state_idx ON task (kind, state);
CREATE TABLE feature_flag (key text PRIMARY KEY, enabled boolean NOT NULL);
CREATE TABLE feature_flag_change (key text NOT NULL, enabled boolean NOT NULL, "previousEnabled" boolean, reason text, "userId" text, "createdAt" timestamptz NOT NULL DEFAULT now());

INSERT INTO account (id, name) VALUES ('acc_meridien', 'Institut Méridien'), ('acc_horizon', 'Formation Horizon'), ('acc_lingua', 'Lingua Campus'), ('acc_atelier', 'Atelier Langues');
INSERT INTO "user" (id, name, email, "adminRole", "accountId") VALUES
  ('usr_01j8c2', 'Camille Durand', 'c.durand@example.com', 'OWNER', 'acc_meridien'),
  ('usr_01j9f7', 'Hugo Martin', 'h.martin@example.com', 'ADMIN', 'acc_horizon'),
  ('usr_01jb31', 'Léa Bernard', 'l.bernard@example.com', 'MANAGER', 'acc_lingua'),
  ('usr_01jd88', 'Nadia Roche', 'n.roche@example.com', 'CLIENT', 'acc_atelier'),
  ('usr_01jd92', 'Malik Benali', 'm.benali@example.com', 'MANAGER', 'acc_meridien');
INSERT INTO task (id, kind, key, state, attempts, "accountId", "runAt", payload)
SELECT 'tsk_db_' || g,
  (ARRAY['parcelo.ship', 'paynest.payment.ingest', 'receipts.email', 'invoxa.invoices.sync'])[1 + g % 4],
  'order:01jc' || g,
  (ARRAY['DONE', 'DONE', 'DONE', 'FAILED', 'QUEUED', 'RUNNING', 'DONE', 'CANCELLED']::task_state[])[1 + g % 8],
  g % 3,
  (ARRAY['acc_meridien', 'acc_horizon', 'acc_lingua', 'acc_atelier'])[1 + g % 4],
  now() + (g % 40 - 30) * interval '1 minute',
  jsonb_build_object('topic', 'registrations', 'retries', g % 3)
FROM generate_series(1, 400) g;
INSERT INTO feature_flag VALUES ('parcelo.ship', true), ('parcelo.read', true), ('paynest.read', true), ('paynest.customers', true), ('receipts.email', true), ('tax.declare', true), ('invoxa.customers', true), ('invoxa.invoices', true), ('pipedeck.companies', false), ('company.register', true), ('webhooks.send', true);
CREATE ROLE vigie_ro LOGIN PASSWORD 'vigie_ro';
GRANT USAGE ON SCHEMA public TO vigie_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vigie_ro;
