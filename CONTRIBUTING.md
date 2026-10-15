# Contributing to AgentFiles

AgentFiles is preparing a standalone MIT self-hosted release. Local phase checks are recorded in [verification](docs/verification/phase-e.md); release acceptance, remote CI and publication are separate gates. Use public issues for redacted synthetic reproductions and [private reporting](SECURITY.md) for vulnerabilities.

## Scope and support

The current application provides one administrator, scoped API keys, authenticated file handoff, explicit expiring/revocable public links, automatic expiry/cleanup, optional authorized persistence, a React interface, OpenAPI, curl/Python examples and a Markdown agent skill. It uses one app process, a dedicated PostgreSQL database and an exclusively owned file volume. No paid account, agent framework, MCP server or telemetry service is required by the HTTP API.

Managed hosting, billing/subscriptions, tenancy, replicas, anonymous uploads, dedicated CLI/MCP packaging, range/resumable transfers, transcoding and native phone apps are deferred. Keep changes focused on the standalone scope. Support is best effort through reviewed issues/PRs, with no service-level or response-time promise. Only the environments with execution evidence in [README](README.md) are currently tested; new support claims require actual clean-install and browser evidence.

## Setup and checks

Use Node 24 and npm, Docker with the Compose plugin/Linux containers, Python 3, and Bash/curl/jq for shell examples. Docker tool setup can run without host Node; [setup](docs/setup.md) and [self-hosting](docs/self-hosting.md) describe both paths. Keep generated `.env` private. Native development uses a separately authored `.env.development.local`; the Compose database URL/storage root are container settings, not host defaults. Read [configuration](docs/configuration.md) before changing them.

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
npm run validate:openapi
npm run check:public
python3 -m unittest discover -s tests/examples -p 'test_roundtrip.py'
python3 -m py_compile examples/roundtrip.py
bash -n examples/upload.sh
```

With Linux Bash/curl/jq installed, explicitly enable the shell safety suite:

```sh
AGENTFILES_SHELL_TESTS=1 python3 -m unittest discover -s tests/examples -p 'test_*.py'
```

Integration/browser checks require an independently provisioned disposable PostgreSQL server and an explicit `AGENTFILES_TEST_DATABASE_URL`. It must contain a username/password, explicit port, and a database named `agentfiles_test_` followed by 12–64 hexadecimal characters. The fixture role must be able to create/drop its own sibling test databases. `DATABASE_URL` is forbidden. Never use a live installation's DB or credentials. Supply the test URL through a private environment file/provider rather than command arguments, shell history or logs. The [CI workflow](.github/workflows/ci.yml) contains an actual launcher that generates its own credentials, writes mode-0600 env files, publishes only loopback, checks ownership and removes only its unique fixture.

```sh
npm run test:integration
node node_modules/playwright/cli.js install chromium
npm run test:browser
node scripts/smoke-compose.mjs --agents
```

Browser fixtures also require host FFmpeg on `PATH` with PNG, libvpx/WebM and WAV encoding support to generate synthetic media. On Ubuntu, install it with `sudo apt-get update` and `sudo apt-get install --yes --no-install-recommends ffmpeg`. Playwright's downloaded FFmpeg is separate and does not supply this host command.

The Compose smoke command creates its own settings/services/volumes. It exercises real installation and curl/Python clients, and removes only disposable resources that it owns. Do not replace that with a smoke test against existing runtime data. Linux CI installs Playwright OS dependencies using `install --with-deps chromium`. Chromium viewports are not physical-phone evidence.

## Layout and fixtures

- `src/server`: Fastify API, authentication, storage, cleanup and immutable SQL migrations.
- `src/client`: React interface and HTTP client.
- `tests/server`, `tests/client`, `tests/setup`, `tests/tools`: default unit, DOM, setup and export-guard tests.
- `tests/integration`, `tests/browser`, `tests/examples`: real PostgreSQL/browser fixtures and independent client safety tests.
- `scripts`, `examples`, `skills/agentfiles`: setup/verification tools and framework-independent integration examples.
- `docs`, `openapi.yaml`, `compose*.yaml`, `Dockerfile*`: contract, evidence and runtime packaging.

Author new synthetic credentials, files and media for tests. Generated fixtures, browser output, raw reports, runtime data and provenance belong in ignored `.private/`, never source artifacts. Before recursive fixture cleanup, verify resolved containment and resource ownership. Never copy a private source tree or its Git history/config/runtime data. Preserve applied migrations byte-for-byte; add a new migration with meaningful real-database tests when schema changes are required.

## Review and maintenance gates

PR/push CI uses read-only repository permissions, pinned actions, no contributor shared cache and disposable settings. Its security job scans tracked source and all fetched Git history; any scan failure is a failed check. The verification job runs both typechecks, default tests, Python/shell checks, build/OpenAPI, dependency gates, installed-platform license generation/check, real PostgreSQL, Chromium and Compose/agent smoke. Maintainers must require both checks before merging. Remote CI remains unobserved until this source is separately authorized for push.

Run `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=critical`: runtime high/critical and build/development critical findings block acceptance. Review lower-severity findings manually. Any lower-risk exception must record owner, advisory/package/version, reason, decision date, expiry and reproduction/compatibility evidence; renew only after a fresh review. There are currently no exceptions or scanner allowlists. Never suppress an unavailable/failed audit. Dependabot proposes weekly npm and Actions updates; review release notes, pinned revisions, compatibility/regressions and license changes before merging. A clean audit does not establish redistribution rights.

After clean installation, `node scripts/generate-notices.mjs --check` verifies the existing platform snapshot. Linux optional packages differ from the reviewed Windows snapshot: generate a private platform report and review notices for the actual distribution, as [dependency review](docs/dependencies.md) explains. CI checks its generated Linux inventory without replacing the tracked notice snapshot.

Before committing, inspect the full staged diff, run `git diff --cached --check`, generic redacted secret scanning and public-export checking. For a source archive use `node scripts/check-public-export.mjs --root <explicit-export-root>`; use `--tracked` only for a repository root. Owner-supplied literal identifier rules can be loaded with `--private-patterns <ignored-json-file>` (array of `{ "category": "...", "value": "..." }`). Keep those rules local and ignored; never add private identifiers or pattern values to CI configuration. Reports contain only categories/counts/redacted relative paths. The export guard is intentionally text-source-only; images, database/runtime/build archives and reparse points require separate release-artifact inspection and are rejected by this source gate.

Use the maintainer-approved public identity or GitHub noreply address. Describe what changed, why, actual executed checks and remaining limits. Local passing checks do not authorize source push, tag/release, container publication or deployment.
