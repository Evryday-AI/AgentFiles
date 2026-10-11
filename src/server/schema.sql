CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  uploaded_by_type TEXT NOT NULL CHECK (uploaded_by_type IN ('admin', 'api_key')),
  uploaded_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_durable BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  deleted_reason TEXT,
  sha256 TEXT,
  thumbnail_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS files_expires_at_idx ON files (expires_at);
CREATE INDEX IF NOT EXISTS files_deleted_at_idx ON files (deleted_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  lookup_id TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  can_upload BOOLEAN NOT NULL DEFAULT true,
  can_download BOOLEAN NOT NULL DEFAULT true,
  can_list BOOLEAN NOT NULL DEFAULT true,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  can_mark_durable BOOLEAN NOT NULL DEFAULT false,
  can_share BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS lookup_id TEXT;

CREATE INDEX IF NOT EXISTS api_keys_name_idx ON api_keys (name);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_lookup_id_idx
  ON api_keys (lookup_id)
  WHERE lookup_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_downloads INTEGER CHECK (max_downloads IS NULL OR max_downloads > 0),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('admin', 'api_key')),
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS share_links_expires_at_idx ON share_links (expires_at);
CREATE INDEX IF NOT EXISTS share_links_file_id_idx ON share_links (file_id);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID REFERENCES files (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'api_key', 'system')),
  actor_name TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_file_id_idx ON events (file_id);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions (expires_at);
