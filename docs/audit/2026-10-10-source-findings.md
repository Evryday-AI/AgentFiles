# Source-verified planning audit

Date: 2026-10-10. Scope: read-only source/config/test inspection and independent dependency metadata audit. AgentFiles was documentation only at this audit boundary; Phase A is now implemented locally, with [execution evidence](../verification/phase-a.md) recorded separately.

## Evidence and limits

The independent public repository has its own `.git`, the intended public remote, no object alternates, and an ignored private provenance directory. The supplied reference revision matched local provenance; its only reported working-tree change was an excluded untracked tooling directory. No reference files, Git state, runtime secrets, database, or storage were modified or used. Existing graph search, snippets, architecture, and call tracing guided discovery. Its inventory omits `MediaPreview.tsx` and test files; its migration snippet does not match the full function. Exact file reads were used where graph results were insufficient.

The proposed import contains 42 regular text-file candidates. Source inspection counted **82 `it()` cases in 11 test files**. No `npm ci`, application tests, application build, Postgres integration, browser session, clean install, deployment, or restore was run. Do not relabel any of those gates passed. The audit copied only two package metadata files into ignored local audit storage and ran registry audits there, without installing packages or executing lifecycle scripts.

The installed audit tools reported Node 24.21.0, npm 11.19.0, and Docker Compose 5.1.4. Their presence is not evidence that the Docker engine or an application container works. A dedicated secret scanner was not available in PATH during the planning audit and was not run at that boundary; Phase A later adds dedicated scan evidence. Staged documentation passed diff validation, local-link checks and a redacted private-identifier/credential-pattern review with zero findings; all 42 candidate hashes remained unchanged. Those checks are narrower than a dedicated secret scan, which A1/E3 still require.

## Confirmed application contract

| Handler | Authentication/permission | Success and notable behavior |
|---|---|---|
| `GET /api/health` | None | Process-only `{ok,service}`; does not check DB/schema. |
| `POST /api/auth/login` | Administrator credentials | Signed HttpOnly SameSite=Lax cookie; seven-day DB session; five requests/minute route limiter. |
| `POST /api/auth/logout` | Cookie if present | Revokes session; clears cookie; bodyless JSON compatibility hook. |
| `GET /api/auth/session` | Optional signed cookie/Bearer key | 200 with `{authenticated,principal}` even when unauthenticated. This is the future agent connection check. |
| `GET/POST/PATCH/DELETE /api/admin/api-keys[/:id]` | Administrator only | Named six-flag keys; hash/lookup stored, secret returned on creation only; flags in requests use snake_case, public key DTO uses camelCase. |
| `GET /api/admin/storage-usage` | Administrator only | `{bytes}` from recursive disk walk. |
| `POST /api/files` | `can_upload` | Multipart upload, 201 flat File DTO; optional `durable` field. |
| `GET /api/files` | `can_list` | `{files}` with limit/offset/durable filters; route filters expired items. |
| `GET /api/files/:code` | `can_download` | Flat File DTO; missing 404, expired 410 before cleanup. |
| `GET /api/files/:code/download` | `can_download` | Streamed attachment; MIME/header sanitization. |
| `PATCH /api/files/:code` | `can_mark_durable` | JSON boolean `durable`; disabling persistence starts a new default retention period. |
| `DELETE /api/files/:code` | `can_delete` | Delete bytes before metadata mark; failure preserves metadata or reports 500. |
| `POST /api/files/:code/share` | `can_share` | Requires future `expires_at`; optional `max_downloads`; rejects share expiry beyond temporary file expiry. |
| `DELETE /api/share-links/:id` | `can_share` | Revoke bearer share. |
| `GET /s/:token` | Bearer link, no other auth | SHA-256 token lookup and atomic gated increment; unavailable token/file returns 410; count is an admitted request, not completed byte delivery. |
| `GET /`, `GET /files/:code` | Public shell, then login | HTML alone discloses no metadata/bytes; code cannot authenticate download. |

File DTO: `code`, `name`, `mime_type`, `size`, `size_bytes`, `created_at`, `updated_at`, `expiry`, `expires_at`, `durable`, `is_durable`, nullable `sha256`, `private_url`, `api_download_url`, `uploaded_by`, `metadata`. URL construction uses configured base origin. The client uses same-origin HTTP, fetch with credentials, XHR multipart progress, and no framework-specific agent protocol.

## Findings by release impact

| ID | Priority | Verified source evidence | Required resolution |
|---|---|---|---|
| F01 | Blocker | Deployment Compose provides one app attached to an external network/storage arrangement; no owned DB or migration gate. | Fresh Compose/volumes/migration job; B4. |
| F02 | Blocker | `config.ts:loadConfig` rejects localhost HTTP in production; cookie `secure` depends solely on Node environment. Setup command absent. | Explicit local/public mode independent of Node environment; secret-safe setup; B1–B2. |
| F03 | Blocker | `db.ts:getPool` reads process environment despite `buildServer(config)` accepting explicit config. `migrate.ts` runs schema and filename-based backfill without a version ledger/transaction lock. | Explicit DB initialization, pinned migration client, transactional ledger, schema readiness; B3. |
| F04 | Blocker | `filesRoutes.ts:multipartLimits` hardcodes 1 GiB, 20 fields/4 KiB each, one file/25 parts. No capacity, reserve, concurrency admission, or stream-level size checks in storage. | Configured byte limits and single-process reservation; C2. |
| F05 | Blocker | `storage.ts:saveUploadStream` links final bytes before multipart parsing and metadata finish. Assignment to parsed upload occurs after further draining. Explicit cleanup can miss a failure in that interval; process crashes leave staging/final orphans. | Stage through complete validation, finalize once, reconcile crash leftovers; C2/C3. |
| F06 | High | `cleanup.ts` calls `listFiles` whose default limit is 100. Job waits one hour before first execution, has no orphan reconciliation/status, and repeated failures can occupy a page. | Immediate start, keyset sweep with progress past failures, grace/active-upload protection, admin status; C3. |
| F07 | High | Non-durable null expiry is treated as available forever in file/share access and SQL. DB permits this state. Unauthorized durable upload intent is silently downgraded. | Fail-closed temporary-expiry invariant and explicit persistence denial; C1. |
| F08 | High | Auth/list/download checks exist; mutation input validation is inconsistent. No same-origin guard for cookie-authorized writes. Key work uses expensive hashes with only login limited. Default logging has no explicit secret/token policy. | Origin/fetch-metadata defenses, bounded input, pre-auth rate/body limits, log/header hygiene; C1. |
| F09 | High | `storagePath` checks lexical containment, not symlink ancestors; root-equal keys are allowed. Filesystem and SQL deletion are not transactional. | Reject root/reparse/symlink paths, isolate mount, durable retry/observability for DB failure after byte removal; C2/C3. |
| F10 | High | `events.ts` only defines types; tables exist without event/session/metadata purging. | Implement bounded safe lifecycle events and maintenance purge; C3. |
| F11 | High | API/repository/cleanup tests largely inject fake DB/storage; SQL claim assertions do not execute Postgres concurrency. Only one browser API test; no rendered UI tests. | Isolated PG/filesystem and browser tests, genuine clean install; B3/C2/C3/D2/E2. |
| F12 | High | Server-only `tsconfig.json`; Vite transpiles React without a client typecheck. `vitest.config.ts` includes only `.test.ts`. | Client no-emit typecheck, explicit DOM/integration projects; A2. |
| F13 | Medium | Mobile inline detail, dialog, native proportions and stale-action guards are present. Search only filters up to 200 listed files; deep-link errors are swallowed in `prependSelectedFile`. No dedicated agent panel/result expiry/actions. | Preserve UI behavior, add exact lookup/connection flow and distinct errors; D2. |
| F14 | Release gate | Source inventory has no standalone license; package declares no root license; lock metadata includes attribution-bearing data. | Record ownership/redistribution basis and exact notices before source distribution; A1/A2. |
| F15 | High | Startup/migration scripts read process environment without explicit `.env` loading; native commands do not supply an env-file flag. | Document Compose injection and explicit independent native env loading; B1/B2. |

F05 and F09 describe source-observed failure windows and risks, not an executed exploit or crash demonstration. Anonymous share links intentionally grant possession-based download access. No tenant, Stripe, subscription, or telemetry requirement appears in the reviewed application contract; do not add one.

## Dependencies and license metadata

The lockfile resolves 349 non-root package entries (including nested/platform-specific entries, not 349 distinct installed packages). Declared license counts: MIT 300, ISC 21, BlueOak-1.0.0 11, Apache-2.0 5, BSD-3-Clause 5, BSD-2-Clause 2, MIT-0 2, 0BSD 1, CC0-1.0 1, CC-BY-4.0 1. No missing license field was found in that metadata inventory. This is **not** a completed redistribution/license-text review. `caniuse-lite` is the CC-BY-4.0 build dependency: preserve dataset attribution and inspect any notices required by distributed bundles. Inspect installed license files after isolated `npm ci`; include runtime/build/image notices rather than relicensing all dependencies MIT.

| Direct package | Reference lock version | Declared license |
|---|---|---|
| `@fastify/cookie` | 11.0.2 | MIT |
| `@fastify/multipart` | 9.4.0 | MIT |
| `@fastify/static` | 8.3.0 | MIT |
| `@fastify/rate-limit` | 10.3.0 | MIT |
| `argon2` | 0.44.0 | MIT |
| `fastify` | 5.8.5 | MIT |
| `pg` | 8.21.0 | MIT |
| `uuid` | 13.0.2 | MIT |
| `zod` | 4.4.3 | MIT |
| `@types/node` | 24.13.1 | MIT |
| `@types/pg` | 8.20.0 | MIT |
| `@types/react` | 19.2.17 | MIT |
| `@types/react-dom` | 19.2.3 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `concurrently` | 9.2.1 | MIT |
| `jsdom` | 27.4.0 | MIT |
| `react` / `react-dom` | 19.2.7 | MIT |
| `tsx` | 4.22.4 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.5 | MIT |
| `vitest` | 4.1.8 | MIT |

Registry audit on 2026-10-10: full lock **16 affected packages** (2 critical, 10 high, 3 moderate, 1 low); runtime-only **6 high** (`@fastify/busboy`, `@fastify/static`, `brace-expansion`, `fast-uri`, `fastify`, `find-my-way`). These are package-level audit totals, including propagated dependency ratings; they are not counts of proven reachable vulnerabilities. Development critical ratings concern `shell-quote` and its parent `concurrently`. Suggested static-plugin remediation includes a major upgrade; never apply `npm audit fix --force` without checking Fastify/plugin compatibility and regression tests. Raw results stay ignored; A2 reruns audits and records remediation/reachability.

Primary context: [multipart boundary advisory](https://github.com/advisories/GHSA-xjh9-v7x6-24jw), [static route traversal advisory](https://github.com/advisories/GHSA-83w8-p2f5-377r), [shell quoting advisory](https://github.com/advisories/GHSA-w7jw-789q-3m8p). Audit output is advisory metadata, not proof of application exploitability.

## Reconciled decisions

Preserve the seed's agreed MIT complete self-hosted scope. Select Node 24 LTS and Postgres 17 for initial validation; freeze exact maintained image tags/digests at B4 and recheck before release. Node 24 is LTS in the [official schedule](https://github.com/nodejs/Release); Postgres 17 remains supported under the [version policy](https://www.postgresql.org/support/versioning/). These are proposed runtime targets, not tested compatibility claims. Compose's `service_healthy` and `service_completed_successfully` gates are specified by [Docker startup-order documentation](https://docs.docker.com/compose/how-tos/startup-order/).

Choose one app process and one app-owned disk volume. Persistence is enabled as an administrator policy, never automatic, and temporary null expiry becomes invalid. Keep seven-day default retention. Draft the agent skill directly after sanitized foundation; only declare it verified after real HTTP clients pass. Setup supports a tool container so host Node is optional. No need to reopen stack, billing, account/tenancy, protocol, or default-retention decisions.

The owner authorizes MIT licensing and import of their original code; individual third-party contributions/dependencies/assets still require inspection and correct notices. Phase A (A1–A3) is now implemented locally; publication remains separate. Remaining release evidence: third-party attribution/notices; confirmed private security-reporting channel; which OS/architectures actually pass installation; container registry/publishing mechanism if container distribution is enabled. Do not implement B/C under Phase A authorization.

Approved lifecycle requirements added after source inspection: issued short codes must never be reassigned within an installation, even after metadata purge. Phase C specifies a permanent `issued_file_codes(code PRIMARY KEY)` with no file metadata, atomic registry/file allocation, bounded collision retries and explicit namespace exhaustion. Retention changes including keep indefinitely and cleanup/manual deletion must arbitrate through the same row lock and committed deletion claim; keep-first protects against stale cleanup, delete-first rejects keep, and failed/uncertain DB/filesystem steps recover without resurrection. Later real-PG/filesystem regressions must prove both ordered outcomes and that a purged old code cannot resolve a new file. Coordinated restore preserves the full registry, merges independently preserved issuance after an older backup, and disables new issuance if completeness cannot be established. These are design/acceptance decisions, not newly executed source, concurrency, installation or restore evidence.
