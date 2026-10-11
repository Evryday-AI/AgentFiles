# Standalone edition compatibility

AgentFiles is in preparation. These notes describe the standalone source contract and locally tested database migrations; release installation acceptance remains pending.

The standalone edition starts with its own configuration, database, storage and credentials. No accounts, sessions, API keys, file metadata or stored bytes are imported from another application.

The administrator session cookie is `agentfiles_admin`. Generated API keys use `af_<24 lowercase hexadecimal lookup characters>_<64 lowercase hexadecimal secret characters>`. Authentication accepts exactly that key format; other prefixes and malformed keys are rejected. Clients must use newly created standalone credentials and a new administrator login.

HTTP route paths, instance-local `F-` file codes, and File DTO aliases remain unchanged during sanitization: `size`/`size_bytes`, `expiry`/`expires_at`, and `durable`/`is_durable`. Codes identify files and still require authenticated access. Public sharing uses a separate high-entropy token.

## Versioned independent migrations

Run migrations explicitly against the installation's own database before starting the app. The migration CLI validates only `DATABASE_URL`; it does not require administrator settings or load an environment file implicitly. Native commands use Node's explicit `--env-file` option as described in [configuration](configuration.md). Compose startup gating is a separate acceptance check.

Schema version 2 consists of `001_initial.sql` and `002_lifecycle.sql`. PostgreSQL 17 provides `gen_random_uuid()` without an extension requirement. The second migration backfills MIME types for octet-stream video filenames and repairs temporary files with null expiry to their creation time plus seven days. It preserves persistence intent and the existing `deleted_reason` field. A database constraint then requires expiry for every temporary file, including deleted metadata.

The `schema_migrations` ledger stores ordered versions, SHA-256 checksums of the migration file bytes, and application timestamps. All committed migration files use LF line endings. A pinned database client holds one transaction and its advisory lock while validating the ledger and applying pending SQL. A failure rolls back SQL and ledger changes together. Repeated runs leave applied rows unchanged; unexpected versions, gaps, or changed checksums refuse migration. Never edit an applied migration: add a new numbered file and increase the expected version instead. The readiness check requires exactly the expected versions and checksums. Version `003` adds the permanent issued-code registry and lifecycle claims. Version `004` adds maintenance indexes, immutable claimed storage identity, retention mutation IDs, safe event actor IDs, and the persistent database/volume association. Readiness now expects four immutable migrations. Existing nonempty databases without a volume association fail closed until verified operator recovery; see [retention](retention.md).

Database rollback does not restore filesystem bytes. Backups and recovery procedures remain release acceptance work. Current authorization, capacity and lifecycle evidence is recorded in [Phase C verification](verification/phase-c.md); final review and release acceptance remain pending.
