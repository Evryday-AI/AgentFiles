-- Permanent, canonical reservations contain codes only. Restore must preserve
-- complete issuance history; this backfill cannot recover previously purged codes.
CREATE TABLE issued_file_codes (
  code TEXT PRIMARY KEY CHECK (code ~ '^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$')
);
INSERT INTO issued_file_codes(code) SELECT code FROM files;
ALTER TABLE files ADD CONSTRAINT files_issued_code_fk FOREIGN KEY(code)
  REFERENCES issued_file_codes(code) ON DELETE RESTRICT;

ALTER TABLE files ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN deletion_claim_id UUID,
  ADD COLUMN deletion_claimed_at TIMESTAMPTZ,
  ADD COLUMN deletion_claim_reason TEXT;
UPDATE files SET lifecycle_state = 'deleted' WHERE deleted_at IS NOT NULL;
ALTER TABLE files ADD CONSTRAINT files_lifecycle_state_check CHECK (
  (lifecycle_state = 'active' AND deleted_at IS NULL AND deletion_claim_id IS NULL
    AND deletion_claimed_at IS NULL AND deletion_claim_reason IS NULL)
  OR (lifecycle_state = 'deleting' AND deleted_at IS NULL AND deletion_claim_id IS NOT NULL
    AND deletion_claimed_at IS NOT NULL AND deletion_claim_reason IS NOT NULL AND deletion_claim_reason IN ('manual','expired'))
  OR (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL
    AND ((deletion_claim_id IS NULL AND deletion_claimed_at IS NULL AND deletion_claim_reason IS NULL)
      OR (deletion_claim_id IS NOT NULL AND deletion_claimed_at IS NOT NULL AND deletion_claim_reason IS NOT NULL AND deletion_claim_reason IN ('manual','expired'))))
);
CREATE INDEX files_deletion_claim_idx ON files(deletion_claimed_at, id) WHERE lifecycle_state = 'deleting';
