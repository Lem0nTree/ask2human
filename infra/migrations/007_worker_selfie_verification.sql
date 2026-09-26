-- Worker identity cutover to the World ID 4 Selfie Check credential.
-- Existing VERIFIED rows intentionally remain untouched. Their nullable
-- provenance fields keep historical settlement access while making them
-- ineligible for current worker enrollment until they reverify.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS idkit_verified_environment text,
  ADD COLUMN IF NOT EXISTS idkit_credential text,
  ADD COLUMN IF NOT EXISTS idkit_credential_schema integer,
  ADD COLUMN IF NOT EXISTS idkit_sybil_score bigint,
  ADD COLUMN IF NOT EXISTS idkit_action text;

ALTER TABLE idkit_challenges
  ADD COLUMN IF NOT EXISTS expected_rp_id text;

ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_idkit_provenance_check;
ALTER TABLE workers ADD CONSTRAINT workers_idkit_provenance_check CHECK (
  (
    idkit_verified_environment IS NULL
    AND idkit_credential IS NULL
    AND idkit_credential_schema IS NULL
    AND idkit_sybil_score IS NULL
    AND idkit_action IS NULL
  )
  OR (
    idkit_verified_environment IN ('production', 'staging', 'sandbox')
    AND idkit_credential = 'selfie'
    AND idkit_credential_schema = 11
    AND idkit_action IS NOT NULL
    AND length(btrim(idkit_action)) > 0
  )
);

CREATE INDEX IF NOT EXISTS workers_current_world_verification_idx
  ON workers (idkit_verified_environment, idkit_credential, idkit_credential_schema, idkit_action)
  WHERE status = 'VERIFIED' AND idkit_verified_at IS NOT NULL;
