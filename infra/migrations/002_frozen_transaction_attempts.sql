ALTER TABLE approvals ADD COLUMN IF NOT EXISTS transaction_bytes_base64 text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS expected_digest text;

ALTER TABLE settlements ADD COLUMN IF NOT EXISTS funding_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS funding_expected_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS submit_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS submit_expected_digest text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_transaction_bytes_base64 text;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS refund_expected_digest text;
