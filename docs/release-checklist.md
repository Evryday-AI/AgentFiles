# AgentFiles v0.1 release acceptance

## Repository and privacy

- [ ] New repository has independent Git history and no object alternates or private remotes.
- [ ] Imported files are recorded in a reviewed source manifest.
- [ ] No secrets, personal media, private deployment details, source-machine paths, or private commit emails appear in tracked files/history.
- [ ] Secret scan and dependency/license review have evidence; findings are resolved or documented without revealing secrets.
- [ ] MIT license and third-party notices are correct.

## Installation

- [ ] Clean installation works with documented prerequisites and no maintainer infrastructure.
- [ ] Setup generates unique secrets and refuses unsafe replacement of existing configuration.
- [ ] Compose validates, database health gates migrations, and migrations gate app startup.
- [ ] Data survives container recreation; no volumes are destroyed by normal update instructions.
- [ ] Local-only HTTP and public HTTPS setups have separate verified instructions.
- [ ] A documented upgrade and isolated restore have been exercised.

## File lifecycle and security

- [ ] Authenticated upload, lookup, download, share, revoke, and delete work with synthetic fixtures.
- [ ] Short code alone cannot bypass authentication; insufficient key permissions are rejected.
- [ ] Expired files cannot be accessed before or after cleanup.
- [ ] Cleanup removes bytes, safely retries failures, and preserves active uploads.
- [ ] Interrupted/crashed uploads are reclaimed within a documented grace period.
- [ ] Upload size, capacity, and concurrent-upload limits are enforced.
- [ ] Logs redact credentials, cookies, and public share tokens.
- [ ] Metadata/log/backup retention is explicitly described.

## Agent and browser experience

- [ ] OpenAPI matches actual routes and responses.
- [ ] Markdown skill contains no live secrets and works with a configurable instance URL.
- [ ] curl and Python examples complete a real round trip with checksum verification.
- [ ] Error handling covers expiry, authorization, oversized uploads, rate limits, and ambiguous upload outcomes.
- [ ] Phone-sized viewport can find, preview, and download an agent-uploaded file.
- [ ] UI preserves portrait/landscape media proportions and supports keyboard navigation.

## Release operations

- [ ] Build, tests, security checks, and container smoke test pass on the release commit.
- [ ] README, contribution guide, security policy, support scope, and upgrade guide are complete.
- [ ] Versioned container/image artifacts contain no development secrets or private assets.
- [ ] Public release notes distinguish verified capabilities from deferred work.
