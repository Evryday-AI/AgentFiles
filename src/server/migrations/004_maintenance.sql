ALTER TABLE files ADD COLUMN retention_mutation_id UUID;
ALTER TABLE events ADD COLUMN actor_id UUID;
CREATE TABLE storage_volume_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  volume_id UUID NOT NULL UNIQUE
);
CREATE UNIQUE INDEX events_terminal_file_idx ON events(file_id,event_type)
  WHERE event_type IN ('file.created','file.deleted','file.expired');
CREATE INDEX files_expired_sweep_idx ON files(expires_at,id) WHERE lifecycle_state='active' AND NOT is_durable;
CREATE INDEX files_pending_sweep_idx ON files(deletion_claimed_at,id) WHERE lifecycle_state='deleting';
-- A committed claim freezes the authority used by disk recovery.
CREATE FUNCTION protect_file_deletion_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle_state IN ('deleting','deleted') AND
    (NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.thumbnail_key IS DISTINCT FROM OLD.thumbnail_key
     OR NEW.deletion_claim_id IS DISTINCT FROM OLD.deletion_claim_id
     OR NEW.deletion_claimed_at IS DISTINCT FROM OLD.deletion_claimed_at
     OR NEW.deletion_claim_reason IS DISTINCT FROM OLD.deletion_claim_reason
     OR NEW.lifecycle_state = 'active') THEN
    RAISE EXCEPTION 'Deletion identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER files_deletion_identity BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION protect_file_deletion_identity();
