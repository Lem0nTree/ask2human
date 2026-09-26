-- Corrective migration for the t2000 payment cutover.
--
-- Migration 003 added the release sender but omitted the frozen release
-- transaction columns.  A release build reads those columns before it can
-- decide whether to reuse an issued attempt, so a schema with 003 recorded as
-- applied fails with PostgreSQL 42703.  Keep this migration additive and
-- idempotent: it repairs schemas that already ran 003 and is harmless when a
-- deployment already has the columns.

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS release_transaction_json jsonb,
  ADD COLUMN IF NOT EXISTS release_transaction_bytes_base64 text,
  ADD COLUMN IF NOT EXISTS release_expected_digest text;

-- The release attempt is one of the frozen transaction records.  This partial
-- index only covers rows with an attempt and does not change existing data or
-- any settlement uniqueness rules; it also keeps recovery/reconciliation
-- lookups bounded on larger deployments.
CREATE INDEX IF NOT EXISTS settlements_release_expected_digest_idx
  ON settlements (release_expected_digest)
  WHERE release_expected_digest IS NOT NULL;
