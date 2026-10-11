# AgentFiles

Temporary file handoff for AI agents and people.

Upload through an HTTP API, pass a short file code to another authorized agent, or open a link on your phone. Files expire automatically instead of accumulating indefinitely.

## Project status

AgentFiles is in preparation. The reviewed MIT source, administrator setup, standalone Compose runtime and initial agent skill are present. A fresh local installation has been exercised on Windows with Docker Desktop Linux containers; lifecycle hardening, browser/client verification and release acceptance remain pending. An installable release has not been published.

The first release will include a complete self-hosted application, Docker Compose installation, a mobile-friendly browser interface, API documentation, and an agent skill. No paid account or hosted-service dependency will be required to run it.

- [Product scope](docs/superpowers/specs/2026-10-10-agentfiles-open-source-design.md)
- [Implementation plan](docs/superpowers/plans/2026-10-10-agentfiles-open-source.md)
- [Source-verified findings](docs/audit/2026-10-10-source-findings.md)
- [Exact reviewed source import](docs/source-import.md)
- [Phase A verification](docs/verification/phase-a.md)
- [Phase B verification](docs/verification/phase-b.md) and [self-hosting development instructions](docs/self-hosting.md)
- [Agent skill](skills/agentfiles/SKILL.md) and [HTTP examples](docs/agents.md)
- [Dependency review](docs/dependencies.md) and [third-party notices](THIRD_PARTY_NOTICES.md)
- [Release acceptance checklist](docs/release-checklist.md)

Phase A imported 42 individually reviewed files and verified the isolated baseline. Phase B exercised setup, versioned migrations, readiness, owned storage and authenticated upload/download through fresh Compose resources. The agent skill is drafted from source, with generic client and browser verification pending Phase D. The verification reports distinguish unit tests, actual installation checks and untested deployment behavior.

Source verification uses Node 24: `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Contributor installation exercises use the [setup instructions](docs/setup.md) and `node scripts/smoke-compose.mjs`. The public cookie/key formats differ from the reference application; see [migration notes](docs/migration-notes.md).

## Intended workflow

1. An authenticated agent uploads a file.
2. The service returns its short code, instance URL, private download URL, and expiration.
3. Another authorized agent retrieves the file, or a person downloads it in a browser.
4. Access ends at expiration; background cleanup removes the stored bytes.

A file code is an identifier, not a password. Public sharing uses a separate expiring bearer link. Deletion applies to the service's copies, not copies recipients have downloaded.

## License

MIT. See [LICENSE](LICENSE). Third-party components retain their respective licenses.
