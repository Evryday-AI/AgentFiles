# AgentFiles phase B implementation plan: independent self-hosting

> **For agentic workers:** Use `executing-plans` after A review. Track checkbox steps; keep the reference read-only.

**Goal:** A fresh local or public installation uses owned services, validated config and safe administrator setup.

**Architecture:** Explicit local/public transport policy is independent of production optimization. Setup writes fresh secrets without echo; versioned transactions prepare owned Postgres before a non-root app becomes ready. Compose uses named volumes, no external network dependency.

**Tech Stack:** Node 24/Postgres 17 validation targets, Zod, Argon2id, Fastify, Docker Compose, Vitest.

## Global constraints

All [master constraints/interfaces](2026-10-10-agentfiles-open-source.md) apply. Only AgentFiles configuration, synthetic data and disposable database/storage. Local HTTP is loopback-only; public HTTP is rejected. A passing dev build is not installation evidence.

## B1: validated configuration and local/public security policy

**Files:** Modify `src/server/config.ts`, `src/server/adminRoutes.ts`, `src/server/index.ts`, `package.json`, `tests/server/config.test.ts`, `tests/server/adminRoutes.test.ts`; create `src/server/originPolicy.ts`, `tests/server/originPolicy.test.ts`, `tests/helpers/config.ts`, `.env.example`, `docs/configuration.md`. Update config fixture objects in `tests/server/auth.test.ts`, `filesRoutes.test.ts`, `shareRoutes.test.ts` through the shared helper.

**Interfaces:** `loadConfig(source: NodeJS.ProcessEnv): AppConfig`; `cookieIsSecure(config): boolean` means deploymentMode public; `publicBaseUrl` is a canonical origin (trailing slash optional, no path/userinfo/query/fragment); `trustProxy` is false or reviewed address list, never unrestricted true/hop count. `tests/helpers/config.ts` exports `testConfig(overrides: Partial<AppConfig> = {}): AppConfig` with synthetic values only.

| Setting | AppConfig field/type | Default / validation |
|---|---|---|
| `NODE_ENV` | `nodeEnv` enum | development; test/production allowed |
| `DEPLOYMENT_MODE` | `deploymentMode` local/public | local; public requires external HTTPS |
| `PORT` | `port` number | 3000, integer 1–65535 |
| `DATABASE_URL` | `databaseUrl` string | required postgres/postgresql URL; redact errors |
| `STORAGE_ROOT` | `storageRoot` string | required; app-owned directory validated at runtime |
| `SESSION_SECRET` | `sessionSecret` string | required ≥32 random bytes represented safely; reject example sentinel |
| `ADMIN_USERNAME` | `adminUsername` string | admin; 1–128 characters |
| `ADMIN_PASSWORD_HASH` | `adminPasswordHash` string | valid Argon2id encoding, not example sentinel |
| `PUBLIC_BASE_URL` | `publicBaseUrl` string | local http://localhost:3000; no credentials/path/query/fragment |
| `TRUST_PROXY` | `trustProxy` false/string[] | empty=false; local rejects nonempty; public explicit IP/CIDR list |
| `RETENTION_DAYS` | `retentionDays` number | 7, positive integer ≤3650 |
| `ALLOW_PERSISTENT_FILES` | `allowPersistentFiles` boolean | false; only literal true/false accepted |
| `MAX_UPLOAD_BYTES` | `maxUploadBytes` number | 1073741824; positive safe integer |
| `MAX_STORAGE_BYTES` | `maxStorageBytes` number | 10737418240; safe integer ≥maxUploadBytes |
| `MIN_FREE_DISK_BYTES` | `minFreeDiskBytes` number | 1073741824; nonnegative safe integer |
| `MAX_CONCURRENT_UPLOADS` | `maxConcurrentUploads` number | 4; integer 1–64 |
| `CLEANUP_INTERVAL_SECONDS` | `cleanupIntervalMs` number | 3600; input integer 1–86400, convert once |
| `ORPHAN_GRACE_SECONDS` | `orphanGraceMs` number | 86400; integer ≥600 and ≥2 cleanup intervals |
| `CLEANUP_BATCH_SIZE` | `cleanupBatchSize` number | 100; integer 1–500 |
| `METADATA_RETENTION_DAYS` | `metadataRetentionDays` number | 30; positive integer |
| `EVENT_RETENTION_DAYS` | `eventRetentionDays` number | 30; positive integer |

Compose-only inputs are `POSTGRES_PASSWORD`, `APP_PORT` (3000), `SETUP_UID/GID` (host mapping) and optional project name. They never appear in public instance JSON. Application config names remain the source's `STORAGE_ROOT`/`PUBLIC_BASE_URL` rather than invented seed `storageDirectory` naming. Document bytes vs seconds vs days and restart requirement for every setting.

- [ ] Write failing config cases: default local production accepted; local rejects external HTTP/HTTPS host; public rejects localhost/127.0.0.1/[::1], HTTP, userinfo/path/query/fragment; literal false remains false; NaN/Infinity/negative/fraction/unsafe integers fail; upload cap cannot exceed managed cap; invalid hash/placeholder secret fails. Use `.example` domains only.

```ts
it("allows production optimizations with local HTTP only", () => {
  const cfg = loadConfig({ ...validTestEnv(), NODE_ENV: "production", DEPLOYMENT_MODE: "local" });
  expect(cfg.publicBaseUrl).toBe("http://localhost:3000");
  expect(cookieIsSecure(cfg)).toBe(false);
});
it("does not coerce a false string into enabled persistence", () => {
  expect(loadConfig({ ...validTestEnv(), ALLOW_PERSISTENT_FILES: "false" }).allowPersistentFiles).toBe(false);
});
```

Define `validTestEnv(): NodeJS.ProcessEnv` in the same test file with a valid **synthetically generated** Argon2id hash prepared in beforeAll, local storage fixture and random test secret. Never use actual `.env` in tests.

- [ ] Implement strict parsing, canonical origin and local/public host policy; normalize IPv6 brackets. Reuse this parser in setup and instance link generation. Do not equate all private LAN addresses with loopback.
- [ ] Replace production-only cookie flag with `cookieIsSecure`; preserve signed HttpOnly SameSite=Lax behavior. Pass reviewed address list into Fastify `trustProxy`; default false. Source dev/server bind becomes loopback in host-local startup; container binds internally to all interfaces while Compose publishes loopback only.
- [ ] Author `.env.example` with commented units and `GENERATE_WITH_SETUP` sentinels (server must reject them), neutral database/storage/example origin. Never copy the reference's env example. Add documentation of existing external Postgres as an advanced independent runtime, not a required network.
- [ ] Make environment loading explicit: Compose supplies container environment through `env_file`; source startup currently does not load `.env` automatically. Native development uses a separately authored ignored `.env.development.local` with independent host-reachable DB/storage and `dev:server` command `node --env-file=.env.development.local --import tsx --watch src/server/index.ts`. Advanced native start/migrate instructions use Node's explicit `--env-file` flag. Do not use Compose's container `db` hostname as a host connection or expose any secret through a `VITE_` browser build variable. Verify secret/hash escaping parses identically in actual chosen setup modes.
- [ ] Verify focused cases, full unit suite/typecheck/build; commit config/docs together.

**Commands:** `npm test -- tests/server/config.test.ts tests/server/originPolicy.test.ts tests/server/adminRoutes.test.ts`; `npm run typecheck`; `npm run build`. Expected failing tests first for missing/new policy, then zero exit after implementation.

**Acceptance/commit:** Local/public behavior explicit and tested; no insecure public downgrade or hidden retention changes. `feat: validate standalone configuration and transport policy`.

## B2: secret-safe setup without mandatory host Node

**Files:** Create `scripts/setup.mjs`, `scripts/setup-lib.mjs`, `tests/setup/setup.test.ts`, `Dockerfile.setup`, `.dockerignore`, `compose.setup.yaml`; modify `package.json`, `.gitignore`, `docs/configuration.md`; create `docs/setup.md`. Extend unit runner to `tests/setup`.

**Interfaces:** `createSetupFile({directory, input, hashPassword, randomBytes}): Promise<void>` is a dependency-injected exclusive writer in setup-lib. `input` carries mode/origin/admin name and password in memory only. `hashPassword(password): Promise<string>` uses Argon2id. `scripts/setup.mjs` owns hidden TTY input and prints only success/path category, not input, URL credentials, password/hash/DB password/session secret. `npm run setup` invokes it. Container command runs `/app/scripts/setup.mjs --directory /workspace` with a bind-mounted independent root; no db/app service starts.

- [ ] Write temp-directory tests for unique generated secrets, verify generated hash with supplied password, literal configuration escaping, no overwrites even with concurrent setup, invalid input creates no `.env`, cancellation/noTTY failure leaves no file. Capture stdout/stderr and assert password/hash/random secrets absent. Define the injected interface in the test and import only setup-lib (no interactive prompt side effects).

```ts
it("refuses replacement and preserves the first file", async () => {
  await createSetupFile(setupFixture(root, "synthetic password one"));
  const first = await readFile(join(root, ".env"), "utf8");
  await expect(createSetupFile(setupFixture(root, "synthetic password two"))).rejects.toThrow(/exists/);
  expect(await readFile(join(root, ".env"), "utf8")).toBe(first);
});
```

`setupFixture(directory,password)` is a test-local builder using real Argon2id/hash and crypto randomness, mode local, default origin, synthetic admin name; `root` comes from mkdtemp/afterEach cleanup. Test cleanup verifies resolved directory stays under its test temp root.

- [ ] Validate mode/origin/admin name/password confirmation before writing. Generate 32 random bytes each for DB password/session secret (hex), hash password Argon2id; set dedicated `POSTGRES_USER/DB=agentfiles`. Do not accept password flags/env variables as normal UX. Interactive stdin uses raw mode without echo, restores terminal on Ctrl+C/error, and disables secret history. Min password length 12, maximum 1024 bytes.
- [ ] Write `.env` with `open(path,'wx',0o600)`, one awaited write/sync/close; on failure remove only the file this process created. Escape dotenv values and Compose `$` interpolation; use generated hex secrets to avoid interpolation in generated hash/password URI values. Hash encoding contains `$`: quote/escape according to actually tested Compose interpolation rather than assume Node dotenv syntax is identical. Existing env remains untouched.
- [ ] Before the first setup build, author `.dockerignore` excluding `.private`, `.git`, `.env*`, runtime bytes/dumps/logs, graph/tool caches, screenshots and local planning caches. Inspect the build context and explicit COPY allowlist. Build fresh setup image containing Node, reviewed Argon2 dependency, and setup scripts only, not reference files. Tool compose is separate to permit setup before `.env` exists. Service uses `user: '${SETUP_UID:-1000}:${SETUP_GID:-1000}'`, bind `source: .`, `target: /workspace`, `working_dir: /workspace`, no network needed after build. Document Linux UID/GID export and Docker Desktop bind permissions. Validate written `.env` is readable by the invoking host owner; do not leave Linux root-owned mode-0600 files.
- [ ] Exercise hidden prompt and interruption in actual terminal on Linux and Docker Desktop where available. Host fallback is `npm ci; npm run setup`; document Node prerequisite only for that fallback. Generated deployment DB URL must point exclusively to Compose `db`, never reference infra. Do not display expanded Compose config containing generated secrets.

**Commands:** `npm test -- tests/setup/setup.test.ts`; `docker compose -f compose.setup.yaml run --rm --build setup`; `docker compose --env-file .env -f compose.yaml config --quiet` once B4 exists. POSIX setup mapping: `export SETUP_UID=$(id -u) SETUP_GID=$(id -g)`. PowerShell uses Docker Desktop default mapping and verifies file access. Expected: non-echoed prompt, new `.env`, second invocation refusal, config parse zero. Missing Docker engine is a recorded limitation, not a pass.

**Acceptance/commit:** No secret in logs/argv, no overwrite, owned readable configuration, setup works without host Node via tool image. `feat: add isolated administrator setup command`.

## B3: explicit DB lifecycle, migration ledger and readiness

**Files:** Modify `src/server/db.ts`, `migrate.ts`, `index.ts`, `config.ts`, `auth.ts`, `adminRoutes.ts`, `filesRepo.ts`, `filesRoutes.ts`, `shareRoutes.ts`, `cleanup.ts`, `package.json`; create `src/server/migrations/001_initial.sql`, `src/server/migrations/002_lifecycle.sql`, `src/server/health.ts`, `vitest.integration.config.ts`, `tests/integration/database.test.ts`, `tests/helpers/integration.ts`, `tests/server/health.test.ts`; extend `tests/server/migrate.test.ts`. Replace old build schema-only copy with migration-directory copy.

**Interfaces:**

```ts
export interface Database extends Queryable {
  withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// db.ts: createDatabase(databaseUrl: string): Database
// migrate.ts: migrate(database: Database): Promise<void>
// health.ts: checkReadiness(db: Queryable, expectedVersion: number): Promise<boolean>
// index.ts: buildServer(config: AppConfig, deps?: { db?: Database }): FastifyInstance
```

Root constructs a database from explicit config and passes it to every route/repository/cleanup; remove ambient process-env pool fallback. Preserve Queryable fake injection in unit tests; any default repository DB access without root wiring fails explicitly. CLI migration reads only validated DATABASE_URL, constructs its own DB and closes it. Expected version is 2 until C migrations increase it.

- [ ] Add failing real integration tests on a newly created isolated `agentfiles_test_<random>` database: migrate twice, table/index/constraint existence, rollback on deliberately invalid SQL, concurrency/advisory lock, mismatched checksum refusal, readiness false before migration/DB outage. Unit tests separately cover readiness timeout without real DB.
- [ ] `tests/helpers/integration.ts` only accepts `AGENTFILES_TEST_DATABASE_URL`; reject missing DB suffix outside dedicated test naming and refuse generic `DATABASE_URL`. Require explicit test-only provisioned server/database, never infer credentials. Return `{db,storageRoot,server,close}` fixture via `createIntegrationFixture(overrides)`; use mkdtemp for storage, fresh config, migrated DB, and cleanup that verifies database/root ownership. Fixtures expose no secrets in logs. Integration command is `vitest run --config vitest.integration.config.ts`.
- [ ] Copy reviewed schema into 001 and backfill into 002; remove unnecessary extension requirement if using Postgres 17 core `gen_random_uuid`, after actual DB test. 002 enforces temporary expiry and uses the existing `deleted_reason` field; repair invalid temporary null expiry relative to created_at + the documented seven-day initial default before constraint validation. No reference data migration occurs.
- [ ] Implement `schema_migrations(version primary key, checksum, applied_at)`. Acquire transaction-level advisory lock on a pinned PoolClient, verify ordered/checksummed applied migrations, run pending SQL and insert ledger entries in the same transaction, rollback any failure, release client in finally. Never send BEGIN/COMMIT through unpinned pool.query calls. Keep applied migration files immutable; future changes create new migrations.
- [ ] Readiness uses bounded DB query plus exact expected ledger version; statement/query/connect timeout ≤3 seconds. `/api/health` process-only 200; `/api/ready` 200 `{ready:true}` or 503 `{ready:false}`, no internal error/DB URL leak. Root logger safe-error behavior follows C1.
- [ ] Add SIGINT/SIGTERM to await server.close (cleanup/upload shutdown), db.close, then exit. Fail startup on invalid config; Compose B4 gates migration. Shutdown tests ensure cleanup finishes, connections close, and hung operations have a documented bounded drain timeout.

**Commands:** `npm test -- tests/server/migrate.test.ts tests/server/health.test.ts`; `npm run test:integration -- tests/integration/database.test.ts`; `npm run typecheck`; `npm run build`. Expected real SQL executes and ledger remains unchanged after rollback; no skipped integration passes. Test connection is supplied only from independent disposable config.

**Acceptance/commit:** Schema version/checksum/locking demonstrated on real PG; config controls every DB access; readiness truthfully represents DB/schema. `feat: gate readiness on versioned independent migrations`.

## B4: fresh Compose runtime and actual installation smoke

**Files:** Create `Dockerfile`, `compose.yaml`, `compose.external-db.yaml`, `scripts/smoke-compose.mjs`, `docs/self-hosting.md`, `docs/verification/phase-b.md`; modify `.dockerignore`, setup docs/build scripts and `docs/upgrading.md` (initial update instructions). No source deployment file is copied.

**Interfaces:** Runtime services `db`, `migrate`, `app`, independent `database`/`storage` named volumes. App port `${APP_PORT:-3000}` binds `127.0.0.1`, DB has no published port. `compose.external-db.yaml` is a separate complete advanced configuration with app/migrate only and required owner-provided independent DATABASE_URL; never merge in an external private network. Setup uses `compose.setup.yaml` from B2.

- [ ] Resolve currently patched official Node24/bookworm-slim and Postgres17/bookworm tags/digests; check primary schedules and plugin/native compatibility, freeze tested exact values in Dockerfiles/Compose. Do not use latest. Record Linux amd64 first; advertise arm64/Desktop support only after actual tests.
- [ ] Add multi-stage build, reviewed npm ci, server/client/migration/skill artifacts, production-only runtime deps, and non-root node user. Extend B2's `.dockerignore` to exclude tests while preserving its private/config/runtime exclusions; no secret needed for build. Include notices. Make Docker copy paths explicit.
- [ ] Verify app-owned named volume is writable by node on first creation and recreation. Use image-created `/data/storage` ownership and test Docker volume copy-up; if an init service is necessary, restrict chown to that exact named volume. Never chown host/reference storage. Setup bind ownership is distinct from runtime volume ownership.
- [ ] Implement service gates exactly:

```yaml
depends_on:
  db:
    condition: service_healthy
# app also requires:
# migrate: { condition: service_completed_successfully }
```

`db` health uses pg_isready with Compose-escaped variables. `migrate` uses same reviewed image, command `node dist/server/migrate.js`, restart no. `app` depends on db healthy plus migrate successful and uses readiness healthcheck. `env_file: .env` does not bake secrets into images. Health URLs are container localhost; public origin can differ.
- [ ] Smoke runner creates a unique project and fixture configuration in an ignored dedicated scratch folder with explicit root containment. It never reads source `.env` or generic DATABASE_URL. Capture bounded sanitized logs; use `config --quiet` only. Test migration failure stops app, database outage changes readiness but not liveness, app recreation preserves metadata/bytes, localhost login cookie/download works.
- [ ] Document exact clone/setup/build/start/stop/recreate instructions, local HTTP and production HTTPS proxy requirements (upload body overhead, timeouts, trusted source IP/CIDR, sanitized access logs). Require public proxy to enforce TLS and scrub share path tokens. No externally exposed DB; no maintainer control plane.

**Commands after fresh setup:**

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/ready
node scripts/smoke-compose.mjs
```

Expected all gates observed, readiness true only after schema, login/upload/download synthetic round trip/recreate succeeds. Smoke runner's final cleanup may remove **its explicitly owned disposable volumes only**; normal docs use `docker compose down` without `-v`. Linux host setup and Desktop checks have separate evidence rows. Public HTTPS phone access is verified in D2/E2, never implied by a localhost test.

**Acceptance/commit:** Fresh installation with dedicated DB/storage and no pre-existing infrastructure. App's full lifecycle safety is still pending C. `feat: package owned Postgres and disk storage with Compose`.
