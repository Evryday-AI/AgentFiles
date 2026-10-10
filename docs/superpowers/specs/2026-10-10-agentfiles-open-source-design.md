# AgentFiles open source release design

Date: 2026-10-10

## Goal

A new user can install AgentFiles on their own machine or server, connect an AI agent, upload a file, retrieve it through another authorized client or phone, and verify expiration without assistance from the maintainer.

## Product decisions

- Publish the complete self-hosted application under MIT.
- Keep the open source repository independent from the private application: separate working directory, Git object database, runtime configuration, database, storage, and remote.
- Charge for managed hosting only in a future project. This release contains no payment integration or hosted account requirement.
- Retain TypeScript, Fastify, React/Vite, Postgres metadata, and streamed local filesystem storage for the first release.
- Package the app and a dedicated Postgres database through Docker Compose. An existing external Postgres database remains an optional advanced configuration.
- Single administrator with multiple named, permission-scoped API keys is sufficient for the first release. Shared customer tenancy and team memberships are deferred.
- Default retention remains seven days for compatibility. Persistent files are an explicit administrator-controlled option, explained in the UI and docs.
- Short file codes require authenticated access. Sharing outside the installation's authorized users uses expiring, revocable, high-entropy bearer links.
- The API is the integration contract. Ship an agent skill and OpenAPI document; native MCP and CLI packaging are later enhancements.

## Delivery boundaries

1. Sanitized source foundation and a recorded dependency/license review.
2. Standalone installation and first-run setup.
3. Predictable expiration, bounded storage, and operational visibility.
4. Documented agent integration and focused mobile onboarding.
5. Verified public release and maintenance documentation.

Each boundary has its own review and acceptance evidence. Avoid unrelated refactors and broad visual redesigns.

## Self-hosting architecture

Compose starts an owned database, a one-shot migration job, and the web/API service with separate persistent volumes for Postgres and file bytes. The local deployment binds only to loopback; HTTP localhost supports a local smoke test. `DEPLOYMENT_MODE=local|public` defines transport policy independently of `NODE_ENV=production`: local permits loopback HTTP with a non-Secure signed cookie; public requires an external HTTPS origin, Secure cookie, and an explicitly trusted reverse proxy. Both modes enforce authentication, secrets, validation, and upload limits. A first-run command generates configuration and an administrator password hash without exposing secrets in logs or command-line arguments. An optional setup tool container removes the host Node prerequisite; a web setup wizard is not required.

Provide explicit application configuration for public origin, storage directory, retention, upload size limit, total managed-storage ceiling, free-disk reserve, and cleanup cadence. Validate configuration at startup. Never contact maintainer infrastructure during startup or normal use.

The initial validation targets are Node 24 LTS and Postgres 17; freeze maintained image patch versions/digests after actual compatible builds. Support one application process and one exclusively owned disk volume, without horizontal replicas or external byte writers. Default upload size is 1 GiB, managed ceiling 10 GiB, free-space reserve 1 GiB, concurrency four, cleanup cadence one hour, and orphan grace 24 hours. Conservative admission reserves the maximum permitted file size for each accepted stream; a small upload can be rejected if that worst-case headroom is unavailable. These are explicit proposed operational defaults, not measured installation guarantees.

Readiness checks establish database connectivity and successful migrations. Liveness checks only establish that the process responds. Container startup waits for migrations to succeed and stops on migration failure.

## File lifecycle

Authenticated uploads stream to an application-owned temporary directory. Track byte counts and a SHA-256 digest without buffering the whole file. Enforce configured upload size, available capacity, and permitted retention. A failed upload or failed metadata insertion removes its temporary/final bytes where safe; a reconciliation job handles process-crash leftovers.

Validate the complete multipart request, truncation, and persistence authorization before finalizing bytes. Use opaque storage keys independent of short codes; hold active-upload protection through metadata commit/compensation. Persistence requires `ALLOW_PERSISTENT_FILES=true` administrator policy and the principal's permission; forbidden persistence intent returns 403 instead of silently changing intent. Non-persistent files must have an expiration; null-expiry temporary records fail closed. Disabling persistence applies a fresh default retention interval.

The API blocks access as soon as a file expires, independently of the cleanup interval. Cleanup deletes expired bytes and marks metadata only after deletion succeeds. Repeated cleanup is safe. Protect active uploads and recently written files from orphan cleanup. Report last successful cleanup, pending expired bytes, failures, and actual managed bytes.

Define metadata and event retention separately from file-byte retention. Backup instructions must explain whether expired content can remain in external snapshots; do not promise forensic erasure or deletion of recipient copies. First-download deletion is not part of this release.

Default deleted-metadata and event retention is 30 days. Session/share purging is independently bounded; active records are not age-purged. Cleanup uses fair keyset batches with progress past failed deletions, starts promptly after readiness checks, and reports completion/failures. Reconciliation removes only old owned orphans, never active/recent uploads, and stops deletion decisions when database or mount identity checks fail. External log rotation/backup retention remain operator responsibilities. After metadata purge a short code may be reused; agents compare instance, code, creation time and checksum rather than treating a code as a permanent identity.

Access checks apply at transfer admission. Expiry/revocation prevents new transfers but cannot retract delivered bytes and does not abort a transfer already started. Optional public-share download limits count admitted requests, not successfully completed deliveries. HTTP range/resumable transfers are deferred and browser preview/download support must be verified for advertised browsers.

## Agent contract

Use `AGENTFILES_BASE_URL` and `AGENTFILES_API_KEY` in clients. The skill specifies upload, metadata lookup, authenticated download, explicit public-share creation, and authorized deletion. Responses include code, original name, MIME type, size, checksum where available, expiration, and instance-qualified URLs. An example must never contain real credentials or a private deployment address.

Author the initial skill immediately after sanitized foundation; mark it source-derived until independent curl and Python runtime checks pass. Preserve actual unversioned `/api/files` routes and response aliases in the first release. The read-only connection check is `/api/auth/session`; HTTP 200 alone is insufficient because unauthenticated responses also use 200. `/api/instance` exposes only non-secret configured instance/retention/upload/persistence/skill metadata. One-time key checks omit browser cookies so an administrator session cannot hide a bad key.

Describe permissions and status codes, including 401, 403, 404, 410, 413, 429, and storage-capacity rejection. Never recommend blind retries of an upload whose outcome is unknown. Document redirect and token handling: send credentials only to the configured instance, do not forward them to arbitrary download URLs, and do not execute downloaded files.

## Human interface

Keep existing gallery/list browsing, original media proportions, and mobile detail behavior. Add a clear upload result with copy-code and copy-link actions, visible expiration, code lookup, and an agent-connection panel. Distinguish private download links from public bearer links. Agent setup displays the base URL, permission choices, a one-time key, skill download, and a connection check without putting secrets into downloadable skills.

## Validation

Use existing unit tests as a starting baseline, then test actual Postgres integration, filesystem deletion, capacity races, and clean Compose installation. Exercise agent instructions with independent shell and Python clients and view a synthetic uploaded file in a narrow/mobile viewport. Scan the staged repository, complete new Git history, and release artifacts before distribution. Record unsupported or untested platforms honestly.

## Out of scope

Subscriptions, Stripe, managed hosting, public anonymous uploads, cross-instance replication, shared multi-customer tenancy, server-side scraping, video transcoding, native phone apps, end-to-end encryption claims, a dedicated CLI, and a native MCP server.

## Source audit and implementation boundaries

The [2026-10-10 findings](../../audit/2026-10-10-source-findings.md) verify existing routes, source/test structure and dependency metadata. They do not establish passing application tests, installation, browser behavior or deployment. The [proposed import manifest](../../source-import.md) lists 42 individual text-file candidates and requires current-content/rights/diff review before import. No application source was imported during the planning audit.

The [implementation plan](../plans/2026-10-10-agentfiles-open-source.md) is split into five reviewable phases. The first checkpoint is sanitized import, isolated baseline verification, and an early draft agent skill. Source redistribution evidence, confirmed private security reporting, tested platforms and artifact publication details are release evidence gates; they do not reopen the settled self-hosted product scope.
