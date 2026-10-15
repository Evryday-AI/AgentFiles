# AgentFiles MIT self-hosted implementation plan

> **For agentic workers:** Phases A (A1–A3), B (B1–B4), C (C1–C3) and D (D1–D2) are implemented and reviewed locally; use `executing-plans` and track checkbox steps. The owner authorizes MIT licensing and import of their original code within that reviewed scope; pushing or publishing source requires a separate instruction. Continue individual content/provenance and third-party notice checks. Phase E requires later authorization and execution; Phase D authorization does not start it. Production runtime migration and deployment are outside this authorization.

**Goal:** Release a complete independent MIT file handoff app that a stranger can install, connect to a generic HTTP-capable agent, and use on a phone.

**Architecture:** Fastify streams files into an app-owned disk volume and keeps metadata, scoped keys, sessions, and shares in dedicated Postgres. React/Vite supplies browser access. Docker Compose supplies owned services and an optional setup container; the HTTP API and Markdown skill need no hosted account, telemetry, MCP service, or payment service.

**Tech Stack:** TypeScript, Node 24 LTS validation target, Fastify 5 with compatible reviewed plugins, React/Vite, Postgres 17 validation target, Compose, Vitest, browser checks, OpenAPI 3.1, Markdown. Freeze image patch tags/digests after isolated builds; do not guess them.

## Global constraints

- Publish the complete self-hosted application under MIT.
- Keep the open source repository independent from the private application: separate working directory, Git object database, runtime configuration, database, storage, and remote.
- Charge for managed hosting only in a future project. This release contains no payment integration or hosted account requirement.
- Single administrator with multiple named, permission-scoped API keys is sufficient for the first release. Shared customer tenancy and team memberships are deferred.
- Default retention remains seven days for compatibility. Persistent files are an explicit administrator-controlled option, explained in the UI and docs.
- Short file codes require authenticated access. Sharing outside the installation's authorized users uses expiring, revocable, high-entropy bearer links.
- Issued short file codes are never reassigned within an installation, even after metadata purge; retain only their canonical code in a permanent registry.
- The API is the integration contract. Ship an agent skill and OpenAPI document; native MCP and CLI packaging are later enhancements.
- One app process and app-owned volume, no horizontal replicas. Only new synthetic fixtures, credentials, media, and test databases.
- Never recursively copy source or import Git/runtime data. Exact paths: [source-import.md](../../source-import.md). Raw provenance stays ignored. Preserve public/noreply identity; review entire staged diffs and redact scanner matches.
- Preparation status stays until release acceptance. No production deployment belongs to these tasks.

## Evidence and sequence

Read [design](../specs/2026-10-10-agentfiles-open-source-design.md), [findings/route inventory](../../audit/2026-10-10-source-findings.md), [allowlist](../../source-import.md), and [checklist](../../release-checklist.md). Source inspection found 82 test cases; zero application tests/builds/installs were executed in planning. Registry audit reports 16 affected packages, six runtime high. No private runtime compatibility/data migration is promised.

| Phase | Tasks | Reviewable result | Detailed plan |
|---|---|---|---|
| A | A1–A3 | Sanitized import, isolated baseline, agent instructions first | [Foundation](2026-10-10-agentfiles-phase-a.md) |
| B | B1–B4 | Safe setup, explicit local/public mode, gated migration, fresh Compose | [Self-hosting](2026-10-10-agentfiles-phase-b.md) |
| C | C1–C3 | Auth/input defenses, bounded uploads, cleanup/recovery/retention | [Lifecycle](2026-10-10-agentfiles-phase-c.md) |
| D | D1–D2 | OpenAPI, real agent clients, browser/phone handoff | [Agent and browser](2026-10-10-agentfiles-phase-d.md) |
| E | E1–E3 | CI, upgrade/restore, clean public-clone release acceptance | [Release](2026-10-10-agentfiles-phase-e.md) |

Each task ends with checks and an explicit-path commit. Review each phase before the next. Current approved implementation boundary: **A1–A3, B1–B4, C1–C3 and D1–D2, implemented and reviewed locally**, with [Phase A evidence](../../verification/phase-a.md), [Phase B evidence](../../verification/phase-b.md), [Phase C evidence](../../verification/phase-c.md) and [Phase D evidence](../../verification/phase-d.md). Phase D's Chromium viewport evidence does not establish physical-phone or public HTTPS behavior. Phase E remains pending; local phase checks do not establish release acceptance.

## Shared interface decisions

1. Preserve routes and File DTO aliases. No `/v1` rename. Add optional `code` to existing `{error}`. Status: malformed 400, auth 401/403, missing 404, expired 410, multipart/file size 413, throttle/concurrency 429 with `Retry-After`, capacity 507, readiness 503. Hidden deleted-file lookup stays 404; expired pre-cleanup lookup is 410. Missing active bytes yield controlled 500, never raw paths.
2. `NODE_ENV=production` governs optimized behavior; `DEPLOYMENT_MODE=local|public` governs origin/cookie transport. Local is loopback HTTP, no proxy trust, loopback published port. Public is external HTTPS, Secure cookie, explicit trusted proxy addresses. Both enforce auth, validation, limits, and secrets.
3. Defaults: seven-day retention; 1 GiB file limit; 10 GiB managed ceiling; 1 GiB free reserve; four concurrent uploads; one-hour cleanup; 24-hour orphan grace; 100-file batches; 30-day deleted-metadata/event retention. B1 defines every setting. Permanent `issued_file_codes(code PRIMARY KEY)` contains only canonical codes, no file metadata, and survives metadata/event/share purge. Registry+file allocation is atomic; collisions retry up to 32 candidates without replaying the stream, then 503 `CODE_ALLOCATION_RETRY_EXHAUSTED`; proven full namespace returns 507 `CODE_SPACE_EXHAUSTED`, never reuse. Preserve the complete registry on restore or disable new issuance. Agents also compare instance, checksum and creation time.
4. Persistence requires per-operation intent, installation `ALLOW_PERSISTENT_FILES=true`, and `can_mark_durable`. Denied intent returns 403. Temporary null expiry fails closed and violates DB constraint. Disabling persistence starts a fresh default interval. Retention changes and cleanup/manual deletion lock the same row: retention commits while active, or deletion commits `deleting` plus claim before unlink. Cleanup revalidates expiry under lock. Keep that wins prevents stale cleanup deletion; deletion that wins causes keep 409 `FILE_DELETION_IN_PROGRESS` (deleted/missing stays 404), never false success. Claims remain unavailable and recoverable after DB/filesystem failures; only confirmed absence permits `deleted`. No first-download file deletion.
5. Shares use 32 random bytes, stored hashed, with mandatory future expiry bounded by file expiry and optional atomic request-admission count. Expiry/revocation blocks new transfers; it cannot retract delivered bytes and does not terminate a transfer already started. Range/resumable downloads and transcoding are deferred; phone previews/downloads still must pass on advertised browsers.
6. Agent connection check is `GET /api/auth/session`, examining `authenticated`. New `GET /api/instance` supplies only configured origin, retention, upload limit, persistence policy and skill URL. Admin storage usage retains `bytes` plus capacity/cleanup details. New `/api/ready` checks DB/expected schema with timeout; liveness remains independent.
7. Setup is an exclusive `.env` writer via optional tool container or host Node, hidden password prompt, no web wizard. Document/test filesystem ownership and Windows permissions. Never use reference config.
8. New API keys: `af_<24 hex lookup>_<64 hex secret>`; cookie `agentfiles_admin`. Change parser/tests/skill/docs together. No reference accounts, keys, sessions, or files are imported.

## Remaining evidence and reporting

No product decision blocks this plan. The owner's original code is authorized for MIT licensing; inspect individual third-party material and record required notices before distribution. Before release, confirm private security reporting, actually tested OS/architectures, and container publishing mechanism if enabled. Select image digests after successful builds. These do not reopen hosting/billing scope or require renewed blanket approval of the owner's code.

Record executed commands, exact public commit, environment/image versions, synthetic fixtures, observed results and limitations. Raw logs stay ignored; summaries are redacted. Unit tests, clean installation, and deployed behavior are distinct claims. This project was not deployed in planning.
