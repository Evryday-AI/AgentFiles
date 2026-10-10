# AgentFiles v0.1 release acceptance

Planning status (2026-10-10): source/config/test inspection and independent dependency-metadata audit completed; application source import, tests, build, clean install and deployment have **not** occurred. All release gates below remain unchecked. See [findings](audit/2026-10-10-source-findings.md) and [phased plan](superpowers/plans/2026-10-10-agentfiles-open-source.md).

For each checked gate, record exact public commit, executed command/scenario, environment/image versions, observed result and limitation in `docs/verification/v0.1.0.md`. Raw logs/provenance remain ignored. Inspection, mocked tests, real integration, clean installation and deployed behavior are separate evidence categories.

## Repository and privacy

- [ ] New repository has independent Git history and no object alternates or private remotes.
- [ ] Imported files are recorded in a reviewed source manifest.
- [ ] No secrets, personal media, private deployment details, source-machine paths, or private commit emails appear in tracked files/history.
- [ ] Secret scan and dependency/license review have evidence; findings are resolved or documented without revealing secrets.
- [ ] MIT license and third-party notices are correct.
- [ ] Source ownership/redistribution basis and bundled/native/build-data attribution are recorded.
- [ ] Both server and React client typechecks pass; dependency remediation is compatible and regression-tested.

## Installation

- [ ] Clean installation works with documented prerequisites and no maintainer infrastructure.
- [ ] Setup generates unique secrets and refuses unsafe replacement of existing configuration.
- [ ] Tool-container setup works before `.env` exists; prompt/output/Compose interpolation and host file ownership are verified.
- [ ] Compose validates, database health gates migrations, and migrations gate app startup.
- [ ] Data survives container recreation; no volumes are destroyed by normal update instructions.
- [ ] Local-only HTTP and public HTTPS setups have separate verified instructions.
- [ ] Deployment mode governs origin/cookie/proxy trust independently of production optimization; no arbitrary forwarded-header trust.
- [ ] Readiness checks DB and version/checksum ledger; liveness remains process-only; migration failure stops app startup.
- [ ] A documented upgrade and isolated restore have been exercised.

## File lifecycle and security

- [ ] Authenticated upload, lookup, download, share, revoke, and delete work with synthetic fixtures.
- [ ] Short code alone cannot bypass authentication; insufficient key permissions are rejected.
- [ ] Explicit invalid Bearer token cannot inherit admin-cookie authority; cookie mutations reject cross-origin browser requests.
- [ ] Forbidden persistence intent returns 403; temporary null expiry fails closed and violates the schema invariant.
- [ ] Expired files cannot be accessed before or after cleanup.
- [ ] Cleanup removes bytes, safely retries failures, and preserves active uploads.
- [ ] More than 100 expired files are swept fairly; failed first batches cannot starve later files.
- [ ] Orphan decisions stop on DB/mount uncertainty; symlinks/reparse points are not followed.
- [ ] Interrupted/crashed uploads are reclaimed within a documented grace period.
- [ ] Upload size, capacity, and concurrent-upload limits are enforced.
- [ ] Exact file-size/truncation/abort/metadata-failure and concurrent reservations are proven with real DB/disk; retained failed-cleanup bytes remain charged.
- [ ] Logs redact credentials, cookies, and public share tokens.
- [ ] Metadata/log/backup retention is explicitly described.
- [ ] Expiry/revocation and share request-count guarantees distinguish admitted transfers from completed delivery.

## Agent and browser experience

- [ ] OpenAPI matches actual routes and responses.
- [ ] Markdown skill contains no live secrets and works with a configurable instance URL.
- [ ] Static skill download/instance metadata expose no credentials; bad-key checks omit browser-cookie fallback.
- [ ] curl and Python examples complete a real round trip with checksum verification.
- [ ] Error handling covers expiry, authorization, oversized uploads, rate limits, and ambiguous upload outcomes.
- [ ] Phone-sized viewport can find, preview, and download an agent-uploaded file.
- [ ] UI preserves portrait/landscape media proportions and supports keyboard navigation.
- [ ] Exact code lookup works beyond the listed page; private/public links, expiry and storage/cleanup errors are distinct.
- [ ] Report narrow viewport separately from actual phone/reachable HTTPS and list only tested platforms/browsers.

## Release operations

- [ ] Build, tests, security checks, and container smoke test pass on the release commit.
- [ ] README, contribution guide, security policy, support scope, and upgrade guide are complete.
- [ ] Versioned container/image artifacts contain no development secrets or private assets.
- [ ] Public release notes distinguish verified capabilities from deferred work.
- [ ] Final image layers/source archive/history are scanned and inspected; remote CI evidence matches the exact release commit.

## Implementation-to-evidence map

| Gate family | Tasks | Required evidence |
|---|---|---|
| Repository/privacy/rights | A1, A2, E3 | Exact manifest/full diff, redacting scans, ownership and dependency notices |
| Early agent skill | A3, D1 | Source-derived draft, then observed generic HTTP client runs |
| Config/setup | B1, B2 | Negative config tests, exclusive secret-safe writes, actual terminal/container setup |
| DB/readiness | B3, B4 | Real SQL migration rollback/concurrency/ledger and startup failure gates |
| Owned installation | B4, E2, E3 | Fresh volumes/services, restart, upgrade, isolated restore, public-clone smoke |
| Auth/input/log hygiene | C1 | Real key/session matrix, exact expiry boundary, cookie origin defense, captured redacted logs |
| Upload/capacity | C2 | Chunked/exact limits, truncation, failures, concurrent reservations and no overwrite |
| Cleanup/retention | C3, E2 | Real byte deletion/retries, >100 fairness, orphan clocks/active leases, actual process crash |
| API/skill/phone | D1, D2 | Spec validation, actual curl/Python SHA round trips, rendered browser/download checks |
| CI/security/release | E1, E3 | Confirmed private reporting, observed exact-commit CI, inspected artifacts/checksums |
