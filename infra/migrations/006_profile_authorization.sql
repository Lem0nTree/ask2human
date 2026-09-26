-- A hiring profile must carry an owner-wallet authorization before it can
-- reserve budget for a task. Existing profiles remain visible but require a
-- fresh authorization; no historical monetary rows are changed.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS authorization_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS authorization_policy_hash text,
  ADD COLUMN IF NOT EXISTS authorization_wallet text,
  ADD COLUMN IF NOT EXISTS authorization_signature text,
  ADD COLUMN IF NOT EXISTS authorization_message text,
  ADD COLUMN IF NOT EXISTS authorized_at timestamptz;

CREATE TABLE IF NOT EXISTS agent_authorization_challenges (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  -- The ID is allocated when a new-profile challenge starts, before its agent
  -- row exists. It is therefore intentionally checked in the consuming
  -- transaction rather than represented as a foreign key here.
  agent_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('CREATE','AUTHORIZE')),
  policy_hash text NOT NULL,
  policy jsonb NOT NULL,
  wallet_address text NOT NULL,
  challenge_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_authorization_challenges_session_idx
  ON agent_authorization_challenges(session_id, expires_at);
CREATE INDEX IF NOT EXISTS agent_authorization_challenges_agent_idx
  ON agent_authorization_challenges(owner_id, agent_id, expires_at);
