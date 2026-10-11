-- Compatibility backfill for independently owned metadata only.
UPDATE files
SET mime_type = CASE
  WHEN lower(original_name) LIKE '%.mp4' OR lower(original_name) LIKE '%.m4v' THEN 'video/mp4'
  WHEN lower(original_name) LIKE '%.mov' THEN 'video/quicktime'
  WHEN lower(original_name) LIKE '%.webm' THEN 'video/webm'
  WHEN lower(original_name) LIKE '%.ogg' OR lower(original_name) LIKE '%.ogv' THEN 'video/ogg'
  ELSE mime_type END,
  updated_at = now()
WHERE mime_type = 'application/octet-stream'
  AND (lower(original_name) LIKE '%.mp4' OR lower(original_name) LIKE '%.m4v'
    OR lower(original_name) LIKE '%.mov' OR lower(original_name) LIKE '%.webm'
    OR lower(original_name) LIKE '%.ogg' OR lower(original_name) LIKE '%.ogv');

-- Restore the documented seven-day initial default; never promote temporary files.
UPDATE files SET expires_at = created_at + INTERVAL '7 days', updated_at = now()
WHERE is_durable = false AND expires_at IS NULL;
ALTER TABLE files ADD CONSTRAINT files_temporary_expiry_check
  CHECK (is_durable OR expires_at IS NOT NULL) NOT VALID;
ALTER TABLE files VALIDATE CONSTRAINT files_temporary_expiry_check;
