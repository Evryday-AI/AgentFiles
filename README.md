# AgentFiles

Temporary file handoff for AI agents and people.

Upload through an HTTP API, pass a short file code to another authorized agent, or open a link on your phone. Files expire automatically instead of accumulating indefinitely.

## Project status

AgentFiles is in preparation. The complete standalone MIT application, administrator setup, Compose runtime, lifecycle controls, HTTP agent examples and browser interface have local verification evidence. An independent local release-candidate clone passed fresh install, tests, browser/agent handoff and synthetic operations checks on 2026-10-14; its source/image/SBOM inspection is recorded in [candidate evidence](docs/verification/v0.1.0.md). Exact public-commit CI, reachable HTTPS/physical-phone evidence and release acceptance remain pending. An installable release has not been published.

The first release will include a complete self-hosted application, Docker Compose installation, a mobile-friendly browser interface, API documentation, and an agent skill. No paid account or hosted-service dependency will be required to run it.

- [Product scope](docs/superpowers/specs/2026-10-10-agentfiles-open-source-design.md)
- [Implementation plan](docs/superpowers/plans/2026-10-10-agentfiles-open-source.md)
- [Source-verified findings](docs/audit/2026-10-10-source-findings.md)
- [Exact reviewed source import](docs/source-import.md)
- [Phase A verification](docs/verification/phase-a.md)
- [Phase B verification](docs/verification/phase-b.md) and [self-hosting development instructions](docs/self-hosting.md)
- [Lifecycle verification](docs/verification/phase-c.md), [agent/browser verification](docs/verification/phase-d.md) and [CI/security preparation](docs/verification/phase-e.md)
- [Agent skill](skills/agentfiles/SKILL.md) and [HTTP examples](docs/agents.md)
- [Dependency review](docs/dependencies.md) and [third-party notices](THIRD_PARTY_NOTICES.md)
- [Release acceptance checklist](docs/release-checklist.md), [v0.1.0 candidate notes](docs/releases/v0.1.0.md) and [candidate evidence](docs/verification/v0.1.0.md)
- [Contributing and support](CONTRIBUTING.md) and [private security reporting](SECURITY.md)

Phase A imported 42 individually reviewed files and verified the isolated baseline. Phase B exercised setup, versioned migrations, readiness, owned storage and authenticated upload/download through fresh Compose resources. Phases C–D verified authorization/lifecycle arbitration on real PostgreSQL, independent curl/Python checksum roundtrips, and Chromium browser handoff at three viewport sizes. The verification reports distinguish unit tests, real installation checks, viewport evidence and untested deployment behavior.

Source verification uses Node 24: `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Contributor installation exercises use the [setup instructions](docs/setup.md) and `node scripts/smoke-compose.mjs`. The public cookie/key formats differ from the reference application; see [migration notes](docs/migration-notes.md).

## Preparation quick start

For the locally verified development path, install Docker Engine with Compose or Docker Desktop with Linux containers, then follow [administrator setup](docs/setup.md) and [self-hosting](docs/self-hosting.md). The Docker setup tool needs no host Node; the host fallback needs Node 24/npm. No paid account, telemetry service or specific agent framework is required. Run one app process with its dedicated PostgreSQL database and exclusively owned file volume.

```sh
docker compose -f compose.setup.yaml run --rm --build setup
docker compose config --quiet
docker compose build
docker compose up -d
```

On Linux, export the invoking user's `SETUP_UID`/`SETUP_GID` as the setup guide requires. Setup creates new private credentials and refuses replacement. For default local mode, open `http://localhost:3000`, sign in and create a named scoped API key for [agent examples](docs/agents.md). `docker compose down` preserves named volumes. Normal operation/update must not use `down --volumes`. Public HTTPS requires a separately operated trusted TLS proxy and configured reachable origin; another device cannot use this machine's localhost.

## Retention and tested environments

Temporary files expire after seven days by default. Persistent files require explicit administrator policy (`ALLOW_PERSISTENT_FILES=false` by default), permission and an intentional keep operation; temporary files never become permanent automatically. Deleted details/events default to 30-day retention. Issued codes remain reserved permanently and are never reused. Logs, external backups and recipients' copies have independent operator/recipient retention; snapshots may retain expired content. Read [retention/recovery](docs/retention.md) before changing policy or restoring data. Synthetic upgrade/backup/restore checks are recorded in [Phase E](docs/verification/phase-e.md); final release acceptance remains pending.

| Environment | Observed evidence | Limits |
| --- | --- | --- |
| Windows x64, Node 24.21.0/npm 11.19.0 | Typechecks, unit/setup/DOM/tools, build and Python checks | Two POSIX-only unit checks skip on Windows. |
| Docker Desktop Linux amd64, Node 24.21.0/PostgreSQL 17.11 pinned images | Isolated Compose install, real SQL/disk lifecycle tests and Bash/curl/Python handoff | Native Linux/macOS hosts and other architectures have no clean-install evidence yet. |
| Windows Chromium 156, Playwright 1.64.0 | Desktop 1280×900, phone viewport 390×844 and minimum width 320×740; actual checksum downloads | No physical-phone, reachable public HTTPS, Safari/WebKit/Firefox or native Linux browser claim. |
| GitHub Ubuntu CI | Read-only workflow prepared | Exact public-commit remote execution awaits separately authorized source push. |

See the phase reports and [frozen candidate evidence](docs/verification/v0.1.0.md) for exact revisions/results. The audited runtime image remains a private validation artifact; binary redistribution requires reviewed corresponding-source arrangements for its applicable dependencies. Managed hosting/billing, multi-customer tenancy, replicas, dedicated CLI/MCP packaging and range/resumable transfers are deferred.

## Intended workflow

1. An authenticated agent uploads a file.
2. The service returns its short code, instance URL, private download URL, and expiration.
3. Another authorized agent retrieves the file, or a person downloads it in a browser.
4. Access ends at expiration; background cleanup removes the stored bytes.

A file code is an identifier, not a password. Public sharing uses a separate expiring bearer link. Deletion applies to the service's copies, not copies recipients have downloaded.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Distribution must retain the notices required by its actual platform/artifact dependencies.
