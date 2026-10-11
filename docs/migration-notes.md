# Standalone edition compatibility

AgentFiles is in preparation. These notes describe the Phase A source contract; they are not a runtime migration procedure or installation guarantee.

The standalone edition starts with its own configuration, database, storage and credentials. No accounts, sessions, API keys, file metadata or stored bytes are imported from another application.

The administrator session cookie is `agentfiles_admin`. Generated API keys use `af_<24 lowercase hexadecimal lookup characters>_<64 lowercase hexadecimal secret characters>`. Authentication accepts exactly that key format; other prefixes and malformed keys are rejected. Clients must use newly created standalone credentials and a new administrator login.

HTTP route paths, instance-local `F-` file codes, and File DTO aliases remain unchanged during sanitization: `size`/`size_bytes`, `expiry`/`expires_at`, and `durable`/`is_durable`. Codes identify files and still require authenticated access. Public sharing uses a separate high-entropy token.

Lifecycle, setup, deployment-mode and schema-migration improvements remain later-phase work. The original baseline's temporary-file and persistence behavior must not be treated as release acceptance evidence.
