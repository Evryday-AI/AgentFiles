# AgentFiles phase E implementation plan: operations and verified public release

> **For agentic workers:** Use `executing-plans` after D review. Release requires every advertised acceptance gate, not just unit tests.

**Goal:** Produce reproducible CI/operations and a reviewed release from public source alone.

**Architecture:** Untrusted contributions run read-only CI with synthetic fixtures. Backup/restore uses isolated owned volumes and quiesced app writes. Versioned source/container artifacts derive only from the reviewed public commit and are inspected before publication.

**Tech Stack:** GitHub Actions, Docker Compose, npm/Vitest/Playwright, redacting secret scanner, Postgres pg_dump/restore, checksums/SBOM.

## Global constraints

All [master constraints/interfaces](2026-10-10-agentfiles-open-source.md) apply. No private infra/source/runtime in builds or validation. No production deployment. Preserve public/noreply identity. Actual install/restore/phone/platform evidence must precede corresponding support claims.

## E1: CI, contribution/security policy and release gates

**Files:** Create `CONTRIBUTING.md`, `SECURITY.md`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `scripts/check-public-export.mjs`, `tests/tools/publicExport.test.ts`; modify `package.json`, `vitest.config.ts`, `.gitignore`, `README.md`, `docs/release-checklist.md`; create `docs/verification/phase-e.md`.

**Interfaces:** `check-public-export.mjs` scans an explicitly supplied tracked/export root and emits redacted category/count/relative path, failing nonzero on unresolved secret/forbidden artifacts. Private identifier patterns are local ignored input for owner pre-publication checks, never public CI secrets/config. CI scanner separately checks generic secrets/history; static public-safe rules catch private caches/env/media/build/runtime artifacts.

- [ ] Write synthetic scanner tests for forbidden `.env`, runtime upload, graph DB, reparse/binary artifacts, credentials/private-path patterns and allowed `.env.example`, license notices/reserved example URL. Add `tests/tools/**/*.test.ts` to the default unit include list (A2 initially limits discovery to server/client and B2 adds setup). Test reports omit matched secret values. Refuse directories outside the explicitly resolved export root; generated test cleanup verifies containment. No whole-tree hash/log output exposing user material.
- [ ] Define normal PR/push CI with `permissions: contents: read`, no deploy secrets, no `pull_request_target` execution of contributor code, no untrusted shared caches. Pin reviewed actions/scanners to immutable revisions; verify compatibility from primary releases at implementation time rather than guessing SHA values in this plan.
- [ ] CI clean checkout/install, both typechecks, unit/setup/DOM tests, build, OpenAPI validation, audit/license report, full-history redacted secret scan, isolated PG integration, browser tests, and Compose/agent smoke. Jobs use explicit disposable test settings, never repository production secrets. Logs suppress expanded Compose config/DB credentials and scrub share tokens/passwords.
- [ ] Keep dependency updates enabled for npm and Actions. Review material alerts manually, with compatibility/regression checks from A2. Enforce runtime high/critical and build-critical gate; lower-risk exceptions have owner/reason/date/expiry/reproduction evidence, no indefinite blanket exclusions. Scanner failures are failures even if another job passes.
- [ ] Contribution docs list setup/test commands, complete vs deferred scope, path layout, synthetic fixtures, single process and support policy. Security policy uses confirmed GitHub private reporting URL/settings or a maintainer-approved private channel; verify before publishing, never invent an email. Public issues request redacted reproduction and prohibit real keys/file contents.
- [ ] README remains preparation until E3; prepare verified quick-start text but do not imply acceptance already passed. Include persistence default/policy, private vs public links, retention/backup limits, minimum prerequisites, actual platform matrix and license/notices. Add ignore entries for test results/browser traces/__pycache__/artifacts/backups while ensuring release artifacts built deliberately outside runtime data.

**Commands:** `npm test -- tests/tools/publicExport.test.ts`; `node scripts/check-public-export.mjs --tracked`; `npm run typecheck`; `npm test`; `npm run build`; `npm run validate:openapi`; `npm run test:integration`; `npm run test:browser`; `node scripts/smoke-compose.mjs --agents`. Review workflow syntax and run actual remote CI on the exact public commit once source push is separately authorized. A local workflow read is not a remote CI pass.

**Acceptance/commit:** Meaningful CI/maintenance path, confirmed private reporting, docs match observed features. `ci: verify standalone installation and secure public contributions`.

## E2: real operations, crash process, backup/restore and upgrade

**Files:** Create `scripts/backup.mjs`, `scripts/restore-smoke.mjs`, `tests/integration/operations.test.ts`, `docs/backups.md`; modify `scripts/smoke-compose.mjs`, `docs/upgrading.md`, `docs/self-hosting.md`, `docs/retention.md`, phase-e evidence.

**Interfaces:** Backup explicitly selects owned Compose project/volumes, requires app quiescence, writes database dump/file archive/config recovery guidance into an ignored operator-selected directory; never traverses generic host mounts. Restore smoke targets a newly named isolated project, never existing live volumes. Dump/backup bytes are **runtime data**, never source/release artifacts.

- [ ] Exercise setup from scratch with regenerated secrets and isolated project. Verify normal `down`, app/db recreation, failed migration gates, changed local/public config, upgrade new version then rollback using backup, and no normal command deletes volumes. Version upgrades run a fresh `migrate` job explicitly even if Compose retains the old successful migration container.
- [ ] Add real subprocess crash tests: pause upload after temp creation and after finalization/pre-metadata, terminate disposable app process/container, restart/recount, advance fixture clock or age fixture-owned bytes, run maintenance, verify only abandoned bytes reclaimed and other files preserved. Test full disk via small controlled volume or injected statfs/ENOSPC with the limitation explicit; no host disk filling.
- [ ] Backup order: stop/quiesce app+maintenance/upload admission, wait drain, pg_dump dedicated DB and archive exact app volume, store schema/app version/checksums and safe inventory, resume app in finally. Document interruption recovery and encrypted/operator access to dumps/config/keys. Do not claim an uncoordinated live tar+dump is consistent.
- [ ] Restore into new owned DB/file volumes, verify checksums, permissions, expected migration version, synthetic file metadata/bytes correspondence and authentication. Generate new session secret/revoke sessions and consider key/share exposure if backup was compromised; document operator rotation process. Retention still denies restored expired bytes immediately; run cleanup before opening public traffic. External snapshot expiry remains operator responsibility.
- [ ] Exercise upgrade from public phase-B baseline to final schema version (including immutability/checksum ledger) using synthetic data. No migration from reference application's actual runtime is needed or allowed. Test rollback schema compatibility; if downgrade cannot be supported, document restoring matched app+DB+bytes backup instead of running old binary on new schema.
- [ ] Verify public HTTPS proxy in independent disposable infrastructure or local test CA + browser trust environment: login Secure cookie, upload cap/timeouts, spoofed forwarded headers, sanitized access log, phone-reachable configured origin. Do not describe localhost/curl HTTPS alone as real-phone evidence. Record platform/browser/architecture and actual commands without private paths/addresses.

**Commands:** `npm run test:integration -- tests/integration/operations.test.ts`; `node scripts/smoke-compose.mjs --operations`; `node scripts/restore-smoke.mjs`. Add these exact flags and guard project/target ownership; backup's interactive interface is `node scripts/backup.mjs --project agentfiles --output ./backups` and must reject unknown/unowned project or active unquiesced write state. `docker compose down` preserves named volumes; destructive cleanup exists only for confirmed disposable fixture projects.

**Acceptance/commit:** Upgrade/restart/crash/restore demonstrated on independent synthetic data; operational instructions match execution and preserve user volumes; limitations explicit. `docs: verify upgrades backup restore and crash recovery`.

## E3: clean public-clone acceptance, artifacts and v0.1.0

**Files:** Create `docs/releases/v0.1.0.md`, `docs/verification/v0.1.0.md`, `.github/workflows/release.yml` if container publication selected; modify `README.md`, `package.json`, `package-lock.json`, `docs/release-checklist.md`, notices as required. Release/source artifacts live in ignored `artifacts/` during audit.

**Interfaces:** Artifacts originate from exact public commit. Public clone alone supplies build/setup/runtime; no reference/provenance/machine cache required. Registry/location/versioned image tags are confirmed by maintainer before publish; all artifacts immutable/tagged with checksums/provenance where supported. Publishing source/artifacts never deploys production or includes backups/runtime bytes.

- [ ] Before tagging, clone `https://github.com/Evryday-AI/AgentFiles.git` into a newly isolated directory, checkout intended public commit, verify independent object DB/no alternates/public remotes. Do not clone reference history. Scan all new public history with redacting scanner and local identifier review; any leak requires stopping distribution/remediation, not deleting text only from HEAD.
- [ ] Follow documented prerequisites/setup commands exactly with new credentials/volumes and no existing `.env`, dependency cache assumptions, external networks or administrator help. Run all tests/typecheck/build/OpenAPI/agent/browser/Compose checks and E2 operations. CI evidence must match release commit; a differing earlier commit cannot satisfy checklist.
- [ ] Inspect Docker build context and final exported image/layers for env files, credentials, private paths, media, backups, tests/tool/graph caches and unnecessary artifacts; check native/library/OS notices and non-root uid/volume permissions. Inspect source archive member list: `git archive` includes only tracked reviewed files but still needs scan. Generate SBOM and checksums from inspected artifacts; keep raw scans ignored/redacted.
- [ ] Record release evidence with columns `gate`, `public commit`, `command/scenario`, `OS/arch/browser/image version`, `observed result`, `limitation`. Include source count/license review/scanner versions, real PG/filesystem races, clean install, both client hashes, phone viewport vs actual phone, upgrade/restore and unsupported platforms. Never mark unexecuted gate passed.
- [ ] Complete every release checklist item or explicitly remove unsupported capability/platform from advertised scope and rerun dependent checks. Then replace preparation wording with verified quick start; retain deferred managed service, MCP/CLI, tenancy/range/transcoding and other exclusions. Version root/lock metadata consistently, re-run affected checks after any release-document/package edit.
- [ ] Stage/read full final diff, secret/identifier scan history/export/artifacts, public identity commit. Prepare tag/release notes/container workflow as reviewable artifacts. Ask for publication approval only if not already granted in execution session; user approves concrete inspected commit/artifact list. Do not request publication approval now in the planning session.
- [ ] If authorized, publish versioned source/containers from minimal-permission CI with immutable tags/digest/checksums; verify downloaded public archive/image can perform documented fresh install. Container workflow uses packages write only for trusted release event and no production deploy credentials; separate from read-only PR CI. No automatic production rollout.

**Checks:** clean clone `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `npm run validate:openapi`, independent integration/browser/smoke/restore commands; `git diff --cached --check`; `gitleaks git . --redact`; redacted export/image scan and observed remote release CI. Expected every advertised gate proven on exact release commit, no runtime/private material in artifacts.

**Acceptance/commit:** A stranger can install, connect an agent, transfer to a second client/phone, verify expiry/reclamation and operate upgrades/restores using public release alone. `release: document verified AgentFiles v0.1.0 acceptance` precedes authorized publication.

## Final evidence boundary

If engine/OS/phone/private-reporting/artifact publication checks cannot be executed, report them as open with precise next action. Do not replace evidence with source inspection or call a preparation repository installable. Managed service pricing/billing is outside every phase.
