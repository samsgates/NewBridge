CREATE TABLE IF NOT EXISTS nb_audit_events (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS nb_idempotency (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS nb_approvals (
  id text PRIMARY KEY,
  actor text NOT NULL,
  connection text NOT NULL,
  table_name text NOT NULL,
  operation text NOT NULL,
  payload jsonb,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
