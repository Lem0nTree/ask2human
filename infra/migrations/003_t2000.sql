-- t2000 cutover. 001 and 002 deliberately remain historical records of the
-- original schema and frozen transaction format.  Existing monetary values
-- are preserved verbatim and tagged as legacy SUI/testnet; only newly-created
-- rows may use mainnet USDC atomic units.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'max_task_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'max_task_atomic') THEN
    ALTER TABLE agents RENAME COLUMN max_task_mist TO max_task_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'total_budget_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'total_budget_atomic') THEN
    ALTER TABLE agents RENAME COLUMN total_budget_mist TO total_budget_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'reserved_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'reserved_atomic') THEN
    ALTER TABLE agents RENAME COLUMN reserved_mist TO reserved_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'spent_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'spent_atomic') THEN
    ALTER TABLE agents RENAME COLUMN spent_mist TO spent_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'amount_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'amount_atomic') THEN
    ALTER TABLE tasks RENAME COLUMN amount_mist TO amount_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'approvals' AND column_name = 'amount_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'approvals' AND column_name = 'amount_atomic') THEN
    ALTER TABLE approvals RENAME COLUMN amount_mist TO amount_atomic;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settlements' AND column_name = 'amount_mist')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settlements' AND column_name = 'amount_atomic') THEN
    ALTER TABLE settlements RENAME COLUMN amount_mist TO amount_atomic;
  END IF;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS asset text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS network text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS decimals smallint;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS legacy_read_only boolean;
UPDATE agents SET asset = 'SUI', network = 'testnet', decimals = 9, legacy_read_only = true
WHERE asset IS NULL OR network IS NULL OR decimals IS NULL OR legacy_read_only IS NULL;
ALTER TABLE agents ALTER COLUMN asset SET DEFAULT 'USDC';
ALTER TABLE agents ALTER COLUMN network SET DEFAULT 'mainnet';
ALTER TABLE agents ALTER COLUMN decimals SET DEFAULT 6;
ALTER TABLE agents ALTER COLUMN legacy_read_only SET DEFAULT false;
ALTER TABLE agents ALTER COLUMN asset SET NOT NULL;
ALTER TABLE agents ALTER COLUMN network SET NOT NULL;
ALTER TABLE agents ALTER COLUMN decimals SET NOT NULL;
ALTER TABLE agents ALTER COLUMN legacy_read_only SET NOT NULL;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_t2000_money_check;
ALTER TABLE agents ADD CONSTRAINT agents_t2000_money_check CHECK (
  (asset = 'USDC' AND network = 'mainnet' AND decimals = 6 AND legacy_read_only = false)
  OR (asset = 'SUI' AND network = 'testnet' AND decimals = 9 AND legacy_read_only = true)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS asset text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS network text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS decimals smallint;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS legacy_read_only boolean;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_window_ms bigint;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reject_split_bps integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rejection_digest text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
UPDATE tasks SET asset = 'SUI', network = 'testnet', decimals = 9, legacy_read_only = true,
                 review_window_ms = COALESCE(review_window_ms, 300000),
                 reject_split_bps = COALESCE(reject_split_bps, 5000)
WHERE asset IS NULL OR network IS NULL OR decimals IS NULL OR legacy_read_only IS NULL;
ALTER TABLE tasks ALTER COLUMN asset SET DEFAULT 'USDC';
ALTER TABLE tasks ALTER COLUMN network SET DEFAULT 'mainnet';
ALTER TABLE tasks ALTER COLUMN decimals SET DEFAULT 6;
ALTER TABLE tasks ALTER COLUMN legacy_read_only SET DEFAULT false;
ALTER TABLE tasks ALTER COLUMN review_window_ms SET DEFAULT 300000;
ALTER TABLE tasks ALTER COLUMN reject_split_bps SET DEFAULT 5000;
ALTER TABLE tasks ALTER COLUMN asset SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN network SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN decimals SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN legacy_read_only SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN review_window_ms SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN reject_split_bps SET NOT NULL;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_t2000_money_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_t2000_money_check CHECK (
  (asset = 'USDC' AND network = 'mainnet' AND decimals = 6 AND legacy_read_only = false)
  OR (asset = 'SUI' AND network = 'testnet' AND decimals = 9 AND legacy_read_only = true)
);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_t2000_terms_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_t2000_terms_check CHECK (review_window_ms BETWEEN 0 AND 2592000000 AND reject_split_bps BETWEEN 0 AND 10000);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN ('OPEN','ASSIGNED','FUNDING','FUNDED','SUBMITTED','REVIEW','PAID','REFUNDED','REJECTED','CANCELLED'));

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS asset text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS network text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decimals smallint;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS review_window_ms bigint;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS reject_split_bps integer;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS fee_quote_bps integer;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS fee_quote_atomic bigint;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS net_quote_atomic bigint;
UPDATE approvals a SET asset = t.asset, network = t.network, decimals = t.decimals,
                       review_window_ms = t.review_window_ms, reject_split_bps = t.reject_split_bps
FROM tasks t WHERE t.id = a.task_id
  AND (a.asset IS NULL OR a.network IS NULL OR a.decimals IS NULL OR a.review_window_ms IS NULL OR a.reject_split_bps IS NULL);
ALTER TABLE approvals ALTER COLUMN asset SET DEFAULT 'USDC';
ALTER TABLE approvals ALTER COLUMN network SET DEFAULT 'mainnet';
ALTER TABLE approvals ALTER COLUMN decimals SET DEFAULT 6;
ALTER TABLE approvals ALTER COLUMN review_window_ms SET DEFAULT 300000;
ALTER TABLE approvals ALTER COLUMN reject_split_bps SET DEFAULT 5000;
ALTER TABLE approvals ALTER COLUMN asset SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN network SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN decimals SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN review_window_ms SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN reject_split_bps SET NOT NULL;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('HIRE','RELEASE','REJECT'));
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_t2000_money_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_t2000_money_check CHECK (
  (asset = 'USDC' AND network = 'mainnet' AND decimals = 6)
  OR (asset = 'SUI' AND network = 'testnet' AND decimals = 9)
);
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_t2000_terms_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_t2000_terms_check CHECK (review_window_ms BETWEEN 0 AND 2592000000 AND reject_split_bps BETWEEN 0 AND 10000);

ALTER TABLE settlements ADD COLUMN IF NOT EXISTS asset text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS decimals smallint;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_atomic bigint;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS net_atomic bigint;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_bps integer;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS review_window_ms bigint;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS reject_split_bps integer;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS rejection_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS reject_transaction_json jsonb;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS reject_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS reject_expected_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_transaction_json jsonb;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_expected_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_id text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_sender text;
-- score_id can be a deterministic, precomputed object ID while score setup is
-- still frozen. This marker is written only after a confirmed receipt or a
-- successful read of the existing score object.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS score_ready_at timestamptz;
-- A worker may have an unfunded score prerequisite frozen when the owner
-- reaches the deadline.  Refund recovery keeps an independent owner-signed
-- score attempt so it never overwrites or reuses bytes from that worker flow.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_score_transaction_json jsonb;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_score_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_score_expected_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_score_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_score_sender text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_quote_bps integer;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_quote_atomic bigint;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS funding_fee_bps integer;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_acknowledged_at timestamptz;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS release_sender text;
UPDATE settlements s SET asset = COALESCE(s.asset, 'SUI'), decimals = COALESCE(s.decimals, 9)
WHERE s.asset IS NULL OR s.decimals IS NULL;
ALTER TABLE settlements ALTER COLUMN asset SET DEFAULT 'USDC';
ALTER TABLE settlements ALTER COLUMN decimals SET DEFAULT 6;
ALTER TABLE settlements ALTER COLUMN asset SET NOT NULL;
ALTER TABLE settlements ALTER COLUMN decimals SET NOT NULL;
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN ('FUNDING','FUNDED','SUBMITTED','PAID','REFUNDED','REJECTED'));
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_t2000_money_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_t2000_money_check CHECK (
  (asset = 'USDC' AND network = 'mainnet' AND decimals = 6)
  OR (asset = 'SUI' AND network = 'testnet' AND decimals = 9)
);
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_t2000_values_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_t2000_values_check CHECK (
  (fee_atomic IS NULL OR fee_atomic >= 0) AND (net_atomic IS NULL OR net_atomic >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS settlements_network_job_idx ON settlements(network, job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlements_settled_at_idx ON settlements(settled_at) WHERE settled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ratings (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_wallet text NOT NULL,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  digest text UNIQUE NOT NULL,
  transaction_json jsonb,
  transaction_bytes_base64 text,
  expected_digest text,
  confirmed_at timestamptz,
  network text NOT NULL CHECK (network = 'mainnet'),
  coin_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- A legacy row remains visible for reconciliation but cannot be turned into a
-- new USDC budget or task by accident.  State reconciliation on such rows is
-- intentionally blocked; operators can archive them separately.
CREATE OR REPLACE FUNCTION t2000_reject_legacy_money_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.legacy_read_only AND (NEW.asset, NEW.network, NEW.decimals, NEW.legacy_read_only) IS DISTINCT FROM
     (OLD.asset, OLD.network, OLD.decimals, OLD.legacy_read_only) THEN
    RAISE EXCEPTION 'legacy SUI/testnet monetary rows are read-only';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agents_t2000_legacy_read_only ON agents;
CREATE TRIGGER agents_t2000_legacy_read_only BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION t2000_reject_legacy_money_mutation();
DROP TRIGGER IF EXISTS tasks_t2000_legacy_read_only ON tasks;
CREATE TRIGGER tasks_t2000_legacy_read_only BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION t2000_reject_legacy_money_mutation();
