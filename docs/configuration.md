# Configuration

AgentFiles is in preparation. This configuration contract is implemented and [Phase B](verification/phase-b.md) exercised a fresh local Compose installation. Complete lifecycle and release acceptance remain pending. The settings below do not establish an installable release. See the [release checklist](release-checklist.md).

Every application setting and every Compose-only input below requires restarting the affected service after a change. Configuration errors name the setting and omit its supplied value. The server does not automatically read `.env`; the caller must supply environment variables explicitly.

## Local and public transport

`NODE_ENV` selects development, test or production optimizations. `DEPLOYMENT_MODE` selects origin and cookie security independently. Production optimizations work with local HTTP.

Local mode accepts HTTP origins on `localhost`, IPv4 loopback (`127.0.0.0/8`), IPv6 loopback (`::1`), and mapped IPv4 loopback. It rejects external hosts and proxy trust. Native startup binds to `127.0.0.1`; containers must invoke the server with `--host=0.0.0.0` and publish their host port on loopback. Local cookies remain signed, HttpOnly and SameSite=Lax.

Public mode requires an external HTTPS origin, for example `https://files.example`. It sets Secure cookies regardless of `NODE_ENV`. Terminate HTTPS at an independently configured reverse proxy and explicitly list its reviewed IP addresses or CIDRs in `TRUST_PROXY`. An empty list trusts no proxies. Boolean trust, hop counts, named ranges, hostnames and default-route CIDRs are rejected. Do not trust a whole container network when individual proxy addresses suffice. Forwarded headers from other peers are ignored.

`PUBLIC_BASE_URL` must be an origin: an optional trailing slash is allowed; credentials, paths, queries and fragments are rejected. It is canonicalized before producing instance-qualified links. Private LAN addresses are external addresses, rather than loopback; HTTPS and public-mode policy apply to them.

## Application settings

All numbers use decimal integer notation. Whitespace, exponent notation, hexadecimal, NaN, Infinity, fractions and unsafe integers are rejected. Boolean settings accept only the literal `true` or `false`.

| Variable | Default | Validation / units |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `DEPLOYMENT_MODE` | `local` | `local`, `public`; transport rules above |
| `PORT` | `3000` | TCP port, 1–65535 |
| `DATABASE_URL` | Required | `postgres://` or `postgresql://` URL with host and database name |
| `STORAGE_ROOT` | Required | App-owned directory; ownership/mount validation belongs to runtime setup |
| `SESSION_SECRET` | Required | At least 32 cryptographically random bytes, encoded as hex, canonical base64 or base64url; optional base64 padding |
| `ADMIN_USERNAME` | `admin` | Nonblank, 1–128 characters |
| `ADMIN_PASSWORD_HASH` | Required | Valid Argon2id v19 encoding with positive parameters, salt of at least 8 bytes and digest of at least 16 bytes |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Canonical origin allowed by deployment mode |
| `TRUST_PROXY` | Empty / false | Public only; comma-separated reviewed IP/CIDR list |
| `RETENTION_DAYS` | `7` | File expiry, days, 1–3650 |
| `ALLOW_PERSISTENT_FILES` | `false` | Administrator policy; true does not replace per-operation intent and key permission |
| `MAX_UPLOAD_BYTES` | `1073741824` | Per-upload bytes, positive safe integer (1 GiB default) |
| `MAX_STORAGE_BYTES` | `10737418240` | Managed bytes, safe integer at least `MAX_UPLOAD_BYTES` (10 GiB default) |
| `MIN_FREE_DISK_BYTES` | `1073741824` | Free-disk reserve, nonnegative safe integer bytes (1 GiB default) |
| `MAX_CONCURRENT_UPLOADS` | `4` | Concurrent requests, 1–64 |
| `CLEANUP_INTERVAL_SECONDS` | `3600` | Seconds, 1–86400; converted to milliseconds once |
| `ORPHAN_GRACE_SECONDS` | `86400` | Seconds, at least 600 and twice the cleanup interval; milliseconds must remain a safe integer |
| `CLEANUP_BATCH_SIZE` | `100` | Files per batch, 1–500 |
| `METADATA_RETENTION_DAYS` | `30` | Deleted-file details only, positive safe integer days |
| `EVENT_RETENTION_DAYS` | `30` | Event records, positive safe integer days |

Persistence authorization, atomic code reservation, row-lock deletion/retention arbitration, staged upload validation and capacity admission are enforced. Scheduled cleanup uses the configured interval and batch size and retries committed deletion claims. Orphan recovery, ordered maintenance, fairness and metadata/event purging remain C3 work. No setting permits issued-code reuse or age-purging the permanent code-only registry. Changes never silently make temporary files permanent.

Each upload reserves MAX_UPLOAD_BYTES, regardless of Content-Length, in one serialized admission check. Admission requires managed bytes plus all reservations to fit MAX_STORAGE_BYTES and available disk minus reservations to retain MIN_FREE_DISK_BYTES. Small uploads can therefore be rejected conservatively. Successful commit converts the reservation to actual bytes; failed deletion during compensation remains charged. Startup measures all managed files, including `.tmp` and orphan final files, before accepting requests. An uncertain mount/measurement rejects admission. Idle maintenance rescans replace charges only when no uploads are active, avoiding double subtraction of active bytes. Streaming checkpoints recheck free disk; ENOSPC fails cleanly. Already-written active bytes can be counted conservatively in these disk checks. These checks cannot guarantee physical space against privileged external writers; only one app process and an exclusively app-owned local volume are supported.

Completed validated streams are linked exclusively from `.tmp` into `files/<random UUID><safe extension>` on the same volume. The supplied name or code never chooses the byte path. Empty, dot, absolute and escaping keys are rejected; existing ancestors and files are checked for symlinks/junctions and downloads open with no-follow where supported. Storage deletion unlinks regular files and never recursively deletes a supplied key. Native Windows junction tests are covered; POSIX no-follow validation needs separate Linux evidence.

An uncertain SQL allocation is reconciled under the same storage-key transaction advisory lock as the original allocator. A bounded timeout retains the reservation and active byte protection; an unlocked fresh absence does not authorize unlink. Scheduled maintenance retries unresolved ownership, and administrator usage reports its count. Restart remeasures retained bytes; grace-period orphan reclamation remains C3. Shutdown retains the shared ten-second deadline even when ownership cannot be resolved; process exit may leave charged bytes for restart recovery.

The [administrator setup command](setup.md) generates new secrets and an Argon2id administrator hash through an isolated Docker tool or host Node fallback. `GENERATE_WITH_SETUP` is an invalid sentinel, never a usable credential. Length and encoding checks cannot prove randomness; generate session secrets with a cryptographic generator, preferably 32 bytes as hex. Never pass secrets through `VITE_` variables: those become browser build data.

## Explicit environment loading

Compose passes the container environment through `env_file: .env`. Its database hostname is `db`, internal to that Compose network. `POSTGRES_PASSWORD` initializes the owned database; setup encodes the same password into `DATABASE_URL`. The [fresh Compose smoke](self-hosting.md) verifies this path. Compose fixes container `PORT` to 3000 and `STORAGE_ROOT` to `/data/storage`; `APP_PORT` controls the loopback host port. These overrides preserve the health checks and owned mount; native operation can choose different values.

Native development uses a separately authored, ignored `.env.development.local` containing an independent host-reachable database URL and an app-owned host storage directory. Do not use the container-only `db` hostname on the host. Run `npm run dev:server`; its command is:

```sh
node --env-file=.env.development.local --import tsx --watch src/server/index.ts
```

For advanced native operation, provision an independent Postgres database, build the app, and explicitly select the environment file:

```sh
node --env-file=.env.native.local dist/server/migrate.js
node --env-file=.env.native.local dist/server/index.js
```

Supply the settings above in that ignored file. Existing exported environment variables take precedence over Node's env file. Single-quote Argon2 hashes and database URLs in environment files; this preserves literal dollar signs and avoids Compose interpolation. Setup generates hex credentials without shell metacharacters. Setup's literal dollar/hash/space/double-quote/interior-backslash encoding and Argon2 hashes have been checked with Node and the isolated Compose tool environment. Setup rejects apostrophes, control characters and odd trailing backslashes in administrator names because parser escaping differs. Runtime Compose validation and an actual dollar-containing administrator login are recorded in [Phase B evidence](verification/phase-b.md). Never log secret values while checking escaping.

An existing external Postgres server is an advanced independent runtime option. Use a dedicated database/account, the appropriate TLS connection parameters and a host reachable from the chosen runtime. It requires no maintainer network, shared database or hosted account. Only one app process should own the storage volume.

## Compose-only inputs

These values never appear in public instance JSON. Restart/recreate affected services after changes.

| Variable | Default / meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Setup-generated password for the owned Postgres database; required |
| `APP_PORT` | `3000`; published host TCP port, 1–65535; keep loopback publication in local mode |
| `SETUP_UID`, `SETUP_GID` | Optional host identity mapping for tool-container setup where supported; Windows permissions require separate verification |
| `COMPOSE_PROJECT_NAME` | Optional independent project name; isolates owned services/volumes |

Never commit `.env`, `.env.development.local`, `.env.native.local`, storage bytes, database dumps or generated setup credentials. The committed `.env.example` is a newly authored template containing invalid sentinels.

## Database readiness, storage and shutdown

Every route, repository and scheduled cleanup receives the database created from the validated `DATABASE_URL`. No ambient `PG*` credentials, port or TLS defaults select a different connection. An omitted URL user defaults to `postgres`, omitted password stays empty, and omitted port defaults to 5432. Production passwords should be supplied explicitly. The reserved `connectionString` query option is rejected before constructing the database pool, including an encoded option name; errors omit the supplied URL. URL-provided TLS settings are preserved; use the settings appropriate to the independently operated database. Connect, SQL statement and client query timeouts are each capped at 2.5 seconds.

`GET /api/health` returns process liveness without a database query. `GET /api/ready` returns 200 with `{ "ready": true }` only when the owned database has exactly schema version 3 and matching migration checksums; an unavailable database, missing migration, unexpected version or changed checksum returns 503 with `{ "ready": false }`. Readiness has a 2.5-second deadline and omits internal errors and connection details. Run the [immutable migrations](migration-notes.md) before app startup.

`STORAGE_ROOT` must already be a directory readable, writable and searchable by the app process. Startup rejects a symlink root; on POSIX it also requires the process UID to own the directory and rejects world-writable roots. Startup creates, syncs, reads and removes an exclusive probe file to verify access. Create the directory and set its owner before native startup; container volume initialization must provide the app UID. Windows uses actual directory access and the probe because POSIX ownership is unavailable. Deeper mount, child-symlink and orphan-recovery checks remain Phase C work.

SIGINT and SIGTERM stop admission through Fastify close, await active cleanup and transfers, then close database connections. One ten-second deadline bounds the entire drain; server drain reserves the final second for attempting and awaiting database close before forced exit. Successful drain exits zero; a failed or hung operation exits nonzero at the deadline, and database close is attempted even if server close times out. A forced exit may interrupt transfers or cleanup; restart recovery remains Phase C work. Configure container stop grace longer than ten seconds. Restart the process after changing database or storage configuration.

## HTTP admission, browser writes and logs

The server limits ordinary JSON bodies and HTTP headers to 16 KiB before authentication. Login accepts JSON only, with a 128-byte username and 4096-byte password input bound; it allows non-browser clients without Origin but rejects cross-site Fetch metadata and mismatched Origin. Login is limited to five requests per minute per resolved client IP. Authentication resolution is independently limited to 120 requests per minute per IP before expensive password/key verification. Public share downloads have a separate 120-per-minute/IP bucket; authenticated uploads are limited to 30 per minute per principal across IPs. Rejections return 429 and Retry-After. IP resolution uses only the configured trusted peers above; changing a forwarded header from an untrusted peer does not reset a bucket. These counters are process-local, consistent with the one-process support boundary.

Cookie-authorized POST, PATCH and DELETE requests (including logout and administrator key/share mutations) require an Origin exactly equal to PUBLIC_BASE_URL. Missing Origin is rejected for cookie mutations, including non-browser clients using cookies; Sec-Fetch-Site alone cannot prove origin. A matching Origin does not override cross-site Fetch metadata. Header-only API clients do not need Origin or Fetch headers. An explicit Authorization header selects API-key authority exclusively, including malformed or invalid Bearer credentials; it never falls back to an administrator cookie. Logout accepts only cookie authority and will not revoke a cookie through a Bearer request.

Connections have a 30-second idle timeout and requests a 60-second request timeout. Multipart requests and byte streams expire after 30 seconds without progress; timeout closes the connection and compensates incomplete temporary bytes. Actual socket abort/idle tests verify reservation release; injected unlink failures verify retained byte charges. Grace-period crash reclamation remains C3. MAX_UPLOAD_BYTES controls multipart file size and an independent streaming meter; multipart metadata remains limited to 20 fields, 4 KiB each, one file and 25 total parts. Only the optional durable field is accepted.

Authenticated file/key/session/share responses and public downloads use Cache-Control: no-store, X-Content-Type-Options: nosniff and Referrer-Policy: no-referrer. Downloads remain attachments even for HTML/SVG. The app CSP permits only own scripts/assets/API calls, own/blob media, and own/blob/data images; inline styles remain permitted for React progress and media proportions. Objects, external form actions, framing and base-URL replacement are disabled. C1 checked synthetic image decoding and the larger preview dialog in a real local Chromium browser; full browser/phone acceptance remains D2.

Request logs allowlist method and route template, excluding raw share-token URLs, query strings, headers and bodies. Error logs use generic messages without stack, storage paths or database diagnostics. Explicit secret fields are redacted. Operator access/proxy logs, rotated logs and backups need independent retention/redaction policies; application serializers cannot sanitize those systems.

Schema 003 permanently reserves canonical issued codes and backfills all still-present rows, including deleted files. Its registry contains only code, with no timestamps or file metadata; it is never age-purged. New standalone installations retain all issuance history. Migration cannot recover reservations for previously purged unknown codes and must not be described as recovering a complete historical registry. Preserve every reservation during backup/restore; when complete issuance evidence is unavailable, keep new uploads disabled until the operator can restore that evidence. General restore acceptance remains E2.
