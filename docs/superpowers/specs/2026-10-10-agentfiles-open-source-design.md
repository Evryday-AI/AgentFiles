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

Compose starts a database, a one-shot migration job, and the web/API service with separate persistent volumes for Postgres and file bytes. The default development/local profile binds only to loopback; HTTP localhost supports a local smoke test. The production guide requires a configured HTTPS public origin and trusted reverse proxy. A first-run command generates configuration and an administrator password hash without exposing secrets in logs or command-line arguments. A web setup wizard is not required for this release.

Provide explicit application configuration for public origin, storage directory, retention, upload size limit, total managed-storage ceiling, free-disk reserve, and cleanup cadence. Validate configuration at startup. Never contact maintainer infrastructure during startup or normal use.

Readiness checks establish database connectivity and successful migrations. Liveness checks only establish that the process responds. Container startup waits for migrations to succeed and stops on migration failure.

## File lifecycle

Authenticated uploads stream to an application-owned temporary directory. Track byte counts and a SHA-256 digest without buffering the whole file. Enforce configured upload size, available capacity, and permitted retention. A failed upload or failed metadata insertion removes its temporary/final bytes where safe; a reconciliation job handles process-crash leftovers.

The API blocks access as soon as a file expires, independently of the cleanup interval. Cleanup deletes expired bytes and marks metadata only after deletion succeeds. Repeated cleanup is safe. Protect active uploads and recently written files from orphan cleanup. Report last successful cleanup, pending expired bytes, failures, and actual managed bytes.

Define metadata and event retention separately from file-byte retention. Backup instructions must explain whether expired content can remain in external snapshots; do not promise forensic erasure or deletion of recipient copies. First-download deletion is not part of this release.

## Agent contract

Use `AGENTFILES_BASE_URL` and `AGENTFILES_API_KEY` in clients. The skill specifies upload, metadata lookup, authenticated download, explicit public-share creation, and authorized deletion. Responses include code, original name, MIME type, size, checksum where available, expiration, and instance-qualified URLs. An example must never contain real credentials or a private deployment address.

Describe permissions and status codes, including 401, 403, 404, 410, 413, 429, and storage-capacity rejection. Never recommend blind retries of an upload whose outcome is unknown. Document redirect and token handling: send credentials only to the configured instance, do not forward them to arbitrary download URLs, and do not execute downloaded files.

## Human interface

Keep existing gallery/list browsing, original media proportions, and mobile detail behavior. Add a clear upload result with copy-code and copy-link actions, visible expiration, code lookup, and an agent-connection panel. Distinguish private download links from public bearer links. Agent setup displays the base URL, permission choices, a one-time key, skill download, and a connection check without putting secrets into downloadable skills.

## Validation

Use existing unit tests as a starting baseline, then test actual Postgres integration, filesystem deletion, capacity races, and clean Compose installation. Exercise agent instructions with independent shell and Python clients and view a synthetic uploaded file in a narrow/mobile viewport. Scan the staged repository, complete new Git history, and release artifacts before distribution. Record unsupported or untested platforms honestly.

## Out of scope

Subscriptions, Stripe, managed hosting, public anonymous uploads, cross-instance replication, shared multi-customer tenancy, server-side scraping, video transcoding, native phone apps, end-to-end encryption claims, a dedicated CLI, and a native MCP server.
