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
- Never reassign an issued short file code within an installation, including after deleted-file metadata is purged. A permanent minimal issued-code registry reserves identity independently of file-byte and metadata retention.
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

The API blocks access as soon as a file expires, independently of the cleanup interval. Retention changes (including keep indefinitely), expiry cleanup and manual deletion arbitrate through a Postgres row lock and a committed lifecycle transition. An active row may either receive the authorized retention update or become `deleting` with an immutable deletion claim; cleanup rechecks the current expiry/persistence under that lock. A successful keep commit prevents a stale cleanup candidate from claiming/deleting it. If deletion claims first, keep returns a conflict and never reports success or recreates bytes. Manual deletion may still explicitly delete a kept file. Files in `deleting` are unavailable to new transfers, and byte removal starts only after the claim commit is confirmed. Mark `deleted` only after removal succeeds or confirmed absence; retry the same claim after failure or restart. Protect active uploads and recently written files from orphan cleanup. Report last successful cleanup, pending deletion bytes, failures, and actual managed bytes.

SQL and filesystem operations cannot commit together. A failed/uncertain claim commit permits no unlink until a fresh database read confirms the same claim. Failed unlink retains the claim and capacity charge; successful unlink followed by failed/uncertain metadata commit remains unavailable and is finalized idempotently after confirming absence. Do not revert a claim to active after a filesystem failure or report keep success before a confirmed retention commit. Database or mount uncertainty stops destructive recovery. Phase C must prove both lock-winning orders with barriers on real Postgres and synthetic disk bytes, including crashes/failures between each transition.

Define metadata and event retention separately from file-byte retention. Backup instructions must explain whether expired content can remain in external snapshots; do not promise forensic erasure or deletion of recipient copies. First-download deletion is not part of this release.

Default deleted-metadata and event retention is 30 days. Session/share purging is independently bounded; active records are not age-purged. Cleanup uses fair keyset batches with progress past failed deletions, starts promptly after readiness checks, and reports completion/failures. Reconciliation removes only old owned orphans, never active/recent uploads, and stops deletion decisions when database or mount identity checks fail. External log rotation/backup retention remain operator responsibilities.

`issued_file_codes(code PRIMARY KEY)` stores only the canonical code, permanently: no filename, file ID, content, checksum, MIME, size, owner, timestamps, or other file metadata. A foreign key from file rows reserves their code. Allocate by inserting a new registry entry and file metadata in the same transaction; collision retries choose another candidate without repeating the upload stream. Every committed/issued code remains reserved when file/share/event rows are purged. Rollback before issuance may release an uncommitted candidate; an unknown committed upload outcome may not. After 32 collisions return retryable 503 `CODE_ALLOCATION_RETRY_EXHAUSTED`; only a proven full finite namespace returns 507 `CODE_SPACE_EXHAUSTED`. Never recycle a code or overwrite an earlier file to resolve either condition. Backups/restores must preserve all issued codes, including issuance since an older backup; if that registry cannot be recovered, upload issuance stays disabled rather than silently weakening the guarantee. Agents still verify instance, code, creation time and checksum when checking a handoff.

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

The [2026-10-10 findings](../../audit/2026-10-10-source-findings.md) verify existing routes, source/test structure and dependency metadata. They do not establish passing application tests, installation, browser behavior or deployment. The [proposed import manifest](../../source-import.md) lists 42 individual text-file candidates and requires individual current-content/provenance/diff review and third-party notice inspection before import; the owner's original code is already authorized under MIT. No application source was imported during the planning audit.

The [implementation plan](../plans/2026-10-10-agentfiles-open-source.md) is split into five reviewable phases. Phase A (sanitized import, isolated baseline verification, and an early draft agent skill) is approved and in progress. The owner has authorized their original code under MIT; individually inspect third-party contributions/dependencies/assets and preserve their required notices. Confirmed private security reporting, tested platforms and artifact publication details remain release evidence gates; they do not reopen the settled self-hosted product scope. Later phases require their own execution boundary and are design work here.
