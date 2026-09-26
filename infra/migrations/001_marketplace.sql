CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
  area text NOT NULL CHECK (length(area) BETWEEN 1 AND 100),
  skills text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED')),
  wallet_address text UNIQUE,
  wallet_verified_at timestamptz,
  idkit_nullifier text UNIQUE,
  idkit_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'VERIFIED') = (idkit_nullifier IS NOT NULL AND idkit_verified_at IS NOT NULL)),
  CHECK ((wallet_address IS NULL) = (wallet_verified_at IS NULL))
);

CREATE TABLE IF NOT EXISTS owners (
  id uuid PRIMARY KEY,
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  wallet_address text UNIQUE,
  wallet_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject),
  CHECK ((wallet_address IS NULL) = (wallet_verified_at IS NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS idkit_challenges (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  expected_nonce text NOT NULL,
  expected_action text NOT NULL,
  expected_environment text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idkit_challenges_worker_idx ON idkit_challenges(worker_id, expires_at);

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('worker','owner','recover_worker','recover_owner')),
  address text NOT NULL,
  challenge_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_challenges_expiry_idx ON wallet_challenges(expires_at);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  api_key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  categories text[] NOT NULL CHECK (cardinality(categories) > 0),
  max_task_mist bigint NOT NULL CHECK (max_task_mist > 0),
  total_budget_mist bigint NOT NULL CHECK (total_budget_mist >= max_task_mist),
  reserved_mist bigint NOT NULL DEFAULT 0 CHECK (reserved_mist >= 0),
  spent_mist bigint NOT NULL DEFAULT 0 CHECK (spent_mist >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (spent_mist + reserved_mist <= total_budget_mist)
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  brief text NOT NULL CHECK (length(brief) BETWEEN 1 AND 4000),
  category text NOT NULL,
  area text NOT NULL CHECK (length(area) BETWEEN 1 AND 120),
  rubric jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_mist bigint NOT NULL CHECK (amount_mist > 0),
  deadline timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ASSIGNED','FUNDING','FUNDED','SUBMITTED','REVIEW','PAID','REFUNDED','CANCELLED')),
  assigned_worker_id uuid REFERENCES workers(id),
  job_id text UNIQUE,
  funding_digest text UNIQUE,
  submission_digest text UNIQUE,
  release_digest text UNIQUE,
  refund_digest text UNIQUE,
  commitment_hash text,
  review_decision text CHECK (review_decision IN ('ACCEPT','REQUEST_REVIEW')),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('OPEN','CANCELLED')) = (assigned_worker_id IS NULL))
);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks(state, category, deadline) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_worker_idx ON tasks(assigned_worker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  kind text NOT NULL CHECK (kind IN ('HIRE','RELEASE')),
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','ISSUED','CONSUMED','DENIED','EXPIRED')),
  amount_mist bigint NOT NULL CHECK (amount_mist > 0),
  worker_id uuid NOT NULL REFERENCES workers(id),
  worker_wallet text NOT NULL,
  owner_wallet text NOT NULL,
  expires_at timestamptz NOT NULL,
  consented_at timestamptz,
  transaction_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_active_per_task_kind_idx
  ON approvals(task_id, kind) WHERE status IN ('PENDING','APPROVED','ISSUED');

CREATE TABLE IF NOT EXISTS oidc_flows (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('owner_login','protected_approval')),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES owners(id) ON DELETE CASCADE,
  approval_id uuid REFERENCES approvals(id) ON DELETE CASCADE,
  issued_at_epoch bigint NOT NULL,
  transaction_expires_at_epoch bigint NOT NULL,
  max_age_seconds integer NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'protected_approval') = (approval_id IS NOT NULL AND owner_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS oidc_flows_expiry_idx ON oidc_flows(expires_at);

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id),
  object_key text NOT NULL UNIQUE,
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 4194304),
  sha256 text NOT NULL,
  report text NOT NULL CHECK (length(report) BETWEEN 1 AND 5000),
  commitment_hash text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlements (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('testnet','mainnet','devnet','localnet')),
  package_id text NOT NULL,
  coin_type text NOT NULL,
  amount_mist bigint NOT NULL CHECK (amount_mist > 0),
  funder_wallet text NOT NULL,
  worker_wallet text NOT NULL,
  brief_hash text NOT NULL,
  deadline timestamptz NOT NULL,
  job_id text UNIQUE,
  funding_digest text UNIQUE,
  submission_digest text UNIQUE,
  release_digest text UNIQUE,
  refund_digest text UNIQUE,
  submit_transaction_json jsonb,
  refund_transaction_json jsonb,
  status text NOT NULL CHECK (status IN ('FUNDING','FUNDED','SUBMITTED','PAID','REFUNDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id uuid,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  safe_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_task_idx ON audit_events(task_id, created_at DESC);

CREATE OR REPLACE FUNCTION groundwork_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workers_touch_updated_at ON workers;
CREATE TRIGGER workers_touch_updated_at BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
DROP TRIGGER IF EXISTS owners_touch_updated_at ON owners;
CREATE TRIGGER owners_touch_updated_at BEFORE UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
DROP TRIGGER IF EXISTS agents_touch_updated_at ON agents;
CREATE TRIGGER agents_touch_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
DROP TRIGGER IF EXISTS tasks_touch_updated_at ON tasks;
CREATE TRIGGER tasks_touch_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
DROP TRIGGER IF EXISTS approvals_touch_updated_at ON approvals;
CREATE TRIGGER approvals_touch_updated_at BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
DROP TRIGGER IF EXISTS settlements_touch_updated_at ON settlements;
CREATE TRIGGER settlements_touch_updated_at BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
