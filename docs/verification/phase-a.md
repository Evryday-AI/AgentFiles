# Phase A: sanitized foundation verification

Date: 2026-10-10. Scope: approved A1–A3 only. AgentFiles remains in preparation; no standalone installation or deployment claim is made.

## Import and licensing

Imported exactly **42 individually selected regular UTF-8 files** from the [reviewed manifest](../source-import.md): 25 application files, 11 tests, and six package/build files. Full candidate content/imports and attribution were inspected. No runtime configuration, media, database/storage, generated artifacts or Git history was imported. Reference revision and all candidate hashes were unchanged after import; raw provenance is ignored.

Path validation rejected candidate links and redirecting/unknown ancestor reparse tags. Verified Windows Cloud Files ancestor markers were accepted only after each candidate's final handle path equaled its contained lexical path. Destination ancestors contained no reparse points. Copying selected files did not use recursive directory copying.

The owner authorized their original code under MIT. No conflicting attribution or third-party application assets were found in these candidates. Dependencies retain their own licenses; [notices](../../THIRD_PARTY_NOTICES.md) and [dependency review](../dependencies.md) record their separate evidence and limitations.

Sanitization changed visible branding, service/package metadata, synthetic fixture labels and reserved example hosts. New keys are `af_<24 hex lookup>_<64 hex secret>` and the administrator cookie is `agentfiles_admin`; no legacy accounts/keys/data were imported. [Migration notes](../migration-notes.md) explain this boundary. Development Vite binds to loopback. Native server startup/security/setup changes remain Phase B/C work.

## Executed checks

Environment: Windows x64, Node **24.21.0**, npm **11.19.0**, Python **3.14**, Bash **5.2.21** through WSL. This is source-verification coverage, not Docker Desktop, Linux installation or browser coverage.

All commands ran in AgentFiles using fresh dependencies and synthetic fixtures. Database-related ambient environment variables were removed for unit checks; no reference runtime was contacted. npm used explicitly empty user/global configuration and the public registry for installation/remediation. Dependency install hooks were inspected; see dependency review for the installed npm version's hook-policy behavior.

| Check | Observed result |
|---|---|
| Initial `npm ci` after public root metadata regeneration | Exit 0; isolated dependency installation |
| Initial `npm test` | 95 passing tests in 11 files |
| Initial `npm run build` | Exit 0; Vite client + TypeScript server + schema copy |
| Added `npm run typecheck` | Exit 0 for server and client; no client typing fixes needed |
| Dependency remediation and fresh `npm ci` | Exit 0; no forced bulk major upgrade |
| Static-plugin focused regressions | 7 passing tests; Fastify 5 compatibility, encoded traversal and case aliases |
| Final `npm test` | **102 passing tests in 12 files**, zero failures |
| Final `npm run typecheck` | Exit 0, both compiler configurations |
| Final `npm run build` | Exit 0; Vite 7.3.7 |
| Full `npm audit --json` | Zero reported vulnerabilities |
| Runtime `npm audit --omit=dev --json` | Zero reported vulnerabilities |
| Python example safety tests | 15 passing synthetic loopback tests; no application DB/runtime |
| Python compilation / Bash syntax | Both exit 0 |

The planning inventory counted 82 source `it()` cases. Import added ten parameterized malformed/other-prefix cases and three cookie cases, yielding 95 discovered tests; seven static regressions yield 102. Existing revocation-race coverage was preserved. Default Vitest discovery is explicitly limited to server/client unit tests; real database integration remains a separate future runner. Both audits describe registry advisories at this date, not proof that all application risks are absent.

Dependency remediation selected Fastify 5.12.5, compatible `@fastify/static` 10.1.6, multipart 9.4.0, Vitest 4.1.11, concurrently 9.2.5 and esbuild 0.28.2. Other updates stayed within existing declared ranges. Lockfile root metadata was regenerated independently; inspect the dependency report for installed licenses and reachability context.

## Agent instructions and security review

The [skill](../../skills/agentfiles/SKILL.md), [agent guide](../agents.md), [source API contract](../api-contract.md), and shell/Python examples use actual baseline routes, flat DTO aliases and the session principal's camelCase permissions. They are **source-derived drafts; application runtime verification is pending D1**. Future instance/readiness endpoints and hardened persistence/capacity errors are explicitly labeled planned.

The 15 tracked Python client checks passed against a synthetic loopback HTTP server, and Python compilation/Bash syntax passed. Shell HTTP execution was not run because the available WSL environment lacks jq; other Python versions are untested. These are separate from application HTTP verification. Dedicated Gitleaks 8.30.1 was downloaded from its official release and its archive SHA-256 matched the published checksum. Staged export and independent public history are scanned with 100% redaction; local private-identifier review uses ignored provenance without printing matched values. The 66-file staged export and existing independent public history both passed Gitleaks with zero findings; private-identifier review found zero matches and staged diff validation passed. Complete source/config/test hunks, lock semantics and the final documentation/examples/notices changes were reviewed before the local commit. Raw scanner/review reports remain ignored.

## Remaining boundaries

No Postgres integration, owned Compose setup, Docker engine/container execution, actual application curl/Python round trip, browser/phone check, restore, deployed behavior, or source publication was performed. Existing source-observed gaps remain in the [findings](../audit/2026-10-10-source-findings.md). This baseline is not a security-complete or installable release.

The updated design requires permanent code-only issuance reservations after metadata purge and atomic retention/deletion arbitration with persisted deletion claims. The database schema, handlers, recovery and deterministic real-concurrency regressions for those requirements are specified in Phase C; they were not implemented under A approval. Phase E covers complete-registry restore and actual process crashes.

Stop at A1–A3. Phase B needs the next instruction. Source publication, production deployment, managed hosting and billing are outside this checkpoint.
