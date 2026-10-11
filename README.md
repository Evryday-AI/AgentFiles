# AgentFiles

Temporary file handoff for AI agents and people.

Upload through an HTTP API, pass a short file code to another authorized agent, or open a link on your phone. Files expire automatically instead of accumulating indefinitely.

## Project status

AgentFiles is in preparation. The reviewed MIT source baseline and initial agent skill are now present; an installable application has not been released yet. Setup, standalone Compose, lifecycle hardening, and release acceptance remain planned work.

The first release will include a complete self-hosted application, Docker Compose installation, a mobile-friendly browser interface, API documentation, and an agent skill. No paid account or hosted-service dependency will be required to run it.

- [Product scope](docs/superpowers/specs/2026-10-10-agentfiles-open-source-design.md)
- [Implementation plan](docs/superpowers/plans/2026-10-10-agentfiles-open-source.md)
- [Source-verified findings](docs/audit/2026-10-10-source-findings.md)
- [Exact reviewed source import](docs/source-import.md)
- [Phase A verification](docs/verification/phase-a.md)
- [Agent skill](skills/agentfiles/SKILL.md) and [HTTP examples](docs/agents.md)
- [Dependency review](docs/dependencies.md) and [third-party notices](THIRD_PARTY_NOTICES.md)
- [Release acceptance checklist](docs/release-checklist.md)

Phase A imported 42 individually reviewed files and verified the isolated baseline. Unit tests, server/client typechecks, and the production build pass; these checks do not establish clean installation or deployed behavior. The agent skill is drafted from source, with application HTTP round-trip verification pending Phase D. See the verification report for exact results and limitations.

Source verification uses Node 24: `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. These are contributor checks; standalone setup instructions arrive in Phase B. The public cookie/key formats differ from the reference application; see [migration notes](docs/migration-notes.md).

## Intended workflow

1. An authenticated agent uploads a file.
2. The service returns its short code, instance URL, private download URL, and expiration.
3. Another authorized agent retrieves the file, or a person downloads it in a browser.
4. Access ends at expiration; background cleanup removes the stored bytes.

A file code is an identifier, not a password. Public sharing uses a separate expiring bearer link. Deletion applies to the service's copies, not copies recipients have downloaded.

## License

MIT. See [LICENSE](LICENSE). Third-party components retain their respective licenses.
