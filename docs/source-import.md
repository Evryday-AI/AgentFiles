# Sanitized source import manifest

Date: 2026-10-10. Status: **42 individually reviewed text files imported locally for Phase A**. Dependency verification, notices and final staged privacy scans are separate checkpoint evidence; this import is not a release or an installation guarantee.

The source is an owner-supplied, read-only reference. Its location, revision, working-tree state, file hashes, and raw scans are recorded only in ignored `.private/audit/`. The import matched all 42 inventory hashes and the recorded revision. The reference was never executed or modified. Any later import must compare its inventory with the reference again; this manifest does not authorize additional files or runtime data.

## Exact allowlist

These are the 42 imported regular UTF-8 text files: 25 application files, 11 test files, and six build/package files. None of the candidate files or destination ancestors is a reparse point. Two source ancestors had verified Microsoft Cloud Files tags, no redirect target, and every opened candidate's final resolved path matched its expected path under the source root. Redirecting or unknown reparse tags remain prohibited. Entries were copied individually; directory wildcards and recursive copying are prohibited. Destination paths are identical to the paths below.

| Path | Treatment before public commit |
|---|---|
| `src/server/adminRoutes.ts` | Retain routes; review one-time secret responses and test fixtures; hardening follows in C1. |
| `src/server/auth.ts` | Replace legacy cookie and generated-key branding; change parser and tests together. |
| `src/server/cleanup.ts` | Retain baseline; bounded sweep and reconciliation follow in C3. |
| `src/server/config.ts` | Retain baseline parsing; B1 introduces independently usable local/public modes. |
| `src/server/db.ts` | Retain lazy pool; B3 removes disagreement between explicit config and environment. |
| `src/server/events.ts` | Retain event types; do not claim event recording exists. |
| `src/server/fileCodes.ts` | Retain instance-local `F-` code format; it is not an authentication secret. |
| `src/server/filesRepo.ts` | Retain repository and row mapping; lifecycle invariants follow in C1/C3. |
| `src/server/filesRoutes.ts` | Retain HTTP routes and response aliases; multipart staging fixes follow in C2. |
| `src/server/index.ts` | Replace service/title branding; retain app shell and routing. |
| `src/server/migrate.ts` | Retain baseline schema/backfill behavior; B3 adds a migration ledger. |
| `src/server/schema.sql` | Retain schema baseline, never database contents. |
| `src/server/shareRoutes.ts` | Retain hashed, high-entropy share tokens and atomic claim. |
| `src/server/storage.ts` | Retain streaming/hash logic; C2 replaces premature finalization. |
| `src/client/App.tsx` | Replace title branding; preserve selection/race guards and mobile detail placement. |
| `src/client/api.ts` | Retain relative requests and DTO aliases. |
| `src/client/components/FileDetail.tsx` | Retain details, explicit sharing, and preview dialog. |
| `src/client/components/GalleryView.tsx` | Retain gallery and inline detail behavior. |
| `src/client/components/ListView.tsx` | Retain list and inline detail behavior. |
| `src/client/components/Login.tsx` | Replace visible title branding. |
| `src/client/components/MediaPreview.tsx` | Retain original-proportion media rendering. This file is absent from the graph's file inventory. |
| `src/client/components/Settings.tsx` | Retain key creation/revocation and one-time secret display. |
| `src/client/components/UploadPanel.tsx` | Retain queue/progress; improve result and persistence permission handling in D2. |
| `src/client/main.tsx` | Retain entry point. |
| `src/client/styles.css` | Retain authored CSS and system-font stack; no font assets are imported. |
| `tests/client/api.test.ts` | Retain bodyless-logout regression. |
| `tests/server/adminRoutes.test.ts` | Neutralize legacy names and database/temp-directory fixture labels. |
| `tests/server/auth.test.ts` | Update generated-key prefix and cookie assertions together with auth source. |
| `tests/server/cleanup.test.ts` | Retain fake-clock and failure-order coverage. |
| `tests/server/config.test.ts` | Replace branded reserved example hostname with `files.example.com`; B1 changes local-mode expectations. |
| `tests/server/fileCodes.test.ts` | Retain identifier tests. |
| `tests/server/filesRepo.test.ts` | Retain SQL parameter/collision/pagination tests; no production DB use. |
| `tests/server/filesRoutes.test.ts` | Neutralize synthetic fixtures; preserve baseline behavior expectations until C1/C2 intentionally change them. |
| `tests/server/migrate.test.ts` | Retain backfill SQL test; real migration coverage follows in B3. |
| `tests/server/shareRoutes.test.ts` | Neutralize synthetic fixtures; retain claim/revocation/header coverage. |
| `tests/server/storage.test.ts` | Rename synthetic temp prefixes; use temporary directories created by each test. |
| `index.html` | Replace title branding. |
| `package.json` | Set name `agentfiles`, license `MIT`, public repository metadata; keep `private: true`. Bind dev server to loopback. |
| `package-lock.json` | Audit reference snapshot locally; regenerate public root metadata and dependency fixes in AgentFiles. Never copy a private registry credential. |
| `tsconfig.json` | Retain strict server compiler config; client typecheck added in A2. |
| `vite.config.ts` | Retain assets/proxy contract, with loopback development bind. |
| `vitest.config.ts` | Retain baseline runner; separate unit/integration/DOM test projects as needed. |

The complete application, test and configuration text was read before importing, including the preview component absent from the reference graph inventory. The lockfile was parsed in full and all 350 entries reviewed for metadata fields, registry resolution, license declarations and install-script flags; installed package license texts and native/build-data notices are an A2 obligation. All relative imports point to reviewed allowlisted source or public package dependencies. Exact per-file approval and provenance stay ignored. Review the complete transformed staged diff again before committing.

## Exclusions and freshly authored replacements

Everything outside the table is excluded. In particular: source README/design/plans, agent memory/instructions, `.env` and `.env.example`, `.gitignore`, `.dockerignore`, Dockerfile, deployment Compose file, private tooling/caches, screenshots/media, runtime bytes, logs, dumps, databases, generated build artifacts, dependency directories, Git metadata/history, graph databases, and symlinks/reparse points. No source environment file needs to be opened to perform the import.

Author `.env.example`, `Dockerfile`, `.dockerignore`, `compose.yaml`, setup scripts, agent skill, OpenAPI, notices, and public documentation freshly. The reference deployment contains infrastructure-specific configuration; describing that category is sufficient. Never reproduce its addresses or paths in public diffs.

## Sanitization rules

- Visible product/package/service branding becomes AgentFiles/`agentfiles`.
- New cookie name: `agentfiles_admin`. New API keys: `af_<24 hex lookup characters>_<64 hex secret characters>`. Parser accepts exactly that new format. The standalone edition imports no old accounts, keys, sessions, or files; do not add compatibility reads against the reference runtime.
- Preserve API route paths, `F-` codes, and DTO aliases (`size`/`size_bytes`, `expiry`/`expires_at`, `durable`/`is_durable`) during sanitization. Cookie/key-prefix differences belong in the public migration note.
- Replace legacy synthetic database labels with `agentfiles_test`, temp prefixes with `agentfiles-`, multipart boundary labels with `agentfiles-test-boundary`, and reserved branded hostnames with `files.example.com`. Synthetic passwords/hashes stay clearly test-only; scanner exceptions must target the specific fixture rather than whole tests directories.
- Do not insert machine-specific filesystem paths. Use `mkdtemp`, `tmpdir`, configured storage roots, and reserved example domains.
- The maintainer stated that the original application code is theirs and authorized licensing it under MIT. Source publication is separate from this local import checkpoint. Complete source review found no conflicting copyright headers, external contribution attribution, copied asset notices or vendored third-party source. The UI uses authored CSS, system-font names and basic inline SVG shapes; no font, media or icon-library files were imported. Public dependencies retain their own licenses and require the exact-version notices review in A2. New concrete third-party ownership evidence would require specific review.

## Verification and evidence

A1/A2 must record: exact imported count, reviewed sanitized diff, public identity, full-history secret scan, identifier review, package/license results, unit-test count/results, server/client typecheck and build. The import count is 42; it is not a passing-test count. See the [Phase A verification record](verification/phase-a.md) for executed checks and remaining evidence. Inspect every future candidate even if automated checks find nothing.

Use explicit `git add` paths. Run `git diff --cached --check`, read the full staged diff, and run a redacting secret scanner on the staged export and independent public history. Private identifier matching must load its patterns from ignored local provenance and report only category/count/path; never print matched values. A failed scan prevents the source commit until resolved. Repeat scanning on release artifacts.

The first checkpoint is the reviewed import plus isolated baseline verification and initial agent instructions (A1–A3). It is **not** a release, installation guarantee, runtime migration, or deployment authorization.
