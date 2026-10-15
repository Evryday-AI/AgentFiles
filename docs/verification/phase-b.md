# Phase B: independent runtime verification

Date: 2026-10-10. Scope: B1–B4. Configuration commits are `9b29d50`/`2cadaa2`, setup `874a78e`/`80c6776`, database/readiness/shutdown `1723c84`/`ac48f74`, runtime packaging/build-context protection `9b2af47`/`19336e4`, and final database-isolation fix `313888d`. Each task passed an independent specification and quality review after its fixes. AgentFiles remains in preparation; no release acceptance, production deployment, public HTTPS or phone-access claim is made.

## Platforms and pinned artifacts

Host: Windows x64, Node 24.21.0, npm 11.19.0. Runtime: Docker Desktop Linux amd64, Engine 29.5.3, Compose 5.1.4. Actual containers run Node 24.21.0/npm 11.19.0 and PostgreSQL 17.11 on Debian bookworm. Native Linux host Docker/bind setup, arm64 and other Desktop platforms are untested.

| Official image | Tested immutable index digest |
|---|---|
| `node:24.21.0-bookworm-slim` | `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` |
| `postgres:17.11-bookworm` | `sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826` |

The tested amd64 manifests are Node `sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd` and Postgres `sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df`. Patch tags/manifests were checked with `docker buildx imagetools inspect` and the official [Node image catalog](https://github.com/docker-library/official-images/blob/master/library/node) and [Postgres image catalog](https://github.com/docker-library/official-images/blob/master/library/postgres). The primary [Node schedule](https://github.com/nodejs/Release) gives Node 24 maintenance through 2028-04-30; [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) gives version 17 support through 2029-11-08. Pins require deliberate review/update; they do not promise future advisories remain absent.

The multi-stage build installs the reviewed lock with `npm ci`, builds client/server, copies immutable SQL, installs production dependencies separately and runs as node UID 1000. The image includes skill and MIT/third-party notices; tests, source, private/env/runtime inputs and development dependencies are absent from the runtime. Image SQL SHA-256 values equal source file bytes. No secret is needed or supplied for build.

Actual Linux artifacts: Argon2 0.44.0 glibc native prebuild loaded and real login/password verification succeeded; esbuild 0.28.2 and Rollup 4.64.5 built the client. Their actual shipped license texts and node-addon-api match the full texts already preserved in `THIRD_PARTY_NOTICES.md` under its documented whitespace normalization. Linux esbuild records Go 1.26.5, matching the existing Go license supplement. Base Node license and 88 Debian `/usr/share/doc/*/copyright` files remain in the image; PostgreSQL's official image retains its supplied license files. This is specific artifact attribution review, not an exhaustive audit of all container OS packages.

The image's npm 11.19.0 Arborist skips only explicit `allowScripts=false`; unreviewed hooks are permitted and produce advisory warnings. Argon2/esbuild hooks were reviewed in [dependency evidence](../dependencies.md). Native fallback compilation and optional-binary download branches were not separately exercised. No dependency changes occurred in B4.

## Executed checks and actual installation

Only newly generated synthetic credentials/bytes and dedicated owned resources were used. The runner strips ambient app, PostgreSQL, Compose and Docker settings and uses explicit scratch env files/project directories. It never reads the checkout's `.env` or ambient database URL. Expanded configuration/container environment was never printed. Logs are bounded and sanitized; raw local provenance/evidence stays ignored.

| Category / command | Observed result |
|---|---|
| Configuration focused tests | B1: 104/104 passed; later invalid Argon2-cost regression: 79/79 |
| Setup focused tests | B2: exclusive writes, random secrets, hidden prompts, encoding, cancellation and real password verification passed |
| B3 real PostgreSQL suite | 11/11 passed with explicit isolated database connection; migration rollback/advisory concurrency/ledger/CLI/readiness; separate from mocked unit tests |
| `npm test -- tests/setup/smokeCompose.test.ts` | B4 isolation guard tests passed after expected RED |
| `docker build -f Dockerfile.setup ...` plus real `docker run --rm -it --network none ...` | Rebuilt final setup source; hidden TTY inputs created new configuration in an owned Desktop bind fixture; Windows host read-access passed; final-prompt cancellation exited1 and created no file |
| `node scripts/smoke-compose.mjs` | Actual fresh Compose build/install scenarios below passed; owned disposable services/networks/volumes removed |
| Final `npm test` | 256/256 tests in 17 files passed after the final database-option regression, zero failures/skips |
| Final `npm run typecheck` / `npm run build` | Both server/client typechecks and client/server/SQL build exited 0 |
| `npm run test:integration -- tests/integration/buildContext.test.ts` | Actual Docker context regression: 19 required inputs present, 84 forbidden nested inputs absent |
| Full and runtime-only `npm audit --json` | Zero reported vulnerabilities; no dependency versions changed after the audit |
| Tracked-file/private-identifier and full-history secret scans at `19336e4` | 99 tracked files and commit metadata checked; 11 commits secret-scanned with redacted output, zero findings |

The smoke command performs `config --quiet`, `build`, `up -d` and explicit container/HTTP checks under unique projects. It observed healthy PostgreSQL and migration exit 0 before app start, no DB published port, loopback-only app binding and a UID1000-owned writable volume after first Docker copy-up. Local administrator name containing `$` and generated Argon2 hash survived Compose encoding; login returned signed HttpOnly/SameSite=Lax cookie without Secure. Client assets and authenticated synthetic upload/metadata/download returned 200/201 with exact SHA-256/bytes.

Stopping the owned database yielded readiness 503/`ready:false` within the bounded request deadline while liveness stayed 200. Restart restored readiness. App recreation preserved its metadata, administrator session and download bytes. Actual Linux SIGINT and SIGTERM both drained and exited 0 within the 15-second stop grace. Wrong POSIX owner and world-writable root each failed startup; restoration of the exact owned named volume to UID1000/mode0750 restored readiness/download without byte loss.

A separate owned database fixture's ledger checksum was deliberately corrupted. The real migration CLI exited 1; Compose reported the failed completion dependency and left app unstarted. The complete `compose.external-db.yaml` alternative also started successfully with only migration/app services and its own storage, using a temporarily attached synthetic owned database fixture on its own default network. That endpoint was disconnected before cleanup. This exercises the alternative without borrowing any existing infrastructure/network.

Initial smoke caught harness issues (assuming `db` exists in advanced cleanup, an incorrect Docker stop-timeout inspect field, and a mismatched synthetic advanced fixture password). Each was corrected and the complete smoke rerun. No application source or immutable SQL was changed by B4.

Task review identified nested environment/private/runtime inputs admitted by recursive Docker inclusions. A synthetic Docker context regression reproduced 80 forbidden inputs before the fix; narrowed inclusions and final exclusions removed all 84 forbidden fixtures while preserving 19 required inputs. Runtime and setup rebuilds retained identical image payloads. The controller then independently reran all 254 unit tests, both typechecks, the build, 11 real PostgreSQL tests and the real Docker context regression at `19336e4`; all passed. Normalized local documentation links also passed. Status/evidence edits were separately reviewed and staged-scanned.

The entire 11-file staged B4 diff was inspected. `git diff --cached --check`, the redacted private-identifier check and Gitleaks 8.30.1 staged scan with `--redact=100` passed with zero findings. No reference files were read by the identifier check. Raw scanner reports remain ignored; final release image-layer/archive/history scanning remains Phase E.

Final whole-branch review found that a URL's reserved `connectionString` query option could trigger a second pg parser after the factory pinned credentials, port and timeouts. The factory now rejects that option before Pool construction. Two regressions first failed because plain and percent-encoded option names were accepted; they now verify the fixed value-free error and absence of Pool construction. Real `pg.Client` parsing with synthetic ambient settings also verifies ordinary explicit URLs retain their credentials, port and bounded timeouts without opening a network connection. Fresh covering configuration/database/migration/readiness tests passed 102/102, the complete unit suite passed 256/256, both typechecks and the build passed, and the existing real PostgreSQL suite passed 11/11 through the isolated fixture launcher. Existing TLS behavior remains covered; immutable SQL and dependencies did not change. This source, unit and database evidence is separate from the earlier Compose installation checks.

The whole-branch re-review approved `313888d` with no remaining findings. The controller independently reran `npm test` (256/256 passed) and `node scripts/smoke-compose.mjs` against that corrected source. The final Linux amd64 image passed all ten actual installation scenarios described above, including real migration failure, database outage, recreation, signals, storage permissions and the complete external-database alternative. The runner exited 0 after removing its owned disposable services and volumes.

## Limits and remaining release work

The Docker Desktop bind/setup and Linux-container POSIX checks do not establish native Linux host UID/mode behavior. Public HTTPS/proxy routing and actual phone access remain D2/E2. Phase C lifecycle/authorization/log/capacity/registry recovery, D generic HTTP/browser clients, E upgrades/restores/public-clone/CI/release-artifact scans remain pending. Normal [update instructions](../upgrading.md) preserve volumes, but no version-to-version upgrade or restore was executed here. The [release checklist](../release-checklist.md) stays unchecked until exact release evidence exists.
