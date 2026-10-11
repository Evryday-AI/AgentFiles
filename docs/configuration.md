# Configuration

AgentFiles is in preparation. This configuration contract is implemented; complete clean-install and release acceptance remain pending. The settings below do not establish an installable release. See the [release checklist](release-checklist.md).

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

Capacity, persistence authorization, orphan recovery, deletion arbitration, and metadata/event purge settings are validated now; full lifecycle enforcement is scheduled for Phase C. Existing cleanup uses the configured interval. No setting permits issued-code reuse or purging the permanent code-only registry; its schema and allocation guarantees also belong to Phase C. Changes here never silently make temporary files permanent.

Setup must generate new secrets and an Argon2id administrator hash. `GENERATE_WITH_SETUP` is an invalid sentinel, never a usable credential. Length and encoding checks cannot prove randomness; generate session secrets with a cryptographic generator, preferably 32 bytes as hex. Never pass secrets through `VITE_` variables: those become browser build data.

## Explicit environment loading

Compose must pass the container environment through `env_file: .env`. Its database hostname is `db`, internal to that Compose network. `POSTGRES_PASSWORD` initializes the owned database; setup must encode the same password into `DATABASE_URL`. These details remain subject to the fresh Compose smoke tests.

Native development uses a separately authored, ignored `.env.development.local` containing an independent host-reachable database URL and an app-owned host storage directory. Do not use the container-only `db` hostname on the host. Run `npm run dev:server`; its command is:

```sh
node --env-file=.env.development.local --import tsx --watch src/server/index.ts
```

For advanced native operation, provision an independent Postgres database, build the app, and explicitly select the environment file:

```sh
node --env-file=.env.native.local dist/server/migrate.js
node --env-file=.env.native.local dist/server/index.js
```

Supply the settings above in that ignored file. Existing exported environment variables take precedence over Node's env file. Single-quote Argon2 hashes and database URLs in environment files; this preserves literal dollar signs and avoids Compose interpolation. Setup generates hex credentials without shell metacharacters. Native parsing is tested separately from Compose/tool-container parsing, whose evidence belongs to setup acceptance. Never log secret values while checking escaping.

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
