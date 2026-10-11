# Phase E preparation evidence

AgentFiles remains in preparation. E1 adds CI, contributor/security policy and source-export guards. E2 operations and E3 exact-public-commit release acceptance remain separate work. No push, tag, release, container publication or production deployment is established by this report. Raw fixtures, synthetic credentials, logs and local identifier rules remain ignored.

## E1 scope and provenance

The read-only PR/push workflow has independent `security` and `verify` jobs. There is no trusted-event execution of contributor code, shared contributor cache, deploy secret or artifact publication. Checkout does not persist credentials. Both action revisions were verified against GitHub's upstream tag/commit API and primary release source on 2026-10-11:

| Component | Immutable pin | Primary evidence |
| --- | --- | --- |
| Checkout v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [Release](https://github.com/actions/checkout/releases/tag/v7.0.1); pinned action uses Node 24. |
| Setup Node v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | [Release](https://github.com/actions/setup-node/releases/tag/v7.1.0); [runtime/input documentation](https://github.com/actions/setup-node/blob/v7.1.0/README.md) confirms Node 24 runner requirement and cache-disable option. |
| Gitleaks v8.30.1 Linux x64 archive | SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` | [Official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), exact asset digest confirmed via release API. |

Hosted Ubuntu 24.04 runners supply the modern Actions runner; custom/self-hosted runners are not part of this CI claim. Node is fixed to 24.21.0, Playwright to the lockfile's 1.64.0, and disposable PostgreSQL uses the already reviewed 17.11 image digest from Compose. Gitleaks runs its built-in default rules over all fetched history with full redaction and no repository/inline suppression. Scanner errors fail the job. Private literal identifier rules are owner-local input to the export guard; CI has no private pattern values or secrets.

GitHub reporting was initially disabled. Authorized E1 maintenance enabled it through `PUT /repos/Evryday-AI/AgentFiles/private-vulnerability-reporting`; an independent subsequent GET returned `enabled: true` on 2026-10-11. The confirmed private channel is [GitHub's advisory report form](https://github.com/Evryday-AI/AgentFiles/security/advisories/new), as described by [GitHub reporting documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately). No alternative email was invented and no report/message was submitted.

## Executed local checks

The E1 working tree is based on local preparation commit `57023d4`. Host execution used Windows x64, Node 24.21.0/npm 11.19.0, Python 3.14, Docker Desktop Linux amd64/Docker Engine 29.5.3, pinned PostgreSQL 17.11, Playwright 1.64.0 and the previously installed Chromium 156/revision 1248. These checks exercise local source, not a public clone or remote Actions run.

| Command/check | Observed result and limit |
| --- | --- |
| `npm test -- tests/tools/publicExport.test.ts` | 28 passed. Initial missing scanner caused 20 expected failures; two fail-closed negative exit checks already returned nonzero. Added cache/private/media/password-hash tests caused five expected failures before those rules were implemented. A self-review filename credential regression failed before its fix. |
| `npm test` | 435 passed, two existing Windows POSIX skips, 32 files. Includes the new default tools include and existing setup/DOM coverage. |
| `npm run typecheck`; `npm run build` | Server/client typechecks and client/server production build passed. |
| `npm run validate:openapi` | OpenAPI 3.1 valid, 21 unique operation IDs, external reference resolution disabled. |
| `python -m unittest discover -s tests/examples -p test_roundtrip.py` | 19 native Windows tests passed. Linux Bash/client negatives are separately exercised by Compose/agent smoke. |
| Bash syntax for all nine workflow `run` blocks and `examples/upload.sh` | Passed in a uniquely owned network-disabled Linux container using the existing reviewed Node image pin. |
| Actionlint 1.7.12 for `.github/workflows/ci.yml`; YAML parse for workflow/Dependabot/issue template | Passed. Official Windows archive SHA-256 verified before execution. Shellcheck/Pyflakes were disabled in Actionlint; actual Bash syntax was checked separately. |
| `npm audit --json --audit-level=critical`; `npm audit --omit=dev --json --audit-level=high` | Both returned zero; all/runtime reports contain zero advisories. Unavailable/error reports remain failing CI outcomes. |
| `node scripts/generate-notices.mjs --check` | Reviewed Windows snapshot passed: 282 installed locations, 303 notice sections. CI separately generates/checks the actual Linux installed inventory privately and restores the tracked snapshot; Linux distribution attribution still requires E3 review. |
| Exact workflow PostgreSQL launcher executing `npm run test:integration` equivalent | 124 passed, one existing Windows skip, ten files against a new owned PostgreSQL server, fresh per-test sibling databases and synthetic storage. |
| Exact workflow launcher executing `npm run test:browser` equivalent | 18 passed without retries: six each at desktop, phone viewport and minimum width. Real HTTP/PostgreSQL/checksum downloads; no physical phone or public HTTPS evidence. |
| Exact workflow launcher executing `node scripts/smoke-compose.mjs --agents` | Fresh Linux amd64 multi-stage build and all 14 scenarios passed, including Linux Python/Bash safety tests and independent scoped-key clients. Only owned resources were removed. |
| Redacted tracked/export/history and owner-local identifier scans; full staged diff | 160 tracked files and 13 staged files passed the export guard and local literal rules. Staged generic Gitleaks scan and preparation-history scan passed with redaction. Full staged diff and whitespace checks were reviewed. This is not an image-layer or public-release archive audit. |

The real-check launcher was extracted verbatim from CI into ignored scratch and executed locally. It generates fresh independent credentials, writes protected PostgreSQL/test env files, starts only a uniquely named loopback server, admits no ambient application/database/cloud settings to fixture children, scrubs password/key/share/DB output and verifies its exact ownership label before removal. Browser traces/screenshots are disabled; its existing launcher keeps private fixture state and sanitized diagnostics ignored. Compose smoke creates and cleans only its own projects/volumes. Neither launcher connects to an existing installation.

The source-export guard checks an explicit export root or tracked file listing, refuses redirected roots/ancestors, unsupported/binary files, environment/runtime/build/cache/media artifacts, credential/private-path patterns and optional local literal rules. Tests generate all fixture values at runtime, keep fixtures under ignored scratch, assert physical containment before cleanup, and verify that outside-junction bytes survive unchanged. Output contains only category/count/redacted relative path, never matching content. This text-source guard does not claim to inspect a published image or binary release artifact.

## Remaining acceptance boundary

Remote CI on the exact authorized public source commit has not run. Workflow lint/local launchers do not satisfy that gate. Dependabot and both read-only jobs are prepared for normal PR/push execution; maintainers must review material advisories/updates and require both jobs. Runtime high/critical and development/build critical findings block acceptance. Lower-risk exceptions need owner, reason, date, expiry and reproduction evidence; none is currently configured.

E2 upgrade/crash/backup/restore/public-proxy work, E3 public-clone/archive/image/layer/notice review and the complete release checklist remain outstanding here. Physical-phone/reachable public HTTPS, native Linux/macOS clean installation, other architectures and other browsers are not claimed. Preparation quick-start/support/security documents describe only observed capabilities and the remaining limits. Immutable SQL migrations and public noreply identity are preserved.
