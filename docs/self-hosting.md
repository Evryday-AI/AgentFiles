# Self-hosting preparation

AgentFiles remains in preparation. Phase B has a verified fresh local installation on Docker Desktop with Linux amd64 containers. Lifecycle hardening has [Phase C evidence](verification/phase-c.md) reviewed locally; agent/browser checks, upgrade/restore and final release acceptance remain pending in the [release checklist](release-checklist.md). These instructions describe the tested installation workflow, not a production-ready release.

## Prerequisites and isolation

Use an independent checkout and Docker Engine with Compose, or Docker Desktop in Linux-container mode. The tested versions are in [Phase B evidence](verification/phase-b.md). Linux host installation and arm64 have not been tested. Host Node is optional for container setup/build/start; running the smoke script requires Node 24 and `npm ci`.

The default stack owns one PostgreSQL database volume and one disk storage volume. It needs no agent framework, hosted account, telemetry service, external Docker network or maintainer infrastructure. Keep one app process; replicas sharing a volume are unsupported. Keep the checkout and `.env` private to the operator and supply only database/storage dedicated to this installation.

## Fresh localhost installation

```sh
git clone https://github.com/Evryday-AI/AgentFiles.git
cd AgentFiles
```

Follow [administrator setup](setup.md) to create `.env`. On Linux, map the setup container to your host identity:

```sh
export SETUP_UID=$(id -u) SETUP_GID=$(id -g)
docker compose -f compose.setup.yaml run --rm --build setup
test -r .env
```

On Windows PowerShell with Docker Desktop:

```powershell
docker compose -f compose.setup.yaml run --rm --build setup
$configuration = [System.IO.File]::OpenRead((Join-Path (Get-Location) '.env'))
$configuration.Dispose()
```

Choose `local`, the default `http://localhost:3000` origin and a new administrator password. Setup creates unique secrets and refuses replacement of `.env`. If port 3000 is occupied, privately edit `APP_PORT` and `PUBLIC_BASE_URL` to the same chosen localhost port before starting. Keep the generated single-quote encoding. Compose fixes the container `PORT` at 3000; `APP_PORT` selects the host port.

Run from the checkout:

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/ready
```

For PowerShell, replace the two curl checks with:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/ready
```

Open `http://localhost:3000` and sign in with the credentials you just created. Liveness reports `ok: true`; readiness reports `ready: true` after the expected schema is available. Container health checks address their own localhost, even when the public origin differs.

Compose waits for `db` health, runs the immutable migration CLI once, and starts `app` only after migration exits successfully. A failed migration leaves the app unstarted. PostgreSQL publishes no host port. The app publishes only `127.0.0.1`; this local test does not establish phone access or reachable public HTTPS.

## Storage, stopping and recreation

Docker initializes the `storage` named volume from an image-created `/data/storage` owned by node UID 1000, mode 0750. The non-root app verifies ownership and actual read/write access before listening. This volume ownership is separate from setup's host bind ownership. Do not replace it with a host bind mount or run a blanket host `chown` as a permissions workaround.

Stop/start while preserving volumes:

```sh
docker compose stop
docker compose start
```

Remove service containers/network while preserving data, then start again:

```sh
docker compose down
docker compose up -d
```

Recreate only the app against the existing database and storage:

```sh
docker compose up -d --no-deps --force-recreate app
```

Keep the same Compose project name and checkout directory: changing them creates different default volume names. Normal operation and updates must not use `down --volumes` or `down -v`. Stop grace is 15 seconds, exceeding the application's ten-second shutdown deadline. Hard kills can interrupt transfers. Phase C verifies deterministic recovery windows; actual process-kill and power-loss recovery acceptance remains E2.

## Isolated installation smoke

With Node 24 installed:

```sh
npm ci
node scripts/smoke-compose.mjs
```

The runner generates synthetic credentials/configuration in an ignored dedicated scratch directory. It uses unique Compose projects and disposable volumes, strips ambient application/PG/Compose/Docker settings, and never reads the checkout's `.env` or ambient `DATABASE_URL`. It checks first-start gates, authenticated upload/download checksums, DB outage, recreation, Linux signals, POSIX permissions and real migration failure. It also starts the advanced Compose file against its own synthetic database fixture.

The runner removes only its uniquely owned disposable services/networks/volumes and retains bounded sanitized evidence in ignored scratch. Generated image tags and build cache remain local build artifacts. It never prunes other installations. Smoke success is installation evidence; final review and release gates still apply.

## Advanced independent database

`compose.external-db.yaml` is a complete alternative with only migration/app services and storage. Use it alone, not merged with `compose.yaml`. Provision a dedicated database, replace `DATABASE_URL` in private `.env` with its owner-provided reachable URL, and configure database TLS/access restrictions appropriate to that service. It must be reachable from the app's own default network; no private application's network is required or authorized. Setup's initial URL addresses `db` and requires this edit for an independently provisioned database. `POSTGRES_PASSWORD` is unused by this alternative.

```sh
docker compose -f compose.external-db.yaml config --quiet
docker compose -f compose.external-db.yaml build
docker compose -f compose.external-db.yaml up -d
docker compose -f compose.external-db.yaml ps
```

Migrations gate app startup; the external operator supplies database availability. This file publishes no database port. Stop with `docker compose -f compose.external-db.yaml down` without volume removal. Native operation has separate [configuration](configuration.md) and [migration](migration-notes.md) instructions.

## Public HTTPS proxy requirements

Public operation requires `DEPLOYMENT_MODE='public'`, an external HTTPS `PUBLIC_BASE_URL`, and an independently operated TLS reverse proxy. Require TLS at the proxy and point an on-host proxy at loopback `APP_PORT`. Another container cannot use its own loopback to reach this published listener; author/review that topology separately without widening the default binding.

Set `TRUST_PROXY` to only exact proxy source IP addresses or CIDRs observed by the app. A hostname or forwarded header does not establish trust. Set/overwrite forwarded host/protocol headers at the trusted proxy, reject unapproved Host names and restrict database access. See [configuration](configuration.md).

Allow `MAX_UPLOAD_BYTES` plus multipart headers/fields in the proxy body limit; reserve at least 1 MiB overhead for the current bounded fields/headers. Set upload/read/write/idle timeouts for the largest expected transfers and connection speed. Review buffering and temporary-disk behavior against your storage policy. Preserve application error status codes.

Proxy access/error logs must omit Authorization, cookies and request bodies and scrub bearer tokens in `/s/<token>` paths, including query strings/referrers that could carry links. Restrict log access and retention. App logs use safe route templates and redact secret fields. Configure bounded proxy/container log rotation (recommended maximum 30 days); lifecycle events have separate app-managed retention. See [retention](retention.md). Reachable public HTTPS and actual phone access need separate D2/E2 evidence and were not tested in Phase B.

Storage startup pairs the database and volume through a persistent UUID marker. Preserve `.agentfiles-volume` with all file bytes and the matching database `storage_volume_identity` row. Do not point an existing database at an empty replacement mount: startup refuses this uncertainty. Before any stale-snapshot restore, set `FILE_ISSUANCE_ENABLED=false` and recover the complete issued-code registry, including codes issued after the snapshot. Detailed [recovery boundaries](retention.md) apply; the release backup/restore workflow remains E2.
