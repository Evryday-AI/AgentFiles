# AgentFiles Open Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The first session audits the reference application and refines these work packages into source-verified implementation steps before changing application behavior.

**Goal:** Release a complete MIT self-hosted file handoff app with sanitized source, reproducible installation, reliable expiration, and a usable agent skill.

**Architecture:** Independent repository and runtime; a Fastify/React application streams bytes to disk and keeps metadata in a dedicated Postgres database. Docker Compose supplies all runtime dependencies. An HTTP API is the common interface for humans' browser sessions and agents' scoped keys.

**Tech Stack:** TypeScript, Node.js 22 or a verified supported successor, Fastify, React/Vite, Postgres, Docker Compose, Vitest, OpenAPI, Markdown agent skill.

## Global constraints

- Publish the complete self-hosted application under MIT.
- Keep the open source repository independent from the private application: separate working directory, Git object database, runtime configuration, database, storage, and remote.
- Charge for managed hosting only in a future project. This release contains no payment integration or hosted account requirement.
- Single administrator with multiple named, permission-scoped API keys is sufficient for the first release. Shared customer tenancy and team memberships are deferred.
- Default retention remains seven days for compatibility. Persistent files are an explicit administrator-controlled option, explained in the UI and docs.
- Short file codes require authenticated access. Sharing outside the installation's authorized users uses expiring, revocable, high-entropy bearer links.
- The API is the integration contract. Ship an agent skill and OpenAPI document; native MCP and CLI packaging are later enhancements.
- No private code, history, credential, address, or media is published without the source sanitization checks in Task 1. Never connect test environments to the reference application's database or storage.
- Use only synthetic test assets. Keep private provenance and raw scan findings in ignored `.private/` files. Public reports describe categories and outcomes, not secret values or private paths.
- The seed repository is documentation only. Do not claim that the app is installable until the clean-install acceptance gate passes.

## Current starting point

The reference application is a small TypeScript service with `src/server`, `src/client`, and `tests`. It already implements streaming uploads, short codes, scoped API keys, administrator sessions, share links, file retention, cleanup, and browser previews. Its deployment configuration assumes pre-existing infrastructure. Its schema is single-administrator, without customer tenancy or billing.

The new repository begins with freshly authored documentation and license files. No application code or private Git history has been imported. A local-only source reference will be supplied to the first session separately.

## Sequence and checkpoints

| Checkpoint | Tasks | Reviewable result |
|---|---|---|
| Source foundation | 1 | Sanitized standalone source and baseline verification |
| Self-hosting | 2–3 | Fresh installation works without maintainer infrastructure |
| File lifecycle | 4 | Expiration and storage capacity behavior are demonstrably bounded |
| Agent experience | 5–6 | Agent uploads a file and a human retrieves it on a phone |
| Release | 7–8 | CI, documentation, release artifacts, and acceptance evidence |

Execute in order. Commit each independently verified deliverable. If a source finding changes a proposed interface, update the design and all dependent tasks together before implementation. Hosted-service work is not an implied extension of these tasks.

## Task 1: Audit and import a sanitized source baseline

**Files:**
- Create after review: `src/server/*`, `src/client/*`, `tests/server/*`, `tests/client/*`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`.
- Create: `docs/source-import.md`, `THIRD_PARTY_NOTICES.md` when notices are required.
- Modify: `README.md`, `.gitignore`, `.gitattributes`.
- Keep local only: `.private/source-reference.json`, `.private/audit/`.

**Interfaces:** Read-only reference source enters through an explicit reviewed manifest. The resulting repository has no private remote, history, symlink, runtime directory, or configuration dependency. Build/test commands remain `npm ci`, `npm test`, and `npm run build`.

- [ ] Confirm this repository's top-level directory and separate `.git` directory before copying anything. Verify the source reference commit and working-tree status without checking out or modifying the source.
- [ ] Prefer its graph index for code discovery. Refresh/index only if necessary; never include generated graph artifacts in the export.
- [ ] Inventory tracked source, tests, config, and package metadata. Review each candidate for secrets, personal identifiers, domains, fixed addresses, local paths, proprietary assets, attribution requirements, and runtime side effects.
- [ ] Record an allowlist of exact relative paths. Exclude all source documentation, environment files, screenshots, uploaded media, local tools, Git files, and deployment notes. Configuration examples are authored fresh in later tasks.
- [ ] Copy only reviewed allowlisted regular files. Reject symlinks/reparse points, paths outside the reference root, and unexpected binary files. Do not use clone, a shared worktree, or recursive folder copying.
- [ ] Rename public branding to AgentFiles. Keep externally visible API behavior stable unless documented in a migration note. Set package name to `agentfiles`, add `license: MIT`, and regenerate lock metadata with the package manager. Retaining `private: true` is acceptable to prevent accidental npm publication.
- [ ] Preserve required upstream copyright/attribution. Inventory direct and transitive licenses and resolve any incompatible or unknown redistribution requirement before distributing affected code/assets.
- [ ] Install dependencies only in AgentFiles. Run the existing tests and build; record failures separately from changes introduced by sanitization. Inspect the dependency audit and fix material release blockers with compatible upgrades and regression tests.
- [ ] Run a secret scanner with redacted findings against the working tree and new Git history; separately review personal identifiers and infrastructure references because secret scanners will not detect them all.
- [ ] Inspect the full staged diff and staged path list. Commit only the reviewed paths with a public/noreply identity. Record source counts, sanitized categories, test results, and attribution decisions in `docs/source-import.md` without private provenance.

**Verification commands:**

```powershell
git rev-parse --show-toplevel
git rev-parse --git-dir
git remote -v
npm ci
npm test
npm run build
npm audit --omit=dev
git diff --cached --check
git diff --cached --name-only
```

**Acceptance:** The app builds and its baseline tests pass using only new local dependencies. The staged export contains no private material. Source license requirements are accounted for. A secret-scanner pass is recorded without claiming that it replaces human review.

## Task 2: Independent configuration and initial administrator setup

**Files:**
- Create: `.env.example`, `scripts/setup.mjs`, `docs/configuration.md`, `tests/setup/setup.test.ts`.
- Modify: `src/server/config.ts`, `src/server/auth.ts` where configuration is consumed, `package.json`, `tests/server/config.test.ts`.

**Interfaces:** `npm run setup` creates a local `.env` from validated input without modifying an existing file. Server configuration exposes retention, maximum upload size, managed-storage ceiling, free-disk reserve, public base URL, and cleanup settings. Existing authentication consumes the generated Argon2id password hash.

- [ ] Inspect current configuration parsing and authentication to preserve the verified hash format and session behavior.
- [ ] Write tests for missing/invalid settings, insecure nonlocal production origins, positive integer limits, and valid local-only development configuration.
- [ ] Add a setup command that generates a cryptographically random session secret and database password, requests the administrator password without echo, hashes it, and writes `.env` exclusively. Never pass password values through command-line arguments.
- [ ] Add tests proving repeated setup cannot overwrite an existing `.env`, generated secrets differ between runs, and command output does not expose passwords or hashes. Use temporary test directories outside runtime storage.
- [ ] Replace personal defaults with neutral values. Document each setting, units, default, and whether a restart is required. Do not silently accept production placeholder secrets.
- [ ] Explain Windows file permissions and POSIX restrictive file mode without promising platform guarantees that were not verified.
- [ ] Run the focused setup/config tests, then build. Commit the configuration/setup deliverable and fresh example environment file.

**Acceptance:** An unfamiliar user can create valid configuration without editing source, manually producing password hashes, or using maintainer credentials. Existing configuration is preserved.

## Task 3: Reproducible Docker Compose installation

**Files:**
- Create: `compose.yaml`, `.dockerignore`, `docs/self-hosting.md`, `docs/upgrading.md`, `scripts/smoke-compose.mjs`.
- Create or rewrite: `Dockerfile`.
- Modify: `src/server/index.ts`, `src/server/migrate.ts`, `src/server/db.ts`, `package.json`.
- Add tests: `tests/server/health.test.ts`, extend `tests/server/migrate.test.ts`.

**Interfaces:** Compose owns `db`, `migrate`, and `app` services plus independent database/storage volumes. `/api/health` is liveness; `/api/ready` returns 200 only with database connectivity and expected schema, otherwise 503. Production HTTPS termination is documented separately from local HTTP.

- [ ] Pin a supported Postgres major version and Node base image after checking current primary documentation and dependency compatibility. Document the selected versions; do not use floating `latest` for releases.
- [ ] Define database health checks, a one-shot migration service, and app dependencies requiring successful migration completion. Keep the database private to the Compose network.
- [ ] Bind the default app port to `127.0.0.1`. Add production reverse-proxy instructions that explicitly cover upload limits, request timeouts, HTTPS, trusted forwarded headers, and a reachable public base URL.
- [ ] Run the app as a non-root user. Verify named-volume ownership and exclude `.private`, `.git`, environment files, runtime storage, screenshots, and development caches from the image build context.
- [ ] Test liveness/readiness separately and simulate unavailable Postgres and failed migrations. App startup must not report readiness against an unprepared schema.
- [ ] Build and start an isolated Compose project with disposable credentials and volumes. Upload a synthetic file, restart/recreate the app, and verify the file and metadata persist.
- [ ] Document first installation, logs, stop/start, configuration changes, updates, database compatibility, backup scope, and restore. Normal update commands must preserve volumes.
- [ ] Exercise an isolated restore without reading production data. Commit the deployment deliverable with observed platform coverage.

**Verification commands:**

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/ready
```

**Acceptance:** A clean machine with the documented prerequisites can run the app without an existing database/network, control panel, or maintainer account. Document Docker Desktop testing separately from Linux server testing.

## Task 4: Reliable expiry, cleanup, and storage limits

**Files:**
- Modify: `src/server/storage.ts`, `src/server/cleanup.ts`, `src/server/filesRoutes.ts`, `src/server/filesRepo.ts`, `src/server/adminRoutes.ts`, `src/server/schema.sql` through versioned migrations.
- Add focused modules if required: `src/server/storageLimits.ts`, `src/server/reconciliation.ts`.
- Extend: `tests/server/storage.test.ts`, `tests/server/cleanup.test.ts`, `tests/server/filesRoutes.test.ts`.
- Create: `tests/integration/fileLifecycle.test.ts`, `docs/retention.md`.

**Interfaces:** File access expires independently of deletion scheduling. Upload/storage limits use bytes and account for in-flight reservations. Capacity rejection returns a documented JSON error. Cleanup reports actual removals and failures, is retry-safe, and does not remove active uploads.

- [ ] Add lifecycle tests for expired metadata/download/share access before cleanup runs; all must deny access.
- [ ] Test deletion failure, already-missing bytes, database-update failure, retries, durable files, and overlapping cleanup runs. Metadata must not claim successful deletion while known bytes remain.
- [ ] Enforce upload-size and total-capacity limits during streaming, not only through the client-supplied length. Reserve capacity or serialize admission so concurrent uploads cannot all pass the same free-space check.
- [ ] Add free-disk reserve checks and clear errors. Define the first release's supported single-app-process deployment; do not imply distributed quota correctness without a cross-process reservation design.
- [ ] Reclaim abandoned temporary uploads and orphaned final files using a documented grace period and active-upload protection. Use controlled fixtures and clocks to test crashes without scanning arbitrary host directories.
- [ ] Expose storage usage and cleanup health to the authenticated administrator. Redact credentials and bearer tokens from application and proxy logs.
- [ ] Define metadata/event/session purging and backup limitations. Explain that external snapshots and recipient downloads have independent retention.
- [ ] Run lifecycle tests against a real disposable Postgres database and temporary filesystem, then run the full regression suite and commit.

**Acceptance:** Expired files are inaccessible immediately, bytes are reclaimed within the configured successful-cleanup window, cleanup failures are visible/retryable, and concurrent uploads respect capacity limits.

## Task 5: API contract, examples, and agent skill

**Files:**
- Create: `openapi.yaml`, `skills/agentfiles/SKILL.md`, `docs/agents.md`, `examples/upload.sh`, `examples/roundtrip.py`.
- Create tests: `tests/integration/apiContract.test.ts`, `tests/integration/agentRoundtrip.test.ts`.
- Modify existing route responses only where the documented contract requires it; preserve or explicitly document compatibility.

**Interfaces:** Clients receive `AGENTFILES_BASE_URL` and `AGENTFILES_API_KEY` from their environment. Keep existing `/api/files` endpoints for the initial release; document their version and compatibility policy rather than inventing unsupported routes. The generated spec must match observed handlers.

- [ ] Enumerate actual endpoints, authentication schemes, permission checks, multipart fields, successful JSON responses, and errors from source and integration tests.
- [ ] Define and validate OpenAPI schemas for upload, list, inspect, download, share creation/revocation, and deletion. Include checksum and expiry semantics and expired-versus-missing behavior.
- [ ] Write the skill with frontmatter, supported tasks, prerequisites, environment configuration, exact working examples, response handling, and troubleshooting. Use a configurable instance and synthetic filenames.
- [ ] Explain that codes are scoped to the configured instance and are not credentials. Tell agents to return the full instance-qualified link, short code, and expiration to the user.
- [ ] Document 401/403/404/410/413/429 and capacity failures; honor `Retry-After` where provided. Do not instruct automatic repeated POST uploads after an ambiguous network timeout unless an idempotency mechanism has actually been implemented.
- [ ] Require explicit intent for public-share creation, deletion, and persistence. Do not execute downloaded content, forward API keys across origins, embed keys in URLs, or insert live keys into the distributed skill.
- [ ] Run curl and Python round trips against the disposable Compose instance: upload synthetic bytes, inspect metadata, download, compare SHA-256, and observe expiry. Test insufficient permissions and key revocation.
- [ ] Commit the spec, skill, examples, and contract evidence together. Advertise only agent runtimes actually tested; HTTP capability alone does not guarantee every agent can access local files or networks.

**Acceptance:** An agent with generic HTTP/file tools can complete the workflow from the skill without unstated knowledge of this repository or a provider-specific integration.

## Task 6: Focused self-hosted onboarding and phone handoff

**Files:**
- Modify: `src/client/App.tsx`, `src/client/api.ts`, `src/client/styles.css`, `src/client/components/Settings.tsx`, `src/client/components/UploadPanel.tsx`, `src/client/components/FileDetail.tsx`.
- Create where separation is useful: `src/client/components/AgentSetup.tsx`.
- Extend: `tests/client/api.test.ts`; add meaningful UI/integration coverage for the new flow.

**Interfaces:** Agent setup uses the existing key-management API. A connection check is read-only. Skill download serves static instructions without credentials. Upload results expose private code/link and expiration; public links remain explicitly created separately.

- [ ] Inspect current UI before designing changes. Preserve image/video proportions, gallery/list behavior, keyboard access, and existing mobile-detail fixes.
- [ ] Add an obvious code lookup action and an upload-success view with code, filename, expiry, and copy-link actions.
- [ ] Add an agent setup panel with instance URL, minimal permission presets, one-time key display, setup instructions, skill download, and a read-only connection test.
- [ ] Keep secret-bearing setup snippets out of browser persistence, telemetry, and exported skill files. Explain that copied setup snippets can contain credentials.
- [ ] Make the difference between private and public links visible. Show missing, expired, unauthorized, full-storage, and cleanup-warning states in plain language.
- [ ] Test the phone workflow at a narrow viewport with synthetic portrait and landscape media and keyboard navigation. Verify downloading the agent's output does not require using developer tools.
- [ ] Commit focused UI changes and capture sanitized evidence; do not introduce a broad branding redesign into this task.

**Acceptance:** A human can find and download a newly agent-uploaded file on a phone, and can connect an agent without understanding the server implementation.

## Task 7: Community, security, and automated verification

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`.
- Modify: `README.md`, `docs/release-checklist.md`.

**Interfaces:** CI operates on untrusted contributions with read-only permissions and no deployment credentials. Public docs contain verified commands and synthetic examples. Security reporting directs users away from posting secrets in public issues.

- [ ] Document local development, formatting/build/test commands, project layout, contribution scope, release support policy, and issue reproduction expectations.
- [ ] Configure private vulnerability reporting through available repository settings, or provide a maintainer-approved reporting channel before publishing security-contact instructions. Never invent an email address.
- [ ] Add CI jobs for clean dependency install, type/build validation, tests, secret scanning with redaction, and an isolated Compose/API smoke test. Pin third-party actions to reviewed immutable revisions.
- [ ] Set minimal workflow token permissions. Do not use privileged pull-request workflows that execute contributor code with secrets.
- [ ] Add dependency update configuration. Review dependency alerts; passing a scanner alone is not a claim of application security.
- [ ] Rewrite the README around an actual tested quick start, the handoff workflow, lifecycle guarantees, authentication model, deployment requirements, and license.
- [ ] Commit documentation and CI; verify a fresh remote CI run against the exact commit.

**Acceptance:** A contributor can reproduce verification locally, CI catches meaningful regressions, and the repository has a usable maintenance/security path.

## Task 8: Clean-room release validation and v0.1 packaging

**Files:**
- Create: `docs/releases/v0.1.0.md`, `docs/verification/v0.1.0.md`, `.github/workflows/release.yml` if publishing images through Actions.
- Modify: `package.json`, `package-lock.json`, `docs/release-checklist.md`, `README.md`.

**Interfaces:** Versioned artifacts come from the reviewed release commit. A fresh clone of the public repository is sufficient to build/run. No release step reads local private source, configuration, runtime data, or machine-specific caches.

- [ ] Clone the public repository into an isolated temporary verification directory. Confirm there are no private remotes or history links and repeat secret/identifier scans on all public history.
- [ ] Follow the documented setup exactly using new credentials, an isolated Compose project, and synthetic files. Verify restart, upgrade, restore, expiry, cleanup, and both agent clients.
- [ ] Audit the Docker build context and final image for secrets, private paths, unnecessary development assets, and correct non-root operation.
- [ ] Record OS/architecture, image versions, commands, results, and genuine limitations in the verification report. Do not mark unexecuted checks passed.
- [ ] Finish every release checklist item or explicitly reduce the advertised supported scope. Remove preparation-only wording only after the application is actually installable.
- [ ] Publish versioned source and container artifacts from CI with minimal required permissions. Add checksums/provenance where supported. Do not deploy to the private application's infrastructure.
- [ ] Create release notes describing supported features, installation, limits, retention, and known issues. Keep managed hosting and billing out of the release.

**Acceptance:** A stranger can install, connect an agent, hand off a file to another client/phone, and observe expiration using the public release alone.

## First session instructions

Use GPT-6.1 Sol with high reasoning. Read the design, this plan, and local-only source reference. Inspect the actual reference implementation read-only, then refine Task 1 and the configuration/self-hosting interfaces into source-verified steps. Resolve contradictions in the documents and record a prioritized release risk list without exposing private details. The requested first session is planning and audit: do not import or publish application code, implement later tasks, or deploy anything until the written plan has been reviewed. Routine repository/documentation setup is already authorized.

The session should finish with a detailed reviewed plan, an explicit proposed import manifest, baseline findings, and the next implementation checkpoint. No hosted-service implementation belongs in this session.
