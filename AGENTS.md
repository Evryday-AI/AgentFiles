# AgentFiles contributor instructions

## Scope and isolation

- This repository is the standalone MIT self-hosted edition. Hosted billing, subscription enforcement, and shared multi-customer hosting are out of scope for this release.
- Work only in this repository. An independently maintained private application may be supplied as a read-only reference by the owner. Never edit it, use its runtime credentials, connect to its database, deploy it, or import its Git history.
- Import only individually reviewed source and tests. Do not recursively copy a source repository. Do not copy local environment files, media, screenshots, logs, database dumps, infrastructure notes, agent memory, private planning documents, or Git metadata.
- Never include private source paths, usernames, infrastructure addresses, or credential values in tracked documents or audit reports. Keep any necessary local provenance in ignored `.private/` files.
- New public commits must use a maintainer-approved public identity or GitHub noreply email.

## Discovery

Prefer codebase-memory-mcp graph tools for code discovery: search_graph, trace_path, get_code_snippet, query_graph, and search_code. Index this repository if it has no index. Use ordinary search for configuration, prose, literal values, or insufficient graph results. Do not commit generated graph databases.

## Implementation

- Read the scope, implementation plan, and release checklist before starting.
- Keep the HTTP API usable without a specific agent framework, MCP server, paid account, or telemetry service.
- Keep short codes behind authentication. Public links use separate high-entropy tokens.
- Treat uploaded filenames, metadata, and file contents as untrusted input.
- Never silently promote temporary files to permanent storage.
- Add meaningful tests for authorization, expiry, cleanup, upload limits, and setup behavior. Validate configuration and documentation with real clean-install smoke tests.
- Report verification honestly; distinguish source inspection, passing tests, and deployed behavior.
- Before committing imported content, inspect the entire staged diff and run secret and private-identifier checks with redacted output.

## Release boundary

The initial repository is documentation only. Do not describe it as installable until the release acceptance checks pass. Publishing a reviewed source commit does not authorize publishing runtime data or a production deployment.
