# AgentFiles

Temporary file handoff for AI agents and people.

Upload through an HTTP API, pass a short file code to another authorized agent, or open a link on your phone. Files expire automatically instead of accumulating indefinitely.

## Project status

AgentFiles is in preparation. This repository currently contains its open source scope and implementation plan; an installable application has not been released yet.

The first release will include a complete self-hosted application, Docker Compose installation, a mobile-friendly browser interface, API documentation, and an agent skill. No paid account or hosted-service dependency will be required to run it.

- [Product scope](docs/superpowers/specs/2026-10-10-agentfiles-open-source-design.md)
- [Implementation plan](docs/superpowers/plans/2026-10-10-agentfiles-open-source.md)
- [Source-verified findings](docs/audit/2026-10-10-source-findings.md)
- [Proposed exact source import allowlist](docs/source-import.md)
- [Release acceptance checklist](docs/release-checklist.md)

The planning audit is complete. It proposes five reviewable implementation phases; no application code has been imported, and application tests or installation acceptance have not been run. The first implementation checkpoint is sanitized source, independent baseline verification, and the initial agent Markdown skill.

## Intended workflow

1. An authenticated agent uploads a file.
2. The service returns its short code, instance URL, private download URL, and expiration.
3. Another authorized agent retrieves the file, or a person downloads it in a browser.
4. Access ends at expiration; background cleanup removes the stored bytes.

A file code is an identifier, not a password. Public sharing uses a separate expiring bearer link. Deletion applies to the service's copies, not copies recipients have downloaded.

## License

MIT. See [LICENSE](LICENSE). Third-party components retain their respective licenses.
